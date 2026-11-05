//go:build !linux

package main

import (
	"fmt"
	"io"
)

// cmdSnapshotExec is the Linux snapshot helper; elsewhere it does nothing.
func cmdSnapshotExec(_ []string, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "snapshot-exec: not supported on this system")
	return exitUsage
}
