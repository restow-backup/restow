//go:build linux && !amd64

package oneshot

// restow-agent oneshot runs on amd64 only (the recovery ISO is amd64); the
// numbers are never used here.
const (
	sysMemfdCreate   = 0
	sysKexecFileLoad = 0
	kexecSupported   = false
)
