//go:build !linux

package baremetal

import "context"

// CaptureLocal is Linux only in this version (macOS follows in M6).
func CaptureLocal(context.Context, Options) (*Manifest, RawSet, error) {
	return nil, nil, ErrUnsupportedPlatform
}

// LocalHost is the root file system of this machine.
func LocalHost() Host { return DirHost{Root: "/"} }

// LocalStat is not used outside Linux.
func LocalStat(context.Context, string) error { return ErrUnsupportedPlatform }
