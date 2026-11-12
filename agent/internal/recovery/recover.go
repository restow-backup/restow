package recovery

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/update"
)

// The flow of restow-agent recover (docs/BAREMETAL.md 10.2 to 10.20):
// keyboard and language, network, clock and TLS, code, approval,
// credentials, snapshot, manifest, facts, hardware, choices, plan,
// confirmation, execution, check, finish, reconnection, restart. The
// machine is reached through FlowEnv, so the whole flow runs in tests.

// FlowEnv is the machine and the ISO as the flow uses them.
type FlowEnv interface {
	Now() time.Time
	Hardware(ctx context.Context) (HardwareInput, error)
	Interfaces() []NetIface
	ApplyNetwork(ctx context.Context, n AnswersNetwork) error
	WaitNetwork(ctx context.Context, ui *UI, timeout time.Duration) []NetIface
	NoDriverDevices(ctx context.Context) []string
	LoadKeymap(ctx context.Context, layout, variant string) error
	SetClock(t time.Time) error
	ProbeTLS(ctx context.Context, origin, proxy string) (*TLSProbe, error)
	DateHint(ctx context.Context, origin, proxy string) (time.Time, error)
	ReadFile(p string) ([]byte, error)
	// Restic gives the reader and the restorer of the session's
	// repository; zero clears its password.
	Restic(repo string, password []byte, user, pass string, trust TrustConfig) (ResticReader, ResticRestorer, func(), error)
	// Executor fills the machine parts of an executor (Exec, Ops,
	// Isolator, OpenRootfs, TargetRoot) and the verifier for a target.
	Executor(x *Executor, t *baremetal.Target)
	// Guard fills the machine parts of the guard of the confirmed disks
	// (Scan, Hold, ProbeWrite; devguard.go).
	Guard(g *DiskGuard)
	// Finalize prepares the restart (flush, unmount, close).
	Finalize(ctx context.Context, x *Executor)
	Shell(ctx context.Context) error
	Reboot(ctx context.Context) error
	PowerOff(ctx context.Context) error
	EnableRemote(ctx context.Context) (string, []api.RecoverySSHHostKey, error)
	RemoteKeys(ctx context.Context, keys []string) error
}

// Recover is one run of the flow.
type Recover struct {
	UI      *UI
	Env     FlowEnv
	Answers *Answers
	Cmdline CmdlineOptions
	// Version is the ISO's version (restow-agent version --short).
	Version  string
	PlanOnly bool
	// PlanOut receives the plan with --plan-only.
	PlanOut io.Writer
	// Log collects the log lines; they go to the session in batches.
	Log *LogBuffer
	// HTTPClient replaces the client built from the trust mode (tests).
	HTTPClient *http.Client
	// Countdown replaces the 30 seconds of the unattended countdown (tests).
	Countdown time.Duration
	// Poll replaces the 5 seconds of the approval poll (tests).
	Poll time.Duration
	// SysClassNet replaces /sys/class/net, where a probe waits for the lab
	// to take the network away (tests).
	SysClassNet string

	session *Session
	curMu   sync.Mutex
	current *Executor
	// aborted: Ctrl+C came before the execution; no step may start after
	// it (the console said "nothing was erased").
	aborted bool
	// stopCountdown ends the countdown of confirm when Ctrl+C comes.
	stopCountdown context.CancelFunc
	finished      bool
	origin        string
	trust         TrustConfig
	lang          string
	ownLayout     string
	started       time.Time
	remoteOn      bool
	// snap is the snapshot that will be restored, as the operator is shown
	// it before the plan and again before the erase.
	snap snapshotNote
}

// snapshotNote is what the instance says about the chosen snapshot.
type snapshotNote struct {
	ID    string
	Time  time.Time
	Check string
}

// Result is how the flow ended.
type Result struct {
	Status       string
	Verification *api.RecoveryVerification
	Plan         *baremetal.RestorePlan
}

// LogBuffer holds log lines until they are sent (and writes them to a
// file when one is set).
type LogBuffer struct {
	mu    sync.Mutex
	lines []string
	all   []string
	File  io.Writer
}

// Add adds one line (redacted).
func (l *LogBuffer) Add(s string) {
	if l == nil {
		return
	}
	s = redact.Redact(s)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, s)
	if len(l.all) < 20000 {
		l.all = append(l.all, s)
	}
	if l.File != nil {
		fmt.Fprintln(l.File, time.Now().UTC().Format(time.RFC3339)+" "+s)
	}
}

// Take returns the unsent lines.
func (l *LogBuffer) Take() []string {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.lines
	l.lines = nil
	return out
}

// All is every line so far (for the log view of the menu).
func (l *LogBuffer) All() []string {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.all...)
}

func (r *Recover) logf(format string, args ...any) { r.Log.Add(fmt.Sprintf(format, args...)) }

// probe is the probe block of the lab's answers, or nil outside a probe.
func (r *Recover) probe() *AnswersProbe {
	if r.Answers == nil {
		return nil
	}
	return r.Answers.Probe
}

func (r *Recover) flushLog(ctx context.Context) {
	if r.session == nil || r.session.ID == "" {
		return
	}
	if lines := r.Log.Take(); len(lines) > 0 {
		// A session that has ended takes no more log lines (9.8): that is
		// the expected end, not something to show. The lines stay in the
		// local log.
		if _, err := r.session.Log(ctx, lines); err != nil && !errors.Is(err, ErrSessionClosed) {
			r.UI.Say("report.log", "reason", redact.Redact(err.Error()))
		}
	}
}

func (r *Recover) unattended() bool { return r.Answers != nil }

// Run runs the flow and prints RESTOW-RECOVER-RESULT at the end.
func (r *Recover) Run(ctx context.Context) (*Result, error) {
	r.started = r.Env.Now()
	res, err := r.run(ctx)
	if r.wasAborted() && (res == nil || res.Status == "") {
		// Ctrl+C before the execution ended a dialog: cancelled, and the
		// session hears it when there is one.
		res, err = &Result{Status: api.RecoveryCancelled}, nil
		if !r.finished {
			r.finish(context.WithoutCancel(ctx), api.RecoveryCancelled, api.RecoveryVerification{}, []api.RecoveryWarning{})
		}
	}
	status := api.RecoveryFailed
	if res != nil && res.Status != "" {
		status = res.Status
	}
	if err != nil {
		r.logf("recover: %v", err)
		r.UI.Raw(redact.Redact(err.Error()))
	}
	r.flushLog(context.WithoutCancel(ctx))
	r.UI.Line("RESTOW-RECOVER-RESULT " + status)
	return res, err
}

func (r *Recover) run(ctx context.Context) (*Result, error) {
	r.UI.Menu = func() { r.menu(ctx) }
	r.UI.Say("start.title", "version", r.Version)
	var answersDisk string
	if r.Answers != nil && r.Answers.Source == SourceMedia {
		// The medium decides the instance and the disks to erase: it is
		// named before anything is typed, and its disk is never a target.
		md := r.Answers.Medium
		if md == nil || md.Disk == "" {
			return nil, errors.New("restow.answers=media: the disk of the answers medium is not known")
		}
		answersDisk = md.Disk
		r.UI.Say("answers.medium", "device", md.Device, "model", md.Model, "instance", r.Answers.InstanceURL)
	}
	if err := r.keyboard(ctx); err != nil {
		return nil, err
	}
	if err := r.network(ctx); err != nil {
		return nil, err
	}
	if err := r.instance(ctx); err != nil {
		return nil, err
	}
	r.UI.Say("hw.scanning")
	hw, err := r.Env.Hardware(ctx)
	if err != nil {
		return nil, fmt.Errorf("detect the hardware: %w", err)
	}
	hw.AnswersMedium = answersDisk
	target, notes := BuildTarget(hw)
	for _, n := range notes {
		r.logf("not a target: %s (%s)", n.Device, n.Reason)
	}
	if len(target.Disks) == 0 {
		r.UI.Say("code." + ProblemNoDisksFound)
		return &Result{Status: api.RecoveryFailed}, &problemError{code: ProblemNoDisksFound, err: errors.New("no disk found")}
	}
	if err := r.exchange(ctx, target); err != nil {
		return nil, err
	}
	creds, err := r.session.Credentials(ctx)
	if err != nil {
		if IsProblem(err, ProblemNotAvailable) && ProblemReason(err) == "snapshot_unknown" {
			// The backup the code was issued for is gone (deleted, or no
			// whole-machine backup any more): no other one is restored in
			// its place, and this code restores nothing.
			r.logf("credentials: %v", err)
			r.UI.Say("creds.snapshot_gone")
			return &Result{Status: api.RecoveryFailed}, nil
		}
		return r.fail(ctx, nil, nil, ProblemAccessExpired, err)
	}
	if mv := creds.MinRecoveryVersion; mv != "" && tooOld(r.Version, mv) {
		r.UI.Say("code."+ProblemRecoveryTooOld, "version", mv)
		return r.fail(ctx, nil, nil, ProblemRecoveryTooOld, fmt.Errorf("the instance requires recovery %s", mv))
	}
	snapshot, layoutSHA, err := r.chooseSnapshot(creds)
	if err != nil {
		if errors.Is(err, ErrAborted) {
			return r.finishEarly(ctx, nil, api.RecoveryCancelled, "")
		}
		// The answers name a snapshot the instance does not offer: no
		// other one is restored in its place.
		return r.fail(ctx, nil, nil, ProblemSnapshotIDUnmatched, err)
	}
	r.noteSnapshot(creds, snapshot)
	r.showSnapshot("snapshot.chosen")
	pw := []byte(creds.Repository.Password)
	rr, restorer, zeroRepo, err := r.Env.Restic(creds.Repository.URL, pw, r.session.ID, r.session.Secret, r.trust)
	if err != nil {
		return r.fail(ctx, nil, nil, ProblemRestoreFailed, err)
	}
	r.UI.Say("manifest.reading", "id", shortID(snapshot))
	m, _, err := ReadManifest(ctx, rr, snapshot, layoutSHA)
	if err != nil {
		code := ProblemCode(err)
		if code == ProblemManifestMismatch {
			r.logf("the manifest in the snapshot and on the server differ; nothing was changed")
		}
		r.UI.Say("code."+code, "format", "?", "reason", err.Error())
		zeroRepo()
		return r.fail(ctx, nil, nil, code, err)
	}
	r.UI.Say("facts.reading")
	facts, lvmMultiline, err := GatherFacts(ctx, rr, m, snapshot, creds.RestoreSizes)
	if err != nil {
		zeroRepo()
		return r.fail(ctx, nil, nil, ProblemRestoreFailed, err)
	}
	if hw.RAMBytes > 0 && hw.RAMBytes < 2<<30 {
		r.logf("low memory: %d bytes", hw.RAMBytes)
	}
	shared := SharedIdentities(hw)
	choices, nicMap, err := r.choices(m, target, shared)
	if err != nil {
		zeroRepo()
		r.UI.Line(TParams(r.UI.Lang, "code."+baremetal.ProblemMappingInvalid, map[string]any{"reason": err.Error()}))
		return r.fail(ctx, nil, nil, baremetal.ProblemMappingInvalid, err)
	}
	popts := baremetal.PlanOptions{Snapshot: snapshot, Probe: r.probe().Options()}
	if err := baremetal.CheckProbe(m, popts.Probe); err != nil {
		// The lab's answers would leave a system path out: no probe, no step.
		zeroRepo()
		r.logf("%v", err)
		return r.fail(ctx, nil, nil, ProblemStepFailed, err)
	}
	plan, _ := baremetal.PlanWith(m, target, facts, choices, popts)
	// The offer to continue comes before any question about the mapping:
	// a resumed plan maps by the identities on the disks (the disks the
	// first run wrote, whatever was chosen then) and erases nothing.
	// A probe never resumes: its disks are new for every probe.
	resume := r.probe() == nil && r.offerResume(m, target, snapshot)
	if resume {
		popts.Resume = baremetal.ResumeClean
		// The first run decided the sizes; this plan creates nothing.
		choices.Shrink = "auto"
		plan, _ = baremetal.PlanWith(m, target, facts, choices, popts)
	}
	plan, choices = r.refinePlan(ctx, m, target, facts, choices, plan, popts)
	if lvmMultiline {
		plan.OK = false
		plan.Problems = append(plan.Problems, baremetal.Finding{Code: ProblemLVMFilterMultiline, Severity: baremetal.FindingProblem,
			Message: T(LangEN, "code."+ProblemLVMFilterMultiline), Params: map[string]any{}})
	}
	r.showPlan(ctx, plan, target)
	if r.wasAborted() {
		// Ctrl+C ended the dialogs: cancelled, whatever the plan says.
		zeroRepo()
		return r.finishEarly(ctx, plan, api.RecoveryCancelled, "")
	}
	planBytes, _ := baremetal.EncodePlan(plan)
	planSum := sha256.Sum256(planBytes)
	planSHA := hex.EncodeToString(planSum[:])
	if r.PlanOnly {
		if r.PlanOut != nil {
			_, _ = r.PlanOut.Write(append(planBytes, '\n'))
		}
		zeroRepo()
		return r.finishEarly(ctx, plan, api.RecoveryCancelled, "")
	}
	if !plan.OK {
		r.UI.Say("plan.problems")
		for _, f := range plan.Problems {
			if f.Code == baremetal.ProblemAdoptIncomplete && !resume {
				// A disk with a part of the identities of the backup (an
				// interrupted recovery, an old disk): it is never erased by
				// the automatic mapping.
				r.UI.Say("plan.partial")
				break
			}
		}
		zeroRepo()
		return r.finishEarly(ctx, plan, api.RecoveryFailed, "")
	}
	secrets := &Secrets{}
	keepKeys, fallback, err := r.secretsAndOptions(ctx, m, plan, secrets)
	if err != nil {
		zeroRepo()
		secrets.Zero()
		return r.finishEarly(ctx, plan, api.RecoveryCancelled, "")
	}
	stop := func() (*Result, error) {
		if !r.wasAborted() {
			r.UI.Say("ui.aborted")
		}
		zeroRepo()
		secrets.Zero()
		return r.finishEarly(ctx, plan, api.RecoveryCancelled, "")
	}
	if !resume {
		ok, err := r.confirm(ctx, plan, target, shared)
		if err != nil || !ok {
			return stop()
		}
	}
	if r.wasAborted() {
		return stop()
	}
	_ = r.session.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseConfirmed, StepsTotal: len(plan.Steps)})
	fx := baremetal.NewFixupContext(m)
	for o, n := range nicMap {
		fx.MACs[o] = n
	}
	x := &Executor{Plan: plan, PlanSHA256: planSHA, Manifest: m, LayoutSHA256: layoutSHA, Snapshot: snapshot, Restic: restorer,
		Session: r.session, UI: r.UI, Secrets: secrets, Fixups: fx, ZeroRepoSecrets: zeroRepo, Fallback: fallback, KeepKeyFiles: keepKeys,
		Log: r.Log.Add, Now: r.Env.Now, TargetDevices: mappedDevices(plan, target), Probe: r.probe() != nil}
	if r.probe() != nil {
		x.OnRelease = r.probeReleased
	}
	r.Env.Executor(x, target)
	// From here Ctrl+C asks whether to cancel the execution; one that came
	// before said "nothing was erased" and holds: no step starts.
	r.curMu.Lock()
	if r.aborted {
		r.curMu.Unlock()
		return stop()
	}
	r.current = x
	r.curMu.Unlock()
	if resume {
		x.ResumeCheck = func(rf Rootfs) (*baremetal.RestorePlan, error) {
			mk, err := ResumeMarker(rf, snapshot, layoutSHA)
			if err != nil {
				return nil, err
			}
			x.OriginalPlanSHA256 = mk.PlanSHA256
			x.MarkerDisks = mk.Disks
			return resumedPlan(m, target, facts, choices, plan, mk, snapshot)
		}
	}
	if err := r.awaitForeignMappings(ctx, x); err != nil {
		zeroRepo()
		secrets.Zero()
		return r.fail(ctx, plan, nil, ProblemForeignMappingOpen, err)
	}
	// The last dialog is over (the shell of awaitForeignMappings too): the
	// disks must still be the ones that were shown and confirmed. Only
	// then recover writes to a disk for the first time (10.6).
	guard := &DiskGuard{AnswersMedium: answersDisk}
	r.Env.Guard(guard)
	defer guard.Close()
	if err := guard.Arm(ctx, r.Env.Hardware, target, plan, !resume); err != nil {
		zeroRepo()
		secrets.Zero()
		code := ProblemCode(err)
		var pe *problemError
		switch {
		case errors.Is(err, ErrDisksChanged):
			r.UI.Say("code."+ProblemDisksChanged, "detail", strings.TrimPrefix(err.Error(), ErrDisksChanged.Error()+": "))
		case code == baremetal.ProblemSEDLocked && errors.As(err, &pe):
			r.UI.Line(TParams(r.UI.Lang, "code."+code, pe.params))
		}
		r.UI.Say("ui.aborted")
		return r.fail(ctx, plan, nil, code, err)
	}
	x.Guard = guard
	rep, execErr := x.Run(ctx)
	// No step follows: the disks are let go before the shell, the restart
	// or the power-off.
	guard.Close()
	r.flushLog(ctx)
	if rep == nil {
		rep = x.Report()
	}
	warnings := planWarnings(plan)
	warnings = append(warnings, rep.Warnings...)
	if hw.RAMBytes > 0 && hw.RAMBytes < 2<<30 {
		warnings = append(warnings, api.RecoveryWarning{Code: WarnLowMemory, Message: fmt.Sprintf("%d bytes", hw.RAMBytes)})
	}
	hints := append(planHints(m, plan, target, choices), rep.Hints...)
	for o, n := range nicMap {
		hints = append(hints, api.RecoveryHint{Code: HintNICMapped, Params: map[string]string{"oldName": nicName(m, o), "oldMac": o, "newMac": n}})
	}
	verification := BuildVerification(snapshot, planSHA, rep.StartedAt, r.Env.Now(), rep.RestoreErrors, rep.Checks, hints, rep.Fixups, rep.NotAdaptedKernels)
	status := api.RecoverySucceeded
	switch {
	case errors.Is(execErr, ErrCancelled):
		status = api.RecoveryCancelled
	case execErr != nil:
		status = api.RecoveryFailed
		code := ProblemStepFailed
		var se *StepError
		if errors.As(execErr, &se) && se.Problem != "" {
			code = se.Problem
		}
		warnings = append(warnings, api.RecoveryWarning{Code: code, Message: redact.Redact(execErr.Error())})
		var pe *problemError
		switch {
		case code == ProblemAccessExpired:
			r.UI.Say("code." + ProblemAccessExpired)
		case code == ProblemForeignMappingOpen && errors.As(execErr, &pe):
			r.UI.Line(TParams(r.UI.Lang, "code."+code, pe.params))
			r.UI.Say("dm.foreign.resume")
		case errors.Is(execErr, ErrNoStartedRecovery):
			r.UI.Say("resume.no_marker")
		case errors.Is(execErr, ErrDisksChanged):
			r.UI.Say("code."+ProblemDisksChanged, "detail", strings.TrimPrefix(errors.Unwrap(execErr).Error(), ErrDisksChanged.Error()+": "))
		}
		if rep.FailedStep > 0 {
			r.UI.Say("exec.failed", "n", rep.FailedStep)
		}
	case verification.Result == api.VerifyFailed:
		status = api.RecoveryFailed
		warnings = append(warnings, api.RecoveryWarning{Code: ProblemVerifyFailed, Message: FailedChecks(verification)})
	}
	r.showVerification(verification, rep)
	refused := false
	if status != api.RecoveryCancelled || rep.Completed > 0 {
		// The instance decides what the recovery is stored as: a success
		// it does not take (9.8) is none here either, and the rebind,
		// which it would refuse, is not offered.
		if stored, reason := r.finish(ctx, status, verification, warnings); status == api.RecoverySucceeded && stored != status {
			status, refused = stored, true
			r.logf("the instance stored the recovery as %s (%s), not as the reported success", stored, reason)
			if stored == api.RecoveryFailed {
				r.UI.Say("finish.refused", "reason", r.serverReason(reason))
			} else {
				r.UI.Say("finish.ended", "state", r.UI.Text("state."+stored))
			}
		}
	}
	res := &Result{Status: status, Verification: &verification, Plan: plan}
	if status != api.RecoverySucceeded {
		if status == api.RecoveryFailed {
			if !refused {
				r.UI.Say("verify.failed")
			}
			r.UI.Say("done.failed")
		}
		if !r.unattended() {
			_ = r.Env.Shell(ctx)
		}
		return res, nil
	}
	if r.probe() == nil {
		r.rebind(ctx, x, m)
	}
	r.Env.Finalize(ctx, x)
	r.UI.Say("done.succeeded")
	r.after(ctx)
	return res, nil
}

// awaitForeignMappings: before the first step, no device-mapper device
// that could hold a key may be open outside the target disks when the plan
// runs a grub or LVM program with CAP_SYS_ADMIN (dmguard.go, 10.14). On
// the console recover names them and offers a shell to close them, then
// checks again; an unattended run stops.
func (r *Recover) awaitForeignMappings(ctx context.Context, x *Executor) error {
	for {
		err := x.PreflightMappings()
		var pe *problemError
		if err == nil || !errors.As(err, &pe) {
			return err
		}
		r.logf("%v", err)
		r.UI.Line(TParams(r.UI.Lang, "code."+ProblemForeignMappingOpen, pe.params))
		if r.unattended() {
			return err
		}
		ok, aerr := r.UI.YesNo(r.UI.Text("dm.foreign.shell"), true)
		if aerr != nil || !ok {
			return err
		}
		_ = r.Env.Shell(ctx)
	}
}

// Interrupt is Ctrl+C on the console. During the execution recover asks
// whether to cancel. Before it, Ctrl+C aborts the run: the countdown and
// every dialog end, no step starts, and only then the console says that
// nothing was erased (run checks aborted under the same lock before it
// hands the executor to Interrupt).
func (r *Recover) Interrupt() {
	r.curMu.Lock()
	x := r.current
	first := x == nil && !r.aborted
	if x == nil {
		r.aborted = true
	}
	stop := r.stopCountdown
	r.curMu.Unlock()
	if x != nil {
		x.PromptCancel()
		return
	}
	if stop != nil {
		stop()
	}
	r.UI.Abort()
	if first {
		r.UI.Say("ui.aborted")
	}
}

func (r *Recover) wasAborted() bool {
	r.curMu.Lock()
	defer r.curMu.Unlock()
	return r.aborted
}

// tooOld compares the ISO's version with the instance's minimum; a
// development build is never too old.
func tooOld(have, min string) bool {
	h, err1 := update.ParseVersion(have)
	m, err2 := update.ParseVersion(min)
	if err1 != nil || err2 != nil || h.IsDev() {
		return false
	}
	return update.Compare(h, m) < 0
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// keyboard loads the layout (restow.keymap, the answers or the
// operator's choice) and picks the language.
func (r *Recover) keyboard(ctx context.Context) error {
	layout := r.Cmdline.Keymap
	if r.Answers != nil && r.Answers.Keymap != "" {
		layout = r.Answers.Keymap
	}
	if layout == "" {
		layout = "us"
	}
	if !r.unattended() {
		def := 0
		for i, k := range ISOKeymaps {
			if k == layout {
				def = i
			}
		}
		i, err := r.UI.Choose(r.UI.Text("start.keymap"), ISOKeymaps, def)
		if err != nil {
			return err
		}
		layout = ISOKeymaps[i]
	}
	r.ownLayout = layout
	if err := r.Env.LoadKeymap(ctx, layout, ""); err != nil {
		r.logf("keymap %s: %v", layout, err)
	}
	r.lang = LangForKeymap(layout)
	if r.Answers != nil && r.Answers.Language != "" {
		r.lang = r.Answers.Language
	}
	if !r.unattended() {
		def := 1
		if r.lang == LangDE {
			def = 0
		}
		i, err := r.UI.Choose(r.UI.Text("start.language"), []string{"Deutsch", "English"}, def)
		if err != nil {
			return err
		}
		r.lang = []string{LangDE, LangEN}[i]
	}
	r.UI.Lang = r.lang
	return nil
}

// network: DHCP by default; a static address from the answers or the
// operator; the wait for an address (120 s) with the hints of 10.3.
func (r *Recover) network(ctx context.Context) error {
	var n *AnswersNetwork
	if r.Answers != nil {
		n = r.Answers.Network
	} else {
		r.UI.Say("net.limits")
		i, err := r.UI.Choose(r.UI.Text("net.mode"), []string{"DHCP", "static"}, 0)
		if err != nil {
			return err
		}
		if i == 1 {
			st := AnswersNetwork{Mode: "static"}
			var errs []error
			ask := func(id string, dst *string) {
				v, err := r.UI.Input(r.UI.Text(id), "")
				errs = append(errs, err)
				*dst = v
			}
			ask("net.static.iface", &st.Interface)
			ask("net.static.address", &st.Address)
			ask("net.static.gateway", &st.Gateway)
			var dns string
			ask("net.static.dns", &dns)
			if err := errors.Join(errs...); err != nil {
				return err
			}
			st.DNS = strings.Fields(dns)
			n = &st
		}
		proxy, err := r.UI.Input(r.UI.Text("net.proxy"), "")
		if err != nil {
			return err
		}
		if proxy != "" {
			if n == nil {
				n = &AnswersNetwork{Mode: "dhcp"}
			}
			n.Proxy = proxy
		}
	}
	if n != nil && n.Mode == "static" {
		if err := r.Env.ApplyNetwork(ctx, *n); err != nil {
			return fmt.Errorf("static network: %w", err)
		}
	}
	if n != nil {
		r.trust.Proxy = n.Proxy
	}
	ifs := r.Env.WaitNetwork(ctx, r.UI, 120*time.Second)
	r.UI.Say("net.title")
	phys := 0
	for _, i := range ifs {
		if !i.Physical {
			continue
		}
		phys++
		link := r.UI.Text("ui.no")
		if i.Link {
			link = r.UI.Text("ui.yes")
		}
		r.UI.Say("net.iface", "name", i.Name, "mac", i.MAC, "driver", i.Driver, "link", link, "addresses", strings.Join(i.Addresses, " "))
	}
	if phys == 0 {
		r.UI.Say("net.no_nic")
		for _, d := range r.Env.NoDriverDevices(ctx) {
			r.UI.Raw("  " + d)
		}
		r.UI.Say("net.no_nic_hint")
	} else if !HasAddress(ifs) {
		r.UI.Say("net.no_address")
		for _, name := range NoAddressHint(ifs) {
			r.UI.Say("net.lacp", "name", name)
		}
	}
	return nil
}

// instance asks for the address and settles the trust in the
// certificate (10.3).
func (r *Recover) instance(ctx context.Context) error {
	addr := ""
	allowHTTP := false
	if r.Answers != nil {
		addr = r.Answers.InstanceURL
		allowHTTP = r.Answers.Source == SourceFWCfg && strings.HasPrefix(addr, "http://")
	} else {
		var err error
		if addr, err = r.UI.Input(r.UI.Text("instance.address"), ""); err != nil {
			return err
		}
	}
	origin, err := CanonicalOrigin(addr, allowHTTP)
	if err != nil {
		return err
	}
	r.origin = origin
	if strings.HasPrefix(origin, "http://") {
		r.trust.Mode = TrustSystem
		return nil
	}
	if r.HTTPClient != nil {
		return nil
	}
	for attempt := 0; attempt < 3; attempt++ {
		probe, err := r.Env.ProbeTLS(ctx, origin, r.trust.Proxy)
		if err != nil {
			return &problemError{code: ProblemTLSUntrusted, err: err}
		}
		if r.Answers != nil && r.Answers.CAFile != "" {
			pem, err := r.Env.ReadFile(r.Answers.CAFile)
			if err != nil {
				return &problemError{code: ProblemTLSUntrusted, err: err}
			}
			r.trust.Mode, r.trust.CAPEM = TrustCAFile, pem
			return nil
		}
		class := ClassifyTLSError(probe.SystemErr, probe.Leaf, r.Env.Now())
		switch class {
		case TLSErrNone:
			r.trust.Mode = TrustSystem
			return nil
		case TLSErrExpired, TLSErrNotYetValid:
			state := r.UI.Text("clock.expired")
			if class == TLSErrNotYetValid {
				state = r.UI.Text("clock.not_yet_valid")
			}
			date := "?"
			if d, err := r.Env.DateHint(ctx, origin, r.trust.Proxy); err == nil {
				date = d.UTC().Format("2006-01-02 15:04")
			}
			r.UI.Say("clock.now", "time", r.Env.Now().UTC().Format("2006-01-02 15:04"))
			r.UI.Say("clock.tls", "state", state, "date", date)
			if r.unattended() {
				return &problemError{code: ProblemClockWrong, err: probe.SystemErr}
			}
			in, err := r.UI.Input(r.UI.Text("clock.set"), "")
			if err != nil {
				return err
			}
			if in != "" {
				t, err := ParseManualTime(in)
				if err != nil {
					r.UI.Raw(err.Error())
					continue
				}
				if err := r.Env.SetClock(t); err != nil {
					r.UI.Raw(err.Error())
				}
				continue
			}
		}
		return r.trustFallback(probe)
	}
	return &problemError{code: ProblemClockWrong, err: errors.New("the clock is still wrong")}
}

// trustFallback: the instance's own CA, or the whole check value typed by
// the operator (a prefix is not enough; a mismatch sends nothing).
func (r *Recover) trustFallback(probe *TLSProbe) error {
	if r.Answers != nil {
		if r.Answers.SPKICheck != "" {
			if !CheckSPKI(probe.Leaf, r.Answers.SPKICheck) {
				return &problemError{code: ProblemSPKIMismatch, err: errors.New("the check value does not match")}
			}
			r.trust.Mode, r.trust.Leaf = TrustPinned, probe.Leaf
			return nil
		}
		return &problemError{code: ProblemTLSUntrusted, err: probe.SystemErr}
	}
	r.UI.Say("code."+ProblemTLSUntrusted, "reason", fmt.Sprint(probe.SystemErr))
	i, err := r.UI.Choose(r.UI.Text("tls.mode"), []string{"system", "CA", "SPKI"}, 2)
	if err != nil {
		return err
	}
	switch i {
	case 1:
		p, err := r.UI.Input(r.UI.Text("tls.ca_file"), "")
		if err != nil {
			return err
		}
		var pem []byte
		if p == "-" {
			r.UI.Say("tls.ca_paste")
			var b strings.Builder
			for {
				l, err := r.UI.ReadLine()
				if err != nil || strings.TrimSpace(l) == "" {
					break
				}
				b.WriteString(l + "\n")
			}
			pem = []byte(b.String())
		} else if pem, err = r.Env.ReadFile(p); err != nil {
			return &problemError{code: ProblemTLSUntrusted, err: err}
		}
		r.trust.Mode, r.trust.CAPEM = TrustCAFile, pem
		return nil
	case 2:
		r.UI.Say("tls.spki_show", "cert", probe.CertSHA256, "spki", probe.SPKISHA256)
		typed, err := r.UI.Input(r.UI.Text("tls.spki_type"), "")
		if err != nil {
			return err
		}
		if !CheckSPKI(probe.Leaf, typed) {
			r.UI.Say("code." + ProblemSPKIMismatch)
			return &problemError{code: ProblemSPKIMismatch, err: errors.New("the check value does not match")}
		}
		r.trust.Mode, r.trust.Leaf = TrustPinned, probe.Leaf
		return nil
	}
	return &problemError{code: ProblemTLSUntrusted, err: probe.SystemErr}
}

// exchange redeems the code and waits for the approval (10.4 point 1).
func (r *Recover) exchange(ctx context.Context, target *baremetal.Target) error {
	hc := r.HTTPClient
	if hc == nil {
		var err error
		if hc, err = NewHTTPClient(r.trust); err != nil {
			return err
		}
	}
	allowHTTP := strings.HasPrefix(r.origin, "http://")
	s, err := NewSession(r.origin, allowHTTP, hc)
	if err != nil {
		return err
	}
	r.session = s
	for attempt := 0; ; attempt++ {
		code := ""
		if r.Answers != nil && r.Answers.Code != "" {
			code = r.Answers.Code
		} else if code, err = r.UI.Input(r.UI.Text("code.enter"), ""); err != nil {
			return err
		}
		norm, err := NormalizeCode(code)
		if err != nil {
			r.UI.Say("code.invalid")
			if r.unattended() && r.Answers.Code != "" || attempt >= 4 {
				return err
			}
			continue
		}
		redact.Add(norm, FormatCode(norm), code)
		out, err := s.Exchange(ctx, api.RecoveryExchangeRequest{CodeProof: CodeProof(s.BaseURL, norm), RecoveryVersion: r.Version, Hardware: ExchangeHardware(target)})
		if err != nil {
			switch ProblemName(err) {
			case ProblemCodeInvalid:
				r.UI.Say("code.invalid")
			case ProblemCodeExpired:
				r.UI.Say("code.expired")
			case ProblemCodeRevoked:
				r.UI.Say("code.revoked")
			case ProblemCodeUsed:
				r.UI.Say("code.used")
			case ProblemTooOld:
				r.UI.Say("code."+ProblemRecoveryTooOld, "version", "?")
				return &problemError{code: ProblemRecoveryTooOld, err: err}
			default:
				return err
			}
			if (r.Answers != nil && r.Answers.Code != "") || attempt >= 4 {
				return err
			}
			continue
		}
		r.UI.Say("approval.machine", "name", out.Endpoint.DisplayName, "hostname", out.Endpoint.Hostname)
		r.UI.Say("approval.match", "match", FormatMatchCode(out.MatchCode))
		r.logf("session %s exchanged", out.SessionID)
		_ = s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseConnected})
		if out.Status != api.RecoveryActive {
			if err := r.waitApproval(ctx); err != nil {
				return err
			}
		}
		if r.remoteOn {
			if keys, err := s.SSHKeys(ctx); err == nil {
				if err := r.Env.RemoteKeys(ctx, keys); err == nil {
					r.UI.Say("remote.keys")
				} else {
					r.logf("remote access: the switch to keys failed: %v", err)
					r.UI.Raw(redact.Redact(err.Error()))
				}
			}
		}
		return nil
	}
}

func (r *Recover) waitApproval(ctx context.Context) error {
	r.UI.Say("approval.waiting")
	_ = r.session.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseWaitingApproval})
	poll := r.Poll
	if poll == 0 {
		poll = 5 * time.Second
	}
	for {
		st, err := r.session.Current(ctx)
		if err != nil {
			return err
		}
		switch st.Status {
		case api.RecoveryActive:
			r.UI.Say("approval.granted")
			return nil
		case api.RecoveryPendingApproval:
		default:
			return &problemError{code: ProblemAccessExpired, err: fmt.Errorf("the session is %s", st.Status)}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
	}
}

// chooseSnapshot: the snapshot of the code, the answers' or the
// operator's choice among the whole-machine snapshots. A snapshot named
// in the answers must be exactly one of those the instance offers; with
// none or several the run fails before anything is planned or erased
// (never the snapshot of the code instead: who names an older snapshot
// wants that one, for example the last one before a break-in).
func (r *Recover) chooseSnapshot(c *api.RecoveryCredentials) (string, string, error) {
	id, sha := c.SnapshotID, c.LayoutSHA256
	if r.Answers != nil && r.Answers.SnapshotID != "" {
		want := r.Answers.SnapshotID
		found := map[string]string{}
		for _, s := range c.Snapshots {
			if strings.HasPrefix(s.ID, want) {
				found[s.ID] = s.LayoutSHA256
			}
		}
		if id != "" && strings.HasPrefix(id, want) {
			if _, ok := found[id]; !ok {
				found[id] = sha
			}
		}
		if len(found) != 1 {
			r.UI.Say("code."+ProblemSnapshotIDUnmatched, "id", want, "count", len(found))
			return "", "", fmt.Errorf("answers: snapshotId %s names %d of the snapshots this recovery code may restore; exactly one is needed, nothing was changed", want, len(found))
		}
		for fid, fsha := range found {
			id, sha = fid, fsha
		}
		return id, sha, nil
	}
	if r.unattended() || len(c.Snapshots) < 2 {
		return id, sha, nil
	}
	list := append([]api.RecoverySnapshot(nil), c.Snapshots...)
	sort.Slice(list, func(i, j int) bool { return list[i].Time.After(list[j].Time) })
	opts := make([]string, len(list))
	def := 0
	for i, s := range list {
		opts[i] = r.UI.Text("snapshot.item", "time", s.Time.UTC().Format("2006-01-02 15:04"), "id", shortID(s.ID), "check", r.checkState(s.Check))
		if s.ID == id {
			def = i
		}
	}
	i, err := r.UI.Choose(r.UI.Text("snapshot.title"), opts, def)
	if err != nil {
		// The dialog ended (Ctrl+C, end of the input): no snapshot is
		// taken in the operator's place.
		return "", "", ErrAborted
	}
	return list[i].ID, list[i].LayoutSHA256, nil
}

// checkState is the stage-1 check state of a snapshot in the console's
// language (passed, failed, incomplete, none; anything else is unknown).
func (r *Recover) checkState(check string) string {
	switch check {
	case "passed", "failed", "incomplete", "none":
		return r.UI.Text("snapcheck." + check)
	}
	return r.UI.Text("snapcheck.unknown")
}

// noteSnapshot keeps what the instance says about the snapshot that will
// be restored.
func (r *Recover) noteSnapshot(c *api.RecoveryCredentials, id string) {
	r.snap = snapshotNote{ID: id}
	for _, s := range c.Snapshots {
		if s.ID == id {
			r.snap.Time, r.snap.Check = s.Time, s.Check
		}
	}
}

// showSnapshot names the snapshot that will be restored (id, point in
// time, check state) with the text id, and says so when its check did not
// pass: the operator decides with that in view (10.4 point 3).
func (r *Recover) showSnapshot(id string) {
	when := r.UI.Text("snapshot.no_time")
	if !r.snap.Time.IsZero() {
		when = r.snap.Time.UTC().Format("2006-01-02 15:04")
	}
	r.UI.Say(id, "id", shortID(r.snap.ID), "time", when, "check", r.checkState(r.snap.Check))
	if r.snap.Check != "passed" {
		r.UI.Say("snapshot.not_passed", "check", r.checkState(r.snap.Check))
	}
}

// choices from the answers (mapping by identity, adoption, shrink, raw
// LVs, Secure Boot); the NIC map when one card is replaced by one.
//
// An identity of the answers must name exactly one device of the machine.
// One that several devices report (shared) is refused with the devices
// and the identities that name each alone; an empty identity matches
// nothing.
func (r *Recover) choices(m *baremetal.Manifest, t *baremetal.Target, shared map[string][]string) (baremetal.Choices, map[string]string, error) {
	var c baremetal.Choices
	nicMap := map[string]string{}
	if a := r.Answers; a != nil {
		if !a.DiskMapping.Auto && a.DiskMapping.Map != nil {
			c.DiskMapping = map[string]string{}
			srcs := make([]string, 0, len(a.DiskMapping.Map))
			for src := range a.DiskMapping.Map {
				srcs = append(srcs, src)
			}
			sort.Strings(srcs)
			for _, src := range srcs {
				ident := a.DiskMapping.Map[src]
				if err := sharedIdentityError("diskMapping "+src, ident, shared, t); err != nil {
					return c, nil, err
				}
				var ids []string
				others := 0
				for _, d := range t.Disks {
					if ident != "" && deref(d.Identity) == ident {
						ids = append(ids, d.ID)
					}
				}
				for _, d := range t.Others {
					if ident != "" && deref(d.Identity) == ident {
						others++
					}
				}
				switch {
				case len(ids) == 1 && others == 0:
					c.DiskMapping[src] = ids[0]
				case len(ids)+others > 1:
					return c, nil, fmt.Errorf("answers: diskMapping %s: %d devices have the identity %s", src, len(ids)+others, ident)
				default:
					c.DiskMapping[src] = "missing"
				}
			}
		}
		c.Adopt, c.Shrink, c.RawLVs, c.SecureBootOff = a.Adopt, a.Shrink, a.RawLVs, a.SecureBootOff
	}
	var oldNICs []baremetal.NetInterface
	for _, n := range m.Linux.Network {
		if n.Physical && n.MAC != nil {
			oldNICs = append(oldNICs, n)
		}
	}
	rename := len(oldNICs) == len(t.NICs)
	if r.Answers != nil {
		rename = r.Answers.RenameNICs
	}
	if rename && len(oldNICs) == 1 && len(t.NICs) == 1 && t.NICs[0].MAC != nil && !strings.EqualFold(*oldNICs[0].MAC, *t.NICs[0].MAC) {
		nicMap[strings.ToLower(*oldNICs[0].MAC)] = strings.ToLower(*t.NICs[0].MAC)
	}
	return c, nicMap, nil
}

// sharedIdentityError refuses an identity of the answers that several
// devices of the machine report, and says how each is named alone.
func sharedIdentityError(what, ident string, shared map[string][]string, t *baremetal.Target) error {
	devs := shared[ident]
	if len(devs) == 0 {
		return nil
	}
	own := map[string]string{}
	for _, list := range [][]baremetal.TargetDisk{t.Disks, t.Others} {
		for _, d := range list {
			own[d.Path] = deref(d.Identity)
		}
	}
	var named []string
	for _, dev := range devs {
		if id := own[dev]; id != "" {
			named = append(named, dev+" is "+id)
		} else {
			named = append(named, dev+" has no identity of its own")
		}
	}
	return fmt.Errorf("answers: %s: %d devices report the identity %s (%s); it names no single disk", what, len(devs), ident, strings.Join(named, ", "))
}

func nicName(m *baremetal.Manifest, mac string) string {
	for _, n := range m.Linux.Network {
		if n.MAC != nil && strings.EqualFold(*n.MAC, mac) {
			return n.Name
		}
	}
	return ""
}

// refinePlan asks the operator where the plan needs a decision (a disk
// without a target, a disk that carries only a part of the identities of
// the backup, shrinking, Secure Boot), then plans again. A resumed plan
// maps by the identities on the disks; it asks nothing about the mapping.
func (r *Recover) refinePlan(ctx context.Context, m *baremetal.Manifest, t *baremetal.Target, f *baremetal.Facts, c baremetal.Choices, p *baremetal.RestorePlan, o baremetal.PlanOptions) (*baremetal.RestorePlan, baremetal.Choices) {
	if r.unattended() {
		return p, c
	}
	changed := false
	shrinkAsked, secureBootAsked := false, false
	for _, pr := range p.Problems {
		switch pr.Code {
		case baremetal.ProblemShrinkNeedsConfirmation:
			// One answer covers every proposal (the choice is one for the
			// plan), so all of them are shown before it is asked, and the
			// default is no: nothing shrinks because Enter was pressed.
			if shrinkAsked {
				continue
			}
			shrinkAsked = true
			r.UI.Say("shrink.title")
			for _, q := range p.Problems {
				if q.Code == baremetal.ProblemShrinkNeedsConfirmation {
					r.showShrink(q, t)
				}
			}
			if ok, err := r.UI.YesNo(r.UI.Text("shrink.ask"), false); err == nil && ok {
				c.Shrink, changed = "auto", true
			}
		case baremetal.ProblemSecureBootCAMissing, baremetal.ProblemSecureBootRevoked, baremetal.ProblemSecureBootSbatRevoked:
			// recover cannot switch Secure Boot off; a yes only makes the
			// findings warnings. The question says what is left to do, and
			// it is asked once for all findings of the boot chain.
			if c.SecureBootOff || secureBootAsked {
				continue
			}
			secureBootAsked = true
			for _, q := range p.Problems {
				switch q.Code {
				case baremetal.ProblemSecureBootCAMissing, baremetal.ProblemSecureBootRevoked, baremetal.ProblemSecureBootSbatRevoked:
					r.UI.Line("  - " + TParams(r.lang, "code."+q.Code, q.Params))
				}
			}
			if ok, err := r.UI.YesNo(r.UI.Text("secureboot.ask"), false); err == nil && ok {
				c.SecureBootOff, changed = true, true
			}
		case baremetal.ProblemTargetMissing, baremetal.ProblemMappingInvalid:
			if c.DiskMapping == nil && o.Resume == "" {
				c.DiskMapping = r.askMapping(m, t, p)
				changed = true
			}
		case baremetal.ProblemAdoptIncomplete:
			// A target disk carries identities of the backup, so the plan
			// keeps it, but not everything the backup had on it: a recovery
			// that stopped between partitioning and the first file, or an
			// old disk of this machine. The plan cannot run as it is; the
			// operator says what becomes of each disk (a disk chosen as a
			// target is erased after the confirmation, 10.18).
			if c.DiskMapping == nil && o.Resume == "" {
				r.UI.Line(TParams(r.lang, "code."+pr.Code, pr.Params))
				r.UI.Say("map.partial")
				c.DiskMapping = r.askMapping(m, t, p)
				changed = true
			}
		}
	}
	if !changed {
		return p, c
	}
	np, _ := baremetal.PlanWith(m, t, f, c, o)
	return np, c
}

// showShrink prints one shrink proposal of the plan: what does not fit
// where, and every volume that would shrink with its size before and
// after.
func (r *Recover) showShrink(pr baremetal.Finding, t *baremetal.Target) {
	byID := map[string]baremetal.TargetDisk{}
	for _, d := range t.Disks {
		byID[d.ID] = d
	}
	var targets []string
	for _, id := range strings.Split(paramString(pr.Params["target"]), ", ") {
		if d, ok := byID[id]; ok {
			targets = append(targets, fmt.Sprintf("%s (%s, %s)", d.Path, deref(d.Model), FormatBytes(d.SizeBytes)))
		} else {
			targets = append(targets, id)
		}
	}
	vg, _ := pr.Params["vg"].(string)
	if vg != "" {
		r.UI.Say("shrink.vg", "vg", vg, "target", strings.Join(targets, ", "))
	} else {
		r.UI.Say("shrink.disk", "disk", paramString(pr.Params["disk"]), "target", strings.Join(targets, ", "))
	}
	items, _ := pr.Params["proposal"].([]any)
	for _, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		from, to := FormatBytes(paramInt(m["fromBytes"])), FormatBytes(paramInt(m["toBytes"]))
		if lv, ok := m["lv"]; ok {
			name := paramString(lv)
			if vg != "" {
				name = vg + "/" + name
			}
			r.UI.Say("shrink.lv", "lv", name, "from", from, "to", to)
		} else {
			r.UI.Say("shrink.part", "partition", paramString(m["partition"]), "from", from, "to", to)
		}
	}
}

// paramInt reads a number of a finding's parameters (the planner's int64,
// or the float64 JSON makes of it).
func paramInt(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	}
	return 0
}

func (r *Recover) askMapping(m *baremetal.Manifest, t *baremetal.Target, p *baremetal.RestorePlan) map[string]string {
	out := map[string]string{}
	min := map[string]int64{}
	for _, d := range p.MinimumSizes.Disks {
		min[d.Disk] = d.MinBytes
	}
	used := map[string]bool{}
	for _, d := range m.Linux.Disks {
		r.UI.Say("map.disk", "disk", d.ID, "kname", d.KName, "size", FormatBytes(d.SizeBytes), "mounts", "", "min", FormatBytes(min[d.ID]))
		var opts []string
		var ids []string
		for _, td := range t.Disks {
			if used[td.ID] {
				continue
			}
			opts = append(opts, r.UI.Text("hw.disk", "path", td.Path, "model", deref(td.Model), "size", FormatBytes(td.SizeBytes), "identity", deref(td.Identity)))
			ids = append(ids, td.ID)
		}
		opts = append(opts, r.UI.Text("map.adopt"), r.UI.Text("map.missing"))
		i, err := r.UI.Choose(r.UI.Text("map.choose", "disk", d.ID), opts, 0)
		if err != nil {
			return out
		}
		switch {
		case i < len(ids):
			out[d.ID] = ids[i]
			used[ids[i]] = true
		case i == len(ids):
			out[d.ID] = "adopt"
		default:
			out[d.ID] = "missing"
		}
	}
	return out
}

// offerResume: the target disks carry the disk identities of the manifest
// that the planner would not erase; a recovery of this snapshot may have
// been started on them (10.18). The GUID alone proves nothing (the source
// machine's own disks carry it): the marker decides once the root is
// mounted (ResumeMarker), before anything is written there.
func (r *Recover) offerResume(m *baremetal.Manifest, t *baremetal.Target, snapshot string) bool {
	guids := map[string]bool{}
	for _, d := range m.Linux.Disks {
		if d.Table != nil && d.Table.ID != "" {
			guids[normIdent(d.Table.ID)] = true
		}
	}
	found := false
	for _, d := range t.Disks {
		for _, s := range d.Signatures {
			if s.Kind == "disk_guid" && guids[normIdent(s.UUID)] {
				found = true
			}
		}
	}
	if !found {
		return false
	}
	if r.unattended() {
		return false
	}
	ok, err := r.UI.YesNo(r.UI.Text("resume.offer", "id", shortID(snapshot)), true)
	return err == nil && ok
}

// resumedPlan is the plan a resumed run continues with from the first
// restore step, once the marker of the started run is read (10.18). The
// first plan of the resume mapped every disk by the identities on it; the
// marker says what the started run did with each source disk. A disk it
// adopted is adopted again, so its mount points stay out of the restore
// (it carries the same identities as a disk recover wrote, and nothing on
// it was ever confirmed for overwriting); a disk that was missing stays
// missing. The devices opened and mounted so far must be the ones of
// this plan. After an unclean end the plan restores with --overwrite
// always.
func resumedPlan(m *baremetal.Manifest, t *baremetal.Target, f *baremetal.Facts, c baremetal.Choices, first *baremetal.RestorePlan, mk *Marker, snapshot string) (*baremetal.RestorePlan, error) {
	mode := baremetal.ResumeUnclean
	if mk.CleanStop {
		mode = baremetal.ResumeClean
	}
	if len(mk.Disks) > 0 {
		mapped := map[string]string{}
		for _, a := range first.Mapping {
			if a.Target != nil && a.Action != baremetal.ActionMissing {
				mapped[a.Source] = *a.Target
			}
		}
		c.DiskMapping = map[string]string{}
		for _, d := range mk.Disks {
			switch d.Action {
			case baremetal.ActionAdopt, baremetal.ActionMissing:
				c.DiskMapping[d.Source] = d.Action
			default:
				tg, ok := mapped[d.Source]
				if !ok {
					return nil, fmt.Errorf("the started recovery wrote disk %s of the backup, but no disk of this machine carries its identities now; nothing was restored", d.Source)
				}
				c.DiskMapping[d.Source] = tg
			}
		}
	} else if mk.CleanStop {
		return nil, nil
	}
	next, _ := baremetal.PlanWith(m, t, f, c, baremetal.PlanOptions{Snapshot: snapshot, Resume: mode})
	if !next.OK {
		var why []string
		for _, p := range next.Problems {
			why = append(why, p.Message)
		}
		return nil, fmt.Errorf("the started recovery cannot be continued on these disks; nothing was restored: %s", strings.Join(why, " "))
	}
	if a, b := stackSteps(first), stackSteps(next); a != b {
		return nil, errors.New("the disks opened for the resume are not the ones the started recovery used (its marker names another mapping); nothing was restored")
	}
	return next, nil
}

// stackSteps are the steps of a plan before the restore (what is
// assembled, opened, activated and mounted), as one string.
func stackSteps(p *baremetal.RestorePlan) string {
	var b strings.Builder
	for _, s := range p.Steps {
		if s.Phase == "restore" {
			break
		}
		b.WriteString(s.Kind + " " + strings.Join(s.Args, " ") + "\n")
	}
	return b.String()
}

func (r *Recover) showPlan(ctx context.Context, p *baremetal.RestorePlan, t *baremetal.Target) {
	r.UI.Say("plan.title")
	byID := map[string]baremetal.TargetDisk{}
	for _, d := range t.Disks {
		byID[d.ID] = d
	}
	for _, pd := range p.Disks {
		td := byID[pd.Target]
		var parts []string
		if pd.Table != nil {
			parts = append(parts, strings.ToUpper(*pd.Table))
		}
		for _, pp := range pd.Partitions {
			parts = append(parts, fmt.Sprintf("%d %s", pp.Number, FormatBytes(pp.SizeBytes)))
		}
		for _, lv := range pd.LVs {
			parts = append(parts, fmt.Sprintf("%s/%s %s", lv.VG, lv.LV, FormatBytes(lv.SizeBytes)))
		}
		r.UI.Say("plan.disk", "path", td.Path, "model", deref(td.Model), "size", FormatBytes(td.SizeBytes), "identity", deref(td.Identity), "layout", strings.Join(parts, ", "))
	}
	for _, a := range p.Adopted {
		r.UI.Say("plan.adopted", "unit", a.Kind+" "+a.Ref)
	}
	if len(p.Problems) > 0 {
		r.UI.Say("plan.problems")
		for _, f := range p.Problems {
			r.UI.Line("  - " + TParams(r.lang, "code."+f.Code, f.Params))
		}
	}
	if len(p.Warnings) > 0 {
		r.UI.Say("plan.warnings")
		for _, f := range p.Warnings {
			r.UI.Line("  - " + TParams(r.lang, "code."+f.Code, f.Params))
			if f.Code == baremetal.WarnUntestedDistribution {
				r.UI.Say("plan.untested")
			}
		}
	}
	_ = r.session.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhasePlanning, StepsTotal: len(p.Steps)})
	if r.unattended() || !p.OK {
		return
	}
	in, err := r.UI.Input(r.UI.Text("plan.commands"), "")
	if err == nil && strings.TrimSpace(in) == "p" {
		for _, s := range p.Steps {
			r.UI.Raw(fmt.Sprintf("%3d %-9s %s", s.N, s.Phase, strings.Join(s.Args, " ")))
		}
	}
}

// secretsAndOptions asks for the passphrases and the options the plan
// needs: the new LUKS passphrase (typed twice or generated) with the
// keyboard layout that applies at the start, the old passphrases of
// adopted volumes, the key files and the fallback boot path.
func (r *Recover) secretsAndOptions(ctx context.Context, m *baremetal.Manifest, p *baremetal.RestorePlan, sec *Secrets) (keepKeys, fallback bool, err error) {
	needNew, needKey, needFallback := false, false, false
	var old []string
	for _, s := range p.Steps {
		if s.StdinSecret != nil && *s.StdinSecret == "passphrase" {
			needNew = true
		}
		if s.StdinSecret != nil && *s.StdinSecret == "old_passphrase" && s.Target != nil {
			old = append(old, *s.Target)
		}
		needKey = needKey || s.Kind == "keyfile"
		needFallback = needFallback || s.Kind == "fallback_path"
	}
	fallback = true
	if r.Answers != nil {
		keepKeys = r.Answers.KeyFiles == "keep"
		if needNew {
			if r.Answers.Passphrase == "" {
				return false, false, errors.New("the answers have no passphrase (only fw_cfg may carry one)")
			}
			sec.SetPassphrase([]byte(r.Answers.Passphrase))
		}
		if len(old) > 0 {
			return false, false, errors.New("adopted LUKS volumes need their old passphrase, which the answers cannot carry")
		}
		return keepKeys, fallback, nil
	}
	if needNew {
		layout, variant, grub := KeymapForInitramfs(m)
		if grub {
			r.UI.Say("pass.notice_grub")
		} else {
			r.UI.Say("pass.notice", "layout", strings.TrimSpace(layout+" "+variant))
		}
		_ = r.Env.LoadKeymap(ctx, layout, variant)
		defer func() { _ = r.Env.LoadKeymap(ctx, r.ownLayout, "") }()
		i, err := r.UI.Choose(r.UI.Text("pass.mode"), []string{r.UI.Text("pass.enter"), "generate"}, 0)
		if err != nil {
			return false, false, err
		}
		if i == 1 {
			pw, err := GeneratePassphrase()
			if err != nil {
				return false, false, err
			}
			sec.SetPassphrase([]byte(pw))
			r.UI.Say("pass.generated", "passphrase", pw)
		} else {
			b, err := r.UI.SecretTwice(r.UI.Text("pass.enter"))
			if err != nil {
				return false, false, err
			}
			sec.SetPassphrase(b)
		}
	}
	for _, dev := range old {
		b, err := r.UI.Secret(r.UI.Text("pass.old", "volume", dev))
		if err != nil {
			return false, false, err
		}
		sec.SetOld(dev, b)
	}
	if needKey {
		i, err := r.UI.Choose(r.UI.Text("keyfiles.mode"), []string{"new", "keep"}, 0)
		if err != nil {
			return false, false, err
		}
		keepKeys = i == 1
	}
	if needFallback {
		if fallback, err = r.UI.YesNo(r.UI.Text("fallback.ask"), true); err != nil {
			return false, false, err
		}
	}
	return keepKeys, fallback, nil
}

// GeneratePassphrase makes a passphrase of layout-proof characters: the
// code alphabet (no Y or Z), six groups of five.
func GeneratePassphrase() (string, error) {
	groups := make([]string, 6)
	for g := range groups {
		var b strings.Builder
		for i := 0; i < 5; i++ {
			n, err := rand.Int(rand.Reader, big.NewInt(int64(len(Alphabet))))
			if err != nil {
				return "", err
			}
			b.WriteByte(Alphabet[n.Int64()])
		}
		groups[g] = b.String()
	}
	return strings.Join(groups, "-"), nil
}

// erasedDisks are the target disks the plan erases.
func erasedDisks(p *baremetal.RestorePlan, t *baremetal.Target) []baremetal.TargetDisk {
	byID := map[string]baremetal.TargetDisk{}
	for _, d := range t.Disks {
		byID[d.ID] = d
	}
	var out []baremetal.TargetDisk
	for _, a := range p.Mapping {
		if a.Action == baremetal.ActionErase && a.Target != nil {
			out = append(out, byID[*a.Target])
		}
	}
	return out
}

func mappedDevices(p *baremetal.RestorePlan, t *baremetal.Target) []string {
	var out []string
	for _, d := range erasedDisks(p, t) {
		out = append(out, d.Path)
	}
	return out
}

// confirm: for every disk to erase that carries data, the last four
// characters of its identity, then the erase word (10.4 point 8).
// Unattended: confirmErase must name exactly the identities erased; from
// a medium the disks are shown for 30 seconds first, any key aborts.
//
// An identity confirms a disk only when it names that disk alone: one
// that several devices report is refused (the answers must use the
// identity recover shows for the disk), and a disk without an identity
// cannot be confirmed for erasing at all.
func (r *Recover) confirm(ctx context.Context, p *baremetal.RestorePlan, t *baremetal.Target, shared map[string][]string) (bool, error) {
	disks := erasedDisks(p, t)
	count := map[string]int{}
	for _, list := range [][]baremetal.TargetDisk{t.Disks, t.Others} {
		for _, d := range list {
			if id := deref(d.Identity); id != "" {
				count[id]++
			}
		}
	}
	for _, d := range disks {
		id := deref(d.Identity)
		if id == "" && (r.Answers != nil || len(d.Signatures) > 0) {
			r.UI.Say("confirm.no_identity", "path", d.Path, "model", deref(d.Model), "size", FormatBytes(d.SizeBytes))
			return false, nil
		}
		if id != "" && (count[id] != 1 || len(shared[id]) > 0) {
			r.UI.Say("confirm.shared", "path", d.Path, "identity", id)
			return false, nil
		}
	}
	if r.Answers != nil {
		want := map[string]bool{}
		for _, id := range r.Answers.ConfirmErase {
			if err := sharedIdentityError("confirmErase", id, shared, t); err != nil {
				r.logf("%v", err)
				r.UI.Raw(err.Error())
				return false, nil
			}
			want[id] = true
		}
		if len(want) != len(disks) || len(want) != len(r.Answers.ConfirmErase) {
			return false, nil
		}
		for _, d := range disks {
			if !want[deref(d.Identity)] {
				return false, nil
			}
		}
		if r.Answers.Source == SourceMedia {
			r.showSnapshot("confirm.snapshot")
			r.UI.Say("unattended.countdown", "instance", r.origin)
			for _, d := range disks {
				r.UI.Line(r.eraseLine(d))
			}
			wait := r.Countdown
			if wait == 0 {
				wait = 30 * time.Second
			}
			cctx, cancel := context.WithTimeout(ctx, wait)
			r.curMu.Lock()
			r.stopCountdown = cancel
			gone := r.aborted
			r.curMu.Unlock()
			pressed := gone || r.UI.AnyKey(cctx)
			r.curMu.Lock()
			r.stopCountdown = nil
			r.curMu.Unlock()
			cancel()
			// A key, Ctrl+C or the end of the run: nothing is erased. Only
			// the full time without any of them goes on.
			if pressed || r.wasAborted() || ctx.Err() != nil {
				return false, nil
			}
		}
		return true, nil
	}
	// What will be written, then every disk by itself, then all of them
	// once more right above the erase word: the plan screen that named
	// them has scrolled away behind the passphrase and option dialogs.
	r.showSnapshot("confirm.snapshot")
	var lines []string
	for _, d := range disks {
		lines = append(lines, r.eraseLine(d))
		if deref(d.Identity) == "" {
			// No identity to type (an empty disk without one, see above):
			// the list and the erase word are its confirmation.
			continue
		}
		// Every disk, also one without a signature: raw data and formats
		// blkid does not know look empty and are not.
		ok, err := r.UI.TypeToConfirm(d.Path, deref(d.Model), FormatBytes(d.SizeBytes), deref(d.Identity))
		if err != nil || !ok {
			return false, err
		}
	}
	return r.UI.ConfirmErase(lines)
}

// eraseLine names a disk that will be erased: path, model, size, identity.
func (r *Recover) eraseLine(d baremetal.TargetDisk) string {
	id := deref(d.Identity)
	if id == "" {
		id = r.UI.Text("confirm.no_id")
	}
	return r.UI.Text("confirm.disk", "path", d.Path, "model", deref(d.Model), "size", FormatBytes(d.SizeBytes), "identity", id)
}

// planWarnings are the plan's findings as finish warnings (problems too
// when the run ends before anything was erased).
func planWarnings(p *baremetal.RestorePlan) []api.RecoveryWarning {
	out := []api.RecoveryWarning{}
	if p == nil {
		return out
	}
	for _, f := range append(append([]baremetal.Finding{}, p.Problems...), p.Warnings...) {
		out = append(out, api.RecoveryWarning{Code: f.Code, Message: f.Message})
	}
	return out
}

// planHints are the hints that follow from the plan and the manifest.
func planHints(m *baremetal.Manifest, p *baremetal.RestorePlan, t *baremetal.Target, c baremetal.Choices) []api.RecoveryHint {
	var out []api.RecoveryHint
	byPath := map[string]baremetal.TargetDisk{}
	for _, d := range t.Disks {
		byPath[d.ID] = d
		byPath[d.Path] = d
	}
	for _, w := range p.Warnings {
		switch w.Code {
		case baremetal.WarnBIOSBootDisk:
			d := byPath[fmt.Sprint(w.Params["target"])]
			out = append(out, api.RecoveryHint{Code: HintBIOSBootDisk, Params: map[string]string{"model": deref(d.Model), "identity": deref(d.Identity)}})
		case baremetal.WarnLUKSTokensNotRestored:
			out = append(out, api.RecoveryHint{Code: HintLUKSReenrollToken, Params: map[string]string{"volume": fmt.Sprint(w.Params["luks"]), "tokenTypes": paramString(w.Params["tokens"])}})
		case baremetal.WarnMDDegradedFirstBoot:
			md := fmt.Sprint(w.Params["md"])
			out = append(out, api.RecoveryHint{Code: HintMDDegradedFirstBoot, Params: map[string]string{"array": md}},
				api.RecoveryHint{Code: HintMDAddDisk, Params: map[string]string{"array": md}})
		}
	}
	if c.SecureBootOff {
		out = append(out, api.RecoveryHint{Code: HintSecureBootDisabled, Params: map[string]string{}})
	}
	if len(m.Linux.LUKS) > 0 {
		layout, variant, _ := KeymapForInitramfs(m)
		out = append(out, api.RecoveryHint{Code: HintKeymapAtBoot, Params: map[string]string{"layout": strings.TrimSpace(layout + " " + variant)}})
	}
	for i, ref := range m.Linux.DeviceNameRefs {
		if i >= 20 {
			break
		}
		out = append(out, api.RecoveryHint{Code: HintDeviceNameRefs, Params: map[string]string{"path": ref.Path, "line": fmt.Sprint(ref.Line)}})
	}
	return out
}

// finishEarly ends a run before anything was erased: the plan's problems
// travel as warnings.
func (r *Recover) finishEarly(ctx context.Context, p *baremetal.RestorePlan, status, code string) (*Result, error) {
	w := planWarnings(p)
	if code != "" {
		w = append(w, api.RecoveryWarning{Code: code, Message: T(LangEN, "code."+code)})
	}
	r.finish(ctx, status, api.RecoveryVerification{}, w)
	return &Result{Status: status, Plan: p}, nil
}

func (r *Recover) fail(ctx context.Context, p *baremetal.RestorePlan, _ *ExecReport, code string, err error) (*Result, error) {
	if code == "" {
		code = ProblemStepFailed
	}
	w := planWarnings(p)
	w = append(w, api.RecoveryWarning{Code: code, Message: redact.Redact(err.Error())})
	if code != ProblemAccessExpired {
		r.finish(ctx, api.RecoveryFailed, api.RecoveryVerification{}, w)
	}
	return &Result{Status: api.RecoveryFailed, Plan: p}, err
}

// finish reports the end and returns what the instance stored it as, with
// the instance's reason when that is not what was reported: a success
// without a verification report that bears it out is stored as failed
// (9.8), and a session that had ended before (cancelled in the web
// interface) keeps its state. A session that has ended takes nothing
// more: that answer is expected and not shown.
func (r *Recover) finish(ctx context.Context, status string, v api.RecoveryVerification, w []api.RecoveryWarning) (stored, reason string) {
	if r.session == nil || r.session.ID == "" {
		return status, ""
	}
	r.finished = true
	r.flushLog(ctx)
	var raw []byte
	if v.Format != "" {
		raw = VerificationJSON(v)
	}
	res, err := r.session.Finish(ctx, api.RecoveryFinish{Status: status, Verification: raw, Warnings: w,
		DurationSeconds: int64(r.Env.Now().Sub(r.started) / time.Second)})
	switch {
	case errors.Is(err, ErrSessionClosed):
		r.logf("finish: %v", err)
		if res.Status != "" {
			return res.Status, ""
		}
		return status, ""
	case err != nil:
		r.UI.Say("report.finish", "reason", redact.Redact(err.Error()))
		return status, ""
	}
	return res.Status, res.Reason
}

// serverReason is the instance's reason for not taking a reported success,
// in the console's language (the code itself when this ISO does not know
// it).
func (r *Recover) serverReason(code string) string {
	if id := "server." + code; code != "" && HasText(LangEN, id) {
		return r.UI.Text(id)
	}
	if code == "" {
		code = "?"
	}
	return r.UI.Text("server.unknown", "code", code)
}

func (r *Recover) showVerification(v api.RecoveryVerification, rep *ExecReport) {
	if len(v.Checks) == 0 {
		return
	}
	r.UI.Say("verify.title")
	// The report carries English texts for the server; the console shows
	// each finding in the operator's language (Check.Text).
	local := map[string]*Check{}
	if rep != nil {
		for _, c := range rep.Checks {
			local[c.ID] = c
		}
	}
	for _, c := range v.Checks {
		result := "result." + c.Result
		if !HasText(LangEN, result) {
			result = "result.failed"
		}
		r.UI.Say("verify.line", "result", r.UI.Text(result), "check", r.UI.Text("check."+c.ID))
		for i := range c.Findings {
			text := r.UI.Text("find.not_run")
			if lc := local[c.ID]; lc != nil {
				text = lc.Text(i, r.lang)
			}
			r.UI.Line("    " + text)
		}
	}
	for _, h := range v.Hints {
		params := map[string]any{}
		for k, val := range h.Params {
			params[k] = val
		}
		r.UI.Line("  * " + TParams(r.lang, "hint."+h.Code, params))
	}
	if rep != nil && rep.MokPassword != "" {
		r.UI.Say("mok.password", "password", rep.MokPassword)
	}
}

// rebind connects the restored machine again on request (10.19).
func (r *Recover) rebind(ctx context.Context, x *Executor, m *baremetal.Manifest) {
	token := ""
	if r.Answers != nil {
		token = r.Answers.RebindToken
	} else if ok, err := r.UI.YesNo(r.UI.Text("rebind.ask"), false); err == nil && ok {
		token, _ = r.UI.Input(r.UI.Text("rebind.token"), "")
	}
	if token == "" || x.Rootfs() == nil {
		return
	}
	if _, err := Rebind(ctx, r.session, strings.TrimSpace(token), r.origin, x.Rootfs(), m, r.Version); err != nil {
		r.UI.Say("report.rebind", "reason", redact.Redact(err.Error()))
		return
	}
	r.UI.Say("rebind.done")
}

// after: restart, power off or shell.
func (r *Recover) after(ctx context.Context) {
	if r.Answers != nil {
		if r.Answers.AfterSuccess == "poweroff" {
			_ = r.Env.PowerOff(ctx)
		} else {
			_ = r.Env.Reboot(ctx)
		}
		return
	}
	i, err := r.UI.Choose(r.UI.Text("after.choose"), []string{r.UI.Text("menu.reboot"), r.UI.Text("menu.poweroff"), r.UI.Text("menu.shell")}, 0)
	if err != nil {
		return
	}
	switch i {
	case 0:
		_ = r.Env.Reboot(ctx)
	case 1:
		_ = r.Env.PowerOff(ctx)
	default:
		_ = r.Env.Shell(ctx)
	}
}

// menu is the ? menu (10.2 point 2).
func (r *Recover) menu(ctx context.Context) {
	opts := []string{r.UI.Text("menu.network"), r.UI.Text("menu.clock"), r.UI.Text("menu.shell"), r.UI.Text("menu.remote"),
		r.UI.Text("menu.log"), r.UI.Text("menu.reboot"), r.UI.Text("menu.poweroff"), r.UI.Text("menu.back")}
	saved := r.UI.Menu
	r.UI.Menu = nil
	defer func() { r.UI.Menu = saved }()
	i, err := r.UI.Choose(r.UI.Text("menu.title"), opts, len(opts)-1)
	if err != nil {
		return
	}
	switch i {
	case 0:
		for _, n := range r.Env.Interfaces() {
			r.UI.Say("net.iface", "name", n.Name, "mac", n.MAC, "driver", n.Driver, "link", n.Link, "addresses", strings.Join(n.Addresses, " "))
		}
	case 1:
		r.UI.Say("clock.now", "time", r.Env.Now().UTC().Format("2006-01-02 15:04"))
		if in, err := r.UI.Input(r.UI.Text("clock.set"), ""); err == nil && in != "" {
			if t, err := ParseManualTime(in); err == nil {
				_ = r.Env.SetClock(t)
			}
		}
	case 2:
		_ = r.Env.Shell(ctx)
	case 3:
		r.UI.Say("remote.warning")
		pw, keys, err := r.Env.EnableRemote(ctx)
		if err != nil {
			r.UI.Raw(err.Error())
			return
		}
		r.remoteOn = true
		addr := ""
		for _, n := range r.Env.Interfaces() {
			if len(n.Addresses) > 0 && addr == "" {
				addr = strings.SplitN(n.Addresses[0], "/", 2)[0]
			}
		}
		r.UI.Say("remote.password", "address", addr, "password", pw)
		for _, k := range keys {
			r.UI.Say("remote.hostkeys", "type", k.Type, "fingerprint", k.Fingerprint)
		}
		if r.session != nil && r.session.ID != "" {
			_ = r.session.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseConnected, SSHHostKeys: keys})
			_ = r.session.Event(ctx, api.RecoveryEventRemoteAccessEnabled, map[string]string{"address": addr})
			if ks, err := r.session.SSHKeys(ctx); err == nil && len(ks) > 0 {
				if err := r.Env.RemoteKeys(ctx, ks); err == nil {
					r.UI.Say("remote.keys")
				} else {
					r.logf("remote access: the switch to keys failed: %v", err)
					r.UI.Raw(redact.Redact(err.Error()))
				}
			}
		}
	case 4:
		for _, l := range r.Log.All() {
			r.UI.Raw(l)
		}
	case 5:
		_ = r.Env.Reboot(ctx)
	case 6:
		_ = r.Env.PowerOff(ctx)
	}
}
