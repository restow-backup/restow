//go:build unix

package update

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// createStaged creates a new file with a random name next to dest. O_EXCL and
// O_NOFOLLOW make sure it is a fresh file and not something prepared in its
// place; the folder itself is root-owned (checked by the caller).
func createStaged(dir, base string) (*os.File, string, error) {
	for i := 0; i < 10; i++ {
		var rnd [8]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			return nil, "", err
		}
		name := filepath.Join(dir, "."+base+".new-"+hex.EncodeToString(rnd[:]))
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
		if err == nil {
			return f, name, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("cannot find a free name for the staged file")
}

// commitFile renames the staged file over dest. The current content stays
// reachable through a hard link (same file system, no copy): dest.prev for
// the agent, kept for a manual rollback, and dest.old-<hex> for the other
// files, which undo renames back over dest and done deletes. Unix replaces a
// running binary in one rename. Failing to make the link is not fatal; the
// file then cannot be put back.
func commitFile(staged, dest string, keepPrev bool) (swap, error) {
	existed := false
	old := ""
	if st, err := os.Lstat(dest); err == nil {
		existed = true
		if st.Mode().IsRegular() {
			old = dest + ".old-" + randomSuffix()
			if keepPrev {
				old = dest + ".prev"
				_ = os.Remove(old)
			}
			if os.Link(dest, old) != nil {
				old = ""
			}
		}
	}
	if err := os.Rename(staged, dest); err != nil {
		_ = os.Remove(staged)
		if old != "" && !keepPrev {
			_ = os.Remove(old)
		}
		return swap{}, err
	}
	sw := swap{undo: func() {}, done: func() {}}
	switch {
	case !existed:
		sw.undo = func() { _ = os.Remove(dest) }
	case old != "" && keepPrev:
		sw.undo = func() {
			// .prev stays: link it again after the rename takes it.
			back := dest + ".old-" + randomSuffix()
			if os.Link(old, back) == nil {
				if os.Rename(back, dest) != nil {
					_ = os.Remove(back)
				}
			}
		}
	case old != "":
		sw.undo = func() { _ = os.Rename(old, dest) }
		sw.done = func() { _ = os.Remove(old) }
	}
	return sw, nil
}
