package update

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// swapFixture is an installed release (notices, restic, agent) and a staged
// newer one, in a temporary folder.
func swapFixture(t *testing.T) (dir string, staged []stagedFile) {
	t.Helper()
	dir = t.TempDir()
	for _, f := range []struct {
		name     string
		keepPrev bool
	}{{"NOTICES.txt", false}, {"restic", false}, {"restow-agent", true}} {
		dest := filepath.Join(dir, f.name)
		if err := os.WriteFile(dest, []byte("old "+f.name), 0o600); err != nil {
			t.Fatal(err)
		}
		st := filepath.Join(dir, "."+f.name+".new-test")
		if err := os.WriteFile(st, []byte("new "+f.name), 0o600); err != nil {
			t.Fatal(err)
		}
		staged = append(staged, stagedFile{dest: dest, staged: st, keepPrev: f.keepPrev})
	}
	return dir, staged
}

func readSwapped(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.Contains(e.Name(), ".old-") || strings.Contains(e.Name(), ".new-") {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestCommitAllReplacesEveryFileAndKeepsOnlyTheAgentsPrev(t *testing.T) {
	dir, staged := swapFixture(t)
	if err := commitAll(staged); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"NOTICES.txt", "restic", "restow-agent"} {
		if got := readSwapped(t, filepath.Join(dir, name)); got != "new "+name {
			t.Errorf("%s = %q after the update", name, got)
		}
	}
	if got := readSwapped(t, filepath.Join(dir, "restow-agent.prev")); got != "old restow-agent" {
		t.Errorf("restow-agent.prev = %q", got)
	}
	for _, name := range []string{"NOTICES.txt.prev", "restic.prev"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
			t.Errorf("%s must not exist", name)
		}
	}
	if l := leftovers(t, dir); len(l) > 0 {
		t.Errorf("files left behind: %v", l)
	}
}

func TestCommitAllPutsResticBackWhenTheAgentSwapFails(t *testing.T) {
	dir, staged := swapFixture(t)
	agent := staged[2].dest
	orig := commit
	t.Cleanup(func() { commit = orig })
	commit = func(st, dest string, keepPrev bool) (swap, error) {
		if dest == agent {
			return swap{}, errors.New("the agent's file is locked")
		}
		return orig(st, dest, keepPrev)
	}
	err := commitAll(staged)
	if err == nil || !strings.Contains(err.Error(), "the agent's file is locked") {
		t.Fatalf("commitAll = %v, want the agent's error", err)
	}
	for _, name := range []string{"NOTICES.txt", "restic", "restow-agent"} {
		if got := readSwapped(t, filepath.Join(dir, name)); got != "old "+name {
			t.Errorf("%s = %q after the failed update, want the previous content", name, got)
		}
	}
	if l := leftovers(t, dir); len(l) > 0 {
		t.Errorf("files left behind: %v", l)
	}
}

func TestCommitAllRemovesAFileThatDidNotExistBefore(t *testing.T) {
	dir, staged := swapFixture(t)
	if err := os.Remove(staged[0].dest); err != nil {
		t.Fatal(err)
	}
	agent := staged[2].dest
	orig := commit
	t.Cleanup(func() { commit = orig })
	commit = func(st, dest string, keepPrev bool) (swap, error) {
		if dest == agent {
			return swap{}, errors.New("no")
		}
		return orig(st, dest, keepPrev)
	}
	if err := commitAll(staged); err == nil {
		t.Fatal("commitAll must fail")
	}
	if _, err := os.Lstat(staged[0].dest); !os.IsNotExist(err) {
		t.Errorf("the notices that were not installed before must be gone again: %v", err)
	}
	if got := readSwapped(t, filepath.Join(dir, "restic")); got != "old restic" {
		t.Errorf("restic = %q", got)
	}
}
