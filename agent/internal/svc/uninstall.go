//go:build unix

package svc

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// UninstallOptions controls Uninstall.
type UninstallOptions struct {
	Layout paths.Layout
	// Files are the binaries and links to remove, the agent binary last;
	// nil selects DefaultFiles (the installed and the pre-release locations).
	Files []string
	// Dirs are removed when they are empty afterwards; nil selects DefaultDirs.
	Dirs []string
	// KeepLogs leaves the log directory in place.
	KeepLogs bool
	// FromService is set when the running service removes itself (uninstall
	// task): files go first and the service is stopped as the very last step.
	FromService bool
	Out         io.Writer
	// SkipService leaves the service manager alone (development layouts).
	SkipService bool
	// KeepBinaries leaves the agent and restic binaries in place (development
	// layouts, where they are not the installed copies).
	KeepBinaries bool
	// Manager overrides the platform manager (tests).
	Manager Manager
}

// protectedDirs must never be removed, whatever a misconfigured layout says.
var protectedDirs = map[string]bool{
	"/": true, "/etc": true, "/var": true, "/var/lib": true, "/var/log": true, "/usr": true, "/usr/local": true,
	"/usr/local/bin": true, "/usr/local/lib": true, "/usr/bin": true, "/home": true, "/root": true, "/Users": true,
	"/Library": true, "/tmp": true, "/private": true, "/opt": true, "/Library/Application Support": true,
}

func safeToRemove(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) {
		return fmt.Errorf("refusing to remove %q", dir)
	}
	if protectedDirs[filepath.Clean(dir)] {
		return fmt.Errorf("refusing to remove the system directory %s", dir)
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
	// Restored or hook-created content may have unusual modes.
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(p, 0o700)
		}
		return nil
	})
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	fmt.Fprintf(out, "removed %s\n", dir)
	return nil
}

// DefaultFiles are the files Uninstall removes on a real installation: the
// binaries below the root-owned prefix and their license notices, those of an
// earlier pre-release installation, the convenience link (only when it is the
// link to the agent or the pre-release binary), the agent binary last.
func DefaultFiles() []string {
	files := []string{
		paths.InstalledAgentBinary() + ".prev", paths.InstalledResticBinary(), paths.InstalledNotices(),
		reloadPlistPath(paths.InstallDir()),
		paths.LegacyAgentBinary + ".prev", paths.LegacyResticBinary,
	}
	if ours(paths.CommandLink) {
		files = append(files, paths.CommandLink)
	}
	return append(files, paths.InstalledAgentBinary())
}

// DefaultDirs are the folders Uninstall removes when they are empty.
func DefaultDirs() []string {
	return []string{paths.BinDir(), paths.InstallDir(), paths.LegacyLibDir}
}

// ours reports whether path is the convenience link to the installed agent or
// the agent binary of 0.1.0 (both live at /usr/local/bin/restow-agent).
func ours(path string) bool {
	fi, err := os.Lstat(path)
	if err != nil {
		return false
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		return err == nil && strings.HasPrefix(target, paths.InstallDir()+"/")
	}
	return fi.Mode().IsRegular() && path == paths.LegacyAgentBinary
}

// Uninstall removes the agent from this machine: service, local state
// (including the stored secrets), working data and binaries. Backups already
// stored on the Restow instance are not touched; revoke the endpoint in the
// Restow UI to complete the removal there.
func Uninstall(o UninstallOptions) error {
	out := o.Out
	if out == nil {
		out = io.Discard
	}
	m := o.Manager
	if m == nil && !o.SkipService {
		var err error
		if m, err = New(); err != nil {
			fmt.Fprintf(out, "note: %v\n", err)
		}
	}
	var errs []error

	if !o.FromService && m != nil {
		if err := m.Stop(); err == nil {
			fmt.Fprintln(out, "stopped the service")
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
	}

	if !o.KeepBinaries {
		files, dirs := o.Files, o.Dirs
		if files == nil {
			files = DefaultFiles()
		}
		if dirs == nil {
			dirs = DefaultDirs()
		}
		// The agent binary is the last file; removing a running binary is fine on Unix.
		for _, f := range files {
			if f == "" {
				continue
			}
			if err := os.Remove(f); err == nil {
				fmt.Fprintf(out, "removed %s\n", f)
			} else if !os.IsNotExist(err) {
				errs = append(errs, err)
			}
		}
		// Folders only when empty (nothing of anyone else is touched).
		for _, d := range dirs {
			if d != "" && safeToRemove(d) == nil && os.Remove(d) == nil {
				fmt.Fprintf(out, "removed %s\n", d)
			}
		}
	}

	if m != nil {
		var err error
		if o.FromService {
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
	return errors.Join(errs...)
}
