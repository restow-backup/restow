package payload

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
)

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func liveISO(t *testing.T, o isoOpts, edit func(files map[string][]byte)) []byte {
	t.Helper()
	kernel := bytes.Repeat([]byte("K"), 5000)
	initrd := bytes.Repeat([]byte("I"), 3001)
	squash := bytes.Repeat([]byte("S"), 9000)
	files := map[string][]byte{
		KernelPath: kernel, InitrdPath: initrd, SquashfsPath: squash,
		"/live/filesystem.packages": []byte("x"),
		"/isolinux/isolinux.cfg":    []byte("timeout 100"),
	}
	files[SumsPath] = []byte(fmt.Sprintf("%s  ./live/vmlinuz\n%s  ./live/initrd.img\n%s  ./live/filesystem.squashfs\n",
		sum(kernel), sum(initrd), sum(squash)))
	if edit != nil {
		edit(files)
	}
	return buildTestISO(files, o)
}

func TestISOLookupRockRidge(t *testing.T) {
	img := liveISO(t, isoOpts{}, nil)
	iso, err := OpenISO(bytes.NewReader(img), int64(len(img)))
	if err != nil {
		t.Fatal(err)
	}
	b, err := iso.ReadFile("/isolinux/isolinux.cfg", 100)
	if err != nil || string(b) != "timeout 100" {
		t.Fatalf("isolinux.cfg = %q, %v", b, err)
	}
	e, err := iso.Lookup("/live/filesystem.squashfs")
	if err != nil || e.Size != 9000 || e.Dir {
		t.Fatalf("lookup = %+v, %v", e, err)
	}
	if _, err := iso.Lookup("/live/missing"); err == nil {
		t.Fatal("a missing file was found")
	}
	for _, p := range []string{"live/vmlinuz", "/live/../live/vmlinuz", "/live//vmlinuz", "/a/b/c/d/e/f/g/h/i"} {
		if _, err := iso.Lookup(p); err == nil {
			t.Errorf("%q was accepted", p)
		}
	}
	if _, err := iso.Open("/live"); err == nil {
		t.Error("a directory was opened as a file")
	}
	if _, err := iso.ReadFile(SquashfsPath, 10); err == nil {
		t.Error("ReadFile ignored its limit")
	}
}

func TestISOWithoutRockRidgeUsesISONames(t *testing.T) {
	img := buildTestISO(map[string][]byte{"/LIVE/VMLINUZ": []byte("k")}, isoOpts{noRockRidge: true})
	iso, err := OpenISO(bytes.NewReader(img), int64(len(img)))
	if err != nil {
		t.Fatal(err)
	}
	if b, err := iso.ReadFile("/LIVE/VMLINUZ", 10); err != nil || string(b) != "k" {
		t.Fatalf("= %q, %v", b, err)
	}
}

func TestISORefusesBrokenImages(t *testing.T) {
	good := liveISO(t, isoOpts{}, nil)
	cases := map[string][]byte{
		"empty":             nil,
		"short":             good[:16*sectorSize+10],
		"no magic":          buildTestISO(map[string][]byte{"/a": []byte("a")}, isoOpts{mutate: func(img []byte) { copy(img[16*sectorSize+1:], "XXXXX") }}),
		"block size":        buildTestISO(map[string][]byte{"/a": []byte("a")}, isoOpts{mutate: func(img []byte) { img[16*sectorSize+129] = 4 }}),
		"only a terminator": buildTestISO(map[string][]byte{"/a": []byte("a")}, isoOpts{mutate: func(img []byte) { img[16*sectorSize] = 255 }}),
	}
	for name, img := range cases {
		if _, err := OpenISO(bytes.NewReader(img), int64(len(img))); err == nil {
			t.Errorf("%s: opened", name)
		}
	}
	// A file whose extent lies beyond the end of the image.
	img := liveISO(t, isoOpts{}, nil)
	truncated := img[:len(img)-sectorSize]
	iso, err := OpenISO(bytes.NewReader(truncated), int64(len(truncated)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iso.LiveFiles(); err == nil || !strings.Contains(err.Error(), "outside the image") {
		t.Fatalf("LiveFiles on a truncated image: %v", err)
	}
}

func TestLiveFilesChecksTheImagesList(t *testing.T) {
	img := liveISO(t, isoOpts{}, nil)
	iso, err := OpenISO(bytes.NewReader(img), int64(len(img)))
	if err != nil {
		t.Fatal(err)
	}
	lf, err := iso.LiveFiles()
	if err != nil {
		t.Fatal(err)
	}
	if lf.Squashfs.Size() != 9000 || lf.Kernel.Size() != 5000 || lf.Initrd.Size() != 3001 {
		t.Fatalf("sizes %d %d %d", lf.Kernel.Size(), lf.Initrd.Size(), lf.Squashfs.Size())
	}
	refused := map[string]func(files map[string][]byte){
		"changed squashfs": func(f map[string][]byte) { f[SquashfsPath] = bytes.Repeat([]byte("T"), 9000) },
		"no list":          func(f map[string][]byte) { delete(f, SumsPath) },
		"kernel not listed": func(f map[string][]byte) {
			f[SumsPath] = []byte(strings.SplitN(string(f[SumsPath]), "\n", 2)[1])
		},
		"listed twice": func(f map[string][]byte) { f[SumsPath] = append(f[SumsPath], f[SumsPath]...) },
		"no kernel":    func(f map[string][]byte) { delete(f, KernelPath) },
	}
	for name, edit := range refused {
		img := liveISO(t, isoOpts{}, edit)
		iso, err := OpenISO(bytes.NewReader(img), int64(len(img)))
		if err != nil {
			t.Fatal(name, err)
		}
		if _, err := iso.LiveFiles(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// entry is one file of an initramfs as the kernel unpacks it.
type entry struct {
	name string
	mode uint32
	data []byte
}

// unpackInitramfs parses a buffer the way init/initramfs.c does: archives one
// after the other, zero bytes between them skipped only at multiples of four,
// gzip members decompressed, every newc header at a multiple of four.
func unpackInitramfs(t *testing.T, buf []byte) []entry {
	t.Helper()
	var out []entry
	off := 0
	for off < len(buf) {
		if buf[off] == 0 {
			if off%4 != 0 {
				t.Fatalf("zero padding at %d, not at a multiple of four", off)
			}
			for off < len(buf) && buf[off] == 0 {
				off++
			}
			continue
		}
		if bytes.HasPrefix(buf[off:], []byte{0x1f, 0x8b}) {
			br := bytes.NewReader(buf[off:])
			zr, err := gzip.NewReader(br)
			if err != nil {
				t.Fatal(err)
			}
			zr.Multistream(false)
			raw, err := io.ReadAll(zr)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, parseNewc(t, raw)...)
			off += len(buf[off:]) - br.Len()
			continue
		}
		if off%4 != 0 {
			t.Fatalf("archive at %d, not at a multiple of four", off)
		}
		ents, n := parseNewcAt(t, buf[off:])
		out = append(out, ents...)
		off += n
	}
	return out
}

func parseNewc(t *testing.T, b []byte) []entry {
	ents, _ := parseNewcAt(t, b)
	return ents
}

func parseNewcAt(t *testing.T, b []byte) ([]entry, int) {
	t.Helper()
	var out []entry
	off := 0
	for {
		if off%4 != 0 || off+110 > len(b) || string(b[off:off+6]) != "070701" {
			t.Fatalf("no newc header at %d", off)
		}
		field := func(i int) uint32 {
			v, err := strconv.ParseUint(string(b[off+6+8*i:off+14+8*i]), 16, 32)
			if err != nil {
				t.Fatal(err)
			}
			return uint32(v)
		}
		mode, size, namesize := field(1), field(6), field(11)
		name := string(b[off+110 : off+110+int(namesize)-1])
		p := (off + 110 + int(namesize) + 3) &^ 3
		data := b[p : p+int(size)]
		off = (p + int(size) + 3) &^ 3
		if name == "TRAILER!!!" {
			return out, off
		}
		out = append(out, entry{name: name, mode: mode, data: data})
	}
}

func testInitrd(t *testing.T) []byte {
	t.Helper()
	// Like Debian's: an uncompressed archive of modules, then a gzip member of
	// odd length.
	var b bytes.Buffer
	a := NewCPIO(&b)
	if err := a.File("usr/lib/modules/x.ko", 0o644, 3, strings.NewReader("abc")); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	var inner bytes.Buffer
	ia := NewCPIO(&inner)
	if err := ia.File("init", 0o755, 5, strings.NewReader("#!/sh")); err != nil {
		t.Fatal(err)
	}
	if err := ia.Close(); err != nil {
		t.Fatal(err)
	}
	zw := gzip.NewWriter(&b)
	zw.Write(inner.Bytes())
	zw.Close()
	return b.Bytes()
}

func TestAssembleIsWhatTheKernelUnpacks(t *testing.T) {
	initrd := testInitrd(t)
	squash := bytes.Repeat([]byte{0x68, 0x73, 0x71, 0x73}, 1001) // 4004 bytes
	data := []byte(`{"format":"restow-oneshot-v1"}`)
	var out bytes.Buffer
	n, err := Assemble(&out, bytes.NewReader(initrd), bytes.NewReader(squash), int64(len(squash)), data)
	if err != nil {
		t.Fatal(err)
	}
	if n != int64(out.Len()) || out.Len()%4 != 0 {
		t.Fatalf("wrote %d, buffer %d", n, out.Len())
	}
	if !bytes.Equal(out.Bytes()[:len(initrd)], initrd) {
		t.Fatal("the ISO's initrd was changed")
	}
	got := map[string]entry{}
	for _, e := range unpackInitramfs(t, out.Bytes()) {
		got[e.name] = e
	}
	for _, want := range []struct {
		name string
		mode uint32
		data []byte
	}{
		{"usr/lib/modules/x.ko", 0o100644, []byte("abc")},
		{"init", 0o100755, []byte("#!/sh")},
		{"restow", 0o40755, nil},
		{"restow/medium/live", 0o40755, nil},
		{SquashfsName, 0o100644, squash},
		{DataPath, 0o100600, data},
	} {
		e, ok := got[want.name]
		if !ok {
			t.Fatalf("%s is not in the initramfs (have %v)", want.name, got)
		}
		if e.mode != want.mode || !bytes.Equal(e.data, want.data) {
			t.Errorf("%s: mode %o, %d bytes", want.name, e.mode, len(e.data))
		}
	}
}

func TestAssembleRefuses(t *testing.T) {
	var out bytes.Buffer
	if _, err := Assemble(&out, strings.NewReader("i"), strings.NewReader("s"), 1, nil); err == nil {
		t.Error("empty data accepted")
	}
	if _, err := Assemble(&out, strings.NewReader("i"), strings.NewReader("s"), 1, make([]byte, MaxDataBytes+1)); err == nil {
		t.Error("too much data accepted")
	}
	if _, err := Assemble(&out, strings.NewReader("i"), strings.NewReader("s"), 0, []byte("{}")); err == nil {
		t.Error("an empty live file system accepted")
	}
	// The live file system is shorter than announced.
	if _, err := Assemble(&out, strings.NewReader("i"), strings.NewReader("ss"), 5, []byte("{}")); err == nil {
		t.Error("a short live file system accepted")
	}
}

func TestCPIONames(t *testing.T) {
	a := NewCPIO(io.Discard)
	for _, n := range []string{"", "/abs", "a/../b", "..", "../x", "a//b", "a/", "a\nb"} {
		if err := a.Dir(n, 0o755); err == nil {
			t.Errorf("%q accepted", n)
		}
	}
}

func TestCmdline(t *testing.T) {
	c, err := Cmdline(Consoles("BOOT_IMAGE=/vmlinuz root=UUID=x ro console=tty1 console=ttyS0,115200n8 console=netcon0 quiet"), "us")
	if err != nil {
		t.Fatal(err)
	}
	want := "boot=live components live-media=/restow/medium live-media-timeout=30 noswap nopersistence " +
		"modprobe.blacklist=amdgpu,radeon,nouveau,xe restow.oneshot=1 restow.keymap=us console=tty1 console=ttyS0,115200n8 restow.console=ttyS0"
	if c != want {
		t.Fatalf("cmdline\n %s\nwant\n %s", c, want)
	}
	c, err = Cmdline(nil, "de")
	if err != nil || !strings.HasSuffix(c, "restow.keymap=de console=tty0") {
		t.Fatalf("no console: %q %v", c, err)
	}
	for _, bad := range [][]string{{"ttyS0;reboot"}, {"tty0 init=/bin/sh"}, {"hvc0"}} {
		if _, err := Cmdline(bad, "us"); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if _, err := Cmdline(nil, "xx"); err == nil {
		t.Error("keymap xx accepted")
	}
	many := make([]string, 300)
	for i := range many {
		many[i] = "ttyS0,115200n8"
	}
	if _, err := Cmdline(many, "us"); err == nil {
		t.Error("a command line over 2048 bytes accepted")
	}
}

// TestRealRecoveryISO reads the live files of a built recovery ISO when
// RESTOW_TEST_RECOVERY_ISO names one (the CI job recovery-iso).
func TestRealRecoveryISO(t *testing.T) {
	p := os.Getenv("RESTOW_TEST_RECOVERY_ISO")
	if p == "" {
		t.Skip("RESTOW_TEST_RECOVERY_ISO is not set")
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, _ := f.Stat()
	iso, err := OpenISO(f, st.Size())
	if err != nil {
		t.Fatal(err)
	}
	lf, err := iso.LiveFiles()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("kernel %d, initrd %d, squashfs %d bytes", lf.Kernel.Size(), lf.Initrd.Size(), lf.Squashfs.Size())
}
