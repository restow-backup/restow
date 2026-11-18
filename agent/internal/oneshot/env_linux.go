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
	outputLimitBytes = 8 << 20
)

// maxKernelBytes bounds the kernel (a variable for the tests).
var maxKernelBytes int64 = 256 << 20

// LinuxEnv is the machine the command runs on.
type LinuxEnv struct {
	Runner cmdrun.ExecRunner
	Log    func(string)
	// Dir replaces WorkDir (tests).
	Dir string
	// DataDir replaces recovery.OneshotDir (tests).
	DataDir string
	// Stdin, Stdout, Stderr are the console of recover in the direct mode.
	Stdin          io.Reader
	Stdout, Stderr io.Writer
}

// HasTool implements Env.
func (e *LinuxEnv) HasTool(name string) bool { _, err := e.Runner.Resolve(name); return err == nil }

func (e *LinuxEnv) dataDir() string {
	if e.DataDir != "" {
		return e.DataDir
	}
	return recovery.OneshotDir
}

// WriteSessionData implements Env: a fresh folder of root's (0700) and the
// file (0600), never through a link; recover checks both again.
func (e *LinuxEnv) WriteSessionData(data []byte) (string, error) {
	dir := e.dataDir()
	if err := os.Mkdir(dir, 0o700); err != nil {
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
		fi, err := os.Lstat(dir)
		if err != nil {
			return "", err
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !fi.IsDir() || !ok || int(st.Uid) != os.Geteuid() || fi.Mode().Perm() != 0o700 {
			return "", fmt.Errorf("%s is not a private folder of this user", dir)
		}
	}
	p := filepath.Join(dir, "oneshot.json")
	_ = os.Remove(p)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		_ = os.Remove(p)
		return "", err
	}
	return p, f.Close()
}

// RemoveSessionData implements Env.
func (e *LinuxEnv) RemoveSessionData(path string) {
	_ = os.Remove(path)
	_ = os.Remove(filepath.Dir(path))
}

// RunRecover implements Env: recover in this process, outside the ISO.
func (e *LinuxEnv) RunRecover(ctx context.Context, dataPath, resticBin string) int {
	return recovery.Main(recovery.MainOptions{NotISO: true, OneshotFile: dataPath, ResticBin: resticBin,
		Stdin: e.Stdin, Stdout: e.Stdout, Stderr: e.Stderr})
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

// Memfd implements Env.
func (e *LinuxEnv) Memfd(name string, fill func(io.Writer) error) (Blob, error) {
	return memfd(name, fill)
}

// KexecFileLoad implements Env: under lockdown the kernel checks the
// signature of the kernel itself.
func (e *LinuxEnv) KexecFileLoad(kernel, initrd Blob, cmdline string) error {
	k, ok1 := kernel.(*os.File)
	i, ok2 := initrd.(*os.File)
	if !ok1 || !ok2 {
		return errors.New("kexec: not a memfd")
	}
	st, err := k.Stat()
	if err != nil {
		return err
	}
	if st.Size() > maxKernelBytes {
		return errors.New("the kernel is too large")
	}
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
// and starts the loaded kernel. Only when systemctl is missing, or failed
// for another reason than the cancel, sync and the raw reboot call follow;
// a cancel before systemctl ran returns ErrCancelled. systemctl itself runs
// to its end once started (a shutdown that has begun is not interrupted).
func (e *LinuxEnv) Kexec(ctx context.Context) error {
	if ctx.Err() != nil {
		return ErrCancelled
	}
	if _, err := e.Runner.Resolve("systemctl"); err == nil {
		run, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		_, err := e.Output(run, "systemctl", "kexec")
		cancel()
		if err == nil {
			// systemd stops this process on the way down.
			time.Sleep(2 * time.Minute)
			return errors.New("systemctl kexec returned, but the machine did not switch")
		}
		if e.Log != nil {
			e.Log("systemctl kexec: " + err.Error())
		}
		if ctx.Err() != nil {
			return ErrCancelled
		}
	}
	syscall.Sync()
	return syscall.Reboot(rebootCmdKexec)
}
