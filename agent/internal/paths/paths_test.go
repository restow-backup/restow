package paths

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultLayoutIsFixedPerSpecification(t *testing.T) {
	t.Setenv(EnvAgentDir, "")
	l := Default()
	if l.StateDir != "/etc/restow-agent" || l.StateFile() != "/etc/restow-agent/state.json" {
		t.Fatalf("state location: %+v", l)
	}
	if l.StatusFile() != "/var/lib/restow-agent/status.json" || l.LogFile() != "/var/log/restow-agent/agent.log" {
		t.Fatalf("data/log location: %+v", l)
	}
}

func TestDevelopmentOverrideRelocatesEverything(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvAgentDir, dir)
	l := Default()
	for _, p := range []string{l.StateDir, l.DataDir, l.LogDir, l.CacheDir(), l.TmpDir(), l.OutboxDir(), l.LockFile()} {
		if !strings.HasPrefix(p, dir) {
			t.Errorf("%s is outside the override directory", p)
		}
	}
}

func TestEnsureModes(t *testing.T) {
	l := Layout{DataDir: filepath.Join(t.TempDir(), "data"), LogDir: filepath.Join(t.TempDir(), "log")}
	if err := l.Ensure(); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(l.DataDir); st.Mode().Perm() != 0o755 {
		t.Fatalf("data dir must be world-traversable for `status`: %v", st.Mode())
	}
	if st, _ := os.Stat(l.LogDir); st.Mode().Perm() != 0o750 {
		t.Fatalf("log dir: %v", st.Mode())
	}
}

func TestResticBinaryLookup(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "restic")
	t.Setenv(EnvResticPath, bin)
	if got, err := ResticBinary(); err != nil || got != bin {
		t.Fatalf("override: %q %v", got, err)
	}
	t.Setenv(EnvResticPath, "")
	if _, err := os.Stat(InstalledResticBinary()); err == nil {
		t.Skip("restic is installed on this machine")
	}
	// A restic next to the agent binary is never used (0.1.0 did that).
	if _, err := ResticBinary(); err == nil || !strings.Contains(err.Error(), "install script") {
		t.Fatalf("a missing restic must say how to repair: %v", err)
	}
}

func TestInstallLocationsAreRootOwnedPrefixes(t *testing.T) {
	if InstallDirFor("linux") != "/opt/restow-agent" || InstallDirFor("darwin") != "/Library/Application Support/Restow" {
		t.Fatalf("install prefixes: %q %q", InstallDirFor("linux"), InstallDirFor("darwin"))
	}
	if filepath.Dir(InstalledAgentBinary()) != filepath.Dir(InstalledResticBinary()) || filepath.Dir(InstalledAgentBinary()) != BinDir() {
		t.Fatal("agent and restic belong in the same bin folder below the prefix")
	}
	// The license notices sit in the prefix, next to the bin folder (the install scripts agree).
	if InstalledNotices() != filepath.Join(InstallDir(), "THIRD_PARTY_NOTICES.txt") || filepath.Dir(InstalledNotices()) != filepath.Dir(BinDir()) {
		t.Fatalf("notices: %s", InstalledNotices())
	}
	for _, p := range []string{InstalledAgentBinary(), InstalledResticBinary()} {
		if strings.HasPrefix(p, "/usr/local") {
			t.Fatalf("%s must not be below /usr/local (user-owned on Intel Macs with Homebrew)", p)
		}
	}
	if LegacyAgentBinary != "/usr/local/bin/restow-agent" || LegacyResticBinary != "/usr/local/lib/restow-agent/restic" {
		t.Fatal("the pre-release locations are needed for the move")
	}
	t.Setenv(EnvAgentDir, "")
	if l := Default(); l.HooksDir() != "/etc/restow-agent/hooks.d" {
		t.Fatalf("hooks dir: %s", l.HooksDir())
	}
}
