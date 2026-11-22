//go:build linux && amd64

package oneshot

// Raw system calls of amd64 (no x/sys): memfd_create and kexec_file_load.
const (
	sysMemfdCreate   = 319
	sysKexecFileLoad = 320
	kexecSupported   = true
)
