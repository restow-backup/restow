//go:build !darwin

package core

// loadFirmlinks: only macOS has firmlinks.
func loadFirmlinks() Firmlinks { return nil }
