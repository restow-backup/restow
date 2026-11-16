package core

import (
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// pveStateFiles are the secrets of the PVE integration (restow-pve), which
// writes its state with temporary files named .state.json.<random>.
var pveStateFiles = []string{"/etc/restow-pve/state.json", "/etc/restow-pve/.state.json.*"}

// agentExcludes are excluded from every backup on every system, whatever
// the job says (docs/BAREMETAL.md 5.3 and 5.4): the agent's cache and
// temporary folders, earlier restores, and its secrets: state.json and the
// temporary files state.Save writes (.state-*.tmp), on Linux also the
// state of restow-pve. On macOS each path is given in all its spellings
// (expandDarwinExcludes). An old agent secret in a snapshot helps nobody
// after a restore and harms a copy of the machine (two machines, one
// secret).
//
// Every path is written with the separator of goos, the system whose files
// the backup reads: paths.Layout joins with the separator of the system the
// agent runs on, and restic matches an exclude with a foreign separator
// against nothing.
func agentExcludes(l paths.Layout, goos string, fl Firmlinks) []string {
	sep, other := "/", `\`
	if goos == "windows" {
		sep, other = other, sep
	}
	native := func(p string) string { return strings.ReplaceAll(p, other, sep) }
	ex := []string{native(l.CacheDir()), native(l.TmpDir()), native(l.StateFile()), native(strings.TrimRight(l.StateDir, `/\`) + sep + ".state-*.tmp"), "Restow-Restore-*"}
	switch goos {
	case "linux":
		ex = append(ex, pveStateFiles...)
	case "darwin":
		ex = expandDarwinExcludes(ex, fl, "")
	}
	return ex
}
