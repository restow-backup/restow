// Command restow-agent is the endpoint backup agent of Restow. It runs on a
// server or a client machine, connects outbound over HTTPS to the Restow
// instance and backs the machine up with restic into a repository that the
// instance exposes in append-only mode.
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
)

const usage = `restow-agent %s

Usage: restow-agent <command> [options]

Commands:
  enroll       Enroll this machine (reads RESTOW_TOKEN and RESTOW_URL from the environment)
  run          Run the agent (this is what the service executes)
  status       Show the local state of the agent (no root needed)
  backup-now   Run a backup right now and wait for it
  service      Control the system service: install | start | stop | restart | status
  hooks        Show or set whether hooks from the Restow server run here: status | off | scripts | any
  uninstall    Remove the agent, its service and its local secrets from this machine
  version      Print the version

Options:
  --debug      Verbose logging (or RESTOW_DEBUG=1)

Run "restow-agent <command> -h" for the options of a command.
Documentation: agent/README.md in the Restow repository.
`

// Exit codes.
const (
	exitOK      = 0
	exitError   = 1
	exitUsage   = 2
	exitPartial = 3 // backup-now: snapshot created, some files were unreadable
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintf(stderr, usage, buildinfo.Version)
		return exitUsage
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "enroll":
		return cmdEnroll(rest, stdout, stderr)
	case "run":
		return cmdRun(rest, stdout, stderr)
	case "status":
		return cmdStatus(rest, stdout, stderr)
	case "backup-now":
		return cmdBackupNow(rest, stdout, stderr)
	case "service":
		return cmdService(rest, stdout, stderr)
	case "hooks":
		return cmdHooks(rest, stdout, stderr)
	case "uninstall":
		return cmdUninstall(rest, stdout, stderr)
	case "version", "--version", "-v":
		return cmdVersion(rest, stdout)
	case "help", "-h", "--help":
		fmt.Fprintf(stdout, usage, buildinfo.Version)
		return exitOK
	}
	fmt.Fprintf(stderr, "restow-agent: unknown command %q\n\n", cmd)
	fmt.Fprintf(stderr, usage, buildinfo.Version)
	return exitUsage
}

func cmdVersion(args []string, stdout io.Writer) int {
	if len(args) > 0 && (args[0] == "--short" || args[0] == "-s") {
		fmt.Fprintln(stdout, buildinfo.Version)
		return exitOK
	}
	fmt.Fprintln(stdout, buildinfo.Long())
	return exitOK
}
