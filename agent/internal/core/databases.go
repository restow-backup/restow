package core

import (
	"context"
	"encoding/json"
	"runtime"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
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
