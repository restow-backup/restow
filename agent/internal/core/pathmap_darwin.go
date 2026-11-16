//go:build darwin

package core

import "os"

// loadFirmlinks reads the firmlinks of this Mac (/usr/share/firmlinks),
// not a table in the code: they change between macOS releases.
func loadFirmlinks() Firmlinks {
	b, err := os.ReadFile("/usr/share/firmlinks")
	if err != nil {
		return nil
	}
	return ParseFirmlinks(b)
}
