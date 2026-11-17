package dbprobe

import (
	"context"
	"errors"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// HealthTimeout bounds one health check (docs/DATABASES.md 8: 10 seconds).
const HealthTimeout = 10 * time.Second

// Health runs one health check of a stored connection (D2): the probe of a
// connection test in its health purpose, inside the same bounds as every
// probe (Run: one deadline, here at most HealthTimeout, one read budget
// shared by all its connections, every connection closed when the deadline
// passes, the SQLite file opened without blocking or following a link). The
// spec carries the confirmed certificate (PinnedFingerprintSHA256): another
// one, or no TLS, ends the check right after the handshake, before any of
// the sign-in is sent. It never fails; the credentials stay in the spec the
// caller holds.
func Health(ctx context.Context, spec api.DBProbeSpec, o Options) api.DBProbeResult {
	spec.Purpose = api.PurposeHealth
	if spec.TimeoutSeconds <= 0 || time.Duration(spec.TimeoutSeconds)*time.Second > HealthTimeout {
		spec.TimeoutSeconds = int(HealthTimeout / time.Second)
	}
	timeout := time.Duration(spec.TimeoutSeconds) * time.Second
	hctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res := Run(hctx, spec, o)
	// A check its deadline ended failed because nothing answered in time, whatever step it
	// was in (a closed connection may look like a port that answers as no database).
	if res.Error != nil && res.Login != LoginOK && deadlinePassed(hctx) {
		res.Error = &api.DBProbeError{Code: CodeUnreachable, Message: "the check did not finish within " + timeout.String()}
	}
	return res
}

// deadlinePassed: the check's deadline is (about) over. A read whose socket
// deadline is the check's own can end a moment before the context says so.
func deadlinePassed(ctx context.Context) bool {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return true
	}
	deadline, ok := ctx.Deadline()
	return ok && time.Until(deadline) <= 100*time.Millisecond
}
