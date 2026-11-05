//go:build windows

package core

import (
	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// winVolumes asks Windows about volumes (volumeSystem).
type winVolumes struct{}

func (winVolumes) VolumePathName(p string) (string, error) { return winapi.VolumePathName(p) }
func (winVolumes) DriveType(root string) uint32            { return winapi.DriveType(root) }
func (winVolumes) FileSystem(root string) (string, error) {
	fsName, _, err := winapi.VolumeInformation(root)
	return fsName, err
}
func (winVolumes) VolumeName(mp string) (string, error) { return winapi.VolumeNameForMountPoint(mp) }

// MountPoints asks by the volume GUID path, as FindFirstVolumeMountPointW
// documents it, and by the drive root when that is not known.
func (winVolumes) MountPoints(root string) ([]string, error) {
	v := root
	if id, err := winapi.VolumeNameForMountPoint(root); err == nil && id != "" {
		v = id
	}
	return winapi.VolumeMountPoints(v)
}

// planSnapshot decides on the volume shadow copy of a backup
// (docs/WINDOWS-AGENT.md, 17.1): only with useVss, only with the rights for
// it, and without the volumes VSS certainly cannot do (removable media, FAT,
// exFAT), which restic is told to read live, also when such a volume is
// mounted in a folder below a source (planVolumes). Whatever this lets
// through, restic decides (and reports).
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
	planVolumes(&p, winVolumes{}, sources)
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
