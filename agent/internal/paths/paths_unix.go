//go:build unix

package paths

import (
	"os"
	"runtime"
)

func installDir() string { return InstallDirFor(runtime.GOOS) }

func systemLayout() Layout {
	return Layout{
		StateDir: "/etc/restow-agent",
		DataDir:  "/var/lib/restow-agent",
		LogDir:   "/var/log/restow-agent",
	}
}

func ensureLayout(l Layout) error {
	if err := os.MkdirAll(l.DataDir, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(l.DataDir, 0o755); err != nil {
		return err
	}
	return os.MkdirAll(l.LogDir, 0o750)
}
