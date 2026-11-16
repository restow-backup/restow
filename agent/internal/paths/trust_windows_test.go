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

// A folder of the layout that a user created before the agent protected the
// folder above it is replaced when it is empty and refused when it holds
// something; agent.log loses the read access it inherited (K114).
func TestProtectedFoldersAndFilesReplaceWhatUsersPrepared(t *testing.T) {
	if elevated, err := winapi.TokenElevated(); err != nil || !elevated {
		t.Fatalf("this test needs an elevated administrator (the Windows runner is one): %v", err)
	}
	root := filepath.Join(ProgramDataDir(), "RestowProtectTest-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	// As the 0.5.0 previews left it: created with the permissions of
	// ProgramData, with a folder that belongs to Users.
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// The previews' installer ran elevated, so the folder belonged to
	// Administrators. An elevated process owns what it creates itself only
	// where the policy "Default owner for objects created by members of the
	// Administrators group" says so (the Windows runner's account, LA), and the
	// agent rightly refuses such a folder; set the owner the previews left.
	if out, err := exec.Command("icacls", root, "/setowner", "*S-1-5-32-544").CombinedOutput(); err != nil {
		t.Fatalf("icacls /setowner: %v %s", err, out)
	}
	empty, full := filepath.Join(root, "state"), filepath.Join(root, "data")
	for _, d := range []string{empty, full} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(full, "x"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{empty, full} {
		if out, err := exec.Command("icacls", d, "/setowner", "*S-1-5-32-545").CombinedOutput(); err != nil {
			t.Fatalf("icacls /setowner: %v %s", err, out)
		}
	}
	if err := EnsureProtectedDir(root, ProtectedSDDL); err != nil {
		t.Fatal(err)
	}
	if err := EnsureProtectedDir(empty, ProtectedSDDL); err != nil {
		t.Fatalf("an empty folder of Users was not replaced: %v", err)
	}
	if owner, sddl := securityOf(t, empty); owner != winapi.SIDAdministrators || !strings.Contains(sddl, "D:P") || strings.Contains(sddl, ";BU)") {
		t.Fatalf("replaced folder: %s %s", owner, sddl)
	}
	err := EnsureProtectedDir(full, ProtectedSDDL)
	if err == nil || !strings.Contains(err.Error(), "someone else may have prepared it") {
		t.Fatalf("a folder of Users with files was accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(full, "x")); err != nil {
		t.Fatal("the folder of Users was changed")
	}

	logs := filepath.Join(root, "logs")
	if err := os.Mkdir(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(logs, "agent.log")
	if err := os.WriteFile(log, []byte("line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// What agent.log inherited from ProgramData: Users may read it.
	if out, err := exec.Command("icacls", log, "/grant", "*S-1-5-32-545:R").CombinedOutput(); err != nil {
		t.Fatalf("icacls /grant: %v %s", err, out)
	}
	if _, sddl := securityOf(t, log); !strings.Contains(sddl, ";BU)") {
		t.Fatalf("Users have no access before ProtectFile: %s", sddl)
	}
	if err := ProtectFile(log); err != nil {
		t.Fatal(err)
	}
	if _, sddl := securityOf(t, log); !strings.Contains(sddl, "D:P") || strings.Contains(sddl, ";BU)") || strings.Contains(sddl, "ID;") {
		t.Fatalf("agent.log after ProtectFile: %s", sddl)
	}
}
