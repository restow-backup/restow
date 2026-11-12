package core

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// maxReportedErrors caps the errors array of one run report.
const maxReportedErrors = 100

// Bounds of one entry in the errors of a run report. The server refuses a
// report with a longer message (2000 characters), path (4096) or code (100),
// so a long path in what restic reports must not cost the whole report.
const (
	maxRunErrorMessageBytes = 1000
	maxRunErrorPathBytes    = 4096
	maxRunErrorCodeBytes    = 100
)

// formatBytes renders a byte count for logs (binary units).
func formatBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// kbpsToKiB converts the bandwidth limit of the configuration, kilobits per
// second (1 kbit = 1000 bit), to restic's unit KiB/s, rounding up so that a
// configured limit is never silently disabled.
func kbpsToKiB(kbps int64) int {
	if kbps <= 0 {
		return 0
	}
	kib := int(math.Ceil(float64(kbps) * 1000 / 8 / 1024))
	if kib < 1 {
		kib = 1
	}
	return kib
}

// ownFormSources splits configured paths into those written the way this
// system writes paths and those of other systems: a backup job with Linux
// and Windows machines carries /etc and C:\Users side by side
// (docs/WINDOWS-AGENT.md, 16.1). On Windows a drive path (X:\ or X:/) or a
// UNC path is the own form, elsewhere a path starting with /. Anything else
// (a relative path) stays with the own ones, where it counts as missing.
func ownFormSources(paths []string, windows bool) (own, foreign []string) {
	for _, p := range paths {
		t := strings.TrimSpace(p)
		drive := len(t) >= 3 && t[1] == ':' && (t[2] == '\\' || t[2] == '/') &&
			((t[0] >= 'a' && t[0] <= 'z') || (t[0] >= 'A' && t[0] <= 'Z'))
		var isForeign bool
		if windows {
			isForeign = strings.HasPrefix(t, "/")
		} else {
			isForeign = drive || strings.HasPrefix(t, `\\`)
		}
		if isForeign {
			foreign = append(foreign, t)
		} else {
			own = append(own, p)
		}
	}
	return own, foreign
}

// snapshotPathOf is the path restic stores a source under: the source
// itself with forward slashes on Unix; on Windows C:\Users becomes
// /C/Users, with the drive letter in capitals as the agent hands it to
// restic (docs/WINDOWS-AGENT.md, 16.4).
func snapshotPathOf(osPath string, windows bool) string {
	if !windows {
		return filepath.ToSlash(osPath)
	}
	p := strings.ReplaceAll(osPath, `\`, "/")
	if len(p) >= 2 && p[1] == ':' {
		p = "/" + strings.ToUpper(p[:1]) + p[2:]
	}
	return p
}

// sourceNote describes a configured path that is backed up under another
// name; Kind says why ("symbolic link", "junction", "mounted volume").
type sourceNote struct{ Configured, Resolved, Kind string }

// sourceSplit is what splitSources makes of the configured paths.
type sourceSplit struct {
	// existing are handed to restic, missing do not exist (a warning).
	existing, missing []string
	resolved          []sourceNote
	// problems are sources that exist but cannot be backed up as configured
	// (locked or offline drive, no access, a mount point without a drive
	// letter); each makes the run partial (docs/WINDOWS-AGENT.md, 16.5).
	problems []api.RunError
}

// reparseKind is what a Windows reparse point that is not a symbolic link is.
type reparseKind int

const (
	reparseNone     reparseKind = iota // no link: an ordinary file or folder
	reparseJunction                    // a junction (mklink /J) to a folder
	reparseVolume                      // a volume mounted in a folder
	reparseOther                       // a link restic does not follow
)

// reparsePoint describes such a reparse point: the target of a junction, the
// drive root (E:\) of a mounted volume ("" when it has none), the tag of
// anything else.
type reparsePoint struct {
	kind   reparseKind
	target string
	tag    uint32
}

// classifyReparse sorts a reparse point by its tag and substitute name
// (winapi.ParseReparseData): a mount point names a folder (\??\C:\target, a
// junction) or a volume (\??\Volume{guid}\, a mounted volume, whose drive
// root volumePaths finds); a tag without the name-surrogate bit is no link
// at all. It has no build tag, so it is tested on every system.
func classifyReparse(tag uint32, substitute string, volumePaths func(string) ([]string, error)) (reparsePoint, error) {
	if tag&winapi.ReparseTagNameSurrogate == 0 {
		return reparsePoint{kind: reparseNone}, nil
	}
	if tag != winapi.ReparseTagMountPoint {
		return reparsePoint{kind: reparseOther, tag: tag}, nil
	}
	s := strings.TrimPrefix(substitute, `\??\`)
	switch {
	case len(s) >= 3 && s[1] == ':' && s[2] == '\\' && isDriveLetterByte(s[0]):
		if len(s) > 3 {
			s = strings.TrimRight(s, `\`)
		}
		return reparsePoint{kind: reparseJunction, target: strings.ToUpper(s[:1]) + s[1:]}, nil
	case len(s) > 7 && strings.EqualFold(s[:7], "Volume{"):
		vol := `\\?\` + strings.TrimRight(s, `\`) + `\`
		names, err := volumePaths(vol)
		if err != nil {
			return reparsePoint{}, fmt.Errorf("cannot find the drive letter of the mounted volume %s: %w", vol, err)
		}
		for _, n := range names {
			if len(n) == 3 && n[1] == ':' && n[2] == '\\' && isDriveLetterByte(n[0]) {
				return reparsePoint{kind: reparseVolume, target: strings.ToUpper(n[:1]) + `:\`}, nil
			}
		}
		return reparsePoint{kind: reparseVolume}, nil
	}
	return reparsePoint{kind: reparseOther, tag: tag}, nil
}

// sourceFS is what splitSources asks of the file system; tests replace it.
type sourceFS struct {
	lstat        func(string) (fs.FileInfo, error)
	evalSymlinks func(string) (string, error)
	// reparse inspects a path whose Lstat is neither a symbolic link nor an
	// ordinary file or folder (Windows junctions and mount points, which Go
	// reports as irregular); nil where there are none.
	reparse func(path string, st fs.FileInfo) (reparsePoint, error)
}

var localSourceFS = sourceFS{lstat: os.Lstat, evalSymlinks: filepath.EvalSymlinks, reparse: platformReparse}

// splitSources separates configured paths into existing and missing ones.
// Relative paths are treated as missing: the configuration must be absolute.
// A path that is a symbolic link or a junction is replaced by its target,
// and a folder a volume is mounted at by the volume's drive, because restic
// would otherwise store only the link itself when the link is a source (this
// matters on macOS, where /etc, /var and /tmp are links, and on Windows,
// where restic treats junctions and mount points as links). A path that
// exists but cannot be read is no missing path: it is a problem of the run.
func splitSources(paths []string) sourceSplit { return splitSourcesWith(localSourceFS, paths) }

func splitSourcesWith(fsys sourceFS, paths []string) sourceSplit {
	var out sourceSplit
	seenConfigured := map[string]bool{}
	seenReal := map[string]bool{} // the same directory reached by different names
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" || seenConfigured[p] {
			continue
		}
		seenConfigured[p] = true
		if !filepath.IsAbs(p) {
			out.missing = append(out.missing, p)
			continue
		}
		configured := p
		var note *sourceNote
		var st fs.FileInfo
		ok := true
		for hop := 0; ok; hop++ {
			var err error
			st, err = fsys.lstat(p)
			if err != nil {
				ok = false
				if errors.Is(err, fs.ErrNotExist) {
					// Also the target of a junction that is gone.
					out.missing = append(out.missing, configured)
				} else {
					out.problems = append(out.problems, sourceUnreadable(configured, p, err))
				}
				break
			}
			if st.Mode()&os.ModeSymlink != 0 || st.Mode()&os.ModeIrregular == 0 || fsys.reparse == nil {
				break
			}
			if hop >= 8 {
				ok = false
				out.problems = append(out.problems, api.RunError{Code: "source_unreadable", Path: configured,
					Message: fmt.Sprintf("The backup path %s leads through more than 8 junctions or mounted volumes and was not backed up. Add the folder it ends at instead.", configured)})
				break
			}
			rp, err := fsys.reparse(p, st)
			switch {
			case err != nil:
				ok = false
				out.problems = append(out.problems, sourceUnreadable(configured, p, err))
			case rp.kind == reparseJunction:
				note = &sourceNote{Configured: configured, Resolved: rp.target, Kind: "junction"}
				p = rp.target
				continue
			case rp.kind == reparseVolume && rp.target != "":
				note = &sourceNote{Configured: configured, Resolved: rp.target, Kind: "mounted volume"}
				p = rp.target
				continue
			case rp.kind == reparseVolume:
				ok = false
				out.problems = append(out.problems, api.RunError{Code: "source_is_mount_point", Path: configured,
					Message: fmt.Sprintf("%s is a mounted volume without a drive letter; restic would back up only the mount point, not the files on the volume. Give the volume a drive letter (Disk Management) and add it to the backup by that letter, for example E:\\.", configured)})
			case rp.kind == reparseOther:
				ok = false
				out.problems = append(out.problems, api.RunError{Code: "source_unreadable", Path: configured,
					Message: fmt.Sprintf("%s is a link of a kind restic does not follow (reparse tag 0x%08X); it would back up only the link. Add the folder it points to instead.", configured, rp.tag)})
			}
			break
		}
		if !ok {
			continue
		}
		real, err := fsys.evalSymlinks(p)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				// A link whose target is gone.
				out.missing = append(out.missing, configured)
			} else {
				out.problems = append(out.problems, sourceUnreadable(configured, p, err))
			}
			continue
		}
		if st.Mode()&os.ModeSymlink != 0 {
			note = &sourceNote{Configured: configured, Resolved: real, Kind: "symbolic link"}
			p = real
		} else if note != nil {
			note.Resolved = p
		}
		if note != nil {
			out.resolved = append(out.resolved, *note)
		}
		if seenReal[real] {
			continue
		}
		seenReal[real] = true
		out.existing = append(out.existing, p)
	}
	return out
}

// sourceUnreadable is the run error for a source that exists (or may) but
// cannot be read: a drive locked by BitLocker, offline or not ready, or no
// access for the agent. The text is the system's, without the path again.
func sourceUnreadable(configured, at string, err error) api.RunError {
	cause := err
	var pe *fs.PathError
	if errors.As(err, &pe) {
		cause = pe.Err
	}
	where := ""
	if at != configured {
		where = " (at " + at + ")"
	}
	return api.RunError{Code: "source_unreadable", Path: configured,
		Message: fmt.Sprintf("The backup path %s cannot be read%s: %v. The drive may be locked (BitLocker), offline or not ready, or the agent has no access to it. It was not backed up.", configured, where, cause)}
}

// linkedSourcesWithFiles is the safety net of a backup in which restic
// processed no file at all: it returns a run error for each source that was
// configured as a link or mount point (a symbolic link, junction or mounted
// volume that splitSources resolved) and that is a file or holds a file
// directly. Only there can "no file" mean that restic stored the link
// instead of following it; a link in a folder above a source is followed by
// the system for restic as for everyone. A plain folder whose files the
// job's exclusions (patterns, the size limit, online-only cloud files) leave
// out is a correct empty backup and no error.
func linkedSourcesWithFiles(resolved []sourceNote, sources []string) []api.RunError {
	var errs []api.RunError
	seen := map[string]bool{}
	check := func(configured, src string) {
		if seen[src] {
			return
		}
		seen[src] = true
		if !holdsFile(src) {
			return
		}
		name := src
		if configured != src {
			name = configured + " (backed up as " + src + ")"
		}
		errs = append(errs, api.RunError{Code: "source_unreadable", Path: configured,
			Message: fmt.Sprintf("restic backed up no file from %s, although it contains files and is configured as a link or mounted volume. restic may have stored the link instead of following it, or the exclusions of the backup job leave nothing of it.", name)})
	}
	for _, src := range sources {
		for _, r := range resolved {
			if r.Resolved == src {
				check(r.Configured, src)
			}
		}
	}
	return errs
}

// holdsFile reports whether a path is a regular file or a folder with a
// regular file directly in it.
func holdsFile(src string) bool {
	st, err := os.Stat(src)
	if err != nil {
		return false
	}
	if st.Mode().IsRegular() {
		return true
	}
	if !st.IsDir() {
		return false
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Type().IsRegular() {
			return true
		}
	}
	return false
}

// capErrors limits the number of reported errors and says how many were
// dropped: those cut here plus `unlisted`, errors that were counted but not
// kept before (restic's per-file errors beyond the first hundred). Each entry
// is bounded to what the server accepts (shortened in the middle: restic
// names the cause last, after the path).
func capErrors(errs []api.RunError, unlisted int) []api.RunError {
	unlisted = max(unlisted, 0)
	keep := len(errs)
	if len(errs) > maxReportedErrors || unlisted > 0 {
		keep = min(len(errs), maxReportedErrors-1)
	}
	out := make([]api.RunError, 0, keep+1)
	for _, e := range errs[:keep] {
		out = append(out, api.RunError{
			Path:    shortenMiddle(e.Path, maxRunErrorPathBytes),
			Message: shortenMiddle(e.Message, maxRunErrorMessageBytes),
			Code:    shortenMiddle(e.Code, maxRunErrorCodeBytes),
		})
	}
	if dropped := len(errs) - keep + unlisted; dropped > 0 {
		out = append(out, api.RunError{Message: fmt.Sprintf("%d more errors are not listed here; see the log tail and the agent log on the machine", dropped), Code: "truncated"})
	}
	return out
}

// shortenMiddle keeps the start and the end of s within limit bytes, as
// valid UTF-8, with " ... " in between.
func shortenMiddle(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	const gap = " ... "
	head := limit / 4
	tail := limit - head - len(gap)
	return strings.ToValidUTF8(s[:head], "") + gap + strings.ToValidUTF8(s[len(s)-tail:], "")
}

// snapshotToLocalPath maps a path as stored in a snapshot to the path on this
// machine: on Linux and macOS they are identical, on Windows /C/Users/a.txt
// is C:\Users\a.txt (snapshotPathOf the other way round).
func snapshotToLocalPath(p string) string {
	return snapshotToLocalPathFor(p, runtime.GOOS == "windows")
}

// snapshotToLocalPathFor is snapshotToLocalPath for the given system, so the
// Windows form is tested everywhere. Only a first segment of a single drive
// letter is a drive (/C/x -> C:\x, /C -> C:\); any other path only gets
// backslashes (docs/WINDOWS-AGENT.md, 16.4).
func snapshotToLocalPathFor(p string, windows bool) string {
	if !windows {
		return filepath.FromSlash(p)
	}
	if len(p) >= 2 && p[0] == '/' && isDriveLetterByte(p[1]) && (len(p) == 2 || p[2] == '/') {
		rest := strings.TrimPrefix(p[2:], "/")
		return strings.ToUpper(p[1:2]) + `:\` + strings.ReplaceAll(rest, "/", `\`)
	}
	return strings.ReplaceAll(p, "/", `\`)
}

func isDriveLetterByte(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// hashFile returns the SHA-256 (hex) and size of a file, stopping early when
// done is closed.
func hashFile(path string, done <-chan struct{}) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 256*1024)
	var total int64
	for {
		select {
		case <-done:
			return "", 0, fmt.Errorf("hashing %s was interrupted", path)
		default:
		}
		n, err := f.Read(buf)
		if n > 0 {
			_, _ = h.Write(buf[:n])
			total += int64(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", 0, err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), total, nil
}

// removeAllForce deletes a directory tree that may contain directories without
// write permission (restic restores the original modes).
func removeAllForce(dir string) error {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(p, 0o700)
		}
		return nil
	})
	return os.RemoveAll(dir)
}

// targetError carries the run error code of a refused restore target.
type targetError struct {
	code string
	msg  string
}

func (e *targetError) Error() string { return e.msg }

func targetFail(code, format string, args ...any) error {
	return &targetError{code: code, msg: fmt.Sprintf(format, args...)}
}

// shortID shortens a snapshot id for display.
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func trimTime(t time.Time) time.Time { return t.UTC().Truncate(time.Second) }
