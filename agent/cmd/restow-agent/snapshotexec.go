//go:build linux

package main

import (
	"fmt"
	"io"
	"os"

	"github.com/restow-backup/restow/agent/internal/fssnap"
)

// cmdSnapshotExec is the hidden helper `restow-agent snapshot-exec --spec
// FILE [--measure] [-- argv]` (docs/BAREMETAL.md 6.3). The agent starts it
// in a new mount namespace; it builds the snapshot tree (or mounts btrfs
// top levels), then execs argv or measures files read from stdin. Not for
// manual use; it is not in the usage text.
func cmdSnapshotExec(args []string, stdout, stderr io.Writer) int {
	var specFile string
	measure := false
	var argv []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--spec":
			if i+1 >= len(args) {
				fmt.Fprintln(stderr, "snapshot-exec: --spec needs a file")
				return exitUsage
			}
			specFile = args[i+1]
			i++
		case "--measure":
			measure = true
		case "--":
			argv = args[i+1:]
			i = len(args)
		default:
			fmt.Fprintf(stderr, "snapshot-exec: unexpected argument %q\n", args[i])
			return exitUsage
		}
	}
	if specFile == "" || (!measure && len(argv) == 0) {
		fmt.Fprintln(stderr, "snapshot-exec: usage: snapshot-exec --spec FILE [--measure | -- command]")
		return exitUsage
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(stderr, "snapshot-exec: operation not permitted: the helper must run as root")
		return exitError
	}
	b, err := os.ReadFile(specFile)
	if err != nil {
		fmt.Fprintf(stderr, "snapshot-exec: %v\n", err)
		return exitError
	}
	spec, err := fssnap.DecodeSpec(b)
	if err != nil {
		fmt.Fprintf(stderr, "snapshot-exec: %v\n", err)
		return exitError
	}
	// RunHelper execs argv; it returns only on an error or after measuring.
	if err := fssnap.RunHelper(spec, argv, measure, os.Stdin, stdout); err != nil {
		fmt.Fprintf(stderr, "snapshot-exec: %v\n", err)
		return exitError
	}
	return exitOK
}
