//go:build unix

package paths

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// UntrustedError names a file or folder the agent refuses to rely on because
// a user other than root could change it.
type UntrustedError struct {
	Path   string
	Reason string
}

func (e *UntrustedError) Error() string {
	return fmt.Sprintf("%s %s. The agent runs as root and only uses files and folders that no other user can change "+
		"(owner root, not writable by group or others); fix the ownership and permissions or re-run the install script", e.Path, e.Reason)
}

// trustedUID is root, or the user the agent runs as (a development run
// without root trusts its own files; it gains nothing from them).
func trustedUID(uid uint32) bool { return uid == 0 || int(uid) == os.Geteuid() }

func ownerOf(fi os.FileInfo) (uint32, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Uid, true
}

// TrustedFile resolves path and checks that the file and every folder above it
// are owned by root and not writable by group or others. It returns the
// resolved path, which is what the caller must open or execute.
func TrustedFile(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", &UntrustedError{Path: path, Reason: "is not an absolute path"}
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	fi, err := os.Lstat(resolved)
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", &UntrustedError{Path: resolved, Reason: "is not a regular file"}
	}
	if err := checkEntry(resolved, fi, false); err != nil {
		return "", err
	}
	if _, err := TrustedDir(filepath.Dir(resolved), false); err != nil {
		return "", err
	}
	return resolved, nil
}

// TrustedDir resolves dir and checks it and every folder above it. With
// allowSticky a world-writable folder with the sticky bit (/tmp) passes: other
// users can add entries there but cannot rename or remove root's.
func TrustedDir(dir string, allowSticky bool) (string, error) {
	if !filepath.IsAbs(dir) {
		return "", &UntrustedError{Path: dir, Reason: "is not an absolute path"}
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	current := "/"
	parts := strings.Split(strings.TrimPrefix(filepath.Clean(resolved), "/"), "/")
	for i := -1; i < len(parts); i++ {
		if i >= 0 {
			if parts[i] == "" {
				continue
			}
			current = filepath.Join(current, parts[i])
		}
		fi, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if !fi.IsDir() {
			return "", &UntrustedError{Path: current, Reason: "is not a folder"}
		}
		if err := checkEntry(current, fi, allowSticky); err != nil {
			return "", err
		}
	}
	return resolved, nil
}

func checkEntry(path string, fi os.FileInfo, allowSticky bool) error {
	uid, ok := ownerOf(fi)
	if !ok {
		return &UntrustedError{Path: path, Reason: "has an unknown owner"}
	}
	if !trustedUID(uid) {
		return &UntrustedError{Path: path, Reason: fmt.Sprintf("is owned by uid %d, not by root", uid)}
	}
	if perm := fi.Mode().Perm(); perm&0o022 != 0 {
		if allowSticky && fi.IsDir() && fi.Mode()&os.ModeSticky != 0 {
			return nil
		}
		return &UntrustedError{Path: path, Reason: fmt.Sprintf("is writable by group or others (mode %#o)", perm)}
	}
	return nil
}

// EnsureBinDir creates the install prefix and its bin folder, owned by root
// with mode 0755, and checks the whole chain. The self-update and the move
// from 0.1.0 install into it. A folder that already exists and is not trusted
// is refused, not repaired: someone else may have prepared it.
func EnsureBinDir() (string, error) {
	return EnsureRootDir(BinDir())
}

// EnsureRootDir creates dir and any missing parents as root-owned folders
// with mode 0755 below a trusted existing ancestor, then checks the chain.
func EnsureRootDir(dir string) (string, error) {
	dir = filepath.Clean(dir)
	var missing []string
	existing := dir
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		} else if !os.IsNotExist(err) {
			return "", err
		}
		missing = append(missing, existing)
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		existing = parent
	}
	if _, err := TrustedDir(existing, false); err != nil {
		return "", err
	}
	for i := len(missing) - 1; i >= 0; i-- {
		d := missing[i]
		if err := os.Mkdir(d, 0o755); err != nil && !os.IsExist(err) {
			return "", err
		}
		if os.Geteuid() == 0 {
			if err := os.Lchown(d, 0, 0); err != nil {
				return "", err
			}
		}
		if err := os.Chmod(d, 0o755); err != nil {
			return "", err
		}
	}
	return TrustedDir(dir, false)
}
