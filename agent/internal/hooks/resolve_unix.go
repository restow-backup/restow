//go:build unix

package hooks

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// Resolve turns the hook configured on the server into the command line to
// run under the local mode. dir is the hooks folder (scripts mode).
func Resolve(mode, dir, configured string) ([]string, error) {
	configured = strings.TrimSpace(configured)
	switch NormalizeMode(mode) {
	case ModeAny:
		return []string{"/bin/sh", "-c", configured}, nil
	case ModeScripts:
		if !IsScriptName(configured) {
			// The configured text is not repeated: a command may carry credentials.
			return nil, fmt.Errorf("%w: this machine only runs scripts from %s, and the configured hook is not the name of a script", ErrNotAllowed, dir)
		}
		p := filepath.Join(dir, configured)
		resolved, err := trustedScript(p)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrNotAllowed, err)
		}
		return []string{resolved}, nil
	}
	return nil, fmt.Errorf("%w: hooks from the Restow server are switched off on this machine (an administrator of the machine can allow them with `sudo restow-agent hooks scripts` or `sudo restow-agent hooks any`)", ErrNotAllowed)
}

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
	if fi.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("%s is not executable (chmod 0700)", p)
	}
	return paths.TrustedFile(p)
}
