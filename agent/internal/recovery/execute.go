package recovery

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// Execution of a restow-plan-v1 plan (docs/BAREMETAL.md 10.10 to 10.15,
// 10.18). Every command of the plan is run as it stands (Grundregel 2);
// recover adds only what the plan names as operations, the token values
// and the checks after a step (readback, marker, space).

// Ops are the operations of recover on the machine (ops_linux.go; tests
// use a fake).
type Ops interface {
	ReleaseHolders(ctx context.Context, dev string) error
	BlkZero(ctx context.Context, dev string, head, tail int64) error
	PMBRBoot(ctx context.Context, dev string) error
	WaitPartUUIDs(ctx context.Context, uuids []string, timeout time.Duration) error
	// Exists reports whether a device node or link exists.
	Exists(dev string) bool
	// Mounted reports whether a path of the ISO is a mount point.
	Mounted(p string) bool
	// MkdirHost creates a folder of the ISO (the target root before its
	// file system is mounted).
	MkdirHost(p string) error
	// Statfs is free and total bytes of the file system holding a path of
	// the ISO.
	Statfs(p string) (free, total int64, err error)
	WriteBootEntry(ctx context.Context, e BootEntryRequest) (int, error)
	// Swapfile creates a swap file of the target and returns its resume
	// offset (-1 when unknown).
	Swapfile(ctx context.Context, p string, size int64, uuid, label string) (int64, error)
	// TmpFile writes a private file on tmpfs (0600) for a tool.
	TmpFile(name string, data []byte) (string, func(), error)
	// DeviceSet expands target devices for an isolated step.
	DeviceSet(disks, extra []string) (devices, links []string)
	// UnmountAll unmounts everything below the target root.
	UnmountAll(ctx context.Context, root string) error
	// MappingOn reports whether the device-mapper device name sits on
	// exactly dev (and nothing else), and what it sits on.
	MappingOn(name, dev string) (bool, string)
}

// BootEntryRequest is one Boot#### entry to create.
type BootEntryRequest struct {
	Label    string
	PartUUID string
	Loader   string
}

// Isolator runs a program of the target in isolation (isolate_linux.go).
type Isolator interface {
	Run(ctx context.Context, spec IsolateSpec) (*IsolationResult, error)
}

// IsolationResult is how an isolated program ended.
type IsolationResult struct {
	ExitCode int
	Output   []byte
}

// SessionAPI is the part of the recovery session the execution uses.
type SessionAPI interface {
	Current(ctx context.Context) (*api.RecoverySessionState, error)
	Progress(ctx context.Context, p api.RecoveryProgress) error
	Log(ctx context.Context, lines []string) (api.RecoveryLogResult, error)
	Event(ctx context.Context, kind string, detail map[string]string) error
	Release(ctx context.Context) (string, error)
}

// Secrets are the passphrases recover holds for a run, in buffers it
// zeroes; each is registered with the redactor.
type Secrets struct {
	mu         sync.Mutex
	passphrase []byte
	old        map[string][]byte
	zeroed     bool
}

// SetPassphrase sets the new passphrase of the LUKS volumes.
func (s *Secrets) SetPassphrase(b []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.passphrase = b
	if len(b) > 0 {
		redact.Add(string(b))
	}
}

// SetOld sets the old passphrase of an adopted volume (by its device).
func (s *Secrets) SetOld(dev string, b []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.old == nil {
		s.old = map[string][]byte{}
	}
	s.old[dev] = b
	if len(b) > 0 {
		redact.Add(string(b))
	}
}

func (s *Secrets) get(kind, dev string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.zeroed {
		return nil, errors.New("the passphrases were already cleared; a step after the isolated steps needs one (plan order)")
	}
	switch kind {
	case "passphrase":
		if len(s.passphrase) == 0 {
			return nil, errors.New("no passphrase")
		}
		return s.passphrase, nil
	case "old_passphrase":
		if b := s.old[dev]; len(b) > 0 {
			return b, nil
		}
		return nil, fmt.Errorf("no old passphrase for %s", dev)
	}
	return nil, fmt.Errorf("unknown secret %q", kind)
}

// Zero overwrites every passphrase buffer.
func (s *Secrets) Zero() {
	s.mu.Lock()
	defer s.mu.Unlock()
	zero(s.passphrase)
	for _, b := range s.old {
		zero(b)
	}
	s.passphrase, s.old, s.zeroed = nil, nil, true
}

// Zeroed reports whether Zero ran.
func (s *Secrets) Zeroed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.zeroed }

// Verifier runs the checks of 10.17.
type Verifier interface {
	Verify(ctx context.Context, x *Executor) []*Check
}

// Executor runs one plan.
type Executor struct {
	Plan       *baremetal.RestorePlan
	PlanSHA256 string
	Manifest   *baremetal.Manifest
	// LayoutSHA256 is the SHA-256 of the manifest (for the marker).
	LayoutSHA256 string
	Snapshot     string
	TargetRoot   string
	// OriginalPlanSHA256 is kept in the marker of a resumed run.
	OriginalPlanSHA256 string
	Exec               Exec
	Ops                Ops
	Isolator           Isolator
	Restic             ResticRestorer
	Session            SessionAPI
	UI                 *UI
	Secrets            *Secrets
	// OpenRootfs opens the target root after its file system is mounted.
	OpenRootfs func() (Rootfs, error)
	Fixups     baremetal.FixupContext
	Verifier   Verifier
	// ZeroRepoSecrets zeroes the repository password after the release.
	ZeroRepoSecrets func()
	// Fallback sets up \EFI\BOOT\BOOTX64.EFI (operator's choice, default on).
	Fallback bool
	// KeepKeyFiles keeps the old key files (operator's choice).
	KeepKeyFiles bool
	Log          func(string)
	Now          func() time.Time
	// TargetDevices are the target disks of the mapping (their device
	// paths); isolated steps see these and what sits on them.
	TargetDevices []string
	// ResumeCheck is called once, before the first restore step of a
	// resumed plan, with the mounted root: it checks the marker and may
	// return the plan to continue with (the unclean one after a power
	// loss).
	ResumeCheck func(r Rootfs) (*baremetal.RestorePlan, error)

	askCancel atomic.Bool

	cancelled atomic.Bool

	rootfs      Rootfs
	report      ExecReport
	opened      []string
	created     []string
	markerOn    bool
	released    bool
	resumeOff   map[string]int64
	stepTimeout func(kind string) time.Duration
}

// ExecReport is what the execution produced.
type ExecReport struct {
	StartedAt         time.Time
	Completed         int64
	FailedStep        int64
	FailedKind        string
	FailedError       string
	Problem           string
	CleanStop         bool
	Cancelled         bool
	RestoreErrors     int64
	SystemErrors      int64
	Warnings          []api.RecoveryWarning
	Hints             []api.RecoveryHint
	Fixups            []api.RecoveryFixupChange
	NotAdaptedKernels []string
	RebuiltKernels    []string
	BootEntries       []int
	MokPassword       string
	Checks            []*Check
}

// ErrCancelled ends a run that the operator or the web cancelled.
var ErrCancelled = errors.New("the recovery was cancelled")

// StepError is a failed step.
type StepError struct {
	N       int64
	Kind    string
	Problem string
	Err     error
}

func (e *StepError) Error() string {
	return fmt.Sprintf("step %d (%s): %v", e.N, e.Kind, e.Err)
}

func (e *StepError) Unwrap() error { return e.Err }

func (x *Executor) now() time.Time {
	if x.Now != nil {
		return x.Now()
	}
	return time.Now()
}

func (x *Executor) log(format string, args ...any) {
	if x.Log != nil {
		x.Log(redact.Redact(fmt.Sprintf(format, args...)))
	}
}

func (x *Executor) warn(code, message string) {
	for _, w := range x.report.Warnings {
		if w.Code == code && w.Message == message {
			return
		}
	}
	x.report.Warnings = append(x.report.Warnings, api.RecoveryWarning{Code: code, Message: message})
}

func (x *Executor) hint(code string, params map[string]string) {
	if params == nil {
		params = map[string]string{}
	}
	x.report.Hints = append(x.report.Hints, api.RecoveryHint{Code: code, Params: params})
}

// Phase of the recovery API for a plan phase.
func apiPhase(phase, kind string) string {
	switch {
	case kind == "verify":
		return api.RecoveryPhaseVerifying
	case phase == "restore":
		return api.RecoveryPhaseRestoring
	case phase == "post":
		return api.RecoveryPhaseConfiguring
	}
	return api.RecoveryPhasePartitioning
}

// Run executes the plan. A failing step stops the run (StepError); a
// cancellation stops it cleanly (ErrCancelled, CleanStop set).
func (x *Executor) Run(ctx context.Context) (*ExecReport, error) {
	if x.Plan == nil || !x.Plan.OK {
		return nil, errors.New("the plan has problems; nothing is executed")
	}
	x.report = ExecReport{StartedAt: x.now(), Warnings: []api.RecoveryWarning{}, Hints: []api.RecoveryHint{}, Fixups: []api.RecoveryFixupChange{}}
	x.resumeOff = map[string]int64{}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := x.watch(rctx, cancel)
	defer stop()
	total := len(x.Plan.Steps)
	lastSecret := lastSecretStep(x.Plan)
	resumeChecked := false
	for i := 0; i < len(x.Plan.Steps); i++ {
		s := x.Plan.Steps[i]
		if rctx.Err() != nil {
			return x.stopCleanly(ctx)
		}
		// A resumed plan has opened and mounted what the first run made;
		// the marker on the root now says how that run ended (10.18).
		if s.Phase == "restore" && x.ResumeCheck != nil && !resumeChecked {
			resumeChecked = true
			next, err := x.ResumeCheck(x.rootfs)
			if err != nil {
				x.report.Problem = ProblemStepFailed
				return &x.report, &StepError{N: s.N, Kind: s.Kind, Problem: ProblemStepFailed, Err: err}
			}
			if next != nil && next != x.Plan {
				x.Plan = next
				total, lastSecret = len(next.Steps), lastSecretStep(next)
				for j, ns := range next.Steps {
					if ns.Phase == "restore" {
						i = j
						break
					}
				}
				s = x.Plan.Steps[i]
			}
		}
		// Before the post phase: the restore is over, read access ends and
		// the repository secrets are cleared (10.13 points 1 and 2).
		if s.Phase == "post" && !x.released {
			x.release(ctx)
		}
		// Before the first program of the target: no passphrase is left.
		if len(s.Args) > 0 && s.Args[0] == "chroot-exec" && !x.Secrets.Zeroed() {
			if i < lastSecret {
				return &x.report, &StepError{N: s.N, Kind: s.Kind, Problem: ProblemStepFailed,
					Err: errors.New("a step that needs a passphrase comes after a program of the target")}
			}
			x.Secrets.Zero()
		}
		if x.UI != nil {
			x.UI.Say("exec.step", "n", s.N, "total", total, "reason", s.Reason)
		}
		x.progress(ctx, apiPhase(s.Phase, s.Kind), int(s.N), total, 0, 0, 0, 0, s.Reason)
		err := x.step(rctx, &s)
		if err != nil && rctx.Err() != nil && ctx.Err() == nil && x.cancelled.Load() {
			return x.stopCleanly(ctx)
		}
		if err != nil {
			se := &StepError{N: s.N, Kind: s.Kind, Problem: ProblemStepFailed, Err: err}
			var pe *problemError
			if errors.As(err, &pe) {
				se.Problem = pe.code
			}
			x.report.FailedStep, x.report.FailedKind, x.report.FailedError, x.report.Problem = s.N, s.Kind, redact.Redact(err.Error()), se.Problem
			x.log("step %d (%s) failed: %v", s.N, s.Kind, err)
			if se.Problem == ProblemAccessExpired {
				_, _ = x.stopCleanly(ctx)
			} else {
				x.updateMarker(s, false)
			}
			return &x.report, se
		}
		x.report.Completed = s.N
		x.updateMarker(s, false)
	}
	if !x.released {
		x.release(ctx)
	}
	x.Secrets.Zero()
	if x.rootfs != nil {
		if err := RemoveMarker(x.rootfs); err != nil {
			x.log("remove the marker: %v", err)
		}
	}
	return &x.report, nil
}

func lastSecretStep(p *baremetal.RestorePlan) int {
	last := -1
	for i, s := range p.Steps {
		if s.StdinSecret != nil || (len(s.Args) > 0 && (s.Args[0] == "keyfile" || s.Args[0] == "mok-import")) {
			last = i
		}
	}
	return last
}

// problemError carries a recover code.
type problemError struct {
	code string
	err  error
}

func (p *problemError) Error() string { return p.err.Error() }
func (p *problemError) Unwrap() error { return p.err }

func stepProblem(code string, format string, args ...any) error {
	return &problemError{code: code, err: fmt.Errorf(format, args...)}
}

// watch polls cancelRequested every 5 seconds and reads "a" from the
// console (with a question first); either cancels the run.
func (x *Executor) watch(ctx context.Context, cancel context.CancelFunc) func() {
	wctx, stop := context.WithCancel(ctx)
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-wctx.Done():
				return
			case <-t.C:
				if x.Session == nil {
					continue
				}
				st, err := x.Session.Current(wctx)
				if err == nil && st.CancelRequested {
					x.log("the recovery was cancelled in the web interface")
					x.cancelled.Store(true)
					cancel()
					return
				}
			}
		}
	}()
	if x.UI != nil {
		go func() {
			for {
				line, ok := x.UI.TryLine(wctx)
				if !ok {
					return
				}
				ans := line
				if !x.askCancel.Swap(false) {
					if strings.TrimSpace(line) != "a" {
						continue
					}
					x.UI.Say("exec.cancel_confirm")
					if ans, ok = x.UI.TryLine(wctx); !ok {
						return
					}
				}
				if a := strings.ToLower(strings.TrimSpace(ans)); a == "y" || a == "j" || a == "yes" || a == "ja" {
					x.cancelled.Store(true)
					cancel()
					return
				}
			}
		}()
	}
	return stop
}

// PromptCancel asks whether to cancel (Ctrl+C on the console); the next
// line answers it.
func (x *Executor) PromptCancel() {
	if x.UI == nil {
		return
	}
	x.askCancel.Store(true)
	x.UI.Say("exec.cancel_confirm")
}

// stopCleanly ends a cancelled run: the marker says "clean stop",
// everything below the target is unmounted and the LUKS volumes are
// closed; arrays keep running (a resync does no harm).
func (x *Executor) stopCleanly(ctx context.Context) (*ExecReport, error) {
	ctx = context.WithoutCancel(ctx)
	x.report.CleanStop, x.report.Cancelled = true, x.cancelled.Load()
	if x.rootfs != nil {
		x.writeMarker(x.report.Completed, "stopped", true)
	}
	if x.Ops != nil {
		if err := x.Ops.UnmountAll(ctx, x.TargetRoot); err != nil {
			x.log("unmount: %v", err)
		}
	}
	for i := len(x.opened) - 1; i >= 0; i-- {
		if _, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"cryptsetup", "close", x.opened[i]}, NoKill: true, Timeout: 2 * time.Minute}); err != nil {
			x.log("close %s: %v", x.opened[i], err)
		}
	}
	if x.UI != nil {
		x.UI.Say("exec.cancelled")
	}
	if x.cancelled.Load() {
		x.warn(WarnCancelRequested, "stopped cleanly; the target disks are incomplete")
	}
	return &x.report, ErrCancelled
}

func (x *Executor) release(ctx context.Context) {
	x.released = true
	if x.Session != nil {
		if _, err := x.Session.Release(ctx); err != nil {
			x.log("release: %v", err)
		}
	}
	if x.ZeroRepoSecrets != nil {
		x.ZeroRepoSecrets()
	}
}

func (x *Executor) progress(ctx context.Context, phase string, step, total int, bytesDone, totalBytes, files, totalFiles int64, msg string) {
	if x.Session == nil {
		return
	}
	_ = x.Session.Progress(ctx, api.RecoveryProgress{Phase: phase, Step: step, StepsTotal: total, BytesDone: bytesDone,
		TotalBytes: totalBytes, FilesDone: files, TotalFiles: totalFiles, Message: msg})
}

func (x *Executor) writeMarker(last int64, phase string, clean bool) {
	if x.rootfs == nil {
		return
	}
	sha := x.PlanSHA256
	if x.OriginalPlanSHA256 != "" {
		sha = x.OriginalPlanSHA256
	}
	m := Marker{SnapshotID: x.Snapshot, LayoutSHA256: x.LayoutSHA256, PlanSHA256: sha, StartedAt: x.report.StartedAt.UTC(),
		UpdatedAt: x.now().UTC(), LastStep: last, Phase: phase, CleanStop: clean}
	if err := WriteMarker(x.rootfs, m); err != nil {
		x.log("marker: %v", err)
	}
}

func (x *Executor) updateMarker(s baremetal.Step, clean bool) {
	if x.markerOn {
		x.writeMarker(s.N, s.Phase, clean)
	}
}

// subst fills the tokens of the plan.
func (x *Executor) subst(a string) string {
	a = strings.ReplaceAll(a, "{snapshot}", x.Snapshot)
	a = strings.ReplaceAll(a, "{target_root}", x.TargetRoot)
	if strings.Contains(a, "{kernelopts}") {
		a = strings.ReplaceAll(a, "{kernelopts}", x.kernelopts())
	}
	return a
}

// rel is a path of the target for an argument below {target_root}.
func (x *Executor) rel(a string) (string, error) {
	if a == x.TargetRoot {
		return "/", nil
	}
	if p, ok := strings.CutPrefix(a, x.TargetRoot+"/"); ok && !strings.Contains(p, "..") {
		return "/" + p, nil
	}
	return "", fmt.Errorf("%q is not below the target root", a)
}

func stepTimeout(kind string) time.Duration {
	switch kind {
	case "restore", "restore_verify":
		return 0
	}
	return DefaultStepTimeout
}

func (x *Executor) step(ctx context.Context, s *baremetal.Step) error {
	if len(s.Args) == 0 {
		return errors.New("empty step")
	}
	args := make([]string, len(s.Args))
	for i, a := range s.Args {
		args[i] = x.subst(a)
	}
	switch args[0] {
	case "restic":
		return x.restore(ctx, s, args[1:])
	case "chroot-exec":
		return x.isolated(ctx, s, args[1:])
	case "release-holders":
		return x.Ops.ReleaseHolders(ctx, args[1])
	case "blkzero":
		head, tail, dev, err := blkzeroArgs(args[1:])
		if err != nil {
			return err
		}
		return x.Ops.BlkZero(ctx, dev, head, tail)
	case "pmbr-boot":
		return x.Ops.PMBRBoot(ctx, args[1])
	case "fixup":
		return x.fixup(args[1], args[2:])
	case "mkdirs":
		return x.mkdirs(args[1:])
	case "swapfile":
		return x.swapfile(ctx, args[1:])
	case "keyfile":
		return x.keyfile(ctx, args[1:])
	case "nvram":
		return x.nvram(ctx, args[1:])
	case "fallback-path":
		return x.fallbackPath(args[1:])
	case "mok-import":
		return x.mokImport(ctx, args[1:])
	case "selinux":
		return x.selinux(ctx)
	case "verify":
		if x.Verifier != nil {
			x.report.Checks = x.Verifier.Verify(ctx, x)
		}
		return nil
	}
	return x.program(ctx, s, args)
}

// program runs a program of the ISO (mkfs, sfdisk, mdadm, cryptsetup,
// lvm, mount, wipefs, btrfs, chattr) with the plan's stdin or a secret.
func (x *Executor) program(ctx context.Context, s *baremetal.Step, args []string) error {
	if !KnownTool(args[0]) {
		return fmt.Errorf("%s is not a tool of the recovery ISO", args[0])
	}
	spec := RunSpec{Argv: args, NoKill: true, Timeout: stepTimeout(s.Kind)}
	if s.Stdin != nil {
		spec.Stdin = []byte(*s.Stdin)
	}
	if s.StdinSecret != nil {
		dev := ""
		if s.Target != nil {
			dev = *s.Target
		}
		b, err := x.Secrets.get(*s.StdinSecret, dev)
		if err != nil {
			return err
		}
		spec.Stdin, spec.StdinSecret = b, true
	}
	resuming := x.isResume()
	switch s.Kind {
	case "mount":
		target := args[len(args)-1]
		if resuming && x.Ops.Mounted(target) {
			x.log("%s is mounted already", target)
			if target == x.TargetRoot && x.rootfs == nil {
				return x.rootMounted()
			}
			return nil
		}
		if err := x.mountPoint(target); err != nil {
			return err
		}
	case "nocow":
		r, err := x.rel(args[len(args)-1])
		if err != nil {
			return err
		}
		if err := x.mkdirInTarget(r, 0o755); err != nil {
			return err
		}
	case "md_assemble", "vg_activate":
		if s.Kind == "md_assemble" && resuming && s.Target != nil && x.Ops.Exists(*s.Target) {
			x.log("%s is assembled already", *s.Target)
			return nil
		}
	case "luks_open":
		// An open mapping of the same name is used only when it sits on
		// exactly the partition of the plan: a volume of a disk outside the
		// confirmed set (the old disk, opened from the shell) under that
		// name would otherwise get the new LVM, file systems and restore.
		name, src := args[len(args)-1], args[len(args)-2]
		if x.Ops.Exists("/dev/mapper/" + name) {
			on, backing := x.Ops.MappingOn(name, src)
			if !on {
				if backing == "" {
					backing = "an unknown device"
				}
				return fmt.Errorf("/dev/mapper/%s is open already on %s, not on %s of the plan; close it (cryptsetup close %s) and start again", name, backing, src, name)
			}
			x.log("%s is open already on %s", name, src)
			x.opened = append(x.opened, name)
			return nil
		}
	}
	_, err := x.Exec.Run(ctx, spec)
	if err != nil && s.Kind == "btrfs_quota" && hasArg(args, "rescan") {
		x.warn(WarnQuotaRescanFailed, redact.Redact(err.Error()))
		return nil
	}
	if err != nil {
		return err
	}
	switch s.Kind {
	case "luks_open":
		x.opened = append(x.opened, args[len(args)-1])
	case "partition":
		return x.readbackPartition(ctx, s)
	case "mkfs", "mkswap":
		return x.readbackMkfs(ctx, args)
	case "mount":
		if args[len(args)-1] == x.TargetRoot {
			return x.rootMounted()
		}
	}
	return nil
}

func hasArg(args []string, a string) bool {
	for _, v := range args {
		if v == a {
			return true
		}
	}
	return false
}

func (x *Executor) isResume() bool {
	for _, s := range x.Plan.Steps {
		if s.Kind == "restore" {
			for i, a := range s.Args {
				if a == "--overwrite" && i+1 < len(s.Args) && s.Args[i+1] != "never" {
					return true
				}
			}
		}
	}
	return false
}

// mountPoint makes sure the folder a file system is mounted on exists and
// is a real folder: the root on the ISO, everything else inside the
// target (a link there, after a resume with restored content, is refused:
// it could lead the mount out of the target).
func (x *Executor) mountPoint(target string) error {
	if target == x.TargetRoot || !strings.HasPrefix(target, x.TargetRoot+"/") {
		return x.Ops.MkdirHost(target)
	}
	if strings.HasPrefix(target, x.TargetRoot+"/.restow-btrfs-") && x.rootfs == nil {
		return x.Ops.MkdirHost(target)
	}
	r, err := x.rel(target)
	if err != nil {
		return err
	}
	return x.mkdirInTarget(r, 0o755)
}

func (x *Executor) mkdirInTarget(p string, mode fs.FileMode) error {
	if x.rootfs == nil {
		return fmt.Errorf("%s: the root file system of the target is not mounted", p)
	}
	cur := ""
	for _, part := range strings.Split(strings.Trim(p, "/"), "/") {
		cur += "/" + part
		st, err := x.rootfs.Lstat(cur)
		switch {
		case err == nil && st.Mode()&fs.ModeSymlink != 0:
			return fmt.Errorf("%s is a link in the target; nothing is mounted through it", cur)
		case err == nil && !st.IsDir():
			return fmt.Errorf("%s is not a folder", cur)
		case err == nil:
			continue
		}
		if err := x.rootfs.MkdirAll(cur, mode); err != nil {
			return err
		}
		x.created = append(x.created, cur)
	}
	return nil
}

// rootMounted opens the target root and writes the first marker.
func (x *Executor) rootMounted() error {
	if x.OpenRootfs == nil {
		return nil
	}
	r, err := x.OpenRootfs()
	if err != nil {
		return err
	}
	x.rootfs = r
	x.markerOn = true
	x.writeMarker(x.report.Completed, "mount", false)
	return nil
}

// Rootfs is the opened target root (nil before the root is mounted).
func (x *Executor) Rootfs() Rootfs { return x.rootfs }

// Report is the report so far.
func (x *Executor) Report() *ExecReport { return &x.report }

func blkzeroArgs(a []string) (head, tail int64, dev string, err error) {
	for _, s := range a {
		switch {
		case strings.HasPrefix(s, "--head="):
			head, err = strconv.ParseInt(strings.TrimPrefix(s, "--head="), 10, 64)
		case strings.HasPrefix(s, "--tail="):
			tail, err = strconv.ParseInt(strings.TrimPrefix(s, "--tail="), 10, 64)
		case strings.HasPrefix(s, "/dev/"):
			dev = s
		default:
			err = fmt.Errorf("blkzero: unknown argument %q", s)
		}
		if err != nil {
			return 0, 0, "", err
		}
	}
	if dev == "" || head < 0 || tail < 0 {
		return 0, 0, "", errors.New("blkzero: no device")
	}
	return head, tail, dev, nil
}

// readbackPartition waits for the PARTUUID links and compares the table
// sfdisk reports with the plan (10.10 point 3).
func (x *Executor) readbackPartition(ctx context.Context, s *baremetal.Step) error {
	dev := deref(s.Target)
	want := parseSfdiskScript(deref(s.Stdin))
	var uuids []string
	for _, p := range want.parts {
		if p.uuid != "" {
			uuids = append(uuids, p.uuid)
		}
	}
	sort.Strings(uuids)
	if _, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"udevadm", "settle", "--timeout=30"}, Timeout: time.Minute}); err != nil {
		x.log("udevadm settle: %v", err)
	}
	if want.label == "gpt" && len(uuids) > 0 {
		if err := x.Ops.WaitPartUUIDs(ctx, uuids, 30*time.Second); err != nil {
			return stepProblem(ProblemPartitionReadbackMismatch, "%s: %v", dev, err)
		}
	}
	out, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"sfdisk", "--dump", dev}, Timeout: time.Minute})
	if err != nil {
		return stepProblem(ProblemPartitionReadbackMismatch, "%s: sfdisk --dump: %v", dev, err)
	}
	got := parseSfdiskScript(string(out.Output))
	if d := compareTables(want, got); d != "" {
		return stepProblem(ProblemPartitionReadbackMismatch, "%s: %s", dev, d)
	}
	return nil
}

type sfdiskTable struct {
	label   string
	labelID string
	parts   map[string]sfdiskPart
}

type sfdiskPart struct {
	start, size, typ, uuid string
}

// parseSfdiskScript reads the sfdisk dump format (the plan's script and
// sfdisk --dump): label, label-id and one line per partition.
func parseSfdiskScript(s string) sfdiskTable {
	t := sfdiskTable{parts: map[string]sfdiskPart{}}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "label:"):
			t.label = strings.TrimSpace(strings.TrimPrefix(line, "label:"))
		case strings.HasPrefix(line, "label-id:"):
			t.labelID = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(line, "label-id:")))
		case strings.HasPrefix(line, "/dev/"):
			dev, fields, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			var p sfdiskPart
			for _, f := range strings.Split(fields, ",") {
				k, v, _ := strings.Cut(strings.TrimSpace(f), "=")
				v = strings.ToLower(strings.Trim(strings.TrimSpace(v), `"`))
				switch strings.TrimSpace(k) {
				case "start":
					p.start = v
				case "size":
					p.size = v
				case "type":
					p.typ = strings.TrimPrefix(v, "0x")
				case "uuid":
					p.uuid = v
				}
			}
			t.parts[strings.TrimSpace(dev)] = p
		}
	}
	return t
}

func compareTables(want, got sfdiskTable) string {
	if want.label != got.label {
		return fmt.Sprintf("label %q, want %q", got.label, want.label)
	}
	if want.labelID != "" && strings.TrimPrefix(want.labelID, "0x") != strings.TrimPrefix(got.labelID, "0x") {
		return fmt.Sprintf("label-id %s, want %s", got.labelID, want.labelID)
	}
	names := make([]string, 0, len(want.parts))
	for n := range want.parts {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		w := want.parts[n]
		g, ok := got.parts[n]
		if !ok {
			return n + " is missing"
		}
		if w.start != g.start || w.size != g.size || (w.uuid != "" && w.uuid != g.uuid) || (w.typ != "" && w.typ != g.typ) {
			return fmt.Sprintf("%s is start=%s size=%s type=%s uuid=%s, want start=%s size=%s type=%s uuid=%s", n, g.start, g.size, g.typ, g.uuid, w.start, w.size, w.typ, w.uuid)
		}
	}
	return ""
}

// readbackMkfs compares UUID, type and label (blkid -p) and, for ext, the
// feature list (dumpe2fs -h) with what was asked for (10.11).
func (x *Executor) readbackMkfs(ctx context.Context, args []string) error {
	want := mkfsExpect(args)
	if want.dev == "" {
		return nil
	}
	out, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"blkid", "-p", "-o", "export", want.dev}, Timeout: time.Minute})
	if err != nil {
		return stepProblem(ProblemMkfsReadbackMismatch, "%s: blkid: %v", want.dev, err)
	}
	kv := parseExport(string(out.Output))
	if want.uuid != "" && !strings.EqualFold(normFSUUID(kv["UUID"]), normFSUUID(want.uuid)) {
		return stepProblem(ProblemMkfsReadbackMismatch, "%s: UUID %s, want %s", want.dev, kv["UUID"], want.uuid)
	}
	if want.typ != "" && kv["TYPE"] != want.typ {
		return stepProblem(ProblemMkfsReadbackMismatch, "%s: type %s, want %s", want.dev, kv["TYPE"], want.typ)
	}
	if want.label != "" && kv["LABEL"] != want.label {
		return stepProblem(ProblemMkfsReadbackMismatch, "%s: label %q, want %q", want.dev, kv["LABEL"], want.label)
	}
	if len(want.features) > 0 {
		out, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"dumpe2fs", "-h", want.dev}, Timeout: time.Minute})
		if err != nil {
			return stepProblem(ProblemMkfsReadbackMismatch, "%s: dumpe2fs: %v", want.dev, err)
		}
		have := extFeatures(string(out.Output))
		for _, f := range want.features {
			if !have[f] {
				return stepProblem(ProblemMkfsReadbackMismatch, "%s: feature %s missing", want.dev, f)
			}
		}
		asked := map[string]bool{}
		for _, f := range want.features {
			asked[f] = true
		}
		// The features newer mkfs versions turn on by default, which older
		// kernels and GRUB cannot read (10.11), must not appear unasked.
		for _, f := range []string{"metadata_csum_seed", "orphan_file", "metadata_csum", "64bit", "inline_data", "encrypt", "casefold", "stable_inodes", "verity"} {
			if have[f] && !asked[f] {
				return stepProblem(ProblemMkfsReadbackMismatch, "%s: feature %s was not asked for", want.dev, f)
			}
		}
	}
	return nil
}

type mkfsWant struct {
	dev, uuid, typ, label string
	features              []string
}

// mkfsExpect reads the identity a mkfs call asks for from its arguments.
func mkfsExpect(args []string) mkfsWant {
	var w mkfsWant
	if len(args) < 2 {
		return w
	}
	w.dev = args[len(args)-1]
	if !strings.HasPrefix(w.dev, "/dev/") {
		w.dev = ""
	}
	get := func(flag string) string {
		for i := 1; i+1 < len(args); i++ {
			if args[i] == flag {
				return args[i+1]
			}
		}
		return ""
	}
	switch args[0] {
	case "mkfs.ext4":
		w.typ = "ext4"
		if t := get("-t"); t != "" {
			w.typ = t
		}
		w.uuid, w.label = get("-U"), get("-L")
		if o := get("-O"); o != "" {
			for _, f := range strings.Split(o, ",") {
				if f != "" && f != "none" && !strings.HasPrefix(f, "^") {
					w.features = append(w.features, f)
				}
			}
		}
	case "mkfs.xfs":
		w.typ, w.label = "xfs", get("-L")
		for _, kv := range strings.Split(get("-m"), ",") {
			if u, ok := strings.CutPrefix(kv, "uuid="); ok {
				w.uuid = u
			}
		}
	case "mkfs.btrfs":
		w.typ, w.uuid, w.label = "btrfs", get("-U"), get("-L")
		// The first device is checked; mkfs.btrfs takes several.
		for i := 1; i < len(args); i++ {
			if strings.HasPrefix(args[i], "/dev/") && !strings.HasPrefix(args[i-1], "-") {
				w.dev = args[i]
				break
			}
		}
	case "mkfs.vfat":
		w.typ, w.label = "vfat", get("-n")
		if id := get("-i"); len(id) == 8 {
			w.uuid = strings.ToUpper(id[:4] + "-" + id[4:])
		}
	case "mkswap":
		w.typ, w.uuid, w.label = "swap", get("-U"), get("-L")
	}
	return w
}

func normFSUUID(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// parseExport reads KEY=value lines (blkid -o export).
func parseExport(s string) map[string]string {
	out := map[string]string{}
	for _, l := range strings.Split(s, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(l), "="); ok {
			out[k] = v
		}
	}
	return out
}

func extFeatures(dump string) map[string]bool {
	out := map[string]bool{}
	for _, l := range strings.Split(dump, "\n") {
		if v, ok := strings.CutPrefix(l, "Filesystem features:"); ok {
			for _, f := range strings.Fields(v) {
				out[f] = true
			}
		}
	}
	return out
}

// restore runs a restore step; files that could not be restored below the
// system paths stop the run before the fixups (10.12), other ones are a
// warning with a list.
func (x *Executor) restore(ctx context.Context, s *baremetal.Step, args []string) error {
	if x.Restic == nil {
		return errors.New("no restic")
	}
	if x.rootfs == nil && s.Kind == "restore" {
		return errors.New("the root file system of the target is not mounted")
	}
	last := time.Time{}
	out, err := x.Restic.Restore(ctx, args, func(p restic.Progress) {
		if x.UI != nil {
			x.UI.Progress(x.UI.Text("exec.restore", "files", p.FilesDone, "totalFiles", p.TotalFiles, "bytes", FormatBytes(int64(p.BytesDone)), "totalBytes", FormatBytes(int64(p.TotalBytes))))
		}
		if now := x.now(); now.Sub(last) >= 5*time.Second {
			last = now
			x.progress(ctx, api.RecoveryPhaseRestoring, int(s.N), len(x.Plan.Steps), int64(p.BytesDone), int64(p.TotalBytes), int64(p.FilesDone), int64(p.TotalFiles), s.Reason)
		}
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return stepProblem(ProblemRestoreFailed, "%v", err)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if strings.Contains(out.FatalError, "401") || strings.Contains(out.FatalError, "403 Forbidden") || strings.Contains(strings.ToLower(out.FatalError), "unauthorized") {
		return stepProblem(ProblemAccessExpired, "%s", out.FatalError)
	}
	if out.FatalError != "" && strings.Contains(out.FatalError, "x509:") {
		return stepProblem(ProblemTLSUntrusted, "%s", out.FatalError)
	}
	if out.ExitCode != 0 && out.ItemCount == 0 {
		return stepProblem(ProblemRestoreFailed, "%s", out.FatalError)
	}
	if s.Kind == "restore" {
		x.report.RestoreErrors += int64(out.ItemCount)
	}
	var sys []string
	for _, it := range out.Items {
		if underSystemPath(it.Path, x.espRoots()) {
			sys = append(sys, it.Path)
		}
	}
	// Items beyond the first hundred are counted, not listed: treat them
	// as system files when any listed one was.
	if len(sys) > 0 {
		x.report.SystemErrors += int64(len(sys))
		return stepProblem(ProblemSystemFilesIncomplete, "%d files below the system paths could not be restored, first: %s", len(sys), sys[0])
	}
	if out.ItemCount > 0 {
		first := ""
		if len(out.Items) > 0 {
			first = out.Items[0].Path
		}
		x.warn(WarnRestoreFileErrors, fmt.Sprintf("%d files could not be restored, first: %s", out.ItemCount, first))
	}
	return nil
}

func (x *Executor) espRoots() []string {
	var out []string
	if x.Manifest == nil || x.Manifest.Linux == nil {
		return out
	}
	l := x.Manifest.Linux
	for _, id := range l.Bootloader.ESPs {
		for _, m := range l.Mounts {
			if m.FS != nil && *m.FS == id {
				out = append(out, m.Target)
			}
		}
	}
	return out
}

// underSystemPath reports a path below /boot, /usr, /etc, /lib*, /bin,
// /sbin or an ESP.
func underSystemPath(p string, esps []string) bool {
	p = path.Clean("/" + p)
	top := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 2)[0]
	switch {
	case top == "boot", top == "usr", top == "etc", top == "bin", top == "sbin", strings.HasPrefix(top, "lib"):
		return true
	}
	for _, e := range esps {
		if e != "/" && (p == e || strings.HasPrefix(p, strings.TrimSuffix(e, "/")+"/")) {
			return true
		}
	}
	return false
}

// isolated runs a program of the target through chroot-exec.
func (x *Executor) isolated(ctx context.Context, s *baremetal.Step, argv []string) error {
	if x.Isolator == nil {
		return errors.New("no isolation helper")
	}
	if len(argv) == 0 {
		return errors.New("chroot-exec without a program")
	}
	prog := argv[0]
	spec := IsolateSpec{Root: x.TargetRoot, Argv: argv, TimeoutSeconds: int(stepTimeout(s.Kind) / time.Second)}
	if strings.Contains(prog, "grub") && strings.HasSuffix(prog, "mkconfig") {
		spec.Env = append(spec.Env, "GRUB_DISABLE_OS_PROBER=true")
	}
	disks, extra := x.isolatedDevices(s.Kind)
	spec.Devices, spec.DevLinks = x.Ops.DeviceSet(disks, extra)
	spec.CapSysAdmin = needsSysAdmin(prog, spec.Devices)
	switch s.Kind {
	case "initramfs_extra":
		ok, why := x.bootRoomFor(deref(s.Target))
		if !ok {
			x.report.NotAdaptedKernels = append(x.report.NotAdaptedKernels, deref(s.Target))
			x.warn(WarnInitramfsNotRebuilt, fmt.Sprintf("%s: %s", deref(s.Target), why))
			x.hint(HintInitramfsNotAdapted, map[string]string{"kernel": deref(s.Target)})
			return nil
		}
	case "bootctl_install":
		esp := strings.TrimPrefix(argv[1], "--esp-path=")
		if x.rootfs != nil {
			if _, err := x.rootfs.Lstat(path.Join(esp, "EFI/systemd/systemd-bootx64.efi")); err == nil {
				x.log("systemd-boot is on %s already; bootctl install is not needed", esp)
				return nil
			}
		}
	}
	if prog == "update-initramfs" && x.rootfs != nil {
		// MODULES=most for this run only: an initramfs with MODULES=dep of
		// the old controller does not start on new hardware (10.15).
		const conf = "/etc/initramfs-tools/conf.d/zz-restow-recovery"
		if err := x.rootfs.MkdirAll(path.Dir(conf), 0o755); err == nil {
			if err := x.rootfs.WriteFileAtomic(conf, []byte("# written by restow-agent recover for the rebuild after the recovery\nMODULES=most\n"), 0o644, 0, 0, ""); err != nil {
				return err
			}
			defer func() {
				if err := x.rootfs.Remove(conf); err != nil {
					x.log("remove %s: %v", conf, err)
				}
			}()
		}
	}
	x.log("$ chroot-exec %s", strings.Join(argv, " "))
	res, err := x.Isolator.Run(ctx, spec)
	if res != nil {
		for i, l := range strings.Split(strings.TrimRight(string(res.Output), "\n"), "\n") {
			if i >= 400 {
				x.log("  ... (output cut)")
				break
			}
			if l != "" {
				x.log("  %s", l)
			}
		}
	}
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("%s exited with code %d", prog, res.ExitCode)
	}
	switch s.Kind {
	case "initramfs", "initramfs_extra", "uki":
		x.report.RebuiltKernels = append(x.report.RebuiltKernels, deref(s.Target))
	}
	return nil
}

// needsSysAdmin: the device-mapper ioctls of grub-probe (grub-install,
// grub-mkconfig) and of vgimportdevices need CAP_SYS_ADMIN, but only when
// a device-mapper node (LVM, LUKS) is among the devices of the step; on a
// plain system they run without it and without /dev/mapper/control. The
// seccomp filter still lets only read-only device-mapper commands through
// (10.14).
func needsSysAdmin(prog string, devices []string) bool {
	switch prog {
	case "grub-install", "grub2-install", "grub-mkconfig", "grub2-mkconfig", "update-grub", "vgimportdevices":
	default:
		return false
	}
	for _, d := range devices {
		if strings.HasPrefix(d, "/dev/dm-") || (strings.HasPrefix(d, "/dev/mapper/") && d != "/dev/mapper/control") {
			return true
		}
	}
	return false
}

// isolatedDevices are the devices of an isolated step: the erased target
// disks (with what sits on them) and, for initramfs steps, the dm nodes of
// adopted volumes the crypttab names.
func (x *Executor) isolatedDevices(kind string) (disks, extra []string) {
	disks = append(disks, x.TargetDevices...)
	for _, s := range x.Plan.Steps {
		if s.Kind == "release_holders" && s.Target != nil && !hasArg(disks, *s.Target) {
			disks = append(disks, *s.Target)
		}
		if s.Kind == "luks_open" && len(s.Args) > 0 && strings.HasPrefix(kind, "initramfs") {
			extra = append(extra, "/dev/mapper/"+s.Args[len(s.Args)-1])
		}
	}
	return disks, extra
}

// bootRoomFor: the initramfs of another kernel is rebuilt only when /boot
// has 1.5 times the estimated size of a generic image free (3 times the
// existing image, at least 130 MiB; 10.15).
func (x *Executor) bootRoomFor(kver string) (bool, string) {
	est := int64(130 << 20)
	if x.Manifest != nil && x.Manifest.Linux != nil {
		for _, k := range x.Manifest.Linux.Kernels {
			if k.Version == kver && k.InitramfsBytes != nil && 3**k.InitramfsBytes > est {
				est = 3 * *k.InitramfsBytes
			}
		}
	}
	free, _, err := x.Ops.Statfs(x.TargetRoot + "/boot")
	if err != nil {
		return false, "free space on /boot unknown: " + err.Error()
	}
	if free*2 < est*3 {
		return false, fmt.Sprintf("not enough space on /boot (%s free, %s needed)", FormatBytes(free), FormatBytes(est*3/2))
	}
	return true, ""
}

// kernelopts is the kernel command line for grubenv: the manifest's with
// the fixups applied, without BOOT_IMAGE and initrd.
func (x *Executor) kernelopts() string {
	if x.Manifest == nil || x.Manifest.Linux == nil {
		return ""
	}
	cmd := x.Manifest.Linux.OS.Cmdline
	fixed, _ := baremetal.FixKernelCmdline([]byte("GRUB_CMDLINE_LINUX=\""+cmd+"\"\n"), x.Fixups)
	line := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(string(fixed)), "GRUB_CMDLINE_LINUX=\""), "\"")
	var out []string
	for _, f := range strings.Fields(line) {
		if strings.HasPrefix(f, "BOOT_IMAGE=") || strings.HasPrefix(f, "initrd=") {
			continue
		}
		out = append(out, f)
	}
	return strings.Join(out, " ")
}

// fixup applies the rules of a planned fixup to one file (or to every
// file of a pattern): read through Rootfs, rewrite with baremetal.Fix*,
// keep the old file as <file>.restow-<UTC time>.
func (x *Executor) fixup(p string, rules []string) error {
	if x.rootfs == nil {
		return errors.New("the root file system of the target is not mounted")
	}
	files := []string{p}
	if strings.Contains(path.Base(p), "*") {
		names, err := x.rootfs.ReadDir(path.Dir(p))
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		files = nil
		for _, n := range names {
			if ok, _ := path.Match(path.Base(p), n); ok {
				files = append(files, path.Join(path.Dir(p), n))
			}
		}
		sort.Strings(files)
	}
	for _, f := range files {
		if err := x.fixupFile(f, rules); err != nil {
			return err
		}
	}
	return nil
}

func (x *Executor) backupName(p string) string {
	return path.Base(p) + ".restow-" + x.now().UTC().Format("20060102T150405Z")
}

func (x *Executor) fixupFile(p string, rules []string) error {
	st, err := x.rootfs.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if st.Mode()&fs.ModeSymlink != 0 {
		x.log("%s is a link in the target; the fixup leaves it", p)
		return nil
	}
	for _, r := range rules {
		switch r {
		case "delete":
			if err := x.rootfs.Remove(p); err != nil {
				return err
			}
			x.report.Fixups = append(x.report.Fixups, api.RecoveryFixupChange{Path: p, Rule: r, Backup: ""})
			return nil
		case "set_aside":
			data, err := x.rootfs.ReadFile(p, 16<<20)
			if err != nil {
				return err
			}
			b := path.Join(path.Dir(p), x.backupName(p))
			if err := x.rootfs.WriteFileAtomic(b, data, st.Mode().Perm(), 0, 0, ""); err != nil {
				return err
			}
			if err := x.rootfs.Remove(p); err != nil {
				return err
			}
			x.report.Fixups = append(x.report.Fixups, api.RecoveryFixupChange{Path: p, Rule: r, Backup: b})
			return nil
		}
	}
	data, err := x.rootfs.ReadFile(p, 16<<20)
	if err != nil {
		return err
	}
	out := data
	var changed []string
	for _, r := range rules {
		fn := fixupRule(r)
		if fn == nil {
			x.log("%s: unknown fixup rule %s", p, r)
			continue
		}
		if r == "lvm_filter" && LVMFilterMultiline(out) {
			x.warn(ProblemLVMFilterMultiline, p)
		}
		next, ch := fn(out, x.Fixups)
		if len(ch) > 0 {
			changed = append(changed, r)
		}
		out = next
	}
	if len(changed) == 0 || string(out) == string(data) {
		return nil
	}
	uid, gid := 0, 0
	if o, ok := fileOwner(st); ok {
		uid, gid = o[0], o[1]
	}
	backup := x.backupName(p)
	if err := x.rootfs.WriteFileAtomic(p, out, st.Mode().Perm(), uid, gid, backup); err != nil {
		return err
	}
	x.created = append(x.created, p)
	x.report.Fixups = append(x.report.Fixups, api.RecoveryFixupChange{Path: p, Rule: strings.Join(changed, ","), Backup: path.Join(path.Dir(p), backup)})
	return nil
}

func fixupRule(r string) func([]byte, baremetal.FixupContext) ([]byte, []baremetal.FixupChange) {
	switch r {
	case "fstab":
		return baremetal.FixFstab
	case "crypttab":
		return baremetal.FixCrypttab
	case "mdadm":
		return baremetal.FixMdadmConf
	case "cmdline":
		return baremetal.FixKernelCmdline
	case "resume":
		return baremetal.FixResumeConf
	case "mount_unit":
		return baremetal.FixMountUnit
	case "dracut_add_device":
		return baremetal.FixDracutAddDevice
	case "lvm_filter":
		return baremetal.FixLVMFilter
	case "grub_install_devices":
		return baremetal.FixGrubInstallDevices
	case "proxmox_boot_uuids":
		return baremetal.FixProxmoxBootUUIDs
	case "mac":
		return baremetal.FixMACs
	}
	return nil
}

// mkdirs creates the mount points and API folders that are missing, with
// fixed modes, root:root (10.12).
func (x *Executor) mkdirs(specs []string) error {
	if x.rootfs == nil {
		return errors.New("the root file system of the target is not mounted")
	}
	for _, sp := range specs {
		p, m, ok := strings.Cut(sp, ":")
		if !ok {
			return fmt.Errorf("mkdirs: %q", sp)
		}
		mode, err := strconv.ParseUint(m, 8, 32)
		if err != nil {
			return fmt.Errorf("mkdirs: %q: %v", sp, err)
		}
		if _, err := x.rootfs.Lstat(p); err == nil {
			continue
		}
		fm := fs.FileMode(mode & 0o777)
		if mode&0o1000 != 0 {
			fm |= fs.ModeSticky
		}
		if err := x.rootfs.MkdirAll(p, fm); err != nil {
			return err
		}
		if err := x.rootfs.Chmod(p, fm); err != nil {
			return err
		}
		if err := x.rootfs.Chown(p, 0, 0); err != nil {
			return err
		}
		x.created = append(x.created, p)
	}
	return nil
}

func (x *Executor) swapfile(ctx context.Context, a []string) error {
	if len(a) != 2 {
		return fmt.Errorf("swapfile: %q", a)
	}
	p, err := x.rel(a[0])
	if err != nil {
		return err
	}
	size, err := strconv.ParseInt(a[1], 10, 64)
	if err != nil || size <= 0 {
		return fmt.Errorf("swapfile: size %q", a[1])
	}
	uuid, label := "", ""
	if x.Manifest != nil && x.Manifest.Linux != nil {
		for _, s := range x.Manifest.Linux.Swap {
			if s.Path != nil && *s.Path == p {
				uuid, label = deref(s.UUID), deref(s.Label)
			}
		}
	}
	off, err := x.Ops.Swapfile(ctx, p, size, uuid, label)
	if err != nil {
		return err
	}
	x.created = append(x.created, p)
	if off >= 0 {
		x.resumeOff[p] = off
		x.Fixups.ResumeOffset = &off
	}
	return nil
}

// keyfile creates a new key file in the target (64 random bytes, the old
// file's mode and owner) and adds it as a key slot; the passphrase goes on
// stdin, the key through a private file on tmpfs (10.10 point 5).
func (x *Executor) keyfile(ctx context.Context, a []string) error {
	if len(a) != 2 {
		return fmt.Errorf("keyfile: %q", a)
	}
	p, err := x.rel(a[0])
	if err != nil {
		return err
	}
	dev := a[1]
	if x.KeepKeyFiles {
		x.log("key file %s kept (operator's choice)", p)
		return nil
	}
	mode, uid, gid := fs.FileMode(0o400), 0, 0
	if st, err := x.rootfs.Lstat(p); err == nil && st.Mode().IsRegular() {
		mode = st.Mode().Perm()
		if o, ok := fileOwner(st); ok {
			uid, gid = o[0], o[1]
		}
	}
	key := make([]byte, 64)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	defer zero(key)
	tmp, cleanup, err := x.Ops.TmpFile("keyfile", key)
	if err != nil {
		return err
	}
	defer cleanup()
	pass, err := x.Secrets.get("passphrase", dev)
	if err != nil {
		return err
	}
	if _, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"cryptsetup", "luksAddKey", "--batch-mode", "--key-file", "-", dev, tmp},
		Stdin: pass, StdinSecret: true, NoKill: true, Timeout: 10 * time.Minute}); err != nil {
		return err
	}
	if err := x.rootfs.MkdirAll(path.Dir(p), 0o700); err != nil {
		return err
	}
	if err := x.rootfs.WriteFileAtomic(p, key, mode, uid, gid, ""); err != nil {
		return err
	}
	x.created = append(x.created, p)
	if x.Session != nil {
		if err := x.Session.Event(ctx, api.RecoveryEventKeyfileRegenerated, map[string]string{"path": p, "device": dev}); err != nil {
			x.log("event keyfile_regenerated: %v", err)
		}
	}
	return nil
}

func (x *Executor) nvram(ctx context.Context, a []string) error {
	var req BootEntryRequest
	for i := 0; i+1 < len(a); i += 2 {
		switch a[i] {
		case "--label":
			req.Label = a[i+1]
		case "--partuuid":
			req.PartUUID = a[i+1]
		case "--loader":
			req.Loader = a[i+1]
		}
	}
	if req.Label == "" || req.PartUUID == "" || req.Loader == "" {
		return fmt.Errorf("nvram: %q", a)
	}
	n, err := x.Ops.WriteBootEntry(ctx, req)
	if err != nil {
		return err
	}
	x.report.BootEntries = append(x.report.BootEntries, n)
	return nil
}

// fallbackPath sets up \EFI\BOOT\BOOTX64.EFI on the ESP (10.15): the shim
// fallback chain when fbx64.efi and BOOTX64.CSV are in the vendor folder,
// else a copy of the loader, its neighbours and the grub.cfg stub.
func (x *Executor) fallbackPath(a []string) error {
	if !x.Fallback {
		x.log("fallback boot path left out (operator's choice)")
		return nil
	}
	if len(a) != 1 {
		return fmt.Errorf("fallback-path: %q", a)
	}
	esp, err := x.rel(a[0])
	if err != nil {
		return err
	}
	if x.Manifest == nil || x.Manifest.Linux == nil {
		return nil
	}
	loader := ""
	for _, e := range x.Manifest.Linux.Firmware.Entries {
		if e.Active && e.Loader != nil && !strings.Contains(strings.ToLower(*e.Loader), `\efi\microsoft\`) {
			loader = strings.ReplaceAll(*e.Loader, `\`, "/")
			break
		}
	}
	if loader == "" {
		x.log("no boot entry to copy for the fallback path")
		return nil
	}
	vendor := path.Join(esp, path.Dir(loader))
	boot := path.Join(esp, "EFI/BOOT")
	names, err := x.rootfs.ReadDir(vendor)
	if err != nil {
		return fmt.Errorf("fallback-path: %v", err)
	}
	has := map[string]string{}
	for _, n := range names {
		has[strings.ToLower(n)] = n
	}
	copyFile := func(from, to string) error {
		b, err := x.rootfs.ReadFile(from, 64<<20)
		if err != nil {
			return err
		}
		if err := x.rootfs.MkdirAll(path.Dir(to), 0o755); err != nil {
			return err
		}
		return x.rootfs.WriteFileAtomic(to, b, 0o755, 0, 0, "")
	}
	if shim, ok := has["shimx64.efi"]; ok && has["fbx64.efi"] != "" && has["bootx64.csv"] != "" {
		if err := copyFile(path.Join(vendor, shim), path.Join(boot, "BOOTX64.EFI")); err != nil {
			return err
		}
		return copyFile(path.Join(vendor, has["fbx64.efi"]), path.Join(boot, "fbx64.efi"))
	}
	first := path.Base(loader)
	if shim, ok := has["shimx64.efi"]; ok {
		first = shim
	}
	if err := copyFile(path.Join(vendor, first), path.Join(boot, "BOOTX64.EFI")); err != nil {
		return err
	}
	for _, n := range []string{"grubx64.efi", "mmx64.efi", "grub.cfg"} {
		if real, ok := has[n]; ok {
			if err := copyFile(path.Join(vendor, real), path.Join(boot, real)); err != nil {
				return err
			}
		}
	}
	return nil
}

// mokImport queues a machine owner key for enrolment at the first start
// (10.5) with a one-time password of eight digits that is shown on the
// console only.
func (x *Executor) mokImport(ctx context.Context, a []string) error {
	if len(a) != 1 {
		return fmt.Errorf("mok-import: %q", a)
	}
	p, err := x.rel(a[0])
	if err != nil {
		return err
	}
	der, err := x.rootfs.ReadFile(p, 64<<10)
	if err != nil {
		return err
	}
	keyFile, cleanKey, err := x.Ops.TmpFile("mok.der", der)
	if err != nil {
		return err
	}
	defer cleanKey()
	pw := ""
	for i := 0; i < 8; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return err
		}
		pw += n.String()
	}
	redact.Add(pw)
	out, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"mokutil", "--generate-hash=" + pw}, Timeout: time.Minute})
	if err != nil {
		return err
	}
	hashFile, cleanHash, err := x.Ops.TmpFile("mok.hash", out.Output)
	if err != nil {
		return err
	}
	defer cleanHash()
	if _, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"mokutil", "--import", keyFile, "--hash-file", hashFile}, Timeout: time.Minute, NoKill: true}); err != nil {
		return err
	}
	x.report.MokPassword = pw[:4] + " " + pw[4:]
	if x.UI != nil {
		x.UI.Say("mok.password", "password", x.report.MokPassword)
	}
	x.warn(WarnMokEnrollPending, p)
	x.hint(HintMokEnroll, nil)
	return nil
}

// selinux samples the labels after the restore (10.13): when they are
// there, restorecon -F only for what recover created or changed, else
// /.autorelabel as the fallback.
func (x *Executor) selinux(ctx context.Context) error {
	samples := []string{"/etc", "/usr/bin", "/var"}
	for _, d := range []string{"/etc", "/usr/bin", "/var"} {
		names, err := x.rootfs.ReadDir(d)
		if err != nil {
			continue
		}
		sort.Strings(names)
		for i := 0; i < len(names) && i < 4; i++ {
			samples = append(samples, path.Join(d, names[i]))
		}
	}
	labelled, total := 0, 0
	for _, s := range samples {
		if _, err := x.rootfs.Lstat(s); err != nil {
			continue
		}
		total++
		if v, err := x.rootfs.Getxattr(s, "security.selinux"); err == nil && len(v) > 0 {
			labelled++
		}
	}
	if total > 0 && labelled*10 >= total*9 {
		paths := uniqueStrings(x.created)
		if len(paths) == 0 {
			return nil
		}
		argv := append([]string{"restorecon", "-F"}, paths...)
		step := &baremetal.Step{N: 0, Kind: "selinux_restorecon", Args: append([]string{"chroot-exec"}, argv...)}
		return x.isolated(ctx, step, argv)
	}
	if err := x.rootfs.WriteFileAtomic("/.autorelabel", nil, 0o644, 0, 0, ""); err != nil {
		return err
	}
	x.warn(WarnSELinuxAutorelabel, fmt.Sprintf("%d of %d samples labelled", labelled, total))
	x.hint(HintSELinuxAutorelabel, nil)
	return nil
}

func uniqueStrings(s []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range s {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

// LVMFilterMultiline reports an lvm.conf filter that spans several lines
// and names kernel devices: the fixup cannot rewrite it (recover reports
// lvm_filter_multiline).
func LVMFilterMultiline(conf []byte) bool {
	open := false
	for _, line := range strings.Split(string(conf), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "#") {
			continue
		}
		if !open && (strings.HasPrefix(t, "filter") || strings.HasPrefix(t, "global_filter")) && strings.Contains(t, "[") && !strings.Contains(t, "]") {
			open = true
			continue
		}
		if open {
			if strings.Contains(t, "/dev/sd") || strings.Contains(t, "/dev/nvme") || strings.Contains(t, "/dev/vd") || strings.Contains(t, "/dev/hd") || strings.Contains(t, "/dev/xvd") {
				return true
			}
			if strings.Contains(t, "]") {
				open = false
			}
		}
	}
	return false
}
