package fssnap

import (
	"context"
	"errors"

	"github.com/restow-backup/restow/agent/internal/activity"
)

// ErrNoHelper is returned when the namespace helper cannot run (not root,
// unshare refused, not Linux).
var ErrNoHelper = errors.New("the snapshot helper cannot run on this machine (it needs root and a private mount namespace)")

// Helper runs commands in a private mount namespace. ExecHelper (Linux)
// starts `restow-agent snapshot-exec`; tests use a fake.
type Helper interface {
	// Run mounts spec (plain) and runs argv; it returns argv's output.
	Run(ctx context.Context, spec Spec, argv []string) ([]byte, error)
	// Measure builds the tree (spec) and hashes and measures files in it.
	Measure(ctx context.Context, spec Spec, req MeasureRequest) (MeasureResponse, error)
	// Probe checks that the helper can run at all.
	Probe(ctx context.Context) error
}

// HelperArgv is the command line of the helper: the agent binary with the
// hidden command snapshot-exec, the spec file, then argv (restic and its
// arguments, or a btrfs command). Measure mode passes no argv.
func HelperArgv(agentBin, specFile string, argv []string) []string {
	out := []string{agentBin, "snapshot-exec", "--spec", specFile}
	if argv == nil {
		return append(out, "--measure")
	}
	return append(append(out, "--"), argv...)
}

// MeasureRequest asks the helper to hash and measure files in the tree.
type MeasureRequest struct {
	// Sample are files of the snapshot whose SHA-256 is recorded for the
	// restore tests (size as restic saw it).
	Sample []SampleFile `json:"sample"`
	// Activity are new or changed files whose entropy is measured.
	Activity []string `json:"activity"`
}

// SampleFile is a file to hash.
type SampleFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
}

// MeasureResponse is what the helper measured.
type MeasureResponse struct {
	Sample   []SampleFile      `json:"sample"`
	Activity []activity.Sample `json:"activity"`
}
