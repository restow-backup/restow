package core

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
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
	// Volumes mounted in a folder below a source that VSS cannot do are in
	// excluded too, by that folder (C:\Data\Archive\).
	volumes  []string
	excluded []string
	notes    []string
	// vssExclude is what restic is told to read live
	// (-o vss.exclude-volumes): excluded, with a mounted folder by its
	// volume GUID path when known (restic compares the volume, and a folder
	// name may hold the list's separator ";").
	vssExclude []string
	// volumesUnknown: the volume of at least one source could not be
	// determined; restic may still have snapshotted it.
	volumesUnknown bool
	// unavailable is set when a snapshot is wanted but cannot be taken at
	// all (for example without administrator rights); it is the message.
	unavailable string
}

// volumeSystem is what planning a shadow copy asks of the machine's volumes:
// Windows (winVolumes, snapshot_windows.go) or a fake in the tests.
type volumeSystem interface {
	// VolumePathName is the mount point of the volume a path is on (C:\,
	// C:\Data\Archive\).
	VolumePathName(path string) (string, error)
	// DriveType and FileSystem describe the volume at a mount point or
	// volume GUID path.
	DriveType(root string) uint32
	FileSystem(root string) (string, error)
	// VolumeName is the volume GUID path (\\?\Volume{...}\) of the volume
	// mounted at a drive root or folder.
	VolumeName(mountPoint string) (string, error)
	// MountPoints lists the folders of the volume of a drive root (C:\)
	// that other volumes are mounted at, relative to the root
	// (Data\Archive\); FindFirstVolumeMountPointW, the call restic makes.
	MountPoints(root string) ([]string, error)
}

// planVolumes fills in the volumes of a backup that asks for a shadow copy
// (docs/WINDOWS-AGENT.md, 17.1 and 17.2). Each source's volume is snapshotted
// unless VSS certainly cannot do it (vssExcludeReason); restic is then told
// to read it live. restic also snapshots the volumes mounted in folders of a
// drive (vss.exclude-all-mount-points stays off) and reads a folder whose
// volume it cannot snapshot from the live file system without a word in its
// JSON output. The folders below a source are therefore looked at the same
// way: one VSS cannot do is excluded and named among the volumes read live,
// so the report does not claim a shadow copy for its files.
func planVolumes(p *snapshotPlan, sys volumeSystem, sources []string) {
	seen := map[string]bool{}
	for _, s := range sources {
		vol, err := sys.VolumePathName(s)
		if err != nil || vol == "" {
			p.volumesUnknown = true
			continue
		}
		vol = restic.NormalizeVolume(vol)
		key := strings.ToUpper(vol)
		if seen[key] {
			continue
		}
		seen[key] = true
		fsName, ferr := sys.FileSystem(vol)
		if ferr != nil {
			fsName = ""
		}
		if reason := vssExcludeReason(sys.DriveType(vol), fsName); reason != "" {
			p.excluded = append(p.excluded, vol)
			p.vssExclude = append(p.vssExclude, vol)
			p.notes = append(p.notes, fmt.Sprintf("%s is read without a shadow copy: %s.", vol, reason))
			continue
		}
		p.volumes = append(p.volumes, vol)
	}
	// restic snapshots a path's drive (filepath.VolumeName) with the folders
	// mounted on it; a drive read live as a whole needs no look inside.
	var roots []string
	for _, s := range sources {
		root := driveRootOf(s)
		if root == "" || containsFold(roots, root) || containsFold(p.excluded, root) {
			continue
		}
		roots = append(roots, root)
	}
	for _, root := range roots {
		rels, err := sys.MountPoints(root)
		if err != nil {
			p.notes = append(p.notes, fmt.Sprintf("The folders of %s that other volumes are mounted at could not be listed (%v): restic reads such a folder without a shadow copy when it cannot snapshot its volume.", root, err))
			continue
		}
		for _, rel := range rels {
			mp := root + strings.TrimLeft(rel, `\`)
			if !strings.HasSuffix(mp, `\`) {
				mp += `\`
			}
			if !belowAnySource(mp, sources) {
				continue
			}
			key := strings.ToUpper(mp)
			if seen[key] {
				continue
			}
			seen[key] = true
			target := mp
			if id, err := sys.VolumeName(mp); err == nil && id != "" {
				target = id
			}
			fsName, ferr := sys.FileSystem(target)
			if ferr != nil {
				fsName = ""
			}
			if reason := vssExcludeReason(sys.DriveType(target), fsName); reason != "" {
				p.excluded = append(p.excluded, mp)
				p.vssExclude = append(p.vssExclude, target)
				p.notes = append(p.notes, fmt.Sprintf("%s (a volume mounted in a folder) is read without a shadow copy: %s.", mp, reason))
			}
		}
	}
}

// driveRootOf is the drive root (C:\) of a drive path, else "".
func driveRootOf(p string) string {
	if len(p) >= 2 && p[1] == ':' && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')) {
		return strings.ToUpper(p[:1]) + `:\`
	}
	return ""
}

// belowAnySource reports whether the folder dir (with a trailing backslash)
// is a source or lies below one, without case.
func belowAnySource(dir string, sources []string) bool {
	d := strings.ToUpper(dir)
	for _, s := range sources {
		s = strings.ToUpper(strings.ReplaceAll(s, "/", `\`))
		if !strings.HasSuffix(s, `\`) {
			s += `\`
		}
		if strings.HasPrefix(d, s) {
			return true
		}
	}
	return false
}

func containsFold(list []string, v string) bool {
	for _, l := range list {
		if strings.EqualFold(l, v) {
			return true
		}
	}
	return false
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

// consistencyOf rates what happened to the snapshot of a backup that got as
// far as restic. unavailable: no snapshot could be taken at all. "used"
// needs at least one volume that really came from a snapshot; volumes read
// live (failed, excluded from the start, not supported by the provider) are
// listed in LiveFilesystems with any state, and when no volume is left the
// state is "unavailable" with that list (docs/WINDOWS-AGENT.md, 17.5).
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
	notSnapshotted := map[string]bool{}
	for _, f := range out.FailedVolumes {
		add(f.Volume)
		notSnapshotted[strings.ToUpper(f.Volume)] = true
	}
	for _, v := range out.SkippedVolumes {
		add(v)
		notSnapshotted[strings.ToUpper(v)] = true
	}
	for _, v := range plan.excluded {
		add(v)
	}
	snapshotted := 0
	for _, v := range plan.volumes {
		if !notSnapshotted[strings.ToUpper(v)] {
			snapshotted++
		}
	}
	// Without any known volume (and none excluded) the plan says nothing:
	// what restic did not report as failed or skipped came from a snapshot.
	known := !plan.volumesUnknown && len(plan.volumes)+len(plan.excluded) > 0
	switch {
	case unavailable || plan.unavailable != "":
		c.State = api.ConsistencyUnavailable
		live = nil
	case known && snapshotted == 0:
		c.State = api.ConsistencyUnavailable
	case len(out.FailedVolumes) == 0:
		c.State = api.ConsistencyUsed
	default:
		c.State = api.ConsistencyPartial
	}
	if len(live) > api.MaxLiveFilesystems {
		live = live[:api.MaxLiveFilesystems]
	}
	c.LiveFilesystems = live
	return c
}

// snapshotFailedErrors are the run errors for the volumes whose snapshot
// failed; under continue restic read them live. A failure whose text says
// that the Volume Shadow Copy service cannot be used on the machine at all
// (disabled, access denied, restic.MachineWideCause) is no transient
// snapshot_failed of a volume: those volumes become one snapshot_unavailable
// with the cause, so the run tells the administrator to start the service
// instead of waiting for the next try. machineWide reports that case.
func snapshotFailedErrors(out restic.SnapshotOutcome, stopped bool) (errs []api.RunError, machineWide bool) {
	cause, machine, single := out.SplitMachineWide()
	if len(machine) > 0 {
		vols := make([]string, len(machine))
		for i, f := range machine {
			vols[i] = f.Volume
		}
		msg := fmt.Sprintf("The file system snapshot (Volume Shadow Copy) cannot be used on this machine: %s (%s: %s). ",
			cause, strings.Join(vols, ", "), strings.TrimSuffix(strings.TrimSpace(machine[0].Message), "."))
		if stopped {
			msg += "The backup was stopped, as the policy for a failed file system snapshot asks."
		} else {
			msg += "The backup ran without it, from the live file system."
		}
		errs = append(errs, api.RunError{Code: "snapshot_unavailable", Message: msg})
	}
	for _, f := range single {
		msg := fmt.Sprintf("The shadow copy of %s could not be created (%s). ", f.Volume, f.Message)
		if stopped {
			msg += "The backup was stopped, as the policy for a failed file system snapshot asks."
		} else {
			msg += "The volume was read from the live file system: files that changed during the backup may be inconsistent."
		}
		errs = append(errs, api.RunError{Code: "snapshot_failed", Path: f.Volume, Message: msg})
	}
	return errs, len(machine) > 0
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

// snapshotUnavailableError is the run error for a backup without any
// snapshot that the agent knew of beforehand (no rights for it).
func snapshotUnavailableError(reason string, fallback bool) api.RunError {
	return unavailableError("The file system snapshot (Volume Shadow Copy) cannot be used on this machine: "+reason+". ", fallback)
}

// vssSetupFailedError is the run error for a backup whose restic could not
// set up the shadow copy (VssApi.dll, COM, a VSS error), with restic's text.
func vssSetupFailedError(text string, fallback bool) api.RunError {
	return unavailableError("restic could not initialise the Volume Shadow Copy service: "+strings.TrimSuffix(strings.TrimSpace(text), ".")+". ", fallback)
}

func unavailableError(msg string, fallback bool) api.RunError {
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
	if cause, _, _ := out.SplitMachineWide(); cause != "" {
		rl.Warnf("The Volume Shadow Copy service cannot be used on this machine: %s. Check the service \"Volume Shadow Copy\" (VSS) in services.msc; see %s.", cause, snapshotLogHint)
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
