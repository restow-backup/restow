//go:build !windows

package core

import (
	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// planSnapshot: Linux and macOS take no file system snapshot of an ordinary
// backup in this release (LVM, btrfs and APFS come with "whole machine").
func planSnapshot(cfg *api.Config, _ []string) snapshotPlan {
	var p snapshotPlan
	if cfg.UseVSS {
		p.notes = append(p.notes, "Volume Shadow Copy (useVss) is a Windows feature and has no effect on this system.")
	}
	return p
}

// platformBackupOptions adds what the system needs to every backup: nothing
// outside Windows.
func platformBackupOptions(*restic.BackupOptions, paths.Layout) {}
