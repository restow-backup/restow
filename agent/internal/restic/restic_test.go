package restic

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRestic writes a shell script that stands in for restic. The script
// records its arguments and environment and then behaves according to the
// FAKE_MODE variable.
func fakeRestic(t *testing.T) (r *Runner, argsFile, envFile string) {
	t.Helper()
	dir := t.TempDir()
	argsFile = filepath.Join(dir, "args.txt")
	envFile = filepath.Join(dir, "env.txt")
	script := filepath.Join(dir, "restic")
	body := `#!/bin/sh
printf '%s\n' "$@" > "$FAKE_ARGS_OUT"
env > "$FAKE_ENV_OUT"
case "$FAKE_MODE" in
version)
  echo "restic 0.19.1 compiled with go1.25.10 on linux/arm64" ;;
backup-ok)
  echo '{"message_type":"status","percent_done":0.5,"total_files":10,"files_done":5,"total_bytes":1000,"bytes_done":500,"current_files":["/data/a.txt"]}'
  echo 'not json noise'
  echo '{"message_type":"summary","files_new":3,"files_changed":1,"files_unmodified":6,"data_added":4096,"total_files_processed":10,"total_bytes_processed":1000,"snapshot_id":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
  ;;
backup-partial)
  # What restic 0.19.1 writes for a file it cannot read: the error and the final
  # warning on stderr, the summary on stdout.
  echo '{"message_type":"error","error":{"message":"open /data/secret: permission denied"},"during":"archival","item":"/data/secret"}' >&2
  echo '{"message_type":"summary","files_new":1,"snapshot_id":"aaaa000000000000000000000000000000000000000000000000000000000000"}'
  echo '{"message_type":"exit_error","code":3,"message":"Warning: at least one source file could not be read"}' >&2
  exit 3 ;;
backup-partial-old)
  # An older restic wrote the errors of single files to stdout.
  echo '{"message_type":"error","error":{"message":"open /data/secret: permission denied"},"during":"archival","item":"/data/secret"}'
  echo '{"message_type":"summary","files_new":1,"snapshot_id":"aaaa000000000000000000000000000000000000000000000000000000000000"}'
  exit 3 ;;
backup-many-errors)
  i=0
  while [ $i -lt 130 ]; do
    echo '{"message_type":"error","error":{"message":"open /f'$i': permission denied"},"during":"archival","item":"/f'$i'"}' >&2
    i=$((i + 1))
  done
  echo '{"message_type":"summary","files_new":1,"snapshot_id":"aaaa000000000000000000000000000000000000000000000000000000000000"}'
  exit 3 ;;
backup-fatal-after-errors)
  echo '{"message_type":"error","error":{"message":"open /data/secret: permission denied"},"during":"archival","item":"/data/secret"}' >&2
  echo '{"message_type":"exit_error","code":1,"message":"Fatal: unable to save snapshot: connection refused"}' >&2
  exit 1 ;;
wrong-password)
  echo '{"message_type":"exit_error","code":12,"message":"Fatal: wrong password or no key found"}' >&2
  exit 12 ;;
locked)
  echo 'Fatal: unable to create lock in backend: repository is already locked exclusively by PID 42' >&2
  exit 11 ;;
forbidden)
  echo 'Fatal: unexpected HTTP response (403): 403 Forbidden' >&2
  exit 1 ;;
nosummary)
  echo '{"message_type":"status","percent_done":1}' ;;
sleep)
  # The interrupt handler and the child are in place before "started" is
  # written. A test that reacts to that line may signal at once; signalling
  # earlier would kill the shell (no handler yet) or leave the child running
  # (pid not yet set), and either would make the outcome depend on timing.
  trap 'kill $pid; echo interrupted >&2; exit 130' INT
  sleep 30 &
  pid=$!
  echo started >&2
  wait ;;
restore-ok)
  echo '{"message_type":"status","percent_done":1,"total_files":2,"files_restored":2,"total_bytes":20,"bytes_restored":20}'
  echo '{"message_type":"summary","total_files":2,"files_restored":2,"total_bytes":20,"bytes_restored":20}' ;;
restore-damaged)
  # What restic 0.19.1 writes when a pack the files need is missing (REST backend):
  # the per-item errors and the final error go to stderr, the summary to stdout.
  echo 'Load(<data/6e73100d78>, 300050, 0) failed: <data/6e73100d78> does not exist' >&2
  echo '{"message_type":"error","error":{"message":"ReadFull(<data/6e73100d78>): <data/6e73100d78> does not exist"},"during":"restore","item":"/src/big.bin"}' >&2
  echo '{"message_type":"error","error":{"message":"lchown /t/src/big.bin: no such file or directory"},"during":"restore","item":"/src/big.bin"}' >&2
  echo '{"message_type":"summary","total_files":2,"files_restored":8,"total_bytes":300006}'
  echo '{"message_type":"exit_error","code":1,"message":"Fatal: There were 2 errors"}' >&2
  exit 1 ;;
restore-many-errors)
  i=0
  while [ $i -lt 130 ]; do
    echo '{"message_type":"error","error":{"message":"write: no space left on device"},"during":"restore","item":"/f'$i'"}' >&2
    i=$((i + 1))
  done
  echo '{"message_type":"exit_error","code":1,"message":"Fatal: There were 130 errors"}' >&2
  exit 1 ;;
ls)
  echo '{"message_type":"snapshot","id":"abc"}'
  echo '{"message_type":"node","name":"a","type":"dir","path":"/a"}'
  for i in 1 2 3 4 5 6 7 8 9 10; do
    echo '{"message_type":"node","name":"f'$i'","type":"file","path":"/a/f'$i'","size":'$i'00,"mtime":"2026-09-30T10:00:00Z"}'
  done
  echo '{"message_type":"node","name":"empty","type":"file","path":"/a/empty","size":0}'
  echo '{"message_type":"node","name":"link","type":"symlink","path":"/a/link"}' ;;
esac
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	r = &Runner{
		Bin: script, Repo: "rest:https://restow.example.com/agent/restic/ep-1/",
		Password: "repo-password-SECRET-0001", RESTUser: "ep-1", RESTPass: "rsea_agent_SECRET_0002",
		CacheDir: filepath.Join(dir, "cache"), TmpDir: filepath.Join(dir, "tmp"),
		ExtraEnv:    []string{"FAKE_ARGS_OUT=" + argsFile, "FAKE_ENV_OUT=" + envFile},
		CancelGrace: 5 * time.Second,
	}
	return r, argsFile, envFile
}

func mode(r *Runner, m string) { r.ExtraEnv = append(r.ExtraEnv, "FAKE_MODE="+m) }

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestVersion(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "version")
	v, err := r.Version(context.Background())
	if err != nil || v != "0.19.1" {
		t.Fatalf("Version = %q, %v", v, err)
	}
}

func TestBackupOK_SecretsOnlyInEnvironment(t *testing.T) {
	r, argsFile, envFile := fakeRestic(t)
	mode(r, "backup-ok")
	var logs []string
	r.Log = func(l string) { logs = append(logs, l) }
	var progress []Progress
	res, err := r.Backup(context.Background(), BackupOptions{
		Paths:          []string{"/data", "/etc"},
		Excludes:       []string{"*.tmp", "node_modules", "", "#comment", "$HOME/x"},
		Host:           "web01",
		Tags:           []string{"restow-agent"},
		LimitUploadKiB: 512,
		// 1 GiB, as the server sends a limit of 1 GiB.
		ExcludeLargerThanBytes: 1073741824,
		OnProgress:             func(p Progress) { progress = append(progress, p) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.SnapshotID != "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ||
		res.Summary.FilesNew != 3 || res.Summary.DataAdded != 4096 || res.Partial {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(progress) != 1 || progress[0].FilesDone != 5 || progress[0].TotalBytes != 1000 || progress[0].CurrentPath != "/data/a.txt" {
		t.Fatalf("progress: %+v", progress)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "#comment") {
		t.Fatalf("expected one skipped-pattern warning, got %v", res.Warnings)
	}
	// Non-JSON output is forwarded to the log.
	if len(logs) != 1 || logs[0] != "not json noise" {
		t.Fatalf("logs = %v", logs)
	}

	args := readFile(t, argsFile)
	for _, want := range []string{"backup", "--json", "--files-from-raw", "--exclude-caches", "--host\nweb01", "--tag\nrestow-agent", "--limit-upload\n512", "--exclude-file", "--exclude-larger-than\n1073741824"} {
		if !strings.Contains(args, want) {
			t.Errorf("args lack %q:\n%s", want, args)
		}
	}
	// The core promise: no secret on the command line, all of them in the environment.
	for _, secret := range []string{"repo-password-SECRET-0001", "rsea_agent_SECRET_0002"} {
		if strings.Contains(args, secret) {
			t.Fatalf("secret %q on the command line", secret)
		}
	}
	env := readFile(t, envFile)
	for _, want := range []string{
		"RESTIC_PASSWORD=repo-password-SECRET-0001", "RESTIC_REST_USERNAME=ep-1", "RESTIC_REST_PASSWORD=rsea_agent_SECRET_0002",
		"RESTIC_REPOSITORY=rest:https://restow.example.com/agent/restic/ep-1/", "RESTIC_PROGRESS_FPS=0.5", "RESTIC_CACHE_DIR=",
	} {
		if !strings.Contains(env, want) {
			t.Errorf("environment lacks %q", want)
		}
	}
	// Option files are removed afterwards.
	entries, _ := os.ReadDir(r.TmpDir)
	if len(entries) != 0 {
		t.Fatalf("temporary option files left behind: %v", entries)
	}
}

func TestBackupWithoutASizeLimitPassesNoSwitch(t *testing.T) {
	// restic reads --exclude-larger-than 0 as "skip every file with content", so a zero must never reach it.
	for _, limit := range []int64{0, -1} {
		r, argsFile, _ := fakeRestic(t)
		mode(r, "backup-ok")
		if _, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}, ExcludeLargerThanBytes: limit}); err != nil {
			t.Fatal(err)
		}
		if args := readFile(t, argsFile); strings.Contains(args, "--exclude-larger-than") {
			t.Fatalf("limit %d reached restic:\n%s", limit, args)
		}
	}
}

func TestBackupArgs(t *testing.T) {
	cases := []struct {
		name string
		opts BackupOptions
		ex   string
		want []string
	}{
		{
			name: "only the sources",
			opts: BackupOptions{Paths: []string{"/data"}},
			want: []string{"backup", "--json", "--files-from-raw", "/tmp/paths.raw", "--exclude-caches", "--retry-lock", "15m"},
		},
		{
			name: "a size limit is passed as a plain number of bytes",
			opts: BackupOptions{ExcludeLargerThanBytes: 5 * 1024 * 1024 * 1024},
			want: []string{"backup", "--json", "--files-from-raw", "/tmp/paths.raw", "--exclude-caches", "--retry-lock", "15m",
				"--exclude-larger-than", "5368709120"},
		},
		{
			name: "everything at once, in a fixed order",
			opts: BackupOptions{Host: "web01", Tags: []string{"restow-agent", "nightly"}, LimitUploadKiB: 977, ExcludeLargerThanBytes: 1000},
			ex:   "/tmp/excludes.txt",
			want: []string{"backup", "--json", "--files-from-raw", "/tmp/paths.raw", "--exclude-caches", "--retry-lock", "15m",
				"--host", "web01", "--tag", "restow-agent", "--tag", "nightly", "--exclude-file", "/tmp/excludes.txt",
				"--limit-upload", "977", "--exclude-larger-than", "1000"},
		},
		{
			name: "no limits: neither switch appears",
			opts: BackupOptions{LimitUploadKiB: 0, ExcludeLargerThanBytes: 0},
			want: []string{"backup", "--json", "--files-from-raw", "/tmp/paths.raw", "--exclude-caches", "--retry-lock", "15m"},
		},
		{
			name: "a negative size is no limit",
			opts: BackupOptions{ExcludeLargerThanBytes: -7},
			want: []string{"backup", "--json", "--files-from-raw", "/tmp/paths.raw", "--exclude-caches", "--retry-lock", "15m"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := backupArgs(tc.opts, "/tmp/paths.raw", tc.ex)
			if strings.Join(got, "\x00") != strings.Join(tc.want, "\x00") {
				t.Fatalf("args\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

func TestBackupEnvironmentIsAllowlisted(t *testing.T) {
	t.Setenv("AWS_SECRET_ACCESS_KEY", "leak-me-not")
	t.Setenv("RESTOW_TOKEN", "rset_leak")
	r, _, envFile := fakeRestic(t)
	mode(r, "backup-ok")
	if _, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}}); err != nil {
		t.Fatal(err)
	}
	env := readFile(t, envFile)
	if strings.Contains(env, "leak-me-not") || strings.Contains(env, "rset_leak") {
		t.Fatalf("foreign environment leaked into restic:\n%s", env)
	}
}

func TestExcludeFileContent(t *testing.T) {
	r, argsFile, _ := fakeRestic(t)
	// Replace the script so that it copies the exclude file before it is removed.
	script := r.Bin
	body, _ := os.ReadFile(script)
	patched := strings.Replace(string(body), "case \"$FAKE_MODE\" in",
		`prev=""; for a in "$@"; do if [ "$prev" = "--exclude-file" ]; then cp "$a" "$FAKE_ARGS_OUT.excludes"; fi; if [ "$prev" = "--files-from-raw" ]; then cp "$a" "$FAKE_ARGS_OUT.paths"; fi; prev="$a"; done
case "$FAKE_MODE" in`, 1)
	if err := os.WriteFile(script, []byte(patched), 0o755); err != nil {
		t.Fatal(err)
	}
	mode(r, "backup-ok")
	_, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/a b", "/c"}, Excludes: []string{" *.tmp ", "$HOME/x", "cache/"}})
	if err != nil {
		t.Fatal(err)
	}
	ex := readFile(t, argsFile+".excludes")
	if ex != "*.tmp\n$$HOME/x\ncache/\n" {
		t.Fatalf("exclude file = %q", ex)
	}
	paths := readFile(t, argsFile+".paths")
	if paths != "/a b\x00/c\x00" {
		t.Fatalf("paths file = %q", paths)
	}
}

// restic 0.19 reports the files it could not read on stderr: the result lists
// them, and the run log names each once in a readable form.
func TestBackupPartialExit3(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "backup-partial")
	var mu sync.Mutex
	var logged []string
	r.Log = func(line string) {
		mu.Lock()
		defer mu.Unlock()
		logged = append(logged, line)
	}
	res, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Partial || res.SnapshotID == "" || len(res.Errors) != 1 || res.ErrorCount != 1 ||
		res.Errors[0].Path != "/data/secret" || res.Errors[0].During != "archival" ||
		res.Errors[0].Message != "open /data/secret: permission denied" {
		t.Fatalf("partial result: %+v", res)
	}
	mu.Lock()
	joined := strings.Join(logged, "\n")
	mu.Unlock()
	if strings.Count(joined, "error: /data/secret: open /data/secret: permission denied") != 1 ||
		strings.Contains(joined, `"message_type"`) {
		t.Fatalf("log:\n%s", joined)
	}
}

func TestBackupPartialOfAnOlderResticOnStdout(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "backup-partial-old")
	res, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Partial || len(res.Errors) != 1 || res.ErrorCount != 1 || res.Errors[0].Path != "/data/secret" {
		t.Fatalf("partial result: %+v", res)
	}
}

func TestBackupKeepsAHundredItemErrorsAndCountsAll(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "backup-many-errors")
	res, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.ErrorCount != 130 || len(res.Errors) != maxKeptItemErrors || res.Errors[0].Path != "/f0" ||
		res.Errors[maxKeptItemErrors-1].Path != "/f99" {
		t.Fatalf("count=%d kept=%d", res.ErrorCount, len(res.Errors))
	}
}

// A backup that fails after some files could not be read carries those errors too.
func TestBackupFailureCarriesItemErrors(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "backup-fatal-after-errors")
	_, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}})
	re, ok := err.(*Error)
	if !ok {
		t.Fatalf("err = %T %v", err, err)
	}
	if re.ExitCode != 1 || re.Message != "Fatal: unable to save snapshot: connection refused" || re.ItemCount != 1 ||
		len(re.Items) != 1 || re.Items[0].Path != "/data/secret" {
		t.Fatalf("error: %+v", re)
	}
}

func TestBackupFailuresMapToHints(t *testing.T) {
	cases := []struct {
		mode      string
		exit      int
		hint      string
		transient bool
	}{
		{"wrong-password", 12, "enroll this machine again", false},
		{"locked", 11, "server-side maintenance", true},
		{"forbidden", 1, "append-only", false},
	}
	for _, c := range cases {
		r, _, _ := fakeRestic(t)
		mode(r, c.mode)
		res, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}})
		if res != nil || err == nil {
			t.Fatalf("%s: expected failure, got %+v", c.mode, res)
		}
		re, ok := err.(*Error)
		if !ok {
			t.Fatalf("%s: error type %T", c.mode, err)
		}
		if re.ExitCode != c.exit || !strings.Contains(re.Hint(), c.hint) || re.Transient() != c.transient {
			t.Errorf("%s: exit=%d hint=%q transient=%v", c.mode, re.ExitCode, re.Hint(), re.Transient())
		}
		if re.Message == "" {
			t.Errorf("%s: no message", c.mode)
		}
	}
}

func TestBackupWithoutSummaryIsAnError(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "nosummary")
	if _, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/data"}}); err == nil ||
		!strings.Contains(err.Error(), "without reporting a snapshot id") {
		t.Fatalf("err = %v", err)
	}
}

func TestBackupCancelSendsInterrupt(t *testing.T) {
	// The deadlines below only bound how long a broken run takes to fail; a
	// working run never waits for them. CancelGrace is the time restic gets to
	// react to the interrupt before it is killed, so it is generous as well: the
	// fake reacts at once, unless the machine is starved.
	const guard = 60 * time.Second
	r, _, _ := fakeRestic(t)
	mode(r, "sleep")
	r.CancelGrace = 30 * time.Second
	var mu sync.Mutex
	var lines []string
	started := make(chan struct{}, 1)
	r.Log = func(l string) {
		mu.Lock()
		lines = append(lines, l)
		mu.Unlock()
		if l == "started" {
			select {
			case started <- struct{}{}:
			default:
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := r.Backup(ctx, BackupOptions{Paths: []string{"/data"}})
		done <- err
	}()
	// "started" means the fake is ready for the interrupt (see fakeRestic).
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("backup ended before the fake restic was ready: %v", err)
	case <-time.After(guard):
		t.Fatal("fake restic did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || ctx.Err() == nil {
			t.Fatalf("expected context error, got %v", err)
		}
	case <-time.After(guard):
		t.Fatal("backup did not stop after cancel")
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(strings.Join(lines, "|"), "interrupted") {
		t.Fatalf("restic did not receive SIGINT (graceful stop): %v", lines)
	}
}

func TestBackupNoPathsAndMissingBinary(t *testing.T) {
	r, _, _ := fakeRestic(t)
	if _, err := r.Backup(context.Background(), BackupOptions{}); err == nil {
		t.Fatal("no paths must fail")
	}
	r.Bin = filepath.Join(t.TempDir(), "does-not-exist")
	_, err := r.Backup(context.Background(), BackupOptions{Paths: []string{"/x"}})
	if err == nil || !strings.Contains(err.Error(), "cannot start restic") {
		t.Fatalf("err = %v", err)
	}
}

func TestRestoreArgsAndSummary(t *testing.T) {
	r, argsFile, _ := fakeRestic(t)
	mode(r, "restore-ok")
	var seen []Progress
	res, err := r.Restore(context.Background(), RestoreOptions{
		SnapshotID: "abcd1234", Target: "/tmp/Restow-Restore-x",
		Includes:   []string{"/home/lucas/report [final].txt", "/srv/www"},
		OnProgress: func(p Progress) { seen = append(seen, p) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Summary.FilesRestored != 2 || len(seen) != 1 || seen[0].FilesDone != 2 {
		t.Fatalf("res=%+v seen=%+v", res, seen)
	}
	args := readFile(t, argsFile)
	for _, want := range []string{"restore", "--target\n/tmp/Restow-Restore-x", "--overwrite\nnever", "--verify",
		"--include\n/home/lucas/report \\[final].txt", "--include\n/srv/www", "abcd1234"} {
		if !strings.Contains(args, want) {
			t.Errorf("args lack %q:\n%s", want, args)
		}
	}
	if _, err := r.Restore(context.Background(), RestoreOptions{SnapshotID: "x", Target: "/t", Includes: []string{"relative/path"}}); err == nil {
		t.Fatal("relative include must be refused")
	}
	if _, err := r.Restore(context.Background(), RestoreOptions{SnapshotID: "", Target: "/t"}); err == nil {
		t.Fatal("missing snapshot must be refused")
	}
}

// restic 0.19 reports per-item errors on stderr: the failure carries them and
// restic's own final error, so the server can tell damage from a local problem.
func TestRestoreFailureCarriesItemErrorsAndFatal(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "restore-damaged")
	var mu sync.Mutex
	var logged []string
	r.Log = func(line string) {
		mu.Lock()
		defer mu.Unlock()
		logged = append(logged, line)
	}
	_, err := r.Restore(context.Background(), RestoreOptions{SnapshotID: "abcd1234", Target: "/t", Includes: []string{"/src/big.bin"}})
	re, ok := err.(*Error)
	if !ok {
		t.Fatalf("err = %T %v", err, err)
	}
	if re.ExitCode != 1 || re.Fatal != "Fatal: There were 2 errors" || re.ItemCount != 2 || len(re.Items) != 2 {
		t.Fatalf("error: %+v", re)
	}
	if re.Items[0].Path != "/src/big.bin" || re.Items[0].Message != "ReadFull(<data/6e73100d78>): <data/6e73100d78> does not exist" ||
		!strings.HasPrefix(re.Items[1].Message, "lchown ") {
		t.Fatalf("items: %+v", re.Items)
	}
	if !strings.Contains(re.Message, "2 file(s) could not be restored, first: /src/big.bin: ReadFull") {
		t.Fatalf("message: %q", re.Message)
	}
	// Each item error is logged once, readably, not as raw JSON.
	mu.Lock()
	joined := strings.Join(logged, "\n")
	mu.Unlock()
	if strings.Count(joined, "does not exist\"") != 0 || strings.Count(joined, "error: /src/big.bin: ReadFull") != 1 {
		t.Fatalf("log:\n%s", joined)
	}
}

func TestRestoreFailureKeepsAHundredItemErrorsAndCountsAll(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "restore-many-errors")
	_, err := r.Restore(context.Background(), RestoreOptions{SnapshotID: "abcd1234", Target: "/t"})
	re, ok := err.(*Error)
	if !ok {
		t.Fatalf("err = %T %v", err, err)
	}
	if re.ItemCount != 130 || len(re.Items) != maxKeptItemErrors || re.Items[0].Path != "/f0" {
		t.Fatalf("count=%d kept=%d first=%+v", re.ItemCount, len(re.Items), re.Items[0])
	}
	if !strings.Contains(re.Hint(), "disk is full") {
		t.Fatalf("hint: %q", re.Hint())
	}
}

func TestLsAndSample(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "ls")
	var files []string
	err := r.Ls(context.Background(), "abc", func(n Node) error {
		if n.Type == "file" {
			files = append(files, n.Path)
		}
		return nil
	})
	if err != nil || len(files) != 11 {
		t.Fatalf("Ls: %v %v", files, err)
	}
	// Early stop.
	count := 0
	err = r.Ls(context.Background(), "abc", func(n Node) error { count++; return ErrStopLs })
	if err != nil || count != 1 {
		t.Fatalf("early stop: count=%d err=%v", count, err)
	}
	nodes, err := r.SampleFiles(context.Background(), "abc", SampleOptions{
		Want: 3, Pool: 5, MaxFileSize: 800, Rand: rand.New(rand.NewPCG(1, 2)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 5 {
		t.Fatalf("expected a pool of 5, got %d", len(nodes))
	}
	seen := map[string]bool{}
	for _, n := range nodes {
		if n.Type != "file" || n.Size == 0 || n.Size > 800 {
			t.Errorf("ineligible node in sample: %+v", n)
		}
		if seen[n.Path] {
			t.Errorf("duplicate %s", n.Path)
		}
		seen[n.Path] = true
	}
}

func TestReservoirIsUniform(t *testing.T) {
	rng := rand.New(rand.NewPCG(42, 7))
	counts := make([]int, 20)
	const rounds = 20000
	for i := 0; i < rounds; i++ {
		res := NewReservoir(4, rng)
		for k := 0; k < 20; k++ {
			res.Offer(Node{Path: fmt.Sprintf("/f%d", k), Size: uint64(k + 1), Type: "file"})
		}
		for _, n := range res.Shuffled() {
			counts[n.Size-1]++
		}
	}
	// Each element should be picked in 4/20 = 20% of the rounds.
	for k, c := range counts {
		frac := float64(c) / rounds
		if frac < 0.18 || frac > 0.22 {
			t.Errorf("element %d selected in %.3f of the rounds, want about 0.2", k, frac)
		}
	}
}

func TestEscapeIncludePath(t *testing.T) {
	cases := map[string]string{
		"/plain/path.txt":       "/plain/path.txt",
		"/a/report [final].txt": `/a/report \[final].txt`,
		"/a/what?*":             `/a/what\?\*`,
		`/a/back\slash`:         `/a/back\\slash`,
	}
	for in, want := range cases {
		if got := EscapeIncludePath(in); got != want {
			t.Errorf("EscapeIncludePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPeekTypeAndLineWriter(t *testing.T) {
	if peekType([]byte(`{"message_type":"status","x":1}`)) != "status" || peekType([]byte(`plain`)) != "" || peekType([]byte(`{bad`)) != "" {
		t.Fatal("peekType")
	}
	var got []string
	w := newLineWriter(func(l []byte) { got = append(got, string(l)) })
	long := strings.Repeat("x", maxLineBytes+10)
	// Feed in odd-sized pieces to exercise the carry-over of partial lines.
	input := "one\ntwo\r\n" + long + "\nlast-without-newline"
	for i := 0; i < len(input); i += 7 {
		end := i + 7
		if end > len(input) {
			end = len(input)
		}
		_, _ = w.Write([]byte(input[i:end]))
	}
	w.flush()
	if len(got) != 3 || got[0] != "one" || got[1] != "two" || got[2] != "last-without-newline" {
		t.Fatalf("lines = %d: %v", len(got), got[:min(len(got), 3)])
	}
}
