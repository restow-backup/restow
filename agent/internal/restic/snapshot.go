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
	// vssErrorPrefix starts an entry restic writes for a volume mounted in a
	// folder whose shadow copy it made but cannot use
	// ("VSS error: GetSnapshotProperties() for mount point c:\mnt\x\
	// returned error: ...", vss_windows.go:1074): restic reads that folder
	// live and ends with exit code 0. Every other entry restic writes about a
	// shadow copy starts with one of the prefixes above.
	vssErrorPrefix      = "VSS error:"
	vssMountPointMarker = "for mount point "
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
	case strings.HasPrefix(msg, vssErrorPrefix):
		volume = item
		if volume == "" {
			if i := strings.Index(msg, vssMountPointMarker); i >= 0 {
				rest := msg[i+len(vssMountPointMarker):]
				if j := strings.Index(rest, " returned"); j >= 0 {
					volume = rest[:j]
				} else if j := strings.IndexByte(rest, ' '); j >= 0 {
					volume = rest[:j]
				} else {
					volume = rest
				}
			}
		}
		return snapFailed, UpperDrive(NormalizeVolume(volume))
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

// vssMachineMarkers are texts in a volume's "failed to create snapshot" entry
// that say the Volume Shadow Copy service cannot be used on the whole
// machine, not that this one shadow copy failed (compared without case).
// restic's HasSufficientPrivilegesForVSS only loads VssApi.dll and creates
// the in-process backup components, so it passes when the service is
// disabled or COM refuses the requester; the service is first contacted in
// NewVssSnapshot for every volume (InitializeForBackup, GatherWriterMetadata),
// whose error restic writes per volume and ends with exit code 0. restic
// prints an HRESULT it has no name for as "UNKNOWN (0x80070422)".
//
// certain: the text alone proves it (a disabled or missing service, a
// restic.exe of another architecture, a provider that does not exist: no
// volume of the machine can get a shadow copy). Access denied is no such
// proof, as it can concern one volume or its provider; it counts only when
// every planned volume failed with it (SplitMachineWide).
//
// A failure of every volume is no marker by itself: a second backup program
// taking a shadow copy at the same time (VSS_E_SNAPSHOT_SET_IN_PROGRESS), a
// writer in a bad state or a provider fault (VSS_E_UNEXPECTED_PROVIDER_ERROR,
// often one volume's storage) fails every volume as well and passes.
var vssMachineMarkers = []struct {
	marker, cause string
	certain       bool
}{
	{"0x80070422", "the Volume Shadow Copy service (VSS) is disabled", true},
	{"0x80070424", "the Volume Shadow Copy service (VSS) is not installed", true},
	{"0x8007042c", "a service the Volume Shadow Copy service (VSS) depends on did not start", true},
	{"can't use vss", "restic.exe was built for another processor architecture than this Windows", true},
	{"failed to detect windows architecture", "restic could not detect the processor architecture of Windows", true},
	{"invalid vss provider", "the configured shadow copy provider does not exist on this machine", true},
	{"0x80070005", "Windows denied the agent access to the Volume Shadow Copy service", false},
	{"e_accessdenied", "Windows denied the agent access to the Volume Shadow Copy service", false},
}

// machineWideMarker returns the cause a volume's failure text names, and
// whether the text alone proves that VSS cannot be used on the machine.
func machineWideMarker(message string) (cause string, certain bool) {
	m := strings.ToLower(message)
	for _, k := range vssMachineMarkers {
		if strings.Contains(m, k.marker) {
			return k.cause, k.certain
		}
	}
	return "", false
}

// MachineWideCause returns why the Volume Shadow Copy service cannot be used
// on the machine at all when a volume's failure text may say so, else "".
func MachineWideCause(message string) string {
	cause, _ := machineWideMarker(message)
	return cause
}

// SplitMachineWide separates the failed volumes whose text says that VSS
// cannot be used on the machine at all (with the first such cause) from the
// failures of single shadow copies. planned are the volumes the backup asked
// a shadow copy of (nil when not all are known). It is machine-wide only when
// a failure's text proves it (a disabled service), or when every planned
// volume failed with a marker such as access denied: a volume that restic did
// snapshot shows that VSS works on the machine, so with C:\ snapshotted a
// failure of D:\ stays a failure of D:\.
func (o SnapshotOutcome) SplitMachineWide(planned []string) (cause string, machine, single []VolumeFailure) {
	proven := false
	marked := map[string]bool{}
	for _, f := range o.FailedVolumes {
		if c, certain := machineWideMarker(f.Message); c != "" {
			marked[strings.ToUpper(NormalizeVolume(f.Volume))] = true
			proven = proven || certain
		}
	}
	all := len(planned) > 0
	for _, v := range planned {
		if !marked[strings.ToUpper(NormalizeVolume(v))] {
			all = false
			break
		}
	}
	if !proven && !all {
		return "", nil, o.FailedVolumes
	}
	for _, f := range o.FailedVolumes {
		if c := MachineWideCause(f.Message); c != "" {
			if cause == "" {
				cause = c
			}
			machine = append(machine, f)
			continue
		}
		single = append(single, f)
	}
	return cause, machine, single
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
	// anything, with a text that matches nothing known, neither VSS nor the
	// repository or the network. It is an ordinary failure: in restic 0.19
	// the only fatal VSS path is its setup (HasSufficientPrivilegesForVSS),
	// whose texts are known; the agent only says in the log that VSS may be
	// the cause should it repeat (docs/WINDOWS-AGENT.md, 17.3).
	SnapshotFaultPossible
)

// vssSetupMarkers are texts of restic's VSS setup (HasSufficientPrivilegesForVSS
// and the VSS errors of vss_windows.go), compared without case, including
// the raw OLE errors of CoInitializeEx (go-ole's OleError is the system's
// text of the HRESULT, for example RPC_E_CHANGED_MODE).
var vssSetupMarkers = []string{
	"vss error", "vss_e_", "vssapi.dll", "coinitializeex", "coinitializesecurity", "can't use vss",
	"cannot change thread mode after it is set", "0x80010106", "catastrophic failure", "0x8000ffff",
}

// repositoryMarkers are texts of failures of the repository or the network
// (restic's "unable to open config file", "Load(<key/...>)", the HTTP
// client): such a failure is never put down to the snapshot.
var repositoryMarkers = []string{
	"unable to open", "dial tcp", "http response", "load(<", "i/o timeout", "connection refused",
	"connection reset", "no such host", "x509:", "tls:", "server response unexpected",
	"unexpected http", "repository", "context deadline exceeded", "eof",
}

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
	for _, m := range repositoryMarkers {
		if strings.Contains(text, m) {
			return SnapshotFaultNone
		}
	}
	return SnapshotFaultPossible
}
