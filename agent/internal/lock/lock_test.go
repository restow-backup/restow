//go:build unix

package lock

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "run.lock")
	first, err := TryAcquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := TryAcquire(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("second acquire: err = %v, want ErrLocked", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	again, err := TryAcquire(path)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	_ = again.Release()
}
