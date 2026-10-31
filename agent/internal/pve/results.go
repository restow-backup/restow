//go:build !windows

package pve

import (
	"context"
	"os"
	"path/filepath"
	"sync"
)

// PendingResult is a task result the server has not taken yet. restow-pve keeps it on disk
// and sends it again before every heartbeat until the server answers (docs/PVE-PROTOCOL.md,
// "Task results"): a result lost while the Restow server was unreachable (an update, an
// outage longer than the calls ride out) still settles the task and its run later.
type PendingResult struct {
	TaskID string         `json:"taskId"`
	Status string         `json:"status"`
	Error  string         `json:"error,omitempty"`
	Result map[string]any `json:"result,omitempty"`
}

// MaxPendingResults bounds the file: the oldest results go first beyond it.
const MaxPendingResults = 100

var pendingMu sync.Mutex

func (l Layout) pendingResultsFile() string {
	return filepath.Join(l.DataDir, "pending-results.json")
}

func (s *Service) loadPending() []PendingResult {
	var out []PendingResult
	if err := readJSON(s.Layout.pendingResultsFile(), &out); err != nil {
		return nil
	}
	return out
}

func (s *Service) savePending(list []PendingResult) {
	path := s.Layout.pendingResultsFile()
	if len(list) == 0 {
		_ = os.Remove(path)
		return
	}
	if len(list) > MaxPendingResults {
		list = list[len(list)-MaxPendingResults:]
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		s.Logf("could not keep task results: %v", err)
		return
	}
	if err := writeJSONAtomic(path, list, 0o600); err != nil {
		s.Logf("could not keep task results: %v", err)
	}
}

func (s *Service) pendingResult(taskID string) bool {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	for _, r := range s.loadPending() {
		if r.TaskID == taskID {
			return true
		}
	}
	return false
}

// resultSettled says whether the server's answer ends the attempts: it took the result, or it
// refuses it for good (4xx: an unknown task, a malformed result), which another attempt would
// not change. Anything else (unreachable, 5xx, 429) is tried again.
func resultSettled(err error) bool {
	if err == nil {
		return true
	}
	for _, status := range []int{400, 401, 403, 404, 409, 410, 422} {
		if IsStatus(err, status) {
			return true
		}
	}
	return false
}

// reportResult sends a task result; one the server could not take is kept for later.
func (s *Service) reportResult(ctx context.Context, r PendingResult) {
	err := s.Server.TaskResult(ctx, r.TaskID, r.Status, r.Error, r.Result)
	if err == nil {
		return
	}
	if resultSettled(err) {
		s.Logf("task %s: report result: %v", r.TaskID, err)
		return
	}
	s.Logf("task %s: report result: %v (kept, sent again with the next heartbeat)", r.TaskID, err)
	pendingMu.Lock()
	defer pendingMu.Unlock()
	list := s.loadPending()
	kept := list[:0]
	for _, p := range list {
		if p.TaskID != r.TaskID {
			kept = append(kept, p)
		}
	}
	s.savePending(append(kept, r))
}

// flushResults sends the kept results again, oldest first; it stops at the first the server
// still cannot take (it is unreachable, the rest would fail the same way).
func (s *Service) flushResults(ctx context.Context) {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	list := s.loadPending()
	if len(list) == 0 {
		return
	}
	for i, r := range list {
		err := s.Server.TaskResult(ctx, r.TaskID, r.Status, r.Error, r.Result)
		if !resultSettled(err) {
			s.savePending(list[i:])
			return
		}
		if err != nil {
			s.Logf("task %s: late result refused: %v", r.TaskID, err)
		} else {
			s.Logf("task %s: late result sent", r.TaskID)
		}
	}
	s.savePending(nil)
}
