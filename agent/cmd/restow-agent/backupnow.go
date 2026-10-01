package main

import (
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/state"
)

func cmdBackupNow(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("backup-now", stderr)
	debug := fs.Bool("debug", false, "verbose logging")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if !requireRoot("backup-now", stderr) {
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
		fmt.Fprintf(stderr, "Cannot start a backup: %v\n", err)
		return exitError
	}
	ctx, cancel := signalContext()
	defer cancel()

	out, err := a.BackupNow(ctx)
	if err != nil {
		switch {
		case errors.Is(err, core.ErrBusy):
			fmt.Fprintln(stderr, "A backup or restore is already running on this machine (started by the service or another terminal). Check with: restow-agent status")
		case api.IsNetworkError(err) || api.IsServerReachable(err):
			fmt.Fprintf(stderr, "Cannot start the backup: %s\n", api.Explain(err, st.ServerURL))
		default:
			fmt.Fprintf(stderr, "Cannot start the backup: %v\n", err)
		}
		return exitError
	}
	switch out.Status {
	case api.StatusSucceeded:
		fmt.Fprintf(stdout, "Backup finished: snapshot %s.\n", out.SnapshotID)
		return exitOK
	case api.StatusPartial:
		fmt.Fprintf(stdout, "Backup finished with warnings: snapshot %s is incomplete (%d problems).\n", out.SnapshotID, len(out.Errors))
		return exitPartial
	}
	msg := "unknown error"
	if len(out.Errors) > 0 {
		msg = out.Errors[0].Message
	}
	fmt.Fprintf(stderr, "Backup failed: %s\n", msg)
	return exitError
}
