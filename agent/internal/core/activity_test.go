package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/status"
)

const previousSnapshotID = "cccc000000000000000000000000000000000000000000000000000000000000"

func TestBackupReportsWhatChangedSinceThePreviousSnapshot(t *testing.T) {
	h := newHarness(t)
	h.writeSourceFiles(3)
	h.srv.Config.Paths = []string{h.src}
	change := func(p, m string) string {
		b, _ := json.Marshal(map[string]string{"message_type": "change", "path": p, "modifier": m})
		return string(b)
	}
	diff := strings.Join([]string{
		change(h.src+"/", "M"),
		change(h.src+"/file00.txt", "M"),
		change(h.src+"/report.docx", "-"),
		change(h.src+"/report.docx.locked", "+"),
		change(h.src+"/HOW_TO_DECRYPT.txt", "+"),
		// A folder that left the backup set is not deleted.
		change("/elsewhere/old.txt", "-"),
		`{"message_type":"statistics","changed_files":1}`,
	}, "\n") + "\n"
	diffFile := filepath.Join(h.dir, "diff.jsonl")
	if err := os.WriteFile(diffFile, []byte(diff), 0o644); err != nil {
		t.Fatal(err)
	}
	h.env("FAKE_DIFF_FILE=" + diffFile)
	h.build()
	_ = h.status.Update(func(s *status.Status) {
		s.LastBackup = &status.RunSummary{Kind: "backup", Status: api.StatusSucceeded, SnapshotID: previousSnapshotID}
	})
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()

	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("status %s, log:\n%s", fin.Status, fin.LogTail)
	}
	a := fin.Activity
	if a == nil || a.V != 1 || a.Added != 2 || a.Modified != 1 || a.Removed != 1 || a.Renamed != 1 {
		t.Fatalf("activity %+v, log:\n%s", a, fin.LogTail)
	}
	if len(a.Names) != 1 || a.Names[0].Value != "HOW_TO_DECRYPT.txt" {
		t.Fatalf("names %+v", a.Names)
	}
	// Only the file that exists on disk is measured; the others are gone or new elsewhere.
	if len(a.Entropy) != 1 || a.Entropy[0].Path != h.src+"/file00.txt" || a.Entropy[0].Head <= 0 {
		t.Fatalf("entropy %+v", a.Entropy)
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "diff-args.txt"))
	if !strings.Contains(string(args), "--no-lock\n"+previousSnapshotID+"\naaaa") {
		t.Fatalf("diff args:\n%s", args)
	}
	if !strings.Contains(fin.LogTail, "1 renamed to another extension") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestFirstBackupAndAFailedDiffSendNoActivity(t *testing.T) {
	h := newHarness(t)
	h.writeSourceFiles(3)
	h.srv.Config.Paths = []string{h.src}
	h.build()
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	if fin := h.waitRun(1).Finish; fin.Activity != nil || strings.Contains(h.commands(), "diff") {
		t.Fatalf("a first backup compared: %+v", fin.Activity)
	}
	h.stop()

	// The previous snapshot is gone (retention): the diff fails, the backup does not.
	h2 := newHarness(t)
	h2.writeSourceFiles(3)
	h2.srv.Config.Paths = []string{h2.src}
	h2.build()
	_ = h2.status.Update(func(s *status.Status) {
		s.LastBackup = &status.RunSummary{Kind: "backup", Status: api.StatusSucceeded, SnapshotID: previousSnapshotID}
	})
	h2.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h2.start()
	fin := h2.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded || fin.Activity != nil {
		t.Fatalf("status %s activity %+v", fin.Status, fin.Activity)
	}
	if !strings.Contains(fin.LogTail, "Could not compare this snapshot with the previous one") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestUnderSources(t *testing.T) {
	within := underSources([]string{"/srv/data/", "/home"})
	for p, want := range map[string]bool{
		"/srv/data/a.txt": true, "/srv/data": true, "/srv/database/x": false, "/home/u/x": true, "/etc/x": false,
	} {
		if within(p) != want {
			t.Errorf("%s: %v", p, !want)
		}
	}
}
