//go:build linux

package recovery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// prctl options and flags the helper needs (linux/prctl.h, seccomp.h).
const (
	prSetDumpable     = 4
	prSetSeccomp      = 22
	prCapbsetDrop     = 24
	prSetNoNewPrivs   = 38
	seccompModeFilter = 2
	cloneNewCgroup    = 0x02000000
)

// RunIsolated runs spec.Argv inside the target through the helper self
// (the agent binary; "/proc/self/exe" on the ISO): self is started as
// `chroot-exec --spec 3` in new PID, network, IPC, UTS and cgroup
// namespaces (Cloneflags, so the helper is PID 1 of the new PID
// namespace; R5) and a new mount namespace, in a new session, with an
// empty environment and SIGKILL when recover dies. Output is stdout and
// stderr together, capped.
func RunIsolated(ctx context.Context, self string, spec IsolateSpec, maxOut int) (*IsolationResult, error) {
	if err := CheckIsolateSpec(spec); err != nil {
		return nil, err
	}
	b, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer pr.Close()
	timeout := time.Duration(spec.TimeoutSeconds) * time.Second
	if timeout == 0 {
		timeout = 30 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout+time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, self, "chroot-exec", "--spec", "3")
	cmd.Env = []string{}
	cmd.Stdin = nil
	if maxOut <= 0 {
		maxOut = 4 << 20
	}
	out := &cappedBuffer{max: maxOut}
	cmd.Stdout, cmd.Stderr = out, out
	cmd.ExtraFiles = []*os.File{pr}
	cmd.WaitDelay = 10 * time.Second
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:   syscall.CLONE_NEWPID | syscall.CLONE_NEWNET | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS | cloneNewCgroup,
		Unshareflags: syscall.CLONE_NEWNS,
		Pdeathsig:    syscall.SIGKILL,
		// A new session without a controlling terminal: /dev/tty of the
		// isolation is not the console of recover.
		Setsid: true,
	}
	if err := cmd.Start(); err != nil {
		pw.Close()
		return nil, fmt.Errorf("chroot-exec: %w", err)
	}
	_, werr := pw.Write(b)
	pw.Close()
	err = cmd.Wait()
	res := &IsolationResult{Output: out.Bytes(), ExitCode: -1}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if werr != nil && err == nil {
		err = werr
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		err = nil
	}
	if cctx.Err() != nil && ctx.Err() == nil {
		return res, fmt.Errorf("%s did not finish within %s", spec.Argv[0], timeout)
	}
	return res, err
}

type cappedBuffer struct {
	buf  bytes.Buffer
	max  int
	over bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.max {
		c.over = true
		if room := c.max - c.buf.Len(); room > 0 {
			c.buf.Write(p[:room])
		}
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *cappedBuffer) Bytes() []byte { return c.buf.Bytes() }

// ChrootExecCommand is the hidden command `chroot-exec`: --spec <fd> is
// the helper as PID 1 (mounts, pivot_root, reaping), --stage2 <fd> the
// process that drops privileges and execs the program.
func ChrootExecCommand(args []string, stderr io.Writer) int {
	if len(args) != 2 || (args[0] != "--spec" && args[0] != "--stage2") || args[1] != "3" {
		fmt.Fprintln(stderr, "usage: restow-agent chroot-exec --spec 3 (internal)")
		return 2
	}
	f := os.NewFile(3, "spec")
	if f == nil {
		fmt.Fprintln(stderr, "chroot-exec: no spec on fd 3")
		return 2
	}
	b, err := io.ReadAll(io.LimitReader(f, 1<<20))
	f.Close()
	var spec IsolateSpec
	if err == nil {
		err = json.Unmarshal(b, &spec)
	}
	if err == nil {
		err = CheckIsolateSpec(spec)
	}
	if err != nil {
		fmt.Fprintln(stderr, "chroot-exec:", err)
		return 2
	}
	if args[0] == "--stage2" {
		err := stage2(spec)
		fmt.Fprintln(stderr, "chroot-exec:", err)
		return 126
	}
	code, err := initMain(spec, b)
	if err != nil {
		fmt.Fprintln(stderr, "chroot-exec:", err)
		return 125
	}
	return code
}

// initMain is PID 1 of the new PID namespace.
func initMain(spec IsolateSpec, specJSON []byte) (int, error) {
	if os.Getpid() != 1 {
		return 0, errors.New("not PID 1 of a new PID namespace")
	}
	if err := setupRoot(spec); err != nil {
		return 0, err
	}
	// The program may read neither the memory nor the environment of PID 1
	// (it lacks CAP_SYS_PTRACE; R6).
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); e != 0 {
		return 0, fmt.Errorf("PR_SET_DUMPABLE: %v", e)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return 0, err
	}
	cwd := spec.Cwd
	if cwd == "" {
		cwd = "/"
	}
	attr := &os.ProcAttr{Dir: cwd, Env: []string{}, Files: []*os.File{os.Stdin, os.Stdout, os.Stderr, pr}}
	p, err := os.StartProcess("/proc/self/exe", []string{"restow-agent", "chroot-exec", "--stage2", "3"}, attr)
	pr.Close()
	if err != nil {
		pw.Close()
		return 0, fmt.Errorf("start the program: %w", err)
	}
	_, _ = pw.Write(specJSON)
	pw.Close()
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	timeout := time.Duration(spec.TimeoutSeconds) * time.Second
	if timeout == 0 {
		timeout = 30 * time.Minute
	}
	timer := time.AfterFunc(timeout, func() { _ = syscall.Kill(-1, syscall.SIGKILL) })
	defer timer.Stop()
	go func() {
		for s := range sigs {
			_ = p.Signal(s)
		}
	}()
	// Reap every child (orphans are reparented to PID 1); the exit code is
	// the program's. When it ends, the namespace ends with PID 1.
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, 0, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return 125, fmt.Errorf("wait: %w", err)
		}
		if pid == p.Pid {
			switch {
			case ws.Exited():
				return ws.ExitStatus(), nil
			case ws.Signaled():
				return 128 + int(ws.Signal()), nil
			}
			return 125, nil
		}
	}
}

// setupRoot builds the view of the program: the target root bound onto
// itself, a fresh /proc, /sys read-only, /run on tmpfs, a /dev tmpfs with
// nodev holding only bind mounts of the null devices, a private devpts
// and the target devices, then pivot_root and the old root detached.
func setupRoot(spec IsolateSpec) error {
	root := filepath.Clean(spec.Root)
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return fmt.Errorf("make / private: %w", err)
	}
	if err := syscall.Mount(root, root, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return fmt.Errorf("bind %s: %w", root, err)
	}
	// The mount points are plain directories of the target (recover's
	// mkdirs step made them); a symlink or anything else is refused.
	for _, d := range []string{"proc", "sys", "dev", "run"} {
		st, err := os.Lstat(filepath.Join(root, d))
		if err != nil || !st.IsDir() {
			return fmt.Errorf("%s/%s is not a directory of the target", root, d)
		}
	}
	dev := filepath.Join(root, "dev")
	if err := syscall.Mount("tmpfs", dev, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "mode=0755,size=4m"); err != nil {
		return fmt.Errorf("mount /dev: %w", err)
	}
	for _, n := range []string{"null", "zero", "full", "random", "urandom", "tty"} {
		if err := bindNode("/dev/"+n, filepath.Join(dev, n)); err != nil {
			return err
		}
	}
	if err := os.Mkdir(filepath.Join(dev, "pts"), 0o755); err != nil {
		return err
	}
	if err := syscall.Mount("devpts", filepath.Join(dev, "pts"), "devpts", syscall.MS_NOSUID|syscall.MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620"); err != nil {
		return fmt.Errorf("mount devpts: %w", err)
	}
	if err := os.Mkdir(filepath.Join(dev, "shm"), 0o1777); err != nil {
		return err
	}
	if err := syscall.Mount("tmpfs", filepath.Join(dev, "shm"), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=1777,size=64m"); err != nil {
		return fmt.Errorf("mount /dev/shm: %w", err)
	}
	for name, target := range map[string]string{"ptmx": "pts/ptmx", "fd": "/proc/self/fd", "stdin": "/proc/self/fd/0", "stdout": "/proc/self/fd/1", "stderr": "/proc/self/fd/2"} {
		if err := os.Symlink(target, filepath.Join(dev, name)); err != nil {
			return err
		}
	}
	devices := append([]string(nil), spec.Devices...)
	if spec.CapSysAdmin {
		devices = append(devices, "/dev/mapper/control")
	}
	bound := map[string]bool{}
	for _, d := range devices {
		if err := bindDevice(d, dev, bound); err != nil {
			return err
		}
	}
	for _, l := range spec.DevLinks {
		target, err := os.Readlink(l)
		if err != nil {
			continue
		}
		resolved, err := filepath.EvalSymlinks(l)
		if err != nil || !bound[resolved] {
			continue // a link to a device that is not in the set
		}
		p := filepath.Join(dev, strings.TrimPrefix(l, "/dev/"))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.Symlink(target, p); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	if err := syscall.Mount("sysfs", filepath.Join(root, "sys"), "sysfs", syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil {
		return fmt.Errorf("mount /sys: %w", err)
	}
	if err := syscall.Mount("proc", filepath.Join(root, "proc"), "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil {
		return fmt.Errorf("mount /proc: %w", err)
	}
	if err := protectProc(filepath.Join(root, "proc"), filepath.Join(dev, "null")); err != nil {
		return err
	}
	if err := syscall.Mount("tmpfs", filepath.Join(root, "run"), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=0755,size=64m"); err != nil {
		return fmt.Errorf("mount /run: %w", err)
	}
	if err := syscall.Chdir(root); err != nil {
		return err
	}
	if err := syscall.PivotRoot(".", "."); err != nil {
		return fmt.Errorf("pivot_root: %w", err)
	}
	if err := syscall.Unmount(".", syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("detach the old root: %w", err)
	}
	return syscall.Chdir("/")
}

// Parts of the fresh /proc that act on the whole machine and need only
// uid 0, no capability: a write to /proc/sys/kernel/core_pattern would let
// the kernel run a file of the target as full root outside every
// namespace, /proc/sysrq-trigger reboots or kills recover. They are made
// read-only or masked the way container runtimes do it (10.14).
var (
	procReadOnly   = []string{"sys", "sysrq-trigger", "irq", "bus", "fs"}
	procMaskFiles  = []string{"kcore", "kallsyms", "keys", "latency_stats", "timer_list", "timer_stats", "sched_debug", "mtrr"}
	procMaskFolder = []string{"acpi", "asound", "scsi"}
)

// protectProc binds the read-only parts onto themselves read-only, the
// masked files to null and an empty read-only tmpfs over the masked
// folders. A part the kernel does not have is left out.
func protectProc(proc, null string) error {
	const flags = syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC
	for _, n := range procReadOnly {
		p := filepath.Join(proc, n)
		if _, err := os.Lstat(p); err != nil {
			continue
		}
		if err := syscall.Mount(p, p, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
			return fmt.Errorf("bind /proc/%s: %w", n, err)
		}
		if err := syscall.Mount(p, p, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|flags, ""); err != nil {
			return fmt.Errorf("make /proc/%s read-only: %w", n, err)
		}
	}
	for _, n := range procMaskFiles {
		p := filepath.Join(proc, n)
		if st, err := os.Lstat(p); err != nil || st.IsDir() {
			continue
		}
		if err := syscall.Mount(null, p, "", syscall.MS_BIND, ""); err != nil {
			return fmt.Errorf("mask /proc/%s: %w", n, err)
		}
	}
	for _, n := range procMaskFolder {
		p := filepath.Join(proc, n)
		if st, err := os.Lstat(p); err != nil || !st.IsDir() {
			continue
		}
		if err := syscall.Mount("tmpfs", p, "tmpfs", syscall.MS_RDONLY|flags, "size=4k,mode=0555"); err != nil {
			return fmt.Errorf("mask /proc/%s: %w", n, err)
		}
	}
	return nil
}

// bindNode bind-mounts one device node of the ISO onto a new file.
func bindNode(src, dst string) error {
	st, err := os.Stat(src)
	if err != nil {
		return err
	}
	if st.Mode()&os.ModeDevice == 0 {
		return fmt.Errorf("%s is not a device", src)
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	f.Close()
	if err := syscall.Mount(src, dst, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind %s: %w", src, err)
	}
	return nil
}

// bindDevice binds a device of the set (a symlink such as /dev/vg/lv is
// recreated and the node it names bound).
func bindDevice(d, dev string, bound map[string]bool) error {
	st, err := os.Lstat(d)
	if err != nil {
		return nil // a device that does not exist (yet) is left out
	}
	rel := strings.TrimPrefix(d, "/dev/")
	if st.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(d)
		if err != nil {
			return err
		}
		resolved, err := filepath.EvalSymlinks(d)
		if err != nil || !strings.HasPrefix(resolved, "/dev/") {
			return fmt.Errorf("%s points outside /dev", d)
		}
		p := filepath.Join(dev, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.Symlink(target, p); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		return bindDevice(resolved, dev, bound)
	}
	if bound[d] {
		return nil
	}
	p := filepath.Join(dev, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := bindNode(d, p); err != nil {
		return err
	}
	bound[d] = true
	return nil
}

// stage2 drops privileges and execs the program; it returns only on an
// error. Everything happens on one locked thread: the bounding set, no new
// privileges and the seccomp filter are per thread, and exec keeps them.
func stage2(spec IsolateSpec) error {
	runtime.LockOSThread()
	arch, err := nativeArch()
	if err != nil {
		return err
	}
	filter, err := BuildSeccomp(arch)
	if err != nil {
		return err
	}
	for _, c := range capsToDrop(spec.CapSysAdmin) {
		if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prCapbsetDrop, uintptr(c), 0); e != 0 && e != syscall.EINVAL {
			return fmt.Errorf("PR_CAPBSET_DROP %d: %v", c, e)
		}
	}
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); e != 0 {
		return fmt.Errorf("PR_SET_NO_NEW_PRIVS: %v", e)
	}
	bin, err := lookInRoot(spec.Argv[0])
	if err != nil {
		return err
	}
	env := IsolatedEnv(spec.Env)
	prog := struct {
		Len    uint16
		_      [6]byte
		Filter *SockFilter
	}{Len: uint16(len(filter)), Filter: &filter[0]}
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetSeccomp, seccompModeFilter, uintptr(unsafe.Pointer(&prog))); e != 0 {
		return fmt.Errorf("PR_SET_SECCOMP: %v", e)
	}
	runtime.KeepAlive(filter)
	return syscall.Exec(bin, spec.Argv, env)
}

// lookInRoot finds a program of the target in the fixed directories.
func lookInRoot(name string) (string, error) {
	if strings.HasPrefix(name, "/") {
		return name, nil
	}
	for _, d := range []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: not found in the target", name)
}

// DeviceSet expands the target devices of a step: every disk with its
// partitions and the md and device-mapper nodes on top of them (from
// /sys/block/*/holders), their /dev/mapper, /dev/md and /dev/<vg> names,
// and the /dev/disk/by-* links that point to any of them. sysRoot and
// devRoot are /sys and /dev (tests use fake trees).
func DeviceSet(disks []string, extra []string, sysRoot, devRoot string) (devices, links []string) {
	nodes := map[string]bool{}
	var walk func(k string, depth int)
	walk = func(k string, depth int) {
		if depth > 16 || nodes[k] {
			return
		}
		nodes[k] = true
		holders, _ := os.ReadDir(filepath.Join(sysRoot, "class/block", k, "holders"))
		for _, h := range holders {
			walk(h.Name(), depth+1)
		}
		parts, _ := os.ReadDir(filepath.Join(sysRoot, "block", k))
		for _, p := range parts {
			if strings.HasPrefix(p.Name(), k) {
				if _, err := os.Stat(filepath.Join(sysRoot, "block", k, p.Name(), "partition")); err == nil {
					walk(p.Name(), depth+1)
				}
			}
		}
	}
	for _, d := range disks {
		walk(strings.TrimPrefix(d, "/dev/"), 0)
	}
	for _, e := range extra {
		if r, err := filepath.EvalSymlinks(e); err == nil {
			nodes[strings.TrimPrefix(r, devRoot+"/")] = true
		}
	}
	for k := range nodes {
		devices = append(devices, "/dev/"+k)
	}
	// Names of the nodes: /dev/mapper/*, /dev/md/*, /dev/<vg>/<lv>.
	entries, _ := os.ReadDir(devRoot)
	for _, e := range entries {
		dir := filepath.Join(devRoot, e.Name())
		if !e.IsDir() || e.Name() == "disk" || e.Name() == "pts" || e.Name() == "shm" {
			continue
		}
		subs, _ := os.ReadDir(dir)
		for _, s := range subs {
			p := filepath.Join(dir, s.Name())
			if r, err := filepath.EvalSymlinks(p); err == nil && nodes[strings.TrimPrefix(r, devRoot+"/")] {
				devices = append(devices, "/dev/"+e.Name()+"/"+s.Name())
			} else if st, err := os.Stat(p); err == nil && st.Mode()&os.ModeDevice != 0 && e.Name() == "mapper" && nodes[s.Name()] {
				devices = append(devices, "/dev/mapper/"+s.Name())
			}
		}
	}
	bys, _ := filepath.Glob(filepath.Join(devRoot, "disk", "by-*", "*"))
	for _, l := range bys {
		if r, err := filepath.EvalSymlinks(l); err == nil && nodes[strings.TrimPrefix(r, devRoot+"/")] {
			links = append(links, "/dev/"+strings.TrimPrefix(l, devRoot+"/"))
		}
	}
	sort.Strings(devices)
	sort.Strings(links)
	return devices, links
}

// HelperIsolator runs isolated steps through the agent binary.
type HelperIsolator struct {
	// Self is the agent binary (default /proc/self/exe).
	Self string
}

// Run implements Isolator.
func (h HelperIsolator) Run(ctx context.Context, spec IsolateSpec) (*IsolationResult, error) {
	self := h.Self
	if self == "" {
		self = "/proc/self/exe"
	}
	return RunIsolated(ctx, self, spec, 0)
}
