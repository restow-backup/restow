package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "agent.log")
	r, err := NewRotatingFile(path, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	line := strings.Repeat("a", 40) + "\n"
	for i := 0; i < 10; i++ {
		if _, err := r.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"agent.log", "agent.log.1", "agent.log.2"} {
		if _, err := os.Stat(filepath.Join(dir, "sub", name)); err != nil {
			t.Errorf("expected %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "sub", "agent.log.3")); err == nil {
		t.Error("agent.log.3 must not exist (Keep = 2)")
	}
	st, _ := os.Stat(path)
	if st.Size() > 100 {
		t.Errorf("active file too large: %d", st.Size())
	}
}

// The log file is protected every time it is opened, and rotated copies from
// before are protected at the start (K114: on Windows a DACL for SYSTEM and
// Administrators replaces what agent.log inherited from ProgramData).
func TestRotationProtectsTheFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.log")
	if err := os.WriteFile(path+".1", []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var protected []string
	r, err := newRotatingFile(path, 100, 2, func(p string) error {
		protected = append(protected, filepath.Base(p))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if strings.Join(protected, ",") != "agent.log.1,agent.log" {
		t.Fatalf("protected at the start: %v", protected)
	}
	for i := 0; i < 5; i++ {
		if _, err := r.Write([]byte(strings.Repeat("a", 40) + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	if n := strings.Count(strings.Join(protected, ","), "agent.log,"); n < 1 || protected[len(protected)-1] != "agent.log" {
		t.Fatalf("the new file after a rotation was not protected: %v", protected)
	}
	// A file that cannot be protected is not written to.
	if _, err := newRotatingFile(filepath.Join(dir, "other.log"), 100, 2, func(string) error { return os.ErrPermission }); err == nil {
		t.Fatal("an unprotected log file was opened")
	}
}
