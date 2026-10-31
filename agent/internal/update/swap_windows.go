//go:build windows

package update

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/atomicfile"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// createStaged creates a new file with a random name next to dest:
// .restow-agent.new-<16 hex>.exe, so `version` can run it. O_EXCL is
// CREATE_NEW; there is no O_NOFOLLOW on Windows, the trust check of the bin
// folder (nobody else can create anything there) takes its place.
func createStaged(dir, base string) (*os.File, string, error) {
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 0; i < 10; i++ {
		var rnd [8]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			return nil, "", err
		}
		name := filepath.Join(dir, "."+stem+".new-"+hex.EncodeToString(rnd[:])+ext)
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return f, name, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("cannot find a free name for the staged file")
}

// moveRetry renames with the retry of package atomicfile (Defender keeps a
// freshly written .exe open for a moment). Without MOVEFILE_REPLACE_EXISTING
// semantics problems the caller handles that dest is free.
func moveRetry(from, to string) error { return atomicfile.Rename(from, to) }

// commitFile puts staged at dest. A running .exe cannot be overwritten or
// deleted, but renamed: the current file moves aside first (to dest.prev for
// the agent, kept for a manual rollback; to dest.old-<hex> for restic and the
// notices), then the staged file moves into place. undo moves the new file
// out and the previous one back; done deletes dest.old-<hex> (at the next
// reboot when restic still runs).
func commitFile(staged, dest string, keepPrev bool) (swap, error) {
	if _, err := os.Lstat(dest); os.IsNotExist(err) {
		if err := moveRetry(staged, dest); err != nil {
			_ = os.Remove(staged)
			return swap{}, err
		}
		return swap{undo: func() { removeOrLater(dest) }, done: func() {}}, nil
	}
	aside := dest + ".old-" + randomSuffix()
	if keepPrev {
		aside = dest + ".prev"
		if err := os.Remove(aside); err != nil && !os.IsNotExist(err) {
			// The previous binary is still running (an update right after an
			// update): move it out of the way and delete it at the next reboot.
			stale := dest + ".old-" + randomSuffix()
			if err := moveRetry(aside, stale); err == nil {
				_ = winapi.MoveFileEx(stale, "", winapi.MoveFileDelayUntilReboot)
			}
		}
	}
	if err := moveRetry(dest, aside); err != nil {
		_ = os.Remove(staged)
		return swap{}, err
	}
	if err := moveRetry(staged, dest); err != nil {
		_ = moveRetry(aside, dest)
		_ = os.Remove(staged)
		return swap{}, err
	}
	sw := swap{
		undo: func() {
			out := dest + ".old-" + randomSuffix()
			if moveRetry(dest, out) == nil {
				_ = moveRetry(aside, dest)
				removeOrLater(out)
			}
		},
		done: func() {},
	}
	if !keepPrev {
		sw.done = func() { removeOrLater(aside) }
	}
	return sw, nil
}

// removeOrLater deletes path, or marks it for deletion at the next reboot
// when a running process still holds it.
func removeOrLater(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		_ = winapi.MoveFileEx(path, "", winapi.MoveFileDelayUntilReboot)
	}
}
