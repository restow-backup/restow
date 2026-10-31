//go:build unix

package main

import (
	"fmt"
	"io"
)

// serviceConsole is only meaningful on Windows.
const serviceConsole = true

// inWindowsService is only meaningful on Windows.
const inWindowsService = false

// runService exists on Windows only; systemd and launchd run `restow-agent run`.
func runService(_ bool, stderr io.Writer) int {
	fmt.Fprintln(stderr, "--service is for the Windows service; systemd and launchd run `restow-agent run`")
	return exitUsage
}
