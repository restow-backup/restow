package core

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/fssnap"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// File system snapshots of a backup (docs/WINDOWS-AGENT.md, section 17). On
// Windows the agent asks restic for a volume shadow copy (VSS) when the
// machine's useVss is set; what happens when one fails is the policy
// snapshotOnFailure: continue (the default) backs up from the live file
// system and ends partial, fail stops the backup. The same policy and the
// same report field (api.Consistency) serve LVM, btrfs and APFS snapshots.

// vssTimeout is restic's -o vss.timeout: servers with many writers (SQL
// Server, Hyper-V, Exchange) need longer than restic's 120 s to gather the
// writer metadata.
const vssTimeout = 5 * time.Minute

// errSnapshotFailed is the cause the agent stops restic with when a volume's
// snapshot failed under the policy fail.
var errSnapshotFailed = errors.New("the file system snapshot of a volume failed (policy: stop the backup)")

// snapshotPlan is what a backup asks of the file system snapshot.
type snapshotPlan struct {
	// method is the snapshot method of the system (vss); empty: none.
	method string
	// requested: the backup asks restic for a snapshot.
	requested bool
	// volumes are the volumes of the sources that are snapshotted (empty
	// when unknown); excluded are those that are read live from the start
	// (removable media, FAT, exFAT), with the reason in notes.
	volumes  []string
	excluded []string
	notes    []string
	// unavailable is set when a snapshot is wanted but cannot be taken at
	// all (for example without administrator rights); it is the message.
	unavailable string
}

// planSnapshotFn is planSnapshot (snapshot_windows.go, snapshot_other.go);
// tests replace it to drive the policy on any system.
var planSnapshotFn = planSnapshot

// snapshotFailPolicy reports whether the policy stops a backup whose
// snapshot failed.
func snapshotFailPolicy(cfg *api.Config) bool {
	return cfg.Policy != nil && cfg.Policy.SnapshotOnFailure == api.SnapshotOnFailureFail
}

// snapshotLogHint is where an administrator looks for the cause.
const snapshotLogHint = "Event Viewer > Windows Logs > Application, source VSS; as an administrator: vssadmin list writers"

// snapshotNoun names the snapshot of a method in messages.
func snapshotNoun(method string) string {
	switch method {
	case api.SnapshotMethodLVM:
		return "LVM snapshot"
	case api.SnapshotMethodBtrfs:
		return "btrfs snapshot"
	case "apfs":
		return "APFS snapshot"
	case api.SnapshotMethodMixed:
		return "file system snapshot"
	}
	return "shadow copy"
}

// snapshotLogHintFor is where an administrator looks for the cause, per
// method (docs/BAREMETAL.md 6.4).
func snapshotLogHintFor(method string) string {
	switch method {
	case api.SnapshotMethodLVM:
		return "lvs, vgs, journalctl -k"
	case api.SnapshotMethodBtrfs:
		return "btrfs filesystem usage <mount point>"
	case api.SnapshotMethodMixed:
		return "lvs, vgs, journalctl -k and btrfs filesystem usage <mount point>"
	case "apfs":
		return "diskutil apfs listSnapshots /"
	}
	return snapshotLogHint
}

// methodOfSource is the snapshot method of one planned source.
func methodOfSource(plan fssnap.Plan, p string) string {
	for _, s := range plan.Sources {
		if s.Path == p && s.Method != fssnap.MethodLive {
			return string(s.Method)
		}
	}
	return plan.Method
}

// consistencyOfFS rates the LVM and btrfs snapshots of a Linux backup
// (R8): used when none failed and at least one held, partial when some
// failed and some held, unavailable when none held (all failed, none with
// a method, or no snapshot possible); liveFilesystems are the source
// paths read live (failed or without a method), sorted, at most 32.
func consistencyOfFS(plan fssnap.Plan, out fssnap.Outcome) *api.Consistency {
	c := &api.Consistency{Method: plan.Method, State: api.ConsistencyOff}
	if !plan.Requested {
		c.Method = ""
		return c
	}
	held, failed := len(out.Snapshotted) > 0, len(out.Failed) > 0
	switch {
	case plan.Unavailable != "" || out.Unavailable != "" || !held:
		c.State = api.ConsistencyUnavailable
	case failed:
		c.State = api.ConsistencyPartial
	default:
		c.State = api.ConsistencyUsed
	}
	set := map[string]bool{}
	for _, f := range out.Failed {
		set[f.Path] = true
	}
	for _, p := range out.Live {
		set[p] = true
	}
	if c.State != api.ConsistencyUnavailable || plan.Unavailable == "" && out.Unavailable == "" {
		live := make([]string, 0, len(set))
		for p := range set {
			live = append(live, p)
		}
		sort.Strings(live)
		if len(live) > api.MaxLiveFilesystems {
			live = live[:api.MaxLiveFilesystems]
		}
		if len(live) > 0 {
			c.LiveFilesystems = live
		}
	}
	return c
}

// fsSnapshotFailedErrors are the run errors of the LVM and btrfs snapshots
// that failed (path: the source path).
func fsSnapshotFailedErrors(plan fssnap.Plan, fails []fssnap.Failure, stopped bool) []api.RunError {
	var errs []api.RunError
	for _, f := range fails {
		noun := snapshotNoun(methodOfSource(plan, f.Path))
		msg := fmt.Sprintf("The %s of %s could not be created or did not hold (%s). ", noun, f.Path, f.Message)
		if stopped {
			msg += "The backup was stopped, as the policy for a failed file system snapshot asks."
		} else {
			msg += "It was read from the live file system: files that changed during the backup may be inconsistent."
		}
		errs = append(errs, api.RunError{Code: "snapshot_failed", Path: f.Path, Message: msg})
	}
	return errs
}

// fsSnapshotUnavailableError is the run error for a Linux backup without
// any snapshot although one was wanted.
func fsSnapshotUnavailableError(method, reason string, fallback bool) api.RunError {
	msg := fmt.Sprintf("The file system snapshot (%s) cannot be used on this machine: %s. ", snapshotNoun(method), reason)
	if fallback {
		msg += "The backup ran without it, from the live file system."
	} else {
		msg += "The backup was not made, as the policy for a failed file system snapshot asks."
	}
	return api.RunError{Code: "snapshot_unavailable", Message: msg}
}

// fsSnapshotCleanupErrors report snapshots the agent could not remove; they
// change nothing about the status and are removed at the next start.
func fsSnapshotCleanupErrors(fails []fssnap.Failure) []api.RunError {
	var errs []api.RunError
	for _, f := range fails {
		errs = append(errs, api.RunError{Code: "snapshot_cleanup_failed", Path: f.Path,
			Message: fmt.Sprintf("The snapshot %s could not be removed after the backup (%s); the agent removes it when it starts again or before the next backup.", f.Path, f.Message)})
	}
	return errs
}

// consistencyOf rates what happened to the snapshot of a backup that got as
// far as restic. unavailable: no snapshot could be taken at all.
func consistencyOf(plan snapshotPlan, out restic.SnapshotOutcome, unavailable bool) *api.Consistency {
	c := &api.Consistency{Method: plan.method, State: api.ConsistencyOff}
	if !plan.requested && plan.unavailable == "" {
		return c
	}
	var live []string
	add := func(v string) {
		for _, l := range live {
			if strings.EqualFold(l, v) {
				return
			}
		}
		live = append(live, v)
	}
	failed := map[string]bool{}
	for _, f := range out.FailedVolumes {
		add(f.Volume)
		failed[strings.ToUpper(f.Volume)] = true
	}
	for _, v := range out.SkippedVolumes {
		add(v)
	}
	for _, v := range plan.excluded {
		add(v)
	}
	switch {
	case unavailable || plan.unavailable != "":
		c.State = api.ConsistencyUnavailable
		live = nil
	case len(out.FailedVolumes) == 0:
		c.State = api.ConsistencyUsed
	default:
		c.State = api.ConsistencyPartial
		// Every volume that was to be snapshotted failed: no snapshot at all.
		if len(plan.volumes) > 0 {
			all := true
			for _, v := range plan.volumes {
				if !failed[strings.ToUpper(v)] {
					all = false
					break
				}
			}
			if all {
				c.State = api.ConsistencyUnavailable
			}
		}
	}
	if len(live) > api.MaxLiveFilesystems {
		live = live[:api.MaxLiveFilesystems]
	}
	c.LiveFilesystems = live
	return c
}

// snapshotFailedErrors are the run errors for the volumes whose snapshot
// failed; under continue restic read them live.
func snapshotFailedErrors(out restic.SnapshotOutcome, stopped bool) []api.RunError {
	var errs []api.RunError
	for _, f := range out.FailedVolumes {
		msg := fmt.Sprintf("The shadow copy of %s could not be created (%s). ", f.Volume, f.Message)
		if stopped {
			msg += "The backup was stopped, as the policy for a failed file system snapshot asks."
		} else {
			msg += "The volume was read from the live file system: files that changed during the backup may be inconsistent."
		}
		errs = append(errs, api.RunError{Code: "snapshot_failed", Path: f.Volume, Message: msg})
	}
	return errs
}

// snapshotCleanupErrors report shadow copies restic could not delete; they
// change nothing about the status.
func snapshotCleanupErrors(out restic.SnapshotOutcome) []api.RunError {
	var errs []api.RunError
	for _, f := range out.CleanupFailed {
		errs = append(errs, api.RunError{Code: "snapshot_cleanup_failed", Path: f.Volume,
			Message: fmt.Sprintf("The shadow copy of %s could not be deleted after the backup (%s); Windows removes it when it needs the space, or delete it with vssadmin.", f.Volume, f.Message)})
	}
	return errs
}

// snapshotUnavailableError is the run error for a backup without any snapshot.
func snapshotUnavailableError(reason string, fallback bool) api.RunError {
	msg := "The file system snapshot (Volume Shadow Copy) cannot be used on this machine: " + reason + ". "
	if fallback {
		msg += "The backup ran without it, from the live file system."
	} else {
		msg += "The backup was not made, as the policy for a failed file system snapshot asks."
	}
	return api.RunError{Code: "snapshot_unavailable", Message: msg}
}

// logSnapshotOutcome writes one line per volume to the run log.
func logSnapshotOutcome(rl runLogger, out restic.SnapshotOutcome) {
	for _, v := range out.SkippedVolumes {
		rl.Infof("%s was backed up without a shadow copy: the snapshot provider does not support this volume.", v)
	}
	for _, f := range out.FailedVolumes {
		rl.Warnf("The shadow copy of %s failed (%s); see %s.", f.Volume, f.Message, snapshotLogHint)
	}
	for _, f := range out.CleanupFailed {
		rl.Warnf("The shadow copy of %s could not be deleted (%s).", f.Volume, f.Message)
	}
	for _, w := range out.Warnings {
		rl.Warnf("Shadow copy: %s", w)
	}
}

// runLogger is the part of the run log the snapshot code writes to.
type runLogger interface {
	Infof(format string, args ...any)
	Warnf(format string, args ...any)
}

// vssExcludeReason says why a volume is read without a shadow copy from the
// start, or "" when VSS may do it. driveType is GetDriveTypeW's answer,
// fsName GetVolumeInformationW's file system name ("" unknown).
func vssExcludeReason(driveType uint32, fsName string) string {
	switch driveType {
	case winapi.DriveRemovable:
		return "removable drive"
	case winapi.DriveCDROM:
		return "optical drive"
	case winapi.DriveRemote:
		return "network drive"
	}
	switch strings.ToUpper(fsName) {
	case "FAT", "FAT32", "EXFAT":
		return "file system " + fsName
	}
	return ""
}

// windowsFixedExcludes are excluded on every Windows backup, whatever the
// server's or the job's exclusions say (docs/WINDOWS-AGENT.md, 16.2).
var windowsFixedExcludes = []string{
	`**\pagefile.sys`, `**\hiberfil.sys`, `**\swapfile.sys`,
	`**\System Volume Information`, `**\$Recycle.Bin`,
}
