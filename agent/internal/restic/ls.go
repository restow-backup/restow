package restic

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"strings"
)

// ErrStopLs may be returned by the Ls callback to end the listing early without an error.
var ErrStopLs = errors.New("stop listing")

// LsOptions are the options of LsWith.
type LsOptions struct {
	// NoLock lists without a lock (and without --retry-lock).
	NoLock bool
	// NoCache uses no local cache.
	NoCache bool
	// Recursive lists the paths below Paths too (--recursive).
	Recursive bool
	// Paths restrict the listing to these snapshot paths.
	Paths []string
}

// Ls lists every node of a snapshot (recursively) and calls fn for each. fn
// may return an error to stop; that error is returned.
func (r *Runner) Ls(ctx context.Context, snapshotID string, fn func(Node) error) error {
	return r.LsWith(ctx, snapshotID, LsOptions{}, fn)
}

// lsArgs is the argument vector of ls.
func lsArgs(snapshotID string, o LsOptions) []string {
	args := []string{"ls", "--json"}
	if o.NoLock {
		args = append(args, "--no-lock")
	} else {
		args = append(args, "--retry-lock", "5m")
	}
	if o.NoCache {
		args = append(args, "--no-cache")
	}
	if o.Recursive {
		args = append(args, "--recursive")
	}
	args = append(args, snapshotID)
	return append(args, o.Paths...)
}

// LsWith is Ls with options.
func (r *Runner) LsWith(ctx context.Context, snapshotID string, o LsOptions, fn func(Node) error) error {
	lctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var fnErr error
	xr, err := r.exec(lctx, execSpec{Command: "ls", Args: lsArgs(snapshotID, o),
		OnStdoutLine: func(line []byte) {
			if fnErr != nil || peekType(line) != msgNode {
				return
			}
			var n Node
			if json.Unmarshal(line, &n) != nil {
				return
			}
			if e := fn(n); e != nil {
				fnErr = e
				cancel()
			}
		}})
	if fnErr != nil {
		if errors.Is(fnErr, ErrStopLs) {
			return nil
		}
		return fnErr
	}
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if xr.ExitCode != 0 {
		return failure("ls", xr)
	}
	return nil
}

// SampleOptions controls SampleFiles.
type SampleOptions struct {
	// Want is the number of candidates to return (spec: 20).
	Want int
	// Pool is how many candidates are kept internally so that unusable ones
	// (changed since the backup) can be replaced. Default 4*Want.
	Pool int
	// MaxFileSize skips larger files (spec: 256 MiB).
	MaxFileSize uint64
	// Rand is the random source; nil selects a time-seeded one.
	Rand *rand.Rand
}

// SampleFiles picks random regular, non-empty files of a snapshot with a
// reservoir sample, so memory stays bounded for snapshots with millions of
// files. The result is in random order and may hold up to Pool entries.
func (r *Runner) SampleFiles(ctx context.Context, snapshotID string, o SampleOptions) ([]Node, error) {
	if o.Want <= 0 {
		return nil, nil
	}
	pool := o.Pool
	if pool < o.Want {
		pool = 4 * o.Want
	}
	rng := o.Rand
	if rng == nil {
		rng = rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64()))
	}
	res := NewReservoir(pool, rng)
	err := r.Ls(ctx, snapshotID, func(n Node) error {
		if EligibleForSample(n, o.MaxFileSize) {
			res.Offer(n)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res.Shuffled(), nil
}

// EligibleForSample reports whether a node may serve as a sample: a regular,
// non-empty file that is not larger than max (0 = no limit).
func EligibleForSample(n Node, max uint64) bool {
	if n.Type != "file" || n.Size == 0 || !strings.HasPrefix(n.Path, "/") {
		return false
	}
	return max == 0 || n.Size <= max
}

// Reservoir keeps a uniform random sample of the nodes offered to it
// (algorithm R).
type Reservoir struct {
	cap   int
	seen  int
	items []Node
	rng   *rand.Rand
}

// NewReservoir creates a reservoir of the given capacity.
func NewReservoir(capacity int, rng *rand.Rand) *Reservoir {
	return &Reservoir{cap: capacity, rng: rng}
}

// Offer considers one node.
func (r *Reservoir) Offer(n Node) {
	r.seen++
	if len(r.items) < r.cap {
		r.items = append(r.items, n)
		return
	}
	if j := r.rng.IntN(r.seen); j < r.cap {
		r.items[j] = n
	}
}

// Seen is the number of nodes offered.
func (r *Reservoir) Seen() int { return r.seen }

// Shuffled returns the kept nodes in random order.
func (r *Reservoir) Shuffled() []Node {
	out := append([]Node(nil), r.items...)
	r.rng.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}
