package core

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/power"
	"github.com/restow-backup/restow/agent/internal/release"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func TestBackupTaskEndToEnd(t *testing.T) {
	h := newHarness(t)
	_, hashes := h.writeSourceFiles(30)
	h.srv.Config.Excludes = []string{"*.tmp"}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()

	run := h.waitRun(1)
	if run.Start.Kind != "backup" || run.Start.TaskID != "t-1" {
		t.Fatalf("start: %+v", run.Start)
	}
	fin := run.Finish
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("status %s, errors %+v, log:\n%s", fin.Status, fin.Errors, fin.LogTail)
	}
	if fin.SnapshotID != "aaaa000000000000000000000000000000000000000000000000000000000000" {
		t.Fatalf("snapshot id %q", fin.SnapshotID)
	}
	if fin.Stats == nil || fin.Stats.FilesNew != 2 || fin.Stats.FilesChanged != 1 || fin.Stats.DataAdded != 4096 || fin.Stats.TotalBytesProcessed != 300 {
		t.Fatalf("stats: %+v", fin.Stats)
	}
	if fin.Errors == nil {
		t.Fatal("errors must be a (possibly empty) array")
	}
	// Sample: at most 20 files, hashes match the files on disk, paths are snapshot paths.
	if len(fin.Sample) != 20 {
		t.Fatalf("sample size %d, want 20 (30 candidates)", len(fin.Sample))
	}
	seen := map[string]bool{}
	for _, s := range fin.Sample {
		if hashes[s.Path] != s.SHA256 || s.Size == 0 || seen[s.Path] {
			t.Fatalf("bad sample entry %+v", s)
		}
		seen[s.Path] = true
	}
	for _, want := range []string{"Run started", "Backing up:", "Snapshot aaaa0000 saved", "Recorded SHA-256 of 20 sample files", "Run finished: succeeded"} {
		if !strings.Contains(fin.LogTail, want) {
			t.Errorf("log tail lacks %q:\n%s", want, fin.LogTail)
		}
	}
	// The agent's own working directories and earlier restores are excluded.
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--files-from-raw") || !strings.Contains(string(args), "--host\ntest-host") {
		t.Fatalf("backup args:\n%s", args)
	}
	// Local status reflects the run.
	st := h.statusAfterRun()
	if st.LastBackup == nil || st.LastBackup.Status != "succeeded" || st.LastSuccessAt.IsZero() || st.Current != nil || st.ConsecutiveFailures != 0 {
		t.Fatalf("status: %+v", st)
	}
	// Heartbeats carry version, state and config version.
	if n := h.srv.HeartbeatCount(); n < 1 {
		t.Fatal("no heartbeat sent")
	}
	h.srv.Lock()
	hb := h.srv.Heartbeats[0]
	h.srv.Unlock()
	if hb.AgentVersion != buildinfo.Version || hb.State != "idle" || hb.OSVersion == "" || hb.ConfigVersion != "0" && hb.ConfigVersion != "1" {
		t.Fatalf("heartbeat: %+v", hb)
	}
}

func TestPartialBackup(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP=partial")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s snapshot %q", fin.Status, fin.SnapshotID)
	}
	if len(fin.Errors) != 1 || fin.Errors[0].Path != "/srv/locked.db" || !strings.Contains(fin.Errors[0].Message, "permission denied") ||
		fin.Errors[0].Code != "archival" {
		t.Fatalf("errors: %+v", fin.Errors)
	}
	// Logged once, readably, with restic's final warning; never as raw JSON.
	if strings.Count(fin.LogTail, "error: /srv/locked.db: open /srv/locked.db: permission denied") != 1 ||
		strings.Contains(fin.LogTail, `"message_type"`) || !strings.Contains(fin.LogTail, "(1 errors)") {
		t.Fatalf("log tail:\n%s", fin.LogTail)
	}
	if st := h.statusAfterRun(); st.ConsecutiveFailures != 0 || st.LastSuccessAt.IsZero() {
		t.Fatalf("a partial backup still counts as taken: %+v", st)
	}
}

// An older restic wrote the errors of single files to stdout: they are still read there.
func TestPartialBackupOfAnOlderRestic(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP=partial-old")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusPartial || len(fin.Errors) != 1 || fin.Errors[0].Path != "/root/secret" {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
}

// A backup with more unreadable files than a report lists names the first
// ones and says how many more there are; the wire format stays the same.
func TestPartialBackupListsTheFirstErrorsAndCountsAll(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP=partial-many")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusPartial || len(fin.Errors) != maxReportedErrors {
		t.Fatalf("%s, %d errors", fin.Status, len(fin.Errors))
	}
	if fin.Errors[0].Path != "/srv/f0" || fin.Errors[98].Path != "/srv/f98" {
		t.Fatalf("first errors: %+v %+v", fin.Errors[0], fin.Errors[98])
	}
	last := fin.Errors[len(fin.Errors)-1]
	if last.Code != "truncated" || !strings.HasPrefix(last.Message, "31 more errors are not listed here") {
		t.Fatalf("last: %+v", last)
	}
	if !strings.Contains(fin.LogTail, "Some files could not be read (130 errors)") {
		t.Fatalf("log tail:\n%s", fin.LogTail)
	}
}

func TestFailedBackupExplainsAndCounts(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP=fail")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || fin.SnapshotID != "" || len(fin.Errors) != 1 {
		t.Fatalf("finish: %+v", fin)
	}
	if !strings.Contains(fin.Errors[0].Message, "could not be reached") || fin.Errors[0].Code != "restic_exit_1" {
		t.Fatalf("error should carry the hint: %+v", fin.Errors[0])
	}
	if st := h.statusAfterRun(); st.ConsecutiveFailures != 1 || st.Interrupted {
		t.Fatalf("status: %+v", st)
	}
}

func TestMissingPathsAreSkippedAndReported(t *testing.T) {
	h := newHarness(t)
	h.srv.Config.Paths = []string{h.src, "/definitely/not/here"}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded || !strings.Contains(fin.LogTail, "/definitely/not/here does not exist") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestNoExistingPathFailsClearly(t *testing.T) {
	h := newHarness(t)
	h.srv.Config.Paths = []string{"/definitely/not/here"}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "no_paths" {
		t.Fatalf("finish: %+v", fin)
	}
	if strings.Contains(h.commands(), "backup") {
		t.Fatal("restic must not be started without a source")
	}
}

func TestHooksPreFailureAbortsBackupPostStillRuns(t *testing.T) {
	h := newHarness(t)
	h.hooksMode = hooks.ModeAny
	marker := filepath.Join(h.dir, "post-ran")
	h.srv.Config.Hooks = api.Hooks{Pre: "echo dumping; exit 3", Post: "echo \"post status=$RESTOW_BACKUP_STATUS\"; touch " + marker}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "pre_hook_failed" {
		t.Fatalf("finish: %+v", fin)
	}
	for _, want := range []string{"pre-hook: dumping", "post-hook: post status=failed"} {
		if !strings.Contains(fin.LogTail, want) {
			t.Errorf("log lacks %q:\n%s", want, fin.LogTail)
		}
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("post hook did not run after a failed pre hook")
	}
	if strings.Contains(h.commands(), "backup") {
		t.Fatal("the backup must not start when the pre hook failed")
	}
}

func TestHooksSuccessAndPostFailureMakesBackupPartial(t *testing.T) {
	h := newHarness(t)
	h.hooksMode = hooks.ModeAny
	h.srv.Config.Hooks = api.Hooks{Pre: "echo pre-ok", Post: "echo cleanup-failed >&2; exit 1"}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s", fin.Status)
	}
	if len(fin.Errors) != 1 || fin.Errors[0].Code != "post_hook_failed" {
		t.Fatalf("errors: %+v", fin.Errors)
	}
	if !strings.Contains(fin.LogTail, "pre-hook: pre-ok") || !strings.Contains(fin.LogTail, "post-hook: cleanup-failed") {
		t.Fatalf("hook output missing from the log:\n%s", fin.LogTail)
	}
}

func TestBandwidthLimitPassedToRestic(t *testing.T) {
	h := newHarness(t)
	kbps := int64(8000) // 8 Mbit/s = 976.5625 KiB/s -> 977
	h.srv.Config.BandwidthKbps = &kbps
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	h.waitRun(1)
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--limit-upload\n977") {
		t.Fatalf("args:\n%s", args)
	}
}

func TestBandwidthLimitIsReadWhenABackupStarts(t *testing.T) {
	// The server works out the active time window when the agent asks for its
	// configuration, and it does not change the configuration version at a
	// window boundary. A backup therefore has to read the configuration again
	// when it starts, not use the copy it holds.
	h := newHarness(t)
	night := int64(0)
	day := int64(2000) // 2 Mbit/s = 244.14 KiB/s -> 245
	h.srv.Config.BandwidthKbps = &day
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	h.waitRun(1)
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--limit-upload\n245") {
		t.Fatalf("first run:\n%s", args)
	}

	// The window ends: same configVersion, no limit any more.
	h.srv.Lock()
	h.srv.Config.BandwidthKbps = &night
	version := h.srv.Config.ConfigVersion
	h.srv.Unlock()
	h.srv.QueueTask(task("t-2", api.TaskBackupNow, nil))
	h.waitRun(2)
	args, _ = os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if strings.Contains(string(args), "--limit-upload") {
		t.Fatalf("second run still limited:\n%s", args)
	}

	// And a limit again, still without a new version.
	h.srv.Lock()
	h.srv.Config.BandwidthKbps = &day
	if h.srv.Config.ConfigVersion != version {
		t.Fatalf("the test must not change the configuration version")
	}
	h.srv.Unlock()
	h.srv.QueueTask(task("t-3", api.TaskBackupNow, nil))
	h.waitRun(3)
	args, _ = os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--limit-upload\n245") {
		t.Fatalf("third run:\n%s", args)
	}
}

func TestSizeLimitPassedToRestic(t *testing.T) {
	h := newHarness(t)
	h.srv.Config.ExcludeLargerThanBytes = 5 << 30 // 5 GiB
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--exclude-larger-than\n5368709120") {
		t.Fatalf("args:\n%s", args)
	}
	// The log says that files are being skipped on purpose.
	if !strings.Contains(fin.LogTail, "Files larger than 5.0 GiB are not backed up") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestNoSizeLimitWhenTheConfigurationHasNone(t *testing.T) {
	// An absent field and an explicit 0 both mean "no limit"; restic would read 0 as "skip every file".
	for _, limit := range []int64{0, -1} {
		h := newHarness(t)
		h.srv.Config.ExcludeLargerThanBytes = limit
		h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
		h.start()
		fin := h.waitRun(1).Finish
		args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
		if strings.Contains(string(args), "--exclude-larger-than") {
			t.Fatalf("limit %d reached restic:\n%s", limit, args)
		}
		if strings.Contains(fin.LogTail, "Files larger than") {
			t.Fatalf("log mentions a limit that is not set:\n%s", fin.LogTail)
		}
		h.stop()
	}
}

func TestProgressIsReportedEveryFiveSecondsByDefault(t *testing.T) {
	var o Options
	o.defaults()
	if o.ProgressInterval != 5*time.Second {
		t.Fatalf("default progress interval %s, want 5s", o.ProgressInterval)
	}
	// The reporter has the same fallback for a caller that passes none.
	if p := newProgressReporter(nil, "1", 0, nil); p.interval != 5*time.Second {
		t.Fatalf("reporter interval %s, want 5s", p.interval)
	}
	// An explicit interval wins (the tests of the engine use a few milliseconds).
	o = Options{ProgressInterval: 20 * time.Millisecond}
	o.defaults()
	if o.ProgressInterval != 20*time.Millisecond {
		t.Fatalf("explicit interval overridden: %s", o.ProgressInterval)
	}
}

func TestScheduledIntervalBackupStartsImmediatelyAndDoesNotRepeat(t *testing.T) {
	h := newHarness(t)
	h.noHistory = true
	h.srv.Config.Schedule = api.Schedule{Kind: api.ScheduleInterval, IntervalMinutes: 60}
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("status %s", fin.Status)
	}
	time.Sleep(300 * time.Millisecond)
	if n := len(h.srv.AllRuns()); n != 1 {
		t.Fatalf("interval of 60 min must not trigger a second run within 300 ms, got %d runs", n)
	}
	st := h.status.Snapshot()
	if st.NextRunAt.IsZero() || st.Schedule == "" {
		t.Fatalf("next run not published: %+v", st)
	}
}

func TestOnlyOnACPowerBlocksScheduledBackup(t *testing.T) {
	h := newHarness(t)
	h.noHistory = true
	var onAC atomic.Bool
	h.powerFn = func() power.Status {
		if onAC.Load() {
			return power.Status{OnAC: true, Known: true, Detail: "test"}
		}
		return power.Status{OnAC: false, Known: true, Detail: "test battery"}
	}
	h.srv.Config.Profile = api.ProfileClient
	h.srv.Config.OnlyOnACPower = true
	h.srv.Config.Schedule = api.Schedule{Kind: api.ScheduleOnConnect}
	h.start()
	time.Sleep(400 * time.Millisecond)
	if n := len(h.srv.AllRuns()); n != 0 {
		t.Fatalf("no backup may start on battery, got %d runs", n)
	}
	onAC.Store(true)
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("status %s", fin.Status)
	}
}

func TestManualBackupIgnoresACRestriction(t *testing.T) {
	h := newHarness(t)
	h.powerFn = func() power.Status { return power.Status{OnAC: false, Known: true, Detail: "battery"} }
	h.srv.Config.OnlyOnACPower = true
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	if fin := h.waitRun(1).Finish; fin.Status != api.StatusSucceeded {
		t.Fatalf("status %s", fin.Status)
	}
}

func TestRestoreTaskGoesIntoANewFolder(t *testing.T) {
	h := newHarness(t)
	target := filepath.Join(h.dir, "Restow-Restore-test")
	snap := "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	h.srv.QueueTask(task("t-1", api.TaskRestore, api.RestoreParams{SnapshotID: snap, Paths: []string{"/home/lucas/Report [final].txt"}, TargetDir: target}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded || fin.SnapshotID != snap {
		t.Fatalf("finish: %+v\n%s", fin, fin.LogTail)
	}
	if !strings.Contains(fin.LogTail, "No existing file was overwritten") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
	if _, err := os.Stat(filepath.Join(target, "data", "file.txt")); err != nil {
		t.Fatalf("restored file missing: %v", err)
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "restore-args.txt"))
	// The agent hands restic the resolved target (macOS: the temp folder is below the link /var).
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--overwrite\nnever", "--target\n" + canonical, "--include\n/home/lucas/Report \\[final].txt", snap} {
		if !strings.Contains(string(args), want) {
			t.Errorf("restore args lack %q:\n%s", want, args)
		}
	}
	run := h.srv.AllRuns()[0]
	if run.Start.Kind != "restore" || run.Start.TaskID != "t-1" {
		t.Fatalf("start: %+v", run.Start)
	}
}

func TestRestoreRefusesExistingContent(t *testing.T) {
	h := newHarness(t)
	target := filepath.Join(h.dir, "existing")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(target, "precious.txt")
	if err := os.WriteFile(keep, []byte("do not touch"), 0o644); err != nil {
		t.Fatal(err)
	}
	snap := "abcdef0123456789"
	h.srv.QueueTask(task("t-1", api.TaskRestore, api.RestoreParams{SnapshotID: snap, TargetDir: target}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "target_not_empty" ||
		!strings.Contains(fin.Errors[0].Message, "never overwrites") {
		t.Fatalf("finish: %+v", fin)
	}
	if strings.Contains(h.commands(), "restore") {
		t.Fatal("restic restore must not run against an existing folder")
	}
	if b, _ := os.ReadFile(keep); string(b) != "do not touch" {
		t.Fatal("existing file was modified")
	}
}

func TestRestoreDefaultTargetIsNewFolderInBackedUpRoot(t *testing.T) {
	h := newHarness(t)
	h.srv.QueueTask(task("t-1", api.TaskRestore, api.RestoreParams{SnapshotID: "abcdef0123456789"}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("finish: %+v\n%s", fin, fin.LogTail)
	}
	entries, err := os.ReadDir(h.src)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "Restow-Restore-") && e.IsDir() {
			found = true
		}
	}
	if !found {
		t.Fatalf("no Restow-Restore-<timestamp> folder in %s: %v", h.src, entries)
	}
}

func TestInvalidTaskParamsFailTheRun(t *testing.T) {
	h := newHarness(t)
	h.srv.QueueTask(api.Task{ID: "t-1", Kind: api.TaskRestore, Params: []byte(`{"snapshotId":"../../etc"}`)})
	h.srv.QueueTask(api.Task{ID: "t-2", Kind: api.TaskVerifySample, Params: []byte(`"not an object"`)})
	h.start()
	for i := 1; i <= 2; i++ {
		fin := h.waitRun(i).Finish
		if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "invalid_task" {
			t.Fatalf("run %d: %+v", i, fin)
		}
		// A restore test that never ran restic reports no result: the server rates nothing.
		if fin.RestoreTest != nil {
			t.Fatalf("run %d: restore-test result without a restore: %+v", i, fin.RestoreTest)
		}
	}
}

func TestVerifySampleTask(t *testing.T) {
	h := newHarness(t)
	restoreSrc := filepath.Join(h.dir, "snapshot-tree")
	files := map[string]string{"/data/a.txt": "alpha", "/data/b.txt": "bravo", "/srv/[x] c.txt": "charlie"}
	var params api.VerifySampleParams
	params.SnapshotID = "abcdef0123456789"
	for p, content := range files {
		full := filepath.Join(restoreSrc, p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		sum, _, _ := hashFile(full, nil)
		params.Files = append(params.Files, api.SampleFile{Path: p, SHA256: sum})
	}
	h.env("FAKE_RESTORE_SRC=" + restoreSrc)
	h.srv.QueueTask(task("t-1", api.TaskVerifySample, params))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusSucceeded || len(fin.Sample) != 3 || len(fin.Errors) != 0 {
		t.Fatalf("finish: %+v\n%s", fin, fin.LogTail)
	}
	if !strings.Contains(fin.LogTail, "all 3 files restored with matching SHA-256") || !strings.Contains(fin.LogTail, "temporary copy was deleted") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
	// The temporary copy is gone.
	entries, _ := os.ReadDir(h.layout.TmpDir())
	if len(entries) != 0 {
		t.Fatalf("temporary folder not cleaned up: %v", entries)
	}
	// The exact path (with glob characters) is passed escaped to restic.
	args, _ := os.ReadFile(filepath.Join(h.dir, "restore-args.txt"))
	if !strings.Contains(string(args), "--include\n/srv/\\[x] c.txt") {
		t.Fatalf("restore args:\n%s", args)
	}
	// The observed hash of every file goes to the server, which judges the test.
	if fin.RestoreTest == nil || fin.RestoreTest.Restic != nil || len(fin.RestoreTest.Files) != 3 {
		t.Fatalf("restore test: %+v", fin.RestoreTest)
	}
	for i, f := range fin.RestoreTest.Files {
		if f.Path != params.Files[i].Path || f.SHA256 != params.Files[i].SHA256 || f.Missing || f.Error != "" {
			t.Fatalf("file %d: %+v, want %+v", i, f, params.Files[i])
		}
	}
	// One restic process restores every file: restic 0.19 cannot set up a new
	// cache folder from several processes at once (the server's restore test
	// reads its first file alone for that reason); the agent never runs two.
	if n := strings.Count(h.commands(), "restore\n"); n != 1 {
		t.Fatalf("restic restore ran %d times:\n%s", n, h.commands())
	}
}

func TestVerifySampleDetectsMismatchAndMissing(t *testing.T) {
	h := newHarness(t)
	restoreSrc := filepath.Join(h.dir, "snapshot-tree")
	_ = os.MkdirAll(filepath.Join(restoreSrc, "data"), 0o755)
	_ = os.WriteFile(filepath.Join(restoreSrc, "data/a.txt"), []byte("corrupted"), 0o644)
	h.env("FAKE_RESTORE_SRC=" + restoreSrc)
	good := sha256Hex("alpha")
	h.srv.QueueTask(task("t-1", api.TaskVerifySample, api.VerifySampleParams{
		SnapshotID: "abcdef0123456789",
		Files:      []api.SampleFile{{Path: "/data/a.txt", SHA256: good}, {Path: "/data/missing.txt", SHA256: good}},
	}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 2 {
		t.Fatalf("finish: %+v", fin)
	}
	codes := map[string]string{}
	for _, e := range fin.Errors {
		codes[e.Path] = e.Code
	}
	if codes["/data/a.txt"] != "hash_mismatch" || codes["/data/missing.txt"] != "missing" {
		t.Fatalf("codes: %v", codes)
	}
	rt := fin.RestoreTest
	if rt == nil || rt.Restic != nil || len(rt.Files) != 2 {
		t.Fatalf("restore test: %+v", rt)
	}
	if rt.Files[0].SHA256 != sha256Hex("corrupted") || rt.Files[0].Missing || rt.Files[1].SHA256 != "" || !rt.Files[1].Missing {
		t.Fatalf("files: %+v", rt.Files)
	}
}

// restic restore failed: its exit code, final error and per-item errors go to
// the server (which decides whether they prove damage), with what it restored.
func TestVerifySampleReportsResticFailure(t *testing.T) {
	h := newHarness(t)
	restoreSrc := filepath.Join(h.dir, "snapshot-tree")
	_ = os.MkdirAll(filepath.Join(restoreSrc, "data"), 0o755)
	_ = os.WriteFile(filepath.Join(restoreSrc, "data/a.txt"), []byte("alpha"), 0o644)
	stderr := filepath.Join(h.dir, "restore-stderr.txt")
	long := "lchown /tmp/" + strings.Repeat("x", 3000) + ": no such file or directory"
	lines := []string{
		`Load(<data/6e73100d78>, 47, 300050) failed: <data/6e73100d78> does not exist`,
		`{"message_type":"error","error":{"message":"ReadFull(\u003cdata/6e73100d78\u003e): \u003cdata/6e73100d78\u003e does not exist"},"during":"restore","item":"/data/b.txt"}`,
		`{"message_type":"error","error":{"message":"` + long + `"},"during":"restore","item":"/data/b.txt"}`,
		`{"message_type":"exit_error","code":1,"message":"Fatal: There were 2 errors"}`,
	}
	if err := os.WriteFile(stderr, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.env("FAKE_RESTORE_SRC="+restoreSrc, "FAKE_RESTORE_STDERR="+stderr, "FAKE_RESTORE_EXIT=1")
	h.srv.QueueTask(task("t-1", api.TaskVerifySample, api.VerifySampleParams{
		SnapshotID: "abcdef0123456789",
		Files:      []api.SampleFile{{Path: "/data/a.txt", SHA256: sha256Hex("alpha")}, {Path: "/data/b.txt", SHA256: sha256Hex("bravo")}},
	}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "restic_exit_1" {
		t.Fatalf("finish: %+v", fin)
	}
	rt := fin.RestoreTest
	if rt == nil || rt.Restic == nil {
		t.Fatalf("restore test: %+v", rt)
	}
	if rt.Restic.ExitCode != 1 || rt.Restic.Fatal != "Fatal: There were 2 errors" || len(rt.Restic.Errors) != 2 {
		t.Fatalf("restic: %+v", rt.Restic)
	}
	first, second := rt.Restic.Errors[0], rt.Restic.Errors[1]
	if first.Item != "/data/b.txt" || first.Message != "ReadFull(<data/6e73100d78>): <data/6e73100d78> does not exist" {
		t.Fatalf("first error: %+v", first)
	}
	// A long message keeps its start and its end (restic names the cause last).
	if len(second.Message) > maxResticMessageBytes || !strings.HasPrefix(second.Message, "lchown /tmp/xxx") ||
		!strings.HasSuffix(second.Message, ": no such file or directory") {
		t.Fatalf("second error (%d bytes): %q", len(second.Message), second.Message)
	}
	if len(rt.Files) != 2 || rt.Files[0].SHA256 != sha256Hex("alpha") || !rt.Files[1].Missing {
		t.Fatalf("files: %+v", rt.Files)
	}
	if fin.SnapshotID != "abcdef0123456789" {
		t.Fatalf("snapshot: %q", fin.SnapshotID)
	}
}

// A restored item the agent cannot check is reported as such, never as a hash.
func TestVerifySampleReportsAFileItCannotCheck(t *testing.T) {
	h := newHarness(t)
	restoreSrc := filepath.Join(h.dir, "snapshot-tree")
	_ = os.MkdirAll(restoreSrc, 0o755)
	h.env("FAKE_RESTORE_SRC="+restoreSrc, "FAKE_RESTORE_MKDIR=/data/dir.txt")
	h.srv.QueueTask(task("t-1", api.TaskVerifySample, api.VerifySampleParams{
		SnapshotID: "abcdef0123456789", Files: []api.SampleFile{{Path: "/data/dir.txt", SHA256: sha256Hex("x")}},
	}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "not_regular" {
		t.Fatalf("finish: %+v", fin)
	}
	rt := fin.RestoreTest
	if rt == nil || len(rt.Files) != 1 || rt.Files[0].Error == "" || rt.Files[0].SHA256 != "" || rt.Files[0].Missing {
		t.Fatalf("restore test: %+v", rt)
	}
}

func TestVerifySampleRejectsTraversalPaths(t *testing.T) {
	h := newHarness(t)
	h.srv.QueueTask(task("t-1", api.TaskVerifySample, api.VerifySampleParams{
		SnapshotID: "abcdef0123456789", Files: []api.SampleFile{{Path: "/data/../../etc/passwd", SHA256: "00"}},
	}))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || fin.Errors[0].Code != "invalid_task" {
		t.Fatalf("finish: %+v", fin)
	}
}

func TestDuplicateTaskIsIgnored(t *testing.T) {
	h := newHarness(t)
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	h.waitRun(1)
	time.Sleep(300 * time.Millisecond)
	if n := len(h.srv.AllRuns()); n != 1 {
		t.Fatalf("the same task id ran %d times", n)
	}
}

func TestUpdateConfigTaskRefetches(t *testing.T) {
	h := newHarness(t)
	h.start()
	fakeserver.WaitFor(5*time.Second, func() bool { h.srv.Lock(); defer h.srv.Unlock(); return h.srv.ConfigGets >= 1 })
	h.srv.Lock()
	before := h.srv.ConfigGets
	h.srv.Config.ConfigVersion = "2"
	h.srv.Unlock()
	h.srv.QueueTask(task("t-cfg", api.TaskUpdateConfig, nil))
	ok := fakeserver.WaitFor(5*time.Second, func() bool {
		st := h.status.Snapshot()
		return st.ConfigVersion == "2"
	})
	if !ok {
		t.Fatalf("config not refreshed (gets before: %d)", before)
	}
}

func TestUninstallTask(t *testing.T) {
	h := newHarness(t)
	called := make(chan struct{}, 1)
	h.uninst = func(ctx context.Context) error { called <- struct{}{}; return nil }
	h.srv.QueueTask(task("t-1", api.TaskUninstall, nil))
	h.start()
	select {
	case <-called:
	case <-time.After(10 * time.Second):
		t.Fatal("uninstaller not called")
	}
	select {
	case err := <-h.done:
		if !errors.Is(err, ErrUninstalled) {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return")
	}
	h.cancel = nil
}

func TestShutdownInterruptsBackupAndResumesLater(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP_SLEEP=30")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	// Wait until the run exists and restic is running.
	fakeserver.WaitFor(10*time.Second, func() bool { return len(h.srv.AllRuns()) == 1 && strings.Contains(h.commands(), "backup") })
	time.Sleep(100 * time.Millisecond)
	if err := h.stop(); err != nil {
		t.Fatal(err)
	}
	fin := h.srv.AllRuns()[0].Finish
	if fin == nil || fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "interrupted" {
		t.Fatalf("finish: %+v", fin)
	}
	st := h.status.Snapshot()
	if !st.Interrupted || st.ConsecutiveFailures != 0 || st.Current != nil || st.Service != "stopped" {
		t.Fatalf("an interrupted backup resumes, it is not a failure: %+v", st)
	}
}

func TestWedgedResticIsStoppedAfterMaxRunTime(t *testing.T) {
	old := maxRunTime
	maxRunTime = 400 * time.Millisecond
	t.Cleanup(func() { maxRunTime = old })
	h := newHarness(t)
	h.env("FAKE_BACKUP_SLEEP=60")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "timeout" {
		t.Fatalf("finish: %+v\n%s", fin, fin.LogTail)
	}
	st := h.statusAfterRun()
	if st.Interrupted || st.ConsecutiveFailures != 1 {
		t.Fatalf("a run that exceeded the limit is a failure, not an interruption: %+v", st)
	}
}

func TestCrashedRunIsReportedOnNextStart(t *testing.T) {
	h := newHarness(t)
	h.build()
	// Simulate a status file left by a killed process: a run was in progress.
	runID := h.srv.RegisterRun("backup")
	_ = h.status.Update(func(s *status.Status) {
		s.Current = &status.RunInfo{Kind: "backup", RunID: runID, StartedAt: time.Now().Add(-time.Hour)}
	})
	h.srv.Config.Schedule = api.Schedule{Kind: api.ScheduleDaily, TimeOfDay: "03:00", TimeZone: "UTC"}
	h.env("FAKE_BACKUP_SLEEP=30")
	h.build() // rebuild with the extra env; status file persists
	h.start()
	ok := fakeserver.WaitFor(10*time.Second, func() bool {
		r := h.srv.RunByID(runID)
		h.srv.Lock()
		defer h.srv.Unlock()
		return r != nil && r.Finish != nil
	})
	if !ok {
		t.Fatal("the orphaned run was not finished")
	}
	fin := h.srv.RunByID(runID).Finish
	if fin.Status != api.StatusFailed || fin.Errors[0].Code != "interrupted" {
		t.Fatalf("finish: %+v", fin)
	}
	// And the interrupted backup resumes on its own (a new run starts).
	if !fakeserver.WaitFor(10*time.Second, func() bool { return len(h.srv.AllRuns()) >= 2 }) {
		t.Fatal("interrupted backup did not resume")
	}
}

func TestUnreachableServerDuringRunKeepsReportAndResumes(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP_SLEEP=1", "FAKE_BACKUP=fail")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fakeserver.WaitFor(10*time.Second, func() bool { return len(h.srv.AllRuns()) == 1 })
	h.net.down.Store(true) // the connection drops while restic works
	// The report cannot be delivered; it must be stored.
	ok := fakeserver.WaitFor(20*time.Second, func() bool {
		entries, _ := os.ReadDir(h.layout.OutboxDir())
		return len(entries) == 1
	})
	if !ok {
		t.Fatal("run report was not stored in the outbox")
	}
	st := h.status.Snapshot()
	if !st.Interrupted || st.ConsecutiveFailures != 0 {
		t.Fatalf("a failure caused by a lost connection is an interruption: %+v", st)
	}
	h.net.down.Store(false)
	// The next heartbeat delivers the stored report.
	if !fakeserver.WaitFor(15*time.Second, func() bool {
		h.srv.Lock()
		defer h.srv.Unlock()
		r := h.srv.Runs["run-1"]
		return r != nil && r.Finish != nil
	}) {
		t.Fatal("stored report was not delivered after the connection came back")
	}
	// The agent removes the stored report once the server answered it, a moment after the server
	// recorded it.
	var entries []os.DirEntry
	fakeserver.WaitFor(10*time.Second, func() bool {
		entries, _ = os.ReadDir(h.layout.OutboxDir())
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "finish-") {
				return false
			}
		}
		return true
	})
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "finish-") {
			t.Fatalf("outbox not emptied: %v", entries)
		}
	}
}

func TestAuthFailureBacksOffAndDoesNotCrash(t *testing.T) {
	h := newHarness(t)
	h.srv.AgentSecret = "another-secret-value" // server no longer accepts the agent's secret
	h.build()
	h.srv.AgentSecret = "rsea_test_secret_0123456789"
	h.start()
	if !fakeserver.WaitFor(15*time.Second, func() bool {
		return strings.Contains(h.status.Snapshot().Heartbeat.Error, "revoked")
	}) {
		t.Fatalf("status must explain the rejection: %+v", h.status.Snapshot().Heartbeat)
	}
	time.Sleep(200 * time.Millisecond)
	if st := h.status.Snapshot(); st.Heartbeat.OK {
		t.Fatalf("heartbeat must not be OK: %+v", st.Heartbeat)
	}
	if h.srv.HeartbeatCount() != 0 {
		t.Fatal("no authenticated call should have succeeded")
	}
	if n := len(h.srv.AllRuns()); n != 0 {
		t.Fatalf("runs started with rejected credentials: %d", n)
	}
}

// Hooks the machine does not allow are not run: the backup runs without them,
// is partial and says why. The server cannot change the policy.
func TestHooksAreOffUnlessTheMachineAllowsThem(t *testing.T) {
	h := newHarness(t)
	marker := filepath.Join(h.dir, "hook-ran")
	h.srv.Config.Hooks = api.Hooks{Pre: "touch " + marker, Post: "touch " + marker}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fin := h.waitRun(1).Finish
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" {
		t.Fatalf("status %s %+v", fin.Status, fin.Errors)
	}
	if len(fin.Errors) != 2 || fin.Errors[0].Code != "hooks_not_allowed" || fin.Errors[1].Code != "hooks_not_allowed" ||
		!strings.Contains(fin.Errors[0].Message, "restow-agent hooks") {
		t.Fatalf("errors: %+v", fin.Errors)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a hook ran although hooks are off on this machine")
	}
	if strings.Contains(fin.LogTail, marker) {
		t.Fatal("the refused hook text must not be repeated in the log")
	}
	if !strings.Contains(h.commands(), "backup") {
		t.Fatal("the backup itself must still run")
	}
	// The heartbeat tells the server the machine's policy.
	h.srv.Lock()
	hb := h.srv.Heartbeats[len(h.srv.Heartbeats)-1]
	h.srv.Unlock()
	if hb.Hooks != hooks.ModeOff {
		t.Fatalf("heartbeat hooks = %q", hb.Hooks)
	}
}

// The policy is read from state.json at each backup, so a local change needs no restart.
func TestHooksPolicyFollowsTheStateFile(t *testing.T) {
	h := newHarness(t)
	marker := filepath.Join(h.dir, "hook-ran")
	h.srv.Config.Hooks = api.Hooks{Pre: "touch " + marker}
	h.build()
	st := *h.agent.d.State
	st.Hooks = hooks.ModeAny
	if err := st.Save(h.layout.StateFile()); err != nil {
		t.Fatal(err)
	}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	if fin := h.waitRun(1).Finish; fin.Status != api.StatusSucceeded {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("hook allowed in state.json did not run")
	}
}

func TestSelfUpdateRequestsRestart(t *testing.T) {
	h := newHarness(t)
	old := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = old })
	h.binDir = trustedDir(t)
	h.exe = filepath.Join(h.binDir, "restow-agent")
	if err := os.WriteFile(h.exe, []byte("#!/bin/sh\necho restow-agent 0.1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	h.updateKey = release.NewPublicKey(pub, "test")
	target := runtime.GOOS + "-" + runtime.GOARCH
	next := []byte("#!/bin/sh\necho \"restow-agent 0.2.0\"\n")
	h.srv.SetRelease("0.2.0", map[string][]byte{target + "/restow-agent": next, target + "/restic": []byte("restic")}, priv)
	h.srv.SetUpdate("0.2.0", target, next)
	h.build()
	h.agent.o.SelfUpdate = true
	h.agent.nextUpdateCheck = time.Time{}
	h.agent.o.UpdateInterval = time.Hour
	// The first check is scheduled one minute after start; shorten by preloading.
	h.startWithUpdateCheckNow()
	select {
	case err := <-h.done:
		if !errors.Is(err, ErrRestart) {
			t.Fatalf("Run returned %v, want ErrRestart", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no restart after the update")
	}
	h.cancel = nil
	b, _ := os.ReadFile(h.exe)
	if !strings.Contains(string(b), "0.2.0") {
		t.Fatalf("binary not replaced: %s", b)
	}
}

// trustedDir is a folder no other user can change (the self-update refuses anything else).
func trustedDir(t *testing.T) string {
	t.Helper()
	parent := "/root"
	if os.Geteuid() != 0 {
		wd, _ := os.Getwd()
		if _, err := paths.TrustedDir(wd, false); err != nil {
			t.Skipf("no trusted folder: %v", err)
		}
		parent = wd
	}
	dir, err := os.MkdirTemp(parent, "bin-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	_ = os.Chmod(dir, 0o755)
	return dir
}

func (h *harness) startWithUpdateCheckNow() {
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	h.agent.testUpdateCheckAfterStart = true
	go func() { h.done <- h.agent.Run(ctx) }()
	h.t.Cleanup(func() { h.stop() })
}

func TestBackupNowHoldsTheRunLock(t *testing.T) {
	h := newHarness(t)
	h.build()
	h.agent.o.HeartbeatInterval = time.Hour
	out, err := h.agent.BackupNow(context.Background())
	if err != nil || out.Status != api.StatusSucceeded || out.SnapshotID == "" {
		t.Fatalf("BackupNow: %+v %v", out, err)
	}
	runs := h.srv.AllRuns()
	if len(runs) != 1 || runs[0].Finish == nil || runs[0].Start.Kind != "backup" {
		t.Fatalf("server view: %+v", runs)
	}
	// While another process holds the lock, BackupNow refuses to run.
	other := newLockHolder(t, h.layout.LockFile())
	defer other()
	if _, err := h.agent.BackupNow(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
}

func TestHelpers(t *testing.T) {
	if got := kbpsToKiB(8000); got != 977 {
		t.Errorf("kbpsToKiB(8000) = %d", got)
	}
	if got := kbpsToKiB(1); got != 1 {
		t.Errorf("kbpsToKiB(1) = %d", got)
	}
	if kbpsToKiB(0) != 0 || kbpsToKiB(-5) != 0 {
		t.Error("non-positive limits mean unlimited")
	}
	for in, want := range map[uint64]string{0: "0 B", 1023: "1023 B", 1024: "1.0 KiB", 5 << 20: "5.0 MiB", 3 << 30: "3.0 GiB"} {
		if got := formatBytes(in); got != want {
			t.Errorf("formatBytes(%d) = %q, want %q", in, got, want)
		}
	}
	errs := make([]api.RunError, 250)
	if got := capErrors(errs, 0); len(got) != maxReportedErrors || got[len(got)-1].Code != "truncated" ||
		!strings.HasPrefix(got[len(got)-1].Message, "151 more errors") {
		t.Errorf("capErrors: %d entries, last %+v", len(got), got[len(got)-1])
	}
	// restic's errors beyond the hundred it keeps are counted in the last entry.
	if got := capErrors(make([]api.RunError, 100), 30); len(got) != maxReportedErrors ||
		!strings.HasPrefix(got[len(got)-1].Message, "31 more errors") {
		t.Errorf("capErrors with unlisted: %d entries, last %+v", len(got), got[len(got)-1])
	}
	if got := capErrors(make([]api.RunError, 3), 2); len(got) != 4 || !strings.HasPrefix(got[3].Message, "2 more errors") {
		t.Errorf("capErrors of a few with unlisted: %+v", got)
	}
	if got := capErrors(make([]api.RunError, 3), 0); len(got) != 3 {
		t.Errorf("capErrors under the limit: %+v", got)
	}
	// Each entry fits what the server accepts; the cause at the end of restic's message stays.
	deep := "/" + strings.Repeat("d", 5000)
	got := capErrors([]api.RunError{{Path: deep, Message: "lstat " + deep + ": file name too long", Code: "scan"}}, 0)
	if len(got) != 1 || len(got[0].Path) > maxRunErrorPathBytes || len(got[0].Message) > maxRunErrorMessageBytes ||
		!strings.HasPrefix(got[0].Path, "/ddd") || !strings.HasSuffix(got[0].Message, "dd: file name too long") ||
		got[0].Code != "scan" {
		t.Errorf("bounded entry: path %d bytes, message %q, code %q", len(got[0].Path), got[0].Message, got[0].Code)
	}
	if m := shortenMiddle(strings.Repeat("ä", 3000), 1000); len(m) > 1000 || !utf8.ValidString(m) || !strings.Contains(m, " ... ") {
		t.Errorf("shortenMiddle cut a character: %d bytes, valid %v", len(m), utf8.ValidString(m))
	}
	if shortenMiddle("short", 1000) != "short" {
		t.Error("shortenMiddle changed a short text")
	}
	// Canonical: restore targets are resolved (macOS: the temp folder is below the link /var).
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	existing, missing, _ := splitSources([]string{dir, dir, "relative/path", "/nope/nope", ""})
	if len(existing) != 1 || len(missing) != 2 {
		t.Errorf("splitSources: %v %v", existing, missing)
	}
	linkDir := t.TempDir()
	real := filepath.Join(linkDir, "real")
	_ = os.MkdirAll(real, 0o755)
	link := filepath.Join(linkDir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	existing, _, resolved := splitSources([]string{link, real})
	want, _ := filepath.EvalSymlinks(real)
	if len(existing) != 1 || existing[0] != want || len(resolved) != 1 || resolved[0].Configured != link {
		t.Errorf("a symbolic link source must be replaced by its target once: %v %v", existing, resolved)
	}
	codeOf := func(err error) string {
		var te *targetError
		if errors.As(err, &te) {
			return te.code
		}
		return ""
	}
	if got, err := prepareRestoreTarget(filepath.Join(dir, "new")); err != nil || got != filepath.Join(dir, "new") {
		t.Errorf("new folder must be accepted: %q %v", got, err)
	} else if st, _ := os.Stat(got); !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Errorf("the new folder is created for root only: %v", st.Mode())
	}
	empty := filepath.Join(dir, "empty")
	_ = os.Mkdir(empty, 0o755)
	if _, err := prepareRestoreTarget(empty); err != nil {
		t.Errorf("empty existing folder must be accepted: %v", err)
	}
	_ = os.WriteFile(filepath.Join(dir, "f"), nil, 0o644)
	if _, err := prepareRestoreTarget(dir); codeOf(err) != "target_not_empty" {
		t.Errorf("non-empty folder must be refused: %v", err)
	}
	if _, err := prepareRestoreTarget(filepath.Join(dir, "f")); codeOf(err) != "target_not_empty" {
		t.Errorf("existing file must be refused: %v", err)
	}
	// A link at the target is never followed.
	_ = os.Symlink(empty, filepath.Join(dir, "link-target"))
	if _, err := prepareRestoreTarget(filepath.Join(dir, "link-target")); codeOf(err) != "target_not_empty" {
		t.Errorf("link as target: %v", err)
	}
	for _, bad := range []string{"/", "relative", dir + "/../etc", dir + "/./x", dir + "//x", dir + "/x/", dir + "/a\x00b"} {
		if _, err := prepareRestoreTarget(bad); codeOf(err) != "invalid_task" {
			t.Errorf("%q must be refused as invalid: %v", bad, err)
		}
	}
	if _, err := prepareRestoreTarget(filepath.Join(dir, "missing", "x")); codeOf(err) != "target_unusable" {
		t.Errorf("missing parent: %v", err)
	}
	// A parent other users can write to (without the sticky bit) could be used to redirect the restore.
	open := filepath.Join(dir, "open")
	_ = os.Mkdir(open, 0o755)
	_ = os.Chmod(open, 0o777)
	if _, err := prepareRestoreTarget(filepath.Join(open, "x")); codeOf(err) != "target_unusable" {
		t.Errorf("world-writable parent: %v", err)
	}
	_ = os.Chmod(open, 0o777|os.ModeSticky)
	if _, err := prepareRestoreTarget(filepath.Join(open, "x")); err != nil {
		t.Errorf("sticky parent like /tmp: %v", err)
	}
	// ... but an existing empty target others can write to is not.
	open2 := filepath.Join(dir, "open2")
	_ = os.Mkdir(open2, 0o755)
	_ = os.Chmod(open2, 0o777|os.ModeSticky)
	if _, err := prepareRestoreTarget(open2); codeOf(err) != "target_unusable" {
		t.Errorf("world-writable empty target: %v", err)
	}
	// A link in the parent chain resolves to where restic actually writes.
	_ = os.Symlink(empty, filepath.Join(dir, "via"))
	if got, err := prepareRestoreTarget(filepath.Join(dir, "via", "restored")); err != nil || got != filepath.Join(empty, "restored") {
		t.Errorf("link in the parent: %q %v", got, err)
	}
	if os.Geteuid() == 0 {
		foreign := filepath.Join(dir, "foreign")
		_ = os.Mkdir(foreign, 0o755)
		_ = os.Chown(foreign, 65534, 65534)
		if _, err := prepareRestoreTarget(filepath.Join(foreign, "x")); codeOf(err) != "target_unusable" {
			t.Errorf("parent owned by another user: %v", err)
		}
		if _, err := prepareRestoreTarget(foreign); codeOf(err) != "target_unusable" {
			t.Errorf("empty target owned by another user: %v", err)
		}
		if got := defaultRestoreDir([]string{foreign, dir}, time.Date(2026, 9, 30, 22, 5, 9, 0, time.UTC)); got != filepath.Join(dir, "Restow-Restore-20260930-220509") {
			t.Errorf("a root owned by another user is skipped: %s", got)
		}
	}
	if got := defaultRestoreDir([]string{"/nope", dir}, time.Date(2026, 9, 30, 22, 5, 9, 0, time.UTC)); got != filepath.Join(dir, "Restow-Restore-20260930-220509") {
		t.Errorf("defaultRestoreDir = %s", got)
	}
}
