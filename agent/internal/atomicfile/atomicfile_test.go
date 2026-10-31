package atomicfile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var errBusy = errors.New("busy")

func TestRetryStopsOnSuccessAndPermanentErrors(t *testing.T) {
	var pauses []time.Duration
	sleep := func(d time.Duration) { pauses = append(pauses, d) }
	calls := 0
	err := retry(func() error {
		calls++
		if calls < 4 {
			return errBusy
		}
		return nil
	}, func(err error) bool { return errors.Is(err, errBusy) }, sleep)
	if err != nil || calls != 4 {
		t.Fatalf("err %v after %d calls", err, calls)
	}
	if len(pauses) != 3 || pauses[0] != 50*time.Millisecond || pauses[2] != 200*time.Millisecond {
		t.Fatalf("pauses %v", pauses)
	}

	calls = 0
	perm := errors.New("permanent")
	if err := retry(func() error { calls++; return perm }, func(err error) bool { return errors.Is(err, errBusy) }, sleep); !errors.Is(err, perm) || calls != 1 {
		t.Fatalf("permanent: %v after %d calls", err, calls)
	}
}

func TestRetryGivesUp(t *testing.T) {
	var total time.Duration
	calls := 0
	err := retry(func() error { calls++; return errBusy }, func(error) bool { return true }, func(d time.Duration) { total += d })
	if !errors.Is(err, errBusy) || calls != maxAttempts {
		t.Fatalf("err %v after %d calls", err, calls)
	}
	if total > 6*time.Second || total < 3*time.Second {
		t.Fatalf("total pause %v", total)
	}
}

func TestRenameReplacesAndReadFile(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	if err := os.WriteFile(a, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A reader that holds the target open must not block the replacement.
	f, err := Open(b)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := Rename(a, b); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFile(b)
	if err != nil || string(got) != "new" {
		t.Fatalf("%q %v", got, err)
	}
}
