package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// fakeRecovery follows the wire contract of the recovery API
// (docs/BAREMETAL.md 9.3 to 9.8 and 11; the M3 contract in section 26).
type fakeRecovery struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	codeHash   string // HashCodeProof of the valid proof
	sessionID  string
	secretSHA  string
	status     string
	repoURL    string // overrides the repository URL of the credentials
	seen       []string
	bodies     []string
	logLines   []string
	progress   []api.RecoveryProgress
	events     []api.RecoveryEvent
	finish     *api.RecoveryFinish
	rebind     *api.RecoveryRebindRequest
	fail503    int    // 503 answers with Retry-After still to give for the next call
	failNoRA   bool   // the next call gets 503 without Retry-After
	credsCalls int    // credential fetches
	cacheCtl   string // Cache-Control of the last request
}

func newFakeRecovery(t *testing.T, origin, code string) *fakeRecovery {
	f := &fakeRecovery{t: t, sessionID: "5b1f0c2e-8f7a-4d7e-9a43-1c2d3e4f5a6b", status: api.RecoveryPendingApproval}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	if origin == "" {
		origin = f.srv.URL
	}
	f.codeHash = HashCodeProof(CodeProof(origin, code))
	return f
}

func problem(w http.ResponseWriter, status int, name, title string) {
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"type": ProblemPrefix + name, "title": title, "status": status, "detail": title})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// isoTextOK is the instance's isoText rule (noControlChars in
// packages/core/src/endpoints/baremetal/canonical.ts): no C0 or C1 control
// character, no line or paragraph separator.
func isoTextOK(values ...string) bool {
	for _, v := range values {
		for _, r := range v {
			if r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0x2028 || r == 0x2029 {
				return false
			}
		}
	}
	return true
}

// fakeBodyLimit is the instance's body limit of a recovery route.
func fakeBodyLimit(path string) int {
	switch path {
	case CurrentPath + "/log":
		return api.RecoveryMaxLogBody
	case CurrentPath + "/finish":
		return api.RecoveryMaxFinishBody
	default:
		return 64 << 10
	}
}

func (f *fakeRecovery) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	f.seen = append(f.seen, r.Method+" "+r.URL.Path)
	f.bodies = append(f.bodies, string(body))
	f.cacheCtl = r.Header.Get("Cache-Control")
	// The request size limits of apps/api/src/middleware/body-limit.ts,
	// checked before anything else.
	if len(body) > fakeBodyLimit(r.URL.Path) {
		problem(w, http.StatusRequestEntityTooLarge, "payload-too-large", "Payload Too Large")
		return
	}
	if f.fail503 > 0 {
		f.fail503--
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusServiceUnavailable, ProblemRepositoryLocked, "The repository is busy")
		return
	}
	if f.failNoRA {
		f.failNoRA = false
		problem(w, http.StatusServiceUnavailable, "unavailable", "Service Unavailable")
		return
	}
	if r.URL.Path == SessionsPath {
		f.exchange(w, r, body)
		return
	}
	user, pass, ok := r.BasicAuth()
	if !ok || user != f.sessionID || SessionSecretSHA256(pass) != f.secretSHA {
		problem(w, http.StatusUnauthorized, ProblemSessionEnded, "The recovery session has ended")
		return
	}
	route := r.Method + " " + strings.TrimPrefix(r.URL.Path, CurrentPath)
	switch route {
	case "GET ":
		writeJSON(w, 200, api.RecoverySessionState{SessionID: f.sessionID, Status: f.status,
			ExpiresAt: time.Date(2026, 11, 5, 14, 0, 0, 0, time.UTC), Approved: f.status != api.RecoveryPendingApproval})
	case "GET /credentials":
		if f.status == api.RecoveryPendingApproval {
			problem(w, 409, ProblemNotApproved, "Not approved yet")
			return
		}
		f.credsCalls++
		if f.credsCalls > 2 {
			problem(w, 409, ProblemCredentialsCollected, "The credentials were collected")
			return
		}
		repo := f.repoURL
		if repo == "" {
			repo = "rest:" + f.srv.URL + ResticPathPrefix + f.sessionID + "/"
		}
		writeJSON(w, 200, map[string]any{
			"repository":   map[string]string{"url": repo, "password": "repo-password-for-recovery-0123"},
			"snapshotId":   strings.Repeat("ab", 32),
			"layoutSha256": strings.Repeat("cd", 32),
			"snapshots": []map[string]any{{"id": strings.Repeat("ab", 32), "time": "2026-11-04T22:00:00.000Z",
				"layoutSha256": strings.Repeat("cd", 32), "check": "passed"}},
			"indexBytes":         12345678,
			"restoreSizes":       map[string]any{"/": map[string]int64{"bytes": 1, "files": 2, "inodes": 3}},
			"minRecoveryVersion": "0.5.0",
		})
	case "GET /ssh-keys":
		writeJSON(w, 200, map[string]any{"keys": []string{"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin"}})
	case "POST /progress":
		var p api.RecoveryProgress
		if json.Unmarshal(body, &p) != nil {
			problem(w, 400, "validation", "bad body")
			return
		}
		texts := []string{p.Message}
		for _, k := range p.SSHHostKeys {
			texts = append(texts, k.Type, k.Fingerprint)
		}
		if !isoTextOK(texts...) {
			problem(w, 422, "validation", "control character in string")
			return
		}
		f.progress = append(f.progress, p)
		w.WriteHeader(http.StatusNoContent)
	case "POST /log":
		var l api.RecoveryLog
		if json.Unmarshal(body, &l) != nil || len(l.Lines) > api.RecoveryMaxLogLines {
			problem(w, 400, "validation", "bad body")
			return
		}
		for _, line := range l.Lines {
			if utf16Len(line) > api.RecoveryMaxLogLine {
				problem(w, 422, "validation", "line too long")
				return
			}
		}
		f.logLines = append(f.logLines, l.Lines...)
		writeJSON(w, http.StatusAccepted, api.RecoveryLogResult{Accepted: len(l.Lines)})
	case "POST /event":
		var e api.RecoveryEvent
		if json.Unmarshal(body, &e) != nil {
			problem(w, 400, "validation", "bad body")
			return
		}
		for _, v := range e.Detail {
			if !isoTextOK(v) || utf16Len(v) > 1024 {
				problem(w, 422, "validation", "control character in string")
				return
			}
		}
		f.events = append(f.events, e)
		w.WriteHeader(http.StatusNoContent)
	case "POST /release":
		if f.status != api.RecoveryActive && f.status != api.RecoveryFinishing {
			problem(w, 409, ProblemStateConflict, "Not active")
			return
		}
		f.status = api.RecoveryFinishing
		writeJSON(w, 200, api.RecoveryStatus{Status: f.status})
	case "POST /finish":
		var fin api.RecoveryFinish
		if json.Unmarshal(body, &fin) != nil || len(fin.Warnings) > api.RecoveryMaxFinishWarning {
			problem(w, 400, "validation", "bad body")
			return
		}
		for _, warning := range fin.Warnings {
			if utf16Len(warning.Code) > api.RecoveryMaxWarningCode || utf16Len(warning.Message) > api.RecoveryMaxWarningMessage {
				problem(w, 422, "validation", "warning too long")
				return
			}
			if !isoTextOK(warning.Code, warning.Message) {
				problem(w, 422, "validation", "control character in string")
				return
			}
		}
		f.finish = &fin
		f.status = fin.Status
		writeJSON(w, 200, api.RecoveryStatus{Status: f.status})
	case "POST /rebind":
		var rb api.RecoveryRebindRequest
		if json.Unmarshal(body, &rb) != nil {
			problem(w, 400, "validation", "bad body")
			return
		}
		if f.status != api.RecoverySucceeded {
			problem(w, 409, ProblemStateConflict, "Not finished")
			return
		}
		f.rebind = &rb
		writeJSON(w, http.StatusCreated, map[string]any{
			"endpointId": "0d7a4b8e-1111-4c2d-9e3f-222233334444", "agentSecret": "rsea_new_secret_after_rebind_0123",
			"repository": map[string]string{"url": "rest:" + f.srv.URL + "/agent/restic/0d7a4b8e-1111-4c2d-9e3f-222233334444/", "password": "repo-password-agent-0123"},
			"config":     map[string]any{"profile": "server", "schedule": map[string]any{"kind": "daily", "timeOfDay": "22:00"}, "paths": []string{}, "excludes": []string{}, "hooks": map[string]any{}, "configVersion": 3},
			"restic":     map[string]string{"version": "0.19.1"}, "rebound": true,
		})
	default:
		problem(w, 404, "not-found", "Not Found")
	}
}

func (f *fakeRecovery) exchange(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.Method != http.MethodPost {
		problem(w, 405, "method-not-allowed", "Method Not Allowed")
		return
	}
	if _, _, ok := r.BasicAuth(); ok {
		f.t.Error("the exchange must not carry Basic credentials")
	}
	var req api.RecoveryExchangeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		problem(w, 400, "validation", "bad body")
		return
	}
	for _, d := range req.Hardware.Disks {
		if !isoTextOK(d.Model, d.Serial, d.WWN, d.Transport) {
			problem(w, 422, "validation", "control character in string")
			return
		}
	}
	for _, n := range req.Hardware.NICs {
		if !isoTextOK(n.MAC, n.Driver) {
			problem(w, 422, "validation", "control character in string")
			return
		}
	}
	if HashCodeProof(req.CodeProof) != f.codeHash {
		problem(w, 401, ProblemCodeInvalid, "Recovery code invalid")
		return
	}
	if f.secretSHA != "" && f.secretSHA != req.SessionSecretSHA256 {
		problem(w, 409, ProblemCodeUsed, "The recovery code was used")
		return
	}
	f.secretSHA = req.SessionSecretSHA256
	writeJSON(w, http.StatusAccepted, map[string]any{
		"sessionId": f.sessionID, "status": f.status, "matchCode": MatchCode(req.SessionSecretSHA256),
		"expiresAt":          "2026-11-05T14:00:00.000Z",
		"endpoint":           map[string]string{"id": "0d7a4b8e-1111-4c2d-9e3f-222233334444", "hostname": "web01", "displayName": "Web 01", "os": "linux"},
		"minRecoveryVersion": "0.5.0",
	})
}

const testCode = "7K3QXM9P2DH4TNV8WRBCJ6FAS"

func newTestSession(t *testing.T, f *fakeRecovery) *Session {
	t.Helper()
	s, err := NewSession(f.srv.URL, true, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	s.Sleep = func(context.Context, time.Duration) error { return nil }
	return s
}

func exchangeRequest(s *Session) api.RecoveryExchangeRequest {
	yes := true
	return api.RecoveryExchangeRequest{
		CodeProof: CodeProof(s.BaseURL, testCode), RecoveryVersion: "0.5.0",
		Hardware: api.RecoveryHardware{Firmware: api.FirmwareUEFI, SecureBoot: &yes, RAMBytes: 17179869184,
			Disks: []api.RecoveryDisk{{SizeBytes: 1000204886016, LogicalSectorSize: 512, Model: "Disk", Transport: "nvme"}},
			NICs:  []api.RecoveryNIC{{MAC: "52:54:00:12:34:56", Driver: "virtio_net", Link: true}}},
	}
}

func TestSessionFullFlow(t *testing.T) {
	f := newFakeRecovery(t, "", testCode)
	s := newTestSession(t, f)
	ctx := context.Background()

	if _, err := s.Current(ctx); err == nil {
		t.Fatal("a session route without a session id must fail before the network")
	}
	ex, err := s.Exchange(ctx, exchangeRequest(s))
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != f.sessionID || ex.Status != api.RecoveryPendingApproval || ex.MatchCode != s.MatchCode() ||
		ex.Endpoint.Hostname != "web01" || ex.MinRecoveryVersion != "0.5.0" || !ex.ExpiresAt.Equal(time.Date(2026, 11, 5, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("exchange answer %+v", ex)
	}
	// The exchange body carries the proof and the secret's hash, never the code or the secret.
	var sent map[string]any
	if err := json.Unmarshal([]byte(f.bodies[0]), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["sessionSecretSha256"] != s.SecretSHA256() || sent["codeProof"] != CodeProof(f.srv.URL, testCode) {
		t.Fatalf("exchange body %s", f.bodies[0])
	}
	hw := sent["hardware"].(map[string]any)
	if hw["secureBoot"] != true || len(hw["disks"].([]any)) != 1 || hw["firmware"] != "uefi" {
		t.Fatalf("hardware %v", hw)
	}
	if f.cacheCtl != "no-store" {
		t.Fatalf("Cache-Control %q", f.cacheCtl)
	}

	st, err := s.Current(ctx)
	if err != nil || st.Status != api.RecoveryPendingApproval || st.Approved {
		t.Fatalf("current: %+v %v", st, err)
	}
	if _, err := s.Credentials(ctx); !IsProblem(err, ProblemNotApproved) {
		t.Fatalf("credentials before approval: %v", err)
	}
	var ae *api.APIError
	if _, err := s.Credentials(ctx); !errors.As(err, &ae) || ae.Status != 409 || ae.Path != CurrentPath+"/credentials" {
		t.Fatalf("problem not decoded: %#v", err)
	}

	f.mu.Lock()
	f.status = api.RecoveryActive
	f.mu.Unlock()
	cr, err := s.Credentials(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cr.Repository.URL != s.ResticRepository() || cr.IndexBytes != 12345678 || cr.RestoreSizes["/"].Inodes != 3 ||
		len(cr.Snapshots) != 1 || cr.Snapshots[0].Check != "passed" || cr.LayoutSHA256 != strings.Repeat("cd", 32) {
		t.Fatalf("credentials %+v", cr)
	}
	if got := redact.Redact("password repo-password-for-recovery-0123"); strings.Contains(got, "repo-password-for-recovery") {
		t.Fatalf("the repository password is not redacted: %q", got)
	}
	keys, err := s.SSHKeys(ctx)
	if err != nil || len(keys) != 1 || !strings.HasPrefix(keys[0], "ssh-ed25519 ") {
		t.Fatalf("ssh keys %v %v", keys, err)
	}

	if err := s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseRestoring, Step: 3, StepsTotal: 40,
		Message: strings.Repeat("ä", 600), SSHHostKeys: []api.RecoverySSHHostKey{{Type: "ssh-ed25519", Fingerprint: "SHA256:abc"}}}); err != nil {
		t.Fatal(err)
	}
	if p := f.progress[0]; len([]rune(p.Message)) != api.RecoveryMaxMessage || p.Step != 3 || len(p.SSHHostKeys) != 1 {
		t.Fatalf("progress %+v", p)
	}

	lines := make([]string, 450)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %d", i)
	}
	lines[7] = "using code RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS and secret " + s.Secret
	lines[8] = strings.Repeat("x", 5000)
	res, err := s.Log(ctx, lines)
	if err != nil || res.Accepted != 450 || len(f.logLines) != 450 {
		t.Fatalf("log %+v %v (%d lines)", res, err, len(f.logLines))
	}
	if strings.Contains(f.logLines[7], s.Secret) || strings.Contains(f.logLines[7], "7K3QX") || len(f.logLines[8]) != api.RecoveryMaxLogLine {
		t.Fatalf("log lines not redacted or cut: %q (%d)", f.logLines[7], len(f.logLines[8]))
	}

	if err := s.Event(ctx, api.RecoveryEventRemoteAccessEnabled, map[string]string{"port": "22"}); err != nil {
		t.Fatal(err)
	}
	if len(f.events) != 1 || f.events[0].Kind != "remote_access_enabled" || f.events[0].Detail["port"] != "22" {
		t.Fatalf("events %+v", f.events)
	}

	if status, err := s.Release(ctx); err != nil || status != api.RecoveryFinishing {
		t.Fatalf("release %q %v", status, err)
	}
	if status, err := s.Release(ctx); err != nil || status != api.RecoveryFinishing {
		t.Fatalf("release again %q %v", status, err)
	}

	if _, err := s.Rebind(ctx, api.RecoveryRebindRequest{Token: "rset_rebind_token_0123456789"}); !IsProblem(err, ProblemStateConflict) {
		t.Fatalf("rebind before finish: %v", err)
	}
	status, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded, DurationSeconds: 1234})
	if err != nil || status != api.RecoverySucceeded {
		t.Fatalf("finish %q %v", status, err)
	}
	if string(f.finish.Verification) != "{}" || f.finish.Warnings == nil || f.finish.DurationSeconds != 1234 {
		t.Fatalf("finish body %+v", f.finish)
	}
	rb, err := s.Rebind(ctx, api.RecoveryRebindRequest{Token: "rset_rebind_token_0123456789", Hostname: "web01", OS: "linux",
		Arch: "amd64", AgentVersion: "0.5.0", OSVersion: "Debian GNU/Linux 12", Hooks: "off"})
	if err != nil || !rb.Rebound || rb.EndpointID != "0d7a4b8e-1111-4c2d-9e3f-222233334444" || rb.Config == nil {
		t.Fatalf("rebind %+v %v", rb, err)
	}
	if f.rebind.Token != "rset_rebind_token_0123456789" || f.rebind.OS != "linux" || f.rebind.Hooks != "off" {
		t.Fatalf("rebind body %+v", f.rebind)
	}
	if got := redact.Redact("x rsea_new_secret_after_rebind_0123 repo-password-agent-0123"); strings.Contains(got, "rsea_new") || strings.Contains(got, "repo-password-agent") {
		t.Fatalf("rebind secrets not redacted: %q", got)
	}

	// The session secret never travels in a body.
	for i, b := range f.bodies {
		if strings.Contains(b, s.Secret) {
			t.Fatalf("body %d (%s) contains the session secret", i, f.seen[i])
		}
	}
	want := []string{
		"POST " + SessionsPath, "GET " + CurrentPath, "GET " + CurrentPath + "/credentials", "GET " + CurrentPath + "/credentials",
		"GET " + CurrentPath + "/credentials", "GET " + CurrentPath + "/ssh-keys", "POST " + CurrentPath + "/progress",
		"POST " + CurrentPath + "/log", "POST " + CurrentPath + "/log", "POST " + CurrentPath + "/log",
		"POST " + CurrentPath + "/event", "POST " + CurrentPath + "/release", "POST " + CurrentPath + "/release",
		"POST " + CurrentPath + "/rebind", "POST " + CurrentPath + "/finish", "POST " + CurrentPath + "/rebind",
	}
	if strings.Join(f.seen, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s\nwant:\n%s", strings.Join(f.seen, "\n"), strings.Join(want, "\n"))
	}
	if !strings.Contains(redact.Redact("secret "+s.Secret), redact.Mask) || strings.Contains(redact.Redact("x "+s.Secret), s.Secret) {
		t.Fatal("the session secret is not registered with the redactor")
	}
}

func TestSessionExchangeProblems(t *testing.T) {
	// The code was issued for another origin: the proof opens nothing.
	f := newFakeRecovery(t, "https://restow.firma.de", testCode)
	s := newTestSession(t, f)
	_, err := s.Exchange(context.Background(), exchangeRequest(s))
	var ae *api.APIError
	if !IsProblem(err, ProblemCodeInvalid) || !errors.As(err, &ae) || ae.Status != 401 || ae.Title != "Recovery code invalid" {
		t.Fatalf("wrong origin: %#v", err)
	}
	if s.ID != "" {
		t.Fatal("a refused exchange must not set a session id")
	}
	if ProblemName(errors.New("x")) != "" || IsProblem(nil, ProblemCodeInvalid) {
		t.Fatal("ProblemName of a plain error")
	}

	// Redeemed with another secret.
	f2 := newFakeRecovery(t, "", testCode)
	first := newTestSession(t, f2)
	if _, err := first.Exchange(context.Background(), exchangeRequest(first)); err != nil {
		t.Fatal(err)
	}
	// The same session again (a lost answer) gets the same session.
	if ex, err := first.Exchange(context.Background(), exchangeRequest(first)); err != nil || ex.SessionID != f2.sessionID {
		t.Fatalf("idempotent exchange: %v", err)
	}
	second := newTestSession(t, f2)
	if _, err := second.Exchange(context.Background(), exchangeRequest(second)); !IsProblem(err, ProblemCodeUsed) {
		t.Fatalf("second secret: %v", err)
	}

	// Malformed requests do not reach the instance.
	bad := exchangeRequest(first)
	bad.CodeProof = "nothex"
	if _, err := first.Exchange(context.Background(), bad); err == nil {
		t.Fatal("a malformed proof must be refused")
	}
	other := exchangeRequest(first)
	other.SessionSecretSHA256 = strings.Repeat("0", 64)
	if _, err := first.Exchange(context.Background(), other); err == nil {
		t.Fatal("a foreign secret hash must be refused")
	}
	empty := &Session{BaseURL: f2.srv.URL, AllowHTTP: true, HTTP: f2.srv.Client()}
	if _, err := empty.Exchange(context.Background(), exchangeRequest(first)); err == nil {
		t.Fatal("a session without secret must be refused")
	}
}

func TestSessionMatchCodeMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusAccepted, map[string]any{"sessionId": "s-1", "status": "pending_approval", "matchCode": "000000",
			"expiresAt": "2026-11-05T14:00:00.000Z", "endpoint": map[string]string{"id": "e"}, "minRecoveryVersion": "0.5.0"})
	}))
	defer srv.Close()
	s, err := NewSession(srv.URL, true, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	if s.MatchCode() == "000000" {
		t.Skip("the random secret happens to match")
	}
	if _, err := s.Exchange(context.Background(), exchangeRequest(s)); err == nil || !strings.Contains(err.Error(), "match code") {
		t.Fatalf("mismatch: %v", err)
	}
}

func TestSessionRetriesOnlyWithRetryAfter(t *testing.T) {
	f := newFakeRecovery(t, "", testCode)
	s := newTestSession(t, f)
	var slept []time.Duration
	s.Sleep = func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil }
	f.fail503 = 2
	if _, err := s.Exchange(context.Background(), exchangeRequest(s)); err != nil {
		t.Fatalf("exchange after two 503: %v", err)
	}
	if len(slept) != 2 || slept[0] != 30*time.Second {
		t.Fatalf("slept %v", slept)
	}
	// Retries stop after MaxAttempts.
	s.MaxAttempts = 2
	f.fail503 = 5
	_, err := s.Current(context.Background())
	var ae *api.APIError
	if !IsProblem(err, ProblemRepositoryLocked) || !errors.As(err, &ae) || ae.RetryAfter != 30*time.Second {
		t.Fatalf("after attempts: %v", err)
	}
	// A 503 without Retry-After is not retried.
	f.mu.Lock()
	f.fail503 = 0
	f.failNoRA = true
	calls := len(f.seen)
	f.mu.Unlock()
	if _, err := s.Current(context.Background()); err == nil {
		t.Fatal("503 without Retry-After must fail")
	}
	if len(f.seen) != calls+1 {
		t.Fatalf("a 503 without Retry-After was retried (%d calls)", len(f.seen)-calls)
	}
}

func TestSessionRefusesForeignRepository(t *testing.T) {
	f := newFakeRecovery(t, "", testCode)
	s := newTestSession(t, f)
	if _, err := s.Exchange(context.Background(), exchangeRequest(s)); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.status = api.RecoveryActive
	f.mu.Unlock()
	for _, repo := range []string{
		"rest:https://attacker.example/agent/recovery/restic/" + f.sessionID + "/",
		"rest:" + f.srv.URL + "/agent/restic/" + f.sessionID + "/",
		"rest:" + f.srv.URL + ResticPathPrefix + "other-session/",
		"s3:" + f.srv.URL + ResticPathPrefix + f.sessionID + "/",
	} {
		f.mu.Lock()
		f.repoURL = repo
		f.credsCalls = 0
		f.mu.Unlock()
		if _, err := s.Credentials(context.Background()); err == nil || !strings.Contains(err.Error(), "refusing") {
			t.Errorf("repository %q: %v", repo, err)
		}
	}
	// A third fetch is refused by the instance.
	f.mu.Lock()
	f.repoURL = ""
	f.credsCalls = 2
	f.mu.Unlock()
	if _, err := s.Credentials(context.Background()); !IsProblem(err, ProblemCredentialsCollected) {
		t.Fatalf("third fetch: %v", err)
	}
}

func TestSessionAddress(t *testing.T) {
	if _, err := NewSession("http://lab.local", false, nil); err == nil {
		t.Fatal("http without the lab flag must be refused")
	}
	if _, err := NewSession("restow.firma.de/restow", false, nil); err == nil {
		t.Fatal("a path must be refused")
	}
	s, err := NewSession("Restow.Firma.de:443", false, nil)
	if err != nil || s.BaseURL != "https://restow.firma.de" || len(s.Secret) != 64 {
		t.Fatalf("%+v %v", s, err)
	}
	s.ID = "abc"
	if s.ResticRepository() != "rest:https://restow.firma.de/agent/recovery/restic/abc/" {
		t.Fatal(s.ResticRepository())
	}
	plain := &Session{BaseURL: "http://lab.local", ID: "a", Secret: "b"}
	if _, err := plain.Current(context.Background()); err == nil || !strings.Contains(err.Error(), "only https") {
		t.Fatalf("plain http session: %v", err)
	}
}

// utf16Len counts as the instance's schemas do (JavaScript string length).
func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// The batches and the finish report stay within the instance's body limits
// (a 413 would lose them: it is not retried).
func TestSessionBodyLimits(t *testing.T) {
	f := newFakeRecovery(t, "", testCode)
	f.status = api.RecoveryActive
	s := newTestSession(t, f)
	ctx := context.Background()
	if _, err := s.Exchange(ctx, exchangeRequest(s)); err != nil {
		t.Fatal(err)
	}

	// 200 full ASCII lines are one batch of about 800 KiB.
	lines := make([]string, api.RecoveryMaxLogLines)
	for i := range lines {
		lines[i] = strings.Repeat("a", api.RecoveryMaxLogLine)
	}
	calls := len(f.seen)
	if res, err := s.Log(ctx, lines); err != nil || res.Accepted != len(lines) {
		t.Fatalf("full ASCII batch: %+v %v", res, err)
	}
	if got := len(f.seen) - calls; got != 1 {
		t.Fatalf("full ASCII batch took %d calls", got)
	}

	// Lines that escape to six times their length are split by size.
	for i := range lines {
		lines[i] = strings.Repeat("<", api.RecoveryMaxLogLine)
	}
	calls, before := len(f.seen), len(f.logLines)
	if res, err := s.Log(ctx, lines); err != nil || res.Accepted != len(lines) {
		t.Fatalf("escaped lines: %+v %v", res, err)
	}
	if got := len(f.seen) - calls; got < 5 {
		t.Fatalf("escaped lines took only %d calls", got)
	}
	if len(f.logLines)-before != len(lines) || f.logLines[len(f.logLines)-1] != lines[0] {
		t.Fatal("escaped lines were not all delivered unchanged")
	}
	for _, b := range f.bodies[calls:] {
		if len(b) > api.RecoveryMaxLogBody {
			t.Fatalf("log body of %d bytes", len(b))
		}
	}

	// Too many, too long warnings are cut, then dropped until the body fits.
	warnings := make([]api.RecoveryWarning, 300)
	for i := range warnings {
		warnings[i] = api.RecoveryWarning{Code: strings.Repeat("c", 100), Message: strings.Repeat("<", 2000)}
	}
	verification := json.RawMessage(`{"report":"` + strings.Repeat("v", api.RecoveryMaxVerification-len(`{"report":""}`)) + `"}`)
	status, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded, Verification: verification, Warnings: warnings})
	if err != nil || status != api.RecoverySucceeded {
		t.Fatalf("finish %q %v", status, err)
	}
	if body := f.bodies[len(f.bodies)-1]; len(body) > api.RecoveryMaxFinishBody {
		t.Fatalf("finish body of %d bytes", len(body))
	}
	n := len(f.finish.Warnings)
	if n == 0 || n >= api.RecoveryMaxFinishWarning {
		t.Fatalf("%d warnings sent", n)
	}
	if w := f.finish.Warnings[0]; len(w.Code) != api.RecoveryMaxWarningCode || len(w.Message) != api.RecoveryMaxWarningMessage {
		t.Fatalf("warning not cut: %d %d", len(w.Code), len(w.Message))
	}
	if len(warnings[0].Code) != 100 {
		t.Fatal("Finish changed the caller's warnings")
	}

	// Plain warnings within the bounds all go (about 280 KiB).
	f.status = api.RecoveryActive
	for i := range warnings {
		warnings[i] = api.RecoveryWarning{Code: strings.Repeat("c", 64), Message: strings.Repeat("m", 1000)}
	}
	if _, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded, Verification: verification, Warnings: warnings}); err != nil {
		t.Fatal(err)
	}
	if len(f.finish.Warnings) != api.RecoveryMaxFinishWarning {
		t.Fatalf("%d plain warnings sent", len(f.finish.Warnings))
	}
}

func TestTruncate(t *testing.T) {
	if got := truncateUTF16("a😀b", 2); got != "a" {
		t.Fatalf("%q", got)
	}
	if got := truncateUTF16("abc", 5); got != "abc" {
		t.Fatalf("%q", got)
	}
	if got := truncateBytes("aää", 4); got != "aä" {
		t.Fatalf("%q", got)
	}
	d, ok := retryAfter("0")
	if !ok || d != time.Second {
		t.Fatalf("retryAfter(0) = %v %v", d, ok)
	}
	if d, ok := retryAfter("9999"); !ok || d != maxRetryDelay {
		t.Fatalf("retryAfter cap: %v", d)
	}
	if _, ok := retryAfter("soon"); ok {
		t.Fatal("an unparsable Retry-After is no Retry-After")
	}
}

// What the ISO reports is often copied from a tool's output: control
// characters become spaces (the instance answers 422 otherwise) and secrets
// are masked, as in the log.
func TestSessionCleansAndRedactsReports(t *testing.T) {
	f := newFakeRecovery(t, "", testCode)
	s := newTestSession(t, f)
	ctx := context.Background()
	req := exchangeRequest(s)
	req.Hardware.Disks[0].Model = "Samsung\x00SSD\n980"
	req.Hardware.NICs[0].Driver = "e1000e\u2028"
	if _, err := s.Exchange(ctx, req); err != nil {
		t.Fatalf("exchange with odd hardware strings: %v", err)
	}
	f.mu.Lock()
	f.status = api.RecoveryActive
	f.mu.Unlock()
	if err := s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseVerifying,
		Message: "dracut:\tW: Possible missing firmware\nRESTIC_PASSWORD=hunter2hunter2"}); err != nil {
		t.Fatalf("progress: %v", err)
	}
	if err := s.Event(ctx, api.RecoveryEventKeyfileRegenerated, map[string]string{"note": "cryptsetup passphrase=sup3rs3cr3t\n"}); err != nil {
		t.Fatalf("event: %v", err)
	}
	status, err := s.Finish(ctx, api.RecoveryFinish{
		Status:       api.RecoverySucceeded,
		Verification: json.RawMessage(`{"steps":[{"output":"PGPASSWORD=hunter2hunter2 psql","exit":0}],"note":"a<b"}`),
		Warnings: []api.RecoveryWarning{
			{Code: "grub\n", Message: "initramfs: W: Possible missing firmware\n\t/lib/firmware/i915"},
			{Code: "hook", Message: "export TOKEN=abcdefgh12345678 and " + s.Secret},
		},
	})
	if err != nil || status != api.RecoverySucceeded {
		t.Fatalf("finish with multi-line warnings: %q %v", status, err)
	}
	sent := strings.Join(f.bodies, "\n")
	for _, secret := range []string{"hunter2hunter2", "sup3rs3cr3t", "abcdefgh12345678", s.Secret} {
		if strings.Contains(sent, secret) {
			t.Fatalf("%q was sent unmasked", secret)
		}
	}
	if w := f.finish.Warnings[0]; w.Message != "initramfs: W: Possible missing firmware  /lib/firmware/i915" || w.Code != "grub " {
		t.Fatalf("warning %+v", w)
	}
	var v struct {
		Steps []struct {
			Output string `json:"output"`
			Exit   int    `json:"exit"`
		} `json:"steps"`
		Note string `json:"note"`
	}
	if err := json.Unmarshal(f.finish.Verification, &v); err != nil || v.Steps[0].Exit != 0 || v.Note != "a<b" ||
		!strings.Contains(v.Steps[0].Output, redact.Mask) {
		t.Fatalf("verification %s (%v)", f.finish.Verification, err)
	}
}

// A key block a hook printed is masked from BEGIN to END, also when the
// lines come in two calls.
func TestSessionLogMasksKeyBlocks(t *testing.T) {
	f := newFakeRecovery(t, "", testCode)
	s := newTestSession(t, f)
	ctx := context.Background()
	if _, err := s.Exchange(ctx, exchangeRequest(s)); err != nil {
		t.Fatal(err)
	}
	body := "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB"
	if _, err := s.Log(ctx, []string{"key:", "-----BEGIN OPENSSH PRIVATE KEY-----", body}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Log(ctx, []string{body, "-----END OPENSSH PRIVATE KEY-----", "done"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"key:", redact.Mask, redact.Mask, redact.Mask, redact.Mask, "done"}
	if strings.Join(f.logLines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("log %q", f.logLines)
	}
}

// A redirect is never followed: Go would send the Authorization header along
// to another port or a subdomain of the same host.
func TestSessionRefusesRedirects(t *testing.T) {
	var leaked []string
	var mu sync.Mutex
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		leaked = append(leaked, r.Header.Get("Authorization"))
		mu.Unlock()
		writeJSON(w, 200, api.RecoverySessionState{SessionID: "s", Status: api.RecoveryActive})
	}))
	t.Cleanup(other.Close)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusPermanentRedirect)
	}))
	t.Cleanup(front.Close)
	for _, hc := range []*http.Client{nil, front.Client()} {
		s, err := NewSession(front.URL, true, hc)
		if err != nil {
			t.Fatal(err)
		}
		s.ID = "5b1f0c2e-8f7a-4d7e-9a43-1c2d3e4f5a6b"
		if _, err := s.Current(context.Background()); err == nil || !strings.Contains(err.Error(), "redirect") {
			t.Fatalf("a redirect must fail the call: %v", err)
		}
		if _, err := s.Exchange(context.Background(), exchangeRequest(s)); err == nil {
			t.Fatal("a redirected exchange must fail")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(leaked) != 0 {
		t.Fatalf("the redirect target was reached %d times (authorization %q)", len(leaked), leaked)
	}
}

// Without a client of its own the session makes one and keeps it, so its
// calls share connections.
func TestSessionKeepsItsClient(t *testing.T) {
	var conns int
	var mu sync.Mutex
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, api.RecoverySessionState{SessionID: "s", Status: api.RecoveryActive})
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			mu.Lock()
			conns++
			mu.Unlock()
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	s, err := NewSession(srv.URL, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.ID = "5b1f0c2e-8f7a-4d7e-9a43-1c2d3e4f5a6b"
	for range 5 {
		if _, err := s.Current(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if conns != 1 {
		t.Fatalf("%d connections for five calls, want one", conns)
	}
}
