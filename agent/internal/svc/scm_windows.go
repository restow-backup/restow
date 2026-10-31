//go:build windows

package svc

import "errors"

// errWindows is returned until the Windows service manager exists (advapi32,
// docs/WINDOWS-AGENT.md, section 9).
var errWindows = errors.New("running the agent as a Windows service is not supported yet")

// New returns the manager for this operating system.
func New() (Manager, error) { return nil, errWindows }

// DefaultFiles are the files Uninstall removes on a real installation.
func DefaultFiles() []string { return nil }

// DefaultDirs are the folders Uninstall removes when they are empty.
func DefaultDirs() []string { return nil }

// Uninstall is not available on Windows yet (docs/WINDOWS-AGENT.md, section 9.4).
func Uninstall(UninstallOptions) error { return errWindows }
