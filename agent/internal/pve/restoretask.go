//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
}

func (s *Service) restoreTask(ctx context.Context, t Task) (map[string]any, error) {
	if !s.State.RestoresAllowed() {
		return nil, errors.New("restores are switched off on this node")
	}
	var p restoreParams
	if err := json.Unmarshal(t.Params, &p); err != nil || p.Volname == "" || p.TargetStorage == "" {
		return nil, errors.New("invalid restore task")
	}
	if p.Pool == "" {
		p.Pool = BootTestPool
	}
	b := s.bootTester()
	vmid := p.TargetVMID
	if vmid == 0 {
		var err error
		if vmid, err = b.PVE.NextID(ctx); err != nil {
			return nil, err
		}
	}
	archive := s.State.StorageID + ":backup/" + strings.TrimPrefix(p.Volname, "backup/")
	var mounts map[string]string
	var omitted []string
	var lxc lxcOptions
	if p.Kind == "ct" {
		rp, err := b.Resolve(ctx, p.Volname)
		if err != nil {
			return nil, fmt.Errorf("restore point: %w", err)
		}
		// PVE restores raw lxc.* keys only for root@pam; the token's restore skips them.
		lxc = rawLxcOptions(rp.GuestConfig)
		if len(lxc.Lines) > 0 {
			s.Logf("restore of %s: PVE restores raw LXC options only for root@pam; add them as root: %s", p.Volname, strings.Join(lxc.Lines, " | "))
		}
		if p.RestoreTest {
			// A check leaves bind and device mount points out (TestRestoreMounts).
			if mounts, omitted, err = TestRestoreMounts(parseConfigText(rp.GuestConfig), p.TargetStorage); err != nil {
				return nil, err
			}
			if len(omitted) > 0 {
				s.Logf("restore test of %s: left out (not part of the backup): %s", p.Volname, strings.Join(omitted, ", "))
			}
		}
	}
	upid, err := b.PVE.RestoreGuest(ctx, s.State.NodeName, p.Kind, vmid, archive, p.TargetStorage, p.Pool, p.Start && !p.RestoreTest, mounts)
	if err != nil {
		return nil, err
	}
	st := restoreState{VMID: vmid, UPID: upid, OmittedMounts: omitted, SkippedLxc: lxc.Lines, CustomIDMap: lxc.IDMap}
	s.keepInflight(inflightTask{TaskID: t.ID, Kind: t.Kind, Params: t.Params, UPID: upid, VMID: vmid,
		StartedAt: time.Now().UTC().Format(time.RFC3339), Restore: &st})
	return s.finishRestore(ctx, t.ID, p, st)
}

// finishRestore waits for the restore task and ends the restore (a check deletes its guest).
func (s *Service) finishRestore(ctx context.Context, taskID string, p restoreParams, st restoreState) (map[string]any, error) {
	b := s.bootTester()
	vmid, upid := st.VMID, st.UPID
	exit, err := b.PVE.WaitTask(ctx, s.State.NodeName, upid, 5*time.Second)
	result := map[string]any{"vmid": vmid, "upid": upid}
	if len(st.OmittedMounts) > 0 {
		result["omittedMounts"] = st.OmittedMounts
	}
	if err != nil {
		return result, err
	}
	if exit != "OK" {
		tail, _ := b.PVE.TaskLogTail(ctx, s.State.NodeName, upid, 200)
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
		result["disks"] = len(GuestDisks(p.Kind, conf))
		if dupid, derr := b.PVE.DeleteGuest(ctx, s.State.NodeName, p.Kind, vmid); derr == nil {
			_, _ = b.PVE.WaitTask(ctx, s.State.NodeName, dupid, 5*time.Second)
			result["deleted"] = true
		} else {
			s.Logf("restore test: could not delete guest %d: %v", vmid, derr)
		}
	}
	if cerr != nil {
		return result, fmt.Errorf("the restored guest has no readable configuration: %w", cerr)
	}
	return result, nil
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
