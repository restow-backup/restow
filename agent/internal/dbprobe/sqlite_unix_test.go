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

func TestSQLiteDoesNotWaitOnAPipe(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "app.db")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("no fifo here: %v", err)
	}
	done := make(chan api.DBProbeResult, 1)
	go func() {
		done <- Run(context.Background(), api.DBProbeSpec{Path: &fifo, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast)
	}()
	select {
	case r := <-done:
		if code(r) != CodeNotADatabase {
			t.Fatalf("pipe: %+v", r.Error)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the probe waits on a pipe")
	}
}
