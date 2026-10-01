// Package fakeserver implements the server side of the agent API from the
// endpoint-backup specification, in memory, for tests. It is not part of the
// shipped binary.
package fakeserver

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/release"
)

// Server is a fake Restow instance.
type Server struct {
	*httptest.Server

	mu sync.Mutex

	// Configuration of the fake.
	EnrollToken  string
	EndpointID   string
	AgentSecret  string
	RepoURL      string
	RepoPassword string
	Config       api.Config
	Update       *api.UpdateInfo
	// Releases are the agent releases served below /install/agent/<version>/:
	// version -> published path ("SHA256SUMS", "SHA256SUMS.sig",
	// "<os>-<arch>/<file>") -> content.
	Releases      map[string]map[string][]byte
	ReleaseGets   []string
	FailNextCalls map[string]int // path -> number of 503 answers still to give

	// Recorded traffic.
	Enrollments []api.EnrollRequest
	Heartbeats  []api.HeartbeatRequest
	ConfigGets  int
	Runs        map[string]*Run
	AuthFailed  int

	pendingTasks []api.Task
	nextRun      int
}

// Run is a run as the server saw it.
type Run struct {
	ID       string
	Start    api.StartRunRequest
	Progress []api.Progress
	Finish   *api.FinishRequest
	Finishes int
}

// Options configures NewWithOptions.
type Options struct {
	// TLS selects HTTPS with the httptest certificate (use Server.Client() for
	// a trusting client).
	TLS bool
	// Listen is a host:port to listen on; empty picks a free port.
	Listen string
	// Extra registers additional handlers on the same server.
	Extra func(mux *http.ServeMux)
	// NoReleases leaves /install/agent/ to Extra (fakeinstance serves a dist folder).
	NoReleases bool
}

// New starts a fake server. tls selects HTTPS (with the httptest certificate;
// use Server.Client() for a trusting client) or plain HTTP.
func New(useTLS bool) *Server { return NewWithOptions(Options{TLS: useTLS}) }

// NewWithOptions starts a fake server with the given options.
func NewWithOptions(o Options) *Server {
	useTLS := o.TLS
	s := &Server{
		EnrollToken:   "rset_test_token_0123456789",
		EndpointID:    "ep-0001",
		AgentSecret:   "rsea_test_secret_0123456789",
		RepoPassword:  "repo-password-0123456789",
		Runs:          map[string]*Run{},
		FailNextCalls: map[string]int{},
		Releases:      map[string]map[string][]byte{},
		Config: api.Config{
			Profile:       api.ProfileServer,
			Schedule:      api.Schedule{Kind: api.ScheduleInterval, IntervalMinutes: 60, TimeZone: "UTC"},
			Paths:         []string{"/etc"},
			Excludes:      []string{},
			ConfigVersion: "1",
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/agent/v1/enroll", s.handleEnroll)
	mux.HandleFunc("/agent/v1/config", s.auth(s.handleConfig))
	mux.HandleFunc("/agent/v1/heartbeat", s.auth(s.handleHeartbeat))
	mux.HandleFunc("/agent/v1/runs", s.auth(s.handleRuns))
	mux.HandleFunc("/agent/v1/runs/", s.auth(s.handleRunSub))
	mux.HandleFunc("/agent/v1/update", s.auth(s.handleUpdate))
	if !o.NoReleases {
		mux.HandleFunc("/install/agent/", s.handleRelease)
	}
	if o.Extra != nil {
		o.Extra(mux)
	}
	hs := httptest.NewUnstartedServer(mux)
	if o.Listen != "" {
		_ = hs.Listener.Close()
		ln, err := net.Listen("tcp", o.Listen)
		if err != nil {
			panic(err)
		}
		hs.Listener = ln
	}
	if useTLS {
		hs.StartTLS()
	} else {
		hs.Start()
	}
	s.Server = hs
	s.RepoURL = "rest:" + s.URL + "/agent/restic/" + s.EndpointID + "/"
	return s
}

// SetEnrollToken installs a fresh single-use enrollment token.
func (s *Server) SetEnrollToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.EnrollToken = token
}

// Lock and Unlock guard reads of recorded state from tests.
func (s *Server) Lock()   { s.mu.Lock() }
func (s *Server) Unlock() { s.mu.Unlock() }

// RegisterRun creates a run as if the agent had started it earlier.
func (s *Server) RegisterRun(kind string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextRun++
	id := fmt.Sprintf("run-%d", s.nextRun)
	s.Runs[id] = &Run{ID: id, Start: api.StartRunRequest{Kind: kind, StartedAt: time.Now()}}
	return id
}

// QueueTask adds a task delivered with the next heartbeat.
func (s *Server) QueueTask(t api.Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pendingTasks = append(s.pendingTasks, t)
}

// Run returns a snapshot pointer of a recorded run (nil if unknown).
func (s *Server) RunByID(id string) *Run {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Runs[id]
}

// AllRuns returns the runs in creation order of their ids.
func (s *Server) AllRuns() []*Run {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Run, 0, len(s.Runs))
	for i := 1; i <= s.nextRun; i++ {
		if r, ok := s.Runs[fmt.Sprintf("run-%d", i)]; ok {
			out = append(out, r)
		}
	}
	return out
}

// HeartbeatCount returns the number of heartbeats received.
func (s *Server) HeartbeatCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.Heartbeats)
}

func problem(w http.ResponseWriter, status int, title, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "urn:restow:problem:test", "title": title, "status": status, "detail": detail,
	})
}

func (s *Server) failInjected(w http.ResponseWriter, r *http.Request) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := s.FailNextCalls[r.URL.Path]; n > 0 {
		s.FailNextCalls[r.URL.Path] = n - 1
		w.Header().Set("Retry-After", "0")
		problem(w, http.StatusServiceUnavailable, "Service Unavailable", "injected")
		return true
	}
	return false
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != s.EndpointID || pass != s.AgentSecret {
			s.mu.Lock()
			s.AuthFailed++
			s.mu.Unlock()
			problem(w, http.StatusUnauthorized, "Unauthorized", "bad agent credentials")
			return
		}
		if s.failInjected(w, r) {
			return
		}
		next(w, r)
	}
}

func (s *Server) handleEnroll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "Method Not Allowed", "")
		return
	}
	if s.failInjected(w, r) {
		return
	}
	var req api.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		problem(w, http.StatusBadRequest, "Bad Request", err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Token != s.EnrollToken {
		problem(w, http.StatusUnauthorized, "Invalid enrollment token", "The token is unknown, expired or already used.")
		return
	}
	s.Enrollments = append(s.Enrollments, req)
	// Single use.
	s.EnrollToken = ""
	cfg := s.Config
	resp := api.EnrollResponse{
		EndpointID:  api.Flex(s.EndpointID),
		AgentSecret: s.AgentSecret,
		Repository:  api.Repository{URL: s.RepoURL, Password: s.RepoPassword},
		Config:      &cfg,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.ConfigGets++
	cfg := s.Config
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(cfg)
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req api.HeartbeatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		problem(w, http.StatusBadRequest, "Bad Request", err.Error())
		return
	}
	s.mu.Lock()
	s.Heartbeats = append(s.Heartbeats, req)
	tasks := s.pendingTasks
	s.pendingTasks = nil
	s.mu.Unlock()
	if tasks == nil {
		tasks = []api.Task{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(api.HeartbeatResponse{Tasks: tasks})
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	var req api.StartRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		problem(w, http.StatusBadRequest, "Bad Request", err.Error())
		return
	}
	s.mu.Lock()
	s.nextRun++
	id := fmt.Sprintf("run-%d", s.nextRun)
	s.Runs[id] = &Run{ID: id, Start: req}
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(api.StartRunResponse{RunID: api.Flex(id)})
}

func (s *Server) handleRunSub(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/agent/v1/runs/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		problem(w, http.StatusNotFound, "Not Found", "")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.Runs[parts[0]]
	if !ok {
		problem(w, http.StatusNotFound, "Not Found", "unknown run")
		return
	}
	switch parts[1] {
	case "progress":
		var p api.Progress
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			problem(w, http.StatusBadRequest, "Bad Request", err.Error())
			return
		}
		run.Progress = append(run.Progress, p)
		w.WriteHeader(http.StatusNoContent)
	case "finish":
		var f api.FinishRequest
		if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
			problem(w, http.StatusBadRequest, "Bad Request", err.Error())
			return
		}
		run.Finishes++
		if run.Finish != nil {
			problem(w, http.StatusConflict, "Conflict", "run already finished")
			return
		}
		run.Finish = &f
		w.WriteHeader(http.StatusNoContent)
	default:
		problem(w, http.StatusNotFound, "Not Found", "")
	}
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	info := s.Update
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if info == nil {
		_, _ = io.WriteString(w, "null")
		return
	}
	_ = json.NewEncoder(w).Encode(info)
}

func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/install/agent/")
	version, file, _ := strings.Cut(rest, "/")
	s.mu.Lock()
	s.ReleaseGets = append(s.ReleaseGets, rest)
	content, ok := s.Releases[version][file]
	s.mu.Unlock()
	if !ok {
		problem(w, http.StatusNotFound, "Not Found", "No such file.")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(content)
}

// SetRelease serves an agent release: files maps `<os>-<arch>/<file>` to the
// content. SHA256SUMS over all files is generated and, with a key, signed
// the way the maintainer signs (SSHSIG); priv nil leaves the release unsigned.
func (s *Server) SetRelease(version string, files map[string][]byte, priv ed25519.PrivateKey) {
	published := map[string][]byte{}
	var sums strings.Builder
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		sum := sha256.Sum256(files[name])
		fmt.Fprintf(&sums, "%s  %s\n", hex.EncodeToString(sum[:]), name)
		published[name] = files[name]
	}
	published["SHA256SUMS"] = []byte(sums.String())
	if priv != nil {
		published["SHA256SUMS.sig"] = release.Sign(priv, published["SHA256SUMS"])
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Releases[version] = published
}

// SetUpdate announces version as the available update of the agent for
// target, with the SHA-256 of binary (the release itself comes from SetRelease).
func (s *Server) SetUpdate(version, target string, binary []byte) {
	sum := sha256.Sum256(binary)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Update = &api.UpdateInfo{Version: version, URL: "/install/agent/" + version + "/" + target + "/restow-agent", SHA256: hex.EncodeToString(sum[:])}
}

// WaitFor polls cond until it is true or the timeout expires.
func WaitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}
