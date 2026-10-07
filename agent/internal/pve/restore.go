package pve

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
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

func restoreKey(volname, device string) string {
	sum := sha256.Sum256([]byte(volname))
	return fmt.Sprintf("%x-%s", sum[:6], device)
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
	key := restoreKey(req.Volname, req.Device)
	sock := filepath.Join(p.restoreDir(), key+".sock")
	pidFile := filepath.Join(p.restoreDir(), key+".pid")
	p.stopRestoreServers(req.Volname, req.Device)
	exe := p.Exe
	if exe == "" {
		exe, _ = os.Executable()
	}
	logFile, err := os.OpenFile(filepath.Join(p.restoreDir(), key+".log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	defer logFile.Close()
	cmd := exec.Command(exe, "serve-restore", "--volname", req.Volname, "--device", req.Device, "--socket", sock)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.Dial("unix", sock); err == nil {
			_ = c.Close()
			_ = cmd.Process.Release()
			p.logf("info", "%s: serving the restore point over NBD", req.Device)
			return map[string]any{"qemuImgPath": "nbd+unix:///" + req.Device + "?socket=" + sock}, nil
		}
		select {
		case err := <-done:
			log, _ := readTail(filepath.Join(p.restoreDir(), key+".log"), 2048)
			return nil, fmt.Errorf("the restore server ended: %v: %s", err, strings.TrimSpace(string(log)))
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	_ = cmd.Process.Kill()
	return nil, errors.New("the restore server did not start within 60 seconds")
}

// stopRestoreServers stops the restore servers of a volume (one device or all).
func (p *Provider) stopRestoreServers(volname, device string) {
	prefix := restoreKey(volname, "")
	entries, _ := os.ReadDir(p.restoreDir())
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".pid") || !strings.HasPrefix(name, prefix) {
			continue
		}
		if device != "" && name != restoreKey(volname, device)+".pid" {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(p.restoreDir(), name))
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 1 {
			_ = syscall.Kill(pid, syscall.SIGTERM)
		}
		base := strings.TrimSuffix(name, ".pid")
		for _, ext := range []string{".pid", ".sock"} {
			_ = os.Remove(filepath.Join(p.restoreDir(), base+ext))
		}
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
		r.prefetch(idx + 1)
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
	r.prefetch(idx + 1)
	if !ok {
		if err == nil {
			err = fmt.Errorf("block %d was not delivered", idx)
		}
		return nil, err
	}
	return data, nil
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
		for len(r.order) > restoreCacheBlocks+int(r.ahead) {
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

// ServeRestore runs the restore server of one disk until ctx ends.
func ServeRestore(ctx context.Context, layout Layout, volname, device, socket string, logf func(string, ...any)) error {
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
			return &nbd.Export{Size: size, Reader: img, Allocation: img.Allocation}, true
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
