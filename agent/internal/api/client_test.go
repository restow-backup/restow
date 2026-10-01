package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func noSleep(context.Context, time.Duration) error { return nil }

func newClient(t *testing.T, s *fakeserver.Server) *api.Client {
	t.Helper()
	c, err := api.New(api.Options{
		BaseURL: s.URL, EndpointID: s.EndpointID, AgentSecret: s.AgentSecret,
		HTTPClient: s.Client(), Sleep: noSleep,
		Retry: api.RetryPolicy{MaxAttempts: 4, BaseDelay: time.Millisecond, MaxDelay: time.Millisecond},
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestParseBaseURL(t *testing.T) {
	good := map[string]string{
		"https://restow.example.com":       "https://restow.example.com",
		"https://restow.example.com/":      "https://restow.example.com",
		"https://restow.example.com:8443/": "https://restow.example.com:8443",
		"https://host/sub/path/":           "https://host/sub/path",
	}
	for in, want := range good {
		u, err := api.ParseBaseURL(in, false)
		if err != nil || u.String() != want {
			t.Errorf("ParseBaseURL(%q) = %v, %v; want %s", in, u, err, want)
		}
	}
	bad := []string{"http://restow.example.com", "ftp://x", "restow.example.com", "https://", "https://u:p@host", "https://host?x=1", ""}
	for _, in := range bad {
		if _, err := api.ParseBaseURL(in, false); err == nil {
			t.Errorf("ParseBaseURL(%q) must fail", in)
		}
	}
	if _, err := api.ParseBaseURL("http://127.0.0.1:8080", true); err != nil {
		t.Errorf("http must be accepted with the dev flag: %v", err)
	}
	_, err := api.ParseBaseURL("http://restow.example.com", false)
	if err == nil || !strings.Contains(err.Error(), "only talks HTTPS") {
		t.Errorf("plain http error must explain itself: %v", err)
	}
}

func TestNewRefusesPlainHTTP(t *testing.T) {
	s := fakeserver.New(false)
	defer s.Close()
	if _, err := api.New(api.Options{BaseURL: s.URL, EndpointID: "a", AgentSecret: "b"}); err == nil {
		t.Fatal("plain http must be refused without the dev flag")
	}
	if _, err := api.New(api.Options{BaseURL: s.URL, EndpointID: "a", AgentSecret: "b", AllowInsecureHTTP: true}); err != nil {
		t.Fatalf("dev flag: %v", err)
	}
}

func TestEnrollAndAuthenticatedCalls(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	// Enroll uses its own client; point the default transport at the test CA
	// by going through a client built from the server's.
	ctx := context.Background()
	c := newClient(t, s)

	// Enroll is not authenticated and goes through api.Enroll (default HTTP
	// client), which does not trust the httptest CA; exercise the same code
	// through a plain-HTTP fake instead.
	plain := fakeserver.New(false)
	defer plain.Close()
	resp, err := api.Enroll(ctx, plain.URL, true, api.EnrollRequest{
		Token: plain.EnrollToken, Hostname: "web01", OS: "linux", Arch: "amd64", AgentVersion: "0.1.0", OSVersion: "Debian 12",
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.EndpointID != "ep-0001" || !strings.HasPrefix(resp.AgentSecret, "rsea_") || resp.Repository.Password == "" || resp.Config == nil {
		t.Fatalf("unexpected enroll response: %+v", resp)
	}
	if len(plain.Enrollments) != 1 || plain.Enrollments[0].Hostname != "web01" {
		t.Fatalf("server did not see the enrollment: %+v", plain.Enrollments)
	}
	// Token is single use.
	_, err = api.Enroll(ctx, plain.URL, true, api.EnrollRequest{Token: "rset_test_token_0123456789"})
	var ae *api.APIError
	if !errors.As(err, &ae) || ae.Status != 401 || ae.Title != "Invalid enrollment token" {
		t.Fatalf("second enroll: err = %v", err)
	}

	// Authenticated calls.
	cfg, err := c.Config(ctx)
	if err != nil || cfg.Profile != "server" || cfg.ConfigVersion != "1" {
		t.Fatalf("Config: %+v %v", cfg, err)
	}
	hb, err := c.Heartbeat(ctx, api.HeartbeatRequest{AgentVersion: "0.1.0", State: "idle", ConfigVersion: "1"})
	if err != nil || len(hb.Tasks) != 0 {
		t.Fatalf("Heartbeat: %+v %v", hb, err)
	}
	s.QueueTask(api.Task{ID: "t1", Kind: api.TaskBackupNow})
	hb, err = c.Heartbeat(ctx, api.HeartbeatRequest{State: "idle"})
	if err != nil || len(hb.Tasks) != 1 || hb.Tasks[0].Kind != api.TaskBackupNow {
		t.Fatalf("Heartbeat tasks: %+v %v", hb, err)
	}
	runID, err := c.StartRun(ctx, api.StartRunRequest{Kind: api.RunBackup, StartedAt: time.Now()})
	if err != nil || runID == "" {
		t.Fatalf("StartRun: %v %v", runID, err)
	}
	total := uint64(10)
	if err := c.SendProgress(ctx, runID, api.Progress{FilesDone: 3, BytesDone: 30, TotalFiles: &total}); err != nil {
		t.Fatal(err)
	}
	if err := c.FinishRun(ctx, runID, api.FinishRequest{Status: api.StatusSucceeded, FinishedAt: time.Now(), LogTail: "ok"}); err != nil {
		t.Fatal(err)
	}
	run := s.RunByID(runID.String())
	if run == nil || len(run.Progress) != 1 || run.Finish == nil || run.Finish.Status != "succeeded" {
		t.Fatalf("server state: %+v", run)
	}
	if run.Finish.Errors == nil {
		t.Fatal("errors must always be sent as an array")
	}
	// Finishing twice is harmless (server answers 409).
	if err := c.FinishRun(ctx, runID, api.FinishRequest{Status: api.StatusSucceeded, FinishedAt: time.Now()}); err != nil {
		t.Fatalf("repeated finish must be tolerated: %v", err)
	}
}

func TestAuthFailure(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	c, _ := api.New(api.Options{BaseURL: s.URL, EndpointID: s.EndpointID, AgentSecret: "wrong", HTTPClient: s.Client(), Sleep: noSleep})
	_, err := c.Config(context.Background())
	if !api.IsAuthError(err) || !api.IsServerReachable(err) || api.IsNetworkError(err) {
		t.Fatalf("expected auth error, got %v", err)
	}
	msg := api.Explain(err, s.URL)
	if !strings.Contains(msg, "revoked") || !strings.Contains(msg, "install command again") {
		t.Fatalf("explanation lacks guidance: %s", msg)
	}
	if s.AuthFailed != 1 {
		t.Fatalf("a rejected credential must not be retried: %d attempts", s.AuthFailed)
	}
}

func TestRetryOn503ThenSuccess(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	s.FailNextCalls["/agent/v1/config"] = 2
	c := newClient(t, s)
	cfg, err := c.Config(context.Background())
	if err != nil || cfg == nil {
		t.Fatalf("expected success after retries: %v", err)
	}
	if s.ConfigGets != 1 {
		t.Fatalf("handler ran %d times", s.ConfigGets)
	}
}

func TestRetryGivesUp(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	s.FailNextCalls["/agent/v1/config"] = 100
	c := newClient(t, s)
	_, err := c.Config(context.Background())
	var ae *api.APIError
	if !errors.As(err, &ae) || ae.Status != 503 {
		t.Fatalf("err = %v", err)
	}
	if left := s.FailNextCalls["/agent/v1/config"]; left != 96 {
		t.Fatalf("expected 4 attempts, %d injected failures left", left)
	}
}

func TestNonIdempotentNotRetriedAfter500(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(500)
	}))
	defer srv.Close()
	c, _ := api.New(api.Options{BaseURL: srv.URL, EndpointID: "a", AgentSecret: "b", HTTPClient: srv.Client(), Sleep: noSleep})
	if _, err := c.StartRun(context.Background(), api.StartRunRequest{Kind: "backup", StartedAt: time.Now()}); err == nil {
		t.Fatal("expected error")
	}
	if calls.Load() != 1 {
		t.Fatalf("POST /runs must not be retried after a 500 (could duplicate the run): %d calls", calls.Load())
	}
}

func TestRetryAfterHeaderHonoured(t *testing.T) {
	var calls atomic.Int32
	var slept []time.Duration
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
			return
		}
		_, _ = w.Write([]byte(`{"profile":"client"}`))
	}))
	defer srv.Close()
	c, _ := api.New(api.Options{BaseURL: srv.URL, EndpointID: "a", AgentSecret: "b", HTTPClient: srv.Client(),
		Sleep: func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil }})
	cfg, err := c.Config(context.Background())
	if err != nil || cfg.Profile != "client" {
		t.Fatal(err)
	}
	if len(slept) != 1 || slept[0] != 7*time.Second {
		t.Fatalf("slept %v, want [7s]", slept)
	}
}

func TestContextCancelStopsRetries(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	s.FailNextCalls["/agent/v1/config"] = 100
	c, _ := api.New(api.Options{BaseURL: s.URL, EndpointID: s.EndpointID, AgentSecret: s.AgentSecret, HTTPClient: s.Client(),
		Sleep: func(ctx context.Context, d time.Duration) error { return context.Canceled }})
	if _, err := c.Config(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

func TestProblemJSONParsed(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(422)
		_, _ = w.Write([]byte(`{"type":"urn:restow:problem:validation","title":"Unprocessable","detail":"kind is invalid"}`))
	}))
	defer srv.Close()
	c, _ := api.New(api.Options{BaseURL: srv.URL, EndpointID: "a", AgentSecret: "b", HTTPClient: srv.Client(), Sleep: noSleep})
	_, err := c.Config(context.Background())
	var ae *api.APIError
	if !errors.As(err, &ae) || ae.Type != "urn:restow:problem:validation" || ae.Detail != "kind is invalid" {
		t.Fatalf("problem+json not parsed: %#v", err)
	}
}

func TestCheckUpdate(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	c := newClient(t, s)
	info, err := c.CheckUpdate(context.Background())
	if err != nil || info != nil {
		t.Fatalf("no update expected: %+v %v", info, err)
	}
	s.SetRelease("0.2.0", map[string][]byte{"linux-amd64/restow-agent": []byte("binary-content")}, nil)
	s.SetUpdate("0.2.0", "linux-amd64", []byte("binary-content"))
	info, err = c.CheckUpdate(context.Background())
	if err != nil || info == nil || info.Version != "0.2.0" {
		t.Fatalf("update expected: %+v %v", info, err)
	}
	var buf strings.Builder
	sum, err := c.Download(context.Background(), info.URL, &buf, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte("binary-content"))
	if sum != hex.EncodeToString(want[:]) || sum != info.SHA256 || buf.String() != "binary-content" {
		t.Fatalf("download mismatch: %s", sum)
	}
	if _, err := c.Download(context.Background(), info.URL, &buf, 5); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("size limit: %v", err)
	}
}

func TestResolveSameOrigin(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	c := newClient(t, s)
	if u, err := c.ResolveSameOrigin("/install/agent/0.2.0/linux-amd64/restow-agent"); err != nil || u.Host != strings.TrimPrefix(s.URL, "https://") {
		t.Fatalf("relative: %v %v", u, err)
	}
	if _, err := c.ResolveSameOrigin("https://evil.example.com/restow-agent"); err == nil {
		t.Fatal("cross-host download must be refused")
	}
	if _, err := c.ResolveSameOrigin("http://" + strings.TrimPrefix(s.URL, "https://") + "/x"); err == nil {
		t.Fatal("scheme downgrade must be refused")
	}
}

func TestFlexTypes(t *testing.T) {
	var tk api.Task
	if err := jsonUnmarshal(`{"id":12,"kind":"backup_now"}`, &tk); err != nil || tk.ID != "12" {
		t.Fatalf("numeric id: %+v %v", tk, err)
	}
	if err := jsonUnmarshal(`{"id":"abc","kind":"restore","params":{"snapshotId":"x"}}`, &tk); err != nil || tk.ID != "abc" {
		t.Fatalf("string id: %+v %v", tk, err)
	}
	var cfg api.Config
	if err := jsonUnmarshal(`{"configVersion":7,"bandwidthKbps":null,"hooks":{"pre":null}}`, &cfg); err != nil || cfg.ConfigVersion != "7" || cfg.BandwidthKbps != nil {
		t.Fatalf("config: %+v %v", cfg, err)
	}
}

func TestExplainNetworkErrors(t *testing.T) {
	// Connection refused: nothing listens on the port of a closed server.
	s := fakeserver.New(true)
	url := s.URL
	s.Close()
	c, _ := api.New(api.Options{BaseURL: url, EndpointID: "a", AgentSecret: "b", HTTPClient: s.Client(), Sleep: noSleep,
		Retry: api.RetryPolicy{MaxAttempts: 1}})
	_, err := c.Config(context.Background())
	if err == nil || !api.IsNetworkError(err) {
		t.Fatalf("expected network error: %v", err)
	}
	if msg := api.Explain(err, url); !strings.Contains(msg, "refused") || !strings.Contains(msg, "outbound HTTPS") {
		t.Fatalf("explanation: %s", msg)
	}
	// Untrusted certificate: the default client does not know the test CA.
	s2 := fakeserver.New(true)
	defer s2.Close()
	c2, _ := api.New(api.Options{BaseURL: s2.URL, EndpointID: "a", AgentSecret: "b", Sleep: noSleep, Retry: api.RetryPolicy{MaxAttempts: 1}})
	_, err = c2.Config(context.Background())
	if err == nil {
		t.Fatal("untrusted certificate must fail")
	}
	if msg := api.Explain(err, s2.URL); !strings.Contains(msg, "not trusted") {
		t.Fatalf("explanation: %s", msg)
	}
}

func TestRedirectDowngradeRefused(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer plain.Close()
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+"/agent/v1/config", http.StatusFound)
	}))
	defer tlsSrv.Close()
	hc := api.NewHTTPClient(false)
	hc.Transport = tlsSrv.Client().Transport
	c, _ := api.New(api.Options{BaseURL: tlsSrv.URL, EndpointID: "a", AgentSecret: "b", HTTPClient: hc, Sleep: noSleep,
		Retry: api.RetryPolicy{MaxAttempts: 1}})
	_, err := c.Config(context.Background())
	if err == nil || !strings.Contains(err.Error(), "non-HTTPS") {
		t.Fatalf("redirect to http must be refused: %v", err)
	}
}
