package share

import (
	"context"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/activity"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// activityTimeout bounds the diff of the parent and the new snapshot and the
// few reads after it.
const activityTimeout = 10 * time.Minute

// activity summarises what the backup changed against its parent for the
// server's ransomware signals (docs/RANSOMWARE.md): restic diff of the two
// snapshots (metadata only) and the entropy of the first and last 64 KiB of
// a few new or changed files on the share. The runner's own files are left
// out, and a removed file counts only below the folders backed up now.
// Nothing here can fail the backup: nil when there is nothing to compare or
// the diff does not work.
func (j *job) activity(ctx context.Context, parent, snapshot string, paths []string) *activity.Report {
	if parent == "" || snapshot == "" || parent == snapshot {
		return nil
	}
	actx, cancel := context.WithTimeout(ctx, activityTimeout)
	defer cancel()
	meta := strings.TrimRight(j.cfg.MetaDir, "/")
	c := activity.NewCollector(j.cfg.Rand)
	c.Skip = func(p string) bool { return p == meta || strings.HasPrefix(p, meta+"/") }
	c.Within = func(p string) bool {
		for _, root := range paths {
			root = strings.TrimRight(root, "/")
			if p == root || strings.HasPrefix(p, root+"/") {
				return true
			}
		}
		return false
	}
	res, err := j.restic.Command(actx, restic.CommandOptions{Name: "diff", Args: restic.DiffArgs(parent, snapshot),
		OnStdoutLine: func(line []byte) {
			if ch, ok := restic.ParseDiffChange(line); ok {
				c.Add(ch)
			}
		}})
	if err == nil {
		if e := res.Err(); e != nil {
			err = e
		}
	}
	if err != nil {
		if ctx.Err() == nil {
			j.log.Printf("the snapshot could not be compared with its parent for the ransomware check: %v", err)
		}
		return nil
	}
	samples := activity.MeasureAll(c.Candidates(), func(p string) string { return p },
		func() bool { return actx.Err() != nil })
	r := c.Report(samples)
	j.log.Printf("compared with the parent: %d new, %d changed, %d deleted, %d renamed to another extension; %d files sampled",
		r.Added, r.Modified, r.Removed, r.Renamed, len(r.Entropy))
	return &r
}
