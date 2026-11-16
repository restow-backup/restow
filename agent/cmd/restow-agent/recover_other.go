//go:build !linux

package main

import (
	"fmt"
	"io"
)

func cmdRecover(_ []string, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "recover runs only on Linux (the Restow recovery ISO)")
	return exitUsage
}
