package recovery

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// Paths of the recovery API (docs/BAREMETAL.md 9.3 to 9.8, 11).
const (
	SessionsPath     = "/agent/v1/recovery/sessions"
	CurrentPath      = SessionsPath + "/current"
	ResticPathPrefix = "/agent/recovery/restic/"
)

// ProblemPrefix starts the type of every problem answer of the instance.
const ProblemPrefix = "urn:restow:problem:"

// Problem types of the recovery API.
const (
	ProblemCodeInvalid          = "recovery-code-invalid"          // 401: wrong code or wrong address
	ProblemCodeExpired          = "recovery-code-expired"          // 410
	ProblemCodeRevoked          = "recovery-code-revoked"          // 410
	ProblemCodeUsed             = "recovery-code-used"             // 409: redeemed with another session secret
	ProblemTooOld               = "recovery-too-old"               // 426: the ISO is older than minRecoveryVersion
	ProblemSessionEnded         = "recovery-session-ended"         // 401: released, finished, cancelled or expired
	ProblemNotApproved          = "recovery-not-approved"          // 409: still waiting for approval
	ProblemCredentialsCollected = "recovery-credentials-collected" // 409: fetched twice, or after the five-minute window
	ProblemStateConflict        = "recovery-state-conflict"        // 409: the call does not fit the session's status
	ProblemNotAvailable         = "baremetal-not-available"        // 409
	ProblemRepositoryLocked     = "endpoint-repository-locked"     // 503 with Retry-After: a prune runs
	ProblemRebindOSMismatch     = "endpoint-rebind-os-mismatch"    // 422
	ProblemEndpointRevoked      = "endpoint-revoked"               // 409: reconnect token without unrevoke
)

const (
	maxSessionResponse = 4 << 20
	defaultTimeout     = 60 * time.Second
	defaultAttempts    = 5
	maxRetryDelay      = 2 * time.Minute
	problemJSON        = "application/problem+json"
)

// ProblemName returns the problem type of an API error without the URN
// prefix ("recovery-code-invalid"), or "" when err is no problem answer.
func ProblemName(err error) string {
	var ae *api.APIError
	if !errors.As(err, &ae) {
		return ""
	}
	return strings.TrimPrefix(ae.Type, ProblemPrefix)
}

// IsProblem reports whether err is a problem answer of the given type.
func IsProblem(err error, name string) bool { return name != "" && ProblemName(err) == name }

// Session is the client of one recovery session. BaseURL is the canonical
// origin of the instance (CanonicalOrigin); the code proof is bound to it.
// Secret is the session secret: it goes only into the Basic authorization
// header of the session routes and of the restic route, never into a body,
// and is registered with the redactor. Redirects are never followed: the
// Authorization header would go along to another port or host of the same
// domain.
//
// Every string the session reports goes through the redactor and, where the
// instance refuses control characters (docs/BAREMETAL.md 4.2), has them
// replaced by spaces, so a warning copied from a tool's output neither leaks
// a secret nor makes the call fail with 422.
type Session struct {
	BaseURL string
	ID      string
	Secret  string
	// HTTP is the client to use (TLS settings, the CA of the instance).
	HTTP *http.Client
	// AllowHTTP accepts a plain http:// BaseURL (lab only).
	AllowHTTP bool
	// RequestTimeout bounds one attempt (default 60 s).
	RequestTimeout time.Duration
	// MaxAttempts bounds retries after 429 and 503 with Retry-After
	// (default 5; 1 turns retries off).
	MaxAttempts int
	// Sleep replaces the context-aware sleep (tests).
	Sleep func(ctx context.Context, d time.Duration) error

	redactOnce sync.Once
	clientOnce sync.Once
	client     *http.Client
	logMu      sync.Mutex
	logBlocks  redact.KeyBlocks
	// closed: the session has ended on the instance (it took the finish,
	// or answered a report with 409 recovery-state-conflict). Nothing more
	// is reported: the result is final there, and every further report
	// would be refused and audited.
	closed atomic.Bool
	// endState is the state the instance named when the session closed
	// (succeeded, failed, cancelled), or nil when it named none.
	endState atomic.Pointer[string]
}

// ErrSessionClosed is what Progress, Log, Event, Release and Finish return
// once the session has ended on the instance (9.8, 9.9: a closed session
// takes no more reports). It is the expected end of every recovery, not a
// failure: callers neither retry nor show it.
var ErrSessionClosed = errors.New("the recovery session has ended on the instance; nothing more is reported")

// Closed reports whether the session has ended on the instance.
func (s *Session) Closed() bool { return s.closed.Load() }

// EndState is the state the session ended in, as the instance named it
// (succeeded, failed, cancelled), or "" while it runs or when the
// instance named none.
func (s *Session) EndState() string {
	if st := s.endState.Load(); st != nil {
		return *st
	}
	return ""
}

// close remembers that the session has ended, and as what.
func (s *Session) close(state string) {
	if closedState(state) {
		s.endState.CompareAndSwap(nil, &state)
	}
	s.closed.Store(true)
}

// closedState reports a state a session ends in.
func closedState(st string) bool {
	return st == api.RecoverySucceeded || st == api.RecoveryFailed || st == api.RecoveryCancelled
}

// report sends a report of the running recovery (progress, log, event,
// release). After the end it sends nothing; the 409 that says the session
// has ended is remembered and returned as ErrSessionClosed.
func (s *Session) report(ctx context.Context, path string, body, out any) error {
	if s.closed.Load() {
		return ErrSessionClosed
	}
	err := s.do(ctx, http.MethodPost, path, body, out, true)
	// The 409 names the state: only a state a session ends in closes it
	// (a release before the approval is refused with the same type).
	if st := ProblemState(err); IsProblem(err, ProblemStateConflict) && closedState(st) {
		s.close(st)
		return fmt.Errorf("%w: %w", ErrSessionClosed, err)
	}
	return err
}

// ProblemState is the state a 409 recovery-state-conflict names (the state
// the session is in), or "".
func ProblemState(err error) string {
	var ae *api.APIError
	if !errors.As(err, &ae) {
		return ""
	}
	return ae.State
}

// ProblemReason is the reason code of a problem answer (for example
// snapshot_unknown of baremetal-not-available), or "".
func ProblemReason(err error) string {
	var ae *api.APIError
	if !errors.As(err, &ae) {
		return ""
	}
	return ae.Reason
}

// NewSession checks the instance address and makes a new session secret.
func NewSession(address string, allowHTTP bool, hc *http.Client) (*Session, error) {
	origin, err := CanonicalOrigin(address, allowHTTP)
	if err != nil {
		return nil, err
	}
	secret, _, err := NewSessionSecret()
	if err != nil {
		return nil, err
	}
	s := &Session{BaseURL: origin, Secret: secret, HTTP: hc, AllowHTTP: allowHTTP}
	s.registerSecret()
	return s, nil
}

func (s *Session) registerSecret() {
	s.redactOnce.Do(func() {
		if s.Secret != "" {
			redact.Add(s.Secret)
		}
	})
}

// SecretSHA256 is the SHA-256 of the session secret (sent at the exchange).
func (s *Session) SecretSHA256() string { return SessionSecretSHA256(s.Secret) }

// MatchCode is the six-digit number to compare with the Restow UI.
func (s *Session) MatchCode() string { return MatchCode(s.SecretSHA256()) }

// ResticRepository is the restic repository URL of the session
// (rest:<origin>/agent/recovery/restic/<sessionId>/), for checking the one
// the credentials name.
func (s *Session) ResticRepository() string {
	return "rest:" + strings.TrimRight(s.BaseURL, "/") + ResticPathPrefix + s.ID + "/"
}

// Exchange redeems the code proof (CodeProof with the origin of BaseURL).
// The request carries the SHA-256 of the session secret; req's
// SessionSecretSHA256 is filled in. On success the session id is set.
func (s *Session) Exchange(ctx context.Context, req api.RecoveryExchangeRequest) (*api.RecoveryExchangeResponse, error) {
	if s.Secret == "" {
		return nil, errors.New("the session has no secret")
	}
	if !isHex64(req.CodeProof) {
		return nil, errors.New("the code proof must be 64 lower-case hexadecimal characters")
	}
	sha := s.SecretSHA256()
	if req.SessionSecretSHA256 != "" && req.SessionSecretSHA256 != sha {
		return nil, errors.New("the request names another session secret")
	}
	req.SessionSecretSHA256 = sha
	disks := make([]api.RecoveryDisk, 0, len(req.Hardware.Disks))
	for _, d := range req.Hardware.Disks {
		d.Model = isoField(d.Model, api.RecoveryMaxString)
		d.Serial = isoField(d.Serial, api.RecoveryMaxString)
		d.WWN = isoField(d.WWN, api.RecoveryMaxString)
		d.Transport = isoField(d.Transport, api.RecoveryMaxTransport)
		disks = append(disks, d)
	}
	req.Hardware.Disks = disks
	nics := make([]api.RecoveryNIC, 0, len(req.Hardware.NICs))
	for _, n := range req.Hardware.NICs {
		n.MAC = isoField(n.MAC, api.RecoveryMaxString)
		n.Driver = isoField(n.Driver, api.RecoveryMaxString)
		nics = append(nics, n)
	}
	req.Hardware.NICs = nics
	var out api.RecoveryExchangeResponse
	if err := s.do(ctx, http.MethodPost, SessionsPath, req, &out, false); err != nil {
		return nil, err
	}
	switch {
	case out.SessionID == "" || strings.ContainsAny(out.SessionID, "/:?#%") || out.SessionID != strings.TrimSpace(out.SessionID):
		return nil, errors.New("the instance answered without a usable session id")
	case out.MatchCode != MatchCode(sha):
		return nil, fmt.Errorf("the instance answered with match code %s, but this session's is %s",
			FormatMatchCode(out.MatchCode), FormatMatchCode(MatchCode(sha)))
	}
	s.ID = out.SessionID
	return &out, nil
}

// Current reads the session's status (recover polls it every 5 seconds
// while it waits for the approval).
func (s *Session) Current(ctx context.Context) (*api.RecoverySessionState, error) {
	var out api.RecoverySessionState
	if err := s.do(ctx, http.MethodGet, CurrentPath, nil, &out, true); err != nil {
		return nil, err
	}
	return &out, nil
}

// Credentials fetches the repository password and the read-only repository
// of the session (status active only). The repository must be the
// session's own route on the instance, because restic sends the session
// secret there.
func (s *Session) Credentials(ctx context.Context) (*api.RecoveryCredentials, error) {
	var out api.RecoveryCredentials
	if err := s.do(ctx, http.MethodGet, CurrentPath+"/credentials", nil, &out, true); err != nil {
		return nil, err
	}
	if out.Repository.Password != "" {
		redact.Add(out.Repository.Password)
	}
	if out.Repository.URL != s.ResticRepository() {
		return nil, fmt.Errorf("the instance named the repository %s, not the session's own %s; refusing to send the session secret there",
			redact.Redact(out.Repository.URL), s.ResticRepository())
	}
	if out.Repository.Password == "" {
		return nil, errors.New("the instance answered without a repository password")
	}
	if !isHex64(out.SnapshotID) {
		return nil, errors.New("the instance answered without a valid snapshot id")
	}
	return &out, nil
}

// SSHKeys fetches the public keys allowed for remote access.
func (s *Session) SSHKeys(ctx context.Context) ([]string, error) {
	var out api.RecoverySSHKeys
	if err := s.do(ctx, http.MethodGet, CurrentPath+"/ssh-keys", nil, &out, true); err != nil {
		return nil, err
	}
	if out.Keys == nil {
		out.Keys = []string{}
	}
	return out.Keys, nil
}

// Progress reports the phase and counters (204). The message is redacted,
// without control characters and cut to 500 characters.
func (s *Session) Progress(ctx context.Context, p api.RecoveryProgress) error {
	p.Message = isoField(p.Message, api.RecoveryMaxMessage)
	if p.SSHHostKeys != nil {
		keys := make([]api.RecoverySSHHostKey, 0, len(p.SSHHostKeys))
		for _, k := range p.SSHHostKeys {
			keys = append(keys, api.RecoverySSHHostKey{
				Type:        isoField(k.Type, 64),
				Fingerprint: isoField(k.Fingerprint, api.RecoveryMaxString),
			})
		}
		p.SSHHostKeys = keys
	}
	return s.report(ctx, CurrentPath+"/progress", p, nil)
}

// logBodyOverhead is the encoded size of api.RecoveryLog without lines:
// {"lines":[]}.
const logBodyOverhead = len(`{"lines":[]}`)

// Log sends log lines (redacted, each cut to 4096 bytes), in batches of at
// most 200 lines whose encoded body stays within the instance's limit for
// the route (api.RecoveryMaxLogBody; escapes can make a line up to six times
// its length). A key block is masked from its BEGIN line to its END line,
// also across calls. The result sums the answers; lines over the session's
// cap are dropped by the instance.
func (s *Session) Log(ctx context.Context, lines []string) (api.RecoveryLogResult, error) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	var total api.RecoveryLogResult
	for len(lines) > 0 {
		batch := make([]string, 0, min(len(lines), api.RecoveryMaxLogLines))
		size := logBodyOverhead
		n := 0
		for _, l := range lines {
			if len(batch) == api.RecoveryMaxLogLines {
				break
			}
			line := truncateBytes(s.logBlocks.Line(redact.Default, l), api.RecoveryMaxLogLine)
			w := encodedLen(line)
			if len(batch) > 0 {
				w++ // the comma
			}
			// A single line always fits: 4096 bytes encode to at most 24 KiB.
			if len(batch) > 0 && size+w > api.RecoveryMaxLogBody {
				break
			}
			batch = append(batch, line)
			size += w
			n++
		}
		lines = lines[n:]
		var out api.RecoveryLogResult
		if err := s.report(ctx, CurrentPath+"/log", api.RecoveryLog{Lines: batch}, &out); err != nil {
			return total, err
		}
		total.Accepted += out.Accepted
		total.Dropped += out.Dropped
	}
	return total, nil
}

// Event reports remote_access_enabled or keyfile_regenerated (204). Each
// detail value is redacted, without control characters and cut to 1024
// characters, each key cut to 64.
func (s *Session) Event(ctx context.Context, kind string, detail map[string]string) error {
	cleaned := make(map[string]string, len(detail))
	for k, v := range detail {
		cleaned[truncateUTF16(k, 64)] = isoField(v, 1024)
	}
	return s.report(ctx, CurrentPath+"/event", api.RecoveryEvent{Kind: kind, Detail: cleaned}, nil)
}

// Release ends read access before the machine restarts (active to
// finishing; repeating it is harmless).
func (s *Session) Release(ctx context.Context) (string, error) {
	var out api.RecoveryStatus
	if err := s.report(ctx, CurrentPath+"/release", struct{}{}, &out); err != nil {
		return "", err
	}
	return out.Status, nil
}

// Finish reports the end of the recovery (from active or finishing). At
// most 200 warnings are sent, each redacted, without control characters,
// the code cut to 64 and the message to 1000 characters; warnings are
// dropped from the end while the encoded body would exceed the instance's
// limit for the route (api.RecoveryMaxFinishBody). Every string of the
// verification report is redacted; keeping it within 64 KiB is the caller's.
//
// The answer is what the instance stored, which is not always what was
// reported: a succeeded without a verification report that bears it out
// ends as failed, with Reported and Reason set (9.8). A session that had
// ended before (cancelled in the web interface, or finished already)
// answers 409 recovery-state-conflict: Finish then returns
// ErrSessionClosed and, in Status, the state the instance named (also when
// an earlier report learned of the end: no second request is sent). After
// either answer the session takes nothing more.
func (s *Session) Finish(ctx context.Context, f api.RecoveryFinish) (api.RecoveryStatus, error) {
	if s.closed.Load() {
		return api.RecoveryStatus{Status: s.EndState()}, ErrSessionClosed
	}
	if len(f.Verification) == 0 {
		f.Verification = json.RawMessage("{}")
	}
	f.Verification = redactJSON(f.Verification)
	warnings := make([]api.RecoveryWarning, 0, min(len(f.Warnings), api.RecoveryMaxFinishWarning))
	for _, w := range f.Warnings {
		if len(warnings) == api.RecoveryMaxFinishWarning {
			break
		}
		warnings = append(warnings, api.RecoveryWarning{
			Code:    isoField(w.Code, api.RecoveryMaxWarningCode),
			Message: isoField(w.Message, api.RecoveryMaxWarningMessage),
		})
	}
	f.Warnings = warnings
	if payload, err := json.Marshal(f); err == nil && len(payload) > api.RecoveryMaxFinishBody {
		size := len(payload)
		for len(f.Warnings) > 0 && size > api.RecoveryMaxFinishBody {
			last := len(f.Warnings) - 1
			size -= encodedLen(f.Warnings[last])
			if last > 0 {
				size-- // the comma
			}
			f.Warnings = f.Warnings[:last]
		}
	}
	var out api.RecoveryStatus
	if err := s.do(ctx, http.MethodPost, CurrentPath+"/finish", f, &out, true); err != nil {
		if st := ProblemState(err); IsProblem(err, ProblemStateConflict) && closedState(st) {
			s.close(st)
			return api.RecoveryStatus{Status: st}, fmt.Errorf("%w: %w", ErrSessionClosed, err)
		}
		return api.RecoveryStatus{}, err
	}
	s.close(out.Status)
	if !closedState(out.Status) {
		return out, fmt.Errorf("the instance answered the finish with the state %q", isoField(out.Status, 64))
	}
	if !reCode.MatchString(out.Reason) {
		out.Reason = ""
	}
	if out.Reported != "" && !closedState(out.Reported) {
		out.Reported = ""
	}
	return out, nil
}

// reCode is the form of a code of the instance (a problem's reason, a
// state): nothing else is taken from an answer into a text.
var reCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// Rebind redeems a reconnect token of the same machine after a successful
// finish (201, the answer of an enrollment with Rebound set). The token is
// registered with the redactor first.
func (s *Session) Rebind(ctx context.Context, req api.RecoveryRebindRequest) (*api.EnrollResponse, error) {
	if req.Token != "" {
		redact.Add(req.Token)
	}
	var out api.EnrollResponse
	if err := s.do(ctx, http.MethodPost, CurrentPath+"/rebind", req, &out, true); err != nil {
		return nil, err
	}
	if out.AgentSecret != "" {
		redact.Add(out.AgentSecret)
	}
	if out.Repository.Password != "" {
		redact.Add(out.Repository.Password)
	}
	if !out.Rebound {
		return nil, errors.New("the instance did not confirm the reconnection (rebound missing)")
	}
	return &out, nil
}

func (s *Session) base() (string, error) {
	u, err := url.Parse(s.BaseURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("invalid instance address %q", s.BaseURL)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && s.AllowHTTP:
	default:
		return "", fmt.Errorf("refusing instance address %q: only https is allowed", s.BaseURL)
	}
	return strings.TrimRight(s.BaseURL, "/"), nil
}

// do sends one call. Only 429 and 503 answers with a Retry-After header are
// retried (the instance says the request did not take effect, for example
// while a prune holds the repository); everything else is returned.
func (s *Session) do(ctx context.Context, method, path string, body, out any, auth bool) error {
	base, err := s.base()
	if err != nil {
		return err
	}
	if auth {
		if s.ID == "" || s.Secret == "" {
			return errors.New("no recovery session: exchange the code first")
		}
		s.registerSecret()
	}
	var payload []byte
	if body != nil {
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encode %s %s: %w", method, path, err)
		}
	}
	attempts := s.MaxAttempts
	if attempts <= 0 {
		attempts = defaultAttempts
	}
	for attempt := 1; ; attempt++ {
		delay, retry, err := s.once(ctx, method, base, path, payload, out, auth)
		if err == nil {
			return nil
		}
		if !retry || attempt >= attempts || ctx.Err() != nil {
			return err
		}
		if serr := s.sleep(ctx, delay); serr != nil {
			return err
		}
	}
}

func (s *Session) sleep(ctx context.Context, d time.Duration) error {
	if s.Sleep != nil {
		return s.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (s *Session) once(ctx context.Context, method, base, path string, payload []byte, out any, auth bool) (time.Duration, bool, error) {
	timeout := s.RequestTimeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	actx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if payload != nil {
		rd = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(actx, method, base+path, rd)
	if err != nil {
		return 0, false, err
	}
	req.Header.Set("Accept", "application/json, "+problemJSON)
	req.Header.Set("User-Agent", buildinfo.UserAgent())
	// Nothing of a recovery session may be kept by a cache on the way.
	req.Header.Set("Cache-Control", "no-store")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		req.SetBasicAuth(s.ID, s.Secret)
	}
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return 0, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return 0, false, fmt.Errorf("%s %s: the instance answered %d with a redirect to %q; recover follows no redirect (the session secret would go along). Enter the address the code dialog shows",
			method, path, resp.StatusCode, redact.Redact(resp.Header.Get("Location")))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSessionResponse+1))
	if err != nil {
		return 0, false, err
	}
	if len(data) > maxSessionResponse {
		return 0, false, fmt.Errorf("%s %s: answer larger than %d bytes", method, path, maxSessionResponse)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out != nil && len(bytes.TrimSpace(data)) > 0 {
			if err := json.Unmarshal(data, out); err != nil {
				return 0, false, fmt.Errorf("%s %s: invalid JSON in answer: %w", method, path, err)
			}
		}
		return 0, false, nil
	}
	ae := &api.APIError{Method: method, Path: path, Status: resp.StatusCode}
	var p struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Detail string `json:"detail"`
		// Extensions of the recovery routes: plain codes, or nothing.
		Reason any `json:"reason"`
		Status any `json:"status"`
	}
	if len(data) > 0 && json.Unmarshal(data, &p) == nil {
		ae.Type, ae.Title, ae.Detail = p.Type, p.Title, redact.Redact(p.Detail)
		if r, ok := p.Reason.(string); ok && reCode.MatchString(r) {
			ae.Reason = r
		}
		if st, ok := p.Status.(string); ok && reCode.MatchString(st) {
			ae.State = st
		}
	}
	if ae.Title == "" {
		ae.Title = http.StatusText(resp.StatusCode)
	}
	delay, ok := retryAfter(resp.Header.Get("Retry-After"))
	ae.RetryAfter = delay
	retry := ok && (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable)
	return delay, retry, ae
}

// httpClient is the client of every call, made once: HTTP (or a client of
// api.NewHTTPClient) that never follows a redirect.
func (s *Session) httpClient() *http.Client {
	s.clientOnce.Do(func() {
		base := s.HTTP
		if base == nil {
			base = api.NewHTTPClient(s.AllowHTTP)
		}
		c := *base
		c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		s.client = &c
	})
	return s.client
}

// isoText is s as the instance accepts a string of the ISO (no C0 or C1
// control character, no line or paragraph separator; docs/BAREMETAL.md
// 4.2): each becomes a space, invalid UTF-8 the replacement character.
func isoText(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0x2028 || r == 0x2029 {
			return ' '
		}
		return r
	}, s)
}

// isoField is a reported string: redacted, as isoText, at most n UTF-16
// units.
func isoField(s string, n int) string { return truncateUTF16(isoText(redact.Redact(s)), n) }

// redactJSON redacts every string of a JSON document (the verification
// report); a document that does not parse is sent as it is.
func redactJSON(raw json.RawMessage) json.RawMessage {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return raw
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(redactValue(v, 0)); err != nil {
		return raw
	}
	return json.RawMessage(bytes.TrimRight(buf.Bytes(), "\n"))
}

func redactValue(v any, depth int) any {
	if depth > 64 {
		return v
	}
	switch t := v.(type) {
	case string:
		return redact.Redact(t)
	case []any:
		for i := range t {
			t[i] = redactValue(t[i], depth+1)
		}
	case map[string]any:
		for k := range t {
			t[k] = redactValue(t[k], depth+1)
		}
	}
	return v
}

// retryAfter parses a Retry-After header (seconds or an HTTP date). ok is
// false when there is none; the delay is at least one second and at most two
// minutes.
func retryAfter(v string) (time.Duration, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	var d time.Duration
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		d = time.Duration(secs) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = time.Until(t)
	} else {
		return 0, false
	}
	return min(max(d, time.Second), maxRetryDelay), true
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && strings.ToLower(s) == s
}

// truncateUTF16 cuts s to at most n UTF-16 units, which is how the instance
// counts characters.
func truncateUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := utf16.RuneLen(r)
		if w < 0 {
			w = 1
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// encodedLen is the length of v as json.Marshal encodes it (the encoding
// of every request body).
func encodedLen(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(b)
}

// truncateBytes cuts s to at most n bytes at a rune boundary (n bytes are
// never more than n UTF-16 units, which is how the instance counts).
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
