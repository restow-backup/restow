//go:build linux

package baremetal

import (
	"context"
	"os"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// CaptureLocal captures the layout of this machine: real tools, the real
// root file system and statfs.
func CaptureLocal(ctx context.Context, o Options) (*Manifest, RawSet, error) {
	if o.Runner == nil {
		o.Runner = cmdrun.ExecRunner{}
	}
	if o.Host == nil {
		o.Host = LocalHost()
	}
	return Capture(ctx, o)
}

// LocalHost is the root file system of this machine.
func LocalHost() Host {
	return DirHost{Root: "/", StatfsFn: func(p string) (Statfs, error) {
		var st syscall.Statfs_t
		if err := syscall.Statfs(p, &st); err != nil {
			return Statfs{}, err
		}
		return Statfs{Files: int64(st.Files), FilesFree: int64(st.Ffree)}, nil
	}}
}

// LocalStat triggers an automount by a stat in a goroutine (a hanging
// automount must not block the caller).
func LocalStat(ctx context.Context, p string) error {
	done := make(chan error, 1)
	go func() { _, err := os.Stat(p); done <- err }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
