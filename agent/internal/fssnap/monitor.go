package fssnap

import (
	"context"
	"fmt"
	"time"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// Thresholds of the monitor (6.2).
const (
	MonitorInterval  = 30 * time.Second
	thinStopPercent  = 90.0
	thickStopPercent = 95.0
)

// Pressure is what the monitor found: the cause and the snapshot.
type Pressure struct {
	Err  error
	Path string
	Msg  string
}

// judge decides from `lvs` output whether a snapshot is in danger: a thin
// pool above 90 percent data or metadata, or a thick snapshot above 95
// percent or invalid (lv_attr 'I'). It is pure.
func judge(lvsJSON []byte, created []Created) *Pressure {
	rep, err := sysparse.ParseLVMFullReport(lvsJSON)
	if err != nil {
		return nil
	}
	rows := map[string]sysparse.LVMRow{}
	for _, r := range rep.LVs {
		rows[r["vg_name"]+"/"+r["lv_name"]] = r
	}
	for _, c := range created {
		if c.Method != MethodLVM {
			continue
		}
		path := c.VG + "/" + c.Origin
		if len(c.Sources) > 0 {
			path = c.Sources[0]
		}
		if c.Thin {
			pool, ok := rows[c.VG+"/"+c.Pool]
			if !ok {
				continue
			}
			d, _ := pool.Float("data_percent")
			m, _ := pool.Float("metadata_percent")
			if d > thinStopPercent || m > thinStopPercent {
				return &Pressure{Err: ErrThinPoolPressure, Path: path,
					Msg: fmt.Sprintf("the thin pool %s/%s is %.1f percent full (data) and %.1f percent (metadata)", c.VG, c.Pool, d, m)}
			}
			continue
		}
		row, ok := rows[c.VG+"/"+c.LV]
		if !ok {
			return &Pressure{Err: ErrSnapshotOverflow, Path: path, Msg: fmt.Sprintf("the snapshot %s/%s disappeared", c.VG, c.LV)}
		}
		attr := row["lv_attr"]
		snap, _ := row.Float("snap_percent")
		if snap > thickStopPercent || (len(attr) > 4 && attr[4] == 'I') {
			return &Pressure{Err: ErrSnapshotOverflow, Path: path, Msg: fmt.Sprintf("the snapshot %s/%s is %.1f percent full", c.VG, c.LV, snap)}
		}
	}
	return nil
}

// Watch checks the LVM snapshots every interval while restic runs and
// cancels with the cause when one is in danger. It returns when ctx ends;
// the result is the pressure found, if any.
func Watch(ctx context.Context, r cmdrun.Runner, created []Created, interval time.Duration, cancel context.CancelCauseFunc) *Pressure {
	lvm := false
	for _, c := range created {
		lvm = lvm || c.Method == MethodLVM
	}
	if !lvm {
		<-ctx.Done()
		return nil
	}
	if interval <= 0 {
		interval = MonitorInterval
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			argv := LVSMonitor()
			out, err := r.Run(ctx, argv[0], argv[1:]...)
			if err != nil {
				continue
			}
			if p := judge(out, created); p != nil {
				cancel(p.Err)
				return p
			}
		}
	}
}
