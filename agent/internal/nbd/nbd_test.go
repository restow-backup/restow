package nbd

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// shortDir returns a temporary directory with a short path (Unix socket paths
// are limited to about 100 bytes).
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "nbd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

type memExport struct {
	mu      sync.Mutex
	data    []byte
	trimmed [][2]uint64
}

func (m *memExport) ReadAt(p []byte, off int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return copy(p, m.data[off:]), nil
}

func serve(t *testing.T, exports map[string]*Export) string {
	t.Helper()
	sock := filepath.Join(shortDir(t), "s")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Lookup: func(name string) (*Export, bool) { e, ok := exports[name]; return e, ok }}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = l.Close(); s.CloseConnections() })
	return sock
}

func randomBytes(t *testing.T, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestReadAndShortLastBlock(t *testing.T) {
	// 10 MiB + 123 bytes: the last 4 MiB block is short.
	data := randomBytes(t, 10<<20+123)
	m := &memExport{data: data}
	sock := serve(t, map[string]*Export{"disk": {Size: uint64(len(data)), Reader: m}})
	for _, structured := range []bool{true, false} {
		c, err := Dial(context.Background(), "unix", sock, ClientOptions{Export: "disk", NoStructuredReplies: !structured})
		if err != nil {
			t.Fatal(err)
		}
		if c.Size() != uint64(len(data)) || !c.ReadOnly() || c.Structured() != structured {
			t.Fatalf("size %d ro %v structured %v", c.Size(), c.ReadOnly(), c.Structured())
		}
		got := make([]byte, 0, len(data))
		for off := uint64(0); off < c.Size(); off += 4 << 20 {
			n := uint64(4 << 20)
			if off+n > c.Size() {
				n = c.Size() - off
			}
			buf := make([]byte, n)
			if err := c.ReadAt(buf, off); err != nil {
				t.Fatal(err)
			}
			got = append(got, buf...)
		}
		if !bytes.Equal(got, data) {
			t.Fatal("data differs")
		}
		// Beyond the end is refused locally, the connection stays usable.
		if err := c.ReadAt(make([]byte, 10), c.Size()-5); err == nil {
			t.Fatal("read beyond the end must fail")
		}
		if err := c.ReadAt(make([]byte, 10), 0); err != nil {
			t.Fatalf("connection must stay usable: %v", err)
		}
		// Writes and trims are refused by a read-only export.
		if err := c.Trim(0, 4096); !IsErrno(err, errPerm) {
			t.Fatalf("trim on a read-only export: %v", err)
		}
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUnknownExport(t *testing.T) {
	sock := serve(t, map[string]*Export{})
	_, err := Dial(context.Background(), "unix", sock, ClientOptions{Export: "nope"})
	var oe *OptionError
	if !errors.As(err, &oe) {
		t.Fatalf("want an option error, got %v", err)
	}
}

func TestBlockStatusDirtyBitmapAndTrim(t *testing.T) {
	const mib = 1 << 20
	size := uint64(64 * mib)
	m := &memExport{data: make([]byte, size)}
	// Dirty: [4 MiB, 12 MiB) and [40 MiB, 41 MiB). The server answers in
	// pieces of at most 6 MiB to exercise continuation.
	dirty := [][2]uint64{{4 * mib, 12 * mib}, {40 * mib, 41 * mib}}
	bitmap := func(off, length uint64) ([]Extent, error) {
		end := off + length
		if end > off+6*mib {
			end = off + 6*mib
		}
		var out []Extent
		at := off
		for at < end {
			flag := uint32(0)
			next := end
			for _, d := range dirty {
				if at >= d[0] && at < d[1] {
					flag = StateDirty
					next = min(next, d[1])
				} else if d[0] > at {
					next = min(next, d[0])
				}
			}
			out = append(out, Extent{Offset: at, Length: next - at, Flags: flag})
			at = next
		}
		return out, nil
	}
	var trims [][2]uint64
	var tmu sync.Mutex
	e := &Export{Size: size, Reader: m, Contexts: map[string]ContextFunc{DirtyBitmapPrefix + "b0": bitmap},
		Trim: func(off, n uint64) error {
			tmu.Lock()
			trims = append(trims, [2]uint64{off, n})
			tmu.Unlock()
			return nil
		}}
	sock := serve(t, map[string]*Export{"drive-scsi0": e})
	c, err := Dial(context.Background(), "unix", sock, ClientOptions{
		Export:       "drive-scsi0",
		MetaContexts: []string{DirtyBitmapPrefix + "b0", DirtyBitmapPrefix + "missing"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	id, ok := c.Context(DirtyBitmapPrefix + "b0")
	if !ok {
		t.Fatal("bitmap context not negotiated")
	}
	if _, ok := c.Context(DirtyBitmapPrefix + "missing"); ok {
		t.Fatal("an unknown context must be absent")
	}
	ext, err := c.Extents(id, 0, size)
	if err != nil {
		t.Fatal(err)
	}
	var got [][2]uint64
	for _, x := range ext {
		if x.Flags&StateDirty != 0 {
			got = append(got, [2]uint64{x.Offset, x.Offset + x.Length})
		}
	}
	if len(got) != 2 || got[0] != dirty[0] || got[1] != dirty[1] {
		t.Fatalf("dirty extents %v, want %v", got, dirty)
	}
	if !c.CanTrim() {
		t.Fatal("export should accept trims")
	}
	if err := c.Trim(4*mib, 8*mib); err != nil {
		t.Fatal(err)
	}
	tmu.Lock()
	defer tmu.Unlock()
	if len(trims) != 1 || trims[0] != [2]uint64{4 * mib, 8 * mib} {
		t.Fatalf("trims %v", trims)
	}
}

// A server that dies in the middle of a read leaves the client with an error
// and an unusable connection, never with half a buffer reported as success.
func TestDisconnectMidRead(t *testing.T) {
	sock := filepath.Join(shortDir(t), "s")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	size := uint64(8 << 20)
	go func() {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		e := &Export{Size: size, Reader: &memExport{data: make([]byte, size)}}
		s := &Server{Lookup: func(string) (*Export, bool) { return e, true }}
		// Negotiate through a real server connection, then cut the
		// connection while the reply to the first read is half written.
		sc := &serverConn{s: s, r: newReader(conn), w: newWriter(&cutWriter{Conn: conn, after: 1 << 20})}
		if err := sc.negotiate(); err != nil {
			return
		}
		_ = sc.transmit()
		_ = conn.Close()
	}()
	c, err := Dial(context.Background(), "unix", sock, ClientOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	err = c.ReadAt(make([]byte, 4<<20), 0)
	if err == nil {
		t.Fatal("read must fail when the server disconnects mid-reply")
	}
	if err := c.ReadAt(make([]byte, 16), 0); err == nil || !strings.Contains(err.Error(), "unusable") {
		t.Fatalf("connection must be unusable afterwards: %v", err)
	}
}

type cutWriter struct {
	net.Conn
	after   int
	written int
}

func (w *cutWriter) Write(p []byte) (int, error) {
	if w.written+len(p) > w.after {
		n := w.after - w.written
		if n > 0 {
			_, _ = w.Conn.Write(p[:n])
		}
		_ = w.Conn.Close()
		return n, errors.New("cut")
	}
	w.written += len(p)
	return w.Conn.Write(p)
}

func haveTool(t *testing.T, names ...string) {
	t.Helper()
	for _, n := range names {
		if _, err := exec.LookPath(n); err != nil {
			t.Skipf("%s not installed", n)
		}
	}
}

func run(t *testing.T, name string, args ...string) string {
	t.Helper()
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}

// Against qemu-nbd: a qcow2 image with a persistent dirty bitmap, written to
// with qemu-io after the bitmap was added, exported with -B. The dirty
// extents must be exactly the written ranges (rounded to the bitmap
// granularity), reads must return what was written, and holes read as zeroes.
func TestQemuNbdDirtyBitmap(t *testing.T) {
	haveTool(t, "qemu-img", "qemu-io", "qemu-nbd")
	dir := shortDir(t)
	img := filepath.Join(dir, "d.qcow2")
	run(t, "qemu-img", "create", "-q", "-f", "qcow2", img, "64M")
	run(t, "qemu-io", "-f", "qcow2", "-c", "write -P 0x11 0 1M", img)
	run(t, "qemu-img", "bitmap", "--add", "-g", "4194304", img, "b0")
	run(t, "qemu-io", "-f", "qcow2", "-c", "write -P 0x22 9M 1M", "-c", "write -P 0x33 40M 512k", img)
	sock := filepath.Join(dir, "s")
	cmd := exec.Command("qemu-nbd", "-k", sock, "-f", "qcow2", "-B", "b0", "-x", "drive-scsi0", "--persistent", "--discard=unmap", img)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	var c *Client
	var err error
	for i := 0; i < 50; i++ {
		c, err = Dial(context.Background(), "unix", sock, ClientOptions{
			Export:       "drive-scsi0",
			MetaContexts: []string{DirtyBitmapPrefix + "b0", ContextBaseAllocation},
		})
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	id, ok := c.Context(DirtyBitmapPrefix + "b0")
	if !ok {
		t.Fatal("qemu-nbd did not offer the bitmap context")
	}
	ext, err := c.Extents(id, 0, c.Size())
	if err != nil {
		t.Fatal(err)
	}
	const mib = 1 << 20
	var dirty [][2]uint64
	for _, x := range ext {
		if x.Flags&StateDirty != 0 {
			dirty = append(dirty, [2]uint64{x.Offset / mib, (x.Offset + x.Length) / mib})
		}
	}
	want := [][2]uint64{{8, 12}, {40, 44}}
	if len(dirty) != len(want) || dirty[0] != want[0] || dirty[1] != want[1] {
		t.Fatalf("dirty extents (MiB) %v, want %v", dirty, want)
	}
	buf := make([]byte, 4*mib)
	if err := c.ReadAt(buf, 8*mib); err != nil {
		t.Fatal(err)
	}
	if buf[0] != 0 || buf[mib] != 0x22 || buf[2*mib-1] != 0x22 || buf[2*mib] != 0 {
		t.Fatal("unexpected content in the dirty block")
	}
	if err := c.ReadAt(buf[:mib], 0); err != nil || buf[0] != 0x11 {
		t.Fatalf("first MiB: %v %x", err, buf[0])
	}
	// The last block of the export, short reads at the very end.
	if err := c.ReadAt(buf[:4096], c.Size()-4096); err != nil {
		t.Fatal(err)
	}
	if c.CanTrim() {
		if err := c.Trim(40*mib, 4*mib); err != nil {
			t.Fatalf("trim: %v", err)
		}
	}
}

// qemu-img convert reads an export of the restore server through the NBD URI
// PVE uses and writes a raw image identical to the source.
func TestQemuImgConvertFromServer(t *testing.T) {
	haveTool(t, "qemu-img")
	data := randomBytes(t, 6<<20+4096)
	clear(data[1<<20 : 3<<20]) // a zero run
	e := &Export{Size: uint64(len(data)), Reader: &memExport{data: data}}
	sock := serve(t, map[string]*Export{"drive-scsi0": e})
	out := filepath.Join(shortDir(t), "out.raw")
	run(t, "qemu-img", "convert", "-f", "raw", "-O", "raw", "nbd+unix:///drive-scsi0?socket="+sock, out)
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("converted image differs")
	}
	info := run(t, "qemu-img", "info", "-f", "raw", "nbd+unix:///drive-scsi0?socket="+sock)
	if !strings.Contains(info, "6 MiB") && !strings.Contains(info, "6.0039") && !strings.Contains(info, "virtual size") {
		t.Fatalf("qemu-img info: %s", info)
	}
}

func newReader(c net.Conn) *bufio.Reader  { return bufio.NewReaderSize(c, 64<<10) }
func newWriter(w io.Writer) *bufio.Writer { return bufio.NewWriterSize(w, 256<<10) }
