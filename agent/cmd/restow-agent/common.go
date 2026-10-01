package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/status"
)

// devLayout reports whether the layout was relocated for development.
func devLayout() bool { return paths.DevLayout() }

// requireRoot refuses to continue for unprivileged users: the agent must read
// every file it backs up and owns root-only state.
func requireRoot(cmd string, stderr io.Writer) bool {
	if os.Geteuid() == 0 || devLayout() {
		return true
	}
	fmt.Fprintf(stderr, "restow-agent %s must run as root (it reads all files and stores root-only secrets). Try: sudo restow-agent %s\n", cmd, cmd)
	return false
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("restow-agent "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

func debugEnabled(flagValue bool) bool {
	return flagValue || os.Getenv("RESTOW_DEBUG") == "1"
}

// stderrLogger logs to stderr only (short-lived commands).
func stderrLogger(debug bool, stderr io.Writer) *slog.Logger {
	level := slog.LevelInfo
	if debug {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewTextHandler(redact.NewWriter(stderr, redact.Default), &slog.HandlerOptions{Level: level}))
}

// loadEnrollment reads the state and registers its secrets with the redactor.
func loadEnrollment(layout paths.Layout, logger *slog.Logger) (*state.State, error) {
	st, warnings, err := state.Load(layout.StateFile())
	for _, w := range warnings {
		logger.Warn(w)
	}
	if err != nil {
		return nil, err
	}
	redact.Add(st.Secrets()...)
	return st, nil
}

// buildAgent wires the engine from the enrollment state.
func buildAgent(layout paths.Layout, st *state.State, logger *slog.Logger, selfUpdate bool, uninstall func(ctx context.Context) error) (*core.Agent, error) {
	client, err := api.New(api.Options{
		BaseURL: st.ServerURL, EndpointID: st.EndpointID, AgentSecret: st.AgentSecret,
		AllowInsecureHTTP: st.AllowInsecureHTTP,
	})
	if err != nil {
		return nil, fmt.Errorf("the server URL in %s is unusable: %w", layout.StateFile(), err)
	}
	bin, err := paths.TrustedRestic()
	if err != nil {
		return nil, err
	}
	if err := checkRepositoryURL(st.RepositoryURL, st.ServerURL, st.AllowInsecureHTTP); err != nil {
		return nil, fmt.Errorf("%w; enroll again with a new token (restow-agent enroll --force)", err)
	}
	runner := &restic.Runner{
		Bin: bin, Repo: st.RepositoryURL, Password: st.RepositoryPassword,
		RESTUser: st.EndpointID, RESTPass: st.AgentSecret,
		CacheDir: layout.CacheDir(), TmpDir: filepath.Join(layout.DataDir, "restic-tmp"),
	}
	store, serr := status.Open(layout.StatusFile())
	if serr != nil {
		logger.Warn("status file was unreadable and is reset", "error", serr)
	}
	return core.New(core.Deps{
		Layout: layout, State: st, Server: client, Restic: runner, Status: store, Logger: logger,
		Uninstall: uninstall,
	}, core.Options{SelfUpdate: selfUpdate}), nil
}

// signalContext cancels on SIGINT and SIGTERM.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

var errUsage = errors.New("usage")

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return flag.ErrHelp
		}
		return errUsage
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(fs.Output(), "%s: unexpected argument %q\n", fs.Name(), fs.Arg(0))
		return errUsage
	}
	return nil
}

// executable returns the running binary with links resolved.
func executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved
	}
	return exe
}
