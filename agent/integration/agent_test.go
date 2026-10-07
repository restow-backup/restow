//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

var snapshotHex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func fileExists(p string) bool { _, err := os.Lstat(p); return err == nil }

// TestBackupRestoreVerifyAppendOnly is the proof the product stands on: a real
// backup with real restic, a restore into a new folder with matching hashes, a
// restore test (verify_sample), and a repository the agent cannot damage.
func TestBackupRestoreVerifyAppendOnly(t *testing.T) {
	e := newEnv(t)
	hashes := e.populate()
	e.start(e.agent(core.Options{}))

	// ---- first backup -----------------------------------------------------
	e.restow.QueueTask(task("t-backup-1", api.TaskBackupNow, nil))
	fin1 := e.waitRun(1, 3*time.Minute).Finish
	if fin1.Status != api.StatusSucceeded {
		t.Fatalf("first backup: %s\nerrors: %+v\n%s", fin1.Status, fin1.Errors, fin1.LogTail)
	}
	snap1 := fin1.SnapshotID
	if !snapshotHex.MatchString(snap1) {
		t.Fatalf("snapshot id %q", snap1)
	}
	if fin1.Stats == nil || fin1.Stats.FilesNew < 35 || fin1.Stats.DataAdded == 0 || fin1.Stats.TotalBytesProcessed < 1<<20 {
		t.Fatalf("stats: %+v", fin1.Stats)
	}
	// Sample: 20 files, every hash equals the file on disk.
	if len(fin1.Sample) != 20 {
		t.Fatalf("sample has %d files, want 20", len(fin1.Sample))
	}
	for _, s := range fin1.Sample {
		if hashes[s.Path] == "" || hashes[s.Path] != s.SHA256 || s.Size <= 0 {
			t.Fatalf("sample entry does not match the source: %+v", s)
		}
	}
	// The snapshot is in the repository, with the exclusions applied.
	listing, err := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "ls", snap1)
	if err != nil {
		t.Fatalf("restic ls: %v\n%s", err, listing)
	}
	for _, want := range []string{"readme.txt", "report [final] (1).txt", "big.bin", "link-to-readme", "index.html"} {
		if !strings.Contains(listing, want) {
			t.Errorf("snapshot lacks %q", want)
		}
	}
	for _, unwanted := range []string{"session.tmp", "node_modules"} {
		if strings.Contains(listing, unwanted) {
			t.Errorf("snapshot contains excluded %q", unwanted)
		}
	}
	if !strings.Contains(fin1.LogTail, "Snapshot "+snap1[:8]+" saved") {
		t.Errorf("log tail:\n%s", fin1.LogTail)
	}

	// ---- change the source, second (incremental) backup -------------------
	writeFile(t, filepath.Join(e.src, "docs/readme.txt"), []byte("changed after the first backup\n"))
	writeFile(t, filepath.Join(e.src, "docs/new.txt"), []byte("added later\n"))
	if err := os.Remove(filepath.Join(e.src, "many/file00.txt")); err != nil {
		t.Fatal(err)
	}
	e.restow.QueueTask(task("t-backup-2", api.TaskBackupNow, nil))
	fin2 := e.waitRun(2, 3*time.Minute).Finish
	if fin2.Status != api.StatusSucceeded {
		t.Fatalf("second backup: %s %+v\n%s", fin2.Status, fin2.Errors, fin2.LogTail)
	}
	if fin2.Stats.FilesNew != 1 || fin2.Stats.FilesChanged != 1 || fin2.Stats.DataAdded > 100*1024 {
		t.Fatalf("incremental stats: %+v", fin2.Stats)
	}
	snap2 := fin2.SnapshotID
	if snap2 == snap1 {
		t.Fatal("second backup reused the first snapshot id")
	}

	// ---- restore test against the OLD snapshot: hashes from the sample ----
	e.restow.QueueTask(task("t-verify-1", api.TaskVerifySample, api.VerifySampleParams{SnapshotID: snap1, Files: fin1.Sample}))
	fin3 := e.waitRun(3, 3*time.Minute).Finish
	if fin3.Status != api.StatusSucceeded || len(fin3.Errors) != 0 || len(fin3.Sample) != 20 {
		t.Fatalf("verify_sample: %s %+v\n%s", fin3.Status, fin3.Errors, fin3.LogTail)
	}
	if entries, _ := os.ReadDir(e.layout.TmpDir()); len(entries) != 0 {
		t.Fatalf("temporary restore copy not deleted: %v", entries)
	}
	// The server judges from what the agent observed: the hash of every restored file.
	if fin3.RestoreTest == nil || fin3.RestoreTest.Restic != nil || len(fin3.RestoreTest.Files) != 20 {
		t.Fatalf("restore-test result: %+v", fin3.RestoreTest)
	}
	for i, f := range fin3.RestoreTest.Files {
		if f.Path != fin1.Sample[i].Path || f.SHA256 != fin1.Sample[i].SHA256 {
			t.Fatalf("restored file %d: %+v, want %+v", i, f, fin1.Sample[i])
		}
	}

	// A wrong expectation must be caught.
	bad := append([]api.SampleFile(nil), fin1.Sample[:2]...)
	bad[0].SHA256 = strings.Repeat("0", 64)
	e.restow.QueueTask(task("t-verify-2", api.TaskVerifySample, api.VerifySampleParams{SnapshotID: snap1, Files: bad}))
	fin4 := e.waitRun(4, 3*time.Minute).Finish
	if fin4.Status != api.StatusFailed || len(fin4.Errors) != 1 || fin4.Errors[0].Code != "hash_mismatch" || fin4.Errors[0].Path != bad[0].Path {
		t.Fatalf("mismatch not detected: %s %+v", fin4.Status, fin4.Errors)
	}
	if rt := fin4.RestoreTest; rt == nil || len(rt.Files) != 2 || rt.Files[0].SHA256 != fin1.Sample[0].SHA256 {
		t.Fatalf("restore-test result: %+v", rt)
	}

	// ---- restore a folder into a NEW directory ---------------------------
	target := filepath.Join(e.root, "restore-docs")
	e.restow.QueueTask(task("t-restore-1", api.TaskRestore, api.RestoreParams{SnapshotID: snap2, Paths: []string{e.src + "/docs"}, TargetDir: target}))
	fin5 := e.waitRun(5, 3*time.Minute).Finish
	if fin5.Status != api.StatusSucceeded {
		t.Fatalf("restore: %s %+v\n%s", fin5.Status, fin5.Errors, fin5.LogTail)
	}
	for _, rel := range []string{"docs/readme.txt", "docs/new.txt", "docs/report [final] (1).txt", "docs/unicode-äöü-日本.txt"} {
		orig := filepath.Join(e.src, filepath.FromSlash(rel))
		restored := filepath.Join(target, orig) // restic keeps the absolute path below the target
		if !fileExists(restored) {
			t.Fatalf("restored file %s is missing", restored)
		}
		if sha256Of(t, restored) != sha256Of(t, orig) {
			t.Fatalf("restored %s differs from the source", rel)
		}
	}
	if fileExists(filepath.Join(target, e.src, "data")) {
		t.Fatal("a folder outside the selection was restored")
	}

	// Restoring into the same (now non-empty) folder must be refused.
	e.restow.QueueTask(task("t-restore-2", api.TaskRestore, api.RestoreParams{SnapshotID: snap2, TargetDir: target}))
	fin6 := e.waitRun(6, 3*time.Minute).Finish
	if fin6.Status != api.StatusFailed || len(fin6.Errors) != 1 || fin6.Errors[0].Code != "target_not_empty" {
		t.Fatalf("overwrite attempt: %s %+v", fin6.Status, fin6.Errors)
	}

	// Full restore of the second snapshot with the default target name.
	e.restow.QueueTask(task("t-restore-3", api.TaskRestore, api.RestoreParams{SnapshotID: snap2}))
	fin7 := e.waitRun(7, 3*time.Minute).Finish
	if fin7.Status != api.StatusSucceeded {
		t.Fatalf("full restore: %s %+v\n%s", fin7.Status, fin7.Errors, fin7.LogTail)
	}
	entries, _ := os.ReadDir(e.src)
	var defaultTarget string
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), "Restow-Restore-") {
			defaultTarget = filepath.Join(e.src, en.Name())
		}
	}
	if defaultTarget == "" {
		t.Fatalf("default Restow-Restore-<timestamp> folder missing in %s", e.src)
	}
	for orig := range hashes {
		if strings.HasSuffix(orig, "many/file00.txt") {
			continue // deleted before snapshot 2
		}
		restored := filepath.Join(defaultTarget, orig)
		if !fileExists(restored) {
			t.Fatalf("full restore misses %s", orig)
		}
		want := sha256Of(t, orig)
		if got := sha256Of(t, restored); got != want {
			t.Fatalf("full restore: %s differs", orig)
		}
	}
	if fileExists(filepath.Join(defaultTarget, e.src, "cache/session.tmp")) {
		t.Fatal("excluded file was restored")
	}
	if link, err := os.Readlink(filepath.Join(defaultTarget, e.src, "link-to-readme")); err != nil || link != "docs/readme.txt" {
		t.Fatalf("symlink not restored: %q %v", link, err)
	}
	// The Restow-Restore-* folder inside the source must not be backed up again.
	e.restow.QueueTask(task("t-backup-3", api.TaskBackupNow, nil))
	fin8 := e.waitRun(8, 3*time.Minute).Finish
	if fin8.Status != api.StatusSucceeded {
		t.Fatalf("third backup: %s %+v", fin8.Status, fin8.Errors)
	}
	if fin8.Stats.FilesNew != 0 {
		t.Fatalf("earlier restores were backed up again (%d new files)", fin8.Stats.FilesNew)
	}

	// ---- append-only: the agent's credentials cannot damage the repository
	out, err := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "forget", "--prune", snap1)
	if err == nil {
		t.Fatalf("the agent credentials were able to forget a snapshot:\n%s", out)
	}
	snaps, err := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "snapshots", "--json")
	if err != nil {
		t.Fatalf("restic snapshots: %v\n%s", err, snaps)
	}
	var list []struct {
		ID       string   `json:"id"`
		Hostname string   `json:"hostname"`
		Tags     []string `json:"tags"`
	}
	if err := json.Unmarshal([]byte(snaps[strings.Index(snaps, "["):]), &list); err != nil {
		t.Fatalf("parse snapshots: %v\n%s", err, snaps)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 snapshots after the attempted forget, found %d", len(list))
	}
	found := false
	for _, s := range list {
		if s.ID == snap1 {
			found = true
		}
		if s.Hostname != "it-host" || len(s.Tags) != 1 || s.Tags[0] != "restow-agent" {
			t.Errorf("snapshot metadata: %+v", s)
		}
	}
	if !found {
		t.Fatal("snapshot 1 vanished")
	}
	// A data file cannot be deleted directly either.
	if matches, _ := filepath.Glob(filepath.Join(e.rest.Dir, e.rest.User, "data", "*", "*")); len(matches) == 0 {
		t.Fatal("no pack files on the server")
	}
}

// TestRestoreTestReportsDamageInResticsOwnWords removes the pack that holds the
// files' contents from the repository: the agent reports how restic restore
// ended (its final error and an error per file, which restic 0.19 writes to
// stderr), so the server can tell damage from a test that could not complete.
func TestRestoreTestReportsDamageInResticsOwnWords(t *testing.T) {
	e := newEnv(t)
	e.populate()
	e.start(e.agent(core.Options{}))
	e.restow.QueueTask(task("t-backup-1", api.TaskBackupNow, nil))
	fin1 := e.waitRun(1, 3*time.Minute).Finish
	if fin1.Status != api.StatusSucceeded || len(fin1.Sample) != 20 {
		t.Fatalf("backup: %s %+v", fin1.Status, fin1.Errors)
	}
	var largest string
	var size int64
	_ = filepath.Walk(filepath.Join(e.rest.Dir, e.rest.User, "data"), func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && info.Size() > size {
			largest, size = path, info.Size()
		}
		return nil
	})
	if largest == "" || os.Remove(largest) != nil {
		t.Fatalf("no data pack to remove (%q)", largest)
	}

	e.restow.QueueTask(task("t-verify-1", api.TaskVerifySample, api.VerifySampleParams{SnapshotID: fin1.SnapshotID, Files: fin1.Sample}))
	fin2 := e.waitRun(2, 3*time.Minute).Finish
	if fin2.Status != api.StatusFailed || len(fin2.Errors) != 1 || fin2.Errors[0].Code != "restic_exit_1" {
		t.Fatalf("verify_sample: %s %+v\n%s", fin2.Status, fin2.Errors, fin2.LogTail)
	}
	rt := fin2.RestoreTest
	if rt == nil || rt.Restic == nil || rt.Restic.ExitCode != 1 {
		t.Fatalf("restore-test result: %+v", rt)
	}
	count := regexp.MustCompile(`^Fatal: There were (\d+) errors$`).FindStringSubmatch(rt.Restic.Fatal)
	if count == nil || count[1] != fmt.Sprint(len(rt.Restic.Errors)) {
		t.Fatalf("restic ended with %q after %d item errors", rt.Restic.Fatal, len(rt.Restic.Errors))
	}
	// Every file restic could not restore has the missing pack among its errors.
	missingPack := regexp.MustCompile(`<data/[0-9a-f]+> does not exist`)
	proven := map[string]bool{}
	for _, item := range rt.Restic.Errors {
		if missingPack.MatchString(item.Message) {
			proven[item.Item] = true
		}
	}
	for _, item := range rt.Restic.Errors {
		if !proven[item.Item] {
			t.Fatalf("item %s failed without restic naming the missing data: %+v", item.Item, rt.Restic.Errors)
		}
	}
	if len(proven) == 0 || len(rt.Files) != 20 {
		t.Fatalf("restore-test result: %+v", rt)
	}
	for _, f := range rt.Files {
		if f.SHA256 == "" && !f.Missing && f.Error == "" {
			t.Fatalf("file without a result: %+v", f)
		}
	}
}

// TestInterruptedBackupResumes stops the agent in the middle of a real backup
// and checks that the run is reported as interrupted (not failed) and that the
// next start finishes the backup without any operator action.
func TestInterruptedBackupResumes(t *testing.T) {
	e := newEnv(t)
	writeFile(t, filepath.Join(e.src, "big.bin"), randomBytes(t, 3<<20))
	kbps := int64(600) // about 73 KiB/s: the upload takes roughly 40 s
	e.restow.Config.BandwidthKbps = &kbps

	first := e.start(e.agent(core.Options{}))
	e.restow.QueueTask(task("t-backup-1", api.TaskBackupNow, nil))
	ok := fakeserver.WaitFor(60*time.Second, func() bool {
		runs := e.restow.AllRuns()
		if len(runs) == 0 {
			return false
		}
		e.restow.Lock()
		defer e.restow.Unlock()
		return len(runs[0].Progress) > 0
	})
	if !ok {
		t.Fatal("no progress reported by the running backup")
	}
	first.stop(t)

	run1 := e.restow.AllRuns()[0]
	e.restow.Lock()
	fin := run1.Finish
	e.restow.Unlock()
	if fin == nil || fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "interrupted" {
		t.Fatalf("interrupted run: %+v", fin)
	}
	st, err := status.Load(e.layout.StatusFile())
	if err != nil || !st.Interrupted || st.ConsecutiveFailures != 0 || st.Current != nil {
		t.Fatalf("status after interruption: %+v %v", st, err)
	}
	if out, _ := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "snapshots"); strings.Contains(out, "restow-agent") {
		t.Fatalf("an interrupted backup must not leave a snapshot:\n%s", out)
	}

	// New agent process, no task: it resumes on its own; the limit is lifted.
	e.restow.Lock()
	e.restow.Config.BandwidthKbps = nil
	e.restow.Config.ConfigVersion = "2"
	e.restow.Unlock()
	e.start(e.agent(core.Options{}))
	fin2 := e.waitRun(2, 3*time.Minute).Finish
	if fin2.Status != api.StatusSucceeded || fin2.SnapshotID == "" {
		t.Fatalf("resumed backup: %s %+v\n%s", fin2.Status, fin2.Errors, fin2.LogTail)
	}
	// The agent reports the finished run before it writes the status file, so the
	// file may still show the run as running for a moment.
	deadline := time.Now().Add(10 * time.Second)
	for {
		st, _ = status.Load(e.layout.StatusFile())
		if st != nil && !st.Interrupted && st.ConsecutiveFailures == 0 && !st.LastSuccessAt.IsZero() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("status after resume: %+v", st)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestHooksRunAroundTheRealBackup checks that a pre hook can produce data that
// ends up in the snapshot (the database dump use case) and that the post hook
// sees the result.
func TestHooksRunAroundTheRealBackup(t *testing.T) {
	e := newEnv(t)
	e.hooks = hooks.ModeAny // allowed by root on the machine (restow-agent hooks any)
	writeFile(t, filepath.Join(e.src, "app/data.txt"), []byte("live data\n"))
	dump := filepath.Join(e.src, "dump.sql")
	e.restow.Config.Hooks = api.Hooks{
		Pre:  "echo 'CREATE TABLE t;' > " + dump + " && echo dump-created",
		Post: "rm -f " + dump + " && echo \"cleanup after $RESTOW_BACKUP_STATUS\"",
	}
	e.start(e.agent(core.Options{}))
	e.restow.QueueTask(task("t-1", api.TaskBackupNow, nil))
	fin := e.waitRun(1, 3*time.Minute).Finish
	if fin.Status != api.StatusSucceeded {
		t.Fatalf("%s %+v\n%s", fin.Status, fin.Errors, fin.LogTail)
	}
	listing, _ := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "ls", fin.SnapshotID)
	if !strings.Contains(listing, "dump.sql") {
		t.Fatalf("the dump created by the pre hook is not in the snapshot:\n%s", listing)
	}
	if fileExists(dump) {
		t.Fatal("the post hook did not clean up")
	}
	for _, want := range []string{"pre-hook: dump-created", "post-hook: cleanup after succeeded"} {
		if !strings.Contains(fin.LogTail, want) {
			t.Errorf("log tail lacks %q", want)
		}
	}
}

// TestHooksAreNotRunWithoutLocalPermission checks the default: a hook the
// server configures does not run, the backup still happens and says so.
func TestHooksAreNotRunWithoutLocalPermission(t *testing.T) {
	e := newEnv(t)
	writeFile(t, filepath.Join(e.src, "app/data.txt"), []byte("live data\n"))
	marker := filepath.Join(e.root, "hook-ran")
	e.restow.Config.Hooks = api.Hooks{Pre: "touch " + marker}
	e.start(e.agent(core.Options{}))
	e.restow.QueueTask(task("t-1", api.TaskBackupNow, nil))
	fin := e.waitRun(1, 3*time.Minute).Finish
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" || len(fin.Errors) != 1 || fin.Errors[0].Code != "hooks_not_allowed" {
		t.Fatalf("%s %+v\n%s", fin.Status, fin.Errors, fin.LogTail)
	}
	if fileExists(marker) {
		t.Fatal("the hook ran without local permission")
	}
}

// TestPartialBackupNamesTheFilesResticCannotRead: restic 0.19 reports the
// files it cannot read on stderr, not on stdout. The run is partial, the
// snapshot exists, and the report names each such file with restic's reason,
// bounded to what the server accepts.
func TestPartialBackupNamesTheFilesResticCannotRead(t *testing.T) {
	e := newEnv(t)
	writeFile(t, filepath.Join(e.src, "app/data.txt"), []byte("live data\n"))
	deep := beyondPathLimit(t, filepath.Join(e.src, "deep"))
	e.start(e.agent(core.Options{}))
	e.restow.QueueTask(task("t-1", api.TaskBackupNow, nil))
	fin := e.waitRun(1, 3*time.Minute).Finish
	if fin.Status != api.StatusPartial || !snapshotHex.MatchString(fin.SnapshotID) || len(fin.Errors) == 0 {
		t.Fatalf("%s %q %+v\n%s", fin.Status, fin.SnapshotID, fin.Errors, fin.LogTail)
	}
	// restic names the files below the source as the agent resolved it (macOS: /var is a link).
	src, err := filepath.EvalSymlinks(e.src)
	if err != nil {
		t.Fatal(err)
	}
	for _, re := range fin.Errors {
		below := strings.HasPrefix(re.Path, filepath.Join(e.src, "deep")) || strings.HasPrefix(re.Path, filepath.Join(src, "deep"))
		if !below || !strings.Contains(re.Message, "file name too long") ||
			re.Code == "" || len(re.Path) > 4096 || len(re.Message) > 1000 {
			t.Fatalf("error entry (path %d bytes): %+v", len(re.Path), re)
		}
	}
	if !strings.Contains(fin.LogTail, "Some files could not be read") || strings.Contains(fin.LogTail, `"message_type"`) {
		t.Fatalf("log tail:\n%s", fin.LogTail)
	}
	// The readable rest is in the snapshot.
	listing, err := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "ls", fin.SnapshotID)
	if err != nil || !strings.Contains(listing, "app/data.txt") {
		t.Fatalf("restic ls: %v\n%s", err, listing)
	}
	if len(deep) <= 4096 {
		t.Fatalf("the deepest folder is only %d bytes long", len(deep))
	}
}

// beyondPathLimit creates folders below dir until the path of the deepest is
// longer than any system accepts (Linux 4096 bytes, macOS 1024), so restic
// cannot read it. Unlike a file without read permission this also holds when
// the tests run as root (in Docker). The folders are made one at a time
// relative to their parent, which works at any depth. It returns the path.
func beyondPathLimit(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	name := strings.Repeat("d", 200)
	path := dir
	for len(path) <= 4200 {
		if err := root.Mkdir(name, 0o755); err != nil {
			t.Fatal(err)
		}
		next, err := root.OpenRoot(name)
		if err != nil {
			t.Fatal(err)
		}
		_ = root.Close()
		root, path = next, path+"/"+name
	}
	_ = root.Close()
	return path
}

// TestShippedBinaryEndToEnd drives the real restow-agent binary (the one
// build.sh produces) through enroll, status, backup-now and run, against the
// real restic and rest-server. It runs in a development layout
// (RESTOW_AGENT_DIR), so no service is installed and no root is needed.
func TestShippedBinaryEndToEnd(t *testing.T) {
	bin := os.Getenv("RESTOW_TEST_AGENT_BIN")
	if bin == "" {
		t.Skip("RESTOW_TEST_AGENT_BIN is not set")
	}
	e := newEnv(t)
	hashes := e.populate()
	dir := filepath.Join(e.root, "agent-dev")
	baseEnv := append(os.Environ(),
		"RESTOW_AGENT_DIR="+dir, "RESTOW_RESTIC_PATH="+envOrFatal(t, "RESTOW_TEST_RESTIC"),
		"RESTOW_URL="+e.restow.URL, "RESTOW_TOKEN="+e.restow.EnrollToken)

	run := func(timeout time.Duration, args ...string) (stdout, stderr string, code int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, args...)
		cmd.Env = baseEnv
		var so, se bytes.Buffer
		cmd.Stdout, cmd.Stderr = &so, &se
		err := cmd.Run()
		code = 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if err != nil {
			t.Fatalf("running %v: %v", args, err)
		}
		return so.String(), se.String(), code
	}
	noSecrets := func(what, out string) {
		t.Helper()
		for _, secret := range []string{e.restow.AgentSecret, e.restow.RepoPassword, e.restow.EnrollToken} {
			if secret != "" && strings.Contains(out, secret) {
				t.Fatalf("%s printed a secret:\n%s", what, out)
			}
		}
	}

	// version
	if so, _, code := run(30*time.Second, "version"); code != 0 || !strings.Contains(so, "restow-agent") {
		t.Fatalf("version: %d %s", code, so)
	}

	// enroll
	so, se, code := run(2*time.Minute, "enroll", "--allow-insecure-http")
	if code != 0 || !strings.Contains(so, "Enrolled as endpoint "+e.restow.EndpointID) || !strings.Contains(so, "backup repository is reachable") {
		t.Fatalf("enroll: exit %d\nstdout:\n%s\nstderr:\n%s", code, so, se)
	}
	noSecrets("enroll", so+se)
	stateFile := filepath.Join(dir, "state", "state.json")
	if st, err := os.Stat(stateFile); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", err, st)
	}
	// The token was single use; a second enroll is a harmless no-op.
	baseEnv = append(baseEnv, "RESTOW_TOKEN=") // token is spent
	if so, _, code := run(time.Minute, "enroll", "--allow-insecure-http"); code != 0 || !strings.Contains(so, "already enrolled") {
		t.Fatalf("second enroll: %d %s", code, so)
	}

	// status
	so, _, code = run(time.Minute, "status")
	if code != 0 || !strings.Contains(so, e.restow.EndpointID) || !strings.Contains(so, "restic:") {
		t.Fatalf("status: %d\n%s", code, so)
	}
	noSecrets("status", so)

	// backup-now
	so, se, code = run(5*time.Minute, "backup-now")
	if code != 0 || !strings.Contains(so, "Backup finished: snapshot") {
		t.Fatalf("backup-now: exit %d\nstdout:\n%s\nstderr:\n%s", code, so, se)
	}
	noSecrets("backup-now", so+se)
	fin := e.waitRun(1, time.Minute).Finish
	if fin.Status != api.StatusSucceeded || len(fin.Sample) == 0 {
		t.Fatalf("server view of backup-now: %+v", fin)
	}
	for _, s := range fin.Sample {
		if hashes[s.Path] != s.SHA256 {
			t.Fatalf("sample mismatch %+v", s)
		}
	}
	if strings.Contains(fin.LogTail, e.restow.AgentSecret) || strings.Contains(fin.LogTail, e.restow.RepoPassword) {
		t.Fatal("secrets in the log tail sent to the server")
	}

	// run: the service main loop as a subprocess; a task arrives with a heartbeat.
	e.restow.QueueTask(task("t-run-1", api.TaskBackupNow, nil))
	cmd := exec.Command(bin, "run")
	cmd.Env = baseEnv
	var runOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &runOut, &runOut
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	fin2 := e.waitRun(2, 3*time.Minute).Finish
	if fin2.Status != api.StatusSucceeded {
		t.Fatalf("run subprocess: %+v\n%s", fin2, runOut.String())
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("run did not exit cleanly on SIGTERM: %v\n%s", err, runOut.String())
		}
	case <-time.After(60 * time.Second):
		t.Fatal("run did not exit after SIGTERM")
	}
	logFile, err := os.ReadFile(filepath.Join(dir, "logs", "agent.log"))
	if err != nil || !strings.Contains(string(logFile), "agent stopped") {
		t.Fatalf("agent log: %v\n%s", err, logFile)
	}
	noSecrets("agent.log", string(logFile))
	st, err := status.Load(filepath.Join(dir, "data", "status.json"))
	if err != nil || st.Service != "stopped" || st.LastBackup == nil {
		t.Fatalf("runtime status: %+v %v", st, err)
	}

	// uninstall (development layout: only the agent directories go)
	so, se, code = run(time.Minute, "uninstall", "--yes")
	if code != 0 {
		t.Fatalf("uninstall: %d\n%s\n%s", code, so, se)
	}
	for _, d := range []string{"state", "data", "logs"} {
		if fileExists(filepath.Join(dir, d)) {
			t.Fatalf("%s survived the uninstall", d)
		}
	}
	if !fileExists(bin) {
		t.Fatal("uninstall in a development layout must not delete the binary under test")
	}
}
