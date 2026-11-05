package restic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
)

// ErrDumpTooLarge is returned by Dump when the file is larger than the cap.
var ErrDumpTooLarge = errors.New("the file in the snapshot is larger than allowed")

// DumpOptions are the options of Dump.
type DumpOptions struct {
	// NoLock reads without a lock (and without --retry-lock).
	NoLock bool
	// NoCache uses no local cache.
	NoCache bool
}

// DumpArgs is the argument vector of a dump of one file.
func DumpArgs(snapshot, path string, o DumpOptions) ([]string, error) {
	if snapshot == "" || !strings.HasPrefix(path, "/") || strings.ContainsRune(path, 0) || strings.HasPrefix(snapshot, "-") {
		return nil, fmt.Errorf("dump: invalid snapshot %q or path %q", snapshot, path)
	}
	args := []string{"dump"}
	if o.NoLock {
		args = append(args, "--no-lock")
	} else {
		args = append(args, "--retry-lock", "5m")
	}
	if o.NoCache {
		args = append(args, "--no-cache")
	}
	return append(args, snapshot, path), nil
}

// Dump writes one file of a snapshot to w, at most max bytes (max <= 0: no
// cap). A file larger than max gives ErrDumpTooLarge and w holds the first
// max bytes only.
func (r *Runner) Dump(ctx context.Context, snapshot, path string, w io.Writer, max int64, o DumpOptions) error {
	args, err := DumpArgs(snapshot, path, o)
	if err != nil {
		return err
	}
	cw := &dumpWriter{w: w, max: max}
	xr, err := r.exec(ctx, execSpec{Command: "dump", Args: args, RawStdout: cw})
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if cw.over {
		return fmt.Errorf("%s: %w (%d bytes)", path, ErrDumpTooLarge, max)
	}
	if cw.err != nil {
		return cw.err
	}
	if xr.ExitCode != 0 {
		return failure("dump", xr)
	}
	return nil
}

type dumpWriter struct {
	w    io.Writer
	max  int64
	n    int64
	over bool
	err  error
}

func (d *dumpWriter) Write(p []byte) (int, error) {
	if d.over || d.err != nil {
		return len(p), nil
	}
	q := p
	if d.max > 0 && d.n+int64(len(q)) > d.max {
		q = q[:d.max-d.n]
		d.over = true
	}
	if len(q) > 0 {
		if _, err := d.w.Write(q); err != nil {
			d.err = err
		}
		d.n += int64(len(q))
	}
	return len(p), nil
}
