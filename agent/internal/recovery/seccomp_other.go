//go:build !amd64 && !arm64

package recovery

import (
	"fmt"
	"runtime"
)

// nativeArch fails on architectures without a system call table.
func nativeArch() (string, error) {
	return "", fmt.Errorf("seccomp: no system call table for %s", runtime.GOARCH)
}
