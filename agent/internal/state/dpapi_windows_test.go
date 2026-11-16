//go:build windows && windowsintegration

package state

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDPAPIRoundTrip(t *testing.T) {
	t.Setenv("RESTOW_AGENT_DIR", t.TempDir())
	path := filepath.Join(os.Getenv("RESTOW_AGENT_DIR"), "state", "state.json")
	s := sampleState()
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, []byte(s.AgentSecret)) || !bytes.Contains(raw, []byte(`"dpapi-machine"`)) {
		t.Fatalf("secrets not protected: %s", raw)
	}
	got, _, err := Load(path)
	if err != nil || got.AgentSecret != s.AgentSecret || got.RepositoryPassword != s.RepositoryPassword {
		t.Fatalf("%+v %v", got, err)
	}
	// A changed blob is refused.
	tampered := bytes.Replace(raw, []byte(`"blob": "A`), []byte(`"blob": "B`), 1)
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil {
		t.Fatal("a changed DPAPI blob was accepted")
	}
	// Secrets in clear text are refused.
	clear, _ := encode(s, nil)
	if err := os.WriteFile(path, clear, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil || !strings.Contains(err.Error(), "clear text") {
		t.Fatalf("clear text: %v", err)
	}
}
