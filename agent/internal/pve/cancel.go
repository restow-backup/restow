//go:build !windows

package pve

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// CancelOrders is what the server wants stopped (heartbeat answer, servers from 0.4.2): tasks
// the node got but is not to start (or to stop when it runs one), and running backup runs.
type CancelOrders struct {
	Tasks []string    `json:"tasks"`
	Runs  []CancelRun `json:"runs"`
}

// CancelRun is a running backup run to stop. TaskID is set when Restow asked for the backup
// (this node started the vzdump task); empty for a backup started in PVE.
type CancelRun struct {
	ID     string `json:"id"`
	VMID   int    `json:"vmid"`
	TaskID string `json:"taskId"`
}

// ErrCancelled is how a task the server withdrew ends on this node.
var ErrCancelled = errors.New("cancelled in Restow")

// StopTask is DELETE /nodes/{node}/tasks/{upid}: PVE stops the task (vzdump ends its guest
// with an error and cleans up its snapshot and fleecing image).
func (p *PVEAPI) StopTask(ctx context.Context, node, upid string) error {
	return p.call(ctx, http.MethodDelete, "/nodes/"+url.PathEscape(node)+"/tasks/"+url.PathEscape(upid), nil, nil)
}

func (l Layout) providerPIDFile(vmid int) string {
	return filepath.Join(l.RunDir, "providers", fmt.Sprintf("%d.pid", vmid))
}

// markProvider records this process as the provider that backs up the guest now; the returned
// function removes the record again.
func markProvider(l Layout, vmid int) func() {
	if vmid <= 0 {
		return func() {}
	}
	path := l.providerPIDFile(vmid)
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return func() {}
	}
	pid := os.Getpid()
	if os.WriteFile(path, []byte(strconv.Itoa(pid)), 0o600) != nil {
		return func() {}
	}
	return func() {
		// Only our own record: a later provider of the same guest may have replaced it.
		if data, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(data)) == strconv.Itoa(pid) {
			_ = os.Remove(path)
		}
	}
}

// procRoot is where the process table is read (tests point it elsewhere).
var procRoot = "/proc"

// signalProcess sends SIGTERM (tests replace it).
var signalProcess = func(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// stopProvider ends the provider that backs up the guest with SIGTERM: it stops reading and
// uploading, reports the run as failed (the server records it as cancelled), and vzdump goes on
// with the next guest of its job. False when no provider of the guest runs.
func stopProvider(l Layout, vmid int) bool {
	data, err := os.ReadFile(l.providerPIDFile(vmid))
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 1 {
		return false
	}
	// A stale record may name a process that is no provider any more: never signal that.
	cmdline, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cmdline"))
	if err != nil || !bytes.Contains(cmdline, []byte("restow-pve")) || !bytes.Contains(cmdline, []byte("provider")) {
		return false
	}
	return signalProcess(pid) == nil
}

// current is the task this node works on, with the vzdump task it started for it.
type current struct {
	id   string
	kind string
	vmid int
	upid string
}

// applyCancel carries out the server's cancel orders: a queued task is dropped (and reported as
// failed, which the server records as cancelled), the running one's vzdump task is stopped
// through the PVE API, and a backup started in PVE is stopped through its provider (or its
// vzdump task when that backs up this guest alone). Each order is acted on once.
func (s *Service) applyCancel(ctx context.Context, orders *CancelOrders) {
	if orders == nil {
		return
	}
	for _, id := range orders.Tasks {
		if s.dropQueued(id) {
			s.Logf("task %s was cancelled in Restow before it started", id)
			// Kept and sent again like any task result the server could not take (results.go).
			s.reportResult(ctx, PendingResult{TaskID: id, Status: "failed", Error: ErrCancelled.Error()})
			continue
		}
		s.stopCurrent(ctx, id, 0)
	}
	for _, r := range orders.Runs {
		if r.TaskID != "" && s.stopCurrent(ctx, r.TaskID, r.VMID) {
			continue
		}
		s.stopRun(ctx, r)
	}
}

// stopCurrent stops the running task `id` (its vzdump task); false when it is not the one.
func (s *Service) stopCurrent(ctx context.Context, id string, vmid int) bool {
	s.mu.Lock()
	s.lazyLocked()
	cur := s.cur
	if cur == nil || cur.id != id {
		s.mu.Unlock()
		return false
	}
	s.cancelled[id] = true
	upid := cur.upid
	if vmid == 0 {
		vmid = cur.vmid
	}
	already := s.stopped[upid]
	if upid != "" {
		s.stopped[upid] = true
	}
	s.mu.Unlock()
	if already {
		return true
	}
	if upid == "" {
		// Not started yet: the task ends as soon as it would start vzdump (task()).
		s.Logf("task %s was cancelled in Restow; it will not start", id)
		return true
	}
	s.Logf("task %s was cancelled in Restow: stopping %s", id, upid)
	if err := s.PVE.StopTask(ctx, s.State.NodeName, upid); err != nil {
		s.Logf("stopping %s: %v", upid, err)
		if vmid > 0 && stopProvider(s.Layout, vmid) {
			s.Logf("stopped the provider of guest %d instead", vmid)
		}
	}
	return true
}

// stopRun stops a backup this node did not start (started in PVE): through its provider, or the
// vzdump task when it backs up this guest alone.
func (s *Service) stopRun(ctx context.Context, r CancelRun) {
	s.mu.Lock()
	s.lazyLocked()
	already := s.stopped["run:"+r.ID]
	s.stopped["run:"+r.ID] = true
	s.mu.Unlock()
	if already || r.VMID <= 0 {
		return
	}
	if stopProvider(s.Layout, r.VMID) {
		s.Logf("backup run %s of guest %d was cancelled in Restow: stopped its provider", r.ID, r.VMID)
		return
	}
	tasks, err := s.PVE.ActiveTasks(ctx, s.State.NodeName, "vzdump")
	if err != nil {
		s.Logf("backup run %s: list the vzdump tasks: %v", r.ID, err)
		return
	}
	for _, t := range tasks {
		if t.ID == strconv.Itoa(r.VMID) {
			s.Logf("backup run %s of guest %d was cancelled in Restow: stopping %s", r.ID, r.VMID, t.UPID)
			if err := s.PVE.StopTask(ctx, s.State.NodeName, t.UPID); err != nil {
				s.Logf("stopping %s: %v", t.UPID, err)
			}
			return
		}
	}
	// Nothing runs for it here (any more): the server refuses the run's uploads in any case.
	s.Logf("backup run %s of guest %d was cancelled in Restow; no backup of it runs on this node", r.ID, r.VMID)
}
