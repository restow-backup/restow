package state

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sample() *State {
	return &State{
		ServerURL:          "https://restow.example.com",
		EndpointID:         "ep_123",
		Hostname:           "web01",
		Profile:            "server",
		EnrolledAt:         time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC),
		AgentSecret:        "rsea_secret_value_123456",
		RepositoryURL:      "rest:https://restow.example.com/agent/restic/ep_123/",
		RepositoryPassword: "repo-password-abcdef",
	}
}

func TestSaveLoadRoundTripAndModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	path := filepath.Join(dir, "state.json")
	if err := sample().Save(path); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %#o, want 0600", st.Mode().Perm())
	}
	dst, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dst.Mode().Perm() != 0o700 {
		t.Fatalf("state dir mode = %#o, want 0700", dst.Mode().Perm())
	}
	got, warnings, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if got.AgentSecret != "rsea_secret_value_123456" || got.EndpointID != "ep_123" || got.SchemaVersion != SchemaVersion {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected only state.json, got %v", entries)
	}
}

func TestLoadNotEnrolled(t *testing.T) {
	_, _, err := Load(filepath.Join(t.TempDir(), "state.json"))
	if !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestLoadTightensOpenPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := sample().Save(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, warnings, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "0600") {
		t.Fatalf("warnings = %v", warnings)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode not corrected: %#o", st.Mode().Perm())
	}
}

func TestLoadRejectsCorruptAndIncomplete(t *testing.T) {
	dir := t.TempDir()
	corrupt := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(corrupt, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(corrupt); err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("corrupt: err = %v", err)
	}
	incomplete := filepath.Join(dir, "incomplete.json")
	if err := os.WriteFile(incomplete, []byte(`{"serverUrl":"https://x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(incomplete); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("incomplete: err = %v", err)
	}
}

func TestLoadRejectsNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"schemaVersion":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil || !strings.Contains(err.Error(), "newer agent") {
		t.Fatalf("err = %v", err)
	}
}

func TestSaveOverwritesAtomically(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := sample()
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	s.AgentSecret = "rsea_second_value_654321"
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	got, _, err := Load(path)
	if err != nil || got.AgentSecret != "rsea_second_value_654321" {
		t.Fatalf("got %+v err %v", got, err)
	}
}
