package recovery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// The boot probe in the lab (docs/BAREMETAL.md 12.3). recover runs the same
// recovery as for a person, with the answers of the lab from fw_cfg; in
// probe mode it changes three things on the restored copy so that its start
// can be read on the serial console, writes RESTOW-PROBE phase=released
// once the repository access has ended, and waits for the lab to take the
// network away before the programs of the restored system run. The finish
// can then no longer reach the instance: recover writes it to the console
// as a framed block (ProbeFinishBlock), and the lab hands it to the worker
// with its result.

// ProbeReleasedLine tells the lab that the repository access ended.
const ProbeReleasedLine = "RESTOW-PROBE phase=released"

// ProbeLinkWait is how long recover waits for the lab to cut the network.
const ProbeLinkWait = 60 * time.Second

// probeBoot is the step probe_boot: the kernel command line of the
// restored system (GRUB defaults, /etc/kernel/cmdline, the Boot Loader
// Specification entries in /boot and on the ESPs) gets the serial console
// and loses quiet, splash and rhgb, and restow-probe.service reports the
// start. Every changed file keeps its previous version beside it.
func (x *Executor) probeBoot() error {
	if x.rootfs == nil {
		return errors.New("the root file system of the target is not mounted")
	}
	if err := x.probeEdit("/etc/default/grub", baremetal.ProbeGrubDefault); err != nil {
		return err
	}
	if err := x.probeEdit("/etc/kernel/cmdline", func(b []byte) []byte { return baremetal.ProbeBLSEntry(b, true) }); err != nil {
		return err
	}
	dirs := []string{"/boot/loader/entries"}
	for _, esp := range x.espRoots() {
		dirs = append(dirs, path.Join(esp, "loader/entries"))
	}
	for _, dir := range dirs {
		names, err := x.rootfs.ReadDir(dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		sort.Strings(names)
		for _, n := range names {
			if !strings.HasSuffix(n, ".conf") {
				continue
			}
			if err := x.probeEdit(path.Join(dir, n), func(b []byte) []byte { return baremetal.ProbeBLSEntry(b, false) }); err != nil {
				return err
			}
		}
	}
	for _, f := range []struct{ dir, name, body string }{
		{"/etc/systemd/system", baremetal.ProbeUnitName, baremetal.ProbeUnit},
		{"/etc/systemd/system/multi-user.target.d", "restow-probe.conf", baremetal.ProbeTargetDropIn},
	} {
		if err := x.rootfs.MkdirAll(f.dir, 0o755); err != nil {
			return err
		}
		p := path.Join(f.dir, f.name)
		if err := x.rootfs.WriteFileAtomic(p, []byte(f.body), 0o644, 0, 0, ""); err != nil {
			return err
		}
		x.created = append(x.created, p)
		x.report.Fixups = append(x.report.Fixups, api.RecoveryFixupChange{Path: p, Rule: "probe"})
	}
	return nil
}

func (x *Executor) probeEdit(p string, fn func([]byte) []byte) error {
	st, err := x.rootfs.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		x.log("%s is no regular file; the probe leaves it", p)
		return nil
	}
	data, err := x.rootfs.ReadFile(p, 1<<20)
	if err != nil {
		return err
	}
	out := fn(data)
	if bytes.Equal(out, data) {
		return nil
	}
	uid, gid := 0, 0
	if o, ok := fileOwner(st); ok {
		uid, gid = o[0], o[1]
	}
	backup := x.backupName(p)
	if err := x.rootfs.WriteFileAtomic(p, out, st.Mode().Perm(), uid, gid, backup); err != nil {
		return err
	}
	x.created = append(x.created, p)
	x.report.Fixups = append(x.report.Fixups, api.RecoveryFixupChange{Path: p, Rule: "probe", Backup: path.Join(path.Dir(p), backup)})
	return nil
}

// linksUp lists the network interfaces under sysClassNet (other than lo)
// whose carrier is up.
func linksUp(sysClassNet string) []string {
	entries, err := os.ReadDir(sysClassNet)
	if err != nil {
		return nil
	}
	var up []string
	for _, e := range entries {
		if e.Name() == "lo" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(sysClassNet, e.Name(), "carrier"))
		if err == nil && strings.TrimSpace(string(b)) == "1" {
			up = append(up, e.Name())
		}
	}
	sort.Strings(up)
	return up
}

// waitNoLink waits until no interface but lo has a link, at most wait;
// it returns the interfaces still up.
func waitNoLink(ctx context.Context, sysClassNet string, wait, poll time.Duration) []string {
	deadline := time.Now().Add(wait)
	for {
		up := linksUp(sysClassNet)
		if len(up) == 0 || !time.Now().Before(deadline) {
			return up
		}
		select {
		case <-ctx.Done():
			return up
		case <-time.After(poll):
		}
	}
}

// probeReleased runs when the repository access of a probe ended: the lab
// reads the line and takes the VM's network away; recover waits for that
// before the first program of the restored system. From here nothing more
// goes to the instance: the log stays on the console, the finish is relayed
// by the lab (relayFinish).
func (r *Recover) probeReleased(ctx context.Context) {
	r.probeRelayed = true
	r.UI.Line(ProbeReleasedLine)
	sys := r.SysClassNet
	if sys == "" {
		sys = "/sys/class/net"
	}
	if up := waitNoLink(ctx, sys, ProbeLinkWait, time.Second); len(up) > 0 {
		r.logf("probe: the lab did not take the network away within %s (still up: %s); the programs of the restored system run isolated anyway", ProbeLinkWait, strings.Join(up, ", "))
	}
}

// The frame of the finish a probe relays through the lab (docs/BAREMETAL.md
// 12.3): ProbeFinishBegin with the byte length and the SHA-256 (hex) of the
// JSON, the JSON in base64 in lines of at most ProbeFinishLineLen
// characters, then ProbeFinishEnd. The lab takes the last complete block
// whose length and digest match.
const (
	ProbeFinishBegin   = "RESTOW-PROBE-FINISH-BEGIN"
	ProbeFinishEnd     = "RESTOW-PROBE-FINISH-END"
	ProbeFinishLineLen = 76
	// ProbeFinishMaxBody bounds the relayed JSON (the lab takes no more):
	// warnings are dropped from the end as for the instance's limit.
	ProbeFinishMaxBody = 160 << 10
)

// ProbeFinishBlock is the finish as the lines of its console block: the
// body Session.Finish would send (finishBody: redacted, within the limits),
// bounded by ProbeFinishMaxBody.
func ProbeFinishBlock(f api.RecoveryFinish) ([]string, error) {
	payload, err := json.Marshal(finishBody(f, ProbeFinishMaxBody))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(payload)
	enc := base64.StdEncoding.EncodeToString(payload)
	lines := make([]string, 0, len(enc)/ProbeFinishLineLen+3)
	lines = append(lines, fmt.Sprintf("%s %d %s", ProbeFinishBegin, len(payload), hex.EncodeToString(sum[:])))
	for len(enc) > ProbeFinishLineLen {
		lines = append(lines, enc[:ProbeFinishLineLen])
		enc = enc[ProbeFinishLineLen:]
	}
	if enc != "" {
		lines = append(lines, enc)
	}
	return append(lines, ProbeFinishEnd), nil
}

// relayFinish writes the finish of a released probe to the console: the
// lab took the network away, the lab hands the block to the worker.
func (r *Recover) relayFinish(f api.RecoveryFinish) {
	lines, err := ProbeFinishBlock(f)
	if err != nil {
		r.logf("probe: the finish cannot be encoded: %v", err)
		return
	}
	r.logf("probe: the finish (%s) goes to the lab over the console", f.Status)
	for _, l := range lines {
		r.UI.Line(l)
	}
}
