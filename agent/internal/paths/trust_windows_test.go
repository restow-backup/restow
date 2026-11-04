//go:build windows && windowsintegration

package paths

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/winapi"
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

// securityOf returns the owner (a SID) and the SDDL of a file or folder.
func securityOf(t *testing.T, p string) (string, string) {
	t.Helper()
	h, err := winapi.OpenNoFollow(p)
	if err != nil {
		t.Fatalf("open %s: %v", p, err)
	}
	defer syscall.CloseHandle(h)
	sddl, err := winapi.HandleSDDL(h)
	if err != nil {
		t.Fatal(err)
	}
	info, err := ParseSDDL(sddl)
	if err != nil {
		t.Fatal(err)
	}
	return info.Owner, sddl
}

// Everything the agent creates in Program Files belongs to Administrators,
// whoever creates it: on hosts where an administrator owns what it creates
// (the GitHub runner is one) the trust check would refuse the agent's own
// folders otherwise. The permissions stay inherited.
func TestCreatedFoldersAndFilesAreOwnedByAdministrators(t *testing.T) {
	if elevated, err := winapi.TokenElevated(); err != nil || !elevated {
		t.Fatalf("this test needs an elevated administrator (the Windows runner is one): %v", err)
	}
	root := filepath.Join(ProgramFilesDir(), "RestowOwnerTest-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	bin := filepath.Join(root, "bin")
	if _, err := EnsureRootDir(bin); err != nil {
		t.Fatalf("EnsureRootDir: %v", err)
	}
	hooksDir := filepath.Join(root, "hooks.d")
	if err := MkdirTrusted(hooksDir, 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := CreateTrusted(filepath.Join(bin, ".restow-agent.new-test.exe"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("x")
	_ = f.Close()
	for _, p := range []string{root, bin, hooksDir, filepath.Join(bin, ".restow-agent.new-test.exe")} {
		owner, sddl := securityOf(t, p)
		if owner != winapi.SIDAdministrators {
			t.Errorf("%s is owned by %s, not by Administrators (%s)", p, owner, sddl)
		}
		if strings.Contains(sddl, "D:P") || !strings.Contains(sddl, "ID;") {
			t.Errorf("%s does not inherit its permissions: %s", p, sddl)
		}
	}
	if _, err := TrustedFile(filepath.Join(bin, ".restow-agent.new-test.exe")); err != nil {
		t.Errorf("the created file is not trusted: %v", err)
	}
}
