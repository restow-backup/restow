//go:build unix

package svc

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// systemdUnit is the unit file. The agent must read everything it backs up and
// write restores anywhere, so it runs as root and the file system stays fully
// visible and writable (no ProtectSystem, ProtectHome, PrivateTmp or
// ReadOnlyPaths): those would make backups of arbitrary paths incomplete and
// restores into them impossible. What the agent and restic never need is
// switched off:
//
//   - NoNewPrivileges: no process of the service gains privileges through
//     setuid/setgid binaries or file capabilities.
//   - ProtectKernelTunables, ProtectKernelLogs, ProtectControlGroups: /proc/sys,
//     /sys, the kernel log and the cgroup tree are read-only or hidden (reading
//     them in a backup still works; nobody restores into them).
//   - Kernel modules cannot be loaded (CAP_SYS_MODULE dropped, module system
//     calls fail with EPERM). ProtectKernelModules is not used because it also
//     hides /usr/lib/modules, which a backup of / must be able to read.
//   - RestrictNamespaces, LockPersonality, RestrictRealtime,
//     SystemCallArchitectures=native, ProtectHostname: no namespaces, no
//     execution domain changes, no realtime scheduling, no foreign syscall ABIs,
//     no hostname changes.
//   - UMask=0077: files the agent or a hook creates are private unless the
//     code sets a mode; restic restores keep the modes from the snapshot.
//
// ProtectClock and PrivateDevices are not set: both restrict device access,
// which hooks (LVM snapshots, fsfreeze) and restores of device nodes need.
//
// The service starts at low CPU and I/O priority so it does not disturb
// production work; KillMode=mixed sends SIGTERM only to the agent, which then
// stops restic in an orderly way before systemd resorts to SIGKILL.
const systemdUnit = `[Unit]
Description=Restow backup agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart={{EXE}} run
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=120
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
WorkingDirectory=/
UMask=0077
NoNewPrivileges=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectHostname=yes
CapabilityBoundingSet=~CAP_SYS_MODULE
SystemCallFilter=~@module
SystemCallErrorNumber=EPERM
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`

type systemd struct {
	run      runner
	unitPath string
}

func (s *systemd) Name() string { return "systemd" }

func renderSystemdUnit(exe string) string { return strings.ReplaceAll(systemdUnit, "{{EXE}}", exe) }

// validateSystemdExe rejects paths that would need quoting or escaping in a
// unit file; the install location has none of these characters.
func validateSystemdExe(p string) error {
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("the agent binary path %q must be absolute", p)
	}
	if strings.ContainsAny(p, " \t\r\n\"'\\%$<>&;") {
		return fmt.Errorf("the agent binary path %q contains characters that are not allowed in a service definition", p)
	}
	return nil
}

func (s *systemd) Install(exe string) error {
	if _, err := s.write(exe); err != nil {
		return err
	}
	if _, err := s.run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	_, err := s.run("systemctl", "enable", SystemdUnit)
	return err
}

// write puts the unit for exe in place and reports whether it changed.
func (s *systemd) write(exe string) (bool, error) {
	if err := validateSystemdExe(exe); err != nil {
		return false, err
	}
	want := []byte(renderSystemdUnit(exe))
	if have, err := os.ReadFile(s.unitPath); err == nil && bytes.Equal(have, want) {
		return false, nil
	}
	if err := writeFileAtomic(s.unitPath, want); err != nil {
		return false, fmt.Errorf("cannot write %s: %w", s.unitPath, err)
	}
	return true, nil
}

// Refresh rewrites the unit when it differs from what this version installs
// (another binary path, older hardening) and reloads systemd. The running
// process keeps its settings until the next start.
func (s *systemd) Refresh(exe string) (bool, error) {
	if _, err := os.Stat(s.unitPath); err != nil {
		return false, nil // not installed as a service (manual run)
	}
	changed, err := s.write(exe)
	if err != nil || !changed {
		return changed, err
	}
	_, err = s.run("systemctl", "daemon-reload")
	return true, err
}

// ReloadFromInside is called by the running service after Refresh moved it:
// systemd starts the new ExecStart when this process exits (Restart=always).
func (s *systemd) ReloadFromInside() (exitNow bool, err error) { return true, nil }

// Program returns the binary the unit starts.
func (s *systemd) Program() (string, error) {
	raw, err := os.ReadFile(s.unitPath)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "ExecStart="); ok {
			if f := strings.Fields(v); len(f) > 0 {
				return f[0], nil
			}
		}
	}
	return "", errors.New("the unit has no ExecStart")
}

func (s *systemd) Start() error   { _, err := s.run("systemctl", "start", SystemdUnit); return err }
func (s *systemd) Stop() error    { _, err := s.run("systemctl", "stop", SystemdUnit); return err }
func (s *systemd) Restart() error { _, err := s.run("systemctl", "restart", SystemdUnit); return err }

func (s *systemd) Status() Info {
	if _, err := os.Stat(s.unitPath); err != nil {
		return Info{State: NotInstalled, Detail: "no unit file at " + s.unitPath}
	}
	out, _ := s.run("systemctl", "show", SystemdUnit, "--property=ActiveState,SubState,MainPID")
	props := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			props[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	pid, _ := strconv.Atoi(props["MainPID"])
	switch props["ActiveState"] {
	case "active", "activating", "reloading":
		return Info{State: Running, PID: pid, Detail: props["ActiveState"] + " (" + props["SubState"] + ")"}
	case "inactive", "failed", "deactivating":
		return Info{State: Stopped, Detail: props["ActiveState"] + " (" + props["SubState"] + ")"}
	}
	return Info{State: Unknown, Detail: "systemctl did not report a state"}
}

func (s *systemd) Uninstall() error {
	var firstErr error
	note := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	// Errors from stop and disable are expected when the unit is not loaded.
	_, _ = s.run("systemctl", "stop", SystemdUnit)
	_, _ = s.run("systemctl", "disable", SystemdUnit)
	if err := os.Remove(s.unitPath); err != nil && !os.IsNotExist(err) {
		note(err)
	}
	_, err := s.run("systemctl", "daemon-reload")
	note(err)
	_, _ = s.run("systemctl", "reset-failed", SystemdUnit)
	return firstErr
}

func (s *systemd) UninstallFromInside() error {
	_, _ = s.run("systemctl", "disable", SystemdUnit)
	if err := os.Remove(s.unitPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, _ = s.run("systemctl", "daemon-reload")
	// Last step: this stops the process that is running this code.
	_, err := s.run("systemctl", "stop", "--no-block", SystemdUnit)
	return err
}
