package sysinfo

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func osVersion() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/sw_vers", "-productVersion").Output()
	if err != nil {
		return "macOS"
	}
	v := "macOS " + strings.TrimSpace(string(out))
	if build, err := exec.CommandContext(ctx, "/usr/bin/sw_vers", "-buildVersion").Output(); err == nil {
		v += " (" + strings.TrimSpace(string(build)) + ")"
	}
	return v
}
