//go:build linux

package recovery

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// openat2 (Linux 5.6) with RESOLVE_IN_ROOT: ".." and absolute symlinks
// stay inside the root, magic links (/proc/self/root) are refused.
const (
	sysOpenat2          = 437
	resolveNoMagiclinks = 0x02
	resolveInRoot       = 0x10
	oPath               = 0x200000
	atRemoveDir         = 0x200
	atEmptyPath         = 0x1000
)

type openHow struct {
	Flags   uint64
	Mode    uint64
	Resolve uint64
}

// DirRootfs is the target root on the ISO.
type DirRootfs struct {
	root *os.File
}

// OpenRootfs opens a target root. It fails when the kernel has no openat2
// (it never falls back to plain path resolution).
func OpenRootfs(dir string) (*DirRootfs, error) {
	f, err := os.OpenFile(dir, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	r := &DirRootfs{root: f}
	fd, err := r.open("/", syscall.O_DIRECTORY|oPath, 0)
	if err != nil {
		f.Close()
		if errors.Is(err, syscall.ENOSYS) {
			return nil, errors.New("the kernel has no openat2; files of the target are not touched")
		}
		return nil, err
	}
	syscall.Close(fd)
	return r, nil
}

// Close releases the root.
func (r *DirRootfs) Close() error { return r.root.Close() }

func clean(p string) (string, error) {
	if !strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("%q is not an absolute path of the target", p)
	}
	c := strings.TrimPrefix(path.Clean(p), "/")
	if c == "" {
		c = "."
	}
	return c, nil
}

func (r *DirRootfs) open(p string, flags int, mode uint32) (int, error) {
	rel, err := clean(p)
	if err != nil {
		return -1, err
	}
	name, err := syscall.BytePtrFromString(rel)
	if err != nil {
		return -1, err
	}
	how := openHow{Flags: uint64(flags | syscall.O_CLOEXEC), Mode: uint64(mode), Resolve: resolveInRoot | resolveNoMagiclinks}
	for {
		fd, _, e := syscall.Syscall6(sysOpenat2, r.root.Fd(), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
		if e == syscall.EINTR || e == syscall.EAGAIN {
			continue
		}
		if e != 0 {
			return -1, &os.PathError{Op: "openat2", Path: p, Err: e}
		}
		return int(fd), nil
	}
}

// pathFd opens p as O_PATH (nothing of the inode is opened: no device
// driver, FIFO or socket sees an open) and describes it.
func (r *DirRootfs) pathFd(p string, flags int) (int, *syscall.Stat_t, error) {
	fd, err := r.open(p, oPath|flags, 0)
	if err != nil {
		return -1, nil, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return -1, nil, err
	}
	return fd, &st, nil
}

// procFd is the path through which a file opened as O_PATH is reached
// again: the same inode, no new path resolution in the target.
func procFd(fd int) string { return "/proc/self/fd/" + strconv.Itoa(fd) }

// ReadFile reads a regular file of at most max bytes. The file is opened
// as O_PATH first and opened for reading only when it is a regular file:
// a block or char node restored from the snapshot at a path recover reads
// (a watchdog, a tape, a terminal) is never opened.
func (r *DirRootfs) ReadFile(p string, max int64) ([]byte, error) {
	pfd, pst, err := r.pathFd(p, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(pfd)
	if pst.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return nil, fmt.Errorf("%s is not a regular file", p)
	}
	f, err := os.OpenFile(procFd(pfd), os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", p)
	}
	if max > 0 && st.Size() > max {
		return nil, fmt.Errorf("%s is larger than %d bytes", p, max)
	}
	return io.ReadAll(io.LimitReader(f, max+1))
}

func (r *DirRootfs) parent(p string) (*os.File, string, error) {
	rel, err := clean(p)
	if err != nil {
		return nil, "", err
	}
	if rel == "." {
		return nil, "", errors.New("the root itself")
	}
	dir, base := path.Split("/" + rel)
	fd, err := r.open(dir, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		return nil, "", err
	}
	return os.NewFile(uintptr(fd), dir), base, nil
}

// WriteFileAtomic replaces p atomically (see Rootfs).
func (r *DirRootfs) WriteFileAtomic(p string, data []byte, mode fs.FileMode, uid, gid int, backup string) error {
	dir, base, err := r.parent(p)
	if err != nil {
		return err
	}
	defer dir.Close()
	dfd := int(dir.Fd())
	if st, err := r.Lstat(p); err == nil && st.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s: %w", p, ErrSymlinkTarget)
	}
	tmp := "." + base + ".restow-tmp-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	fd, err := syscall.Openat(dfd, tmp, syscall.O_CREAT|syscall.O_EXCL|syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, uint32(mode.Perm()))
	if err != nil {
		return &os.PathError{Op: "create", Path: p, Err: err}
	}
	f := os.NewFile(uintptr(fd), tmp)
	ok := false
	defer func() {
		if !ok {
			_ = syscall.Unlinkat(dfd, tmp)
		}
	}()
	_, werr := f.Write(data)
	if werr == nil {
		werr = syscall.Fchown(fd, uid, gid)
	}
	if werr == nil {
		werr = syscall.Fchmod(fd, uint32(mode.Perm())|modeBits(mode))
	}
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fmt.Errorf("write %s: %w", p, werr)
	}
	if backup != "" {
		if strings.ContainsRune(backup, '/') {
			return fmt.Errorf("invalid backup name %q", backup)
		}
		if err := linkat(dfd, base, dfd, backup); err != nil && !errors.Is(err, syscall.ENOENT) {
			return fmt.Errorf("keep %s: %w", p, err)
		}
	}
	if err := syscall.Renameat(dfd, tmp, dfd, base); err != nil {
		return fmt.Errorf("rename %s: %w", p, err)
	}
	ok = true
	return dir.Sync()
}

func modeBits(m fs.FileMode) uint32 {
	var b uint32
	if m&fs.ModeSticky != 0 {
		b |= syscall.S_ISVTX
	}
	if m&fs.ModeSetgid != 0 {
		b |= syscall.S_ISGID
	}
	if m&fs.ModeSetuid != 0 {
		b |= syscall.S_ISUID
	}
	return b
}

func linkat(olddir int, oldname string, newdir int, newname string) error {
	o, err := syscall.BytePtrFromString(oldname)
	if err != nil {
		return err
	}
	n, err := syscall.BytePtrFromString(newname)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall6(syscall.SYS_LINKAT, uintptr(olddir), uintptr(unsafe.Pointer(o)), uintptr(newdir), uintptr(unsafe.Pointer(n)), 0, 0)
	if e != 0 {
		return e
	}
	return nil
}

// MkdirAll creates p and its parents.
func (r *DirRootfs) MkdirAll(p string, mode fs.FileMode) error {
	rel, err := clean(p)
	if err != nil {
		return err
	}
	if rel == "." {
		return nil
	}
	cur := ""
	for _, part := range strings.Split(rel, "/") {
		parent := "/" + cur
		cur = path.Join(cur, part)
		if fd, err := r.open("/"+cur, syscall.O_RDONLY|syscall.O_DIRECTORY, 0); err == nil {
			syscall.Close(fd)
			continue
		}
		pfd, err := r.open(parent, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if err != nil {
			return err
		}
		err = syscall.Mkdirat(pfd, part, uint32(mode.Perm()))
		if err == nil {
			if fd, oerr := syscall.Openat(pfd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0); oerr == nil {
				_ = syscall.Fchmod(fd, uint32(mode.Perm())|modeBits(mode))
				syscall.Close(fd)
			}
		}
		syscall.Close(pfd)
		if err != nil && !errors.Is(err, syscall.EEXIST) {
			return &os.PathError{Op: "mkdir", Path: "/" + cur, Err: err}
		}
		if errors.Is(err, syscall.EEXIST) {
			// A file or a link that does not resolve to a folder.
			return &os.PathError{Op: "mkdir", Path: "/" + cur, Err: syscall.ENOTDIR}
		}
	}
	return nil
}

// Lstat describes p without following the last component.
func (r *DirRootfs) Lstat(p string) (fs.FileInfo, error) {
	fd, err := r.open(p, oPath|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, err
	}
	return statInfo{name: path.Base(p), st: st}, nil
}

type statInfo struct {
	name string
	st   syscall.Stat_t
}

func (s statInfo) Name() string { return s.name }
func (s statInfo) Size() int64  { return s.st.Size }
func (s statInfo) Mode() fs.FileMode {
	m := fs.FileMode(s.st.Mode & 0o777)
	switch s.st.Mode & syscall.S_IFMT {
	case syscall.S_IFDIR:
		m |= fs.ModeDir
	case syscall.S_IFLNK:
		m |= fs.ModeSymlink
	case syscall.S_IFBLK:
		m |= fs.ModeDevice
	case syscall.S_IFCHR:
		m |= fs.ModeDevice | fs.ModeCharDevice
	case syscall.S_IFIFO:
		m |= fs.ModeNamedPipe
	case syscall.S_IFSOCK:
		m |= fs.ModeSocket
	}
	if s.st.Mode&syscall.S_ISVTX != 0 {
		m |= fs.ModeSticky
	}
	if s.st.Mode&syscall.S_ISGID != 0 {
		m |= fs.ModeSetgid
	}
	if s.st.Mode&syscall.S_ISUID != 0 {
		m |= fs.ModeSetuid
	}
	return m
}
func (s statInfo) ModTime() time.Time { return time.Unix(s.st.Mtim.Sec, s.st.Mtim.Nsec) }
func (s statInfo) IsDir() bool        { return s.st.Mode&syscall.S_IFMT == syscall.S_IFDIR }
func (s statInfo) Sys() any           { return &s.st }

// openForMeta opens p as O_PATH without following a link in the last
// component; the metadata calls act on it through /proc/self/fd, so a
// device node, FIFO or socket of the target is never opened.
func (r *DirRootfs) openForMeta(p string) (int, error) {
	fd, st, err := r.pathFd(p, syscall.O_NOFOLLOW)
	if err != nil {
		return -1, err
	}
	if st.Mode&syscall.S_IFMT == syscall.S_IFLNK {
		syscall.Close(fd)
		return -1, fmt.Errorf("%s: %w", p, ErrSymlinkTarget)
	}
	return fd, nil
}

// Chmod changes the mode of p (not through a link).
func (r *DirRootfs) Chmod(p string, mode fs.FileMode) error {
	fd, err := r.openForMeta(p)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Chmod(procFd(fd), uint32(mode.Perm())|modeBits(mode))
}

// Chown changes the owner of p (not through a link).
func (r *DirRootfs) Chown(p string, uid, gid int) error {
	fd, err := r.openForMeta(p)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return fchownEmptyPath(fd, uid, gid)
}

// fchownEmptyPath is fchownat(fd, "", AT_EMPTY_PATH): it works on an
// O_PATH descriptor.
func fchownEmptyPath(fd, uid, gid int) error {
	empty := [1]byte{}
	_, _, e := syscall.Syscall6(syscall.SYS_FCHOWNAT, uintptr(fd), uintptr(unsafe.Pointer(&empty[0])), uintptr(uid), uintptr(gid), atEmptyPath, 0)
	if e != 0 {
		return e
	}
	return nil
}

// Remove removes a file, a link or an empty folder.
func (r *DirRootfs) Remove(p string) error {
	dir, base, err := r.parent(p)
	if err != nil {
		return err
	}
	defer dir.Close()
	err = syscall.Unlinkat(int(dir.Fd()), base)
	if errors.Is(err, syscall.EISDIR) || errors.Is(err, syscall.EPERM) {
		err = unlinkatDir(int(dir.Fd()), base)
	}
	if err != nil {
		return &os.PathError{Op: "remove", Path: p, Err: err}
	}
	return nil
}

func unlinkatDir(dfd int, name string) error {
	n, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(dfd), uintptr(unsafe.Pointer(n)), atRemoveDir)
	if e != 0 {
		return e
	}
	return nil
}

// ReadDir lists a folder.
func (r *DirRootfs) ReadDir(p string) ([]string, error) {
	fd, err := r.open(p, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	return f.Readdirnames(-1)
}

// Getxattr reads an extended attribute of p (not through a link).
func (r *DirRootfs) Getxattr(p, name string) ([]byte, error) {
	fd, err := r.openForMeta(p)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)
	n, err := syscall.BytePtrFromString(name)
	if err != nil {
		return nil, err
	}
	pp, err := syscall.BytePtrFromString(procFd(fd))
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	sz, _, e := syscall.Syscall6(syscall.SYS_GETXATTR, uintptr(unsafe.Pointer(pp)), uintptr(unsafe.Pointer(n)), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0)
	if e != 0 {
		return nil, e
	}
	return buf[:sz], nil
}
