//go:build !linux

package restic

import (
	"errors"
	"os/exec"
)

// newMountNS is Linux only.
func newMountNS(*exec.Cmd) error {
	return errors.New("a private mount namespace is only available on Linux")
}

// ownProcessGroup is Linux only (recover); elsewhere it does nothing.
func ownProcessGroup(*exec.Cmd) {}
