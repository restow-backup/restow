//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// The restore task (docs/PVE.md, "Restore"; docs/PVE-PROTOCOL.md, "Task results"): a restore
// into a new guest, or a restore check (restoreTest), which restores into the restore pool and
// removes the guest again. It runs through the same PVE calls as a boot test (BootTester.PVE and
// .Cmd), so both share one way of restoring and of removing what they restored.

type restoreParams struct {
	Volname       string `json:"volname"`
	Kind          string `json:"kind"`
	TargetVMID    int    `json:"targetVmid"`
	TargetStorage string `json:"targetStorage"`
	Pool          string `json:"pool"`
	Start         bool   `json:"start"`
	// RestoreTest deletes the guest again after a successful restore.
	RestoreTest bool `json:"restoreTest"`
}

// restoreState is what a restore task knows once PVE runs its restore (kept with the task in
// inflight.json, so the service can wait for it again after a restart).
type restoreState struct {
	VMID          int      `json:"vmid"`
	UPID          string   `json:"upid"`
	OmittedMounts []string `json:"omittedMounts,omitempty"`
	// SkippedLxc are the raw lxc.* lines of the backup, which PVE restores only for root@pam;
	// CustomIDMap: among them a custom lxc.idmap.
	SkippedLxc  []string `json:"skippedLxc,omitempty"`
	CustomIDMap bool     `json:"customIdmap,omitempty"`
	// OnbootCleared: the container started with its node; the restored copy does not (onboot=0).
	OnbootCleared bool `json:"onbootCleared,omitempty"`
	// SourceVMID is the original guest's VMID (the name of a check's guest).
	SourceVMID int `json:"sourceVmid,omitempty"`
	// MadeUnprivileged: the container was privileged; it is restored unprivileged.
	MadeUnprivileged bool `json:"madeUnprivileged,omitempty"`
	// Root: restored as root through qmrestore; KeptDevices are the host devices the copy has,
	// as the original (a restore into a new guest).
	Root        bool     `json:"root,omitempty"`
	KeptDevices []string `json:"keptDevices,omitempty"`
	// StaticIPs are the static addresses of a container's interfaces (ip=, ip6=).
	StaticIPs []string `json:"staticIps,omitempty"`
}

func (s *Service) restoreTask(ctx context.Context, t Task) (map[string]any, error) {
	if !s.State.RestoresAllowed() {
		return nil, errors.New("restores are switched off on this node")
	}
	var p restoreParams
	if err := json.Unmarshal(t.Params, &p); err != nil || p.Volname == "" || p.TargetStorage == "" {
		return nil, errors.New("invalid restore task")
	}
	if p.Pool == "" || p.RestoreTest {
		// A check's guest lives in the restore pool, where its removal is allowed and proven.
		p.Pool = BootTestPool
	}
	b := s.bootTester()
	_, source, _ := ParseVolname(p.Volname)
	sp := restoreSpec{Kind: p.Kind, SourceVMID: source, Storage: p.TargetStorage, Pool: p.Pool, VMID: p.TargetVMID,
		Archive: s.State.StorageID + ":backup/" + strings.TrimPrefix(p.Volname, "backup/")}
	if p.RestoreTest {
		sp.Purpose = PurposeRestoreCheck
	}
	var omitted, rootKeys, staticIPs []string
	var lxc lxcOptions
	onboot, madeUnprivileged := false, false
	rp, err := b.Resolve(ctx, p.Volname)
	if err != nil {
		return nil, fmt.Errorf("restore point: %w", err)
	}
	if p.Kind == "vm" {
		// PCI or USB passthrough, a device mapping, virtiofs, host ports, raw arguments: PVE
		// restores those only for root@pam, so the node restores such a VM as root.
		if rootKeys = rootOnlyVMKeys(parseConfigText(rp.GuestConfig)); len(rootKeys) > 0 {
			sp.Root = true
			s.Logf("restore of %s: %s, which PVE restores only for root@pam: restoring as root", p.Volname, strings.Join(rootKeys, ", "))
		}
	}
	if p.Kind == "ct" {
		// PVE restores raw lxc.* keys only for root@pam; the token's restore skips them.
		lxc = rawLxcOptions(rp.GuestConfig)
		if len(lxc.Lines) > 0 {
			s.Logf("restore of %s: PVE restores raw LXC options only for root@pam; add them as root: %s", p.Volname, strings.Join(lxc.Lines, " | "))
		}
		conf := parseConfigText(rp.GuestConfig)
		staticIPs = containerStaticIPs(conf)
		onboot = conf["onboot"] == "1"
		madeUnprivileged = conf["unprivileged"] != "1"
		// Every container restore names its rootfs and volume mount points and leaves the bind
		// and device mount points out (RestoreMounts): PVE restores those only for root@pam.
		mounts, left, err := RestoreMounts(conf, p.TargetStorage, b.mountSizing(ctx, p.TargetStorage, rp))
		if err != nil {
			return nil, err
		}
		omitted = left
		if len(omitted) > 0 {
			s.Logf("restore of %s: left out (not part of the backup): %s", p.Volname, strings.Join(omitted, " | "))
		}
		sp.Params = map[string]string{}
		if p.RestoreTest {
			sp.Params["hostname"] = tempName(PurposeRestoreCheck, source)
		}
		for k, v := range mounts {
			sp.Params[k] = v
		}
	}
	vmid, upid, err := b.startRestore(ctx, sp)
	if err != nil {
		if p.RestoreTest && vmid > 0 {
			// Only a guest proven ours goes (a restore the refused call started all the same).
			cctx, cancel := cleanupContext(ctx)
			defer cancel()
			b.removeTemp(cctx, p.Kind, vmid)
		}
		return nil, err
	}
	st := restoreState{VMID: vmid, UPID: upid, OmittedMounts: omitted, SkippedLxc: lxc.Lines, CustomIDMap: lxc.IDMap,
		OnbootCleared: onboot, SourceVMID: source, MadeUnprivileged: madeUnprivileged, Root: sp.Root,
		StaticIPs: staticIPs}
	if !p.RestoreTest {
		st.KeptDevices = hostDeviceKeys(rootKeys)
	}
	s.keepInflight(inflightTask{TaskID: t.ID, Kind: t.Kind, Params: t.Params, UPID: upid, VMID: vmid,
		StartedAt: time.Now().UTC().Format(time.RFC3339), Restore: &st})
	return s.finishRestore(ctx, t.ID, p, st)
}

// finishRestore waits for the restore task and ends the restore. A check removes its guest on
// every way out (also when the restore failed or the wait ended) and says whether that worked:
// `deleted` only once the guest's configuration is gone, else `deleted: false` with
// `leftoverVmid`.
func (s *Service) finishRestore(ctx context.Context, taskID string, p restoreParams, st restoreState) (result map[string]any, err error) {
	b := s.bootTester()
	vmid, upid := st.VMID, st.UPID
	result = map[string]any{"vmid": vmid, "upid": upid}
	if len(st.OmittedMounts) > 0 {
		result["omittedMounts"] = st.OmittedMounts
	}
	if st.OnbootCleared {
		result["onbootCleared"] = true
	}
	if st.MadeUnprivileged {
		result["madeUnprivileged"] = true
	}
	if st.Root {
		result["restoredAsRoot"] = true
	}
	if len(st.KeptDevices) > 0 {
		// Restored with the host devices the original uses: check them before starting.
		result["keptDevices"] = st.KeptDevices
	}
	if len(st.OmittedMounts) > 0 && !p.RestoreTest {
		// The copy runs without them until they are put back (as root); a bind mount point
		// put back shares the original's live data, and on another node its host path may
		// not exist.
		result["remountCommands"] = remountCommands(vmid, st.OmittedMounts)
	}
	if p.RestoreTest {
		defer func() {
			if ctx.Err() != nil && s.inflight(taskID) != nil {
				// The service stops: the check is waited for again after the restart, which
				// removes the guest then (its marker keeps it known meanwhile).
				return
			}
			cctx, cancel := cleanupContext(ctx)
			defer cancel()
			if b.removeTemp(cctx, p.Kind, vmid) {
				result["deleted"] = true
			} else {
				result["deleted"] = false
				result["leftoverVmid"] = vmid
				s.Logf("restore check: the temporary guest %d could not be removed", vmid)
			}
		}()
	}
	exit, err := b.waitRestore(ctx, upid)
	if err != nil {
		return result, err
	}
	if exit != "OK" {
		tail := b.taskLog(ctx, upid, 200)
		if !TaskWarnings(exit) {
			msg := fmt.Sprintf("restore ended with %q: %s", exit, lastLines(tail, 8))
			if st.CustomIDMap {
				msg += "; " + idmapHint
			}
			return result, errors.New(msg)
		}
		// The restore ran to its end and warned beside it: a restore with warnings, once the
		// guest is there (its configuration can be read).
		result["warnings"] = WarningLines(tail, 10)
	}
	addLxcResult(result, st)
	var conf map[string]any
	var cerr error
	if p.RestoreTest || exit != "OK" {
		conf, cerr = b.PVE.GuestConfig(ctx, s.State.NodeName, p.Kind, vmid)
	}
	if p.RestoreTest {
		if cerr == nil {
			b.recordCreated(vmid, conf)
			result["disks"] = len(GuestDisks(p.Kind, conf))
		}
		if err := b.markTemp(ctx, PurposeRestoreCheck, p.Kind, vmid, st.SourceVMID); err != nil {
			s.Logf("restore check: marking the temporary guest %d: %v", vmid, err)
		}
	}
	if cerr != nil {
		return result, fmt.Errorf("the restored guest has no readable configuration: %w", cerr)
	}
	if p.Start && !p.RestoreTest {
		s.startRestored(ctx, p, st, result)
	}
	return result, nil
}

// startRestored starts a restored guest as root when the task asks for it and the copy may
// run: not without the mount points the restore left out, not with the original's host
// devices, and a container not with a static IP its running original uses. The restore itself
// succeeded either way; the result says whether the guest started (`started`, `startError`) or
// why it was not started (`startSkipped`, `startSkippedMessage`).
func (s *Service) startRestored(ctx context.Context, p restoreParams, st restoreState, result map[string]any) {
	b := s.bootTester()
	skip := func(reason, msg string) {
		result["started"], result["startSkipped"], result["startSkippedMessage"] = false, reason, msg
		s.Logf("restore of %s: the guest %d is not started: %s", p.Volname, st.VMID, msg)
	}
	switch {
	case len(st.OmittedMounts) > 0:
		skip("omitted_mounts", "the restore left mount points out ("+mountKeys(st.OmittedMounts)+"); put them back, then start it")
		return
	case len(st.KeptDevices) > 0:
		skip("host_devices", "restored with host devices "+strings.Join(st.KeptDevices, ", ")+" that the original also uses; check them before starting")
		return
	case p.Kind == "ct" && len(st.StaticIPs) > 0 && st.SourceVMID > 0:
		running, known := b.guestRunning(ctx, st.SourceVMID)
		if running || !known {
			msg := fmt.Sprintf("the original CT %d runs with %s; change the IP, then start it", st.SourceVMID, strings.Join(st.StaticIPs, ", "))
			if !known {
				msg = fmt.Sprintf("the original CT %d may run with %s (its state is unknown); change the IP, then start it", st.SourceVMID, strings.Join(st.StaticIPs, ", "))
			}
			skip("static_ip", msg)
			return
		}
	}
	if err := b.startGuest(ctx, p.Kind, st.VMID); err != nil {
		result["started"], result["startError"] = false, err.Error()
		s.Logf("restore of %s: the guest %d did not start: %v", p.Volname, st.VMID, err)
		return
	}
	result["started"] = true
}

// mountKeys are the keys of left-out mount point lines ("mp0, mp2").
func mountKeys(lines []string) string {
	var keys []string
	for _, l := range lines {
		k, _, _ := strings.Cut(l, ":")
		keys = append(keys, k)
	}
	return strings.Join(keys, ", ")
}

// containerStaticIPs are the static addresses of a container's interfaces.
func containerStaticIPs(conf map[string]string) []string {
	var out []string
	keys := make([]string, 0, len(conf))
	for k := range conf {
		if netKeyRE.MatchString(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, opt := range strings.Split(conf[k], ",") {
			key, v, ok := strings.Cut(strings.TrimSpace(opt), "=")
			if !ok || (key != "ip" && key != "ip6") {
				continue
			}
			switch v {
			case "", "dhcp", "auto", "manual":
				continue
			}
			addr, _, _ := strings.Cut(v, "/")
			out = append(out, addr)
		}
	}
	return out
}

// idmapHint explains a container restore that failed with a custom lxc.idmap in its backup.
const idmapHint = "the backup has a custom lxc.idmap, which PVE restores only for root@pam: the restore uses the default map, so files owned by ids outside it cannot be unpacked"

// addLxcResult names the raw LXC options the restore skipped.
func addLxcResult(result map[string]any, st restoreState) {
	if len(st.SkippedLxc) == 0 {
		return
	}
	result["skippedLxc"] = st.SkippedLxc
	if st.CustomIDMap {
		result["customIdmap"] = true
	}
}
