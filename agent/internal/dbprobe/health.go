package dbprobe

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// HealthTimeout bounds one health check (docs/DATABASES.md 8: 10 seconds).
const HealthTimeout = 10 * time.Second

// connTracker remembers every connection a check opened, to close them all
// when its deadline passes.
type connTracker struct {
	mu     sync.Mutex
	conns  []net.Conn
	closed bool
}

func (t *connTracker) add(c net.Conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		_ = c.Close()
		return
	}
	t.conns = append(t.conns, c)
}

func (t *connTracker) closeAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	for _, c := range t.conns {
		_ = c.Close()
	}
	t.conns = nil
}

// Health runs one health check of a stored connection (D2): the probe in its
// health purpose, with the confirmed certificate of the spec (another one
// ends it before the sign-in), under one overall deadline of HealthTimeout.
// When the deadline passes every connection the check opened is closed and
// the result is a failed check (db_unreachable), whatever step it was in. It
// never fails and never outlives its deadline; the credentials stay in the
// spec the caller holds.
func Health(ctx context.Context, spec api.DBProbeSpec, o Options) api.DBProbeResult {
	timeout := HealthTimeout
	if spec.TimeoutSeconds > 0 && time.Duration(spec.TimeoutSeconds)*time.Second < timeout {
		timeout = time.Duration(spec.TimeoutSeconds) * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	spec.Purpose = api.PurposeHealth
	tracker := &connTracker{}
	inner := o.dial()
	o.Dial = func(dctx context.Context, network, address string) (net.Conn, error) {
		c, err := inner(dctx, network, address)
		if err == nil {
			tracker.add(c)
		}
		return c, err
	}
	stop := context.AfterFunc(ctx, tracker.closeAll)
	defer stop()
	started := time.Now()
	done := make(chan api.DBProbeResult, 1)
	go func() { done <- Run(ctx, spec, o) }()
	select {
	case res := <-done:
		tracker.closeAll()
		return res
	case <-ctx.Done():
		tracker.closeAll()
		// The probe ends on its closed connections; a step that does not read
		// from one (an SQLite file that does not open) is left behind.
		select {
		case res := <-done:
			if res.Error == nil {
				return res
			}
		case <-time.After(100 * time.Millisecond):
		}
		return api.DBProbeResult{
			TLS:   emptyTLS(nil),
			Login: LoginSkipped,
			Error: &api.DBProbeError{
				Code:    CodeUnreachable,
				Message: "the check did not finish within " + timeout.String(),
			},
			DurationMs: time.Since(started).Milliseconds(),
		}
	}
}
