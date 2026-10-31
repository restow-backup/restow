package core

import (
	"context"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/activity"
	"github.com/restow-backup/restow/agent/internal/api"
)

// activityTimeout bounds the diff of two snapshots and the few reads after it.
const activityTimeout = 10 * time.Minute

// previousSnapshot is the snapshot of the last backup that made one, before
// this run: the one the changes are counted against.
func (a *Agent) previousSnapshot(current string) string {
	st := a.d.Status.Snapshot()
	if st.LastBackup == nil || st.LastBackup.Status == api.StatusFailed || st.LastBackup.SnapshotID == current {
		return ""
	}
	return st.LastBackup.SnapshotID
}

// underSources says whether a snapshot path lies below one of the folders
// this run backed up: a file of a folder that left the backup set is not
// "deleted".
func underSources(sources []string) func(string) bool {
	return underSourcesFor(sources, runtime.GOOS == "windows")
}

func underSourcesFor(sources []string, windows bool) func(string) bool {
	prefixes := make([]string, 0, len(sources))
	for _, s := range sources {
		p := strings.TrimRight(snapshotPathOf(s, windows), "/")
		prefixes = append(prefixes, p)
	}
	return func(p string) bool {
		for _, prefix := range prefixes {
			if p == prefix || strings.HasPrefix(p, prefix+"/") || prefix == "" {
				return true
			}
		}
		return false
	}
}

// collectActivity summarises what this backup changed against the previous
// snapshot for the server's ransomware signals (docs/RANSOMWARE.md): restic
// diff of the two snapshots (their metadata only) and the entropy of the first
// and last 64 KiB of a few new or changed files. Nothing here can fail the
// backup: without a previous snapshot, or when the diff does not work, no
// report is sent and the server says "not available".
func (a *Agent) collectActivity(rc *runContext, snapshotID string, sources []string) *activity.Report {
	previous := a.previousSnapshot(snapshotID)
	if previous == "" {
		return nil
	}
	actx, cancel := context.WithTimeout(rc.ctx, activityTimeout)
	defer cancel()
	c := activity.NewCollector(nil)
	c.Within = underSources(sources)
	if err := rc.runner.Diff(actx, previous, snapshotID, c.Add); err != nil {
		if rc.ctx.Err() == nil {
			rc.rl.Warnf("Could not compare this snapshot with the previous one for the ransomware check: %v", err)
		}
		return nil
	}
	samples := activity.MeasureAll(c.Candidates(), snapshotToLocalPath, func() bool { return actx.Err() != nil })
	r := c.Report(samples)
	rc.rl.Infof("Compared with snapshot %s: %d new, %d changed, %d deleted, %d renamed to another extension; %d files sampled.",
		shortID(previous), r.Added, r.Modified, r.Removed, r.Renamed, len(r.Entropy))
	return &r
}
