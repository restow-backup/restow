package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/state"
)

const baremetalUsage = `Usage: restow-agent baremetal capture|plan
  baremetal capture [--raw-dir DIR] [--out FILE]
  baremetal plan --manifest FILE|- [--facts FILE|-] --target same|minimal|other-controller|FILE [--choices FILE] [--snapshot ID] [--json]`

// cmdBaremetal is `restow-agent baremetal capture|plan` (docs/BAREMETAL.md
// 4 and 10.1).
func cmdBaremetal(args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "plan" {
		return cmdBaremetalPlan(args[1:], planStdin, stdout, stderr)
	}
	if len(args) == 0 || args[0] != "capture" {
		fmt.Fprintln(stderr, baremetalUsage)
		return exitUsage
	}
	return cmdBaremetalCapture(args, stdout, stderr)
}

// cmdBaremetalCapture is `restow-agent baremetal capture [--raw-dir DIR]
// [--out FILE]` (Linux, preview): it captures the disk layout of this
// machine as a whole-machine backup does and prints the manifest
// (docs/BAREMETAL.md 4). Nothing is sent and nothing is backed up.
func cmdBaremetalCapture(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("baremetal capture", stderr)
	rawDir := fs.String("raw-dir", "", "also write the sanitized raw tool outputs (raw/) into this folder")
	outFile := fs.String("out", "", "write the manifest to this file instead of standard output")
	if err := parseFlags(fs, args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if runtime.GOOS != "linux" {
		fmt.Fprintln(stderr, "restow-agent baremetal: capturing the disk layout is not supported on this system (Linux only in this version).")
		return exitUsage
	}
	if !requireRoot("baremetal capture", stderr) {
		return exitError
	}
	hostname, _ := os.Hostname()
	if st, _, err := state.Load(paths.Default().StateFile()); err == nil && st.Hostname != "" {
		hostname = st.Hostname
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	m, raw, err := baremetal.CaptureLocal(ctx, baremetal.Options{Hostname: hostname, AgentVersion: buildinfo.Version})
	if err != nil {
		fmt.Fprintf(stderr, "restow-agent baremetal: %v\n", err)
		return exitError
	}
	b, err := m.Encode()
	if err != nil && !errors.Is(err, baremetal.ErrTooLarge) {
		fmt.Fprintf(stderr, "restow-agent baremetal: the manifest is not valid: %v\n", err)
		return exitError
	}
	if errors.Is(err, baremetal.ErrTooLarge) {
		fmt.Fprintf(stderr, "Warning: the manifest is %d bytes, more than the 512 KiB a Restow instance accepts.\n", len(b))
	}
	if *rawDir != "" {
		if err := os.MkdirAll(*rawDir, 0o700); err != nil {
			fmt.Fprintf(stderr, "restow-agent baremetal: %v\n", err)
			return exitError
		}
		for name, content := range raw {
			if err := os.WriteFile(filepath.Join(*rawDir, filepath.Base(name)), content, 0o600); err != nil {
				fmt.Fprintf(stderr, "restow-agent baremetal: %v\n", err)
				return exitError
			}
		}
	}
	if *outFile != "" {
		if err := os.WriteFile(*outFile, append(b, '\n'), 0o600); err != nil {
			fmt.Fprintf(stderr, "restow-agent baremetal: %v\n", err)
			return exitError
		}
	} else {
		fmt.Fprintln(stdout, string(b))
	}
	fmt.Fprintf(stderr, "Verdict: %s (%d findings).\n", m.Linux.Verdict, len(m.Linux.Unsupported))
	for _, u := range m.Linux.Unsupported {
		fmt.Fprintf(stderr, "  %s %s: %s\n", u.Severity, u.Code, u.Message)
	}
	return exitOK
}
