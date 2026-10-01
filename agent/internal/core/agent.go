// Package core is the agent's engine: the service loop (heartbeat, config,
// scheduler, task dispatch, self-update) and the execution of backup, restore
// and sample-verification runs with reporting to the Restow instance.
package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/lock"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/power"
	"github.com/restow-backup/restow/agent/internal/release"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/schedule"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

// Sentinel results of Run.
var (
	// ErrRestart asks the caller to exit so the service manager starts the
	// updated binary.
	ErrRestart = errors.New("restart requested after a self-update")
	// ErrUninstalled means the agent removed itself on the server's request.
	ErrUninstalled = errors.New("the agent was uninstalled on the server's request")
)

// Server is the Restow instance as the engine needs it. *api.Client implements it.
type Server interface {
	BaseURL() string
	Config(ctx context.Context) (*api.Config, error)
	Heartbeat(ctx context.Context, req api.HeartbeatRequest) (*api.HeartbeatResponse, error)
	StartRun(ctx context.Context, req api.StartRunRequest) (api.Flex, error)
	SendProgress(ctx context.Context, runID api.Flex, p api.Progress) error
	FinishRun(ctx context.Context, runID api.Flex, f api.FinishRequest) error
	CheckUpdate(ctx context.Context) (*api.UpdateInfo, error)
	Download(ctx context.Context, rawURL string, w io.Writer, maxBytes int64) (string, error)
}

// Options tunes timings. The zero value selects the production defaults from
// the specification; tests shorten them.
type Options struct {
	HeartbeatInterval time.Duration // default 5 min
	HeartbeatJitter   time.Duration // default +-60 s
	// HeartbeatRetryBase is the first wait after a failed heartbeat (30 s);
	// it doubles up to 5 min while the server stays unreachable.
	HeartbeatRetryBase time.Duration
	Tick               time.Duration // scheduler resolution, default 30 s
	ConfigRefresh      time.Duration // default 1 h
	UpdateInterval     time.Duration // default 6 h
	ProgressInterval   time.Duration // default 10 s
	SampleTimeout      time.Duration // default 10 min
	// SelfUpdate enables GET /agent/v1/update polling.
	SelfUpdate bool
	// Now replaces the clock (tests).
	Now func() time.Time
}

func (o *Options) defaults() {
	if o.HeartbeatInterval == 0 {
		o.HeartbeatInterval = 5 * time.Minute
	}
	if o.HeartbeatJitter == 0 {
		o.HeartbeatJitter = 60 * time.Second
	}
	if o.HeartbeatRetryBase == 0 {
		o.HeartbeatRetryBase = 30 * time.Second
	}
	if o.Tick == 0 {
		o.Tick = 30 * time.Second
	}
	if o.ConfigRefresh == 0 {
		o.ConfigRefresh = time.Hour
	}
	if o.UpdateInterval == 0 {
		o.UpdateInterval = 6 * time.Hour
	}
	if o.ProgressInterval == 0 {
		o.ProgressInterval = 10 * time.Second
	}
	if o.SampleTimeout == 0 {
		o.SampleTimeout = 10 * time.Minute
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Deps are the collaborators of the engine.
type Deps struct {
	Layout paths.Layout
	State  *state.State
	Server Server
	Restic *restic.Runner
	Status *status.Store
	Logger *slog.Logger
	// Power reports the power source; nil selects power.Detect.
	Power func() power.Status
	// BinDir is where the self-update installs; empty selects the
	// root-owned install folder (tests point it elsewhere).
	BinDir string
	// UpdateKey verifies release signatures; nil selects the compiled-in key.
	UpdateKey *release.PublicKey
	// Uninstall removes the agent from this machine (service, files). It is
	// called for the uninstall task and may terminate the process.
	Uninstall func(ctx context.Context) error
}

const (
	triggerSchedule = "schedule"
	triggerTask     = "task"
	triggerCLI      = "cli"

	jobBackup  = "backup"
	jobRestore = "restore"
	jobVerify  = "verify_sample"
)

type job struct {
	kind     string
	trigger  string
	task     *api.Task
	attempts int
}

func (j job) taskID() api.Flex {
	if j.task == nil {
		return ""
	}
	return j.task.ID
}

// Agent runs the service loop.
type Agent struct {
	d   Deps
	o   Options
	log *slog.Logger
	out *outbox

	jobs chan job
	wake chan struct{}

	mu        sync.Mutex
	cfg       *api.Config
	sched     schedule.Config
	reachable bool
	busy      bool
	queued    int
	cancelJob context.CancelFunc
	resticVer string
	osVersion string
	uninstall bool
	restart   bool
	logSeen   map[string]time.Time

	// Loop-owned timers (only touched by the loop goroutine).
	nextHeartbeat     time.Time
	hbFailures        int
	nextConfigRefresh time.Time
	nextUpdateCheck   time.Time
	updateFailures    int
	lastTick          time.Time

	// testUpdateCheckAfterStart makes the first update check happen at once
	// instead of one minute after start (tests only).
	testUpdateCheckAfterStart bool
}

// New creates an agent.
func New(d Deps, o Options) *Agent {
	o.defaults()
	if d.Power == nil {
		d.Power = power.Detect
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	return &Agent{
		d: d, o: o, log: d.Logger,
		out:     &outbox{dir: d.Layout.OutboxDir(), logger: d.Logger},
		jobs:    make(chan job, 32),
		wake:    make(chan struct{}, 1),
		logSeen: map[string]time.Time{},
	}
}

func (a *Agent) now() time.Time { return a.o.Now() }

// Run blocks until ctx is cancelled (returns nil) or the agent has to leave:
// ErrRestart after a self-update, ErrUninstalled after an uninstall task.
func (a *Agent) Run(ctx context.Context) error {
	st := a.d.State
	a.osVersion = sysinfo.OSVersion()
	_ = a.d.Status.Update(func(s *status.Status) {
		s.PID = pidOf()
		s.AgentVersion = buildinfo.Version
		s.ServerURL = st.ServerURL
		s.EndpointID = st.EndpointID
		s.Profile = st.Profile
		s.Hostname = st.Hostname
		s.EnrolledAt = st.EnrolledAt
		s.Service = "starting"
	})
	if v, err := a.d.Restic.Version(ctx); err != nil {
		a.log.Error("restic is not usable; backups will fail until this is fixed", "error", err,
			"hint", "re-run the install script to repair the installation")
	} else {
		a.resticVer = v
		a.log.Info("agent started", "version", buildinfo.Version, "restic", v, "endpoint", st.EndpointID, "server", st.ServerURL)
	}

	a.recoverInterrupted(ctx)
	_ = a.d.Status.Update(func(s *status.Status) { s.Service = "idle" })

	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		a.worker(ctx)
	}()

	result := a.loop(ctx)

	close(a.jobs)
	<-workerDone
	if !errors.Is(result, ErrUninstalled) {
		// After an uninstall the directories are gone; do not recreate them.
		_ = a.d.Status.Update(func(s *status.Status) { s.Service = "stopped" })
	}
	a.log.Info("agent stopped")
	return result
}

// ---- main loop ------------------------------------------------------------

func (a *Agent) loop(ctx context.Context) error {
	now := a.now()
	a.lastTick = now
	a.nextUpdateCheck = now.Add(time.Minute)
	if a.testUpdateCheckAfterStart {
		a.nextUpdateCheck = now
	}
	// The configuration first, so the first heartbeat reports its version and
	// tasks that arrive with it find a configuration to work with.
	a.refreshConfig(ctx, "startup")
	a.doHeartbeat(ctx)
	a.checkSchedule(ctx)

	t := time.NewTicker(a.o.Tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-a.wake:
		}
		now = a.now()
		// A gap much longer than a tick means the machine was suspended (the
		// wall clock keeps running, timers do not): check the server right away.
		if now.Round(0).Sub(a.lastTick.Round(0)) > 3*a.o.Tick {
			a.log.Info("the system was suspended or the clock jumped; contacting the server now")
			a.nextHeartbeat = now
		}
		a.lastTick = now

		if !now.Before(a.nextHeartbeat) {
			a.doHeartbeat(ctx)
		}
		if a.currentConfig() == nil || !now.Before(a.nextConfigRefresh) {
			if a.isReachable() {
				a.refreshConfig(ctx, "periodic")
			}
		}
		a.checkSchedule(ctx)

		if a.uninstallRequested() {
			return a.performUninstall(ctx)
		}
		a.maybeUpdate(ctx)
		if a.restartRequested() {
			return ErrRestart
		}
	}
}

func (a *Agent) signalWake() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *Agent) isReachable() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reachable
}

func (a *Agent) setReachable(v bool) {
	a.mu.Lock()
	a.reachable = v
	a.mu.Unlock()
}

func (a *Agent) idle() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return !a.busy && a.queued == 0
}

// ensureConfig returns the cached configuration, fetching it when none is
// loaded yet (a task can arrive before the first fetch succeeded). It may
// return nil when the server cannot be reached.
func (a *Agent) ensureConfig(ctx context.Context) *api.Config {
	if cfg := a.currentConfig(); cfg != nil {
		return cfg
	}
	if fresh, err := a.fetchConfig(ctx); err == nil {
		a.applyConfig(fresh, "task")
		return fresh
	}
	return nil
}

func (a *Agent) currentConfig() *api.Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// logRateLimited logs at most once per period per key (repeated connection
// errors while offline would otherwise fill the log).
func (a *Agent) logRateLimited(key string, period time.Duration, level slog.Level, msg string, args ...any) {
	a.mu.Lock()
	last := a.logSeen[key]
	now := a.now()
	if !last.IsZero() && now.Sub(last) < period {
		a.mu.Unlock()
		a.log.Debug(msg, args...)
		return
	}
	a.logSeen[key] = now
	a.mu.Unlock()
	a.log.Log(context.Background(), level, msg, args...)
}

// noteServerError updates reachability and logs what to do about an error.
func (a *Agent) noteServerError(op string, err error) {
	if api.IsNetworkError(err) {
		a.setReachable(false)
	} else if api.IsServerReachable(err) {
		a.setReachable(true)
	}
	explain := api.Explain(err, a.d.State.ServerURL)
	a.logRateLimited("server-error:"+op+":"+explain, 30*time.Minute, slog.LevelWarn,
		fmt.Sprintf("%s failed: %s", op, explain))
	_ = a.d.Status.Update(func(s *status.Status) { s.LastError = fmt.Sprintf("%s: %s", op, explain) })
}

// ---- heartbeat ------------------------------------------------------------

func heartbeatRetryDelay(base time.Duration, failures int, err error) time.Duration {
	if api.IsAuthError(err) {
		return 15 * time.Minute
	}
	d := base << min(failures-1, 4)
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

func (a *Agent) jitter() time.Duration {
	j := a.o.HeartbeatJitter
	if j <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(2*j)+1)) - j
}

func (a *Agent) doHeartbeat(ctx context.Context) {
	hbState := "idle"
	if !a.idle() {
		hbState = "running"
	}
	a.mu.Lock()
	cfgVersion := api.Flex("0")
	if a.cfg != nil && a.cfg.ConfigVersion != "" {
		cfgVersion = a.cfg.ConfigVersion
	}
	a.mu.Unlock()
	mode, dir := a.hooksPolicy()
	req := api.HeartbeatRequest{
		AgentVersion: buildinfo.Version, OSVersion: a.osVersion, State: hbState,
		ConfigVersion: cfgVersion, Hooks: mode,
	}
	if mode == hooks.ModeScripts {
		req.HookScripts = hooks.ListScripts(dir)
	}
	if st := a.d.Status.Snapshot(); !st.NextRunAt.IsZero() {
		t := st.NextRunAt
		req.NextRunAt = &t
	}
	hctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	resp, err := a.d.Server.Heartbeat(hctx, req)
	now := a.now()
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		a.hbFailures++
		a.noteServerError("heartbeat", err)
		a.nextHeartbeat = now.Add(heartbeatRetryDelay(a.o.HeartbeatRetryBase, a.hbFailures, err))
		_ = a.d.Status.Update(func(s *status.Status) {
			s.Heartbeat = status.Heartbeat{At: now.UTC(), OK: false, Error: api.Explain(err, a.d.State.ServerURL)}
		})
		return
	}
	if a.hbFailures > 0 {
		a.log.Info("connection to the Restow instance restored")
	}
	a.hbFailures = 0
	a.setReachable(true)
	a.nextHeartbeat = now.Add(a.o.HeartbeatInterval + a.jitter())
	_ = a.d.Status.Update(func(s *status.Status) {
		s.Heartbeat = status.Heartbeat{At: now.UTC(), OK: true}
		s.LastError = ""
	})
	if n := a.out.flush(ctx, a.d.Server); n > 0 {
		a.log.Info("delivered run reports that were waiting in the outbox", "count", n)
	}
	a.dispatchTasks(ctx, resp.Tasks)
}

// hooksPolicy returns the machine's hook mode and hooks folder. The mode is
// read from state.json each time, so `restow-agent hooks ...` takes effect
// without a restart; without a readable file the enrollment in memory counts.
func (a *Agent) hooksPolicy() (string, string) {
	mode := a.d.State.Hooks
	if st, _, err := state.Load(a.d.Layout.StateFile()); err == nil {
		mode = st.Hooks
	}
	return hooks.NormalizeMode(mode), a.d.Layout.HooksDir()
}

// ---- configuration --------------------------------------------------------

func (a *Agent) fetchConfig(ctx context.Context) (*api.Config, error) {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cfg, err := a.d.Server.Config(cctx)
	if err != nil {
		return nil, err
	}
	if cfg.Profile == "" {
		cfg.Profile = a.d.State.Profile
	}
	if cfg.Profile == "" {
		cfg.Profile = api.ProfileServer
	}
	return cfg, nil
}

func (a *Agent) refreshConfig(ctx context.Context, why string) bool {
	cfg, err := a.fetchConfig(ctx)
	if err != nil {
		if ctx.Err() == nil {
			a.noteServerError("fetching the configuration", err)
		}
		a.nextConfigRefresh = a.now().Add(2 * time.Minute)
		return false
	}
	a.setReachable(true)
	a.applyConfig(cfg, why)
	a.nextConfigRefresh = a.now().Add(a.o.ConfigRefresh)
	return true
}

func (a *Agent) applyConfig(cfg *api.Config, why string) {
	jit := schedule.JitterFor(a.d.State.EndpointID, schedule.MaxDailyJitter)
	sc, warnings := schedule.FromAPI(cfg.Schedule, cfg.Profile, jit)
	for _, w := range warnings {
		a.log.Warn("configuration: " + w)
	}
	a.mu.Lock()
	changed := a.cfg == nil || a.cfg.ConfigVersion != cfg.ConfigVersion
	a.cfg, a.sched = cfg, sc
	a.mu.Unlock()
	if changed {
		a.log.Info("configuration loaded", "version", cfg.ConfigVersion.String(), "profile", cfg.Profile,
			"schedule", describe(sc), "paths", len(cfg.Paths), "reason", why)
	}
	_ = a.d.Status.Update(func(s *status.Status) {
		s.ConfigVersion = cfg.ConfigVersion.String()
		s.Schedule = describe(sc)
		s.Profile = cfg.Profile
	})
}

func describe(sc schedule.Config) string {
	switch sc.Kind {
	case api.ScheduleInterval:
		return fmt.Sprintf("every %s", sc.Interval)
	case api.ScheduleDaily:
		h := int(sc.TimeOfDay / time.Hour)
		m := int((sc.TimeOfDay % time.Hour) / time.Minute)
		return fmt.Sprintf("daily at %02d:%02d %s", h, m, sc.Location)
	case api.ScheduleOnConnect:
		return fmt.Sprintf("on connect, at most once per %s", sc.Interval)
	}
	return sc.Kind
}

// ---- scheduling -----------------------------------------------------------

func (a *Agent) checkSchedule(ctx context.Context) {
	a.mu.Lock()
	cfg, sc, reachable := a.cfg, a.sched, a.reachable
	a.mu.Unlock()
	if cfg == nil {
		return
	}
	st := a.d.Status.Snapshot()
	hist := schedule.History{
		EnrolledAt:          a.d.State.EnrolledAt,
		LastAttemptAt:       st.LastAttemptAt,
		Interrupted:         st.Interrupted,
		ConsecutiveFailures: st.ConsecutiveFailures,
	}
	now := a.now()
	d := schedule.Evaluate(sc, hist, now, reachable)
	if !d.Next.Equal(st.NextRunAt) {
		_ = a.d.Status.Update(func(s *status.Status) { s.NextRunAt = d.Next })
	}
	if !d.Due || !a.idle() || ctx.Err() != nil {
		return
	}
	if cfg.OnlyOnACPower {
		if p := a.d.Power(); !p.OnAC {
			a.logRateLimited("battery", 30*time.Minute, slog.LevelInfo,
				"a backup is due but this device runs on battery power; waiting for AC power ("+p.Detail+")")
			return
		} else if !p.Known {
			a.logRateLimited("power-unknown", 24*time.Hour, slog.LevelWarn,
				"the power source cannot be determined on this system; assuming AC power ("+p.Detail+")")
		}
	}
	a.log.Info("starting a scheduled backup", "reason", d.Reason)
	a.enqueue(job{kind: jobBackup, trigger: triggerSchedule})
}

// ---- tasks ----------------------------------------------------------------

func (a *Agent) dispatchTasks(ctx context.Context, tasks []api.Task) {
	for i := range tasks {
		t := tasks[i]
		if t.ID != "" {
			known := false
			_ = a.d.Status.Update(func(s *status.Status) { known = !status.RememberTask(s, t.ID.String()) })
			if known {
				a.log.Info("ignoring a task that was already handled", "task", t.ID.String(), "kind", t.Kind)
				continue
			}
		}
		a.log.Info("task received", "task", t.ID.String(), "kind", t.Kind)
		switch t.Kind {
		case api.TaskBackupNow:
			a.enqueue(job{kind: jobBackup, trigger: triggerTask, task: &t})
		case api.TaskRestore:
			a.enqueue(job{kind: jobRestore, trigger: triggerTask, task: &t})
		case api.TaskVerifySample:
			a.enqueue(job{kind: jobVerify, trigger: triggerTask, task: &t})
		case api.TaskUpdateConfig:
			a.refreshConfig(ctx, "update_config task")
		case api.TaskUninstall:
			a.log.Warn("the Restow instance asked this agent to uninstall itself")
			a.mu.Lock()
			a.uninstall = true
			a.mu.Unlock()
		default:
			a.log.Warn("ignoring a task of an unknown kind (the agent may be older than the server)", "kind", t.Kind)
		}
	}
}

func (a *Agent) enqueue(j job) bool {
	a.mu.Lock()
	a.queued++
	a.mu.Unlock()
	select {
	case a.jobs <- j:
		return true
	default:
		a.mu.Lock()
		a.queued--
		a.mu.Unlock()
		a.log.Error("the job queue is full; dropping a job", "kind", j.kind)
		return false
	}
}

func (a *Agent) worker(ctx context.Context) {
	for j := range a.jobs {
		a.mu.Lock()
		a.queued--
		a.busy = true
		jctx, cancel := context.WithCancel(ctx)
		a.cancelJob = cancel
		a.mu.Unlock()

		a.execute(jctx, j)

		cancel()
		a.mu.Lock()
		a.busy = false
		a.cancelJob = nil
		a.mu.Unlock()
		a.signalWake()
	}
}

func (a *Agent) execute(ctx context.Context, j job) {
	if ctx.Err() != nil {
		return
	}
	// One run at a time per machine: `backup-now` in a terminal holds the same lock.
	lk, err := lock.TryAcquire(a.d.Layout.LockFile())
	if err != nil {
		if !errors.Is(err, lock.ErrLocked) {
			a.log.Error("cannot take the run lock", "error", err)
			return
		}
		if j.trigger == triggerSchedule || j.attempts >= 40 {
			a.log.Info("another run is in progress on this machine; skipping this start", "kind", j.kind)
			return
		}
		j.attempts++
		a.log.Info("another run is in progress on this machine; the task waits", "kind", j.kind)
		time.AfterFunc(30*time.Second, func() { a.enqueue(j); a.signalWake() })
		return
	}
	defer lk.Release()
	switch j.kind {
	case jobBackup:
		a.runBackup(ctx, j)
	case jobRestore:
		a.runRestore(ctx, j)
	case jobVerify:
		a.runVerify(ctx, j)
	}
}

// ---- uninstall and update -------------------------------------------------

func (a *Agent) uninstallRequested() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.uninstall
}

func (a *Agent) restartRequested() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.restart
}

func (a *Agent) performUninstall(ctx context.Context) error {
	a.mu.Lock()
	cancel := a.cancelJob
	a.mu.Unlock()
	if cancel != nil {
		a.log.Info("stopping the running job before uninstalling")
		cancel()
	}
	deadline := time.Now().Add(2 * time.Minute)
	for !a.idle() && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	if a.d.Uninstall == nil {
		a.log.Error("uninstall requested but no uninstaller is configured")
		return nil
	}
	if err := a.d.Uninstall(context.WithoutCancel(ctx)); err != nil {
		a.log.Error("uninstall failed; run `restow-agent uninstall` on the machine", "error", err)
		a.mu.Lock()
		a.uninstall = false
		a.mu.Unlock()
		return nil
	}
	return ErrUninstalled
}

func (a *Agent) maybeUpdate(ctx context.Context) {
	if !a.o.SelfUpdate || ctx.Err() != nil {
		return
	}
	now := a.now()
	if now.Before(a.nextUpdateCheck) || !a.idle() || !a.isReachable() {
		return
	}
	a.nextUpdateCheck = now.Add(a.o.UpdateInterval)
	if err := a.tryUpdate(ctx); err != nil {
		a.updateFailures++
		a.nextUpdateCheck = now.Add(time.Hour)
		a.logRateLimited("update-error", 6*time.Hour, slog.LevelWarn, "agent self-update failed: "+err.Error())
	}
}
