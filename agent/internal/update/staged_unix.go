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
