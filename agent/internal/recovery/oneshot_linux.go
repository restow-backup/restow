//go:build linux

package recovery

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
)

// ReadOneshotFile reads the session data the ISO's init-bottom script put
// into /run (docs/BAREMETAL-ONESHOT.md 9.1): a regular file, not a link,
// owned by root, mode 0600, in a folder of root's with mode 0700.
func ReadOneshotFile(path string) ([]byte, error) {
	dir := path[:strings.LastIndexByte(path, '/')]
	if err := checkOwned(dir, true, 0o700); err != nil {
		return nil, err
	}
	if err := checkOwned(path, false, 0o600); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxOneshotBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxOneshotBytes {
		return nil, errors.New("oneshot data: too large")
	}
	return b, nil
}

func checkOwned(p string, dir bool, perm os.FileMode) error {
	fi, err := os.Lstat(p)
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	switch {
	case dir && !fi.IsDir(), !dir && !fi.Mode().IsRegular():
		return fmt.Errorf("%s is not a plain %s", p, map[bool]string{true: "folder", false: "file"}[dir])
	case !ok || st.Uid != 0:
		return fmt.Errorf("%s is not owned by root", p)
	case fi.Mode().Perm() != perm:
		return fmt.Errorf("%s has mode %o, not %o", p, fi.Mode().Perm(), perm)
	}
	return nil
}

// openMirrors opens the consoles of the session data other than the one
// recover talks on, for writing: the console of a provider is the screen
// for one and the serial port for another (docs/BAREMETAL-ONESHOT.md 9.3).
func openMirrors(primary string, consoles []string) []*os.File {
	var out []*os.File
	seen := map[string]bool{primary: true}
	for _, c := range consoles {
		dev, _, _ := strings.Cut(c, ",")
		p := "/dev/" + dev
		if dev == "tty0" {
			p = "/dev/tty1"
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		f, err := os.OpenFile(p, os.O_WRONLY|syscall.O_NOCTTY|syscall.O_NONBLOCK, 0)
		if err == nil {
			out = append(out, f)
		}
	}
	return out
}
