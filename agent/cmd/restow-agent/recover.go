//go:build linux

package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/restow-backup/restow/agent/internal/recovery"
)

// cmdRecover is restow-agent recover, the bare-metal restore on the
// recovery ISO (docs/BAREMETAL.md 10). It runs as root and only on the
// ISO (/run/live/medium) unless --i-know-this-is-not-the-iso is given;
// --list-tools needs neither.
func cmdRecover(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("recover", flag.ContinueOnError)
	fs.SetOutput(stderr)
	console := fs.String("console", "", "console to run on (for example /dev/tty1); default: standard input and output")
	answers := fs.String("answers", "", "answers file for an unattended recovery (restow-answers-v1)")
	planOnly := fs.Bool("plan-only", false, "show the plan and change nothing")
	logFile := fs.String("log", "", "log file (default /run/restow-recovery/log/recover.log)")
	listTools := fs.Bool("list-tools", false, "list the programs recover calls and their Debian packages")
	resticBin := fs.String("restic", "", "restic binary (default /usr/lib/restow-recovery/restic)")
	notISO := fs.Bool("i-know-this-is-not-the-iso", false, "run outside the recovery ISO (tests)")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: restow-agent recover [--console <tty>] [--answers <file>] [--plan-only] [--log <file>] [--restic <path>] [--list-tools]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return exitUsage
	}
	if *listTools {
		if err := recovery.ListTools(stdout); err != nil {
			return exitError
		}
		return exitOK
	}
	return recovery.Main(recovery.MainOptions{Console: *console, AnswersFile: *answers, PlanOnly: *planOnly, LogFile: *logFile,
		ResticBin: *resticBin, NotISO: *notISO, Stdin: os.Stdin, Stdout: stdout, Stderr: stderr})
}
