// Package sysinfo collects the host facts sent at enrollment and in
// heartbeats: hostname, OS and architecture identifiers, OS version text.
package sysinfo

import (
	"bufio"
	"os"
	"runtime"
	"strings"
)

// OS returns the operating system identifier used by the API: linux or darwin.
func OS() string { return runtime.GOOS }

// Arch returns amd64 or arm64.
func Arch() string { return runtime.GOARCH }

// Hostname returns the machine name, "unknown-host" if it cannot be read.
func Hostname() string {
	h, err := os.Hostname()
	if err != nil || strings.TrimSpace(h) == "" {
		return "unknown-host"
	}
	return strings.TrimSpace(h)
}

// OSVersion returns a human-readable OS version, for example
// "Debian GNU/Linux 12 (bookworm), kernel 6.1.0-18-amd64" or "macOS 15.4".
func OSVersion() string { return osVersion() }

// parseOSRelease extracts PRETTY_NAME from the content of /etc/os-release.
func parseOSRelease(content string) string {
	sc := bufio.NewScanner(strings.NewReader(content))
	fallbackName, fallbackVersion := "", ""
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch k {
		case "PRETTY_NAME":
			if v != "" {
				return v
			}
		case "NAME":
			fallbackName = v
		case "VERSION_ID":
			fallbackVersion = v
		}
	}
	return strings.TrimSpace(fallbackName + " " + fallbackVersion)
}
