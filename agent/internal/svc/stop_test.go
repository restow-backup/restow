package svc

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// A service that does not stop in time is an error the uninstall stops at
// (K118); one that stops, or was not running, is none.
func TestStopAndConfirm(t *testing.T) {
	never := func() (bool, uint32, error) { return false, 4242, nil }
	err := stopAndConfirm(func() error { return nil }, never, 30*time.Millisecond, time.Millisecond)
	if !errors.Is(err, ErrStillRunning) || !strings.Contains(err.Error(), "4242") || !strings.Contains(err.Error(), "did not stop within") {
		t.Fatalf("timeout: %v", err)
	}
	n := 0
	later := func() (bool, uint32, error) { n++; return n > 3, 4242, nil }
	if err := stopAndConfirm(func() error { return nil }, later, time.Second, time.Millisecond); err != nil {
		t.Fatalf("a service that stops: %v", err)
	}
	// A refused stop request decides nothing; the state does.
	refused := errors.New("access denied")
	if err := stopAndConfirm(func() error { return refused }, func() (bool, uint32, error) { return true, 0, nil }, time.Second, time.Millisecond); err != nil {
		t.Fatalf("a stopped service whose stop request failed: %v", err)
	}
	if err := stopAndConfirm(func() error { return refused }, never, time.Second, time.Millisecond); !errors.Is(err, ErrStillRunning) || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("a running service that refuses to stop: %v", err)
	}
	if err := stopAndConfirm(func() error { return nil }, func() (bool, uint32, error) { return false, 0, errors.New("gone") }, time.Second, time.Millisecond); !errors.Is(err, ErrStillRunning) {
		t.Fatalf("an unreadable state: %v", err)
	}
}
