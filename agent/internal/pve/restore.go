//go:build !windows

package pve

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/nbd"
)

// A VM restore runs `qemu-img convert` on the PVE side with a source path the
// provider returns. restow-pve answers it with an NBD URI and starts a
// detached `restow-pve serve-restore` that serves the synthetic full image of
// one disk from the Restow server until restore_vm_volume_cleanup stops it.
//
// A restore server belongs to the PVE worker that restores (the parent of `restow-pve
// provider`, which calls init and cleanup from the same process): its key holds the volname,
// that worker's pid and the device, and <key>.owner records the worker's start time. Two
// restores of one restore point (a boot test beside a restore from the PVE UI, two clones of
// one backup) get a server each; a cleanup stops only its own worker's servers, and an init
// stops another worker's server only when that worker is gone.

// restoreKey is the key of the restore server of one disk for one restoring worker.
func restoreKey(volname string, owner int, device string) string {
	return fmt.Sprintf("%s-%d-%s", restoreVolPrefix(volname), owner, device)
}

// restoreVolPrefix starts the keys of every restore server of a volname.
func restoreVolPrefix(volname string) string {
	sum := sha256.Sum256([]byte(volname))
	return fmt.Sprintf("%x", sum[:6])
}

// legacyRestoreKey is the key of a restore server before 0.5.0 (no owner).
func legacyRestoreKey(volname, device string) string {
	return restoreVolPrefix(volname) + "-" + device
}

func (p *Provider) restoreDir() string { return filepath.Join(p.Layout.RunDir, "restore") }

func (p *Provider) restoreVolumeInit(ctx context.Context, req ProviderRequest) (any, error) {
	if !p.state.RestoresAllowed() {
		return nil, errors.New("restores are switched off on this node (restow-pve config --allow-restores=false)")
	}
	if req.Device == "" || strings.ContainsAny(req.Device, "/?&") {
		return nil, fmt.Errorf("invalid device %q", req.Device)
	}
	if err := os.MkdirAll(p.restoreDir(), 0o700); err != nil {
		return nil, err
	}
	owner := restoreOwner()
	key := restoreKey(req.Volname, owner, req.Device)
	sock := filepath.Join(p.restoreDir(), key+".sock")
	pidFile := filepath.Join(p.restoreDir(), key+".pid")
	// This worker's own server of the disk (an init asked again) goes; another worker's only
	// when that worker is gone.
	p.stopRestoreServers(req.Volname, owner, req.Device)
	p.reapOrphanedRestoreServers()
	if err := os.WriteFile(filepath.Join(p.restoreDir(), key+".owner"), []byte(fmt.Sprintf("%d %s\n", owner, processStart(owner))), 0o600); err != nil {
		return nil, err
	}
	exe := p.Exe
	if exe == "" {
		exe, _ = os.Executable()
	}
	logPath := filepath.Join(p.restoreDir(), key+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	defer logFile.Close()
	cmd := exec.Command(exe, "serve-restore", "--volname", req.Volname, "--device", req.Device, "--socket", sock)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		removeRestoreFiles(p.restoreDir(), key)
		return nil, err
	}
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	// Every way out but a served socket ends the server and removes its files: a detached server
	// left running would serve for up to 48 hours, and its files would mark the node busy.
	abandon := func() {
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		removeRestoreFiles(p.restoreDir(), key)
	}
	deadline := time.Now().Add(restoreServerStartTimeout)
	for time.Now().Before(deadline) {
		if c, err := net.Dial("unix", sock); err == nil {
			_ = c.Close()
			_ = cmd.Process.Release()
			p.logf("info", "%s: serving the restore point over NBD", req.Device)
			return map[string]any{"qemuImgPath": "nbd+unix:///" + req.Device + "?socket=" + sock}, nil
		}
		select {
		case err := <-done:
			log, _ := readTail(logPath, 2048)
			removeRestoreFiles(p.restoreDir(), key)
			return nil, fmt.Errorf("the restore server ended: %v: %s", err, strings.TrimSpace(string(log)))
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			abandon()
			return nil, ctx.Err()
		}
	}
	abandon()
	return nil, fmt.Errorf("the restore server did not start within %s", restoreServerStartTimeout)
}

// restoreServerStartTimeout is how long restore-vm-volume-init waits for the server's socket
// while the server runs: before it listens it reads the restore point and the hash list of the
// disk (33 bytes per 4 MiB block, about 140 MB for 16 TB), which takes a while on a slow link.
// A server that ends is noticed at once.
var restoreServerStartTimeout = 10 * time.Minute

// removeRestoreFiles removes the pid file, socket, log and owner record of one restore server.
func removeRestoreFiles(dir, key string) {
	for _, ext := range []string{".pid", ".sock", ".log", ".owner"} {
		_ = os.Remove(filepath.Join(dir, key+ext))
	}
}

// stopRestoreServers stops the restore servers of a volume that the worker owner started (one
// device or all), and those of the same volume a restow-pve before 0.5.0 started (no owner),
// and removes their files. A pid file whose process is no restore server of that disk any more
// (it ended, and the pid may belong to another process since) is removed without a signal.
func (p *Provider) stopRestoreServers(volname string, owner int, device string) {
	entries, _ := os.ReadDir(p.restoreDir())
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".pid") {
			continue
		}
		key := strings.TrimSuffix(name, ".pid")
		mine := key == restoreKey(volname, owner, device) ||
			(device == "" && strings.HasPrefix(key, fmt.Sprintf("%s-%d-", restoreVolPrefix(volname), owner)))
		legacy := key == legacyRestoreKey(volname, device) ||
			(device == "" && strings.HasPrefix(key, restoreVolPrefix(volname)+"-") && !ownedKey(key))
		if mine || legacy {
			p.stopRestoreServer(key)
		}
	}
}

// ownedKey: a key with an owner (restoreKey), not one before 0.5.0.
func ownedKey(key string) bool {
	parts := strings.SplitN(key, "-", 3)
	if len(parts) != 3 {
		return false
	}
	_, err := strconv.Atoi(parts[1])
	return err == nil
}

func (p *Provider) stopRestoreServer(key string) {
	if pid := readPID(filepath.Join(p.restoreDir(), key+".pid")); pid > 1 && liveProcess(pid, "restow-pve", "serve-restore", key) {
		_ = signalProcess(pid)
	}
	removeRestoreFiles(p.restoreDir(), key)
}

// reapOrphanedRestoreServers stops the restore servers whose worker is gone (a restore that
// crashed or was killed before its cleanup).
func (p *Provider) reapOrphanedRestoreServers() {
	entries, _ := os.ReadDir(p.restoreDir())
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".owner") {
			continue
		}
		key := strings.TrimSuffix(name, ".owner")
		data, _ := os.ReadFile(filepath.Join(p.restoreDir(), name))
		f := strings.Fields(string(data))
		if len(f) != 2 {
			continue
		}
		pid, err := strconv.Atoi(f[0])
		if err != nil || pid <= 1 || processStart(pid) == f[1] {
			continue
		}
		p.logf("info", "stopping the restore server %s: the restore it served for has ended", key)
		p.stopRestoreServer(key)
	}
}

// BlockFetcher is what the restore image needs of the server.
type BlockFetcher interface {
	RestoreBlocks(ctx context.Context, snapshotID, device string, from, count uint32) ([]RestoreBlock, error)
}

// RestoreImage is the synthetic full image of one disk: reads are served from
// blocks fetched from the server, with sequential read-ahead; zero blocks are
// answered locally.
type RestoreImage struct {
	ctx        context.Context
	fetch      BlockFetcher
	snapshotID string
	device     string
	size       uint64
	zero       []bool
	ahead      uint32

	mu    sync.Mutex
	cache map[uint32][]byte
	order []uint32
	inFl  map[uint32]chan struct{}
	err   error
}

// NewRestoreImage creates the image. flags is the per-block flag list of the
// map (FlagZero marks blocks never stored).
func NewRestoreImage(ctx context.Context, fetch BlockFetcher, snapshotID, device string, size uint64, flags []byte) *RestoreImage {
	zero := make([]bool, BlockCount(size))
	for i := range zero {
		if i < len(flags) && flags[i]&FlagPresent == 0 {
			zero[i] = true
		}
	}
	return &RestoreImage{ctx: ctx, fetch: fetch, snapshotID: snapshotID, device: device, size: size, zero: zero,
		ahead: 8, cache: map[uint32][]byte{}, inFl: map[uint32]chan struct{}{}}
}

const restoreCacheBlocks = 32

// ReadAt implements io.ReaderAt.
func (r *RestoreImage) ReadAt(p []byte, off int64) (int, error) {
	n := 0
	for n < len(p) {
		at := uint64(off) + uint64(n)
		if at >= r.size {
			break
		}
		idx := uint32(at / BlockSize)
		inBlock := at % BlockSize
		want := min(uint64(len(p)-n), uint64(BlockLen(r.size, idx))-inBlock)
		if r.zero[idx] {
			clear(p[n : n+int(want)])
		} else {
			data, err := r.block(idx)
			if err != nil {
				return n, err
			}
			copy(p[n:n+int(want)], data[inBlock:inBlock+want])
		}
		n += int(want)
	}
	return n, nil
}

func (r *RestoreImage) block(idx uint32) ([]byte, error) {
	r.mu.Lock()
	if data, ok := r.cache[idx]; ok {
		r.mu.Unlock()
		r.readAhead(idx)
		return data, nil
	}
	ch, flying := r.inFl[idx]
	r.mu.Unlock()
	if !flying {
		ch = r.startFetch(idx)
	}
	<-ch
	r.mu.Lock()
	data, ok := r.cache[idx]
	err := r.err
	r.mu.Unlock()
	r.readAhead(idx)
	if !ok {
		if err == nil {
			err = fmt.Errorf("block %d was not delivered", idx)
		}
		return nil, err
	}
	return data, nil
}

// readAhead keeps two batches in flight: the rest of the current one, and the next one as soon
// as a block of the current one is read (a single batch in flight bounds the restore to one
// request at a time).
func (r *RestoreImage) readAhead(idx uint32) {
	r.prefetch(idx + 1)
	r.prefetch(idx + r.ahead)
}

// startFetch fetches a run of up to `ahead` stored blocks starting at idx.
func (r *RestoreImage) startFetch(idx uint32) chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ch, ok := r.inFl[idx]; ok {
		return ch
	}
	ch := make(chan struct{})
	count := uint32(0)
	for i := idx; i < uint32(len(r.zero)) && count < r.ahead; i++ {
		if _, cached := r.cache[i]; cached {
			break
		}
		if _, f := r.inFl[i]; f {
			break
		}
		r.inFl[i] = ch
		count++
	}
	if count == 0 {
		close(ch)
		return ch
	}
	go func() {
		blocks, err := r.fetch.RestoreBlocks(r.ctx, r.snapshotID, r.device, idx, count)
		r.mu.Lock()
		if err != nil {
			r.err = err
		}
		for _, b := range blocks {
			data := b.Data
			if b.Zero {
				data = make([]byte, b.Length)
			}
			r.cache[b.Index] = data
			r.order = append(r.order, b.Index)
		}
		for i := idx; i < idx+count; i++ {
			delete(r.inFl, i)
		}
		for len(r.order) > restoreCacheBlocks+2*int(r.ahead) {
			delete(r.cache, r.order[0])
			r.order = r.order[1:]
		}
		r.mu.Unlock()
		close(ch)
	}()
	return ch
}

func (r *RestoreImage) prefetch(idx uint32) {
	for idx < uint32(len(r.zero)) && r.zero[idx] {
		idx++
	}
	if idx >= uint32(len(r.zero)) {
		return
	}
	r.mu.Lock()
	_, cached := r.cache[idx]
	_, flying := r.inFl[idx]
	r.mu.Unlock()
	if !cached && !flying {
		r.startFetch(idx)
	}
}

// Allocation answers base:allocation: zero blocks are holes.
func (r *RestoreImage) Allocation(off, length uint64) ([]nbd.Extent, error) {
	var out []nbd.Extent
	end := min(off+length, r.size)
	for at := off; at < end; {
		idx := at / BlockSize
		blockEnd := min((idx+1)*BlockSize, end)
		flags := uint32(0)
		if r.zero[idx] {
			flags = nbd.StateHole | nbd.StateZero
		}
		if n := len(out); n > 0 && out[n-1].Flags == flags {
			out[n-1].Length += blockEnd - at
		} else {
			out = append(out, nbd.Extent{Offset: at, Length: blockEnd - at, Flags: flags})
		}
		at = blockEnd
	}
	return out, nil
}

// activity records the time of the last NBD request of a restore server.
type activity struct {
	mu   sync.Mutex
	last time.Time
}

func (a *activity) touch() {
	a.mu.Lock()
	a.last = time.Now()
	a.mu.Unlock()
}

func (a *activity) since() time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	return time.Since(a.last)
}

// watchIdle returns a context that ends with ctx, or once no request came for idle (looked at
// every tick).
func watchIdle(ctx context.Context, a *activity, idle, tick time.Duration, logf func(string, ...any)) context.Context {
	ctx, cancel := context.WithCancel(ctx)
	a.touch()
	go func() {
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if a.since() >= idle {
					logf("no request for %s: stopping", idle)
					cancel()
					return
				}
			}
		}
	}()
	return ctx
}

// touchingReader marks every read as activity.
type touchingReader struct {
	r io.ReaderAt
	a *activity
}

func (t touchingReader) ReadAt(p []byte, off int64) (int, error) {
	t.a.touch()
	n, err := t.r.ReadAt(p, off)
	t.a.touch()
	return n, err
}

// ServeRestore runs the restore server of one disk until ctx ends or, with idle > 0, no NBD
// request came for idle (the restore's cleanup did not come: its PVE worker crashed).
func ServeRestore(ctx context.Context, layout Layout, volname, device, socket string, idle time.Duration, logf func(string, ...any)) error {
	st, err := LoadState(layout.StateFile)
	if err != nil {
		return err
	}
	srv, err := NewServer(st.URL, st.NodeID, st.NodeSecret, st.AllowInsecureHTTP)
	if err != nil {
		return err
	}
	rp, err := srv.ResolveVolname(ctx, volname)
	if err != nil {
		return err
	}
	var size uint64
	found := false
	for _, d := range rp.Devices {
		if d.Device == device {
			size, found = d.Size, true
		}
	}
	if !found {
		return fmt.Errorf("restore point %s has no disk %s", rp.SnapshotID, device)
	}
	hashes, err := srv.BaseHashes(ctx, rp.SnapshotID, device)
	if err != nil {
		return err
	}
	act := &activity{}
	if idle > 0 {
		ctx = watchIdle(ctx, act, idle, time.Minute, logf)
	}
	img := NewRestoreImage(ctx, srv, rp.SnapshotID, device, size, hashes.Flags)
	_ = os.Remove(socket)
	l, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	_ = os.Chmod(socket, 0o600)
	s := &nbd.Server{
		Lookup: func(name string) (*nbd.Export, bool) {
			if name != device && name != "" {
				return nil, false
			}
			return &nbd.Export{Size: size, Reader: touchingReader{img, act},
				Allocation: func(off, length uint64) ([]nbd.Extent, error) {
					act.touch()
					return img.Allocation(off, length)
				}}, true
		},
		Logf: logf,
	}
	go func() {
		<-ctx.Done()
		_ = l.Close()
		s.CloseConnections()
	}()
	logf("serving %s of %s (%d bytes) on %s", device, rp.SnapshotID, size, socket)
	return s.Serve(l)
}
