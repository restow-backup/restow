//go:build unix

// Package svc installs and controls the agent as an operating system service:
// a systemd unit on Linux and a LaunchDaemon on macOS. It uses only the
// standard library and the platform's own tools (systemctl, launchctl); the
// service definitions are generated from templates in this package so they can
// be reviewed and tested. A Windows service manager can be added behind the
// same Manager interface later.
package svc

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// Identifiers of the service, fixed by the endpoint-backup specification.
const (
	// SystemdUnit is the systemd unit name on Linux.
	SystemdUnit = "restow-agent.service"
	// LaunchdLabel is the LaunchDaemon label on macOS.
	LaunchdLabel = "com.restowbackup.agent"
	// LaunchdReloadLabel is the one-shot job that reloads the LaunchDaemon
	// after the agent moved itself to the root-owned prefix.
	LaunchdReloadLabel = "com.restowbackup.agent.reload"

	systemdUnitPath  = "/etc/systemd/system/" + SystemdUnit
	launchdPlistPath = "/Library/LaunchDaemons/" + LaunchdLabel + ".plist"
)

// State is the state of the service as far as the manager can tell.
type State int

const (
	// NotInstalled means no service definition exists.
	NotInstalled State = iota
	// Stopped means installed but not running.
	Stopped
	// Running means the service process is up.
	Running
	// Unknown means the state could not be determined.
	Unknown
)

func (s State) String() string {
	switch s {
	case NotInstalled:
		return "not installed"
	case Stopped:
		return "installed, not running"
	case Running:
		return "running"
	}
	return "unknown"
}

// Info is the answer of Status.
type Info struct {
	State  State
	PID    int
	Detail string
}

// Manager controls the service of the current platform.
type Manager interface {
	// Name describes the service manager ("systemd", "launchd").
	Name() string
	// Install writes the service definition for the given agent binary and
	// enables it for boot. It does not start the service.
	Install(exePath string) error
	// Start starts the service (installed and enabled).
	Start() error
	// Stop stops the service until the next boot or start.
	Stop() error
	// Restart stops and starts the service.
	Restart() error
	// Status reports the service state.
	Status() Info
	// Uninstall stops the service and removes its definition.
	Uninstall() error
	// UninstallFromInside removes the definition without stopping first and
	// stops the service last. It is for the agent process removing itself: it
	// must not be killed before the rest of the uninstall is done.
	UninstallFromInside() error
	// Refresh rewrites an installed service definition when it differs from
	// the one this version writes for exePath (another location, newer
	// hardening) and reports whether it changed. Without a definition (a
	// manual run) it does nothing.
	Refresh(exePath string) (bool, error)
	// ReloadFromInside makes the service manager start the refreshed
	// definition. exitNow tells the running agent to exit (systemd restarts
	// it from the new definition); otherwise the manager ends the process.
	ReloadFromInside() (exitNow bool, err error)
	// Program returns the binary the installed definition starts.
	Program() (string, error)
}

// New returns the manager for this operating system.
func New() (Manager, error) {
	switch runtime.GOOS {
	case "linux":
		if _, err := os.Stat("/run/systemd/system"); err != nil {
			return nil, errors.New("this Linux system does not run systemd; the agent supports systemd only " +
				"(run `restow-agent run` from another supervisor if you know what you are doing)")
		}
		return &systemd{run: execRunner, unitPath: systemdUnitPath}, nil
	case "darwin":
		return &launchd{run: execRunner, plistPath: launchdPlistPath, reloadPath: reloadPlistPath(paths.InstallDir())}, nil
	}
	return nil, fmt.Errorf("running the agent as a service is not supported on %s", runtime.GOOS)
}

// runner executes an external command and returns its combined output.
type runner func(name string, args ...string) (string, error)

func execRunner(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		out := strings.TrimSpace(buf.String())
		if err != nil {
			return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, out)
		}
		return out, nil
	case <-time.After(2 * time.Minute):
		_ = cmd.Process.Kill()
		return buf.String(), fmt.Errorf("%s %s: timed out", name, strings.Join(args, " "))
	}
}

// writeFileAtomic writes a service definition (mode 0644, owned by root).
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chown(tmp, 0, 0)
	return os.Rename(tmp, path)
}
