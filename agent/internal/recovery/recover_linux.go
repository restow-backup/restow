//go:build linux

package recovery

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// LinuxEnv is FlowEnv on the recovery ISO.
type LinuxEnv struct {
	Exec       Exec
	ResticBin  string
	RunDir     string
	TargetRoot string
	Self       string
	Log        func(string)
	// Console is the console of the shell.
	Console *os.File
	// RepoOverride replaces the session's repository (tests only).
	RepoOverride string

	remote *Remote
	ops    *LinuxOps
	efi    EFIVars
}

func (e *LinuxEnv) runDir(sub string) string { return filepath.Join(e.RunDir, sub) }

// Now implements FlowEnv.
func (e *LinuxEnv) Now() time.Time { return time.Now() }

// Hardware implements FlowEnv.
func (e *LinuxEnv) Hardware(ctx context.Context) (HardwareInput, error) {
	h := &HardwareCollector{Exec: e.Exec, EFI: e.efi, Probe: true}
	return h.Collect(ctx)
}

// Interfaces implements FlowEnv.
func (e *LinuxEnv) Interfaces() []NetIface { return Interfaces("") }

// ApplyNetwork implements FlowEnv.
func (e *LinuxEnv) ApplyNetwork(ctx context.Context, n AnswersNetwork) error {
	return ApplyStatic(ctx, e.Exec, n)
}

// WaitNetwork implements FlowEnv.
func (e *LinuxEnv) WaitNetwork(ctx context.Context, ui *UI, timeout time.Duration) []NetIface {
	return WaitAddress(ctx, ui, timeout)
}

// NoDriverDevices implements FlowEnv.
func (e *LinuxEnv) NoDriverDevices(ctx context.Context) []string {
	res, err := e.Exec.Run(ctx, RunSpec{Argv: []string{"lspci", "-k"}, Timeout: time.Minute})
	if err != nil {
		return nil
	}
	return ParseLspciNoDriver(string(res.Output))
}

// LoadKeymap implements FlowEnv: ckbcomp <layout> [<variant>] | loadkeys -.
func (e *LinuxEnv) LoadKeymap(ctx context.Context, layout, variant string) error {
	if layout == "" {
		return nil
	}
	res, err := e.Exec.Run(ctx, RunSpec{Argv: CkbcompArgs(layout, variant), Timeout: time.Minute})
	if err != nil {
		return err
	}
	_, err = e.Exec.Run(ctx, RunSpec{Argv: []string{"loadkeys", "-"}, Stdin: res.Output, Timeout: time.Minute})
	return err
}

// SetClock implements FlowEnv.
func (e *LinuxEnv) SetClock(t time.Time) error { return SetClock(t) }

// ProbeTLS implements FlowEnv.
func (e *LinuxEnv) ProbeTLS(ctx context.Context, origin, proxy string) (*TLSProbe, error) {
	return ProbeTLS(ctx, origin, proxy, nil)
}

// DateHint implements FlowEnv.
func (e *LinuxEnv) DateHint(ctx context.Context, origin, proxy string) (time.Time, error) {
	return DateHint(ctx, origin, proxy)
}

// ReadFile implements FlowEnv (a CA file, at most 1 MiB).
func (e *LinuxEnv) ReadFile(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, 1<<20))
}

// Restic implements FlowEnv.
func (e *LinuxEnv) Restic(repo string, password []byte, user, pass string, trust TrustConfig) (ResticReader, ResticRestorer, func(), error) {
	ca, err := WritePinnedLeaf(e.runDir("tls"), trust)
	if err != nil {
		return nil, nil, nil, err
	}
	if e.RepoOverride != "" {
		repo, user, pass = e.RepoOverride, "", ""
	}
	r := &restic.Runner{Bin: e.ResticBin, Repo: repo, PasswordBytes: password, RESTUser: user, RESTPass: pass,
		TmpDir: e.runDir("tmp"), CACert: ca, Proxy: trust.Proxy, OwnProcessGroup: true, Log: e.Log}
	return RunnerReader{Runner: r}, ResticExec{Runner: r}, r.ZeroSecrets, nil
}

// Executor implements FlowEnv.
func (e *LinuxEnv) Executor(x *Executor, t *baremetal.Target) {
	x.Exec = e.Exec
	x.TargetRoot = e.TargetRoot
	var rootfs *DirRootfs
	e.ops = &LinuxOps{Exec: e.Exec, Holders: &Holders{Exec: e.Exec}, EFI: e.efi, TmpDir: e.runDir("tmp"), Rootfs: func() *DirRootfs { return rootfs }}
	x.Ops = e.ops
	x.Isolator = HelperIsolator{Self: e.Self}
	x.OpenRootfs = func() (Rootfs, error) {
		r, err := OpenRootfs(e.TargetRoot)
		if err != nil {
			return nil, err
		}
		rootfs = r
		return r, nil
	}
	x.Verifier = StandardVerifier{Env: LinuxVerifyEnv{EFI: e.efi, HW: &HardwareCollector{Exec: e.Exec}}, Target: t}
}

// Finalize implements FlowEnv.
func (e *LinuxEnv) Finalize(ctx context.Context, x *Executor) {
	if e.ops != nil {
		x.Shutdown(ctx, e.ops, x.TargetDevices)
	}
}

// Shell implements FlowEnv: bash on the console, exit returns.
func (e *LinuxEnv) Shell(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "/bin/bash", "-l")
	if e.Console != nil {
		cmd.Stdin, cmd.Stdout, cmd.Stderr = e.Console, e.Console, e.Console
	} else {
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	}
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=linux", "LANG=C.UTF-8"}
	return cmd.Run()
}

// Reboot implements FlowEnv.
func (e *LinuxEnv) Reboot(ctx context.Context) error {
	_, err := e.Exec.Run(ctx, RunSpec{Argv: []string{"systemctl", "reboot"}, Timeout: time.Minute})
	return err
}

// PowerOff implements FlowEnv.
func (e *LinuxEnv) PowerOff(ctx context.Context) error {
	_, err := e.Exec.Run(ctx, RunSpec{Argv: []string{"systemctl", "poweroff"}, Timeout: time.Minute})
	return err
}

// EnableRemote implements FlowEnv.
func (e *LinuxEnv) EnableRemote(ctx context.Context) (string, []api.RecoverySSHHostKey, error) {
	if e.remote == nil {
		e.remote = &Remote{Exec: e.Exec, RunDir: e.RunDir}
	}
	return e.remote.EnablePassword(ctx)
}

// RemoteKeys implements FlowEnv.
func (e *LinuxEnv) RemoteKeys(ctx context.Context, keys []string) error {
	if e.remote == nil {
		return nil
	}
	return e.remote.UseKeys(ctx, keys)
}

// MainOptions are the flags of restow-agent recover.
type MainOptions struct {
	Console     string
	AnswersFile string
	PlanOnly    bool
	LogFile     string
	ResticBin   string
	NotISO      bool
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
}

// FWCfgAnswers is where QEMU's fw_cfg exposes the answers.
const FWCfgAnswers = "/sys/firmware/qemu_fw_cfg/by_name/opt/restow/answers/raw"

// Main runs restow-agent recover.
func Main(o MainOptions) int {
	if runtime.GOARCH != "amd64" {
		fmt.Fprintln(o.Stderr, T(LangEN, "code."+ProblemArchUnsupported))
		return 1
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(o.Stderr, T(LangEN, "start.not_root"))
		return 1
	}
	if _, err := os.Stat("/run/live/medium"); err != nil && !o.NotISO {
		fmt.Fprintln(o.Stderr, T(LangEN, "start.not_iso"))
		return 1
	}
	for _, d := range []string{"tmp", "tls", "log", "media"} {
		if err := os.MkdirAll(filepath.Join(paths.RecoveryRunDir, d), 0o700); err != nil {
			fmt.Fprintln(o.Stderr, err)
			return 1
		}
	}
	cmdlineRaw, _ := os.ReadFile("/proc/cmdline")
	cl := ParseCmdline(string(cmdlineRaw))
	console := o.Console
	if cl.Console != "" {
		console = cl.Console
	}
	in, out := o.Stdin, o.Stdout
	var tty *os.File
	if console != "" && console != "-" {
		f, err := os.OpenFile(console, os.O_RDWR|syscall.O_NOCTTY, 0)
		if err != nil {
			fmt.Fprintln(o.Stderr, err)
			return 1
		}
		defer f.Close()
		tty, in, out = f, f, f
	}
	logPath := o.LogFile
	if logPath == "" {
		logPath = filepath.Join(paths.RecoveryRunDir, "log", "recover.log")
	}
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintln(o.Stderr, err)
		return 1
	}
	defer lf.Close()
	logBuf := &LogBuffer{File: lf}
	// In a QEMU machine with answers on fw_cfg (the recovery lab, CI) the default menu entry
	// shows recover on tty1 only: protocol and screen also go to the first serial port, which
	// the lab records, so a run that stops before it reaches the instance says why.
	var mirror io.Writer
	if console != "/dev/ttyS0" {
		if w := qemuSerialMirror(); w != nil {
			defer w.Close()
			mirror = w
			logBuf.File = io.MultiWriter(lf, w)
		}
	}
	exe := CmdExec{Runner: cmdrun.ExecRunner{OwnProcessGroup: true}, Log: logBuf.Add}
	uiOut := out
	if mirror != nil {
		uiOut = io.MultiWriter(out, mirror)
	}
	ui := &UI{In: in, Out: uiOut, Lang: LangEN, Serial: strings.HasPrefix(console, "/dev/ttyS")}
	answers, err := loadAnswers(context.Background(), o.AnswersFile, cl, exe)
	if err != nil {
		ui.Raw(err.Error())
		return 2
	}
	resticBin := o.ResticBin
	if resticBin == "" {
		resticBin = filepath.Join(paths.RecoveryLibDir, "restic")
	}
	env := &LinuxEnv{Exec: exe, ResticBin: resticBin, RunDir: paths.RecoveryRunDir, TargetRoot: paths.RecoveryTargetRoot,
		Self: "/proc/self/exe", Log: logBuf.Add, Console: tty}
	r := &Recover{UI: ui, Env: env, Answers: answers, Cmdline: cl, Version: buildinfo.Version, PlanOnly: o.PlanOnly, PlanOut: o.Stdout, Log: logBuf}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGINT)
	signal.Ignore(syscall.SIGHUP)
	go func() {
		for range sigs {
			r.Interrupt()
		}
	}()
	res, err := r.Run(ctx)
	if err != nil || res == nil || res.Status != api.RecoverySucceeded {
		if res != nil && res.Status == api.RecoveryCancelled {
			return 3
		}
		return 1
	}
	return 0
}

// qemuSerialMirror opens the first serial port for writing when recover
// runs in a QEMU machine that carries answers on fw_cfg, else nil.
func qemuSerialMirror() *os.File {
	vendor, _ := os.ReadFile("/sys/class/dmi/id/sys_vendor")
	if strings.TrimSpace(string(vendor)) != "QEMU" {
		return nil
	}
	if _, err := os.Stat(FWCfgAnswers); err != nil {
		return nil
	}
	f, err := os.OpenFile("/dev/ttyS0", os.O_WRONLY|syscall.O_NOCTTY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil
	}
	return f
}

// loadAnswers reads the answers from the chosen source only (10.20).
func loadAnswers(ctx context.Context, file string, cl CmdlineOptions, x Exec) (*Answers, error) {
	vendor, _ := os.ReadFile("/sys/class/dmi/id/sys_vendor")
	isQEMU := strings.TrimSpace(string(vendor)) == "QEMU"
	if file != "" {
		b, err := readCapped(file)
		if err != nil {
			return nil, err
		}
		return LoadAnswers(SourceFile, b, isQEMU)
	}
	if isQEMU {
		if b, err := readCapped(FWCfgAnswers); err == nil {
			return LoadAnswers(SourceFWCfg, b, isQEMU)
		}
	}
	if !cl.AnswersMedia {
		return nil, nil
	}
	medium, err := findAnswersMedium(ctx, x, "/sys", (&HardwareCollector{Exec: x}).liveMedium(ctx))
	if err != nil {
		return nil, err
	}
	media := filepath.Join(paths.RecoveryRunDir, "media")
	if _, err := x.Run(ctx, RunSpec{Argv: []string{"mount", "-o", "ro,nosuid,nodev,noexec", medium.Device, media}, Timeout: time.Minute}); err != nil {
		return nil, err
	}
	b, err := readCapped(filepath.Join(media, "answers.json"))
	if err != nil {
		return nil, err
	}
	a, err := LoadAnswers(SourceMedia, b, isQEMU)
	if err != nil {
		return nil, err
	}
	a.Medium = &medium
	return a, nil
}

// findAnswersMedium finds the medium of restow.answers=media (10.20).
// Labels are chosen by whoever made the file system, the backup among
// them (a restored target can carry a RESTOWANS file system), so the
// label alone is not enough: exactly one device may carry it, it must be
// a plain partition or disk (no dm, md or loop device), its disk must be
// removable or on USB, and it must not be the disk the ISO started from
// (live). sysRoot is /sys (tests use a fake tree).
func findAnswersMedium(ctx context.Context, x Exec, sysRoot, live string) (AnswersMedium, error) {
	label := baremetal.AnswersLabel
	res, err := x.Run(ctx, RunSpec{Argv: []string{"blkid", "-c", "/dev/null", "-t", "LABEL=" + label, "-o", "device"}, Timeout: time.Minute})
	var devs []string
	if err == nil {
		for _, l := range strings.Split(string(res.Output), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				devs = append(devs, l)
			}
		}
	}
	switch {
	case len(devs) == 0:
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: no medium labelled %s", label)
	case len(devs) > 1:
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: %d devices are labelled %s (%s); a disk of the machine may carry the label, so none is used: connect only the medium with the answers, or start without restow.answers=media",
			len(devs), label, strings.Join(devs, ", "))
	}
	dev := devs[0]
	kname, ok := strings.CutPrefix(dev, "/dev/")
	if !ok || !reKName.MatchString(kname) || reVirtual.MatchString(kname) {
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: %s is not a partition or disk of a removable medium", dev)
	}
	disk := kname
	t, err := filepath.EvalSymlinks(filepath.Join(sysRoot, "class/block", kname))
	if err != nil {
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: %s: %v", dev, err)
	}
	if _, err := os.Stat(filepath.Join(t, "partition")); err == nil {
		disk = filepath.Base(filepath.Dir(t))
	}
	if !reKName.MatchString(disk) || reVirtual.MatchString(disk) {
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: %s is not on a removable medium", dev)
	}
	if live != "" && disk == live {
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: %s is on the disk the ISO started from; put the answers on a separate medium", dev)
	}
	base := filepath.Join(sysRoot, "block", disk)
	usb := false
	if p, err := filepath.EvalSymlinks(base); err == nil && strings.Contains(p, "/usb") {
		usb = true
	}
	if readTrim(filepath.Join(base, "removable")) != "1" && !usb {
		return AnswersMedium{}, fmt.Errorf("restow.answers=media: %s is on %s, which is neither removable nor on USB; answers are read only from a separate medium", dev, disk)
	}
	return AnswersMedium{Device: dev, Disk: disk, Model: readTrim(filepath.Join(base, "device/model"))}, nil
}

func readCapped(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxAnswersBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxAnswersBytes {
		return nil, errors.New("answers: file too large")
	}
	return b, nil
}
