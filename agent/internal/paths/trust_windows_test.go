//go:build windows && windowsintegration

package paths

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestTrustOnTheRealSystem(t *testing.T) {
	win := WindowsDir()
	if _, err := TrustedFile(filepath.Join(win, "System32", "cmd.exe")); err != nil {
		t.Fatalf("cmd.exe: %v", err)
	}
	if _, err := TrustedDir(ProgramFilesDir(), false); err == nil {
		t.Log("Program Files passes the strict rules with C:\\ as its parent (unexpected on a standard installation)")
	}
	if _, err := TrustedDir(filepath.Join(win, "Temp"), false); err == nil {
		t.Fatal("C:\\Windows\\Temp must not be trusted as an object (users create files there)")
	}
	if _, err := TrustedDir(filepath.VolumeName(win)+`\`, true); err != nil {
		t.Fatalf("the system drive root as the parent of a restore target: %v", err)
	}
}

func TestJunctionIsNeverTrusted(t *testing.T) {
	t.Setenv(EnvAgentDir, t.TempDir()) // trust the test user's own folders
	base := t.TempDir()
	target := filepath.Join(base, "target")
	link := filepath.Join(base, "link")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("mklink /J: %v %s", err, out)
	}
	if _, err := TrustedDir(link, false); err == nil {
		t.Fatal("a junction was trusted")
	}
}
