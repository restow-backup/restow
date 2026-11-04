//go:build windows && windowsintegration

package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A junction and a folder a volume is mounted at, as configured sources: Go
// reports both as irregular and restic would store a bare link
// (docs/WINDOWS-AGENT.md, 16.5).
func TestJunctionSourceIsBackedUpByItsTarget(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "Daten")
	link := filepath.Join(base, "Dokumente")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v %s", err, out)
	}
	sp := splitSources([]string{link})
	want, _ := filepath.EvalSymlinks(target)
	if len(sp.existing) == 1 {
		if got, err := filepath.EvalSymlinks(sp.existing[0]); err == nil {
			sp.existing[0] = got // 8.3 names of the temp folder written out
		}
	}
	if len(sp.existing) != 1 || !strings.EqualFold(sp.existing[0], want) || len(sp.resolved) != 1 || sp.resolved[0].Kind != "junction" {
		t.Fatalf("%+v (want %s)", sp, want)
	}
}

func TestMountedVolumeSourceIsBackedUpByItsDrive(t *testing.T) {
	drive := filepath.VolumeName(os.Getenv("SystemRoot")) + `\`
	out, err := exec.Command("mountvol", drive, "/L").Output()
	if err != nil {
		t.Fatalf("mountvol %s /L: %v", drive, err)
	}
	volume := strings.TrimSpace(string(out))
	dir := filepath.Join(t.TempDir(), "Mounted")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("mountvol", dir, volume).CombinedOutput(); err != nil {
		t.Fatalf("mountvol %s %s: %v %s", dir, volume, err, out)
	}
	t.Cleanup(func() { _ = exec.Command("mountvol", dir, "/D").Run() })
	sp := splitSources([]string{dir})
	if len(sp.existing) != 1 || !strings.EqualFold(sp.existing[0], drive) || len(sp.resolved) != 1 || sp.resolved[0].Kind != "mounted volume" {
		t.Fatalf("%+v (want %s)", sp, drive)
	}
}

// planVolumes lists the folders volumes are mounted at with the calls restic
// makes (FindFirstVolumeMountPointW) and identifies their volume (K102).
func TestWinVolumesListMountedFolders(t *testing.T) {
	drive := filepath.VolumeName(os.Getenv("SystemRoot")) + `\`
	out, err := exec.Command("mountvol", drive, "/L").Output()
	if err != nil {
		t.Fatalf("mountvol %s /L: %v", drive, err)
	}
	volume := strings.TrimSpace(string(out))
	base := t.TempDir()
	dir := filepath.Join(base, "Mounted")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("mountvol", dir, volume).CombinedOutput(); err != nil {
		t.Fatalf("mountvol %s %s: %v %s", dir, volume, err, out)
	}
	t.Cleanup(func() { _ = exec.Command("mountvol", dir, "/D").Run() })
	if id, err := (winVolumes{}).VolumeName(drive); err != nil || !strings.EqualFold(id, volume) {
		t.Fatalf("VolumeName(%s) = %q, %v; want %s", drive, id, err, volume)
	}
	longBase := base
	if l, err := filepath.EvalSymlinks(base); err == nil {
		longBase = l // 8.3 names of the temp folder written out
	}
	// The folder is on the drive of the temp folder, the volume mounted there
	// is the system volume.
	root := filepath.VolumeName(longBase) + `\`
	rels, err := (winVolumes{}).MountPoints(root)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(longBase, "Mounted") + `\`
	found := false
	for _, rel := range rels {
		if strings.EqualFold(root+rel, want) {
			found = true
			if id, err := (winVolumes{}).VolumeName(root + rel); err != nil || !strings.EqualFold(id, volume) {
				t.Fatalf("VolumeName(%s) = %q, %v; want %s", root+rel, id, err, volume)
			}
		}
	}
	if !found {
		t.Fatalf("%s is not among the mounted folders of %s: %q", want, root, rels)
	}
	// The system volume (NTFS, fixed) mounted below a source stays with the
	// shadow copy.
	p := snapshotPlan{method: "vss", requested: true}
	planVolumes(&p, winVolumes{}, []string{longBase})
	if len(p.excluded) != 0 || len(p.volumes) != 1 {
		t.Fatalf("%+v", p)
	}
}
