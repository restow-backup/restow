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
