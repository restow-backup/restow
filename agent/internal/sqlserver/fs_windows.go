//go:build windows

package sqlserver

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/atomicfile"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// winFS is the file system of a Windows machine with real DACLs.
type winFS struct{}

// NewFS returns the file system of this machine.
func NewFS() (FS, error) { return winFS{}, nil }

// existingAncestor is path or the nearest parent that exists.
func existingAncestor(path string) string {
	p := filepath.Clean(path)
	for {
		if _, err := os.Lstat(p); err == nil {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			return p
		}
		p = parent
	}
}

func (winFS) FreeBytes(path string) (uint64, error) {
	return winapi.DiskFreeBytes(existingAncestor(path))
}

func (winFS) MkdirWithSIDs(dir string, modify []string) error {
	sddl, err := ModifySDDL(modify)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return err
	}
	if err := winapi.CreateDirectorySDDL(dir, sddl); err != nil {
		if !winapi.IsErrno(err, winapi.ErrorAlreadyExists) {
			return err
		}
		st, serr := os.Lstat(dir)
		if serr != nil {
			return serr
		}
		if !st.IsDir() || isReparse(st) {
			return errors.New(dir + " exists and is not a plain folder")
		}
		// A folder someone else created stays theirs (an owner keeps
		// WRITE_DAC whatever the DACL says): it is refused, not re-permitted.
		if _, err := paths.OwnerTrusted(dir); err != nil {
			return err
		}
		return winapi.SetFileDACL(dir, sddl)
	}
	return nil
}

// PrepareStagingRoot makes a job's own staging folder the agent's: its
// parent must exist and pass the trust check of a restore target's parent;
// a new folder is created owned by the Administrators with the protected
// DACL and the marker file; an existing one is accepted only when its owner
// and DACL are trusted and it is empty (it gets the marker) or carries the
// marker already.
func (winFS) PrepareStagingRoot(root string) (string, error) {
	sddl, err := ModifySDDL(nil)
	if err != nil {
		return "", err
	}
	root = filepath.Clean(root)
	parent := filepath.Dir(root)
	resolvedParent, err := paths.TrustedDir(parent, true)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("its parent folder %s does not exist", parent)
		}
		return "", err
	}
	final := filepath.Join(resolvedParent, filepath.Base(root))
	err = winapi.CreateDirectorySDDL(final, paths.OwnerAdministrators+sddl)
	switch {
	case err == nil:
		return final, writeMarker(final)
	case !winapi.IsErrno(err, winapi.ErrorAlreadyExists):
		return "", err
	}
	resolved, err := paths.CheckTarget(final, paths.RuleStrict, paths.RuleRestoreParent)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(filepath.Join(resolved, StagingMarker)); err == nil {
		return resolved, nil
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return "", err
	}
	if len(entries) > 0 {
		return "", fmt.Errorf("%s exists, holds other files and was not created by the agent", resolved)
	}
	return resolved, writeMarker(resolved)
}

func writeMarker(dir string) error {
	f, err := paths.CreateTrusted(filepath.Join(dir, StagingMarker))
	if err != nil {
		return err
	}
	_, err = f.WriteString(StagingMarkerText)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// SetReadSIDs sets the DACL on the folder and on everything already in it
// (SetFileSecurityW does not hand a new DACL down to existing children).
func (winFS) SetReadSIDs(dir string, read []string) error {
	dirSDDL, err := ReadSDDL(read)
	if err != nil {
		return err
	}
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if isReparse(info) {
			return errors.New(p + " is a link; a fetched backup holds none")
		}
		return winapi.SetFileDACL(p, dirSDDL)
	})
}

func (winFS) RemoveAll(path string) error { return os.RemoveAll(path) }

func (winFS) SHA256File(ctx context.Context, path string) (string, int64, error) {
	return hashFile(ctx, path)
}

func (winFS) ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }

func (winFS) WriteFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return atomicfile.Rename(tmp, path)
}

func (winFS) Volume(path string) (VolumeFacts, error) {
	var v VolumeFacts
	at := existingAncestor(path)
	root, err := winapi.VolumePathName(at)
	if err != nil {
		return v, err
	}
	v.Root = root
	v.Fixed = winapi.DriveType(root) == winapi.DriveFixed
	if _, total, err := winapi.DiskSpace(root); err == nil {
		v.TotalBytes = total
	}
	if name, _, err := winapi.VolumeInformation(root); err == nil {
		v.FileSystem = name
	}
	// Every existing part of the path below the volume root.
	rel := strings.TrimPrefix(strings.ToLower(filepath.Clean(at)), strings.ToLower(filepath.Clean(root)))
	cur := filepath.Clean(root)
	for _, part := range strings.Split(strings.Trim(rel, `\`), `\`) {
		if part == "" {
			continue
		}
		cur = filepath.Join(cur, part)
		st, err := os.Lstat(cur)
		if err != nil {
			break
		}
		if isReparse(st) {
			v.ReparseAt = cur
			break
		}
	}
	return v, nil
}

func isReparse(st fs.FileInfo) bool {
	if a, ok := st.Sys().(*syscall.Win32FileAttributeData); ok {
		return a.FileAttributes&winapi.FileAttributeReparsePoint != 0
	}
	return st.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0
}
