//go:build !windows

package sysinfo

// detectWindowsMachine is never called outside Windows.
func detectWindowsMachine() Machine { return Machine{Virtualization: VirtNone} }
