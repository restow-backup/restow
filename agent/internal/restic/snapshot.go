package restic

import (
	"strings"
)

// File system snapshots (Windows: VSS through restic --use-fs-snapshot).
//
// restic says nothing in its JSON output when a shadow copy works, and when
// one fails it reports an error for the volume, reads that volume from the
// live file system and still ends with exit code 0 (docs/WINDOWS-AGENT.md,
// sections 1.2 and 17.3). The agent therefore reads restic's error entries:
// the texts below are restic 0.19's own formats (internal/fs/fs_local_vss.go,
// internal/fs/vss_windows.go). The classification has no build tag, so it is
// tested on every system.

// VolumeFailure is one volume and what restic said about it.
type VolumeFailure struct {
	Volume  string
	Message string
}

// SnapshotOutcome is what happened to the file system snapshot of a backup.
type SnapshotOutcome struct {
	// Requested: the backup ran with --use-fs-snapshot.
	Requested bool
	// FailedVolumes could not be snapshotted; restic read them live.
	FailedVolumes []VolumeFailure
	// SkippedVolumes are volumes the snapshot provider does not support;
	// restic read them live. Not an error (docs/WINDOWS-AGENT.md, 17.4).
	SkippedVolumes []string
	// CleanupFailed are shadow copies restic could not delete after the run.
	CleanupFailed []VolumeFailure
	// Warnings are configuration problems with single mount points.
	Warnings []string
}

type snapshotKind int

const (
	snapNone snapshotKind = iota
	snapFailed
	snapUnsupported
	snapCleanup
	snapWarning
)

const (
	vssCreatePrefix  = "failed to create snapshot for ["
	vssUnsupported   = "Snapshots are not supported for volume"
	vssDeletePrefix  = "failed to delete VSS snapshot"
	vssMountPoint    = "failed to get volume from mount point"
	vssParseExcludes = "failed to parse vss.exclude-volumes"
)

// classifySnapshotError sorts one restic error entry. volume is the volume
// it names (restic's item, else the text between the brackets).
func classifySnapshotError(item, message string) (kind snapshotKind, volume string) {
	msg := strings.TrimSpace(message)
	switch {
	case strings.HasPrefix(msg, vssCreatePrefix):
		volume = item
		if volume == "" {
			rest := msg[len(vssCreatePrefix):]
			if i := strings.Index(rest, "]"); i >= 0 {
				volume = rest[:i]
			}
		}
		if strings.Contains(msg, vssUnsupported) {
			return snapUnsupported, NormalizeVolume(volume)
		}
		return snapFailed, NormalizeVolume(volume)
	case strings.HasPrefix(msg, vssDeletePrefix):
		return snapCleanup, NormalizeVolume(item)
	case strings.HasPrefix(msg, vssMountPoint), strings.HasPrefix(msg, vssParseExcludes):
		return snapWarning, item
	}
	return snapNone, ""
}

// record adds one classified entry; it reports whether the entry was a
// snapshot entry (and so not a file error).
func (o *SnapshotOutcome) record(item, message string) (snapshotKind, bool) {
	kind, volume := classifySnapshotError(item, message)
	switch kind {
	case snapFailed:
		o.FailedVolumes = append(o.FailedVolumes, VolumeFailure{Volume: volume, Message: message})
	case snapUnsupported:
		o.SkippedVolumes = append(o.SkippedVolumes, volume)
	case snapCleanup:
		o.CleanupFailed = append(o.CleanupFailed, VolumeFailure{Volume: volume, Message: message})
	case snapWarning:
		w := message
		if item != "" {
			w = item + ": " + message
		}
		o.Warnings = append(o.Warnings, w)
	default:
		return snapNone, false
	}
	return kind, true
}

// NormalizeVolume writes a drive volume with a capital letter and a trailing
// backslash (c:\ -> C:\, C: -> C:\); other forms (\\?\Volume{...}\) stay.
func NormalizeVolume(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 && v[1] == ':' && isDriveLetter(v[0]) && (len(v) == 2 || (len(v) == 3 && (v[2] == '\\' || v[2] == '/'))) {
		return strings.ToUpper(v[:1]) + `:\`
	}
	return v
}

// UpperDrive writes the drive letter of a Windows drive path in capitals
// (c:\Users -> C:\Users). restic takes the letter literally into the
// snapshot path (/c/Users vs /C/Users), so two spellings would make two
// trees (docs/WINDOWS-AGENT.md, 16.4). Other paths are returned unchanged.
func UpperDrive(p string) string {
	if len(p) >= 2 && p[1] == ':' && isDriveLetter(p[0]) && p[0] >= 'a' {
		return strings.ToUpper(p[:1]) + p[1:]
	}
	return p
}

func isDriveLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// SnapshotFault says whether a failed backup with --use-fs-snapshot failed
// because of the snapshot itself.
type SnapshotFault int

const (
	// SnapshotFaultNone: the failure has nothing to do with the snapshot.
	SnapshotFaultNone SnapshotFault = iota
	// SnapshotFaultCertain: restic ended before reading anything with a
	// text of its VSS setup (VssApi.dll, COM, VSS error): the shadow copy
	// service cannot be used at all.
	SnapshotFaultCertain
	// SnapshotFaultPossible: restic ended with exit code 1 before reading
	// anything, with a text that matches nothing known. A second run
	// without the snapshot tells (docs/WINDOWS-AGENT.md, 17.3).
	SnapshotFaultPossible
)

// vssSetupMarkers are texts of restic's VSS setup (HasSufficientPrivilegesForVSS
// and the VSS errors of vss_windows.go), compared without case.
var vssSetupMarkers = []string{"vss error", "vss_e_", "vssapi.dll", "coinitializeex", "coinitializesecurity", "can't use vss"}

// snapshotFaultOf rates a failed `restic backup` that ran with
// --use-fs-snapshot. sawProgress is whether restic reported any status
// line (it then got past the snapshot setup).
func snapshotFaultOf(exitCode int, sawProgress bool, fatal string, stderr []string) SnapshotFault {
	if exitCode != ExitFatal || sawProgress {
		return SnapshotFaultNone
	}
	text := strings.ToLower(fatal + "\n" + strings.Join(stderr, "\n"))
	for _, m := range vssSetupMarkers {
		if strings.Contains(text, m) {
			return SnapshotFaultCertain
		}
	}
	return SnapshotFaultPossible
}
