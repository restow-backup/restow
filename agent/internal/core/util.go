package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
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

// sourceNote describes a configured path that is backed up under another name.
type sourceNote struct{ Configured, Resolved string }

// splitSources separates configured paths into existing and missing ones.
// Relative paths are treated as missing: the configuration must be absolute.
// A path that is a symbolic link is replaced by its target, because restic
// would otherwise store only the link itself when the link is a source (this
// matters on macOS, where /etc, /var and /tmp are links).
func splitSources(paths []string) (existing, missing []string, resolved []sourceNote) {
	seenConfigured := map[string]bool{}
	seenReal := map[string]bool{} // the same directory reached by different names
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" || seenConfigured[p] {
			continue
		}
		seenConfigured[p] = true
		if !filepath.IsAbs(p) {
			missing = append(missing, p)
			continue
		}
		st, err := os.Lstat(p)
		if err != nil {
			missing = append(missing, p)
			continue
		}
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			missing = append(missing, p)
			continue
		}
		if st.Mode()&os.ModeSymlink != 0 {
			resolved = append(resolved, sourceNote{Configured: p, Resolved: real})
			p = real
		}
		if seenReal[real] {
			continue
		}
		seenReal[real] = true
		existing = append(existing, p)
	}
	return existing, missing, resolved
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
// machine. On Linux and macOS they are identical.
func snapshotToLocalPath(p string) string { return filepath.FromSlash(p) }

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
