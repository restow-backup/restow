//go:build windows

package hooks

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// Resolve turns the hook configured on the server into the command line to
// run under the local mode. dir is the hooks folder (scripts mode). Mode
// "any" runs the text as a PowerShell command; mode "scripts" runs a .ps1
// (through PowerShell) or an .exe (directly) from the hooks folder.
func Resolve(mode, dir, configured string) ([]string, error) {
	configured = strings.TrimSpace(configured)
	switch NormalizeMode(mode) {
	case ModeAny:
		ps, err := powerShellExe()
		if err != nil {
			return nil, err
		}
		return PowerShellArgv(ps, configured), nil
	case ModeScripts:
		if !IsScriptName(configured) {
			// The configured text is not repeated: a command may carry credentials.
			return nil, fmt.Errorf("%w: this machine only runs scripts from %s, and the configured hook is not the name of a script", ErrNotAllowed, dir)
		}
		resolved, err := trustedScript(filepath.Join(dir, configured))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrNotAllowed, err)
		}
		if WindowsScriptKind(resolved) == "exe" {
			return []string{resolved}, nil
		}
		ps, err := powerShellExe()
		if err != nil {
			return nil, err
		}
		return PowerShellArgv(ps, PowerShellScriptCommand(resolved)), nil
	}
	return nil, fmt.Errorf("%w: hooks from the Restow server are switched off on this machine (an administrator of the machine can allow them "+
		"in an elevated PowerShell with `& 'C:\\Program Files\\Restow\\bin\\restow-agent.exe' hooks scripts` or `... hooks any`)", ErrNotAllowed)
}

// trustedScript accepts a .ps1 or .exe in the hooks folder that only trusted
// principals can change (there is no executable bit on Windows).
func trustedScript(p string) (string, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("the script %s does not exist", p)
		}
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", p)
	}
	if WindowsScriptKind(p) == "" {
		return "", fmt.Errorf("%s is neither a PowerShell script (.ps1) nor a program (.exe); other kinds are not run", p)
	}
	return paths.TrustedFile(p)
}
