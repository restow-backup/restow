//go:build integration

// Package integration runs the agent against the real restic binary and a real
// restic REST server in append-only mode (a stand-in for the Restow restic
// endpoint). It proves that backup, restore into a new folder, restore tests
// (verify_sample), the append-only guarantee and the shipped CLI work end to
// end. Run it with scripts/integration.sh.
package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func envOrFatal(t testing.TB, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Fatalf("%s is not set; run this test through scripts/integration.sh", name)
	}
	return v
}

// tWriter forwards log lines to the test log.
type tWriter struct{ t testing.TB }

func (w tWriter) Write(p []byte) (int, error) {
	w.t.Helper()
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func testLogger(t testing.TB) *slog.Logger {
	return slog.New(slog.NewTextHandler(tWriter{t}, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// restServer is a running restic rest-server in append-only, private-repos mode.
type restServer struct {
	URL  string // http://127.0.0.1:port
	Dir  string
	User string
	Pass string
	cmd  *exec.Cmd
}

// startRestServer launches rest-server. The agent user is the endpoint id, as
// with the Restow endpoint (basic auth endpointId:agentSecret).
func startRestServer(t *testing.T, user, pass string) *restServer {
	t.Helper()
	bin := envOrFatal(t, "RESTOW_TEST_REST_SERVER")
	dir := t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	// {SHA} htpasswd entry: base64(sha1(password)).
	sum := sha1.Sum([]byte(pass))
	htpasswd := filepath.Join(dir, "htpasswd")
	if err := os.WriteFile(htpasswd, []byte(user+":{SHA}"+base64.StdEncoding.EncodeToString(sum[:])+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(dir, "data")
	cmd := exec.Command(bin, "--path", data, "--listen", addr, "--append-only", "--private-repos", "--htpasswd-file", htpasswd)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatalf("cannot start rest-server: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		if t.Failed() {
			t.Logf("rest-server output:\n%s", out.String())
		}
	})
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return &restServer{URL: "http://" + addr, Dir: data, User: user, Pass: pass, cmd: cmd}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("rest-server did not start:\n%s", out.String())
	return nil
}

// repoURL is the restic repository URL for an endpoint.
func (s *restServer) repoURL() string { return "rest:" + s.URL + "/" + s.User + "/" }

// resticCmd runs restic with the given credentials and returns its output.
func resticCmd(t testing.TB, repo, repoPass, user, pass string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(envOrFatal(t, "RESTOW_TEST_RESTIC"), args...)
	cmd.Env = append(os.Environ(),
		"RESTIC_REPOSITORY="+repo, "RESTIC_PASSWORD="+repoPass,
		"RESTIC_REST_USERNAME="+user, "RESTIC_REST_PASSWORD="+pass,
		"RESTIC_CACHE_DIR="+filepath.Join(os.TempDir(), "restow-it-cache"))
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// env is the full test environment: fake Restow instance, restic repository
// behind rest-server, and a source tree.
type env struct {
	t      *testing.T
	rest   *restServer
	restow *fakeserver.Server
	root   string
	src    string
	layout paths.Layout
	log    *slog.Logger
	// hooks is the machine's local hook policy (off unless a test allows them).
	hooks string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t}
	e.restow = fakeserver.New(false) // plain HTTP; the agent is told to accept it
	t.Cleanup(e.restow.Close)
	e.restow.EndpointID = "ep-it-0001"
	e.restow.AgentSecret = "rsea_integration_secret_0123456789abcdef"
	e.restow.RepoPassword = randomHex(t, 16)
	e.rest = startRestServer(t, e.restow.EndpointID, e.restow.AgentSecret)
	e.restow.RepoURL = e.rest.repoURL()

	// The Restow server initialises the repository at enrollment.
	if out, err := resticCmd(t, e.rest.repoURL(), e.restow.RepoPassword, e.rest.User, e.rest.Pass, "init"); err != nil {
		t.Fatalf("restic init: %v\n%s", err, out)
	}
	e.root = t.TempDir()
	e.src = filepath.Join(e.root, "src")
	e.layout = paths.Layout{StateDir: filepath.Join(e.root, "state"), DataDir: filepath.Join(e.root, "data"), LogDir: filepath.Join(e.root, "logs")}
	if err := os.MkdirAll(e.src, 0o755); err != nil {
		t.Fatal(err)
	}
	e.restow.Config.Paths = []string{e.src}
	e.restow.Config.Excludes = []string{"*.tmp", "node_modules"}
	e.restow.Config.Schedule = api.Schedule{Kind: api.ScheduleDaily, TimeOfDay: "03:00", TimeZone: "UTC"}
	e.log = testLogger(t)
	return e
}

func randomHex(t testing.TB, n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func sha256Of(t testing.TB, path string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func writeFile(t testing.TB, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func randomBytes(t testing.TB, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// populate creates a source tree and returns the SHA-256 of every regular file
// that must be in the backup, keyed by absolute path.
func (e *env) populate() map[string]string {
	e.t.Helper()
	files := map[string][]byte{
		"docs/readme.txt":             []byte("Restow integration test\n"),
		"docs/report [final] (1).txt": []byte("glob characters in the file name\n"),
		"docs/unicode-äöü-日本.txt":     []byte("unicode name\n"),
		"data/big.bin":                randomBytes(e.t, 1<<20),
		"data/empty.txt":              {},
		"web/index.html":              []byte("<html></html>"),
		"web/node_modules/dep/x.js":   []byte("excluded"),
		"cache/session.tmp":           []byte("excluded"),
	}
	for i := 0; i < 30; i++ {
		files[fmt.Sprintf("many/file%02d.txt", i)] = []byte(strings.Repeat(fmt.Sprintf("line %d\n", i), 50))
	}
	hashes := map[string]string{}
	for rel, content := range files {
		p := filepath.Join(e.src, filepath.FromSlash(rel))
		writeFile(e.e(), p, content)
		if !strings.HasSuffix(rel, ".tmp") && !strings.Contains(rel, "node_modules") {
			hashes[p] = sha256Of(e.t, p)
		}
	}
	if err := os.Symlink("docs/readme.txt", filepath.Join(e.src, "link-to-readme")); err != nil {
		e.t.Fatal(err)
	}
	return hashes
}

func (e *env) e() testing.TB { return e.t }

// agent builds an in-process agent against the fake instance and the real
// restic and rest-server.
func (e *env) agent(opts core.Options) *core.Agent {
	e.t.Helper()
	st := &state.State{
		ServerURL: e.restow.URL, EndpointID: e.restow.EndpointID, Hostname: "it-host", Profile: api.ProfileServer,
		EnrolledAt: time.Now().Add(-72 * time.Hour), AllowInsecureHTTP: true,
		AgentSecret: e.restow.AgentSecret, RepositoryURL: e.restow.RepoURL, RepositoryPassword: e.restow.RepoPassword,
		Hooks: e.hooks,
	}
	client, err := api.New(api.Options{BaseURL: e.restow.URL, EndpointID: st.EndpointID, AgentSecret: st.AgentSecret, AllowInsecureHTTP: true})
	if err != nil {
		e.t.Fatal(err)
	}
	store, err := status.Open(e.layout.StatusFile())
	if err != nil {
		e.t.Fatal(err)
	}
	if _, serr := os.Stat(e.layout.StatusFile()); serr != nil {
		// Pretend a backup just ran so only tasks start backups.
		_ = store.Update(func(s *status.Status) { s.LastAttemptAt = time.Now() })
	}
	runner := &restic.Runner{
		Bin: envOrFatal(e.t, "RESTOW_TEST_RESTIC"), Repo: st.RepositoryURL, Password: st.RepositoryPassword,
		RESTUser: st.EndpointID, RESTPass: st.AgentSecret,
		CacheDir: e.layout.CacheDir(), TmpDir: filepath.Join(e.layout.DataDir, "restic-tmp"),
	}
	if opts.HeartbeatInterval == 0 {
		opts.HeartbeatInterval = 100 * time.Millisecond
	}
	if opts.HeartbeatJitter == 0 {
		opts.HeartbeatJitter = time.Nanosecond
	}
	if opts.Tick == 0 {
		opts.Tick = 50 * time.Millisecond
	}
	if opts.ProgressInterval == 0 {
		opts.ProgressInterval = 500 * time.Millisecond
	}
	return core.New(core.Deps{Layout: e.layout, State: st, Server: client, Restic: runner, Status: store, Logger: e.log}, opts)
}

// running is an agent running in the background.
type running struct {
	cancel context.CancelFunc
	done   chan error
}

func (e *env) start(a *core.Agent) *running {
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- a.Run(ctx) }()
	e.t.Cleanup(func() { r.stop(e.t) })
	return r
}

func (r *running) stop(t testing.TB) {
	if r.cancel == nil {
		return
	}
	r.cancel()
	r.cancel = nil
	select {
	case <-r.done:
	case <-time.After(90 * time.Second):
		t.Error("agent did not stop within 90 s")
	}
}

// waitRun waits for the n-th run (1-based) to be finished on the fake instance.
func (e *env) waitRun(n int, timeout time.Duration) *fakeserver.Run {
	e.t.Helper()
	var got *fakeserver.Run
	ok := fakeserver.WaitFor(timeout, func() bool {
		runs := e.restow.AllRuns()
		if len(runs) < n {
			return false
		}
		e.restow.Lock()
		defer e.restow.Unlock()
		if runs[n-1].Finish == nil {
			return false
		}
		got = runs[n-1]
		return true
	})
	if !ok {
		e.t.Fatalf("run %d did not finish within %s (runs: %d)", n, timeout, len(e.restow.AllRuns()))
	}
	return got
}

func task(id, kind string, params any) api.Task {
	t := api.Task{ID: api.Flex(id), Kind: kind}
	if params != nil {
		raw, err := jsonMarshal(params)
		if err != nil {
			panic(err)
		}
		t.Params = raw
	}
	return t
}

var _ = http.StatusOK
