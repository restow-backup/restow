//go:build linux

package recovery

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// LinuxOps are the operations of recover on the ISO (Ops).
type LinuxOps struct {
	Exec    Exec
	Holders *Holders
	EFI     EFIVars
	// Rootfs is the opened target root (for swap files).
	Rootfs func() *DirRootfs
	// TmpDir is a private folder on tmpfs (/run/restow-recovery/tmp).
	TmpDir string
	// SysRoot and DevRoot are /sys and /dev.
	SysRoot string
	DevRoot string
}

func (o *LinuxOps) dev() string {
	if o.DevRoot == "" {
		return "/dev"
	}
	return o.DevRoot
}

func (o *LinuxOps) sys() string {
	if o.SysRoot == "" {
		return "/sys"
	}
	return o.SysRoot
}

// ReleaseHolders implements Ops.
func (o *LinuxOps) ReleaseHolders(ctx context.Context, dev string) error {
	h := o.Holders
	if h == nil {
		h = &Holders{Exec: o.Exec}
	}
	return h.Release(ctx, dev)
}

const blkGetSize64 = 0x80081272

func deviceSize(f *os.File) (int64, error) {
	var n uint64
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), blkGetSize64, uintptr(unsafe.Pointer(&n))); e != 0 {
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() {
			return 0, e
		}
		return st.Size(), nil
	}
	return int64(n), nil
}

// BlkZero zeroes the first head and the last tail bytes of a device (old
// md 1.0 superblocks at the end, LVM labels, the GPT copy).
func (o *LinuxOps) BlkZero(ctx context.Context, dev string, head, tail int64) error {
	f, err := os.OpenFile(dev, os.O_WRONLY|syscall.O_EXCL, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	size, err := deviceSize(f)
	if err != nil {
		return fmt.Errorf("%s: size: %w", dev, err)
	}
	zeros := make([]byte, 1<<20)
	write := func(off, n int64) error {
		for n > 0 {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c := min(n, int64(len(zeros)))
			if _, err := f.WriteAt(zeros[:c], off); err != nil {
				return err
			}
			off += c
			n -= c
		}
		return nil
	}
	head, tail = min(head, size), min(tail, size)
	if err := write(0, head); err != nil {
		return err
	}
	if err := write(size-tail, tail); err != nil {
		return err
	}
	return f.Sync()
}

// PMBRBoot sets the boot flag (byte 446) of the protective MBR, which
// sfdisk drops (10.10 point 3).
func (o *LinuxOps) PMBRBoot(ctx context.Context, dev string) error {
	f, err := os.OpenFile(dev, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	mbr := make([]byte, 512)
	if _, err := io.ReadFull(f, mbr); err != nil {
		return err
	}
	if mbr[510] != 0x55 || mbr[511] != 0xaa || mbr[446+4] != 0xee {
		return fmt.Errorf("%s has no protective MBR", dev)
	}
	if mbr[446] == 0x80 {
		return nil
	}
	if _, err := f.WriteAt([]byte{0x80}, 446); err != nil {
		return err
	}
	return f.Sync()
}

// WaitPartUUIDs waits until every /dev/disk/by-partuuid/<uuid> exists.
func (o *LinuxOps) WaitPartUUIDs(ctx context.Context, uuids []string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var missing []string
		for _, u := range uuids {
			if _, err := os.Lstat(filepath.Join(o.dev(), "disk/by-partuuid", strings.ToLower(u))); err != nil {
				missing = append(missing, u)
			}
		}
		if len(missing) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no device for PARTUUID %s after %s", strings.Join(missing, ", "), timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// Exists implements Ops.
func (o *LinuxOps) Exists(dev string) bool { _, err := os.Lstat(dev); return err == nil }

// MappingOn implements Ops: the dm device with that name (dm/name in
// sysfs) must have exactly one slave, the kernel device dev resolves to.
func (o *LinuxOps) MappingOn(name, dev string) (bool, string) {
	blocks, _ := filepath.Glob(filepath.Join(o.sys(), "class/block/dm-*"))
	for _, b := range blocks {
		n, err := os.ReadFile(filepath.Join(b, "dm/name"))
		if err != nil || strings.TrimSpace(string(n)) != name {
			continue
		}
		ents, _ := os.ReadDir(filepath.Join(b, "slaves"))
		var slaves []string
		for _, e := range ents {
			slaves = append(slaves, "/dev/"+e.Name())
		}
		backing := strings.Join(slaves, ", ")
		want := dev
		if r, err := filepath.EvalSymlinks(dev); err == nil {
			want = r
		}
		return len(slaves) == 1 && slaves[0] == want, backing
	}
	return false, ""
}

// DMMappings implements Ops: every /sys/class/block/dm-N with its dm/name,
// dm/uuid and slaves. A device whose attributes cannot be read is listed
// with what could be read (no UUID: it counts as one that could hold a
// key).
func (o *LinuxOps) DMMappings() []DMMapping {
	blocks, _ := filepath.Glob(filepath.Join(o.sys(), "class/block/dm-*"))
	var out []DMMapping
	for _, b := range blocks {
		m := DMMapping{Node: filepath.Base(b)}
		if n, err := os.ReadFile(filepath.Join(b, "dm/name")); err == nil {
			m.Name = strings.TrimSpace(string(n))
		}
		if u, err := os.ReadFile(filepath.Join(b, "dm/uuid")); err == nil {
			m.UUID = strings.TrimSpace(string(u))
		}
		ents, _ := os.ReadDir(filepath.Join(b, "slaves"))
		for _, e := range ents {
			m.Slaves = append(m.Slaves, e.Name())
		}
		out = append(out, m)
	}
	return out
}

// mountPoints lists the mount points of this mount namespace.
func mountPoints() []string {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if f := strings.Fields(line); len(f) > 4 {
			out = append(out, unescapeMount(f[4]))
		}
	}
	return out
}

// Mounted implements Ops.
func (o *LinuxOps) Mounted(p string) bool {
	p = filepath.Clean(p)
	for _, m := range mountPoints() {
		if m == p {
			return true
		}
	}
	return false
}

// MkdirHost implements Ops.
func (o *LinuxOps) MkdirHost(p string) error {
	if p == "" {
		return nil
	}
	return os.MkdirAll(p, 0o755)
}

// Statfs implements Ops.
func (o *LinuxOps) Statfs(p string) (int64, int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0, 0, err
	}
	return int64(st.Bavail) * st.Bsize, int64(st.Blocks) * st.Bsize, nil
}

// WriteBootEntry implements Ops.
func (o *LinuxOps) WriteBootEntry(ctx context.Context, e BootEntryRequest) (int, error) {
	return o.EFI.WriteBootEntry(e)
}

const btrfsSuperMagic = 0x9123683e

var reFilefragFirst = regexp.MustCompile(`(?m)^\s*0:\s+0\.\.\s*\d+:\s+(\d+)\.\.`)

// Swapfile creates a swap file of the target (10.11): created through the
// target root, then filled with fallocate (on btrfs: chattr +C on the
// empty file, then dd), mode 0600, mkswap with its UUID; the ISO's tools
// reach the file through /proc/<pid>/fd, never through a path of the
// target. The resume offset comes from btrfs inspect-internal
// map-swapfile -r or from the first extent filefrag -v reports.
func (o *LinuxOps) Swapfile(ctx context.Context, p string, size int64, uuid, label string) (int64, error) {
	r := o.Rootfs()
	if r == nil {
		return -1, errors.New("the root file system of the target is not mounted")
	}
	if err := r.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return -1, err
	}
	if err := r.WriteFileAtomic(p, nil, 0o600, 0, 0, ""); err != nil {
		return -1, err
	}
	fd, err := r.open(p, syscall.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	host := fmt.Sprintf("/proc/%d/fd/%d", os.Getpid(), fd)
	var sfs syscall.Statfs_t
	if err := syscall.Fstatfs(fd, &sfs); err != nil {
		return -1, err
	}
	run := func(argv ...string) ([]byte, error) {
		out, err := o.Exec.Run(ctx, RunSpec{Argv: argv, NoKill: true, Timeout: 30 * time.Minute})
		return out.Output, err
	}
	btrfs := uint32(sfs.Type) == btrfsSuperMagic
	if btrfs {
		if _, err := run("chattr", "+C", host); err != nil {
			return -1, err
		}
		mib := (size + (1 << 20) - 1) >> 20
		if _, err := run("dd", "if=/dev/zero", "of="+host, "bs=1M", "count="+strconv.FormatInt(mib, 10), "conv=notrunc,fsync", "status=none"); err != nil {
			return -1, err
		}
	} else if _, err := run("fallocate", "-l", strconv.FormatInt(size, 10), host); err != nil {
		return -1, err
	}
	if err := syscall.Fchmod(fd, 0o600); err != nil {
		return -1, err
	}
	args := []string{"mkswap"}
	if uuid != "" {
		args = append(args, "-U", uuid)
	}
	if label != "" {
		args = append(args, "-L", label)
	}
	if _, err := run(append(args, host)...); err != nil {
		return -1, err
	}
	if btrfs {
		out, err := run("btrfs", "inspect-internal", "map-swapfile", "-r", host)
		if err != nil {
			return -1, nil
		}
		n, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
		if err != nil {
			return -1, nil
		}
		return n, nil
	}
	out, err := run("filefrag", "-v", host)
	if err != nil {
		return -1, nil
	}
	if m := reFilefragFirst.FindSubmatch(out); m != nil {
		n, _ := strconv.ParseInt(string(m[1]), 10, 64)
		return n, nil
	}
	return -1, nil
}

// TmpFile implements Ops: a 0600 file on tmpfs, overwritten with zeros and
// removed by the cleanup.
func (o *LinuxOps) TmpFile(name string, data []byte) (string, func(), error) {
	dir := o.TmpDir
	if dir == "" {
		dir = "/run/restow-recovery/tmp"
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", nil, err
	}
	rnd := make([]byte, 8)
	_, _ = rand.Read(rnd)
	p := filepath.Join(dir, name+"-"+hex.EncodeToString(rnd))
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return "", nil, err
	}
	_, werr := f.Write(data)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	cleanup := func() {
		if f, err := os.OpenFile(p, os.O_WRONLY|syscall.O_NOFOLLOW, 0); err == nil {
			_, _ = f.Write(make([]byte, len(data)))
			f.Close()
		}
		_ = os.Remove(p)
	}
	if werr != nil {
		cleanup()
		return "", nil, werr
	}
	return p, cleanup, nil
}

// DeviceSet implements Ops.
func (o *LinuxOps) DeviceSet(disks, extra []string) ([]string, []string) {
	return DeviceSet(disks, extra, o.sys(), o.dev())
}

// UnmountAll unmounts everything at or below root, deepest first.
func (o *LinuxOps) UnmountAll(ctx context.Context, root string) error {
	root = filepath.Clean(root)
	var ms []string
	for _, m := range mountPoints() {
		if m == root || strings.HasPrefix(m, root+"/") {
			ms = append(ms, m)
		}
	}
	sort.Slice(ms, func(i, j int) bool { return len(ms[i]) > len(ms[j]) })
	var errs []string
	for _, m := range ms {
		if err := syscall.Unmount(m, 0); err != nil {
			if err2 := syscall.Unmount(m, syscall.MNT_DETACH); err2 != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", m, err))
			}
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// ThawFrozen implements Ops: FITHAW on every file system mounted at or
// below root. A file system frozen by a program of the target (FIFREEZE
// keeps the superblock frozen after the namespaces have ended) would make
// the next write of recover or of the next step wait for good in an
// unkillable state; a successful thaw names the mount point. EINVAL (not
// frozen) and EOPNOTSUPP (cannot be frozen) are the normal answers. Each
// mount point is a mount of recover and is opened without following any
// symlink; a thaw of a file system that is not frozen changes nothing.
func (o *LinuxOps) ThawFrozen(root string) ([]string, error) {
	root = filepath.Clean(root)
	var thawed, errs []string
	for _, m := range mountPoints() {
		if m != root && !strings.HasPrefix(m, root+"/") {
			continue
		}
		ok, err := thawMount(m)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", m, err))
		}
		if ok {
			thawed = append(thawed, m)
		}
	}
	if len(errs) > 0 {
		return thawed, errors.New("thaw the file systems of the target: " + strings.Join(errs, "; "))
	}
	return thawed, nil
}

// fiThawRequest is FITHAW _IOWR('X', 120, int).
const fiThawRequest = 0xc0045878

func thawMount(m string) (bool, error) {
	name, err := syscall.BytePtrFromString(m)
	if err != nil {
		return false, err
	}
	how := openHow{Flags: uint64(syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC),
		Resolve: resolveNoSymlinks | resolveNoMagiclinks}
	atFdcwd := -100
	var fd uintptr
	var e syscall.Errno
	for {
		fd, _, e = syscall.Syscall6(sysOpenat2, uintptr(atFdcwd), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
		if e != syscall.EINTR && e != syscall.EAGAIN {
			break
		}
	}
	runtime.KeepAlive(name)
	if e != 0 {
		return false, e
	}
	defer syscall.Close(int(fd))
	_, _, e = syscall.Syscall(syscall.SYS_IOCTL, fd, fiThawRequest, 0)
	switch e {
	case 0:
		return true, nil
	case syscall.EINVAL, syscall.EOPNOTSUPP, syscall.ENOTTY:
		return false, nil
	}
	return false, e
}

// Flush syncs and flushes the buffers of the target disks before the
// restart (10.17).
func (o *LinuxOps) Flush(ctx context.Context, disks []string) {
	syscall.Sync()
	for _, d := range disks {
		_, _ = o.Exec.Run(ctx, RunSpec{Argv: []string{"blockdev", "--flushbufs", d}, Timeout: 2 * time.Minute})
	}
}
