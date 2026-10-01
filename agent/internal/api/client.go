package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
)

const (
	maxResponseBytes = 10 << 20
	problemJSON      = "application/problem+json"
)

// RetryPolicy controls retries with exponential backoff and full jitter.
type RetryPolicy struct {
	// MaxAttempts is the total number of tries per call (1 = no retry).
	MaxAttempts int
	// BaseDelay is the delay ceiling before the first retry; it doubles each
	// attempt up to MaxDelay.
	BaseDelay time.Duration
	MaxDelay  time.Duration
}

// DefaultRetry is used for normal calls.
var DefaultRetry = RetryPolicy{MaxAttempts: 5, BaseDelay: time.Second, MaxDelay: 30 * time.Second}

// Options configures a Client.
type Options struct {
	BaseURL           string
	EndpointID        string
	AgentSecret       string
	AllowInsecureHTTP bool
	// HTTPClient replaces the default client (tests).
	HTTPClient *http.Client
	Retry      RetryPolicy
	// RequestTimeout bounds one attempt of a JSON call (default 30 s).
	RequestTimeout time.Duration
	// Sleep replaces the context-aware sleep (tests).
	Sleep func(ctx context.Context, d time.Duration) error
}

// Client talks to /agent/v1.
type Client struct {
	base       *url.URL
	endpointID string
	secret     string
	insecure   bool
	http       *http.Client
	retry      RetryPolicy
	timeout    time.Duration
	sleep      func(ctx context.Context, d time.Duration) error
}

// ParseBaseURL validates the instance URL. Only https is accepted unless
// allowInsecure is set (development flag).
func ParseBaseURL(raw string, allowInsecure bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid Restow URL %q: %v", raw, err)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && allowInsecure:
	case u.Scheme == "http":
		return nil, fmt.Errorf("refusing plain http:// URL %q: the agent only talks HTTPS to the Restow instance "+
			"(use --allow-insecure-http only for local development)", raw)
	default:
		return nil, fmt.Errorf("invalid Restow URL %q: it must start with https://", raw)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("invalid Restow URL %q: no host", raw)
	}
	if u.User != nil {
		return nil, fmt.Errorf("invalid Restow URL: credentials in the URL are not allowed")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid Restow URL %q: query and fragment are not allowed", raw)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u, nil
}

// NewHTTPClient builds the HTTP client: TLS 1.2 or newer, system trust store,
// proxy from the environment, sane timeouts, no downgrade from https to http.
func NewHTTPClient(allowInsecure bool) *http.Client {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		ExpectContinueTimeout: 2 * time.Second,
		IdleConnTimeout:       60 * time.Second,
		MaxIdleConns:          4,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("stopped after 5 redirects")
			}
			if req.URL.Scheme != "https" && !allowInsecure {
				return fmt.Errorf("refusing redirect to non-HTTPS URL %s", req.URL.Redacted())
			}
			return nil
		},
	}
}

// New creates a client for an enrolled endpoint.
func New(o Options) (*Client, error) {
	base, err := ParseBaseURL(o.BaseURL, o.AllowInsecureHTTP)
	if err != nil {
		return nil, err
	}
	return newClient(base, o), nil
}

func newClient(base *url.URL, o Options) *Client {
	c := &Client{
		base:       base,
		endpointID: o.EndpointID,
		secret:     o.AgentSecret,
		insecure:   o.AllowInsecureHTTP,
		http:       o.HTTPClient,
		retry:      o.Retry,
		timeout:    o.RequestTimeout,
		sleep:      o.Sleep,
	}
	if c.http == nil {
		c.http = NewHTTPClient(o.AllowInsecureHTTP)
	}
	if c.retry.MaxAttempts == 0 {
		c.retry = DefaultRetry
	}
	if c.timeout == 0 {
		c.timeout = 30 * time.Second
	}
	if c.sleep == nil {
		c.sleep = sleepContext
	}
	return c
}

func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
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

// BaseURL returns the instance URL without trailing slash.
func (c *Client) BaseURL() string { return c.base.String() }

type call struct {
	method string
	path   string
	body   any
	out    any
	noAuth bool
	// idempotent calls are retried after timeouts and any 5xx; other calls
	// only when the request certainly did not take effect (connection could
	// not be established, 429, 502, 503, 504).
	idempotent bool
	retry      *RetryPolicy
	// tolerate lists status codes that count as success without a body.
	tolerate []int
}

func (c *Client) do(ctx context.Context, cl call) error {
	var payload []byte
	if cl.body != nil {
		var err error
		payload, err = json.Marshal(cl.body)
		if err != nil {
			return fmt.Errorf("encode %s %s: %w", cl.method, cl.path, err)
		}
	}
	policy := c.retry
	if cl.retry != nil {
		policy = *cl.retry
	}
	if policy.MaxAttempts < 1 {
		policy.MaxAttempts = 1
	}
	var lastErr error
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		retryAfter, err := c.once(ctx, cl, payload)
		if err == nil {
			return nil
		}
		lastErr = err
		if ctx.Err() != nil || !retryable(err, cl.idempotent) || attempt == policy.MaxAttempts {
			return err
		}
		delay := backoff(policy, attempt)
		if retryAfter > 0 {
			delay = retryAfter
			if delay > 2*time.Minute {
				delay = 2 * time.Minute
			}
		}
		if serr := c.sleep(ctx, delay); serr != nil {
			return lastErr
		}
	}
	return lastErr
}

func (c *Client) once(ctx context.Context, cl call, payload []byte) (time.Duration, error) {
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	target := c.base.String() + cl.path
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(actx, cl.method, target, body)
	if err != nil {
		return 0, err
	}
	c.decorate(req, cl.noAuth)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, rerr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if rerr != nil {
		return 0, rerr
	}
	if len(data) > maxResponseBytes {
		return 0, fmt.Errorf("%s %s: response larger than %d bytes", cl.method, cl.path, maxResponseBytes)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if cl.out != nil && len(bytes.TrimSpace(data)) > 0 {
			if err := json.Unmarshal(data, cl.out); err != nil {
				return 0, fmt.Errorf("%s %s: invalid JSON in answer: %w", cl.method, cl.path, err)
			}
		}
		return 0, nil
	}
	for _, t := range cl.tolerate {
		if resp.StatusCode == t {
			return 0, nil
		}
	}
	ae := &APIError{Method: cl.method, Path: cl.path, Status: resp.StatusCode}
	ae.RetryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
	if len(data) > 0 {
		var p struct {
			Type   string `json:"type"`
			Title  string `json:"title"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(data, &p) == nil {
			ae.Type, ae.Title, ae.Detail = p.Type, p.Title, p.Detail
		}
	}
	if ae.Title == "" {
		ae.Title = http.StatusText(resp.StatusCode)
	}
	return ae.RetryAfter, ae
}

func (c *Client) decorate(req *http.Request, noAuth bool) {
	req.Header.Set("Accept", "application/json, "+problemJSON)
	req.Header.Set("User-Agent", buildinfo.UserAgent())
	if !noAuth && c.endpointID != "" {
		req.SetBasicAuth(c.endpointID, c.secret)
	}
}

func retryable(err error, idempotent bool) bool {
	var ae *APIError
	if errors.As(err, &ae) {
		switch ae.Status {
		case 429, 502, 503, 504:
			return true
		case 408, 500, 425:
			return idempotent
		}
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if idempotent {
		// Any network-level failure or an answer cut short.
		return true
	}
	// Non-idempotent: only when the request cannot have reached the server.
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return true
	}
	return false
}

func backoff(p RetryPolicy, attempt int) time.Duration {
	ceiling := p.BaseDelay << (attempt - 1)
	if ceiling <= 0 || ceiling > p.MaxDelay {
		ceiling = p.MaxDelay
	}
	if ceiling <= 0 {
		return 0
	}
	// Full jitter, at least half of the ceiling so retries do not pile up at zero.
	half := ceiling / 2
	return half + time.Duration(rand.Int64N(int64(half)+1))
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

// Enroll exchanges the one-time token for credentials. It is not
// authenticated and is retried only when the request cannot have reached the
// server, because the token is single use.
func Enroll(ctx context.Context, baseURL string, allowInsecure bool, req EnrollRequest) (*EnrollResponse, error) {
	base, err := ParseBaseURL(baseURL, allowInsecure)
	if err != nil {
		return nil, err
	}
	c := newClient(base, Options{AllowInsecureHTTP: allowInsecure, RequestTimeout: 60 * time.Second,
		Retry: RetryPolicy{MaxAttempts: 4, BaseDelay: 2 * time.Second, MaxDelay: 20 * time.Second}})
	var out EnrollResponse
	if err := c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/enroll", body: req, out: &out, noAuth: true}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Config fetches the endpoint configuration.
func (c *Client) Config(ctx context.Context) (*Config, error) {
	var out Config
	if err := c.do(ctx, call{method: http.MethodGet, path: "/agent/v1/config", out: &out, idempotent: true}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Heartbeat reports liveness and returns pending tasks. It is tried once per
// call: the main loop repeats it on its own schedule.
func (c *Client) Heartbeat(ctx context.Context, req HeartbeatRequest) (*HeartbeatResponse, error) {
	var out HeartbeatResponse
	once := RetryPolicy{MaxAttempts: 2, BaseDelay: time.Second, MaxDelay: 5 * time.Second}
	if err := c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/heartbeat", body: req, out: &out, idempotent: false, retry: &once}); err != nil {
		return nil, err
	}
	return &out, nil
}

// StartRun registers a run and returns its id.
func (c *Client) StartRun(ctx context.Context, req StartRunRequest) (Flex, error) {
	var out StartRunResponse
	if err := c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/runs", body: req, out: &out}); err != nil {
		return "", err
	}
	if out.RunID == "" {
		return "", errors.New("POST /agent/v1/runs: the server returned no runId")
	}
	return out.RunID, nil
}

// SendProgress reports progress. Best effort: a single attempt.
func (c *Client) SendProgress(ctx context.Context, runID Flex, p Progress) error {
	one := RetryPolicy{MaxAttempts: 1}
	return c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/runs/" + url.PathEscape(runID.String()) + "/progress", body: p, retry: &one})
}

// FinishRun reports the end of a run. It retries generously because the
// result is the most valuable message of a run; a 409 (already finished)
// counts as success so that a repeated delivery is harmless.
func (c *Client) FinishRun(ctx context.Context, runID Flex, f FinishRequest) error {
	if f.Errors == nil {
		f.Errors = []RunError{}
	}
	long := RetryPolicy{MaxAttempts: 8, BaseDelay: 2 * time.Second, MaxDelay: 60 * time.Second}
	return c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/runs/" + url.PathEscape(runID.String()) + "/finish",
		body: f, retry: &long, idempotent: true, tolerate: []int{http.StatusConflict}})
}

// CheckUpdate asks for a newer agent binary. It returns nil when there is none.
func (c *Client) CheckUpdate(ctx context.Context) (*UpdateInfo, error) {
	var raw json.RawMessage
	if err := c.do(ctx, call{method: http.MethodGet, path: "/agent/v1/update", out: &raw, idempotent: true}); err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	var info UpdateInfo
	if err := json.Unmarshal(trimmed, &info); err != nil {
		return nil, fmt.Errorf("GET /agent/v1/update: invalid answer: %w", err)
	}
	if info.Version == "" && info.URL == "" {
		return nil, nil
	}
	return &info, nil
}

// ResolveSameOrigin resolves an update URL against the instance and refuses
// anything that is not on the same scheme and host, so a compromised answer
// cannot point the agent at a third party.
func (c *Client) ResolveSameOrigin(raw string) (*url.URL, error) {
	ref, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid download URL %q: %v", raw, err)
	}
	target := c.base.ResolveReference(ref)
	if target.Scheme != c.base.Scheme || !strings.EqualFold(target.Host, c.base.Host) {
		return nil, fmt.Errorf("refusing download from %s: it is not the Restow instance %s", target.Host, c.base.Host)
	}
	if target.User != nil {
		return nil, errors.New("refusing download URL with credentials")
	}
	return target, nil
}

// Download streams a same-origin file into w and returns its SHA-256 (hex).
// At most maxBytes are read. No retry here; the caller decides.
func (c *Client) Download(ctx context.Context, rawURL string, w io.Writer, maxBytes int64) (string, error) {
	target, err := c.ResolveSameOrigin(rawURL)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", err
	}
	c.decorate(req, false)
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &APIError{Method: http.MethodGet, Path: target.Path, Status: resp.StatusCode, Title: http.StatusText(resp.StatusCode)}
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return "", err
	}
	if n > maxBytes {
		return "", fmt.Errorf("download from %s exceeds %d bytes", target.Host, maxBytes)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
