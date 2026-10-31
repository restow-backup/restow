//go:build unix

package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// withVSS makes the agent ask restic for a shadow copy as it does on Windows
// with useVss, so the policy runs against the fake restic on any system.
func withVSS(t *testing.T, plan snapshotPlan) {
	t.Helper()
	old := planSnapshotFn
	planSnapshotFn = func(*api.Config, []string) snapshotPlan { return plan }
	t.Cleanup(func() { planSnapshotFn = old })
}

var vssPlan = snapshotPlan{method: api.SnapshotMethodVSS, requested: true, volumes: []string{`C:\`, `D:\`}}

func backupWithPolicy(t *testing.T, fake, policy string) (*api.FinishRequest, *harness) {
	t.Helper()
	h := newHarness(t)
	h.env("FAKE_BACKUP=" + fake)
	h.srv.Config.UseVSS = true
	if policy != "" {
		h.srv.Config.Policy = &api.Policy{SnapshotOnFailure: policy}
	}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	return h.waitRun(1).Finish, h
}

func codes(errs []api.RunError) string {
	var c []string
	for _, e := range errs {
		c = append(c, e.Code)
	}
	return strings.Join(c, ",")
}

func TestSnapshotUsed(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "ok", "")
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.Method != "vss" || c.State != "used" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--use-fs-snapshot\n-o\nvss.timeout=5m0s") {
		t.Fatalf("args:\n%s", args)
	}
}

func TestSnapshotFailedContinue(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "vss-failed", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if codes(fin.Errors) != "snapshot_failed" || fin.Errors[0].Path != `C:\` {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "partial" || len(c.LiveFilesystems) != 1 || c.LiveFilesystems[0] != `C:\` {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if !strings.Contains(fin.LogTail, "Event Viewer") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestSnapshotFailedStopsUnderFail(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-failed-wait", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || fin.SnapshotID != "" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if codes(fin.Errors) != "snapshot_failed" || !strings.Contains(fin.Errors[0].Message, "stopped") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if strings.Contains(fin.LogTail, "interrupted; it resumes") {
		t.Fatalf("reported as interrupted:\n%s", fin.LogTail)
	}
	if st := h.statusAfterRun(); st.Interrupted {
		t.Fatal("a stop under the policy is no interruption")
	}
}

func TestSnapshotUnavailableFallsBack(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-unusable", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s snapshot %q errors %+v", fin.Status, fin.SnapshotID, fin.Errors)
	}
	if codes(fin.Errors) != "snapshot_unavailable" || !strings.Contains(fin.Errors[0].Message, "CoInitializeSecurity") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	// Two backups: with the snapshot, then without.
	if n := strings.Count(h.commands(), "backup\n"); n != 2 {
		t.Fatalf("restic backup ran %d times:\n%s", n, h.commands())
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if strings.Contains(string(args), "--use-fs-snapshot") {
		t.Fatal("the second run asked for the snapshot again")
	}
}

func TestSnapshotUnavailableFailsUnderFail(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-unusable", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "snapshot_unavailable" {
		t.Fatalf("status %s errors %+v", fin.Status, fin.Errors)
	}
	if n := strings.Count(h.commands(), "backup\n"); n != 1 {
		t.Fatalf("restic backup ran %d times", n)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
}

func TestUnknownFailureWithSnapshot(t *testing.T) {
	// An unknown exit 1 before any progress: the second run without the
	// snapshot tells whether it was the snapshot.
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "odd-once", "")
	if fin.Status != api.StatusPartial || codes(fin.Errors) != "snapshot_unavailable" {
		t.Fatalf("odd-once: %s %+v", fin.Status, fin.Errors)
	}
}

func TestUnknownFailureNotTheSnapshot(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "odd-always", "")
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "restic_exit_1" {
		t.Fatalf("odd-always: %s %+v", fin.Status, fin.Errors)
	}
}

func TestSnapshotCleanupIsOnlyANote(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "vss-cleanup", "")
	if fin.Status != api.StatusSucceeded || codes(fin.Errors) != "snapshot_cleanup_failed" {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
}

func TestSnapshotWithoutRights(t *testing.T) {
	withVSS(t, snapshotPlan{method: "vss", unavailable: "the agent runs without administrator rights"})
	fin, h := backupWithPolicy(t, "ok", "")
	if fin.Status != api.StatusPartial || codes(fin.Errors) != "snapshot_unavailable" {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if strings.Contains(string(args), "--use-fs-snapshot") {
		t.Fatal("asked for a snapshot without rights")
	}
	withVSS(t, snapshotPlan{method: "vss", unavailable: "the agent runs without administrator rights"})
	fin, h = backupWithPolicy(t, "ok", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "snapshot_unavailable" || strings.Contains(h.commands(), "backup\n") {
		t.Fatalf("%s %+v %s", fin.Status, fin.Errors, h.commands())
	}
}

func TestNoSnapshotOnThisSystemReportsOff(t *testing.T) {
	fin, _ := backupWithPolicy(t, "ok", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "off" || c.Method != "" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if !strings.Contains(fin.LogTail, "no effect on this system") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestForeignPathsAreSkipped(t *testing.T) {
	h := newHarness(t)
	h.srv.Config.Paths = []string{`C:\Users`, h.src}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded || !strings.Contains(fin.LogTail, `other operating systems are skipped on this machine: C:\Users`) {
		t.Fatalf("%s\n%s", fin.Status, fin.LogTail)
	}
	h2 := newHarness(t)
	h2.srv.Config.Paths = []string{`C:\Users`}
	h2.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h2.start()
	fin = h2.waitRun(1).Finish
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "no_paths" || !strings.Contains(fin.Errors[0].Message, "operating system") {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
}
