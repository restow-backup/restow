package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"os"
	"runtime"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/eventlog"
	"github.com/restow-backup/restow/agent/internal/logging"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/update"
)

// stderrIsTerminal reports whether stderr is a terminal.
func stderrIsTerminal() bool {
	fi, err := os.Stderr.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func cmdRun(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("run", stderr)
	debug := fs.Bool("debug", false, "verbose logging")
	service := fs.Bool("service", false, "run as the Windows service RestowAgent (the service control manager starts it this way)")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if *service {
		return runService(debugEnabled(*debug), stderr)
	}
	if !requireRoot("run", stderr) {
		return exitError
	}
	ctx, cancel := signalContext()
	defer cancel()
	code, _ := runAgent(ctx, debugEnabled(*debug), false)
	return code
}

// exitRestart is returned internally when the service manager has to start
// the agent again (Windows: the service ends with the service-specific code 3
// and the failure action restarts it). It never leaves the process.
const exitRestart = -1

// runAgent is the service: it waits for an enrollment and runs the engine
// until ctx ends. restart reports that the service manager must start the
// agent again (after a self-update); systemd and launchd do that on any exit,
// the Windows service control manager only after a failure.
func runAgent(ctx context.Context, debug, inService bool) (code int, restart bool) {
	layout := paths.Default()
	// stderr goes to journald under systemd and to a terminal when run by
	// hand. Under launchd it is a file without rotation, and a Windows
	// service has none, so only the rotating agent log is written there.
	toStderr := !inService && (stderrIsTerminal() || os.Getenv("INVOCATION_ID") != "")
	logger, closeLog := logging.Setup(logging.Options{LogFile: layout.LogFile(), Stderr: toStderr, Debug: debug})
	defer closeLog()
	if inService && !serviceConsole {
		logger.Warn("the service has no console; a cancelled backup stops restic hard instead of asking it to stop (its repository lock then expires on its own)")
	}

	// The agent runs as root: first make sure it runs from the root-owned
	// location and that nobody else can change its files (moving an earlier
	// pre-release installation if needed). Development layouts run from anywhere.
	if !devLayout() {
		update.CleanupStaged(paths.BinDir())
		if exit, code := ensureInstallation(ctx, layout, logger); exit {
			if code == exitRestart {
				return exitOK, true
			}
			return code, false
		}
	}

	st := waitForEnrollment(ctx, layout, logger)
	if st == nil {
		return exitOK, false
	}
	if st.AllowInsecureHTTP {
		logger.Warn("this agent is enrolled with --allow-insecure-http: traffic is NOT encrypted; use this for development only")
	}
	uninstall := func(ctx context.Context) error {
		// Windows keeps the logs of a removal by a server task: otherwise the
		// task would delete the only local trace (docs/WINDOWS-AGENT.md, 9.4).
		eventlog.Info(eventlog.IDUninstalled, "The Restow agent was uninstalled by a task of the Restow server "+st.ServerURL+".")
		return svc.Uninstall(svc.UninstallOptions{Layout: layout, FromService: true, SkipService: devLayout(), KeepBinaries: devLayout(),
			KeepLogs: runtime.GOOS == "windows", Out: logWriter{logger}})
	}
	if err := layout.Ensure(); err != nil {
		logger.Error("cannot create the agent directories", "error", err)
		return exitError, false
	}
	// A missing restic binary or a bad URL is repairable (re-run the install
	// script): wait and retry instead of exiting into a restart loop.
	var a *core.Agent
	for {
		var err error
		if a, err = buildAgent(layout, st, logger, true, uninstall); err == nil {
			break
		}
		logger.Error("the agent cannot start; retrying in 60 seconds", "error", err)
		select {
		case <-ctx.Done():
			return exitOK, false
		case <-time.After(time.Minute):
		}
	}
	logger.Info("restow-agent starting", "version", buildinfo.Version, "layout", layout.StateDir)
	switch err := a.Run(ctx); {
	case err == nil:
		return exitOK, false
	case errors.Is(err, core.ErrRestart):
		logger.Info("exiting so the service manager starts the updated agent")
		return exitOK, true
	case errors.Is(err, core.ErrUninstalled):
		logger.Info("the agent was removed from this machine")
		return exitOK, false
	default:
		logger.Error("the agent stopped with an error", "error", err)
		return exitError, false
	}
}

// waitForEnrollment returns the enrollment state, waiting while the machine is
// not enrolled yet (the install script starts the service after enrolling, but
// a manual `enroll` may come later). It returns nil when ctx ends first.
func waitForEnrollment(ctx context.Context, layout paths.Layout, logger *slog.Logger) *state.State {
	warned := time.Time{}
	for {
		st, warnings, err := state.Load(layout.StateFile())
		for _, w := range warnings {
			logger.Warn(w)
		}
		if err == nil {
			registerSecrets(st)
			return st
		}
		if time.Since(warned) > 30*time.Minute || warned.IsZero() {
			if errors.Is(err, state.ErrNotEnrolled) {
				logger.Warn("this machine is not enrolled yet; waiting. Run the install command from the Restow UI (Endpoints) on this machine")
			} else {
				logger.Error("the enrollment state is unusable; waiting. Enroll again with a new token: restow-agent enroll --force", "error", err)
			}
			warned = time.Now()
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(30 * time.Second):
		}
	}
}

// logWriter adapts a logger to io.Writer for the uninstall output.
type logWriter struct{ l *slog.Logger }

func (w logWriter) Write(p []byte) (int, error) {
	w.l.Info("uninstall: " + string(p))
	return len(p), nil
}
