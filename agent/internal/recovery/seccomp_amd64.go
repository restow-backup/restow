//go:build amd64

package recovery

// nativeArch is the system call table of this build.
func nativeArch() (string, error) { return "amd64", nil }
