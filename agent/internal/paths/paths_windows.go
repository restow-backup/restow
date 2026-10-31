//go:build windows

package paths

import (
	"os"
	"path/filepath"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// knownFolder returns a known folder of the machine (SHGetKnownFolderPath),
// not an environment variable a caller could have changed; fallback is the
// normal case, used only if Windows cannot answer.
func knownFolder(id *syscall.GUID, fallback string) string {
	if p, err := winapi.KnownFolderPath(id); err == nil && p != "" {
		return p
	}
	return fallback
}

// ProgramFilesDir is C:\Program Files (FOLDERID_ProgramFiles).
func ProgramFilesDir() string { return knownFolder(&winapi.FolderIDProgramFiles, `C:\Program Files`) }

// ProgramFilesX86Dir is C:\Program Files (x86) (FOLDERID_ProgramFilesX86).
func ProgramFilesX86Dir() string {
	return knownFolder(&winapi.FolderIDProgramFilesX86, `C:\Program Files (x86)`)
}

// ProgramDataDir is C:\ProgramData (FOLDERID_ProgramData).
func ProgramDataDir() string { return knownFolder(&winapi.FolderIDProgramData, `C:\ProgramData`) }

// WindowsDir is C:\Windows (FOLDERID_Windows).
func WindowsDir() string { return knownFolder(&winapi.FolderIDWindows, `C:\Windows`) }

func installDir() string { return filepath.Join(ProgramFilesDir(), "Restow") }

// DataRoot is C:\ProgramData\Restow, the parent of the state, data and log folders.
func DataRoot() string { return filepath.Join(ProgramDataDir(), "Restow") }

func systemLayout() Layout {
	root := DataRoot()
	return Layout{
		StateDir: filepath.Join(root, "state"),
		DataDir:  filepath.Join(root, "data"),
		LogDir:   filepath.Join(root, "logs"),
	}
}

func ensureLayout(l Layout) error {
	if DevLayout() {
		if err := os.MkdirAll(l.DataDir, 0o755); err != nil {
			return err
		}
		return os.MkdirAll(l.LogDir, 0o750)
	}
	if err := EnsureProtectedDir(filepath.Dir(l.DataDir), ProtectedSDDL); err != nil {
		return err
	}
	if err := EnsureProtectedDir(l.DataDir, DataDirSDDL); err != nil {
		return err
	}
	return EnsureProtectedDir(l.LogDir, ProtectedSDDL)
}
