//go:build !windows

package pve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Temporary guests: a boot test and a restore check restore a restore point into the pool
// restow-restore and remove the guest again. Both go through one lifecycle (docs/PVE.md, "Boot
// test" and "Restore check"):
//
//   - A marker file in /var/lib/restow-pve/tempguests/<vmid>.json is written before the restore
//     is asked for (VMID, kind, purpose, start time; the UPID of the restore task and the
//     guest's creation time once known). It survives a crash or a reboot of the node.
//   - Right after the restore the guest gets the purpose's tag and name, onboot 0 and
//     protection 0 (a boot test in isolate()).
//   - Removing a guest needs proof that it is ours: on this node, and tagged and named so, or
//     its marker's restore task still runs for it, or its creation time is the one the marker
//     recorded, or a container still carries the name the restore gave it. A guest in the pool
//     without such proof is never removed: real restores live in that pool as well.
//   - The removal stops a restore task that still runs, unlocks the guest, clears its
//     protection, stops and destroys it as root, and counts only when its configuration is
//     gone afterwards.
//   - Whatever a crash left behind is removed when the service starts (whether boot tests and
//     restores are switched on or not) and before every boot test.

const (
	// PurposeBootTest and PurposeRestoreCheck name what a temporary guest is for.
	PurposeBootTest     = "boottest"
	PurposeRestoreCheck = "restorecheck"

	// RestoreCheckTag marks the temporary guests of restore checks (and only those).
	RestoreCheckTag = "restow-restorecheck"
	// RestoreCheckNamePrefix starts the name of every restore check's guest.
	RestoreCheckNamePrefix = "restow-restorecheck-"
)

func tempTag(purpose string) string {
	if purpose == PurposeRestoreCheck {
		return RestoreCheckTag
	}
	return BootTestTag
}

// tempName is the name of a temporary guest: the purpose's prefix and the original's VMID.
func tempName(purpose string, sourceVMID int) string {
	if purpose == PurposeRestoreCheck {
		return RestoreCheckNamePrefix + strconv.Itoa(sourceVMID)
	}
	return BootTestNamePrefix + strconv.Itoa(sourceVMID)
}

// tempMarker records a temporary guest from before its restore is asked for.
type tempMarker struct {
	VMID      int    `json:"vmid"`
	Kind      string `json:"kind"`
	Purpose   string `json:"purpose,omitempty"`
	StartedAt string `json:"startedAt"`
	UPID      string `json:"upid,omitempty"`
	// CTime is the guest's creation time (a VM's `meta: ctime=`) once the restore made it.
	CTime int64 `json:"ctime,omitempty"`
	// Name is the hostname the restore gave a container.
	Name string `json:"name,omitempty"`
}

func (b *BootTester) markerDir() string { return filepath.Join(b.Layout.DataDir, "tempguests") }

func (b *BootTester) markerPath(vmid int) string {
	return filepath.Join(b.markerDir(), strconv.Itoa(vmid)+".json")
}

// legacyMarkerFile is where boot tests before 0.5.0 kept their one marker.
func (b *BootTester) legacyMarkerFile() string {
	return filepath.Join(b.Layout.DataDir, "boottest", "current.json")
}

func (b *BootTester) writeMarker(m tempMarker) error {
	return writeJSONAtomic(b.markerPath(m.VMID), m, 0o600)
}

func (b *BootTester) readMarker(vmid int) *tempMarker {
	var m tempMarker
	if err := readJSON(b.markerPath(vmid), &m); err != nil || m.VMID != vmid {
		return nil
	}
	return &m
}

func (b *BootTester) dropMarker(vmid int) { _ = os.Remove(b.markerPath(vmid)) }

// markedVMIDs are the VMIDs this node's marker files name (read only; also the marker of an
// older release).
func (b *BootTester) markedVMIDs() map[int]bool {
	out := map[int]bool{}
	var legacy tempMarker
	if err := readJSON(b.legacyMarkerFile(), &legacy); err == nil && legacy.VMID > 0 {
		out[legacy.VMID] = true
	}
	entries, _ := os.ReadDir(b.markerDir())
	for _, e := range entries {
		if id, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json")); err == nil && strings.HasSuffix(e.Name(), ".json") {
			out[id] = true
		}
	}
	return out
}

// markers lists the marker files (a boot test marker of an older release is taken over).
func (b *BootTester) markers() []tempMarker {
	var legacy tempMarker
	if err := readJSON(b.legacyMarkerFile(), &legacy); err == nil && legacy.VMID > 0 {
		if legacy.Purpose == "" {
			legacy.Purpose = PurposeBootTest
		}
		if b.readMarker(legacy.VMID) == nil && b.writeMarker(legacy) != nil {
			return []tempMarker{legacy}
		}
	}
	_ = os.Remove(b.legacyMarkerFile())
	var out []tempMarker
	entries, _ := os.ReadDir(b.markerDir())
	for _, e := range entries {
		id, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if m := b.readMarker(id); m != nil {
			out = append(out, *m)
		}
	}
	return out
}

// restoreSpec is one restore through PVE.
type restoreSpec struct {
	// Purpose is "" for a restore into a new guest, else PurposeBootTest or PurposeRestoreCheck.
	Purpose    string
	Kind       string
	SourceVMID int
	Archive    string
	Storage    string
	Pool       string
	// VMID is a target the task names; 0 takes the cluster's next free VMID outside Avoid.
	VMID  int
	Avoid map[int]bool
	// Params are a container's rootfs, mpN (and the name of a temporary one).
	Params map[string]string
	// Root restores a VM as root through qmrestore: its configuration holds what PVE lets only
	// root@pam restore (rootOnlyVMKeys).
	Root bool
}

// maxVMIDAttempts: /cluster/nextid hands out the same VMID to two restores that start in the
// same second (boot tests on two nodes, an admin creating a VM), and one of them is refused.
const maxVMIDAttempts = 3

// startRestore asks PVE for the restore and returns the VMID and the UPID of its task. A
// temporary guest's marker is written before the restore is asked for. An error means no
// restore task is known to run; vmid is then the VMID it was asked for (or 0), which the
// caller's removal checks again before it touches anything.
func (b *BootTester) startRestore(ctx context.Context, sp restoreSpec) (vmid int, upid string, err error) {
	for attempt := 1; ; attempt++ {
		vmid = sp.VMID
		if vmid == 0 {
			if vmid, err = b.nextVMID(ctx, sp.Avoid); err != nil {
				return 0, "", fmt.Errorf("no free VMID: %w", err)
			}
		}
		var m tempMarker
		if sp.Purpose != "" {
			m = tempMarker{VMID: vmid, Kind: sp.Kind, Purpose: sp.Purpose, StartedAt: b.now().UTC().Format(time.RFC3339)}
			if sp.Kind == "ct" {
				m.Name = sp.Params["hostname"]
			}
			if err := b.writeMarker(m); err != nil {
				return 0, "", fmt.Errorf("marker of the temporary guest: %w", err)
			}
		}
		if sp.Root {
			upid, err = b.startRootRestore(ctx, sp, vmid)
		} else {
			upid, err = b.PVE.RestoreGuest(ctx, b.State.NodeName, sp.Kind, vmid, sp.Archive, sp.Storage, sp.Pool, sp.Params)
		}
		if err == nil {
			if sp.Purpose != "" {
				m.UPID = upid
				_ = b.writeMarker(m)
			}
			return vmid, upid, nil
		}
		if !vmidTaken(err) {
			return vmid, "", err
		}
		// Another guest has the VMID: it is not ours, and its marker would say otherwise.
		if sp.Purpose != "" {
			b.dropMarker(vmid)
		}
		if sp.VMID != 0 || attempt >= maxVMIDAttempts {
			return 0, "", err
		}
		b.logf("VMID %d was taken meanwhile; asking for another one", vmid)
	}
}

// maxVMIDProbes bounds the VMIDs nextVMID asks the cluster about beyond its first answer.
const maxVMIDProbes = 64

// vmidSet makes a set of a list of VMIDs.
func vmidSet(ids []int) map[int]bool {
	if len(ids) == 0 {
		return nil
	}
	out := make(map[int]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// nextVMID is a free VMID outside avoid: the cluster's next free one (/cluster/nextid), else
// the next ones upwards that the cluster says are free (GET /cluster/nextid?vmid=N), skipping
// the avoided ones without asking. A restore under the VMID of a guest Restow still keeps would
// take over that guest's history at the next inventory.
func (b *BootTester) nextVMID(ctx context.Context, avoid map[int]bool) (int, error) {
	first, err := b.PVE.NextID(ctx)
	if err != nil {
		return 0, err
	}
	if !avoid[first] {
		return first, nil
	}
	n := first
	for probes := 0; probes < maxVMIDProbes; probes++ {
		for avoid[n] {
			n++
		}
		free, err := b.PVE.VMIDFree(ctx, n)
		if err != nil {
			return 0, err
		}
		if free {
			b.logf("VMID %d belongs to a guest Restow keeps; taking %d", first, n)
			return n, nil
		}
		n++
	}
	return 0, fmt.Errorf("no free VMID above %d outside the ones Restow keeps after %d attempts", first, maxVMIDProbes)
}

// vmidTaken says whether PVE refused a restore because the VMID exists already.
func vmidTaken(err error) bool {
	return err != nil && strings.Contains(err.Error(), "already exists")
}

// waitRestore waits for a restore task and returns its exit status.
func (b *BootTester) waitRestore(ctx context.Context, upid string) (string, error) {
	if strings.HasPrefix(upid, cliUPIDPrefix) {
		r, ok := b.takeCLI(upid)
		if !ok {
			return "", errors.New("the restore through qmrestore ended before restow-pve restarted; how it ended is unknown")
		}
		return cliExit(r), nil
	}
	poll := b.TaskPoll
	if poll <= 0 {
		poll = 5 * time.Second
	}
	return b.PVE.WaitTask(ctx, b.State.NodeName, upid, poll)
}

// taskLog is the end of a restore task's log.
func (b *BootTester) taskLog(ctx context.Context, upid string, lines int) string {
	if strings.HasPrefix(upid, cliUPIDPrefix) {
		b.mu.Lock()
		defer b.mu.Unlock()
		return lastLines(b.cliOut[upid], lines)
	}
	tail, _ := b.PVE.TaskLogTail(ctx, b.State.NodeName, upid, lines)
	return tail
}

// cliUPIDPrefix names a root restore whose PVE task was not found: its outcome is qmrestore's.
const cliUPIDPrefix = "cli:"

type cliResult struct {
	out string
	err error
}

// startRootRestore runs `qmrestore <archive> <vmid> --storage S --unique 1 --pool P` as root
// (never --force, never --start) and returns the UPID of its task once PVE lists it: the wait,
// a removal and a restart of the service then follow the task as for any restore.
func (b *BootTester) startRootRestore(ctx context.Context, sp restoreSpec, vmid int) (string, error) {
	since := time.Now().Add(-5 * time.Second)
	args := []string{sp.Archive, strconv.Itoa(vmid), "--storage", sp.Storage, "--unique", "1"}
	if sp.Pool != "" {
		args = append(args, "--pool", sp.Pool)
	}
	b.logf("restoring as root: qmrestore %s", strings.Join(args, " "))
	done := make(chan cliResult, 1)
	go func() {
		out, err := b.command(ctx, "qmrestore", args...)
		done <- cliResult{out, err}
	}()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case r := <-done:
			if upid := b.findRootRestore(ctx, vmid, since); upid != "" {
				return upid, nil
			}
			if r.err != nil && !strings.Contains(r.out, "TASK ") {
				// qmrestore ended before PVE ran a task (the VMID exists, a refused option).
				if out := lastLines(r.out, 3); out != "" && !strings.Contains(r.err.Error(), out) {
					return "", fmt.Errorf("qmrestore: %w: %s", r.err, out)
				}
				return "", fmt.Errorf("qmrestore: %w", r.err)
			}
			upid := cliUPIDPrefix + strconv.Itoa(vmid)
			b.mu.Lock()
			if b.cliOut == nil {
				b.cliOut, b.cliRes = map[string]string{}, map[string]cliResult{}
			}
			b.cliOut[upid], b.cliRes[upid] = r.out, r
			b.mu.Unlock()
			return upid, nil
		case <-tick.C:
			if upid := b.findRootRestore(ctx, vmid, since); upid != "" {
				return upid, nil
			}
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func (b *BootTester) takeCLI(upid string) (cliResult, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	r, ok := b.cliRes[upid]
	delete(b.cliRes, upid)
	return r, ok
}

// findRootRestore finds the qmrestore task root started for the VMID since then.
func (b *BootTester) findRootRestore(ctx context.Context, vmid int, since time.Time) string {
	tasks, err := b.PVE.RecentTasks(ctx, b.State.NodeName, "qmrestore", vmid)
	if err != nil {
		return ""
	}
	for _, t := range tasks {
		if t.ID != strconv.Itoa(vmid) || !strings.HasPrefix(t.User, "root@pam") {
			continue
		}
		if started, ok := upidStart(t.UPID); ok && started.Before(since) {
			continue
		}
		return t.UPID
	}
	return ""
}

var taskEndRE = regexp.MustCompile(`^TASK (OK|WARNINGS: \d+|ERROR: .*)$`)

// cliExit is the exit status of a task from the output of the command that ran it.
func cliExit(r cliResult) string {
	lines := strings.Split(strings.TrimSpace(r.out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if m := taskEndRE.FindStringSubmatch(strings.TrimSpace(lines[i])); m != nil {
			return strings.TrimPrefix(m[1], "ERROR: ")
		}
	}
	if r.err == nil {
		return "OK"
	}
	return lastLines(r.out, 3)
}

// rootOnlyVMKeys are the keys of a VM configuration that PVE restores only for root@pam (its
// restore permission check, check_restore_permissions and check_mapping_access): PCI
// passthrough (a mapped device needs Mapping.Use, which the node's token does not hold), USB
// host and mapped devices, virtiofs, serial and parallel ports on host devices, raw QEMU
// arguments and a hook script.
func rootOnlyVMKeys(conf map[string]string) []string {
	var out []string
	for k, v := range conf {
		switch {
		case hostpciRE.MatchString(k), virtiofsRE.MatchString(k), k == "args", k == "hookscript":
			out = append(out, k)
		case usbRE.MatchString(k) && !strings.Contains(v, "spice"):
			out = append(out, k)
		case (serialRE.MatchString(k) || parallelRE.MatchString(k)) && strings.HasPrefix(strings.TrimSpace(v), "/dev"):
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// hostDeviceKeys are the root-only keys that bind the guest to a device of the host (or run
// arbitrary QEMU arguments): a restored copy with them is not started by the restore.
func hostDeviceKeys(keys []string) []string {
	var out []string
	for _, k := range keys {
		if k != "hookscript" {
			out = append(out, k)
		}
	}
	return out
}

var (
	hostpciRE  = regexp.MustCompile(`^hostpci\d+$`)
	usbRE      = regexp.MustCompile(`^usb\d+$`)
	virtiofsRE = regexp.MustCompile(`^virtiofs\d+$`)
	parallelRE = regexp.MustCompile(`^parallel\d+$`)
)

var metaCTimeRE = regexp.MustCompile(`(?:^|,)ctime=(\d+)`)

// metaCTime is a VM's creation time from `meta: creation-qemu=...,ctime=...` (0: none).
func metaCTime(conf map[string]any) int64 {
	m := metaCTimeRE.FindStringSubmatch(fmt.Sprint(conf["meta"]))
	if m == nil {
		return 0
	}
	n, _ := strconv.ParseInt(m[1], 10, 64)
	return n
}

// recordCreated keeps the creation time of a restored temporary guest in its marker: from then
// on that time proves the guest ours, before its tag is set.
func (b *BootTester) recordCreated(vmid int, conf map[string]any) {
	m := b.readMarker(vmid)
	if m == nil {
		return
	}
	if ct := metaCTime(conf); ct != 0 {
		m.CTime = ct
		_ = b.writeMarker(*m)
	}
}

// markTemp gives a restored temporary guest its tag and name and keeps it from starting with
// the node or being protected from removal (a boot test does this in isolate()).
func (b *BootTester) markTemp(ctx context.Context, purpose, kind string, vmid, sourceVMID int) error {
	args := []string{"set", strconv.Itoa(vmid)}
	if kind == "vm" {
		args = append(args, "--name", tempName(purpose, sourceVMID))
	} else {
		args = append(args, "--hostname", tempName(purpose, sourceVMID))
	}
	args = append(args, "--tags", tempTag(purpose), "--onboot", "0", "--protection", "0")
	_, err := b.command(ctx, b.cli(kind), args...)
	return err
}

// gone says whether this node has no guest of the VMID any more (its configuration does not
// exist); an error means it is not known.
func (b *BootTester) gone(ctx context.Context, kind string, vmid int) (bool, error) {
	_, err := b.command(ctx, b.cli(kind), "config", strconv.Itoa(vmid))
	if err == nil {
		return false, nil
	}
	if strings.Contains(err.Error(), "does not exist") {
		return true, nil
	}
	return false, err
}

// ownership is what owned found out about a guest.
type ownership int

const (
	// notOurs: proven not a temporary guest of this node (another node's guest, one without
	// tag and name, the VMID given to another guest): left alone, its marker dropped.
	notOurs ownership = iota
	// ours: proven a temporary guest of this node; it is removed.
	ours
	// ownershipUnknown: PVE could not be asked (pveproxy restarts, the node boots, a timeout).
	// That proves nothing either way: the guest is left alone and its marker kept, so the
	// removal is tried again.
	ownershipUnknown
)

// owned says whether the guest of the VMID is a temporary guest of this node (see the top of
// this file), and why not.
func (b *BootTester) owned(ctx context.Context, kind string, vmid int, m *tempMarker) (ownership, string) {
	guests, err := b.PVE.Guests(ctx)
	if err != nil {
		return ownershipUnknown, "the guests of the cluster are unknown: " + err.Error()
	}
	var res *Resource
	for i := range guests {
		if guests[i].VMID == vmid {
			res = &guests[i]
		}
	}
	if res != nil && res.Node != b.State.NodeName {
		return notOurs, "it runs on node " + res.Node
	}
	if res != nil && res.Pool == BootTestPool && tempTagged(*res) {
		return ours, ""
	}
	if m == nil {
		return notOurs, "it carries neither the tag nor the name of a temporary guest"
	}
	conf, err := b.PVE.GuestConfig(ctx, b.State.NodeName, kind, vmid)
	if err != nil {
		return ownershipUnknown, "its configuration is unknown: " + err.Error()
	}
	if strings.TrimSpace(fmt.Sprint(conf["lock"])) == "create" {
		// A restore creates it (or one that failed left it): ours when that is the restore
		// task the marker names, and no other restore runs for the VMID.
		return b.ownedWhileCreated(ctx, vmid, m)
	}
	if res == nil || res.Pool != BootTestPool {
		return notOurs, "it is not in the pool " + BootTestPool
	}
	if m.CTime != 0 && metaCTime(conf) == m.CTime {
		return ours, ""
	}
	if kind == "ct" && m.Name != "" && strings.TrimSpace(fmt.Sprint(conf["hostname"])) == m.Name {
		return ours, ""
	}
	return notOurs, "nothing proves it is the guest the marker recorded (the VMID may have been given to another guest since)"
}

// ownedWhileCreated decides about a guest a restore creates (lock: create): ours when the
// marker's restore task runs for it, or that task ended and no other restore runs for the VMID.
func (b *BootTester) ownedWhileCreated(ctx context.Context, vmid int, m *tempMarker) (ownership, string) {
	id := strconv.Itoa(vmid)
	upid := m.UPID
	if upid == "" {
		var err error
		if upid, err = b.recoverRestoreTask(ctx, vmid, m); err != nil {
			return ownershipUnknown, "the running tasks of the node are unknown: " + err.Error()
		}
	}
	running := false
	switch {
	case upid == cliUPIDPrefix+id:
		// qmrestore as root, whose PVE task was not found: the command has ended.
	case upid != "" && strings.Contains(upid, ":"+id+":"):
		st, err := b.PVE.TaskStatus(ctx, b.State.NodeName, upid)
		if err != nil && !noSuchTask(err) {
			return ownershipUnknown, "the state of its restore task is unknown: " + err.Error()
		}
		running = err == nil && st.Status == "running"
	default:
		return notOurs, "a restore that is not ours creates it"
	}
	if running {
		return ours, ""
	}
	other, err := b.recoverRestoreTask(ctx, vmid, m)
	if err != nil {
		return ownershipUnknown, "the running tasks of the node are unknown: " + err.Error()
	}
	if other == "" || other == upid {
		return ours, ""
	}
	return notOurs, "a restore that is not ours creates it"
}

// noSuchTask says whether PVE does not know the task at all (no task log: it never ran here).
func noSuchTask(err error) bool {
	var pe *PVEAPIError
	return errors.As(err, &pe) && strings.Contains(pe.Message, "no such task")
}

// recoverRestoreTask finds the restore task a refused or timed-out restore call may have started
// all the same: one running for the VMID, started by this node's token or root since the marker.
// An error means the running tasks are unknown.
func (b *BootTester) recoverRestoreTask(ctx context.Context, vmid int, m *tempMarker) (string, error) {
	tasks, err := b.PVE.ActiveTasks(ctx, b.State.NodeName, "")
	if err != nil {
		return "", err
	}
	since, _ := time.Parse(time.RFC3339, m.StartedAt)
	for _, t := range tasks {
		if (t.Type != "qmrestore" && t.Type != "vzrestore" && t.Type != "vzcreate") || t.ID != strconv.Itoa(vmid) {
			continue
		}
		if started, ok := upidStart(t.UPID); ok && !since.IsZero() && started.Before(since.Add(-time.Minute)) {
			continue
		}
		return t.UPID, nil
	}
	return "", nil
}

// upidStart is the start time in a UPID (UPID:node:pid:pstart:starttime:type:id:user:).
func upidStart(upid string) (time.Time, bool) {
	parts := strings.Split(upid, ":")
	if len(parts) < 8 {
		return time.Time{}, false
	}
	n, err := strconv.ParseInt(parts[4], 16, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(n, 0), true
}

// removeTemp removes a temporary guest once it is proven ours; true when it is gone. A guest
// proven not ours is left alone and its marker dropped (the marker no longer names it). When
// that cannot be decided (PVE does not answer) or its restore task cannot be stopped, the guest
// is left alone and the marker kept: the removal is tried again (Cleanup).
func (b *BootTester) removeTemp(ctx context.Context, kind string, vmid int) bool {
	m := b.readMarker(vmid)
	if g, err := b.gone(ctx, kind, vmid); err == nil && g {
		b.dropMarker(vmid)
		return true
	}
	switch own, why := b.owned(ctx, kind, vmid, m); own {
	case notOurs:
		b.logf("guest %d is not removed: %s", vmid, why)
		b.dropMarker(vmid)
		return false
	case ownershipUnknown:
		b.logf("guest %d is not removed now: %s; the removal is tried again", vmid, why)
		return false
	}
	id := strconv.Itoa(vmid)
	cli := b.cli(kind)
	upid := ""
	if m != nil {
		upid = m.UPID
		if upid == "" {
			var err error
			if upid, err = b.recoverRestoreTask(ctx, vmid, m); err != nil {
				b.logf("guest %d is not removed now: the running tasks of the node are unknown: %v; the removal is tried again", vmid, err)
				return false
			}
		}
	}
	if upid != "" && !b.stopTask(ctx, upid) {
		// Destroying the guest under a running restore races with it: the restore may write on
		// or leave a half-made guest and volumes behind.
		b.logf("guest %d is not removed now: its restore task %s may still run; the removal is tried again", vmid, upid)
		return false
	}
	if _, err := b.command(ctx, cli, "unlock", id); err != nil {
		b.logf("unlock: %v", err)
	}
	if _, err := b.command(ctx, cli, "set", id, "--protection", "0"); err != nil {
		b.logf("protection: %v", err)
	}
	if _, err := b.command(ctx, cli, "stop", id, "--skiplock", "1"); err != nil {
		b.logf("stop: %v", err)
	}
	args := []string{"destroy", id, "--purge", "1", "--destroy-unreferenced-disks", "1"}
	if kind == "vm" {
		args = append(args, "--skiplock", "1")
	} else {
		args = append(args, "--force", "1")
	}
	if _, err := b.command(ctx, cli, args...); err != nil {
		b.logf("destroy: %v", err)
	}
	if g, err := b.gone(ctx, kind, vmid); err != nil || !g {
		b.logf("the temporary guest %d is still there; the removal is tried again", vmid)
		return false
	}
	b.dropMarker(vmid)
	b.logf("the temporary guest %d is destroyed", vmid)
	return true
}

// stopTask stops a restore task that still runs and waits (at most two minutes) until PVE says
// it stopped. True only when the task is known not to run (any more): it ended, PVE never ran
// it, or its qmrestore command has ended. False when its state is unknown, the stop was refused
// or the task still runs: the caller then leaves the guest alone.
func (b *BootTester) stopTask(ctx context.Context, upid string) bool {
	if strings.HasPrefix(upid, cliUPIDPrefix) {
		// Recorded only once qmrestore returned (startRootRestore); a stop of the service ends
		// the command with the service's processes.
		return true
	}
	st, err := b.PVE.TaskStatus(ctx, b.State.NodeName, upid)
	if err != nil {
		if noSuchTask(err) {
			return true
		}
		b.logf("the state of the restore task %s is unknown: %v", upid, err)
		return false
	}
	if st.Status != "running" {
		return true
	}
	b.logf("stopping the restore task %s", upid)
	if err := b.stopPVETask(ctx, upid); err != nil {
		b.logf("stopping %s: %v", upid, err)
		return false
	}
	deadline := b.now().Add(2 * time.Minute)
	for {
		if st, err := b.PVE.TaskStatus(ctx, b.State.NodeName, upid); err == nil && st.Status != "running" {
			return true
		}
		if !b.now().Before(deadline) {
			b.logf("the restore task %s still runs two minutes after it was stopped", upid)
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(b.poll()):
		}
	}
}

// stopPVETask asks PVE to stop a task (DELETE /nodes/{node}/tasks/{upid}). The node's token may
// stop its own tasks only: a task of root@pam (a VM the node restored as root with qmrestore)
// needs Sys.Modify, which the token does not hold, so PVE refuses with 403. Such a task, and one
// the API could not stop, is stopped as root through pvesh (the same call, run as root@pam on
// this node, also while pveproxy does not answer).
func (b *BootTester) stopPVETask(ctx context.Context, upid string) error {
	var apiErr error
	if upidUser(upid) != "root@pam" {
		if apiErr = b.PVE.StopTask(ctx, b.State.NodeName, upid); apiErr == nil {
			return nil
		}
	}
	if _, err := b.command(ctx, "pvesh", "delete", "/nodes/"+b.State.NodeName+"/tasks/"+upid); err != nil {
		if apiErr != nil {
			return fmt.Errorf("%v; as root: %w", apiErr, err)
		}
		return fmt.Errorf("as root: %w", err)
	}
	return nil
}

// upidUser is the user in a UPID (UPID:node:pid:pstart:starttime:type:id:user:), "" when the
// UPID cannot be read.
func upidUser(upid string) string {
	parts := strings.Split(upid, ":")
	if len(parts) < 8 || parts[0] != "UPID" {
		return ""
	}
	return parts[7]
}

// cleanupContext is the context a removal runs in: it goes on when the task's own context ends
// (also when the service stops, then briefly: the marker lets the next start finish it).
func cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	budget := 10 * time.Minute
	if ctx.Err() != nil {
		budget = time.Minute
	}
	return context.WithTimeout(context.WithoutCancel(ctx), budget)
}

// Cleanup removes what earlier boot tests and restore checks left behind: the guests of the
// markers, and every guest of this node in the restore pool that carries the tag and the name
// of a temporary guest. A guest a recorded task still waits for (inflight.json) is left to it.
// True when nothing is left to try again: no marker outside those tasks remains and the
// cluster's guests could be listed (the service tries again while it is false).
func (b *BootTester) Cleanup(ctx context.Context) bool {
	skip := inflightVMIDs(b.Layout)
	for _, m := range b.markers() {
		if skip[m.VMID] {
			continue
		}
		if m.Purpose == "" {
			m.Purpose = PurposeBootTest
		}
		b.removeTemp(ctx, m.Kind, m.VMID)
	}
	guests, err := b.PVE.Guests(ctx)
	if err != nil {
		b.logf("leftover temporary guests: the guests of the cluster are unknown: %v; tried again", err)
		return false
	}
	// A tagged guest of this node in the pool is ours (owned): one that stays is tried again.
	done := true
	for _, g := range guests {
		if g.Node != b.State.NodeName || g.Pool != BootTestPool || skip[g.VMID] {
			continue
		}
		if !tempTagged(g) {
			continue
		}
		kind := "vm"
		if g.Type == "lxc" {
			kind = "ct"
		}
		b.logf("removing the leftover temporary guest %d (%s)", g.VMID, g.Name)
		if !b.removeTemp(ctx, kind, g.VMID) {
			done = false
		}
	}
	return done && !b.leftovers()
}

// leftovers says whether a marker of a temporary guest remains that no recorded task waits for.
func (b *BootTester) leftovers() bool {
	skip := inflightVMIDs(b.Layout)
	for id := range b.markedVMIDs() {
		if !skip[id] {
			return true
		}
	}
	return false
}

// tempTagged: the guest carries the tag and the name of a temporary guest of one purpose.
func tempTagged(g Resource) bool {
	return (hasTag(g.Tags, BootTestTag) && strings.HasPrefix(g.Name, BootTestNamePrefix)) ||
		(hasTag(g.Tags, RestoreCheckTag) && strings.HasPrefix(g.Name, RestoreCheckNamePrefix))
}

// startGuest starts a guest as root and waits (at most a minute) until it runs.
func (b *BootTester) startGuest(ctx context.Context, kind string, vmid int) error {
	id := strconv.Itoa(vmid)
	if _, err := b.command(ctx, b.cli(kind), "start", id); err != nil {
		return err
	}
	deadline := b.now().Add(time.Minute)
	var last string
	for {
		st, err := b.command(ctx, b.cli(kind), "status", id)
		if err == nil && strings.Contains(st, "status: running") {
			return nil
		}
		last = strings.TrimSpace(st)
		if err != nil {
			last = err.Error()
		}
		if !b.now().Before(deadline) {
			return fmt.Errorf("the guest does not run a minute after its start (%s)", last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(b.poll()):
		}
	}
}

// guestRunning says whether a guest of the cluster runs (known: the cluster could be asked).
func (b *BootTester) guestRunning(ctx context.Context, vmid int) (running, known bool) {
	guests, err := b.PVE.Guests(ctx)
	if err != nil {
		return false, false
	}
	for _, g := range guests {
		if g.VMID == vmid {
			return g.Status == "running", true
		}
	}
	return false, true
}
