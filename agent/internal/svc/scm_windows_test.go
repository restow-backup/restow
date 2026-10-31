//go:build windows && windowsintegration

package svc

import (
	"os"
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
