package baremetal

import (
	"context"
	"sort"
	"time"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// AutomountTimeout bounds the stat that triggers one automount point.
var AutomountTimeout = 10 * time.Second

// StatFunc stats a path; on the machine it is os.Stat run in a goroutine.
type StatFunc func(ctx context.Context, path string) error

// TriggerAutomounts stats every autofs mount point of mountinfo and every
// fstab entry with x-systemd.automount, so an ESP that systemd unmounts
// when idle is mounted while the layout is captured and backed up
// (docs/BAREMETAL.md, 4.1). It returns the targets that did not answer.
func TriggerAutomounts(ctx context.Context, h Host, stat StatFunc) []string {
	targets := map[string]bool{}
	if b, err := h.ReadFile("/proc/self/mountinfo", 0); err == nil {
		if mi, err := sysparse.ParseMountinfo(b); err == nil {
			for _, m := range mi {
				if m.FSType == "autofs" {
					targets[m.Target] = true
				}
			}
		}
	}
	if b, err := h.ReadFile("/etc/fstab", 0); err == nil {
		for _, e := range sysparse.ParseFstab(b) {
			if sysparse.HasOption(e.Options, "x-systemd.automount") && e.Target != "none" {
				targets[e.Target] = true
			}
		}
	}
	var failed []string
	for _, t := range sortedKeys(targets) {
		sctx, cancel := context.WithTimeout(ctx, AutomountTimeout)
		done := make(chan error, 1)
		go func() { done <- stat(sctx, t) }()
		select {
		case err := <-done:
			if err != nil {
				failed = append(failed, t)
			}
		case <-sctx.Done():
			failed = append(failed, t)
		}
		cancel()
	}
	sort.Strings(failed)
	return failed
}
