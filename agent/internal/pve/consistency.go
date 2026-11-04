//go:build !windows

package pve

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The consistency of a VM restore point. In snapshot mode PVE freezes the guest's file systems
// through the QEMU guest agent around the setup of the backup access and thaws them again
// (qemu-server, qga_fs_freeze and qga_fs_thaw), before backup_vm runs; it goes on without the
// freeze when the agent is off, not running, or the freeze fails. Only vzdump's log of the guest
// says which happened. A restore point without the freeze is crash-consistent: a journalled
// file system replays its journal, XFS and NTFS may need a repair before file restore reads
// them.

// VMConsistency is what a VM restore point records about it (CommitRequest, RunLog).
type VMConsistency struct {
	// State is frozen (fs-freeze and thaw issued), stopped (the guest did not run: stop mode
	// or a powered-off VM), no_agent (the agent is configured but did not answer),
	// crash_consistent (no agent, or the freeze is switched off), freeze_failed (the freeze
	// was issued and failed: crash-consistent), or unknown (the log says nothing about it).
	State string `json:"state"`
	// Detail is one line for the restore point (the error of a failed freeze).
	Detail string `json:"detail,omitempty"`
	// Warnings are problems around the freeze (a thaw that failed or was never issued).
	Warnings []string `json:"warnings,omitempty"`
}

// vzdump's lines about the freeze (qemu-server, VZDump/QemuServer.pm).
const (
	freezeIssued      = "issuing guest-agent 'fs-freeze' command"
	thawIssued        = "issuing guest-agent 'fs-thaw' command"
	freezeNotRunning  = "skipping guest-agent 'fs-freeze', agent configured but not running"
	freezeDisabled    = "skipping guest-agent 'fs-freeze', disabled in VM options"
	freezeCommand     = "guest-fsfreeze-freeze"
	thawCommand       = "guest-fsfreeze-thaw"
	backupModeStopped = "backup mode: stop"
	guestStopped      = "status = stopped"
)

// ClassifyVMConsistency reads vzdump's log of a VM's backup (log; "" when it could not be read)
// and the VM's configuration.
func ClassifyVMConsistency(log, guestConfig string) VMConsistency {
	agentOn, freezeOff := agentSettings(guestConfig)
	var issued, thawed, skippedNotRunning, skippedDisabled, stopped bool
	var freezeErr, thawErr string
	for _, raw := range strings.Split(log, "\n") {
		line := strings.TrimSpace(raw)
		if taskLogLineRE.MatchString(line) {
			line = line[len(taskLogStamp)+1:]
		}
		switch {
		case strings.Contains(line, freezeIssued):
			issued = true
		case strings.Contains(line, thawIssued):
			thawed = true
		case strings.Contains(line, freezeNotRunning):
			skippedNotRunning = true
		case strings.Contains(line, freezeDisabled):
			skippedDisabled = true
		case strings.Contains(line, backupModeStopped), strings.Contains(line, guestStopped):
			stopped = true
		case strings.HasPrefix(line, "ERROR:") && strings.Contains(line, freezeCommand):
			freezeErr = strings.TrimSpace(strings.TrimPrefix(line, "ERROR:"))
		case strings.HasPrefix(line, "ERROR:") && strings.Contains(line, thawCommand):
			thawErr = strings.TrimSpace(strings.TrimPrefix(line, "ERROR:"))
		}
	}
	var c VMConsistency
	switch {
	case issued && freezeErr != "":
		c = VMConsistency{State: "freeze_failed", Detail: "the guest agent could not freeze the file systems (" + clip(freezeErr, 300) + "); the restore point is crash-consistent"}
	case issued:
		c = VMConsistency{State: "frozen", Detail: "the guest agent froze the file systems for the backup"}
	case skippedNotRunning:
		c = VMConsistency{State: "no_agent", Detail: "the guest agent is configured but did not answer, so the file systems were not frozen; the restore point is crash-consistent"}
	case skippedDisabled:
		c = VMConsistency{State: "crash_consistent", Detail: "the freeze is switched off in the VM's guest agent options; the restore point is crash-consistent"}
	case stopped:
		c = VMConsistency{State: "stopped", Detail: "the guest did not run during the backup"}
	case log == "":
		c = VMConsistency{State: "unknown"}
	case !agentOn:
		c = VMConsistency{State: "crash_consistent", Detail: "the VM has no guest agent enabled, so its file systems were not frozen; the restore point is crash-consistent"}
	case freezeOff:
		c = VMConsistency{State: "crash_consistent", Detail: "the freeze is switched off in the VM's guest agent options; the restore point is crash-consistent"}
	default:
		c = VMConsistency{State: "unknown"}
	}
	if issued && !thawed {
		c.Warnings = append(c.Warnings, "vzdump froze the guest's file systems and logged no thaw; check that the guest can write")
	}
	if thawErr != "" {
		c.Warnings = append(c.Warnings, "the guest agent could not thaw the file systems ("+clip(thawErr, 300)+"); check that the guest can write")
	}
	return c
}

// Remark is the line the restore point records (CommitRequest.ConsistencyRemark): nothing for a
// frozen or stopped guest without problems.
func (c VMConsistency) Remark() string {
	parts := []string{}
	if c.State != "frozen" && c.State != "stopped" && c.Detail != "" {
		parts = append(parts, c.Detail)
	}
	parts = append(parts, c.Warnings...)
	return strings.Join(parts, "; ")
}

// agentSettings reads the guest agent option of a VM configuration ("agent: 1",
// "agent: enabled=1,freeze-fs=0"): whether it is on and whether the freeze is switched off.
func agentSettings(guestConfig string) (on, freezeOff bool) {
	v := strings.TrimSpace(parseConfigText(guestConfig)["agent"])
	for i, part := range strings.Split(v, ",") {
		k, val, hasEq := strings.Cut(strings.TrimSpace(part), "=")
		switch {
		case i == 0 && !hasEq:
			on = k == "1"
		case k == "enabled":
			on = val == "1"
		case k == "freeze-fs" || k == "freeze-fs-on-backup":
			freezeOff = val == "0"
		}
	}
	return on, freezeOff
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// vzdumpLogDir is where vzdump writes the log of each guest's backup (qemu-<vmid>.log), the
// file backup_handle_log_file gets later (tests point it elsewhere).
var vzdumpLogDir = "/var/log/vzdump"

// vzdumpGuestLog reads vzdump's log of the VM's running backup while backup_vm runs: the file
// the vzdump worker (this provider's parent) has open, or else vzdump's log folder when the
// file was written in the last hour. "" when neither is there.
func vzdumpGuestLog(vmid int) string {
	name := fmt.Sprintf("qemu-%d.log", vmid)
	path := ""
	fds, _ := filepath.Glob(filepath.Join(procRoot, strconv.Itoa(os.Getppid()), "fd", "*"))
	for _, fd := range fds {
		if target, err := os.Readlink(fd); err == nil && filepath.Base(target) == name && filepath.IsAbs(target) {
			path = target
			break
		}
	}
	if path == "" {
		candidate := filepath.Join(vzdumpLogDir, name)
		if st, err := os.Stat(candidate); err == nil && time.Since(st.ModTime()) < time.Hour {
			path = candidate
		}
	}
	if path == "" {
		return ""
	}
	data, err := readTail(path, 256<<10)
	if err != nil {
		return ""
	}
	return string(data)
}
