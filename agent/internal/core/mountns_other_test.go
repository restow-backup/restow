//go:build unix && !linux

package core

// mayUnshareMounts: mount namespaces are a Linux feature.
func mayUnshareMounts() bool { return false }
