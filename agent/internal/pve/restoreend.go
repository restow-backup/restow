//go:build !windows

package pve

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The end of a container restore (docs/PVE-PROTOCOL.md, "Tasks the node holds"). A container
// restore reads its restore point through restore-container-init, whose restic credential
// (servers from 0.5.0) names the run it reads for. A restore started in the PVE UI has no task
// whose result would end that run, and the provider is gone before PVE's restore task ends, so
// the end goes through three steps:
//
//   - init keeps the run, the volname and the UPID of the PVE worker that restores (its
//     process title, "task UPID:...") in run.json of the restore folder;
//   - cleanup (and the sweep of a folder whose worker is gone) turns it into a record in
//     /var/lib/restow-pve/restore-ends/<run id>.json before it removes the folder;
//   - the service looks at the records after every heartbeat: once PVE's task has ended it
//     reports its exit status (POST /runs/:id/restore-end) and drops the record. A record that
//     is older than restoreEndMaxAge is dropped unreported.
//
// A run that belongs to a task (a restore, a restore check, a boot test) is ended by the task's
// result; the server answers its restore-end with 204 and changes nothing.

// restoreEndMaxAge is how long a restore's end is waited for.
const restoreEndMaxAge = 48 * time.Hour

// restoreRun is what init keeps in the restore folder, and the record cleanup leaves.
type restoreRun struct {
	RunID   string `json:"runId"`
	Volname string `json:"volname"`
	// UPID is the PVE task of the worker that restores ("" when its process title did not say).
	UPID string `json:"upid,omitempty"`
	// WorkerPID is that worker's pid.
	WorkerPID int `json:"workerPid,omitempty"`
	// At is when init ran (RFC 3339).
	At string `json:"at"`
}

func (l Layout) restoreEndsDir() string { return filepath.Join(l.DataDir, "restore-ends") }

func restoreRunFile(folder string) string { return filepath.Join(folder, "run.json") }

// workerUPID is the UPID of the PVE task that the process pid or one of its ancestors runs:
// a PVE worker names itself "task UPID:..." (PVE::RESTEnvironment::fork_worker).
func workerUPID(pid int) string {
	for depth := 0; depth < 8 && pid > 1; depth++ {
		data, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cmdline"))
		if err == nil {
			title := strings.TrimSpace(strings.ReplaceAll(string(data), "\x00", " "))
			if upid, ok := strings.CutPrefix(title, "task "); ok && strings.HasPrefix(upid, "UPID:") {
				return strings.Fields(upid)[0]
			}
		}
		pid = parentPID(pid)
	}
	return ""
}

// parentPID is the parent of process pid (field 4 of /proc/<pid>/stat), 0 when unknown.
func parentPID(pid int) int {
	data, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 2 {
		return 0
	}
	ppid, _ := strconv.Atoi(fields[1])
	return ppid
}

// keepRestoreRun writes run.json into a restore folder (init).
func (p *Provider) keepRestoreRun(folder, runID, volname string, worker int) {
	r := restoreRun{RunID: runID, Volname: volname, UPID: workerUPID(worker), WorkerPID: worker,
		At: p.clock().UTC().Format(time.RFC3339)}
	if r.UPID == "" {
		p.logf("info", "the PVE task of this restore is not known; Restow learns its end only from a task of its own")
	}
	if err := writeJSONAtomic(restoreRunFile(folder), r, 0o600); err != nil {
		p.logf("warn", "keeping the run of this restore: %v", err)
	}
}

// leaveRestoreEnd turns the run.json of a restore folder into a record for the service; a
// folder without one (an older server, no run) leaves nothing.
func leaveRestoreEnd(l Layout, folder string) {
	if l.DataDir == "" {
		return
	}
	var r restoreRun
	if err := readJSON(restoreRunFile(folder), &r); err != nil || r.RunID == "" || r.UPID == "" {
		return
	}
	if strings.ContainsAny(r.RunID, "/\\") || strings.Contains(r.RunID, "..") {
		return
	}
	if err := os.MkdirAll(l.restoreEndsDir(), 0o700); err != nil {
		return
	}
	_ = writeJSONAtomic(filepath.Join(l.restoreEndsDir(), r.RunID+".json"), r, 0o600)
}

// RestoreEndRequest is POST /runs/:id/restore-end.
type RestoreEndRequest struct {
	Status     string   `json:"status"` // succeeded | warnings | failed
	ExitStatus string   `json:"exitStatus"`
	Warnings   []string `json:"warnings,omitempty"`
	Error      string   `json:"error,omitempty"`
}

// RestoreEnd reports the end of a container restore's PVE task.
func (s *Server) RestoreEnd(ctx context.Context, runID string, in RestoreEndRequest) error {
	return s.json(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/restore-end", in, nil, true)
}

// restoreEndOf makes the report of a PVE task's exit status: OK succeeded, "WARNINGS: n" a
// success with the warning lines of its log, anything else failed with the end of its log.
func restoreEndOf(exit, tail string) RestoreEndRequest {
	switch {
	case exit == "OK":
		return RestoreEndRequest{Status: "succeeded", ExitStatus: exit}
	case TaskWarnings(exit):
		return RestoreEndRequest{Status: "warnings", ExitStatus: exit, Warnings: WarningLines(tail, 20)}
	}
	return RestoreEndRequest{Status: "failed", ExitStatus: exit,
		Error: fmt.Sprintf("restore ended with %q: %s", exit, lastLines(tail, 8))}
}

// reportRestoreEnds reports the restores whose PVE task has ended and drops their records; a
// task that still runs is looked at again after the next heartbeat.
func (s *Service) reportRestoreEnds(ctx context.Context) {
	entries, err := os.ReadDir(s.Layout.restoreEndsDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(s.Layout.restoreEndsDir(), e.Name())
		var r restoreRun
		if err := readJSON(path, &r); err != nil || r.RunID == "" || r.UPID == "" {
			_ = os.Remove(path)
			continue
		}
		if at, err := time.Parse(time.RFC3339, r.At); err != nil || time.Since(at) > restoreEndMaxAge {
			s.Logf("restore of %s (run %s): its end was not learned within %s; it is not reported", r.Volname, r.RunID, restoreEndMaxAge)
			_ = os.Remove(path)
			continue
		}
		st, err := s.PVE.TaskStatus(ctx, s.State.NodeName, r.UPID)
		if err != nil {
			var pe *PVEAPIError
			if errors.As(err, &pe) && pe.Status >= 400 && pe.Status < 500 && pe.Status != http.StatusTooManyRequests {
				// PVE does not know the task (any more): its end cannot be read.
				s.Logf("restore of %s (run %s): PVE does not know its task %s: %v", r.Volname, r.RunID, r.UPID, err)
				_ = os.Remove(path)
			}
			continue
		}
		if st.Status != "stopped" {
			continue
		}
		tail := ""
		if st.ExitStatus != "OK" {
			tail, _ = s.PVE.TaskLogTail(ctx, s.State.NodeName, r.UPID, 200)
		}
		end := restoreEndOf(st.ExitStatus, tail)
		if err := s.Server.RestoreEnd(ctx, r.RunID, end); err != nil && !resultSettled(err) {
			s.Logf("restore of %s (run %s): reporting its end: %v (tried again after the next heartbeat)", r.Volname, r.RunID, err)
			continue
		} else if err != nil {
			s.Logf("restore of %s (run %s): the server refused its end: %v", r.Volname, r.RunID, err)
		} else {
			s.Logf("restore of %s (run %s) ended %s", r.Volname, r.RunID, end.ExitStatus)
		}
		_ = os.Remove(path)
	}
}
