//go:build !linux

package fssnap

import (
	"context"
	"io"
	"time"
)

// ExecHelper exists on Linux only; elsewhere every call fails.
type ExecHelper struct {
	AgentBin string
	TmpDir   string
	Timeout  time.Duration
}

// WriteSpec is not supported outside Linux.
func (e ExecHelper) WriteSpec(Spec) (string, func(), error) { return "", func() {}, ErrNoHelper }

// Run is not supported outside Linux.
func (e ExecHelper) Run(context.Context, Spec, []string) ([]byte, error) { return nil, ErrNoHelper }

// Measure is not supported outside Linux.
func (e ExecHelper) Measure(context.Context, Spec, MeasureRequest) (MeasureResponse, error) {
	return MeasureResponse{}, ErrNoHelper
}

// Probe is not supported outside Linux.
func (e ExecHelper) Probe(context.Context) error { return ErrNoHelper }

// RunHelper is the helper process; Linux only.
func RunHelper(Spec, []string, bool, io.Reader, io.Writer) error { return ErrNoHelper }
