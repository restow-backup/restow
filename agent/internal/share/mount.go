package share

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// GuardError is a refusal of the mount guard (4.2): the share is not mounted
// as expected, so nothing may be read or written.
type GuardError struct {
	Code   string
	Detail string
}

func (e *GuardError) Error() string { return e.Code + ": " + e.Detail }

// MountEntry is one line of /proc/self/mountinfo.
type MountEntry struct {
	MountPoint string
	FSType     string
	Options    []string // per-mount options (field 6): ro|rw, ...
	Super      []string // super options
}

// ParseMountInfo parses /proc/self/mountinfo (proc(5)). Mount points are
// unescaped (\040 for a space and the other octal escapes).
func ParseMountInfo(data []byte) []MountEntry {
	var out []MountEntry
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		sep := -1
		for i, f := range fields {
			if f == "-" {
				sep = i
				break
			}
		}
		if sep < 6 || len(fields) < sep+4 {
			continue
		}
		out = append(out, MountEntry{
			MountPoint: unescapeMountField(fields[4]),
			Options:    strings.Split(fields[5], ","),
			FSType:     fields[sep+1],
			Super:      strings.Split(fields[sep+3], ","),
		})
	}
	return out
}

func unescapeMountField(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			b.WriteByte((s[i+1]-'0')<<6 | (s[i+2]-'0')<<3 | (s[i+3] - '0'))
			i += 3
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isOctal(c byte) bool { return c >= '0' && c <= '7' }

// FindMount returns the last (top-most) entry for mountPoint.
func FindMount(entries []MountEntry, mountPoint string) (MountEntry, bool) {
	var found MountEntry
	ok := false
	for _, e := range entries {
		if e.MountPoint == mountPoint {
			found, ok = e, true
		}
	}
	return found, ok
}

func hasOption(options []string, want string) bool {
	for _, o := range options {
		if o == want {
			return true
		}
	}
	return false
}

// fsTypeMatches says whether a mount's type is one of the protocol's.
func fsTypeMatches(protocol, fsType string) bool {
	switch protocol {
	case ProtocolSMB:
		return fsType == "cifs" || fsType == "smb3"
	case ProtocolNFS:
		return fsType == "nfs" || fsType == "nfs4"
	}
	return false
}

func magicMatches(protocol string, magic int64) bool {
	switch protocol {
	case ProtocolSMB:
		return magic == MagicCIFS || magic == MagicSMB2
	case ProtocolNFS:
		return magic == MagicNFS
	}
	return false
}

// GuardResult is what a passed guard learned about the mount.
type GuardResult struct {
	FSType   string
	ReadOnly bool
}

// CheckMount is the mount guard (4.2 steps 1 and 2): root must be a mount of
// the expected protocol's file system, read-only when readOnly is asked for
// and read-write otherwise. Step 3 (readdir) is the callers' business.
func CheckMount(sys System, root, protocol string, readOnly bool) (GuardResult, error) {
	if protocol != ProtocolSMB && protocol != ProtocolNFS {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem, Detail: fmt.Sprintf("unknown protocol %q", protocol)}
	}
	magic, err := sys.Statfs(root)
	if err != nil {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem, Detail: err.Error()}
	}
	if !magicMatches(protocol, magic) {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem,
			Detail: fmt.Sprintf("%s is not an %s mount (file system type 0x%x): the share is not mounted", root, protocol, magic)}
	}
	info, err := sys.MountInfo()
	if err != nil {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem, Detail: "cannot read the mount table: " + err.Error()}
	}
	entry, ok := FindMount(ParseMountInfo(info), root)
	if !ok {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem, Detail: root + " is not a mount point"}
	}
	if !fsTypeMatches(protocol, entry.FSType) {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem,
			Detail: fmt.Sprintf("%s is mounted as %s, expected %s", root, entry.FSType, protocol)}
	}
	ro := hasOption(entry.Options, "ro")
	if readOnly && !ro {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem, Detail: root + " is mounted read-write where read-only was asked for"}
	}
	if !readOnly && ro {
		return GuardResult{}, &GuardError{Code: CodeWrongFilesystem, Detail: root + " is mounted read-only; a restore needs it writable"}
	}
	return GuardResult{FSType: entry.FSType, ReadOnly: ro}, nil
}

// classifyReadError maps an error of reading the share to a run code.
func classifyReadError(err error) string {
	switch {
	case isAccess(err):
		return CodePermissionDenied
	case isUnreachable(err):
		return CodeUnreachable
	case errors.Is(err, os.ErrNotExist):
		return CodeNotFound
	}
	return CodeInternal
}
