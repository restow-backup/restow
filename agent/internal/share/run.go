package share

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// Config is the fixed environment of a run inside the runner container.
type Config struct {
	// Root is where the share is mounted (/share). restic records it under
	// the same name, so it is the snapshot path of the share root as well.
	Root string
	// MetaDir is the scratch volume (/.restow): the sidecar and the manifest.
	MetaDir string
	// TmpDir holds restic's temporary files and option files (/cache/tmp).
	TmpDir string
	// CacheDir is restic's cache (/cache/restic).
	CacheDir  string
	ResticBin string
	// GoMemLimit is passed on to restic (GOMEMLIMIT), e.g. "1638MiB".
	GoMemLimit string
	Sys        System
	Now        func() time.Time
	// Stdout receives the progress as JSON lines; Stderr the log.
	Stdout io.Writer
	Stderr io.Writer
	// ProgressInterval between two progress reports (5 s).
	ProgressInterval time.Duration
	Rand             *rand.Rand
	// Readers are the parallel directory readers of the walk (8).
	Readers int
}

// DefaultConfig is the runner container's layout (docs/FILESHARES.md 3.4).
func DefaultConfig() Config {
	return Config{
		Root: "/share", MetaDir: "/.restow", TmpDir: "/cache/tmp", CacheDir: "/cache/restic",
		ResticBin: "restic", Sys: OS(), Now: time.Now, Stdout: os.Stdout, Stderr: os.Stderr,
		ProgressInterval: 5 * time.Second, Readers: 8,
	}
}

func (c *Config) defaults() {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Stdout == nil {
		c.Stdout = io.Discard
	}
	if c.Stderr == nil {
		c.Stderr = io.Discard
	}
	if c.ProgressInterval <= 0 {
		c.ProgressInterval = 5 * time.Second
	}
	if c.Rand == nil {
		c.Rand = rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 11))
	}
	if c.Readers <= 0 {
		c.Readers = 8
	}
	if c.Sys == nil {
		c.Sys = OS()
	}
}

// runLog keeps the redacted log: every line goes to stderr and the last
// lines into the finish report's logTail.
type runLog struct {
	mu    sync.Mutex
	w     io.Writer
	red   *redact.Redactor
	lines []string
	now   func() time.Time
}

const logTailLines = 80

func (l *runLog) Printf(format string, args ...any) {
	line := l.red.Redact(fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.w, "%s %s\n", l.now().UTC().Format(time.RFC3339), line)
	l.lines = append(l.lines, line)
	if len(l.lines) > logTailLines {
		l.lines = l.lines[len(l.lines)-logTailLines:]
	}
}

func (l *runLog) Tail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	tail := strings.Join(l.lines, "\n")
	if len(tail) > 8000 {
		tail = tail[len(tail)-8000:]
	}
	return l.red.Redact(tail)
}

// reporter forwards progress (throttled), collects items and learns about a
// cancel from the progress answers.
type reporter struct {
	api      *Client
	cfg      *Config
	log      *runLog
	cancel   context.CancelFunc
	mu       sync.Mutex
	last     time.Time
	phase    string
	cur      ProgressReport
	pending  []Item
	counts   map[string]int
	sent     int
	canceled bool
}

const maxItemsSent = 10000

func newReporter(api *Client, cfg *Config, log *runLog, cancel context.CancelFunc) *reporter {
	return &reporter{api: api, cfg: cfg, log: log, cancel: cancel, counts: map[string]int{}}
}

func (r *reporter) Phase(ctx context.Context, phase string) {
	r.mu.Lock()
	r.phase = phase
	r.cur.Phase = phase
	r.mu.Unlock()
	r.flush(ctx, true)
}

// Update replaces the progress numbers and reports them when the interval passed.
func (r *reporter) Update(ctx context.Context, fn func(p *ProgressReport)) {
	r.mu.Lock()
	fn(&r.cur)
	r.cur.Phase = r.phase
	due := r.cfg.Now().Sub(r.last) >= r.cfg.ProgressInterval
	r.mu.Unlock()
	if due {
		r.flush(ctx, false)
	}
}

func (r *reporter) Item(it Item) {
	if len(it.Message) > 500 {
		it.Message = it.Message[:500]
	}
	it.Message = r.log.red.Redact(it.Message)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.counts[it.Code]++
	if r.sent+len(r.pending) < maxItemsSent {
		r.pending = append(r.pending, it)
	}
}

func (r *reporter) Count(code string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.counts[code]
}

func (r *reporter) Counts() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]int, len(r.counts))
	for k, v := range r.counts {
		out[k] = v
	}
	return out
}

func (r *reporter) Cancelled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.canceled
}

func (r *reporter) flush(ctx context.Context, force bool) {
	r.mu.Lock()
	if !force && r.cfg.Now().Sub(r.last) < r.cfg.ProgressInterval {
		r.mu.Unlock()
		return
	}
	r.last = r.cfg.Now()
	p := r.cur
	p.At = r.last.UTC()
	items := r.pending
	r.pending = nil
	r.sent += len(items)
	r.mu.Unlock()

	if b, err := json.Marshal(map[string]any{"progress": p}); err == nil {
		fmt.Fprintln(r.cfg.Stdout, string(b))
	}
	if r.api == nil {
		return
	}
	if len(items) > 0 {
		if err := r.api.Items(ctx, items); err != nil {
			r.log.Printf("could not send %d item(s): %v", len(items), err)
		}
	}
	cancel, err := r.api.Progress(ctx, p)
	if err != nil {
		r.log.Printf("could not report progress: %v", err)
		return
	}
	if cancel {
		r.mu.Lock()
		already := r.canceled
		r.canceled = true
		r.mu.Unlock()
		if !already {
			r.log.Printf("the run was cancelled in Restow; stopping")
			r.cancel()
		}
	}
}

// Outcome is what a backup or restore ended with.
type Outcome struct {
	Status     string
	Code       string
	Message    string
	SnapshotID string
	Stats      map[string]any
	Restore    *RestoreStats
	Exit       int
}

func failed(exit int, code, message string) Outcome {
	return Outcome{Status: StatusFailed, Code: code, Message: message, Exit: exit, Stats: map[string]any{}}
}

// Run executes one run: session, the backup or restore, finish. It returns
// the process exit code (4.8).
func Run(ctx context.Context, cfg Config, api *Client) int {
	cfg.defaults()
	red := &redact.Redactor{}
	red.Add(api.Token)
	log := &runLog{w: cfg.Stderr, red: red, now: cfg.Now}

	sessCtx, cancelSess := context.WithTimeout(ctx, 2*time.Minute)
	session, err := api.Session(sessCtx)
	cancelSess()
	if err != nil {
		log.Printf("the session could not be read: %v", err)
		return ExitUsage
	}
	red.Add(session.Repository.Password)
	log.Printf("restow-share run %s (%s) of share %s", session.Run.ID, session.Run.Kind, session.Run.ShareID)

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if !session.Run.Deadline.IsZero() {
		var cancelDeadline context.CancelFunc
		runCtx, cancelDeadline = context.WithDeadline(runCtx, session.Run.Deadline)
		defer cancelDeadline()
	}
	rep := newReporter(api, &cfg, log, cancel)
	rr := &restic.Runner{
		Bin: cfg.ResticBin, Repo: session.Repository.URL, Password: session.Repository.Password,
		RESTUser: api.RunID, RESTPass: api.Token, CacheDir: cfg.CacheDir, TmpDir: cfg.TmpDir,
		Log: func(line string) { log.Printf("restic: %s", line) },
	}
	if cfg.GoMemLimit != "" {
		rr.ExtraEnv = append(rr.ExtraEnv, "GOMEMLIMIT="+cfg.GoMemLimit)
	}
	j := &job{cfg: &cfg, s: session, rep: rep, log: log, restic: rr, api: api}

	var out Outcome
	if session.Run.Kind == "backup" {
		out = j.backup(runCtx)
	} else {
		out = j.restore(runCtx)
	}
	if rep.Cancelled() && out.Status != StatusSucceeded && out.Status != StatusWarning {
		out = Outcome{Status: StatusCancelled, Code: CodeCancelled, Message: "cancelled in Restow", Exit: ExitFailed,
			Stats: out.Stats, Restore: out.Restore}
	} else if errors.Is(runCtx.Err(), context.DeadlineExceeded) && out.Status == StatusFailed {
		out.Message = "the run passed its deadline: " + out.Message
	}
	// The last items and progress go out before the finish.
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelFinish()
	rep.Phase(finishCtx, PhaseFinalize)
	if out.Stats == nil {
		out.Stats = map[string]any{}
	}
	out.Stats["items"] = rep.Counts()
	log.Printf("finished: %s %s %s", out.Status, out.Code, out.Message)
	err = api.Finish(finishCtx, Finish{Status: out.Status, Code: out.Code, Message: red.Redact(out.Message),
		SnapshotID: out.SnapshotID, Stats: out.Stats, Restore: out.Restore, LogTail: log.Tail()})
	if err != nil {
		log.Printf("the finish report could not be sent: %v", err)
	}
	return out.Exit
}

// job is the state of one run.
type job struct {
	cfg    *Config
	s      *Session
	rep    *reporter
	log    *runLog
	restic *restic.Runner
	api    *Client
}

// resticFailure maps a failed restic invocation to an outcome.
func resticFailure(ctx context.Context, e *restic.Error) Outcome {
	if ctx.Err() != nil {
		return failed(ExitFailed, CodeCancelled, "stopped")
	}
	msg := e.Error()
	lower := strings.ToLower(msg + " " + strings.Join(e.Stderr, " "))
	switch {
	case e.ExitCode == restic.ExitRepoLocked:
		return failed(ExitFailed, CodeRepositoryLocked, msg)
	case strings.Contains(lower, "quota-exceeded") || strings.Contains(lower, "storage budget"):
		return failed(ExitFailed, CodeQuotaExceeded, msg)
	case e.ExitCode == restic.ExitNoRepository || e.ExitCode == restic.ExitWrongPassword:
		return failed(ExitFailed, CodeRepository, msg)
	}
	return failed(ExitFailed, CodeResticFailed, msg)
}
