//go:build arm64

package recovery

// nativeArch is the system call table of this build.
func nativeArch() (string, error) { return "arm64", nil }
