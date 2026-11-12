//go:build !windows

package pve

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The task log of a guest's backup (#61). vzdump hands the backup provider a
// log function that prints to the worker's stderr only (PVE::VZDump, the
// closure `sub { debugmsg($_[0], $_[1]); }` passes no log file): what the
// provider logs shows in the PVE task log but never reaches the guest's own
// log file, which is what backup_handle_log_file hands over and what Restow
// keeps as the run's log. So restow-pve keeps its lines of a backup itself, in
// the format of that file, and merges them in by time before the upload.
//
// The root verbs keep them next to the job state; backup_container runs as
// the container's mapped root and keeps them in its run folder, which
// backup_cleanup (root) folds into the job's log before it removes the folder.

// taskLogLevels are vzdump's prefixes (PVE::VZDump::Plugin::debugmsg).
var taskLogLevels = map[string]string{"info": "INFO:", "warn": "WARN:", "err": "ERROR:"}

// taskLogStamp is the time format of vzdump's log file (local time).
const taskLogStamp = "2006-01-02 15:04:05"

func (l Layout) jobLogFile(storeid string, vmid int) string {
	return filepath.Join(l.RunDir, "jobs", fmt.Sprintf("%s-%d.log", storeid, vmid))
}

// ctTaskLog is the log of backup_container in the run folder.
func ctTaskLog(runDir string) string {
	return filepath.Join(runDir, "task.log")
}

// keepTaskLog appends one log line, as vzdump writes them, to the task log
// of the current backup, if there is one. Failing to keep it never fails the
// backup.
func (p *Provider) keepTaskLog(level, msg string) {
	if p.taskLog == "" {
		return
	}
	prefix, ok := taskLogLevels[level]
	if !ok {
		prefix = "INFO:"
	}
	stamp := p.clock().Format(taskLogStamp)
	var b strings.Builder
	for _, line := range strings.Split(strings.TrimRight(msg, "\n"), "\n") {
		fmt.Fprintf(&b, "%s %s %s\n", stamp, prefix, line)
	}
	f, err := os.OpenFile(p.taskLog, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return
	}
	_, _ = f.WriteString(b.String())
	_ = f.Close()
}

// foldTaskLog appends a container run folder's log to the job's log.
func (p *Provider) foldTaskLog(job *jobState) {
	data, err := os.ReadFile(ctTaskLog(job.RunDir))
	if err != nil || len(data) == 0 {
		return
	}
	f, err := os.OpenFile(p.Layout.jobLogFile(job.StoreID, job.VMID), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return
	}
	_, _ = f.Write(data)
	_ = f.Close()
}

var taskLogLineRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} `)

type taskLogLine struct {
	stamp string
	text  string
}

// splitTaskLog splits a log into lines, each with the time of its own stamp
// or, without one (a continuation), of the line before it.
func splitTaskLog(data []byte) []taskLogLine {
	var out []taskLogLine
	stamp := ""
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		if taskLogLineRE.MatchString(line) {
			stamp = line[:len(taskLogStamp)]
		}
		out = append(out, taskLogLine{stamp: stamp, text: line})
	}
	return out
}

// MergeTaskLog merges restow-pve's lines into vzdump's log of the guest by
// time; on the same second vzdump's line comes first. Both keep their order.
func MergeTaskLog(pve, ours []byte) []byte {
	a, b := splitTaskLog(pve), splitTaskLog(ours)
	var out bytes.Buffer
	i, k := 0, 0
	for i < len(a) || k < len(b) {
		if k == len(b) || (i < len(a) && a[i].stamp <= b[k].stamp) {
			out.WriteString(a[i].text)
			i++
		} else {
			out.WriteString(b[k].text)
			k++
		}
		out.WriteByte('\n')
	}
	return out.Bytes()
}

// tailBytes keeps the last n bytes of data, from a line start where possible.
func tailBytes(data []byte, n int) []byte {
	if len(data) <= n {
		return data
	}
	data = data[len(data)-n:]
	if i := bytes.IndexByte(data, '\n'); i >= 0 && i+1 < len(data) {
		return data[i+1:]
	}
	return data
}

// vzdump takes one lock per node for all its backups (/var/run/vzdump.lock) and waits for it
// for `lockwait` minutes, 180 by default (PVE::VZDump::getlock). A Restow backup that starts
// while a Proxmox VE backup job runs on the node waits in silence, for hours, before backup_init
// ever runs, and then may fail with the lock's timeout.
const (
	vzdumpLockWaiting = "trying to get global lock"
	vzdumpLockGot     = "got global lock"
	vzdumpLockTimeout = "can't acquire lock '/var/run/vzdump.lock'"
)

// vzdumpLockState reads a vzdump task log (tail): whether it waits for the node's backup lock now.
func vzdumpLockState(tail string) (waiting bool) {
	w := strings.LastIndex(tail, vzdumpLockWaiting)
	return w >= 0 && strings.LastIndex(tail, vzdumpLockGot) < w
}

// vzdumpBackupBegun says whether a vzdump task log shows a guest's backup begun, which vzdump
// starts only with the node's backup lock.
func vzdumpBackupBegun(tail string) bool {
	return strings.Contains(tail, vzdumpLockGot) || strings.Contains(tail, "Starting Backup of VM")
}

// lockTimeoutError is the error of a vzdump task that never got the node's backup lock, or nil.
func lockTimeoutError(exit, node string) error {
	if !strings.Contains(exit, vzdumpLockTimeout) || !strings.Contains(exit, "timeout") {
		return nil
	}
	return fmt.Errorf("another Proxmox VE backup job held the backup lock of node %s for all of vzdump's lock wait (3 hours unless lockwait is set); this backup never started. Move the schedule of the Restow job or of the PVE backup job (vzdump said %q)", node, exit)
}

// lockWaitNote is where the service tells backup_init that its backup waited for the node's
// backup lock, so that the run's log says so (the run opens only once vzdump has the lock).
func (l Layout) lockWaitNote(vmid int) string {
	return filepath.Join(l.RunDir, "jobs", fmt.Sprintf("%d.lockwait", vmid))
}

// lockWaitNoteAge bounds how old a note may be to count (one lock wait and some).
const lockWaitNoteAge = 4 * time.Hour

// takeLockWaitNote logs that the backup waited for the node's backup lock, when the service
// left a note about it, and removes the note.
func (p *Provider) takeLockWaitNote(vmid int) {
	path := p.Layout.lockWaitNote(vmid)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = os.Remove(path)
	since, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data)))
	if err != nil || p.clock().Sub(since) > lockWaitNoteAge || p.clock().Before(since) {
		return
	}
	p.logf("info", "this backup waited from %s for another backup on this node (a Proxmox VE backup job) to release vzdump's lock",
		since.Local().Format(taskLogStamp))
}
