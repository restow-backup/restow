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
