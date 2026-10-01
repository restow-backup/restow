package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/core"
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
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if !requireRoot("run", stderr) {
		return exitError
	}
	layout := paths.Default()
	// stderr goes to journald under systemd and to a terminal when run by
	// hand. Under launchd it is a file without rotation, so only the
	// rotating agent log is written there.
	toStderr := stderrIsTerminal() || os.Getenv("INVOCATION_ID") != ""
	logger, closeLog := logging.Setup(logging.Options{LogFile: layout.LogFile(), Stderr: toStderr, Debug: debugEnabled(*debug)})
	defer closeLog()

	ctx, cancel := signalContext()
	defer cancel()

	// The agent runs as root: first make sure it runs from the root-owned
	// location and that nobody else can change its files (moving an earlier
	// pre-release installation if needed). Development layouts run from anywhere.
	if !devLayout() {
		update.CleanupStaged(paths.BinDir())
		if exit, code := ensureInstallation(ctx, layout, logger); exit {
			return code
		}
	}

	st := waitForEnrollment(ctx, layout, logger)
	if st == nil {
		return exitOK
	}
	if st.AllowInsecureHTTP {
		logger.Warn("this agent is enrolled with --allow-insecure-http: traffic is NOT encrypted; use this for development only")
	}
	uninstall := func(ctx context.Context) error {
		return svc.Uninstall(svc.UninstallOptions{Layout: layout, FromService: true, SkipService: devLayout(), KeepBinaries: devLayout(),
			Out: logWriter{logger}})
	}
	if err := layout.Ensure(); err != nil {
		logger.Error("cannot create the agent directories", "error", err)
		return exitError
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
			return exitOK
		case <-time.After(time.Minute):
		}
	}
	logger.Info("restow-agent starting", "version", buildinfo.Version, "layout", layout.StateDir)
	switch err := a.Run(ctx); {
	case err == nil:
		return exitOK
	case errors.Is(err, core.ErrRestart):
		logger.Info("exiting so the service manager starts the updated agent")
		return exitOK
	case errors.Is(err, core.ErrUninstalled):
		logger.Info("the agent was removed from this machine")
		return exitOK
	default:
		logger.Error("the agent stopped with an error", "error", err)
		return exitError
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
