//go:build windows && windowsintegration

package svc

import (
	"os"
	"os/exec"
	"testing"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// The service is created with the configuration of the agent, read back and
// deleted again; it is never started (the test binary is no service).
func TestServiceConfigurationRoundTrip(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m := NewNamed("RestowAgentTest").(*scm)
	defer func() { _ = m.Uninstall() }()
	if err := m.Install(exe); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(); st.State != Stopped {
		t.Fatalf("state %v", st.State)
	}
	mgr, h, err := m.open(winapi.ServiceQueryConfig)
	if err != nil {
		t.Fatal(err)
	}
	have, err := readConfig(h)
	closeBoth(mgr, h)
	if err != nil {
		t.Fatal(err)
	}
	if d := windowsConfigDiffers(have, wantedWindowsConfig(exe)); d != "" {
		t.Fatalf("the installed service differs in %s: %+v", d, have)
	}
	if changed, err := m.Refresh(exe); err != nil || changed {
		t.Fatalf("refresh of an up-to-date service: %v %v", changed, err)
	}
	// A dependency someone added is removed again, and only once.
	if out, err := exec.Command("sc.exe", "config", "RestowAgentTest", "depend=", "LanmanWorkstation").CombinedOutput(); err != nil {
		t.Fatalf("sc.exe config: %v %s", err, out)
	}
	if changed, err := m.Refresh(exe); err != nil || !changed {
		t.Fatalf("refresh of a service with a dependency: %v %v", changed, err)
	}
	if changed, err := m.Refresh(exe); err != nil || changed {
		t.Fatalf("second refresh after the repair: %v %v", changed, err)
	}
	if prog, err := m.Program(); err != nil || prog != exe {
		t.Fatalf("program %q %v", prog, err)
	}
	if err := m.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(); st.State != NotInstalled {
		t.Fatalf("after uninstall: %v", st.State)
	}
}
