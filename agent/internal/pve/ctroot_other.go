//go:build !linux && !windows

package pve

import "errors"

// bindPrivate needs Linux mount namespaces (restow-pve runs on Proxmox VE only).
func bindPrivate(dir, target string) error {
	return errors.New("mount namespaces need Linux")
}
