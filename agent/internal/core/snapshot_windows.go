//go:build windows

package core

import (
	"fmt"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// planSnapshot decides on the volume shadow copy of a backup
// (docs/WINDOWS-AGENT.md, 17.1): only with useVss, only with the rights for
// it, and without the volumes VSS certainly cannot do (removable media, FAT,
// exFAT), which restic is told to read live. Whatever this lets through,
// restic decides (and reports).
func planSnapshot(cfg *api.Config, sources []string) snapshotPlan {
	p := snapshotPlan{method: api.SnapshotMethodVSS}
	if !cfg.UseVSS {
		p.notes = append(p.notes, "Volume Shadow Copy is switched off for this machine (Restow UI, machine settings): files are read from the live file system.")
		return p
	}
	if elevated, err := winapi.TokenElevated(); err != nil || !elevated {
		p.unavailable = "the agent runs without administrator rights (it must run as the RestowAgent service or in an elevated console)"
		return p
	}
	p.requested = true
	seen := map[string]bool{}
	for _, s := range sources {
		vol, err := winapi.VolumePathName(s)
		if err != nil || vol == "" {
			continue
		}
		vol = restic.NormalizeVolume(vol)
		key := strings.ToUpper(vol)
		if seen[key] {
			continue
		}
		seen[key] = true
		fsName, _, ferr := winapi.VolumeInformation(vol)
		if ferr != nil {
			fsName = ""
		}
		if reason := vssExcludeReason(winapi.DriveType(vol), fsName); reason != "" {
			p.excluded = append(p.excluded, vol)
			p.notes = append(p.notes, fmt.Sprintf("%s is read without a shadow copy: %s.", vol, reason))
			continue
		}
		p.volumes = append(p.volumes, vol)
	}
	return p
}

// platformBackupOptions adds the Windows parts of every backup
// (docs/WINDOWS-AGENT.md, 16.2): exclusion patterns without case, online-only
// cloud files left out, the agent's whole data folder and the files Windows
// keeps for itself excluded.
func platformBackupOptions(o *restic.BackupOptions, _ paths.Layout) {
	o.CaseInsensitive = true
	o.ExcludeCloudFiles = true
	o.Excludes = append(o.Excludes, paths.DataRoot())
	o.Excludes = append(o.Excludes, windowsFixedExcludes...)
}
