//go:build unix

package svc

import (
	"errors"
	"fmt"
	"os"
	"runtime"

	"github.com/restow-backup/restow/agent/internal/paths"
)

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
