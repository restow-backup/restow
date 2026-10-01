// Package buildinfo carries the version metadata of the agent binary. The
// values are injected at link time (see build.sh):
//
//	-ldflags "-X github.com/restow-backup/restow/agent/internal/buildinfo.Version=0.1.0"
package buildinfo

import (
	"fmt"
	"runtime"
)

// Version is the agent version. It equals the Restow release version without
// the leading "v". "0.0.0-dev" marks a local build.
var Version = "0.0.0-dev"

// Commit is the source revision the binary was built from.
var Commit = "unknown"

// Date is the build date (UTC, RFC 3339).
var Date = "unknown"

// UserAgent is sent with every request to the Restow instance.
func UserAgent() string {
	return fmt.Sprintf("restow-agent/%s (%s/%s)", Version, runtime.GOOS, runtime.GOARCH)
}

// Long returns the multi-line description printed by `restow-agent version`.
func Long() string {
	return fmt.Sprintf("restow-agent %s\ncommit:   %s\nbuilt:    %s\nplatform: %s/%s\ngo:       %s",
		Version, Commit, Date, runtime.GOOS, runtime.GOARCH, runtime.Version())
}
