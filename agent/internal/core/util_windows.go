//go:build windows

package core

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/restow-backup/restow/agent/internal/eventlog"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// defaultRestoreDir is %SystemDrive%\Restow-Restore-<yyyyMMdd-HHmmss>
// (docs/WINDOWS-AGENT.md, section 18.2; decided by the maintainer). Unlike
// Unix it does not use the first backed-up folder, which on Windows would be
// C:\Users\Restow-Restore-..., a name that looks like a user profile.
func defaultRestoreDir(_ []string, now time.Time) string {
	drive := filepath.VolumeName(paths.WindowsDir())
	if drive == "" {
		drive = "C:"
	}
	return drive + `\Restow-Restore-` + now.Format("20060102-150405")
}

// prepareRestoreTarget applies the Windows target rules (docs/WINDOWS-AGENT.md,
// section 18.1) and creates the target folder with a DACL for SYSTEM and
// Administrators only. It returns the target below the resolved parent,
// which is where restic writes (with --overwrite never, as on Unix).
func prepareRestoreTarget(target string) (string, error) {
	drive, parts, err := windowsTargetForm(target)
	if err != nil {
		return "", err
	}
	root := drive + `\`
	if winapi.DriveType(root) != winapi.DriveFixed {
		return "", targetFail("target_unusable", "the restore target %q is not on a local fixed disk (network drives and removable media are refused)", target)
	}
	if _, flags, err := winapi.VolumeInformation(root); err != nil || flags&winapi.FilePersistentACLs == 0 {
		return "", targetFail("target_unusable", "the drive of %q keeps no permissions (FAT or exFAT); restored files would lose theirs, choose an NTFS or ReFS drive", target)
	}
	parent := paths.JoinDrivePath(drive, parts[:len(parts)-1]...)
	resolvedParent, err := paths.TrustedDir(parent, true)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", targetFail("target_unusable", "the folder %s does not exist; restore into an existing folder or leave the target empty", parent)
		}
		return "", targetFail("target_unusable", "the restore target %q is refused: %v", target, err)
	}
	final := filepath.Join(resolvedParent, parts[len(parts)-1])
	blocked := []string{paths.WindowsDir(), paths.ProgramFilesDir(), paths.ProgramFilesX86Dir(), paths.DataRoot()}
	if windowsTargetBlocked(final, blocked) {
		return "", targetFail("target_unusable", "the restore target %q lies in a system folder (Windows, Program Files, the agent's own data); choose another folder", target)
	}
	err = winapi.CreateDirectorySDDL(final, paths.ProtectedSDDL)
	switch {
	case err == nil:
		eventlog.Info(eventlog.IDRestoreTarget, "The Restow agent restores files to "+final+".")
		return final, nil
	case !winapi.IsErrno(err, winapi.ErrorAlreadyExists):
		return "", targetFail("target_unusable", "cannot create the restore folder %s: %v", final, err)
	}
	// It exists: only an empty folder that only trusted principals can change.
	st, err := os.Lstat(final)
	if err != nil {
		return "", targetFail("target_unusable", "cannot inspect the restore target %q: %v", target, err)
	}
	if !st.IsDir() {
		return "", targetFail("target_not_empty", "the restore target %q exists and is not a folder; Restow never overwrites existing files", target)
	}
	entries, err := os.ReadDir(final)
	if err != nil {
		return "", targetFail("target_unusable", "cannot read the restore target %q: %v", target, err)
	}
	if len(entries) > 0 {
		return "", targetFail("target_not_empty", "the restore target %q already contains files; Restow never overwrites existing files, pick a new folder", target)
	}
	resolved, err := paths.CheckTarget(final, paths.RuleStrict, paths.RuleRestoreParent)
	if err != nil {
		return "", targetFail("target_unusable", "the empty restore target %q is refused: %v", target, err)
	}
	eventlog.Info(eventlog.IDRestoreTarget, "The Restow agent restores files to "+resolved+".")
	return resolved, nil
}
