package core

import (
	"context"
	"os"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// Sample limits from the specification and a budget for the hashing work.
const (
	sampleFiles        = 20
	samplePool         = 80
	sampleMaxFileSize  = 256 << 20
	sampleBudgetBytes  = 1 << 30
	sampleMtimeSlackNs = int64(2 * time.Second)
)

// collectSample picks up to 20 random regular files from the snapshot and
// records their SHA-256, so the server can later prove a restore by restoring
// the same files and comparing. The hash is taken from the file on disk, but
// only for files that are provably unchanged since the snapshot saw them (same
// size and modification time, before and after hashing): a later mismatch
// then points at the backup, not at a file that was edited after it.
func (a *Agent) collectSample(rc *runContext, snapshotID string) []api.SampleFile {
	rl := rc.rl
	sctx, cancel := context.WithTimeout(rc.ctx, a.o.SampleTimeout)
	defer cancel()
	nodes, err := rc.runner.SampleFiles(sctx, snapshotID, restic.SampleOptions{
		Want: sampleFiles, Pool: samplePool, MaxFileSize: sampleMaxFileSize,
	})
	if err != nil {
		if rc.ctx.Err() == nil {
			rl.Warnf("Could not pick sample files for restore tests: %v", err)
		}
		return nil
	}
	sample := make([]api.SampleFile, 0, sampleFiles)
	budget := int64(sampleBudgetBytes)
	skipped := 0
	for _, n := range nodes {
		if len(sample) >= sampleFiles || sctx.Err() != nil {
			break
		}
		if int64(n.Size) > budget {
			skipped++
			continue
		}
		sf, ok := hashUnchanged(sctx.Done(), n)
		if !ok {
			skipped++
			continue
		}
		budget -= sf.Size
		sample = append(sample, sf)
	}
	switch {
	case len(sample) == 0:
		rl.Warnf("No sample files could be recorded for restore tests (%d candidates were unusable).", skipped)
	default:
		rl.Infof("Recorded SHA-256 of %d sample files for restore tests.", len(sample))
	}
	return sample
}

func hashUnchanged(done <-chan struct{}, n restic.Node) (api.SampleFile, bool) {
	local := snapshotToLocalPath(n.Path)
	before, err := os.Lstat(local)
	if err != nil || !before.Mode().IsRegular() || uint64(before.Size()) != n.Size {
		return api.SampleFile{}, false
	}
	if !n.ModTime.IsZero() {
		d := before.ModTime().UnixNano() - n.ModTime.UnixNano()
		if d < 0 {
			d = -d
		}
		if d > sampleMtimeSlackNs {
			return api.SampleFile{}, false
		}
	}
	sum, size, err := hashFile(local, done)
	if err != nil {
		return api.SampleFile{}, false
	}
	after, err := os.Lstat(local)
	if err != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) || size != before.Size() {
		return api.SampleFile{}, false
	}
	return api.SampleFile{Path: n.Path, SHA256: sum, Size: size}, true
}
