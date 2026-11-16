//go:build !windows && !linux

package core

import (
	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// planSnapshot: macOS and the BSDs take no file system snapshot in this
// release (APFS comes with M6).
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

// newFSBackend: LVM and btrfs snapshots and whole-machine backups are
// Linux only (macOS follows in M6).
func newFSBackend(*Agent) fsBackend { return nil }
