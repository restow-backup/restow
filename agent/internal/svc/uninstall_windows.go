//go:build windows

package svc

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// systemDirs are the folders an uninstall never removes, whatever a layout says.
func systemDirs() []string {
	return []string{paths.WindowsDir(), paths.ProgramFilesDir(), paths.ProgramFilesX86Dir(), paths.ProgramDataDir(),
		filepath.Join(filepath.VolumeName(paths.WindowsDir())+`\`, "Users")}
}

func safeToRemove(dir string) error {
	if windowsProtected(dir, systemDirs()) {
		return fmt.Errorf("refusing to remove %q", dir)
	}
	return nil
}

func removeTree(out io.Writer, dir string) error {
	if err := safeToRemove(dir); err != nil {
		return err
	}
	if _, err := os.Lstat(dir); os.IsNotExist(err) {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	fmt.Fprintf(out, "removed %s\n", dir)
	return nil
}

// DefaultFiles are the files Uninstall removes on a real installation, the
// agent binary last.
func DefaultFiles() []string {
	agent := paths.InstalledAgentBinary()
	return []string{agent + ".prev", paths.InstalledResticBinary(), paths.InstalledNotices(), agent}
}

// DefaultDirs are the folders Uninstall removes when they are empty.
func DefaultDirs() []string { return []string{paths.BinDir(), paths.InstallDir()} }

// Uninstall removes the agent from this machine (docs/WINDOWS-AGENT.md,
// section 9.4): service, C:\ProgramData\Restow (state with the secrets, data,
// logs unless kept), restic.exe and the notices. The running
// restow-agent.exe cannot be deleted; it and the then empty folders are
// deleted at the next restart of Windows (MOVEFILE_DELAY_UNTIL_REBOOT). The
// installer (windows.ps1 -Uninstall) passes KeepBinaries and removes
// C:\Program Files\Restow itself after the agent ended, so nothing is left.
// Backups on the Restow instance are not touched.
func Uninstall(o UninstallOptions) error {
	out := o.Out
	if out == nil {
		out = io.Discard
	}
	m := o.Manager
	if m == nil && !o.SkipService {
		m, _ = New()
	}
	var errs []error
	if m != nil {
		var err error
		if o.FromService {
			// Deleting first is safe: the entry goes when this process ends.
			err = m.UninstallFromInside()
		} else {
			err = m.Uninstall()
		}
		if err != nil {
			errs = append(errs, err)
		} else {
			fmt.Fprintf(out, "removed the %s service\n", m.Name())
		}
	}
	for _, dir := range []string{o.Layout.StateDir, o.Layout.DataDir} {
		if err := removeTree(out, dir); err != nil {
			errs = append(errs, err)
		}
	}
	if !o.KeepLogs {
		if err := removeTree(out, o.Layout.LogDir); err != nil {
			errs = append(errs, err)
		}
		// C:\ProgramData\Restow itself, when nothing else is left in it.
		if root := filepath.Dir(o.Layout.StateDir); safeToRemove(root) == nil && os.Remove(root) == nil {
			fmt.Fprintf(out, "removed %s\n", root)
		}
	}
	if o.KeepBinaries {
		return errors.Join(errs...)
	}
	files, dirs := o.Files, o.Dirs
	if files == nil {
		files = DefaultFiles()
	}
	if dirs == nil {
		dirs = DefaultDirs()
	}
	self, _ := os.Executable()
	later := false
	for _, f := range files {
		if f == "" {
			continue
		}
		err := removeFile(f)
		switch {
		case err == nil:
			fmt.Fprintf(out, "removed %s\n", f)
		case os.IsNotExist(err):
		case strings.EqualFold(f, self) || winapi.IsErrno(err, winapi.ErrorAccessDenied):
			// The running agent (or a file still in use): delete at the next
			// restart, under a name of its own. The fixed name is free at once,
			// so an agent installed again before the restart is not deleted
			// with it.
			aside, derr := removeAtReboot(f)
			switch {
			case derr != nil && aside == "":
				errs = append(errs, fmt.Errorf("%s is in use and cannot be deleted now; delete it after the next restart of Windows: %w", f, derr))
			case derr != nil:
				errs = append(errs, derr)
			default:
				fmt.Fprintf(out, "%s is deleted at the next restart of Windows (as %s)\n", f, filepath.Base(aside))
				later = true
			}
		default:
			errs = append(errs, err)
		}
	}
	for _, d := range dirs {
		if d == "" || safeToRemove(d) != nil {
			continue
		}
		if os.Remove(d) == nil {
			fmt.Fprintf(out, "removed %s\n", d)
		} else if later {
			// Registered after the files, so Windows deletes them first; a
			// folder that is not empty then (a new installation) stays.
			_ = moveFileEx(d, "", winapi.MoveFileDelayUntilReboot)
		}
	}
	return errors.Join(errs...)
}

// Seams for the tests: what deleting at the next restart is made of.
var (
	moveFileEx = winapi.MoveFileEx
	renameFile = os.Rename
	removeFile = os.Remove
)

// removeAtReboot renames a file that cannot be deleted now to
// <name>.old-<16 hex> in the same folder (a running .exe can be renamed, not
// deleted) and has Windows delete that name at the next restart
// (MOVEFILE_DELAY_UNTIL_REBOOT). The fixed name is never registered: Windows
// would delete whatever has that name at the restart. It returns the new name.
func removeAtReboot(path string) (string, error) {
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return "", err
	}
	aside := path + ".old-" + hex.EncodeToString(rnd[:])
	if err := renameFile(path, aside); err != nil {
		return "", err
	}
	if err := moveFileEx(aside, "", winapi.MoveFileDelayUntilReboot); err != nil {
		return aside, fmt.Errorf("%s was renamed to %s but cannot be marked for deletion: %w", path, aside, err)
	}
	return aside, nil
}
