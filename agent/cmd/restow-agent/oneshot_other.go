//go:build !linux

package main

import (
	"fmt"
	"io"
)

func cmdOneshot(_ []string, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "oneshot runs only on Linux (a fresh x86_64 machine)")
	return exitUsage
}
