package share

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
)

// APIPath is where the runner routes live below RESTOW_SHARE_API_URL (5.2).
const APIPath = "/internal/file-shares/v1"

// MaxItemsPerRequest is the cap of POST /items (5.2).
const MaxItemsPerRequest = 500

// APIError is an answer of the api that was not a success.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("the Restow api answered HTTP %d: %s", e.Status, e.Body)
}

// Client talks to the runner routes with the run's credential.
type Client struct {
	BaseURL string // RESTOW_SHARE_API_URL, e.g. http://api:3000
	RunID   string
	Token   string
	HTTP    *http.Client
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+APIPath+path, reader)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.RunID, c.Token)
	req.Header.Set("User-Agent", "restow-share/"+buildinfo.Version)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		text := strings.TrimSpace(string(data))
		if len(text) > 300 {
			text = text[:300]
		}
		return &APIError{Status: resp.StatusCode, Body: text}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Session fetches the run's session; it moves the run to running.
func (c *Client) Session(ctx context.Context) (*Session, error) {
	var s Session
	if err := c.do(ctx, http.MethodGet, "/session", nil, &s); err != nil {
		return nil, err
	}
	if s.Run.ID == "" || (s.Run.Kind != "backup" && s.Run.Kind != "restore") {
		return nil, errors.New("the session is malformed (no run id or an unknown kind)")
	}
	if s.Run.ID != c.RunID {
		return nil, errors.New("the session belongs to another run")
	}
	if s.Run.Kind == "backup" && s.Backup == nil {
		return nil, errors.New("the session of a backup has no backup parameters")
	}
	if s.Run.Kind == "restore" && s.Restore == nil {
		return nil, errors.New("the session of a restore has no restore parameters")
	}
	return &s, nil
}

// Progress reports progress; the answer says whether the run was cancelled.
func (c *Client) Progress(ctx context.Context, p ProgressReport) (cancel bool, err error) {
	var out struct {
		Cancel bool `json:"cancel"`
	}
	err = c.do(ctx, http.MethodPost, "/progress", p, &out)
	return out.Cancel, err
}

// Items posts per-file problems, at most MaxItemsPerRequest per request.
func (c *Client) Items(ctx context.Context, items []Item) error {
	for len(items) > 0 {
		n := len(items)
		if n > MaxItemsPerRequest {
			n = MaxItemsPerRequest
		}
		if err := c.do(ctx, http.MethodPost, "/items", map[string]any{"items": items[:n]}, nil); err != nil {
			return err
		}
		items = items[n:]
	}
	return nil
}

// Samples posts the sample files of a snapshot (at most 20).
func (c *Client) Samples(ctx context.Context, snapshotID string, files []SampleFile) error {
	return c.do(ctx, http.MethodPost, "/samples", map[string]any{"snapshotId": snapshotID, "files": files}, nil)
}

// Finish reports the result; it is retried a few times (the route is
// idempotent for the same body).
func (c *Client) Finish(ctx context.Context, f Finish) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * 2 * time.Second):
			}
		}
		err = c.do(ctx, http.MethodPost, "/finish", f, nil)
		var apiErr *APIError
		if err == nil || (errors.As(err, &apiErr) && apiErr.Status < 500) {
			return err
		}
	}
	return err
}
