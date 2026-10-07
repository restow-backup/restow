package pve

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/nbd"
)

const mib = 1 << 20

// memSource is an NBD export in memory with a dirty bitmap.
type memSource struct {
	data    []byte
	dirty   [][2]uint64
	mu      sync.Mutex
	trimmed []uint64
	readErr error
	reads   int
}

func (m *memSource) Size() uint64 { return uint64(len(m.data)) }
func (m *memSource) ReadAt(p []byte, off uint64) error {
	m.mu.Lock()
	m.reads++
	m.mu.Unlock()
	if m.readErr != nil {
		return m.readErr
	}
	copy(p, m.data[off:])
	return nil
}
func (m *memSource) Context(name string) (uint32, bool) {
	return 1, name == nbd.DirtyBitmapPrefix+"snapshot-access:restow"
}
func (m *memSource) Extents(_ uint32, off, length uint64) ([]nbd.Extent, error) {
	var out []nbd.Extent
	at := off
	for _, d := range m.dirty {
		if d[0] > at {
			out = append(out, nbd.Extent{Offset: at, Length: d[0] - at})
		}
		out = append(out, nbd.Extent{Offset: d[0], Length: d[1] - d[0], Flags: nbd.StateDirty})
		at = d[1]
	}
	if at < off+length {
		out = append(out, nbd.Extent{Offset: at, Length: off + length - at})
	}
	return out, nil
}
func (m *memSource) CanTrim() bool { return true }
func (m *memSource) Trim(off, _ uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.trimmed = append(m.trimmed, off/BlockSize)
	return nil
}

// memSink is the server side of uploads: it decodes frames.
type memSink struct {
	mu     sync.Mutex
	blocks map[uint32]FrameBlock
	fail   bool
}

func (s *memSink) PutBlocks(_ context.Context, _ string, frame []byte) error {
	if s.fail {
		return errors.New("upload refused")
	}
	blocks, err := DecodeFrame(bytes.NewReader(frame))
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range blocks {
		if !b.Zero && sha256.Sum256(b.Data) != b.SHA256 {
			return errors.New("hash mismatch")
		}
		s.blocks[b.Index] = b
	}
	return nil
}

func disk(size int) []byte {
	d := make([]byte, size)
	for i := range d {
		d[i] = byte(i*7 + i/4096)
	}
	return d
}

func TestFrameAndHashListRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := []FrameBlock{
		{Device: "drive-scsi0", Index: 3, Length: 5, Data: []byte("hello"), SHA256: sha256.Sum256([]byte("hello"))},
		{Device: "drive-scsi0", Index: 4, Zero: true, Length: BlockSize},
	}
	if err := EncodeFrame(&buf, in); err != nil {
		t.Fatal(err)
	}
	out, err := DecodeFrame(&buf)
	if err != nil || len(out) != 2 || string(out[0].Data) != "hello" || !out[1].Zero || out[1].Data != nil {
		t.Fatalf("%v %+v", err, out)
	}
	h := NewHashList(10*mib + 1)
	h.Flags[1] = FlagPresent
	h.Hashes[1] = sha256.Sum256([]byte("x"))
	h2, err := DecodeHashList(h.Encode())
	if err != nil || h2.Digest() != h.Digest() || len(h2.Flags) != 3 {
		t.Fatalf("%v", err)
	}
	if BlockLen(10*mib+1, 2) != 2*mib+1 || BlockLen(10*mib+1, 3) != 0 {
		t.Fatal("block lengths")
	}
}

func TestBackupDiskFullThenIncremental(t *testing.T) {
	size := 10*mib + 123 // short last block
	src := &memSource{data: disk(size)}
	clear(src.data[4*mib : 8*mib]) // block 1 is zero
	sink := &memSink{blocks: map[uint32]FrameBlock{}}
	plan := DiskPlan{Device: "drive-scsi0", Size: uint64(size), BitmapMode: "new"}
	res, err := BackupDisk(context.Background(), src, sink, "run", plan, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.ChangedBlocks != 2 || res.ZeroBlocks != 1 || len(sink.blocks) != 3 || !sink.blocks[1].Zero {
		t.Fatalf("first backup: %+v, %d blocks uploaded", res.CommitDevice, len(sink.blocks))
	}
	if len(src.trimmed) != 3 {
		t.Fatalf("every block must be discarded after the upload, got %v", src.trimmed)
	}
	// Incremental: block 0 changed, block 2 marked dirty but unchanged.
	src.data[10] ^= 0xff
	src.dirty = [][2]uint64{{0, 4 * mib}, {8 * mib, uint64(size)}}
	src.trimmed = nil
	sink.blocks = map[uint32]FrameBlock{}
	plan = DiskPlan{Device: "drive-scsi0", Size: uint64(size), BitmapMode: "reuse", BitmapName: "snapshot-access:restow", Base: res.Hashes}
	res2, err := BackupDisk(context.Background(), src, sink, "run", plan, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res2.ChangedBlocks != 1 || res2.HashSkipped != 1 || len(sink.blocks) != 1 || sink.blocks[0].Index != 0 {
		t.Fatalf("incremental: %+v", res2.CommitDevice)
	}
	if res2.ReadBytes != uint64(4*mib+2*mib+123) {
		t.Fatalf("only dirty blocks may be read, read %d", res2.ReadBytes)
	}
	if res2.Hashes.Digest() == res.Hashes.Digest() {
		t.Fatal("the block list must change")
	}
}

func TestBackupDiskFailures(t *testing.T) {
	size := 8 * mib
	src := &memSource{data: disk(size)}
	sink := &memSink{blocks: map[uint32]FrameBlock{}, fail: true}
	_, err := BackupDisk(context.Background(), src, sink, "run", DiskPlan{Device: "d", Size: uint64(size), BitmapMode: "new"}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "upload") {
		t.Fatalf("an upload failure must fail the disk: %v", err)
	}
	if len(src.trimmed) != 0 {
		t.Fatal("nothing may be discarded that the server did not acknowledge")
	}
	// Unaligned dirty extents are refused instead of reading clean parts.
	src.dirty = [][2]uint64{{mib, 2 * mib}}
	base := NewHashList(uint64(size))
	_, err = BackupDisk(context.Background(), src, &memSink{blocks: map[uint32]FrameBlock{}},
		"run", DiskPlan{Device: "d", Size: uint64(size), BitmapMode: "reuse", BitmapName: "snapshot-access:restow", Base: base}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "aligned") {
		t.Fatalf("unaligned extent: %v", err)
	}
	// reuse without a base is refused.
	_, err = BackupDisk(context.Background(), src, &memSink{blocks: map[uint32]FrameBlock{}},
		"run", DiskPlan{Device: "d", Size: uint64(size), BitmapMode: "reuse", BitmapName: "snapshot-access:restow"}, nil, nil)
	if err == nil {
		t.Fatal("reuse without base must fail")
	}
	src.readErr = errors.New("EIO")
	_, err = BackupDisk(context.Background(), src, &memSink{blocks: map[uint32]FrameBlock{}}, "run", DiskPlan{Device: "d", Size: uint64(size), BitmapMode: "new"}, nil, nil)
	if err == nil {
		t.Fatal("read errors must fail")
	}
}

// fakeRestow is a minimal /agent/pve/v1 for the provider tests.
type fakeRestow struct {
	mu          sync.Mutex
	commits     map[string]string // commitId -> snapshot
	lose        int               // answers of commit to drop (connection closed)
	failCommit  bool
	baseSnap    string
	baseDigest  string
	baseHashes  []byte
	mode        string
	blocks      int
	finished    []string
	commitCalls int
}

func (f *fakeRestow) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, APIPath)
		switch {
		case p == "/runs" && r.Method == "POST":
			_ = json.NewEncoder(w).Encode(OpenRunResponse{RunID: "run-1", GuestID: "g"})
		case strings.HasSuffix(p, "/incremental"):
			var in struct{ Devices []DeviceSize }
			_ = json.NewDecoder(r.Body).Decode(&in)
			var out []IncrementalDevice
			for _, d := range in.Devices {
				out = append(out, IncrementalDevice{Device: d.Device, Mode: f.mode, BaseSnapshotID: f.baseSnap, HashesDigest: f.baseDigest})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"devices": out})
		case strings.HasSuffix(p, "/hashes"):
			_, _ = w.Write(f.baseHashes)
		case strings.HasSuffix(p, "/blocks"):
			b, _ := io.ReadAll(r.Body)
			bl, err := DecodeFrame(bytes.NewReader(b))
			if err != nil {
				w.WriteHeader(400)
				return
			}
			f.blocks += len(bl)
		case strings.HasSuffix(p, "/commit"):
			f.commitCalls++
			if f.failCommit {
				w.WriteHeader(503)
				return
			}
			var in CommitRequest
			_ = json.NewDecoder(r.Body).Decode(&in)
			snap, again := f.commits[in.CommitID]
			if !again {
				snap = "snap-" + in.CommitID[:8]
				f.commits[in.CommitID] = snap
			}
			if f.lose > 0 {
				f.lose--
				hj, _ := w.(http.Hijacker)
				c, _, _ := hj.Hijack()
				_ = c.Close()
				return
			}
			_ = json.NewEncoder(w).Encode(CommitResponse{SnapshotID: snap, AlreadyCommitted: again})
		case strings.HasSuffix(p, "/finish"):
			var in struct{ Status string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			f.finished = append(f.finished, in.Status)
		case p == "/listing":
			_ = json.NewEncoder(w).Encode(map[string]any{"volumes": []Listing{{Volname: "vm/101/2026-10-03T22:00:00Z", VMID: 101, Kind: "vm"}}})
		default:
			t.Logf("unexpected %s %s", r.Method, p)
			w.WriteHeader(404)
		}
	})
}

func testProvider(t *testing.T, f *fakeRestow, src *memSource) *Provider {
	t.Helper()
	ts := httptest.NewServer(f.handler(t))
	t.Cleanup(ts.Close)
	root := t.TempDir()
	t.Setenv("RESTOW_PVE_ROOT", root)
	l := DefaultLayout()
	if err := SaveState(l.StateFile, &State{URL: ts.URL, NodeID: "n", NodeSecret: "s", StorageID: "restow", NodeName: "pve1",
		PVETokenID: "restow@pve!restow", PVETokenSecret: "x", AllowInsecureHTTP: true}); err != nil {
		t.Fatal(err)
	}
	p := &Provider{Layout: l, Log: io.Discard, now: func() time.Time { return time.Unix(1_790_000_000, 0) },
		Dial: func(context.Context, string, string, []string) (BlockSource, func() error, error) {
			return src, func() error { return nil }, nil
		}}
	if err := p.load(); err != nil {
		t.Fatal(err)
	}
	p.server.sleep = func(context.Context, time.Duration) error { return nil }
	return p
}

func runVMBackup(t *testing.T, p *Provider, size uint64, mode string) (map[string]string, error) {
	ctx := context.Background()
	if _, err := p.Handle(ctx, "backup-init", ProviderRequest{StoreID: "restow", VMID: 101, VMType: "qemu"}); err != nil {
		t.Fatal(err)
	}
	r, err := p.Handle(ctx, "backup-vm-query-incremental", ProviderRequest{StoreID: "restow", VMID: 101,
		Volumes: map[string]ProviderVolume{"drive-scsi0": {Size: size}}})
	if err != nil {
		t.Fatal(err)
	}
	modes := r.(map[string]any)["devices"].(map[string]string)
	bitmap := "new"
	if modes["drive-scsi0"] == "use" && mode != "" {
		bitmap = mode
	}
	_, err = p.Handle(ctx, "backup-vm", ProviderRequest{StoreID: "restow", VMID: 101, GuestConfig: "scsi0: x",
		Volumes: map[string]ProviderVolume{"drive-scsi0": {Size: size, BitmapMode: bitmap, NBDPath: "/x", BitmapName: "snapshot-access:restow"}}})
	return modes, err
}

func TestProviderCommitIsIdempotentAndJournalDecidesIncremental(t *testing.T) {
	size := uint64(8 * mib)
	src := &memSource{data: disk(int(size))}
	f := &fakeRestow{commits: map[string]string{}, mode: "use", lose: 1}
	p := testProvider(t, f, src)
	// First backup: the server says "use" but this node has no journal: new.
	modes, err := runVMBackup(t, p, size, "reuse")
	if err != nil {
		t.Fatal(err)
	}
	if modes["drive-scsi0"] != "new" {
		t.Fatalf("without a journal the disk must be read in full, got %v", modes)
	}
	if f.commitCalls != 2 || len(f.commits) != 1 {
		t.Fatalf("a lost commit answer must be retried with the same commit id: %d calls, %d commits", f.commitCalls, len(f.commits))
	}
	var jr journal
	if err := readJSON(p.Layout.journalFile(101), &jr); err != nil {
		t.Fatal(err)
	}
	entry := jr["drive-scsi0"]
	// Second backup: the server's base is the journal's snapshot: incremental.
	f.baseSnap, f.baseDigest = entry.SnapshotID, entry.Digest
	h, _ := os.ReadFile(p.Layout.hashFile(101, "drive-scsi0"))
	f.baseHashes = h
	f.blocks = 0
	src.dirty = [][2]uint64{{0, 4 * mib}}
	src.data[1] ^= 1
	modes, err = runVMBackup(t, p, size, "reuse")
	if err != nil {
		t.Fatal(err)
	}
	if modes["drive-scsi0"] != "use" || f.blocks != 1 {
		t.Fatalf("incremental: modes %v, %d blocks uploaded", modes, f.blocks)
	}
	// The server's newest restore point is not the journal's (a commit whose
	// answer this node never saw): read in full.
	f.baseSnap = "snap-other"
	modes, _ = runVMBackup(t, p, size, "reuse")
	if modes["drive-scsi0"] != "new" {
		t.Fatalf("journal mismatch must force a full read, got %v", modes)
	}
}

func TestProviderDiesWhenCommitOutcomeUnknown(t *testing.T) {
	size := uint64(4 * mib)
	f := &fakeRestow{commits: map[string]string{}, mode: "new", failCommit: true}
	p := testProvider(t, f, &memSource{data: disk(int(size))})
	_, err := runVMBackup(t, p, size, "")
	if err == nil || !strings.Contains(err.Error(), "commit") {
		t.Fatalf("an unknown commit outcome must fail backup_vm: %v", err)
	}
	if _, err := os.Stat(p.Layout.journalFile(101)); err == nil {
		t.Fatal("no journal entry without a known commit")
	}
	// backup_cleanup after the failure reports a failed run.
	if _, err := p.Handle(context.Background(), "backup-cleanup", ProviderRequest{StoreID: "restow", VMID: 101}); err != nil {
		t.Fatal(err)
	}
	if len(f.finished) != 1 || f.finished[0] != "failed" {
		t.Fatalf("finish: %v", f.finished)
	}
}

func TestListVolumesFromCacheOnly(t *testing.T) {
	f := &fakeRestow{commits: map[string]string{}}
	p := testProvider(t, f, &memSource{})
	if _, err := p.Handle(context.Background(), "job-init", ProviderRequest{StoreID: "restow"}); err != nil {
		t.Fatal(err)
	}
	out, err := p.Handle(context.Background(), "list-volumes", ProviderRequest{StoreID: "restow", VMID: 101})
	if err != nil {
		t.Fatal(err)
	}
	vols := out.(map[string]any)["volumes"].([]map[string]any)
	if len(vols) != 1 || vols[0]["volname"] != "backup/vm/101/2026-10-03T22:00:00Z" || vols[0]["subtype"] != "qemu" {
		t.Fatalf("%v", vols)
	}
	st, _ := p.Handle(context.Background(), "storage-status", ProviderRequest{})
	if !st.(StatusCache).Active {
		t.Fatal("status must be active")
	}
}

type fakeFetcher struct {
	data  []byte
	calls int
	mu    sync.Mutex
}

func (f *fakeFetcher) RestoreBlocks(_ context.Context, _, _ string, from, count uint32) ([]RestoreBlock, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	var out []RestoreBlock
	for i := from; i < from+count && uint64(i)*BlockSize < uint64(len(f.data)); i++ {
		n := BlockLen(uint64(len(f.data)), i)
		d := make([]byte, n)
		copy(d, f.data[uint64(i)*BlockSize:])
		out = append(out, RestoreBlock{Index: i, Length: n, Data: d})
	}
	return out, nil
}

func TestRestoreImageReadsSyntheticFull(t *testing.T) {
	size := 20*mib + 7
	data := disk(size)
	clear(data[4*mib : 8*mib])
	flags := make([]byte, BlockCount(uint64(size)))
	for i := range flags {
		flags[i] = FlagPresent
	}
	flags[1] = FlagZero
	f := &fakeFetcher{data: data}
	img := NewRestoreImage(context.Background(), f, "s", "drive-scsi0", uint64(size), flags)
	got := make([]byte, size)
	for off := 0; off < size; off += 3 * mib {
		end := min(off+3*mib, size)
		if _, err := img.ReadAt(got[off:end], int64(off)); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(got, data) {
		t.Fatal("restored image differs")
	}
	ext, _ := img.Allocation(0, uint64(size))
	if len(ext) != 3 || ext[1].Flags&nbd.StateZero == 0 || ext[1].Offset != 4*mib {
		t.Fatalf("allocation %v", ext)
	}
}

func TestParsers(t *testing.T) {
	if ParseDiskSize("local-lvm:vm-101-disk-0,iothread=1,size=32G") != 32<<30 || ParseDiskSize("x,size=4M") != 4<<20 {
		t.Fatal("disk size")
	}
	disks := GuestDisks("vm", map[string]any{"scsi0": "local-lvm:vm-1-disk-0,size=8G", "ide2": "none,media=cdrom",
		"tpmstate0": "local-lvm:vm-1-disk-2,size=4M,version=v2.0", "net0": "virtio=..", "efidisk0": "local:1,size=1M"})
	if len(disks) != 3 || disks[0].Device != "drive-efidisk0" || disks[2].Device != "drive-tpmstate0-backup" {
		t.Fatalf("%+v", disks)
	}
	ct := GuestDisks("ct", map[string]any{"rootfs": "local-zfs:subvol-1,size=8G", "mp0": "local:2,mp=/data,size=1G"})
	if len(ct) != 2 || ct[0].Backup || !ct[1].Backup {
		t.Fatalf("%+v", ct)
	}
	if !VersionAtLeast("9.2.1", 8, 4) || VersionAtLeast("8.3.5", 8, 4) || !VersionAtLeast("8.4.0", 8, 4) {
		t.Fatal("versions")
	}
	if k, id, ok := ParseVolname("backup/ct/200/2026-10-03T22:00:00Z"); !ok || k != "ct" || id != 200 {
		t.Fatal("volname")
	}
	if _, _, ok := ParseVolname("backup/vzdump-qemu-1.vma"); ok {
		t.Fatal("foreign volname")
	}
	if ExcludeToRestic("/snap", "/var/cache/*") != "/snap/var/cache/*" || ExcludeToRestic("/snap", "*.tmp") != "*.tmp" {
		t.Fatal("excludes")
	}
	if MissingPrivileges(map[string]map[string]int{"/": {"VM.Audit": 1}})[0] != "VM.Backup" {
		t.Fatal("privileges")
	}
	_ = filepath.Join
}
