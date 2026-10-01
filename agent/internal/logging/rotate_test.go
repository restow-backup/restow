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
