package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/lock"
	"github.com/restow-backup/restow/agent/internal/logging"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/power"
	"github.com/restow-backup/restow/agent/internal/release"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

// fakeResticScript stands in for restic in engine tests. Behaviour is chosen
// with FAKE_* variables (see the individual tests).
const fakeResticScript = `#!/bin/sh
echo "$1" >> "$FAKE_DIR/commands.txt"
case "$1" in
version) echo "restic 0.19.1 compiled with go1.25.10 on linux/arm64"; exit 0 ;;
unlock) exit 0 ;;
cat) exit 0 ;;
backup)
  printf '%s\n' "$@" > "$FAKE_DIR/backup-args.txt"
  if [ -n "$FAKE_BACKUP_SLEEP" ]; then
    trap 'kill $pid 2>/dev/null; echo interrupted >&2; exit 130' INT
    echo '{"message_type":"status","percent_done":0.1,"files_done":1,"bytes_done":10}'
    sleep "$FAKE_BACKUP_SLEEP" &
    pid=$!
    wait
  fi
  case "$FAKE_BACKUP" in
  fail) echo 'Fatal: unable to open repository at rest:https://x: dial tcp: connection refused' >&2; exit 1 ;;
  partial)
    # restic 0.19 writes the error of each file and its final warning to stderr.
    echo '{"message_type":"error","error":{"message":"open /srv/locked.db: permission denied"},"during":"archival","item":"/srv/locked.db"}' >&2
    echo '{"message_type":"summary","files_new":2,"files_changed":0,"files_unmodified":1,"data_added":100,"total_files_processed":3,"total_bytes_processed":300,"snapshot_id":"bbbb000000000000000000000000000000000000000000000000000000000000"}'
    echo '{"message_type":"exit_error","code":3,"message":"Warning: at least one source file could not be read"}' >&2
    exit 3 ;;
  partial-old)
    # An older restic wrote them to stdout.
    echo '{"message_type":"error","error":{"message":"permission denied"},"during":"archival","item":"/root/secret"}'
    echo '{"message_type":"summary","files_new":2,"files_changed":0,"files_unmodified":1,"data_added":100,"total_files_processed":3,"total_bytes_processed":300,"snapshot_id":"bbbb000000000000000000000000000000000000000000000000000000000000"}'
    exit 3 ;;
  partial-many)
    i=0
    while [ $i -lt 130 ]; do
      echo '{"message_type":"error","error":{"message":"open /srv/f'$i': permission denied"},"during":"archival","item":"/srv/f'$i'"}' >&2
      i=$((i + 1))
    done
    echo '{"message_type":"summary","files_new":2,"files_changed":0,"files_unmodified":1,"data_added":100,"total_files_processed":133,"total_bytes_processed":300,"snapshot_id":"bbbb000000000000000000000000000000000000000000000000000000000000"}'
    echo '{"message_type":"exit_error","code":3,"message":"Warning: at least one source file could not be read"}' >&2
    exit 3 ;;
  esac
  echo '{"message_type":"status","percent_done":1,"total_files":3,"files_done":3,"total_bytes":300,"bytes_done":300}'
  echo '{"message_type":"summary","files_new":2,"files_changed":1,"files_unmodified":0,"data_added":4096,"total_files_processed":3,"total_bytes_processed":300,"snapshot_id":"aaaa000000000000000000000000000000000000000000000000000000000000"}'
  exit 0 ;;
ls)
  echo '{"message_type":"snapshot","id":"aaaa"}'
  cat "$FAKE_LS_FILE"
  exit 0 ;;
restore)
  printf '%s\n' "$@" > "$FAKE_DIR/restore-args.txt"
  target=""; prev=""
  for a in "$@"; do
    if [ "$prev" = "--target" ]; then target="$a"; fi
    prev="$a"
  done
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--include" ] && [ -n "$FAKE_RESTORE_SRC" ]; then
      p=$(printf '%s' "$a" | sed 's/\\\(.\)/\1/g')
      if [ -f "$FAKE_RESTORE_SRC$p" ]; then
        mkdir -p "$target$(dirname "$p")"
        cp "$FAKE_RESTORE_SRC$p" "$target$p"
      fi
    fi
    prev="$a"
  done
  if [ -z "$FAKE_RESTORE_SRC" ]; then mkdir -p "$target/data"; echo restored > "$target/data/file.txt"; fi
  if [ -n "$FAKE_RESTORE_MKDIR" ]; then mkdir -p "$target$FAKE_RESTORE_MKDIR"; fi
  echo '{"message_type":"summary","total_files":2,"files_restored":2,"total_bytes":20,"bytes_restored":20}'
  if [ -n "$FAKE_RESTORE_STDERR" ]; then cat "$FAKE_RESTORE_STDERR" >&2; exit "$FAKE_RESTORE_EXIT"; fi
  exit 0 ;;
esac
exit 0
`

// flakyTransport fails every request with a dial error while down is set.
type flakyTransport struct {
	down atomic.Bool
	next http.RoundTripper
}

func (f *flakyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if f.down.Load() {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: fmt.Errorf("network is unreachable")}
	}
	return f.next.RoundTrip(r)
}

type harness struct {
	t       *testing.T
	srv     *fakeserver.Server
	layout  paths.Layout
	agent   *Agent
	status  *status.Store
	net     *flakyTransport
	dir     string // FAKE_DIR
	src     string // directory with real files to back up
	extra   []string
	powerFn func() power.Status
	uninst  func(ctx context.Context) error
	exe     string
	// hooksMode is the machine's hook policy in the enrollment (default off).
	hooksMode string
	// binDir and updateKey configure the self-update (TestSelfUpdate...).
	binDir    string
	updateKey *release.PublicKey
	// noHistory leaves the scheduler without a last attempt, so a scheduled
	// backup is due at once (interval and on_connect kinds).
	noHistory bool

	cancel context.CancelFunc
	done   chan error
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t}
	h.srv = fakeserver.New(true)
	t.Cleanup(h.srv.Close)
	root := t.TempDir()
	h.layout = paths.Layout{StateDir: filepath.Join(root, "state"), DataDir: filepath.Join(root, "data"), LogDir: filepath.Join(root, "logs")}
	h.dir = filepath.Join(root, "fake")
	h.src = filepath.Join(root, "src")
	for _, d := range []string{h.dir, h.src} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	h.srv.Config.Paths = []string{h.src}
	h.srv.Config.Schedule = api.Schedule{Kind: api.ScheduleDaily, TimeOfDay: "03:00", TimeZone: "UTC"} // not due during tests
	script := filepath.Join(root, "restic")
	if err := os.WriteFile(script, []byte(fakeResticScript), 0o755); err != nil {
		t.Fatal(err)
	}
	h.extra = []string{"FAKE_DIR=" + h.dir}
	h.net = &flakyTransport{next: h.srv.Client().Transport}
	h.exe = filepath.Join(root, "restow-agent")
	return h
}

func (h *harness) env(kv ...string) { h.extra = append(h.extra, kv...) }

func (h *harness) build() {
	h.t.Helper()
	client, err := api.New(api.Options{
		BaseURL: h.srv.URL, EndpointID: h.srv.EndpointID, AgentSecret: h.srv.AgentSecret,
		HTTPClient: &http.Client{Transport: h.net},
		Retry:      api.RetryPolicy{MaxAttempts: 2, BaseDelay: time.Millisecond, MaxDelay: 2 * time.Millisecond},
		Sleep:      func(context.Context, time.Duration) error { return nil },
	})
	if err != nil {
		h.t.Fatal(err)
	}
	st := &state.State{
		ServerURL: h.srv.URL, EndpointID: h.srv.EndpointID, Hostname: "test-host", Profile: "server",
		EnrolledAt: time.Now().Add(-48 * time.Hour), AgentSecret: h.srv.AgentSecret,
		RepositoryURL: h.srv.RepoURL, RepositoryPassword: h.srv.RepoPassword, Hooks: h.hooksMode,
	}
	store, err := status.Open(h.layout.StatusFile())
	if err != nil {
		h.t.Fatal(err)
	}
	h.status = store
	if !h.noHistory {
		// Pretend a backup just ran, so the scheduler stays quiet unless a test wants it.
		_ = store.Update(func(s *status.Status) { s.LastAttemptAt = time.Now() })
	}
	runner := &restic.Runner{
		Bin: filepath.Join(filepath.Dir(h.exe), "restic"), Repo: st.RepositoryURL, Password: st.RepositoryPassword,
		RESTUser: st.EndpointID, RESTPass: st.AgentSecret,
		CacheDir: h.layout.CacheDir(), TmpDir: filepath.Join(h.layout.DataDir, "restic-tmp"),
		ExtraEnv: h.extra, CancelGrace: 5 * time.Second,
	}
	h.agent = New(Deps{
		Layout: h.layout, State: st, Server: client, Restic: runner, Status: store, Logger: logging.Discard(),
		Power: h.powerFn, BinDir: h.binDir, UpdateKey: h.updateKey, Uninstall: h.uninst,
	}, Options{
		HeartbeatInterval: 40 * time.Millisecond, HeartbeatRetryBase: 30 * time.Millisecond, HeartbeatJitter: time.Nanosecond, Tick: 15 * time.Millisecond,
		ConfigRefresh: time.Hour, ProgressInterval: 20 * time.Millisecond, SampleTimeout: 30 * time.Second,
		SelfUpdate: false,
	})
}

func (h *harness) start() {
	h.t.Helper()
	if h.agent == nil {
		h.build()
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	go func() { h.done <- h.agent.Run(ctx) }()
	h.t.Cleanup(func() { h.stop() })
}

func (h *harness) stop() error {
	if h.cancel == nil {
		return nil
	}
	h.cancel()
	h.cancel = nil
	select {
	case err := <-h.done:
		return err
	case <-time.After(20 * time.Second):
		h.t.Fatal("agent did not stop")
	}
	return nil
}

// waitRun waits until the n-th run (1-based) has finished on the server.
// statusAfterRun is the local status once the agent recorded the end of its
// (only) run. The agent writes it after the server answered the run report, so
// it can lag behind what waitRun sees on the server; on a busy machine reading
// it at once raced with that write.
func (h *harness) statusAfterRun() status.Status {
	h.t.Helper()
	var st status.Status
	fakeserver.WaitFor(10*time.Second, func() bool {
		st = h.status.Snapshot()
		return st.LastRun != nil && st.Current == nil
	})
	return st
}

func (h *harness) waitRun(n int) *fakeserver.Run {
	h.t.Helper()
	var got *fakeserver.Run
	ok := fakeserver.WaitFor(15*time.Second, func() bool {
		runs := h.srv.AllRuns()
		if len(runs) < n {
			return false
		}
		r := runs[n-1]
		h.srv.Lock()
		fin := r.Finish
		h.srv.Unlock()
		if fin == nil {
			return false
		}
		got = r
		return true
	})
	if !ok {
		h.t.Fatalf("run %d did not finish; runs seen: %d", n, len(h.srv.AllRuns()))
	}
	return got
}

func (h *harness) commands() string {
	b, _ := os.ReadFile(filepath.Join(h.dir, "commands.txt"))
	return string(b)
}

// writeSourceFiles creates n files and returns the ls JSON lines and hashes.
func (h *harness) writeSourceFiles(n int) (lsFile string, hashes map[string]string) {
	h.t.Helper()
	hashes = map[string]string{}
	var lines []byte
	for i := 0; i < n; i++ {
		p := filepath.Join(h.src, fmt.Sprintf("file%02d.txt", i))
		content := []byte(fmt.Sprintf("content of file %d\n", i) + fmt.Sprintf("%0200d", i))
		if err := os.WriteFile(p, content, 0o644); err != nil {
			h.t.Fatal(err)
		}
		st, _ := os.Stat(p)
		sum := sha256.Sum256(content)
		hashes[p] = hex.EncodeToString(sum[:])
		node, _ := json.Marshal(map[string]any{"message_type": "node", "name": filepath.Base(p), "type": "file",
			"path": p, "size": st.Size(), "mtime": st.ModTime().Format(time.RFC3339Nano)})
		lines = append(lines, node...)
		lines = append(lines, '\n')
	}
	lsFile = filepath.Join(h.dir, "ls.jsonl")
	if err := os.WriteFile(lsFile, lines, 0o644); err != nil {
		h.t.Fatal(err)
	}
	h.env("FAKE_LS_FILE=" + lsFile)
	return lsFile, hashes
}

// task builds a task with JSON params.
func task(id, kind string, params any) api.Task {
	t := api.Task{ID: api.Flex(id), Kind: kind}
	if params != nil {
		raw, _ := json.Marshal(params)
		t.Params = raw
	}
	return t
}

var _ = io.Discard
var _ sync.Locker

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// newLockHolder takes the run lock like another process would and returns a
// release function.
func newLockHolder(t *testing.T, path string) func() {
	t.Helper()
	lk, err := lock.TryAcquire(path)
	if err != nil {
		t.Fatal(err)
	}
	return func() { _ = lk.Release() }
}
