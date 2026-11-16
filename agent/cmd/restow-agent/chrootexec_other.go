//go:build !linux

package main

import (
	"fmt"
	"io"
)

func cmdChrootExec(_ []string, stderr io.Writer) int {
	fmt.Fprintln(stderr, "chroot-exec runs only on Linux")
	return exitUsage
}
