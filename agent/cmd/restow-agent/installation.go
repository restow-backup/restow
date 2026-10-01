package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/update"
)

// The agent runs as root, so it only runs from the root-owned prefix
// (paths.InstalledAgentBinary). Earlier pre-release installations lived below
// /usr/local; an agent of this version that finds itself there (the
// self-update of such an installation put it there) moves the installation
// before it does anything else: it installs its own, signature-checked release
// into the prefix, points the service at it and lets the service manager start
// it from there. The new process then removes the old files.

// underServiceManager reports whether systemd or launchd started this process
// as the agent service (and will start it again when it exits).
func underServiceManager() bool {
	return os.Getenv("INVOCATION_ID") != "" || os.Getenv("XPC_SERVICE_NAME") == svc.LaunchdLabel
}

// legacyFiles are the places of an earlier pre-release installation.
type legacyFiles struct {
	agent, restic, libDir, link string
}

var legacy = legacyFiles{
	agent: paths.LegacyAgentBinary, restic: paths.LegacyResticBinary, libDir: paths.LegacyLibDir, link: paths.CommandLink,
}

// installationRetry is how long the agent waits before it tries again to make
// its installation safe.
var installationRetry = 5 * time.Minute

// ensureInstallation returns once the agent runs from a safe installation
// (proceed), or tells the caller to exit with code so the service manager
// starts the moved or refreshed installation. Until the installation is safe
// the agent does nothing else: no backup, no task, no hook.
func ensureInstallation(ctx context.Context, layout paths.Layout, logger *slog.Logger) (exit bool, code int) {
	installed := paths.InstalledAgentBinary()
	var warned time.Time
	for {
		exe := executable()
		var err error
		if exe != installed {
			var exitNow bool
			exitNow, err = relocate(ctx, layout, logger, exe, installed)
			if err == nil {
				if exitNow {
					return true, exitOK
				}
				// launchd ends this process from the reload job.
				select {
				case <-ctx.Done():
					return true, exitOK
				case <-time.After(3 * time.Minute):
				}
				err = errors.New("the service manager did not start the agent from its new location")
			}
		} else if _, err = paths.TrustedFile(exe); err == nil {
			if restart := tidyInstallation(logger, installed, legacy); restart {
				return true, exitOK
			}
			return false, exitOK
		}
		if warned.IsZero() || time.Since(warned) > 30*time.Minute {
			logger.Error("the agent does nothing (no backups, no tasks, no hooks) until its installation is safe; it retries every 5 minutes. "+
				"Re-running the install command from the Restow UI repairs the installation", "error", err)
			warned = time.Now()
		}
		select {
		case <-ctx.Done():
			return true, exitOK
		case <-time.After(installationRetry):
		}
	}
}

// relocate installs the running version from its signed release into the
// root-owned prefix and points the service at it.
func relocate(ctx context.Context, layout paths.Layout, logger *slog.Logger, exe, installed string) (exitNow bool, err error) {
	logger.Warn("the agent runs from " + exe + ", outside the root-owned location " + installed +
		"; moving the installation there (files below /usr/local can belong to a user, for example with Homebrew on Intel Macs)")
	st, _, err := state.Load(layout.StateFile())
	if err != nil {
		return false, fmt.Errorf("cannot move the installation without an enrollment (%w); re-run the install command from the Restow UI", err)
	}
	registerSecrets(st)
	client, err := api.New(api.Options{BaseURL: st.ServerURL, EndpointID: st.EndpointID, AgentSecret: st.AgentSecret, AllowInsecureHTTP: st.AllowInsecureHTTP})
	if err != nil {
		return false, err
	}
	uctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	res, err := update.Reinstall(uctx, update.Options{CurrentVersion: buildinfo.Version, Client: client})
	if err != nil {
		return false, fmt.Errorf("installing the signed release %s into %s failed: %w", buildinfo.Version, filepath.Dir(installed), err)
	}
	logger.Info("installed the signature-checked release into the root-owned location", "version", res.Version, "path", res.AgentPath)
	m, err := svc.New()
	if err != nil {
		return false, fmt.Errorf("the agent is installed at %s, but the service could not be updated: %w", installed, err)
	}
	if _, err := m.Refresh(installed); err != nil {
		return false, fmt.Errorf("the agent is installed at %s, but the service definition could not be updated: %w", installed, err)
	}
	if !underServiceManager() {
		logger.Warn("the agent is installed at " + installed + "; restart the service to run it from there: " + installed + " service restart")
		return true, nil
	}
	logger.Info("the service now starts " + installed + "; handing over to the service manager")
	return m.ReloadFromInside()
}

// tidyInstallation runs in an agent that starts from the root-owned prefix:
// it removes what an earlier pre-release installation left below /usr/local,
// provides the convenience link and keeps the service definition current
// (location and hardening). It returns true when the service manager has to
// start the agent again.
func tidyInstallation(logger *slog.Logger, installed string, old legacyFiles) (restart bool) {
	removeLegacy(logger, old)
	ensureCommandLink(logger, installed, old.link)
	m, err := svc.New()
	if err != nil {
		return false
	}
	if l, ok := m.(interface{ CleanupReload() }); ok {
		l.CleanupReload()
	}
	changed, err := m.Refresh(installed)
	if err != nil {
		logger.Warn("the service definition could not be updated", "error", err)
		return false
	}
	if !changed || !underServiceManager() {
		return false
	}
	logger.Info("the service definition was updated (location or hardening); the service manager starts the agent again")
	exitNow, err := m.ReloadFromInside()
	if err != nil {
		logger.Warn("the updated service definition takes effect at the next start", "error", err)
		return false
	}
	return exitNow
}

// removeLegacy deletes the binaries of an earlier pre-release installation. The
// agent path is only removed when it is a file: after the move it is the
// convenience link.
func removeLegacy(logger *slog.Logger, old legacyFiles) {
	candidates := []string{old.agent + ".prev", old.restic, filepath.Join(filepath.Dir(old.agent), ".restow-agent.new"),
		filepath.Join(old.libDir, ".restic.new")}
	if fi, err := os.Lstat(old.agent); err == nil && fi.Mode().IsRegular() {
		candidates = append(candidates, old.agent)
	}
	for _, f := range candidates {
		if err := os.Remove(f); err == nil {
			logger.Info("removed a file of the earlier pre-release installation", "path", f)
		}
	}
	if err := os.Remove(old.libDir); err == nil {
		logger.Info("removed a folder of the earlier pre-release installation", "path", old.libDir)
	}
}

// ensureCommandLink creates /usr/local/bin/restow-agent -> the installed agent
// for administrators, but only where that folder belongs to root: a link in a
// folder a user controls could be replaced and run with sudo.
func ensureCommandLink(logger *slog.Logger, installed, link string) {
	if _, err := os.Lstat(link); err == nil || !os.IsNotExist(err) {
		return
	}
	if _, err := paths.TrustedDir(filepath.Dir(link), false); err != nil {
		logger.Debug("no command link: the folder is not root's alone", "folder", filepath.Dir(link), "error", err)
		return
	}
	if err := os.Symlink(installed, link); err == nil {
		logger.Info("created the command link", "link", link, "target", installed)
	}
}
