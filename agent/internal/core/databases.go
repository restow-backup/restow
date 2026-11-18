package core

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
	"github.com/restow-backup/restow/agent/internal/dbrun"
)

// The module "Databases" in the engine (docs/DATABASES.md, stage D1): the
// task db_probe (a connection test for the server) and the inventory of the
// database instances on this machine for the heartbeat. Neither waits for a
// running backup: a test runs beside it, bounded by its own timeout.

// DBProber is what a Server needs to run connection tests (api.Client has it).
type DBProber interface {
	FetchDBProbe(ctx context.Context, probeID string) (*api.DBProbeSpec, error)
	FinishDBProbe(ctx context.Context, probeID string, result api.DBProbeResult) error
}

// DBHealthReporter is what a Server needs for the health checks (api.Client has it).
type DBHealthReporter interface {
	FetchDBHealth(ctx context.Context, taskID string) (*api.DBHealthPlan, error)
	ReportDBHealth(ctx context.Context, taskID string, samples []api.DBHealthSample) error
}

// DBRunReporter is what a Server needs for backup and restore runs (api.Client has it).
type DBRunReporter interface {
	FetchDBRun(ctx context.Context, runID string) (*api.DBRunSpec, error)
	FinishDBRun(ctx context.Context, runID string, finish api.DBRunFinish) error
	StreamDBRunDump(ctx context.Context, runID string, w io.Writer) error
}

// dbRunMax bounds one backup or restore run, whatever the server says.
const dbRunMax = 24 * time.Hour

// runDBRun runs a backup or restore run (docs/DATABASES.md 4.3, 16 "D3"):
// it fetches the run with its credentials and restic access once, runs it
// (internal/dbrun: every connection pinned, the programs only through the
// relay, the password in a PGPASSFILE in memory) and reports the outcome.
// The credentials stay in this goroutine's memory; a log line names the run
// and the code only.
func (a *Agent) runDBRun(ctx context.Context, t api.Task) {
	var params api.DBRunTaskParams
	if err := json.Unmarshal(t.Params, &params); err != nil || params.RunID == "" {
		a.log.Warn("ignoring a database run without a run id", "task", t.ID.String())
		return
	}
	srv, ok := a.d.Server.(DBRunReporter)
	if !ok || a.d.Restic == nil {
		a.log.Warn("this agent cannot run database backups", "task", t.ID.String())
		return
	}
	go func() {
		rctx, cancel := context.WithTimeout(ctx, dbRunMax)
		defer cancel()
		spec, err := srv.FetchDBRun(rctx, params.RunID)
		if err != nil {
			a.log.Warn("could not fetch the database run", "run", params.RunID, "error", err)
			return
		}
		self, err := os.Executable()
		if err != nil {
			self = os.Args[0]
		}
		deps := dbrun.Deps{Restic: *a.d.Restic, Self: self, ReadDump: func(ctx context.Context, w io.Writer) error {
			return srv.StreamDBRunDump(ctx, params.RunID, w)
		}}
		var report api.DBRunFinish
		if spec.Kind == "restore" {
			report = dbrun.Restore(rctx, spec, deps)
		} else {
			report = dbrun.Backup(rctx, spec, deps)
		}
		spec.Connection.User, spec.Connection.Password = nil, nil
		if spec.Repository != nil {
			spec.Repository.Password, spec.Repository.RepositoryPassword = "", ""
		}
		code := ""
		if report.Error != nil {
			code = report.Error.Code
		}
		a.log.Info("database run done", "run", params.RunID, "kind", spec.Kind, "status", report.Status, "code", code)
		if err := srv.FinishDBRun(rctx, params.RunID, report); err != nil {
			a.log.Warn("could not report the database run", "run", params.RunID, "error", err)
		}
	}()
}

// dbHealthMaxWindow bounds how long one db_health task runs, whatever the
// server says: its credentials stay in memory no longer than this.
const dbHealthMaxWindow = 10 * time.Minute

// dbInventoryInterval: the inventory runs at most this often (3.4).
const dbInventoryInterval = 6 * time.Hour

// dbProbe runs one test (Deps.DBProbe in tests).
func (a *Agent) dbProbe(ctx context.Context, spec api.DBProbeSpec) api.DBProbeResult {
	if a.d.DBProbe != nil {
		return a.d.DBProbe(ctx, spec)
	}
	return dbprobe.Run(ctx, spec, dbprobe.Options{Peer: a.d.DBPeer})
}

// runDBProbe fetches the test with its credentials (once), runs it and posts
// the facts. The credentials stay in this goroutine's memory.
func (a *Agent) runDBProbe(ctx context.Context, t api.Task) {
	var params api.DBProbeTaskParams
	if err := json.Unmarshal(t.Params, &params); err != nil || params.ProbeID == "" {
		a.log.Warn("ignoring a database test without a probe id", "task", t.ID.String())
		return
	}
	srv, ok := a.d.Server.(DBProber)
	if !ok {
		a.log.Warn("this agent cannot fetch database tests", "task", t.ID.String())
		return
	}
	go func() {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		spec, err := srv.FetchDBProbe(pctx, params.ProbeID)
		if err != nil {
			a.log.Warn("could not fetch the database test", "probe", params.ProbeID, "error", err)
			return
		}
		result := a.dbProbe(pctx, *spec)
		spec.Password, spec.User = nil, nil
		code := ""
		if result.Error != nil {
			code = result.Error.Code
		}
		a.log.Info("database test done", "probe", params.ProbeID, "engine", deref(result.Engine), "login", result.Login, "code", code)
		if err := srv.FinishDBProbe(pctx, params.ProbeID, result); err != nil {
			a.log.Warn("could not report the database test", "probe", params.ProbeID, "error", err)
		}
	}()
}

// dbHealth runs one health check (Deps.DBHealth in tests).
func (a *Agent) dbHealth(ctx context.Context, spec api.DBProbeSpec) api.DBProbeResult {
	if a.d.DBHealth != nil {
		return a.d.DBHealth(ctx, spec)
	}
	return dbprobe.Health(ctx, spec, dbprobe.Options{Peer: a.d.DBPeer})
}

// runDBHealth runs the health checks of a db_health task (docs/DATABASES.md
// 8): it fetches them with their credentials once, runs each connection when
// due and then at its interval until the task's window ends or a newer task
// replaces it, and posts every sample as it comes. A check cut short by a
// newer task is not reported (it proves nothing about the database). The
// credentials stay in this goroutine's memory and are dropped at the end;
// a log line names the connection and the code only.
func (a *Agent) runDBHealth(ctx context.Context, t api.Task) {
	srv, ok := a.d.Server.(DBHealthReporter)
	if !ok {
		a.log.Warn("this agent cannot fetch database health checks", "task", t.ID.String())
		return
	}
	hctx, stop := context.WithCancel(ctx)
	a.mu.Lock()
	if a.dbHealthStop != nil {
		a.dbHealthStop()
	}
	a.dbHealthStop = stop
	a.mu.Unlock()
	taskID := t.ID.String()
	go func() {
		defer stop()
		plan, err := srv.FetchDBHealth(hctx, taskID)
		if err != nil {
			if hctx.Err() == nil {
				a.log.Warn("could not fetch the database health checks", "task", taskID, "error", err)
			}
			return
		}
		defer func() {
			for i := range plan.Checks {
				plan.Checks[i].Spec.User, plan.Checks[i].Spec.Password = nil, nil
			}
		}()
		window := time.Duration(plan.WindowSeconds) * time.Second
		if window <= 0 || window > dbHealthMaxWindow {
			window = dbHealthMaxWindow
		}
		wctx, cancel := context.WithTimeout(hctx, window)
		defer cancel()
		samples := make(chan api.DBHealthSample)
		var wg sync.WaitGroup
		for i := range plan.Checks {
			wg.Add(1)
			go func(check api.DBHealthCheck) {
				defer wg.Done()
				a.runHealthCheck(wctx, check, samples)
			}(plan.Checks[i])
		}
		go func() {
			wg.Wait()
			close(samples)
		}()
		for sample := range samples {
			// Posted on the agent's context: a sample taken stays worth sending
			// after a newer task took over.
			pctx, pcancel := context.WithTimeout(ctx, 30*time.Second)
			if err := srv.ReportDBHealth(pctx, taskID, []api.DBHealthSample{sample}); err != nil {
				a.log.Warn("could not report a database health check", "task", taskID, "connection", sample.ConnectionID, "error", err)
			}
			pcancel()
		}
	}()
}

// runHealthCheck runs one connection of a health task at its times.
func (a *Agent) runHealthCheck(ctx context.Context, check api.DBHealthCheck, out chan<- api.DBHealthSample) {
	interval := time.Duration(check.IntervalSeconds) * time.Second
	if interval < time.Minute {
		interval = time.Minute
	}
	next := time.Now().Add(time.Duration(check.FirstAfterSeconds) * time.Second)
	spec := check.Spec
	for {
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		// A check that could not finish before the window closes is left to the next task.
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < dbprobe.HealthTimeout {
			return
		}
		at := time.Now().UTC()
		result := a.dbHealth(ctx, spec)
		if ctx.Err() != nil {
			return
		}
		// The sizes are asked for once per task (at most hourly, the server decides).
		spec.Sizes = false
		if result.Error != nil {
			a.log.Info("database health check failed", "connection", check.ConnectionID, "code", result.Error.Code)
		}
		select {
		case out <- api.DBHealthSample{ConnectionID: check.ConnectionID, At: at, Result: result}:
		case <-ctx.Done():
			return
		}
		next = next.Add(interval)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// dbInventoryForHeartbeat returns the inventory when one is due (at start,
// then every 6 hours), nil otherwise. Linux only; the collection runs here,
// bounded by the programs' timeouts.
func (a *Agent) dbInventoryForHeartbeat(ctx context.Context) *api.DBInventory {
	collect := a.d.DBInventory
	if collect == nil {
		if runtime.GOOS != "linux" {
			return nil
		}
		collect = func(ctx context.Context) []api.DBInventoryInstance {
			return dbprobe.Inventory(ctx, dbprobe.SystemRunner, dbprobe.Options{})
		}
	}
	a.mu.Lock()
	due := a.dbInvAt.IsZero() || a.now().Sub(a.dbInvAt) >= dbInventoryInterval
	if due {
		a.dbInvAt = a.now()
	}
	a.mu.Unlock()
	if !due {
		return nil
	}
	instances := collect(ctx)
	if instances == nil {
		instances = []api.DBInventoryInstance{}
	}
	inv := &api.DBInventory{CollectedAt: a.now().UTC(), Instances: instances}
	for {
		b, err := json.Marshal(inv)
		if err != nil || len(b) <= api.MaxDBInventoryBytes || len(inv.Instances) == 0 {
			break
		}
		inv.Instances = inv.Instances[:len(inv.Instances)/2]
	}
	return inv
}
