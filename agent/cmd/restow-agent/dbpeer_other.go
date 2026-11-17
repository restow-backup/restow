//go:build !linux

package main

import (
	"context"
	"fmt"
	"io"

	"github.com/restow-backup/restow/agent/internal/api"
)

// dbPeer is the PostgreSQL socket sign-in of Linux; elsewhere there is none.
var dbPeer func(ctx context.Context, osUser string, spec api.DBProbeSpec) (*api.DBProbeResult, error)

// cmdDBProbePeer is the Linux helper; elsewhere it does nothing.
func cmdDBProbePeer(_ io.Reader, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "db-probe-peer: not supported on this system")
	return exitUsage
}
