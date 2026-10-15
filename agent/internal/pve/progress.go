package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
)

// Progress is how far a running backup is (POST /runs/:id/progress): the
// bytes read so far, the total to read once it is known, and what was
// uploaded (VMs; restic does not say it while it runs).
type Progress struct {
	BytesDone     uint64  `json:"bytesDone"`
	BytesTotal    *uint64 `json:"bytesTotal,omitempty"`
	BytesUploaded *uint64 `json:"bytesUploaded,omitempty"`
}

// ProgressSender delivers one report.
type ProgressSender func(ctx context.Context, p Progress) error

// progressTimeout bounds one report; a slow server never holds a backup up.
const progressTimeout = 10 * time.Second

// ProgressReporter sends the newest progress every interval from its own
// goroutine, so the backup only stores a value and never waits for the
// network. Reports are best effort: a failure is ignored, and an answer that
// says the server or the run takes no reports (401, 403, 404, 409) ends them
// for the run. A nil reporter does nothing.
type ProgressReporter struct {
	mu      sync.Mutex
	latest  Progress
	changed bool
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

// StartProgress starts a reporter; nil when the server asked for no reports
// (interval 0: a server before 0.4.0) or there is no sender.
func StartProgress(ctx context.Context, interval time.Duration, send ProgressSender) *ProgressReporter {
	if interval <= 0 || send == nil {
		return nil
	}
	r := &ProgressReporter{stop: make(chan struct{}), done: make(chan struct{})}
	go r.loop(ctx, interval, send)
	return r
}

func (r *ProgressReporter) loop(ctx context.Context, interval time.Duration, send ProgressSender) {
	defer close(r.done)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		last := false
		select {
		case <-ctx.Done():
			return
		case <-r.stop:
			// The last figure once more: a VM's commit can take a while after the read.
			last = true
		case <-t.C:
		}
		r.mu.Lock()
		p, changed := r.latest, r.changed
		r.changed = false
		r.mu.Unlock()
		if changed {
			sctx, cancel := context.WithTimeout(ctx, progressTimeout)
			err := send(sctx, p)
			cancel()
			if err != nil && progressRefused(err) {
				return
			}
		}
		if last {
			return
		}
	}
}

// progressRefused reports whether the server takes no reports for this run.
func progressRefused(err error) bool {
	for _, status := range []int{401, 403, 404, 405, 409} {
		if IsStatus(err, status) {
			return true
		}
	}
	return false
}

// Set records the newest progress; the next tick sends it.
func (r *ProgressReporter) Set(p Progress) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.latest, r.changed = p, true
	r.mu.Unlock()
}

// Stop sends the newest progress if it was not sent yet, ends the reports and
// waits for them.
func (r *ProgressReporter) Stop() {
	if r == nil {
		return
	}
	r.once.Do(func() { close(r.stop) })
	<-r.done
}

func uint64Ptr(v uint64) *uint64 { return &v }

// progressUnit is one second of the server's interval (tests shorten it).
var progressUnit = time.Second

// intervalSeconds turns the server's interval into a duration (0: none),
// never below two seconds whatever a server asks for.
func intervalSeconds(s int) time.Duration {
	if s <= 0 {
		return 0
	}
	return time.Duration(max(s, 2)) * progressUnit
}

// runCredentialSender posts progress with a run's restic credential: the
// unprivileged container backup holds no node secret.
func runCredentialSender(client *http.Client, url, user, password string) ProgressSender {
	return func(ctx context.Context, p Progress) error {
		body, err := json.Marshal(p)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "restow-pve/"+buildinfo.Version)
		req.Header.Set("X-Restow-Helper-Version", buildinfo.Version)
		req.SetBasicAuth(user, password)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return &ServerError{Status: resp.StatusCode, Title: http.StatusText(resp.StatusCode)}
		}
		return nil
	}
}

// newRunCredentialSender is runCredentialSender with the helper's HTTP client.
func newRunCredentialSender(url, user, password string) ProgressSender {
	if url == "" {
		return nil
	}
	return runCredentialSender(api.NewHTTPClient(strings.HasPrefix(url, "http://")), url, user, password)
}
