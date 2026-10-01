package sysinfo

import (
	"os"
	"strings"
)

func osVersion() string {
	name := "Linux"
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		if n := parseOSRelease(string(b)); n != "" {
			name = n
		}
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if k := strings.TrimSpace(string(b)); k != "" {
			name += ", kernel " + k
		}
	}
	return name
}
