package hooks

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Local hook policy. Hooks run as root, so whether the Restow server may
// define them is decided on the machine itself, by root, and stored in
// state.json (`restow-agent hooks ...`, `enroll --hooks`, the installer's
// --hooks option). The server cannot change it; it only learns the mode
// from the heartbeat and refuses hook configuration the machine would not run.
const (
	// ModeOff (the default): hooks from the server are never run.
	ModeOff = "off"
	// ModeScripts: a hook names a script in /etc/restow-agent/hooks.d that
	// root put there; the script is run directly, without a shell.
	ModeScripts = "scripts"
	// ModeAny: a hook is any shell command (/bin/sh -c), as earlier pre-release
	// agents ran every hook.
	ModeAny = "any"
)

// Modes lists the valid modes.
var Modes = []string{ModeOff, ModeScripts, ModeAny}

// NormalizeMode maps a stored value to a mode; anything unknown or empty is off.
func NormalizeMode(s string) string {
	switch s {
	case ModeScripts, ModeAny:
		return s
	}
	return ModeOff
}

// ParseMode validates a mode given on the command line.
func ParseMode(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case ModeOff, "none", "deny":
		return ModeOff, nil
	case ModeScripts:
		return ModeScripts, nil
	case ModeAny, "allow", "commands":
		return ModeAny, nil
	}
	return "", fmt.Errorf("unknown hook mode %q (use off, scripts or any)", s)
}

// ErrNotAllowed means the machine's hook policy refuses the configured hook.
var ErrNotAllowed = errors.New("hook not allowed on this machine")

// scriptName is what a hook must be in scripts mode: a plain file name.
var scriptName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// IsScriptName reports whether s can name a script in the hooks folder.
func IsScriptName(s string) bool { return scriptName.MatchString(s) && s != "." && s != ".." }

// ListScripts returns the names of the scripts in dir that scripts mode
// would run (regular, executable, trusted), sorted; at most 50.
func ListScripts(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !IsScriptName(e.Name()) {
			continue
		}
		if _, err := trustedScript(filepath.Join(dir, e.Name())); err == nil {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) > 50 {
		names = names[:50]
	}
	return names
}
