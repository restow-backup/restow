//go:build linux

package recovery

import (
	"context"
	"io"
	"os"
	"strings"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// LinuxVerifyEnv is VerifyEnv on the ISO.
type LinuxVerifyEnv struct {
	EFI EFIVars
	HW  *HardwareCollector
}

// Exists implements VerifyEnv.
func (e LinuxVerifyEnv) Exists(dev string) bool { _, err := os.Stat(dev); return err == nil }

// Statfs implements VerifyEnv.
func (e LinuxVerifyEnv) Statfs(p string) (int64, int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0, 0, err
	}
	return int64(st.Bavail) * st.Bsize, int64(st.Blocks) * st.Bsize, nil
}

// BootOrder implements VerifyEnv.
func (e LinuxVerifyEnv) BootOrder() []int64 { return e.EFI.BootOrder() }

// BootEntries implements VerifyEnv.
func (e LinuxVerifyEnv) BootEntries() map[int]baremetal.LoadOption { return e.EFI.BootEntries() }

// ReadHead implements VerifyEnv.
func (e LinuxVerifyEnv) ReadHead(dev string, n int) ([]byte, error) {
	f, err := os.Open(dev)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b := make([]byte, n)
	_, err = io.ReadFull(f, b)
	return b, err
}

// Signatures implements VerifyEnv.
func (e LinuxVerifyEnv) Signatures(ctx context.Context, dev string) []baremetal.TargetSignature {
	if e.HW == nil {
		return nil
	}
	return e.HW.signatures(ctx, strings.TrimPrefix(dev, "/dev/"))
}

// Shutdown prepares the restart (10.17): sync, flush the target disks,
// unmount everything, close the LUKS volumes.
func (x *Executor) Shutdown(ctx context.Context, ops *LinuxOps, disks []string) {
	ops.Flush(ctx, disks)
	if err := ops.UnmountAll(ctx, x.TargetRoot); err != nil {
		x.log("unmount: %v", err)
	}
	for i := len(x.opened) - 1; i >= 0; i-- {
		if _, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"cryptsetup", "close", x.opened[i]}, NoKill: true}); err != nil {
			x.log("close %s: %v", x.opened[i], err)
		}
	}
}
