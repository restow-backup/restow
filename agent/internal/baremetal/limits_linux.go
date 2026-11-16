//go:build linux

package baremetal

import (
	"runtime/debug"
	"syscall"
)

// Limits of the planner process (docs/BAREMETAL.md 10.1, 12.2): the data
// segment to 512 MiB and the CPU time to 30 s, and the Go heap goal below
// that. RLIMIT_DATA, not RLIMIT_AS: a Go binary reserves far more address
// space than it uses and does not start under an address space limit of
// 512 MiB ("failed to reserve page summary memory").
const (
	plannerDataLimit   = 512 << 20
	plannerCPUSeconds  = 30
	plannerMemoryLimit = 384 << 20
)

// SetPlannerLimits limits the running process for `baremetal plan`.
func SetPlannerLimits() error {
	debug.SetMemoryLimit(plannerMemoryLimit)
	if err := lower(syscall.RLIMIT_DATA, plannerDataLimit); err != nil {
		return err
	}
	return lower(syscall.RLIMIT_CPU, plannerCPUSeconds)
}

// lower sets the soft and hard limit to v unless they are lower already.
func lower(resource int, v uint64) error {
	var cur syscall.Rlimit
	if err := syscall.Getrlimit(resource, &cur); err != nil {
		return err
	}
	if cur.Max < v {
		v = cur.Max
	}
	if cur.Cur <= v && cur.Max <= v {
		return nil
	}
	return syscall.Setrlimit(resource, &syscall.Rlimit{Cur: min(cur.Cur, v), Max: v})
}
