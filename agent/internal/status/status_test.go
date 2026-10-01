package status

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStoreRoundTripAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "status.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	when := time.Date(2026, 9, 30, 22, 0, 0, 0, time.UTC)
	err = s.Update(func(st *Status) {
		st.EndpointID = "ep-1"
		st.LastAttemptAt = when
		st.ConsecutiveFailures = 2
		st.Current = &RunInfo{Kind: "backup", RunID: "r1", StartedAt: when}
		st.LastBackup = &RunSummary{Kind: "backup", Status: "failed", Message: "boom"}
	})
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o644 {
		t.Fatalf("stat: %v mode %v", err, fi.Mode())
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.EndpointID != "ep-1" || !loaded.LastAttemptAt.Equal(when) || loaded.ConsecutiveFailures != 2 ||
		loaded.Current == nil || loaded.Current.RunID != "r1" || loaded.LastBackup.Message != "boom" || loaded.UpdatedAt.IsZero() {
		t.Fatalf("round trip: %+v", loaded)
	}
}

func TestLoadMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	st, err := Load(filepath.Join(dir, "none.json"))
	if err != nil || st == nil {
		t.Fatalf("missing file must give an empty status: %v", err)
	}
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte("{broken"), 0o644)
	st, err = Load(bad)
	if err == nil || st == nil || st.EndpointID != "" {
		t.Fatalf("corrupt file: %v %+v", err, st)
	}
	s, err := Open(bad)
	if err == nil {
		t.Fatal("corrupt status must be reported")
	}
	if uerr := s.Update(func(st *Status) { st.EndpointID = "x" }); uerr != nil {
		t.Fatalf("store must be usable after a corrupt file: %v", uerr)
	}
}

func TestSnapshotIsACopy(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	_ = s.Update(func(st *Status) { st.Current = &RunInfo{Kind: "backup"}; st.ProcessedTasks = []string{"a"} })
	snap := s.Snapshot()
	snap.Current.Kind = "changed"
	snap.ProcessedTasks[0] = "changed"
	again := s.Snapshot()
	if again.Current.Kind != "backup" || again.ProcessedTasks[0] != "a" {
		t.Fatal("Snapshot must not alias internal state")
	}
}

func TestRememberTask(t *testing.T) {
	st := &Status{}
	if !RememberTask(st, "t1") || RememberTask(st, "t1") {
		t.Fatal("duplicate detection")
	}
	for i := 0; i < 150; i++ {
		RememberTask(st, "x"+string(rune('a'+i%26))+time.Duration(i).String())
	}
	if len(st.ProcessedTasks) > maxProcessedTasks {
		t.Fatalf("unbounded: %d", len(st.ProcessedTasks))
	}
}
