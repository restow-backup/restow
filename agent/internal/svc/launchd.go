//go:build unix

package svc

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// launchdPlist is the LaunchDaemon definition. Logs of the process itself go
// to /var/log/restow-agent/agent.log; the launchd files only catch output
// written before logging starts and crash traces. Umask 63 (077) keeps files
// the agent or a hook creates private unless the code sets a mode.
const launchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + LaunchdLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{EXE}}</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>ExitTimeOut</key>
	<integer>120</integer>
	<key>Nice</key>
	<integer>10</integer>
	<key>LowPriorityIO</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>Umask</key>
	<integer>63</integer>
	<key>WorkingDirectory</key>
	<string>/</string>
	<key>StandardOutPath</key>
	<string>/var/log/restow-agent/launchd.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/restow-agent/launchd.log</string>
</dict>
</plist>
`

// launchdReloadPlist is a one-shot LaunchDaemon that reloads the agent's
// definition after the agent moved itself (0.1.0 -> root-owned prefix). It
// must run outside the agent's own job: `launchctl bootout` of the agent ends
// the agent and everything in its process group. The agent removes it again
// at its next start.
const launchdReloadPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + LaunchdReloadLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>sleep 2; /bin/launchctl bootout system/` + LaunchdLabel + `; /bin/launchctl bootstrap system ` + launchdPlistPath + `</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>LaunchOnlyOnce</key>
	<true/>
</dict>
</plist>
`

type launchd struct {
	run       runner
	plistPath string
	// reloadPath is where the one-shot reload job is written (root-owned).
	reloadPath string
}

func (l *launchd) Name() string { return "launchd" }

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func renderLaunchdPlist(exe string) string {
	return strings.ReplaceAll(launchdPlist, "{{EXE}}", xmlEscape(exe))
}

// validateLaunchdExe accepts absolute paths; spaces are fine in a plist
// (/Library/Application Support/...), control characters are not.
func validateLaunchdExe(p string) error {
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("the agent binary path %q must be absolute", p)
	}
	if strings.ContainsAny(p, "\t\r\n\x00") {
		return fmt.Errorf("the agent binary path %q contains characters that are not allowed in a service definition", p)
	}
	return nil
}

func (l *launchd) domainTarget() string { return "system/" + LaunchdLabel }

func (l *launchd) loaded() bool {
	_, err := l.run("launchctl", "print", l.domainTarget())
	return err == nil
}

// write puts the plist for exe in place and reports whether it changed.
func (l *launchd) write(exe string) (bool, error) {
	if err := validateLaunchdExe(exe); err != nil {
		return false, err
	}
	want := []byte(renderLaunchdPlist(exe))
	if have, err := os.ReadFile(l.plistPath); err == nil && bytes.Equal(have, want) {
		return false, nil
	}
	if err := writeFileAtomic(l.plistPath, want); err != nil {
		return false, fmt.Errorf("cannot write %s: %w", l.plistPath, err)
	}
	return true, nil
}

func (l *launchd) Install(exe string) error {
	if err := os.MkdirAll("/var/log/restow-agent", 0o750); err != nil {
		return err
	}
	if _, err := l.write(exe); err != nil {
		return err
	}
	// A definition that changed must be re-read: unload the old one. It is
	// loaded again by Start.
	if l.loaded() {
		_, _ = l.run("launchctl", "bootout", l.domainTarget())
	}
	return nil
}

// Refresh rewrites the plist when it differs from what this version installs.
// launchd keeps the loaded definition until the job is loaded again.
func (l *launchd) Refresh(exe string) (bool, error) {
	if _, err := os.Stat(l.plistPath); err != nil {
		return false, nil // not installed as a service (manual run)
	}
	return l.write(exe)
}

// ReloadFromInside hands the reload to a one-shot job outside the agent's
// job, which ends this process (bootout) and starts the new definition.
func (l *launchd) ReloadFromInside() (exitNow bool, err error) {
	if l.reloadPath == "" {
		return false, errors.New("no location for the reload job")
	}
	_, _ = l.run("launchctl", "bootout", "system/"+LaunchdReloadLabel)
	if err := writeFileAtomic(l.reloadPath, []byte(launchdReloadPlist)); err != nil {
		return false, err
	}
	if _, err := l.run("launchctl", "bootstrap", "system", l.reloadPath); err != nil {
		return false, err
	}
	return false, nil
}

// CleanupReload removes the one-shot reload job after it did its work.
func (l *launchd) CleanupReload() {
	if l.reloadPath == "" {
		return
	}
	if _, err := os.Stat(l.reloadPath); err != nil {
		return
	}
	_, _ = l.run("launchctl", "bootout", "system/"+LaunchdReloadLabel)
	_ = os.Remove(l.reloadPath)
}

var launchdProgram = regexp.MustCompile(`(?s)<key>ProgramArguments</key>\s*<array>\s*<string>([^<]*)</string>`)

// Program returns the binary the plist starts.
func (l *launchd) Program() (string, error) {
	raw, err := os.ReadFile(l.plistPath)
	if err != nil {
		return "", err
	}
	m := launchdProgram.FindSubmatch(raw)
	if m == nil {
		return "", errors.New("the plist has no ProgramArguments")
	}
	var v struct {
		S string `xml:",chardata"`
	}
	if err := xml.Unmarshal([]byte("<s>"+string(m[1])+"</s>"), &v); err != nil {
		return "", err
	}
	return v.S, nil
}

func (l *launchd) Start() error {
	_, _ = l.run("launchctl", "enable", l.domainTarget())
	if l.loaded() {
		_, err := l.run("launchctl", "kickstart", l.domainTarget())
		return err
	}
	_, err := l.run("launchctl", "bootstrap", "system", l.plistPath)
	return err
}

func (l *launchd) Stop() error {
	if !l.loaded() {
		return nil
	}
	_, err := l.run("launchctl", "bootout", l.domainTarget())
	return err
}

func (l *launchd) Restart() error {
	if err := l.Stop(); err != nil {
		return err
	}
	return l.Start()
}

var (
	launchdPID   = regexp.MustCompile(`(?m)^\s*pid = (\d+)`)
	launchdState = regexp.MustCompile(`(?m)^\s*state = (\S+)`)
)

func (l *launchd) Status() Info {
	if _, err := os.Stat(l.plistPath); err != nil {
		return Info{State: NotInstalled, Detail: "no LaunchDaemon at " + l.plistPath}
	}
	out, err := l.run("launchctl", "print", l.domainTarget())
	if err != nil {
		if strings.Contains(out, "Could not find service") || strings.Contains(err.Error(), "Could not find service") {
			return Info{State: Stopped, Detail: "installed, not loaded"}
		}
		return Info{State: Unknown, Detail: "launchctl print failed (are you root?): " + strings.TrimSpace(err.Error())}
	}
	return parseLaunchdPrint(out)
}

func parseLaunchdPrint(out string) Info {
	state := ""
	if m := launchdState.FindStringSubmatch(out); m != nil {
		state = m[1]
	}
	pid := 0
	if m := launchdPID.FindStringSubmatch(out); m != nil {
		pid, _ = strconv.Atoi(m[1])
	}
	switch {
	case state == "running" || pid > 0:
		return Info{State: Running, PID: pid, Detail: "loaded, " + state}
	case state == "":
		return Info{State: Unknown, Detail: "launchctl print gave no state"}
	}
	return Info{State: Stopped, Detail: "loaded, " + state}
}

func (l *launchd) Uninstall() error {
	_, _ = l.run("launchctl", "bootout", l.domainTarget())
	l.CleanupReload()
	if err := os.Remove(l.plistPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (l *launchd) UninstallFromInside() error {
	l.CleanupReload()
	if err := os.Remove(l.plistPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	// Last step: bootout terminates the process that is running this code.
	_, err := l.run("launchctl", "bootout", l.domainTarget())
	return err
}

// reloadPlistPath is where the one-shot reload job lives: in the root-owned
// install prefix, never in a folder a user can write to.
func reloadPlistPath(installDir string) string {
	return filepath.Join(installDir, LaunchdReloadLabel+".plist")
}
