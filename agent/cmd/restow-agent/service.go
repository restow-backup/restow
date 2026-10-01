package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/svc"
)

func cmdService(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: restow-agent service install|start|stop|restart|status")
		return exitUsage
	}
	action := args[0]
	fs := newFlagSet("service "+action, stderr)
	if err := parseFlags(fs, args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if devLayout() {
		fmt.Fprintln(stderr, "RESTOW_AGENT_DIR is set (development layout): the system service is not touched.")
		return exitError
	}
	if action != "status" && !requireRoot("service "+action, stderr) {
		return exitError
	}
	m, err := svc.New()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	var opErr error
	switch action {
	case "install":
		// The service runs the binary as root: only from a location no other user can change.
		exe, err := paths.TrustedFile(executable())
		if err != nil {
			fmt.Fprintf(stderr, "The service is not installed: %v\n", err)
			return exitError
		}
		if exe != paths.InstalledAgentBinary() {
			fmt.Fprintf(stderr, "note: the agent binary is at %s, not at the standard location %s\n", exe, paths.InstalledAgentBinary())
		}
		opErr = m.Install(exe)
		if opErr == nil {
			fmt.Fprintf(stdout, "Installed the %s service for %s. It starts at boot.\n", m.Name(), exe)
		}
	case "start":
		opErr = m.Start()
		if opErr == nil {
			fmt.Fprintln(stdout, "Service started.")
		}
	case "stop":
		opErr = m.Stop()
		if opErr == nil {
			fmt.Fprintln(stdout, "Service stopped.")
		}
	case "restart":
		opErr = m.Restart()
		if opErr == nil {
			fmt.Fprintln(stdout, "Service restarted.")
		}
	case "status":
		info := m.Status()
		fmt.Fprintf(stdout, "%s: %s", m.Name(), info.State)
		if info.PID > 0 {
			fmt.Fprintf(stdout, " (pid %d)", info.PID)
		}
		if info.Detail != "" {
			fmt.Fprintf(stdout, " - %s", info.Detail)
		}
		fmt.Fprintln(stdout)
		if info.State != svc.Running {
			return exitError
		}
	default:
		fmt.Fprintf(stderr, "unknown service action %q (install|start|stop|restart|status)\n", action)
		return exitUsage
	}
	if opErr != nil {
		fmt.Fprintf(stderr, "service %s failed: %v\n", action, opErr)
		return exitError
	}
	return exitOK
}

func cmdUninstall(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("uninstall", stderr)
	yes := fs.Bool("yes", false, "do not ask for confirmation")
	keepLogs := fs.Bool("keep-logs", false, "keep the log directory")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if !requireRoot("uninstall", stderr) {
		return exitError
	}
	if !*yes && stdinIsTerminal() {
		fmt.Fprint(stdout, "Remove the Restow agent, its service and its stored credentials from this machine?\n"+
			"Backups already stored on the Restow instance are kept. [y/N] ")
		var answer string
		_, _ = fmt.Fscanln(os.Stdin, &answer)
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
			fmt.Fprintln(stdout, "Cancelled.")
			return exitOK
		}
	}
	layout := paths.Default()
	err := svc.Uninstall(svc.UninstallOptions{
		Layout: layout, KeepLogs: *keepLogs, SkipService: devLayout(), KeepBinaries: devLayout(), Out: stdout,
	})
	if err != nil {
		fmt.Fprintf(stderr, "Uninstall finished with problems: %v\n", err)
		return exitError
	}
	fmt.Fprintln(stdout, "The agent was removed from this machine.")
	fmt.Fprintln(stdout, "Backups stay on the Restow instance. Revoke this endpoint in the Restow UI (Endpoints) to finish the removal there.")
	return exitOK
}

func stdinIsTerminal() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
