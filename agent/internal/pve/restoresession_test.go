//go:build !windows

package pve

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"
)

func withOwner(t *testing.T, pid int) {
	t.Helper()
	old := restoreOwner
	restoreOwner = func() int { return pid }
	t.Cleanup(func() { restoreOwner = old })
}

func serverAnswers(p *Provider, owner int) bool {
	c, err := net.Dial("unix", filepath.Join(p.restoreDir(), restoreKey(restoreReq().Volname, owner, restoreReq().Device)+".sock"))
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// Two restores of one restore point (a boot test beside a restore from the PVE UI): each PVE
// worker gets its own server, and the cleanup of one leaves the other serving.
func TestTwoRestoresOfOneRestorePointKeepTheirServers(t *testing.T) {
	p := restoreProvider(t, "serve")
	a, b := os.Getpid(), os.Getppid()
	withOwner(t, a)
	if _, err := p.restoreVolumeInit(context.Background(), restoreReq()); err != nil {
		t.Fatal(err)
	}
	withOwner(t, b)
	if _, err := p.restoreVolumeInit(context.Background(), restoreReq()); err != nil {
		t.Fatal(err)
	}
	if !serverAnswers(p, a) || !serverAnswers(p, b) {
		t.Fatal("the second init stopped the first one's server")
	}
	pidA := readPID(filepath.Join(p.restoreDir(), restoreKey(restoreReq().Volname, a, restoreReq().Device)+".pid"))
	withOwner(t, a)
	if _, err := p.Handle(context.Background(), "restore-vm-volume-cleanup", restoreReq()); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(context.Background(), "restore-vm-cleanup", restoreReq()); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pidA)
	if serverAnswers(p, a) || !serverAnswers(p, b) {
		t.Fatal("the first restore's cleanup did not stop its own server only")
	}
	pidB := readPID(filepath.Join(p.restoreDir(), restoreKey(restoreReq().Volname, b, restoreReq().Device)+".pid"))
	withOwner(t, b)
	if _, err := p.Handle(context.Background(), "restore-vm-cleanup", restoreReq()); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pidB)
	if files := restoreFiles(t, p); len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
}

// A server whose PVE worker is gone (it crashed before its cleanup) is stopped by the next init.
func TestRestoreInitReapsTheServerOfAGoneWorker(t *testing.T) {
	p := restoreProvider(t, "serve")
	a, b := os.Getpid(), os.Getppid()
	withOwner(t, a)
	if _, err := p.restoreVolumeInit(context.Background(), restoreReq()); err != nil {
		t.Fatal(err)
	}
	keyA := restoreKey(restoreReq().Volname, a, restoreReq().Device)
	pidA := readPID(filepath.Join(p.restoreDir(), keyA+".pid"))
	// The worker a ended: its start time no longer matches.
	if err := os.WriteFile(filepath.Join(p.restoreDir(), keyA+".owner"), []byte("999999999 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	withOwner(t, b)
	if _, err := p.restoreVolumeInit(context.Background(), restoreReq()); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pidA)
	if serverAnswers(p, a) || !serverAnswers(p, b) {
		t.Fatal("the orphaned server is not reaped, or the new one does not serve")
	}
	withOwner(t, b)
	_, _ = p.Handle(context.Background(), "restore-vm-cleanup", restoreReq())
}

// The restore server stops after a time without requests, and every request resets it.
func TestRestoreServerIdleTimeout(t *testing.T) {
	a := &activity{}
	// Wide apart: the idle time is 100 times the gap between requests. On a busy CI runner a
	// 20 ms sleep took longer than an idle time of 80 ms, and the watcher stopped rightly.
	ctx := watchIdle(context.Background(), a, 2*time.Second, 5*time.Millisecond, func(string, ...any) {})
	for i := 0; i < 10; i++ {
		time.Sleep(20 * time.Millisecond)
		a.touch()
		if ctx.Err() != nil {
			t.Fatalf("stopped after %d requests 20 ms apart", i)
		}
	}
	select {
	case <-ctx.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("did not stop without requests")
	}
	// A read through the export counts as a request.
	b := &activity{}
	r := touchingReader{r: zeroReader{}, a: b}
	b.last = time.Now().Add(-time.Hour)
	_, _ = r.ReadAt(make([]byte, 8), 0)
	if b.since() > time.Second {
		t.Fatal("a read is no activity")
	}
}

type zeroReader struct{}

func (zeroReader) ReadAt(p []byte, _ int64) (int, error) { clear(p); return len(p), nil }

type recordingFetcher struct {
	mu    sync.Mutex
	froms []uint32
}

func (f *recordingFetcher) RestoreBlocks(_ context.Context, _, _ string, from, count uint32) ([]RestoreBlock, error) {
	f.mu.Lock()
	f.froms = append(f.froms, from)
	f.mu.Unlock()
	out := make([]RestoreBlock, 0, count)
	for i := from; i < from+count; i++ {
		out = append(out, RestoreBlock{Index: i, Zero: true, Length: BlockSize})
	}
	return out, nil
}

func (f *recordingFetcher) started() []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := append([]uint32(nil), f.froms...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Reading the first block of a batch starts the next batch: two batches are in flight.
func TestRestoreImageKeepsTwoBatchesInFlight(t *testing.T) {
	f := &recordingFetcher{}
	flags := make([]byte, 12)
	for i := range flags {
		flags[i] = FlagPresent
	}
	img := NewRestoreImage(context.Background(), f, "s1", "drive-scsi0", 12*BlockSize, flags)
	img.ahead = 4
	buf := make([]byte, 4096)
	if _, err := img.ReadAt(buf, 0); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(f.started()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := f.started(); len(got) != 2 || got[0] != 0 || got[1] != 4 {
		t.Fatalf("batches started after the first read: %v, want [0 4]", got)
	}
	// Reading on through the image fetches each block once, the next batch always ahead.
	for at := int64(BlockSize); at < 12*BlockSize; at += BlockSize {
		if _, err := img.ReadAt(buf, at); err != nil {
			t.Fatal(err)
		}
	}
	if got := f.started(); len(got) != 3 || got[2] != 8 {
		t.Fatalf("batches %v, want [0 4 8]", got)
	}
}
