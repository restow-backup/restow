//go:build windows && windowsintegration

package update

import (
	"os"
	"syscall"
	"testing"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// The staged binary belongs to Administrators, also when an administrator
// whose objects are owned by the account itself runs `restow-agent update`:
// the rename into place keeps the owner, and the service refuses a binary
// owned by anyone else (paths.TrustedFile).
func TestStagedFileIsOwnedByAdministrators(t *testing.T) {
	if elevated, err := winapi.TokenElevated(); err != nil || !elevated {
		t.Fatalf("this test needs an elevated administrator (the Windows runner is one): %v", err)
	}
	f, name, err := createStaged(t.TempDir(), "restow-agent.exe")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("x")
	_ = f.Close()
	h, err := winapi.OpenNoFollow(name)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	sddl, err := winapi.HandleSDDL(h)
	if err != nil {
		t.Fatal(err)
	}
	info, err := paths.ParseSDDL(sddl)
	if err != nil {
		t.Fatal(err)
	}
	if info.Owner != winapi.SIDAdministrators {
		t.Fatalf("%s is owned by %s (%s)", name, info.Owner, sddl)
	}
	if _, err := os.Stat(name); err != nil {
		t.Fatal(err)
	}
}
