package share

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// probe and list (4.9): the synchronous operations the mounter runs in a
// container without network, the share mounted read-only. Both print one
// JSON document on stdout.

// ListEntry is one entry of a folder.
type ListEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // dir | file | symlink | other
	Size int64  `json:"size"`
	// MTime in RFC 3339, UTC.
	MTime string `json:"mtime"`
	// InvalidName: the name is not valid UTF-8 and is shown with replacement
	// characters; it cannot be picked as an include folder.
	InvalidName bool `json:"invalidName,omitempty"`
}

// PermissionsInfo says whether the permissions can be read and how.
type PermissionsInfo struct {
	Readable bool   `json:"readable"`
	Xattr    string `json:"xattr"`
	Detail   string `json:"detail,omitempty"`
}

// ProbeResult is the output of probe and list.
type ProbeResult struct {
	OK          bool             `json:"ok"`
	Code        string           `json:"code,omitempty"`
	Detail      string           `json:"detail,omitempty"`
	FSType      string           `json:"fsType,omitempty"`
	ReadOnly    bool             `json:"readOnly,omitempty"`
	Path        *string          `json:"path,omitempty"`
	Entries     []ListEntry      `json:"entries,omitempty"`
	Truncated   bool             `json:"truncated,omitempty"`
	Permissions *PermissionsInfo `json:"permissions,omitempty"`
	DurationMs  int64            `json:"durationMs"`
}

// List limits (4.9).
const (
	DefaultListLimit = 500
	MaxListLimit     = 2000
	ProbeListLimit   = 100
)

func probeFailure(err error, started time.Time, now func() time.Time) (ProbeResult, int) {
	var ge *GuardError
	if errors.As(err, &ge) {
		return ProbeResult{OK: false, Code: ge.Code, Detail: ge.Detail, DurationMs: now().Sub(started).Milliseconds()}, ExitGuard
	}
	return ProbeResult{OK: false, Code: classifyReadError(err), Detail: err.Error(),
		DurationMs: now().Sub(started).Milliseconds()}, ExitFailed
}

// Probe checks the mount, lists the top level and checks the ACL access.
func Probe(sys System, root, protocol string, now func() time.Time) (ProbeResult, int) {
	started := now()
	guard, err := CheckMount(sys, root, protocol, true)
	if err != nil {
		return probeFailure(err, started, now)
	}
	entries, truncated, err := listDir(root, ProbeListLimit)
	if err != nil {
		return probeFailure(err, started, now)
	}
	mode, aclErr := ChooseACLXattr(sys, root, protocol)
	perm := &PermissionsInfo{Readable: mode != ACLModeNone, Xattr: mode}
	if aclErr != nil {
		perm.Detail = aclErr.Error()
	}
	return ProbeResult{OK: true, FSType: guard.FSType, ReadOnly: guard.ReadOnly, Entries: entries,
		Truncated: truncated, Permissions: perm, DurationMs: now().Sub(started).Milliseconds()}, ExitOK
}

// List lists one folder level of the live share.
func List(sys System, root, protocol, rel string, limit int, now func() time.Time) (ProbeResult, int) {
	started := now()
	rel = strings.Trim(rel, "/")
	if !ValidRelative(rel) {
		return ProbeResult{OK: false, Code: CodeNotFound, Detail: "the path is not a valid relative path"}, ExitUsage
	}
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaxListLimit {
		limit = MaxListLimit
	}
	guard, err := CheckMount(sys, root, protocol, true)
	if err != nil {
		return probeFailure(err, started, now)
	}
	entries, truncated, err := listDir(filepath.Join(root, filepath.FromSlash(rel)), limit)
	if err != nil {
		return probeFailure(err, started, now)
	}
	return ProbeResult{OK: true, FSType: guard.FSType, ReadOnly: guard.ReadOnly, Path: &rel, Entries: entries,
		Truncated: truncated, DurationMs: now().Sub(started).Milliseconds()}, ExitOK
}

// listDir: folders first, then by name; at most limit entries.
func listDir(dir string, limit int) ([]ListEntry, bool, error) {
	des, err := os.ReadDir(dir)
	if err != nil {
		return nil, false, err
	}
	out := make([]ListEntry, 0, len(des))
	for _, de := range des {
		e := ListEntry{Name: de.Name(), Type: "other"}
		if !utf8.ValidString(e.Name) {
			e.Name, e.InvalidName = strings.ToValidUTF8(e.Name, "�"), true
		}
		if fi, err := de.Info(); err == nil {
			switch {
			case fi.IsDir():
				e.Type = "dir"
			case fi.Mode().IsRegular():
				e.Type, e.Size = "file", fi.Size()
			case fi.Mode()&os.ModeSymlink != 0:
				e.Type = "symlink"
			}
			e.MTime = fi.ModTime().UTC().Format(time.RFC3339)
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(a, b int) bool {
		da, db := out[a].Type == "dir", out[b].Type == "dir"
		if da != db {
			return da
		}
		return out[a].Name < out[b].Name
	})
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}
