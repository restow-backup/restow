//go:build linux

package oneshot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/recovery"
)

// WorkDir holds the downloaded recovery ISO (public data; the disk is
// erased anyway). The secrets never touch a disk: they live in memory and
// in the memfd of the initrd.
const WorkDir = "/var/tmp/restow-oneshot"

const (
	mfdCloexec       = 0x1
	kexecFileUnload  = 0x1
	rebootCmdKexec   = 0x45584543
	kexecLoadedPath  = "/sys/kernel/kexec_loaded"
	maxKernelBytes   = 256 << 20
	outputLimitBytes = 8 << 20
)

// LinuxEnv is the machine the command runs on.
type LinuxEnv struct {
	Runner cmdrun.ExecRunner
	Log    func(string)
	// Dir replaces WorkDir (tests).
	Dir string
}

func (e *LinuxEnv) dir() string {
	if e.Dir != "" {
		return e.Dir
	}
	return WorkDir
}

// ReadFile implements Env.
func (e *LinuxEnv) ReadFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, 4<<20))
}

// ReadDir implements Env.
func (e *LinuxEnv) ReadDir(path string) ([]string, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, en := range entries {
		if en.IsDir() && !strings.HasPrefix(en.Name(), ".") && en.Name() != "lost+found" {
			names = append(names, en.Name())
		}
	}
	return names, nil
}

// Exists implements Env.
func (e *LinuxEnv) Exists(path string) bool { _, err := os.Lstat(path); return err == nil }

// Output implements Env: the program from the root-owned tool folders,
// with argv, no shell.
func (e *LinuxEnv) Output(ctx context.Context, argv ...string) ([]byte, error) {
	bin, err := e.Runner.Resolve(argv[0])
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, argv[1:]...)
	var out bytes.Buffer
	cmd.Stdout = &limited{w: &out, n: outputLimitBytes}
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	err = cmd.Run()
	return out.Bytes(), err
}

type limited struct {
	w io.Writer
	n int
}

func (l *limited) Write(p []byte) (int, error) {
	if len(p) > l.n {
		return 0, errors.New("output too large")
	}
	l.n -= len(p)
	return l.w.Write(p)
}

// Hardware implements Env with the collector of the recovery ISO.
func (e *LinuxEnv) Hardware(ctx context.Context) (recovery.HardwareInput, error) {
	h := &recovery.HardwareCollector{Exec: recovery.CmdExec{Runner: e.Runner, Log: e.Log}}
	return h.Collect(ctx)
}

// UsedBytes implements Env: the used space of the local file systems
// below /, /home, /srv, /var and /opt, less /usr and /var/cache.
func (e *LinuxEnv) UsedBytes() int64 {
	seen := map[[2]int32]bool{}
	var used int64
	for _, p := range []string{"/", "/home", "/srv", "/var", "/opt"} {
		var st syscall.Statfs_t
		if syscall.Statfs(p, &st) != nil || seen[st.Fsid.X__val] {
			continue
		}
		seen[st.Fsid.X__val] = true
		used += int64(st.Blocks-st.Bfree) * st.Bsize
	}
	for _, p := range []string{"/usr", "/var/cache"} {
		used -= treeBytes(p)
	}
	if used < 0 {
		return 0
	}
	return used
}

// treeBytes sums the regular files below p on its own file system.
func treeBytes(p string) int64 {
	var dev uint64
	if fi, err := os.Lstat(p); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			dev = st.Dev
		}
	}
	var n int64
	_ = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Dev != dev {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if fi.Mode().IsRegular() {
			n += st.Blocks * 512
		}
		return nil
	})
	return n
}

// isoFile is the downloaded ISO.
type isoFile struct{ *os.File }

// ISOFile implements Env: a new file in a folder of root's (0700).
func (e *LinuxEnv) ISOFile() (ISOFile, error) {
	dir := e.dir()
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.IsDir() || !ok || int(st.Uid) != os.Geteuid() || fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is not a private folder of this user", dir)
	}
	f, err := os.OpenFile(filepath.Join(dir, "recovery.iso"), os.O_RDWR|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	return isoFile{f}, nil
}

// Cleanup implements Env.
func (e *LinuxEnv) Cleanup() { _ = os.RemoveAll(e.dir()) }

// memfd copies r into a new memfd (MFD_CLOEXEC) and returns it.
func memfd(name string, fill func(io.Writer) error) (*os.File, error) {
	if !kexecSupported {
		return nil, errors.New("kexec is supported on amd64 only")
	}
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return nil, err
	}
	fd, _, errno := syscall.Syscall(sysMemfdCreate, uintptr(unsafe.Pointer(p)), mfdCloexec, 0)
	if errno != 0 {
		return nil, fmt.Errorf("memfd_create: %w", errno)
	}
	f := os.NewFile(fd, name)
	if err := fill(f); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// KexecLoad implements Env: kernel and initrd go into memfds (nothing on a
// disk), then kexec_file_load. Under lockdown the kernel checks the
// signature of the kernel itself.
func (e *LinuxEnv) KexecLoad(kernel io.Reader, fill func(io.Writer) error, cmdline string) error {
	k, err := memfd("restow-kernel", func(w io.Writer) error {
		n, err := io.Copy(w, io.LimitReader(kernel, maxKernelBytes+1))
		if err == nil && n > maxKernelBytes {
			err = errors.New("the kernel is too large")
		}
		return err
	})
	if err != nil {
		return err
	}
	defer k.Close()
	i, err := memfd("restow-initrd", fill)
	if err != nil {
		return err
	}
	defer i.Close()
	return KexecFileLoad(int(k.Fd()), int(i.Fd()), cmdline)
}

// KexecFileLoad is the raw kexec_file_load. The command line is passed
// with its terminating NUL, as the kernel wants.
func KexecFileLoad(kernelFd, initrdFd int, cmdline string) error {
	if !kexecSupported {
		return errors.New("kexec is supported on amd64 only")
	}
	b := append([]byte(cmdline), 0)
	_, _, errno := syscall.Syscall6(sysKexecFileLoad, uintptr(kernelFd), uintptr(initrdFd), uintptr(len(b)),
		uintptr(unsafe.Pointer(&b[0])), 0, 0)
	if errno != 0 {
		return fmt.Errorf("kexec_file_load: %w", errno)
	}
	return nil
}

// KexecUnload implements Env.
func (e *LinuxEnv) KexecUnload() error {
	if !kexecSupported {
		return errors.New("kexec is supported on amd64 only")
	}
	_, _, errno := syscall.Syscall6(sysKexecFileLoad, ^uintptr(0), ^uintptr(0), 0, 0, kexecFileUnload, 0)
	if errno != 0 {
		return fmt.Errorf("kexec_file_load (unload): %w", errno)
	}
	return nil
}

// KexecLoaded implements Env.
func (e *LinuxEnv) KexecLoaded() bool {
	b, _ := os.ReadFile(kexecLoadedPath)
	return strings.TrimSpace(string(b)) == "1"
}

// Kexec implements Env: systemctl kexec shuts the machine down in order
// and starts the loaded kernel; without systemd, sync and the reboot call.
func (e *LinuxEnv) Kexec(ctx context.Context) error {
	if _, err := e.Output(ctx, "systemctl", "kexec"); err == nil {
		// systemd stops this process on the way down.
		time.Sleep(2 * time.Minute)
		return errors.New("systemctl kexec returned, but the machine did not switch")
	} else if e.Log != nil {
		e.Log("systemctl kexec: " + err.Error())
	}
	syscall.Sync()
	return syscall.Reboot(rebootCmdKexec)
}
