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

// commitFile renames the staged file over dest. With keepPrev the current
// binary stays as dest.prev for a manual rollback (hard link: same file
// system, no copy; failure to keep it is not fatal). Unix replaces a running
// binary in one rename; there is nothing to roll back.
func commitFile(staged, dest string, keepPrev bool) (func(), error) {
	if keepPrev {
		prev := dest + ".prev"
		_ = os.Remove(prev)
		if st, err := os.Lstat(dest); err == nil && st.Mode().IsRegular() {
			_ = os.Link(dest, prev)
		}
	}
	if err := os.Rename(staged, dest); err != nil {
		_ = os.Remove(staged)
		return nil, err
	}
	return func() {}, nil
}
