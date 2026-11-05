//go:build linux

package recovery

import (
	"context"
	"encoding/binary"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// TestRootfsStaysInside: links that point out of the target (absolute,
// .., /proc/self/root) resolve inside it or fail; nothing outside is read
// or written.
func TestRootfsStaysInside(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "etc"), 0o755))
	must(os.WriteFile(filepath.Join(root, "etc/passwd"), []byte("root:x:0:0::/root:/bin/sh\n"), 0o644))
	must(os.Symlink("/etc/passwd", filepath.Join(root, "abs")))
	must(os.Symlink("../../../../../../../"+strings.TrimPrefix(outside, "/")+"/secret", filepath.Join(root, "dotdot")))
	must(os.Symlink("/proc/self/root"+outside+"/secret", filepath.Join(root, "magic")))
	must(os.Symlink(outside, filepath.Join(root, "outdir")))
	r, err := OpenRootfs(root)
	if err != nil {
		t.Skipf("openat2: %v", err)
	}
	defer r.Close()
	if b, err := r.ReadFile("/abs", 4096); err != nil || !strings.HasPrefix(string(b), "root:x") {
		t.Errorf("absolute link inside: %q %v", b, err)
	}
	if b, err := r.ReadFile("/dotdot", 4096); err == nil && string(b) == "outside" {
		t.Error(".. escaped the root")
	}
	if b, err := r.ReadFile("/magic", 4096); err == nil && string(b) == "outside" {
		t.Error("/proc/self/root escaped the root")
	}
	if err := r.WriteFileAtomic("/outdir/new", []byte("x"), 0o644, 0, 0, ""); err == nil {
		if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
			t.Error("a write through a link left the root")
		}
	}
	if err := r.WriteFileAtomic("/abs", []byte("x"), 0o644, 0, 0, ""); !errors.Is(err, ErrSymlinkTarget) {
		t.Errorf("a link was replaced: %v", err)
	}
	// Writes, backups, folders, modes.
	must(r.WriteFileAtomic("/etc/fstab", []byte("old\n"), 0o644, os.Getuid(), os.Getgid(), ""))
	must(r.WriteFileAtomic("/etc/fstab", []byte("new\n"), 0o644, os.Getuid(), os.Getgid(), "fstab.restow-20261105T101500Z"))
	if b, _ := os.ReadFile(filepath.Join(root, "etc/fstab.restow-20261105T101500Z")); string(b) != "old\n" {
		t.Errorf("backup %q", b)
	}
	must(r.MkdirAll("/tmp", 0o755))
	must(r.Chmod("/tmp", fs.ModeSticky|0o777))
	if st, _ := r.Lstat("/tmp"); st.Mode()&fs.ModeSticky == 0 || st.Mode().Perm() != 0o777 || !st.IsDir() {
		t.Errorf("tmp mode %v", st.Mode())
	}
	if st, _ := r.Lstat("/abs"); st.Mode()&fs.ModeSymlink == 0 {
		t.Error("Lstat followed the link")
	}
	if err := r.MkdirAll("/outdir/sub", 0o755); err == nil {
		if _, err := os.Stat(filepath.Join(outside, "sub")); err == nil {
			t.Error("MkdirAll left the root")
		}
	}
	names, err := r.ReadDir("/etc")
	if err != nil || len(names) != 3 {
		t.Errorf("readdir %v %v", names, err)
	}
	must(r.Remove("/etc/fstab.restow-20261105T101500Z"))
	if _, err := r.Lstat("/etc/fstab.restow-20261105T101500Z"); err == nil {
		t.Error("remove")
	}
	if _, err := r.ReadFile("relative", 1); err == nil {
		t.Error("a relative path was accepted")
	}
}

// TestRootfsNeverOpensSpecialFiles: a FIFO (standing in for a block or
// char node restored from the snapshot, whose open has side effects) at a
// path recover reads or changes is never opened: a writer blocked in
// open(2) on it would be released by any open for reading.
func TestRootfsNeverOpensSpecialFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(root, "etc/fstab")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("fstab", filepath.Join(root, "etc/link")); err != nil {
		t.Fatal(err)
	}
	r, err := OpenRootfs(root)
	if err != nil {
		t.Skipf("openat2: %v", err)
	}
	defer r.Close()
	opened := make(chan struct{})
	go func() {
		if f, err := os.OpenFile(fifo, os.O_WRONLY, 0); err == nil {
			f.Close()
		}
		close(opened)
	}()
	time.Sleep(100 * time.Millisecond)
	if _, err := r.ReadFile("/etc/fstab", 1<<20); err == nil {
		t.Error("ReadFile read a FIFO")
	}
	if _, err := r.ReadFile("/etc/link", 1<<20); err == nil {
		t.Error("ReadFile read a FIFO through a link")
	}
	if err := r.Chmod("/etc/fstab", 0o640); err != nil {
		t.Errorf("chmod: %v", err)
	}
	if err := r.Chown("/etc/fstab", os.Getuid(), os.Getgid()); err != nil {
		t.Errorf("chown: %v", err)
	}
	_, _ = r.Getxattr("/etc/fstab", "security.selinux")
	if err := r.Chmod("/etc/link", 0o600); !errors.Is(err, ErrSymlinkTarget) {
		t.Errorf("chmod through a link: %v", err)
	}
	if err := r.Chown("/etc/link", os.Getuid(), os.Getgid()); !errors.Is(err, ErrSymlinkTarget) {
		t.Errorf("chown through a link: %v", err)
	}
	select {
	case <-opened:
		t.Error("recover opened the FIFO of the target")
	case <-time.After(300 * time.Millisecond):
	}
	if st, err := os.Lstat(fifo); err != nil || st.Mode().Perm() != 0o640 || st.Mode()&fs.ModeNamedPipe == 0 {
		t.Errorf("chmod through O_PATH: %v %v", st, err)
	}
	// Release the writer.
	if f, err := os.OpenFile(fifo, os.O_RDONLY|syscall.O_NONBLOCK, 0); err == nil {
		<-opened
		f.Close()
	}
	// Regular files and folders still work.
	if err := os.WriteFile(filepath.Join(root, "etc/hostname"), []byte("srv01\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if b, err := r.ReadFile("/etc/hostname", 64); err != nil || string(b) != "srv01\n" {
		t.Errorf("ReadFile: %q %v", b, err)
	}
	if _, err := r.ReadFile("/etc/hostname", 3); err == nil {
		t.Error("the size limit")
	}
	if err := r.Chmod("/etc", 0o711); err != nil {
		t.Error(err)
	}
	if st, _ := os.Stat(filepath.Join(root, "etc")); st.Mode().Perm() != 0o711 {
		t.Errorf("chmod of a folder: %v", st.Mode())
	}
}

// fakeSys builds a /sys/class/block and /sys/block tree.
type fakeSys struct {
	root string
}

func (f fakeSys) dev(name, devnum string, partition bool, holders ...string) {
	cls := filepath.Join(f.root, "class/block", name)
	_ = os.MkdirAll(filepath.Join(cls, "holders"), 0o755)
	_ = os.WriteFile(filepath.Join(cls, "dev"), []byte(devnum+"\n"), 0o644)
	if partition {
		_ = os.WriteFile(filepath.Join(cls, "partition"), []byte("1\n"), 0o644)
	}
	for _, h := range holders {
		_ = os.MkdirAll(filepath.Join(cls, "holders", h), 0o755)
	}
}

func (f fakeSys) disk(name string, parts ...string) {
	_ = os.MkdirAll(filepath.Join(f.root, "block", name), 0o755)
	for _, p := range parts {
		_ = os.MkdirAll(filepath.Join(f.root, "block", name, p), 0o755)
		_ = os.WriteFile(filepath.Join(f.root, "block", name, p, "partition"), []byte("1\n"), 0o644)
	}
}

func (f fakeSys) dm(name, dmName, uuid string, holders ...string) {
	f.dev(name, "253:0", false, holders...)
	_ = os.MkdirAll(filepath.Join(f.root, "class/block", name, "dm"), 0o755)
	_ = os.WriteFile(filepath.Join(f.root, "class/block", name, "dm/name"), []byte(dmName+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(f.root, "class/block", name, "dm/uuid"), []byte(uuid+"\n"), 0o644)
}

// TestHoldersRelease: mounts, swap, LVs, LUKS and md on a disk are
// stopped from the top; what is left is reported.
func TestHoldersRelease(t *testing.T) {
	dir := t.TempDir()
	fsys := fakeSys{root: filepath.Join(dir, "sys")}
	fsys.disk("sda", "sda1", "sda2", "sda3")
	fsys.dev("sda", "8:0", false)
	fsys.dev("sda1", "8:1", true)
	fsys.dev("sda2", "8:2", true, "md0")
	fsys.dev("sda3", "8:3", true, "dm-0")
	fsys.dev("md0", "9:0", false)
	fsys.dm("dm-0", "sda3_crypt", "CRYPT-LUKS2-abc", "dm-1")
	fsys.dm("dm-1", "vg-root", "LVM-xyz")
	mi := filepath.Join(dir, "mountinfo")
	_ = os.WriteFile(mi, []byte("30 1 8:1 / /mnt/old\\040disk rw - ext4 /dev/sda1 rw\n31 1 253:0 / /mnt/root rw - ext4 /dev/mapper/vg-root rw\n"), 0o644)
	swaps := filepath.Join(dir, "swaps")
	_ = os.WriteFile(swaps, []byte("Filename Type Size Used Priority\n/dev/md0 partition 1 0 -2\n"), 0o644)
	var mu sync.Mutex
	var unmounted, ran []string
	x := execFunc(func(argv []string) error {
		mu.Lock()
		defer mu.Unlock()
		ran = append(ran, strings.Join(argv, " "))
		switch argv[0] {
		case "dmsetup":
			_ = os.RemoveAll(filepath.Join(fsys.root, "class/block/dm-0/holders/dm-1"))
		case "cryptsetup":
			_ = os.RemoveAll(filepath.Join(fsys.root, "class/block/sda3/holders/dm-0"))
		case "mdadm":
			_ = os.RemoveAll(filepath.Join(fsys.root, "class/block/sda2/holders/md0"))
		case "swapoff":
			_ = os.WriteFile(swaps, []byte("Filename Type Size Used Priority\n"), 0o644)
		}
		return nil
	})
	h := &Holders{Exec: x, SysRoot: fsys.root, MountInfo: mi, Swaps: swaps, Unmount: func(target string, flags int) error {
		mu.Lock()
		unmounted = append(unmounted, target)
		mu.Unlock()
		_ = os.WriteFile(mi, []byte(""), 0o644)
		return nil
	}}
	if err := h.Release(context.Background(), "/dev/sda"); err != nil {
		t.Fatalf("release: %v\nran %v", err, ran)
	}
	got := strings.Join(ran, "; ")
	for _, want := range []string{"dmsetup remove --retry vg-root", "cryptsetup close sda3_crypt", "swapoff /dev/md0", "mdadm --stop /dev/md0"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if strings.Index(got, "dmsetup") > strings.Index(got, "cryptsetup") {
		t.Error("the LV was not released before the LUKS volume")
	}
	if len(unmounted) == 0 {
		t.Error("nothing unmounted")
	}
	// A holder that stays is reported.
	fsys.dev("sda1", "8:1", true, "dm-9")
	fsys.dev("dm-9", "253:9", false)
	err := h.Release(context.Background(), "/dev/sda")
	if ProblemCode(err) != ProblemHoldersBusy || !strings.Contains(err.Error(), "dm-9") {
		t.Errorf("busy: %v", err)
	}
}

type execFunc func(argv []string) error

func (f execFunc) Run(ctx context.Context, s RunSpec) (RunResult, error) {
	return RunResult{}, f(s.Argv)
}

func TestDeviceSet(t *testing.T) {
	dir := t.TempDir()
	fsys := fakeSys{root: filepath.Join(dir, "sys")}
	fsys.disk("nvme0n1", "nvme0n1p1", "nvme0n1p2")
	fsys.dev("nvme0n1", "259:0", false)
	fsys.dev("nvme0n1p1", "259:1", true)
	fsys.dev("nvme0n1p2", "259:2", true, "dm-0")
	fsys.dm("dm-0", "root_crypt", "CRYPT-x")
	fsys.disk("sdb", "sdb1")
	fsys.dev("sdb", "8:16", false)
	dev := filepath.Join(dir, "dev")
	for _, n := range []string{"nvme0n1", "nvme0n1p1", "nvme0n1p2", "dm-0", "sdb", "sdb1"} {
		_ = os.MkdirAll(dev, 0o755)
		_ = os.WriteFile(filepath.Join(dev, n), nil, 0o600)
	}
	_ = os.MkdirAll(filepath.Join(dev, "mapper"), 0o755)
	_ = os.Symlink("../dm-0", filepath.Join(dev, "mapper/root_crypt"))
	_ = os.MkdirAll(filepath.Join(dev, "disk/by-uuid"), 0o755)
	_ = os.Symlink("../../nvme0n1p1", filepath.Join(dev, "disk/by-uuid/AAAA-BBBB"))
	_ = os.Symlink("../../sdb1", filepath.Join(dev, "disk/by-uuid/other"))
	devices, links := DeviceSet([]string{"/dev/nvme0n1"}, nil, fsys.root, dev)
	got := strings.Join(devices, " ")
	if got != "/dev/dm-0 /dev/mapper/root_crypt /dev/nvme0n1 /dev/nvme0n1p1 /dev/nvme0n1p2" {
		t.Errorf("devices %s", got)
	}
	if strings.Join(links, " ") != "/dev/disk/by-uuid/AAAA-BBBB" {
		t.Errorf("links %v", links)
	}
}

// TestEFIVarsBootEntry writes a Boot#### into a fake efivarfs, reuses it
// on a second call and puts it first in BootOrder.
func TestEFIVarsBootEntry(t *testing.T) {
	dir := t.TempDir()
	ev := filepath.Join(dir, "efivars")
	_ = os.MkdirAll(ev, 0o755)
	sys := filepath.Join(dir, "sys")
	dev := filepath.Join(dir, "dev")
	part := filepath.Join(sys, "block/nvme0n1/nvme0n1p1")
	_ = os.MkdirAll(part, 0o755)
	_ = os.MkdirAll(filepath.Join(sys, "block/nvme0n1/queue"), 0o755)
	_ = os.WriteFile(filepath.Join(sys, "block/nvme0n1/queue/logical_block_size"), []byte("4096\n"), 0o644)
	for k, v := range map[string]string{"partition": "1", "start": "2048", "size": "1048576"} {
		_ = os.WriteFile(filepath.Join(part, k), []byte(v+"\n"), 0o644)
	}
	_ = os.MkdirAll(filepath.Join(sys, "class/block"), 0o755)
	_ = os.Symlink(part, filepath.Join(sys, "class/block/nvme0n1p1"))
	_ = os.MkdirAll(filepath.Join(dev, "disk/by-partuuid"), 0o755)
	_ = os.WriteFile(filepath.Join(dev, "nvme0n1p1"), nil, 0o600)
	_ = os.Symlink("../../nvme0n1p1", filepath.Join(dev, "disk/by-partuuid/5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6"))
	writeVar := func(name string, data []byte) {
		b := binary.LittleEndian.AppendUint32(nil, 7)
		_ = os.WriteFile(filepath.Join(ev, name+"-"+baremetal.EFIGlobalGUID), append(b, data...), 0o644)
	}
	writeVar("Boot0000", mustLoadOption(t))
	writeVar("BootOrder", baremetal.EncodeBootOrder([]int64{0}))
	e := EFIVars{Dir: ev, FirmwareDir: dir, SysRoot: sys, DevRoot: dev}
	n, err := e.WriteBootEntry(BootEntryRequest{Label: "debian", PartUUID: "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", Loader: `\EFI\debian\shimx64.efi`})
	if err != nil || n != 1 {
		t.Fatalf("entry %d %v", n, err)
	}
	n2, err := e.WriteBootEntry(BootEntryRequest{Label: "debian", PartUUID: "5E1C4D0A-1B2C-4D3E-8F90-A1B2C3D4E5F6", Loader: `\EFI\debian\shimx64.efi`})
	if err != nil || n2 != 1 {
		t.Errorf("not reused: %d %v", n2, err)
	}
	if order := e.BootOrder(); len(order) != 2 || order[0] != 1 || order[1] != 0 {
		t.Errorf("boot order %v", order)
	}
	o := e.BootEntries()[1]
	if o.PartUUID != "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6" || o.Path != `\EFI\debian\shimx64.efi` || !o.Active() {
		t.Errorf("entry %+v", o)
	}
	raw, _ := os.ReadFile(filepath.Join(ev, "Boot0001-"+baremetal.EFIGlobalGUID))
	if binary.LittleEndian.Uint32(raw) != 7 {
		t.Error("attributes are not NV|BS|RT")
	}
	fw := e.Firmware()
	if fw.Mode != "uefi" || fw.DBX != nil {
		t.Errorf("firmware %+v", fw)
	}
}

func mustLoadOption(t *testing.T) []byte {
	b, err := baremetal.BuildLoadOption(1, "Windows Boot Manager", baremetal.LoadOptionPartition{Number: 2, StartLBA: 1, SizeLBA: 1, PartUUID: "00112233-4455-6677-8899-aabbccddeeff"}, `\EFI\Microsoft\Boot\bootmgfw.efi`)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestMappingOn: a dm device is on the partition of the plan only when its
// single slave is that partition.
func TestMappingOn(t *testing.T) {
	sys := t.TempDir()
	mk := func(dm, name string, slaves ...string) {
		_ = os.MkdirAll(filepath.Join(sys, "class/block", dm, "dm"), 0o755)
		_ = os.MkdirAll(filepath.Join(sys, "class/block", dm, "slaves"), 0o755)
		_ = os.WriteFile(filepath.Join(sys, "class/block", dm, "dm/name"), []byte(name+"\n"), 0o644)
		for _, s := range slaves {
			_ = os.MkdirAll(filepath.Join(sys, "class/block", dm, "slaves", s), 0o755)
		}
	}
	mk("dm-0", "sda2_crypt", "sda2")
	mk("dm-1", "vg-root", "nvme0n1p2", "sdb1")
	o := &LinuxOps{SysRoot: sys}
	if on, b := o.MappingOn("sda2_crypt", "/dev/nvme0n1p2"); on || b != "/dev/sda2" {
		t.Errorf("foreign mapping: %v %q", on, b)
	}
	if on, _ := o.MappingOn("sda2_crypt", "/dev/sda2"); !on {
		t.Error("the mapping on the plan's partition was not recognised")
	}
	if on, _ := o.MappingOn("vg-root", "/dev/nvme0n1p2"); on {
		t.Error("a mapping on two devices counts as on one")
	}
	if on, b := o.MappingOn("missing", "/dev/sda2"); on || b != "" {
		t.Errorf("missing: %v %q", on, b)
	}
}
