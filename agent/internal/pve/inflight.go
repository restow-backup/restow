//go:build !windows

package pve

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// A backup or restore task runs as a PVE task for hours. When restow-pve stops meanwhile
// (`systemctl restart restow-pve`, the installer, a self-update, a reboot of the node), PVE goes
// on with it; the task's end is not known to Restow yet. restow-pve therefore writes the PVE
// task it waits for to /var/lib/restow-pve/inflight.json as soon as PVE started it, reports no
// result when its wait ends because the service stops, and waits for the task again when the
// service starts (docs/PVE-PROTOCOL.md, "Task results").

// inflightTask is a task whose PVE task was started and whose result is not reported yet.
type inflightTask struct {
	TaskID    string          `json:"taskId"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	UPID      string          `json:"upid"`
	VMID      int             `json:"vmid"`
	StartedAt string          `json:"startedAt"`
	// Restore is what a restore task knows after its start (restore and restore check).
	Restore *restoreState `json:"restore,omitempty"`
}

var inflightMu sync.Mutex

func (l Layout) inflightFile() string { return filepath.Join(l.DataDir, "inflight.json") }

func loadInflight(l Layout) []inflightTask {
	var out []inflightTask
	if err := readJSON(l.inflightFile(), &out); err != nil {
		return nil
	}
	return out
}

func (s *Service) saveInflightLocked(list []inflightTask) {
	path := s.Layout.inflightFile()
	if len(list) == 0 {
		_ = os.Remove(path)
		return
	}
	if err := writeJSONAtomic(path, list, 0o600); err != nil {
		s.Logf("could not keep the running task: %v", err)
	}
}

// keepInflight records (or updates) a task whose PVE task runs.
func (s *Service) keepInflight(e inflightTask) {
	inflightMu.Lock()
	defer inflightMu.Unlock()
	list := loadInflight(s.Layout)
	kept := list[:0]
	for _, x := range list {
		if x.TaskID != e.TaskID {
			kept = append(kept, x)
		}
	}
	s.saveInflightLocked(append(kept, e))
}

// dropInflight forgets a task whose result is reported (or kept for sending).
func (s *Service) dropInflight(taskID string) {
	inflightMu.Lock()
	defer inflightMu.Unlock()
	list := loadInflight(s.Layout)
	kept := list[:0]
	for _, x := range list {
		if x.TaskID != taskID {
			kept = append(kept, x)
		}
	}
	if len(kept) != len(list) {
		s.saveInflightLocked(kept)
	}
}

// inflight returns the recorded task of that id, or nil.
func (s *Service) inflight(taskID string) *inflightTask {
	inflightMu.Lock()
	defer inflightMu.Unlock()
	for _, x := range loadInflight(s.Layout) {
		if x.TaskID == taskID {
			return &x
		}
	}
	return nil
}

// inflightVMIDs are the guests the recorded tasks restore to (the leftover cleanup leaves them
// to the task that waits for them again).
func inflightVMIDs(l Layout) map[int]bool {
	inflightMu.Lock()
	defer inflightMu.Unlock()
	out := map[int]bool{}
	for _, x := range loadInflight(l) {
		if x.Restore != nil && x.Restore.VMID > 0 {
			out[x.Restore.VMID] = true
		}
	}
	return out
}
