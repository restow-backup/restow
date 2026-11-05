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

// Under the policy fail restic may have saved its snapshot (live-read
// volumes and all) before the interrupt took effect: the failed run reports
// it, so it is no unrecorded snapshot in the repository, and says that the
// policy does not accept it (K104).
func TestSnapshotSavedBeforeTheStopIsReported(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-failed-finished", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || fin.SnapshotID != "dddd000000000000000000000000000000000000000000000000000000000000" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if codes(fin.Errors) != "snapshot_failed" || !strings.Contains(fin.Errors[0].Message, "stopped") ||
		!strings.Contains(fin.Errors[0].Message, "already saved snapshot dddd0000") || !strings.Contains(fin.Errors[0].Message, "no backup the policy accepts") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if fin.Stats == nil || fin.Stats.TotalFilesProcessed != 3 || fin.Stats.DataAdded != 4096 {
		t.Fatalf("stats %+v", fin.Stats)
	}
	if c := fin.Consistency; c == nil || c.State != "partial" || len(c.LiveFilesystems) != 1 || c.LiveFilesystems[0] != `C:\` {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if !strings.Contains(fin.LogTail, "does not accept it as a backup") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
	if st := h.statusAfterRun(); st.Interrupted {
		t.Fatal("a stop under the policy is no interruption")
	}
}

// The Volume Shadow Copy service is disabled: restic reports every volume
// and ends with exit 0. The run carries one permanent snapshot_unavailable
// that names the service, not a transient snapshot_failed per volume (K103).
func TestSnapshotServiceDisabledContinue(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-disabled", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if codes(fin.Errors) != "snapshot_unavailable" || !strings.Contains(fin.Errors[0].Message, "service (VSS) is disabled") ||
		!strings.Contains(fin.Errors[0].Message, "ran without it") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if !strings.Contains(fin.LogTail, "services.msc") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
	if n := strings.Count(h.commands(), "backup\n"); n != 1 {
		t.Fatalf("restic backup ran %d times", n)
	}
}

// Under fail restic stops at the first failed volume. A disabled service
// proves by itself that no volume can get a shadow copy: one permanent
// snapshot_unavailable.
func TestSnapshotServiceDisabledStopsUnderFail(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "vss-disabled-wait", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || fin.SnapshotID != "" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if codes(fin.Errors) != "snapshot_unavailable" || !strings.Contains(fin.Errors[0].Message, "service (VSS) is disabled") ||
		!strings.Contains(fin.Errors[0].Message, "stopped") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
}

// Access denied on the first volume proves no machine-wide outage: D:\ was
// never tried, and access denied also concerns single volumes. The run
// reports the volume with restic's text and names the likely cause should
// it happen on every volume.
func TestSnapshotDeniedOnTheFirstVolumeStopsUnderFail(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "vss-denied-wait", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || fin.SnapshotID != "" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if codes(fin.Errors) != "snapshot_failed" || fin.Errors[0].Path != `C:\` || !strings.Contains(fin.Errors[0].Message, "E_ACCESSDENIED") ||
		!strings.Contains(fin.Errors[0].Message, "denied the agent access") || !strings.Contains(fin.Errors[0].Message, "stopped") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "partial" {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
}

func TestSnapshotUnavailableFallsBack(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-unusable", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s snapshot %q errors %+v", fin.Status, fin.SnapshotID, fin.Errors)
	}
	if codes(fin.Errors) != "snapshot_unavailable" || !strings.Contains(fin.Errors[0].Message, "restic could not initialise the Volume Shadow Copy service: Fatal: VSS error: CoInitializeSecurity") ||
		!strings.Contains(fin.Errors[0].Message, "ran without it") {
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
	// An unknown exit 1 before any progress is an ordinary failure: no
	// second run without the snapshot, no snapshot_unavailable as its
	// explanation (docs/WINDOWS-AGENT.md, 17.3).
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "odd-once", "")
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "restic_exit_1" {
		t.Fatalf("odd-once: %s %+v", fin.Status, fin.Errors)
	}
	if n := strings.Count(h.commands(), "backup\n"); n != 1 {
		t.Fatalf("restic backup ran %d times:\n%s", n, h.commands())
	}
	if !strings.Contains(fin.LogTail, "Volume Shadow Copy service") {
		t.Fatalf("the log does not mention VSS as a possible cause:\n%s", fin.LogTail)
	}
}

func TestUnknownFailureNotTheSnapshot(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "odd-always", "")
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "restic_exit_1" {
		t.Fatalf("odd-always: %s %+v", fin.Status, fin.Errors)
	}
}

// A network blip while restic opens the repository is no VSS failure: the
// run fails like any other (the retry makes the backup, with the shadow
// copy), and nothing says "shadow copy not available".
func TestNetworkFailureIsNeverBlamedOnTheSnapshot(t *testing.T) {
	for _, fake := range []string{"net-once", "net-flaky"} {
		t.Run(fake, func(t *testing.T) {
			withVSS(t, vssPlan)
			fin, h := backupWithPolicy(t, fake, "")
			if fin.Status != api.StatusFailed || codes(fin.Errors) != "restic_exit_1" || fin.Consistency != nil {
				t.Fatalf("%s %+v %+v", fin.Status, fin.Errors, fin.Consistency)
			}
			if n := strings.Count(h.commands(), "backup\n"); n != 1 {
				t.Fatalf("restic backup ran %d times:\n%s", n, h.commands())
			}
			if !strings.Contains(fin.Errors[0].Message, "could not be reached") {
				t.Fatalf("no network hint: %s", fin.Errors[0].Message)
			}
			args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
			if !strings.Contains(string(args), "--use-fs-snapshot") {
				t.Fatal("ran without the shadow copy")
			}
			if fake == "net-once" {
				// The retry succeeds with the shadow copy, green.
				h.srv.QueueTask(task("t-2", api.TaskBackupNow, nil))
				fin = h.waitRun(2).Finish
				if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 || fin.Consistency == nil || fin.Consistency.State != "used" {
					t.Fatalf("retry: %s %+v %+v", fin.Status, fin.Errors, fin.Consistency)
				}
			}
		})
	}
}

// restic could not set up VSS and the backup without it failed too: the
// second failure is the cause, not "shadow copy not available".
func TestFallbackFailureIsTheCause(t *testing.T) {
	withVSS(t, vssPlan)
	fin, h := backupWithPolicy(t, "vss-unusable-then-fail", "")
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "restic_exit_1" || !strings.Contains(fin.Errors[0].Message, "connection refused") {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if n := strings.Count(h.commands(), "backup\n"); n != 2 {
		t.Fatalf("restic backup ran %d times:\n%s", n, h.commands())
	}
}

// restic made the shadow copy of a volume mounted in a folder but cannot use
// it (GetSnapshotProperties) and reads that folder live with exit code 0: the
// folder is a failed volume and the run is partial, not green with a file
// error beside it (K102).
func TestMountPointSnapshotUnusableIsPartial(t *testing.T) {
	withVSS(t, vssPlan)
	fin, _ := backupWithPolicy(t, "vss-mount-props", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s snapshot %q errors %+v", fin.Status, fin.SnapshotID, fin.Errors)
	}
	if codes(fin.Errors) != "snapshot_failed" || fin.Errors[0].Path != `C:\data\archive\` || !strings.Contains(fin.Errors[0].Message, "live file system") {
		t.Fatalf("errors %+v", fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "partial" || len(c.LiveFilesystems) != 1 || c.LiveFilesystems[0] != `C:\data\archive\` {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
}

// The volumes the plan reads live reach restic as vss.exclude-volumes, a
// mounted folder by its volume GUID path.
func TestSnapshotExcludedVolumesReachRestic(t *testing.T) {
	withVSS(t, snapshotPlan{method: api.SnapshotMethodVSS, requested: true, volumes: []string{`C:\`},
		excluded: []string{`E:\`, `C:\Data\Archive\`}, vssExclude: []string{`E:\`, `\\?\Volume{aaaa}\`}})
	fin, h := backupWithPolicy(t, "ok", "")
	if fin.Status != api.StatusSucceeded || fin.Consistency == nil || fin.Consistency.State != "used" ||
		strings.Join(fin.Consistency.LiveFilesystems, ";") != `E:\;C:\Data\Archive\` {
		t.Fatalf("%s %+v", fin.Status, fin.Consistency)
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "vss.exclude-volumes=E:\\;\\\\?\\Volume{aaaa}\\\n") {
		t.Fatalf("args:\n%s", args)
	}
}

// Every source on a volume VSS cannot do by design (an exFAT disk, a
// removable drive): no volume came from a shadow copy, which the consistency
// says (unavailable, with the volume), but nothing failed and nothing the
// administrator could fix short of switching VSS off for the machine, so the
// run is green, as with an exFAT disk next to a snapshotted C:\ (K-W03).
func TestSnapshotOnlyExcludedVolumesSucceeds(t *testing.T) {
	withVSS(t, snapshotPlan{method: api.SnapshotMethodVSS, requested: true,
		excluded: []string{`E:\`}, vssExclude: []string{`E:\`}, notes: []string{`E:\ is read without a shadow copy: file system exFAT.`}})
	fin, _ := backupWithPolicy(t, "ok", "")
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" || strings.Join(c.LiveFilesystems, ";") != `E:\` {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if !strings.Contains(fin.LogTail, "file system exFAT") {
		t.Fatalf("log:\n%s", fin.LogTail)
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
