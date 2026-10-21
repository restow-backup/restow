package main

import (
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/update"
)

// restartService restarts the installed agent service so that it runs the new binary. It
// returns false (and no error) when the service is not running here, so there is nothing to
// restart. A variable for the tests.
var restartService = func() (bool, error) {
	if devLayout() {
		return false, nil
	}
	m, err := svc.New()
	if err != nil {
		return false, err
	}
	if m.Status().State != svc.Running {
		return false, nil
	}
	return true, m.Restart()
}

// cmdUpdate installs the release the Restow instance offers right now, the way the service's
// automatic self-update does (signed SHA256SUMS, every file checked against it), then restarts
// the service. It refuses while a backup, restore or restore test runs on this machine: the
// service installs the update on its own once it is idle.
func cmdUpdate(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("update", stderr)
	debug := fs.Bool("debug", false, "verbose logging")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if !requireRoot("update", stderr) {
		return exitError
	}
	layout := paths.Default()
	logger := stderrLogger(debugEnabled(*debug), stderr)
	st, err := loadEnrollment(layout, logger)
	if err != nil {
		if errors.Is(err, state.ErrNotEnrolled) {
			fmt.Fprintln(stderr, "This machine is not enrolled. Run the install command from the Restow UI first.")
		} else {
			fmt.Fprintf(stderr, "Cannot read the enrollment: %v\n", err)
		}
		return exitError
	}
	if err := layout.Ensure(); err != nil {
		fmt.Fprintf(stderr, "Cannot create the agent directories: %v\n", err)
		return exitError
	}
	a, err := buildAgent(layout, st, logger, false, nil)
	if err != nil {
		fmt.Fprintf(stderr, "Cannot update: %v\n", err)
		return exitError
	}
	ctx, cancel := signalContext()
	defer cancel()

	res, err := a.UpdateNow(ctx)
	if err != nil {
		switch {
		case errors.Is(err, core.ErrBusy):
			fmt.Fprintln(stderr, "A backup is running; the update waits. The service installs it on its own once the backup "+
				"(or restore) is done, or run restow-agent update again then. Check with: restow-agent status")
		case errors.Is(err, update.ErrDevBuild):
			fmt.Fprintf(stderr, "This is a development build (%s); it does not update itself.\n", buildinfo.Version)
		case errors.Is(err, update.ErrNoKey):
			fmt.Fprintf(stderr, "Cannot update: %v\n", err)
		case api.IsNetworkError(err) || api.IsServerReachable(err):
			fmt.Fprintf(stderr, "Cannot update: %s\n", api.Explain(err, st.ServerURL))
		default:
			fmt.Fprintf(stderr, "Update failed: %v\n", err)
		}
		return exitError
	}
	if res == nil {
		fmt.Fprintf(stdout, "No newer release is offered: restow-agent %s is up to date.\n", buildinfo.Version)
		return exitOK
	}
	extra := ""
	if res.ResticChanged {
		extra = " (restic updated as well)"
	}
	fmt.Fprintf(stdout, "Updated restow-agent from %s to %s%s, verified against the signed release.\n", buildinfo.Version, res.Version, extra)
	restarted, rerr := restartService()
	switch {
	case rerr != nil:
		fmt.Fprintf(stderr, "The service could not be restarted (%v). Restart it to run %s: restow-agent service restart\n", rerr, res.Version)
		return exitError
	case restarted:
		fmt.Fprintf(stdout, "Service restarted; it now runs %s.\n", res.Version)
	default:
		fmt.Fprintf(stdout, "The service is not running here; %s runs when it starts (restow-agent service start).\n", res.Version)
	}
	return exitOK
}
