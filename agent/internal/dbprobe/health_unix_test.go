//go:build unix

package dbprobe

import (
	"context"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The health check of an SQLite connection whose file was replaced by a pipe
// ends at once (non-blocking open, D1), well inside its own deadline.
//
// claim: DB-004
func TestHealthCheckDoesNotWaitOnAPipe(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "data.db")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("no fifo here: %v", err)
	}
	engine := EngineSQLite
	done := make(chan api.DBProbeResult, 1)
	start := time.Now()
	go func() {
		done <- Health(context.Background(), api.DBProbeSpec{Engine: &engine, Path: &fifo, AuthMethod: AuthPassword}, fast)
	}()
	select {
	case r := <-done:
		if r.Error == nil || r.Error.Code != CodeNotADatabase || r.SQLite != nil {
			t.Fatalf("pipe: %+v %+v", r, r.Error)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatalf("the check took %v", time.Since(start))
		}
	case <-time.After(HealthTimeout + 2*time.Second):
		t.Fatal("the health check waits on a pipe")
	}
}
