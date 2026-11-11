//go:build linux

package recovery

// The flow of recover around the erase: what must hold between the scan
// of the disks and the first step that writes to one (the same disks,
// one disk per identity, the snapshot that was asked for, Ctrl+C), and
// what a second start finds after a first one was interrupted.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// unattendedRun is one run with answers from fw_cfg against the fake
// instance, the fake machine and a real repository.
type unattendedRun struct {
	t   *testing.T
	f   *fakeRecovery
	env *testEnv
	exe *fakeExec
	m   *baremetal.Manifest
	out syncWriter
	r   *Recover
}

func newUnattended(t *testing.T) *unattendedRun {
	t.Helper()
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY to run the recovery flow with restic")
	}
	raw, err := os.ReadFile("../baremetal/testdata/manifests/debian12-uefi-luks-lvm.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := baremetal.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	repo, snap := snapshotOf(t, bin, raw)
	f := newFakeRecovery(t, "", testCode)
	f.status = api.RecoveryActive
	f.snapshotID, f.layoutSHA = snap, sha256Hex(string(raw))
	exe := newFakeExec()
	env := &testEnv{t: t, hw: hardwareFor(m), repo: repo, resticB: bin, target: t.TempDir(), exec: exe,
		iso: &fakeIsolator{exec: exe, reply: func(IsolateSpec) string { return "kernel/drivers/nvme/host/nvme.ko\n" }}, ops: &fakeOps{exec: exe, mounted: map[string]bool{}}}
	return &unattendedRun{t: t, f: f, env: env, exe: exe, m: m}
}

// answers builds the answers: extra is JSON that follows the fixed part
// (the mapping and the confirmation).
func (u *unattendedRun) run(extra string) (*Result, error) {
	u.t.Helper()
	doc := fmt.Sprintf(`{"format":"restow-answers-v1","instanceUrl":%q,"code":%q,"passphrase":%q,"afterSuccess":"poweroff",%s}`,
		u.f.srv.URL, FormatCode(testCode), testPassphrase, extra)
	a, err := LoadAnswers(SourceFWCfg, []byte(doc), true)
	if err != nil {
		u.t.Fatal(err)
	}
	u.r = &Recover{UI: &UI{In: strings.NewReader(""), Out: &u.out, Lang: LangEN}, Env: u.env, Answers: a, Version: "0.5.0", Log: &LogBuffer{}}
	return u.r.Run(context.Background())
}

func (u *unattendedRun) finish() *api.RecoveryFinish {
	u.f.mu.Lock()
	defer u.f.mu.Unlock()
	return u.f.finish
}

// nothingWritten: no command or operation that writes to a disk ran, the
// write probe included.
func (u *unattendedRun) nothingWritten(what string) {
	u.t.Helper()
	lines := u.exe.lines()
	for _, never := range []string{"probe-write", "op release", "wipefs", "op blkzero", "sfdisk", "luksFormat", "mkfs.", "restic restore"} {
		if strings.Contains(lines, never) {
			u.t.Errorf("%s: %s ran:\n%s", what, never, lines)
		}
	}
}

const (
	okMapping = `"diskMapping":{"d0":"serial.restow-e2e-target0"},"confirmErase":["serial.restow-e2e-target0"]`
)

// TestRecoverWriteProbeAfterConfirmation: the first write to a disk is
// the probe of the confirmed disk, after the confirmation and the second
// look at the hardware, before the first step; a run that is not
// confirmed writes nowhere.
func TestRecoverWriteProbeAfterConfirmation(t *testing.T) {
	u := newUnattended(t)
	res, err := u.run(okMapping)
	if err != nil || res == nil || res.Status != api.RecoverySucceeded {
		t.Fatalf("run: %v %+v\n%s", err, res, u.out.String())
	}
	lines := u.exe.lines()
	if strings.Count(lines, "probe-write") != 1 || !strings.HasPrefix(lines, "probe-write /dev/nvme0n1\nop release /dev/nvme0n1\n") {
		t.Errorf("the write probe is not the first thing after the confirmation:\n%s", lines[:min(len(lines), 300)])
	}
	if u.env.scans < 2+len(res.Plan.Steps) {
		t.Errorf("%d scans for %d steps: the disks were not read again before every step", u.env.scans, len(res.Plan.Steps))
	}
	// The probe fails on the confirmed disk (a locked drive): the run ends
	// before the first step.
	u = newUnattended(t)
	u.env.probeErr = fmt.Errorf("input/output error")
	res, _ = u.run(okMapping)
	fin := u.finish()
	if res == nil || res.Status != api.RecoveryFailed || fin == nil || fin.Status != api.RecoveryFailed || !strings.Contains(fmt.Sprint(fin.Warnings), baremetal.ProblemSEDLocked) {
		t.Errorf("probe failure: %+v, finish %+v", res, fin)
	}
	if lines := u.exe.lines(); strings.Contains(lines, "wipefs") || strings.Contains(lines, "op release") {
		t.Errorf("steps ran after the probe failed:\n%s", lines)
	}
	assertKnownCodes(t, fin.Warnings)
}

// TestRecoverDisksChangedAfterConfirmation: between the scan and the
// first step another disk comes up under the confirmed name (pulled and
// plugged, enumerated again). recover reads the hardware again after the
// last dialog and stops: nothing is written to the disk nobody confirmed.
func TestRecoverDisksChangedAfterConfirmation(t *testing.T) {
	swapped := func(u *unattendedRun) HardwareInput {
		hw := hardwareFor(u.m)
		hw.Blocks[0].Serial = "the-data-disk-nobody-confirmed"
		hw.Blocks[0].Signatures = []baremetal.TargetSignature{{Kind: "fs", UUID: "11111111-2222-4333-8444-555555555555"}}
		return hw
	}
	u := newUnattended(t)
	u.env.rescan = func(n int) (HardwareInput, bool) { return swapped(u), n >= 2 }
	res, _ := u.run(okMapping)
	fin := u.finish()
	if res == nil || res.Status != api.RecoveryFailed || fin == nil || fin.Status != api.RecoveryFailed {
		t.Fatalf("result %+v, finish %+v\n%s", res, fin, u.out.String())
	}
	u.nothingWritten("another disk under the confirmed name")
	if !strings.Contains(u.out.String(), "/dev/nvme0n1 was serial.restow-e2e-target0 and is serial.the-data-disk-nobody-confirmed") ||
		!strings.Contains(u.out.String(), T(LangEN, "ui.aborted")) {
		t.Errorf("the console does not say what changed:\n%s", u.out.String())
	}
	if !strings.Contains(fmt.Sprint(fin.Warnings), ErrDisksChanged.Error()) {
		t.Errorf("finish warnings %+v", fin.Warnings)
	}
	assertKnownCodes(t, fin.Warnings)

	// The same during the run: after the table was written (the scan
	// before the sixth step). The steps so far ran on the confirmed disk;
	// no later one runs on the other.
	u = newUnattended(t)
	const at = 2 + 5 // first scan, the look before the first step, five steps
	u.env.rescan = func(n int) (HardwareInput, bool) { return swapped(u), n >= at+1 }
	res, _ = u.run(okMapping)
	if res == nil || res.Status != api.RecoveryFailed {
		t.Fatalf("result %+v\n%s", res, u.out.String())
	}
	lines := u.exe.lines()
	if !strings.Contains(lines, "sfdisk --no-reread") {
		t.Fatalf("fixture: the table was not written before the change:\n%s", lines)
	}
	for _, never := range []string{"luksFormat", "pvcreate", "mkfs.", "restic restore", "mount "} {
		if strings.Contains(lines, never) {
			t.Errorf("%s ran after the disk changed:\n%s", never, lines)
		}
	}
	if !strings.Contains(u.out.String(), "/dev/nvme0n1 was serial.restow-e2e-target0") || !strings.Contains(u.out.String(), T(LangEN, "exec.failed", "n", 6)) {
		t.Errorf("console:\n%s", u.out.String())
	}

	// A foreign device-mapper device is open, the operator closes it in
	// the shell and swaps a disk there: the look at the hardware comes
	// after the shell.
	a := newAttended(t)
	a.env.ops.setDM(DMMapping{Node: "dm-9", Name: "old_crypt", UUID: "CRYPT-LUKS2-x", Slaves: []string{"/dev/sdz1"}})
	a.env.shell = func() {
		a.env.ops.setDM()
		hw := hardwareFor(u.m)
		hw.Blocks[0].Serial = "swapped-in-the-shell"
		a.env.mu.Lock()
		a.env.hw = hw
		a.env.mu.Unlock()
	}
	script := append(a.upToCode(spkiOf(t, a.f)), passLines...)
	script = append(script, "ERASE", "")
	a.run(script)
	if a.res == nil || a.res.Status != api.RecoveryFailed || !strings.Contains(a.out.String(), "swapped-in-the-shell") {
		t.Fatalf("a disk swapped in the shell: %+v %v\n%s", a.res, a.err, a.out.String())
	}
	for _, never := range []string{"wipefs", "sfdisk", "op release", "probe-write"} {
		if strings.Contains(a.exe.lines(), never) {
			t.Errorf("%s ran on the disk swapped in the shell", never)
		}
	}
}

// TestRecoverInterruptBeforeExecution: Ctrl+C after the confirmation and
// before the first step. The console says that nothing was erased, and
// nothing is: no step starts after that line.
func TestRecoverInterruptBeforeExecution(t *testing.T) {
	u := newUnattended(t)
	u.env.onExecutor = func() { u.r.Interrupt() }
	res, err := u.run(okMapping)
	if err != nil || res == nil || res.Status != api.RecoveryCancelled {
		t.Fatalf("result %+v %v\n%s", res, err, u.out.String())
	}
	if n := strings.Count(u.out.String(), T(LangEN, "ui.aborted")); n != 1 {
		t.Errorf("%d abort lines:\n%s", n, u.out.String())
	}
	u.nothingWritten("after Ctrl+C said that nothing was erased")
	if fin := u.finish(); fin == nil || fin.Status != api.RecoveryCancelled {
		t.Errorf("finish %+v", fin)
	}
	if !strings.Contains(u.out.String(), "RESTOW-RECOVER-RESULT cancelled") {
		t.Errorf("result line:\n%s", u.out.String())
	}
}

// TestRecoverAnswersSnapshotMustExist: the answers ask for a snapshot the
// code may not restore. The run fails; the snapshot of the code is not
// restored in its place, and nothing is erased.
func TestRecoverAnswersSnapshotMustExist(t *testing.T) {
	u := newUnattended(t)
	res, err := u.run(`"snapshotId":"deadbeefdeadbeef",` + okMapping)
	fin := u.finish()
	if err == nil || res == nil || res.Status != api.RecoveryFailed || fin == nil || fin.Status != api.RecoveryFailed {
		t.Fatalf("result %+v %v, finish %+v\n%s", res, err, fin, u.out.String())
	}
	u.nothingWritten("a snapshot the answers named and the instance does not offer")
	if !strings.Contains(u.out.String(), T(LangEN, "snapshot.no_match", "id", "deadbeefdeadbeef", "count", 0)) {
		t.Errorf("console:\n%s", u.out.String())
	}
	if strings.Contains(u.out.String(), T(LangEN, "manifest.reading", "id", shortID(u.f.snapshotID))) {
		t.Error("the manifest of the snapshot of the code was read")
	}
	assertKnownCodes(t, fin.Warnings)
}

// TestRecoverSharedIdentityIsRefused: two disks report one serial. The
// answers that name it are refused; the answers that name the disk by
// its own identity erase that disk and no other.
func TestRecoverSharedIdentityIsRefused(t *testing.T) {
	twins := func(u *unattendedRun) {
		b := u.env.hw.Blocks[0]
		b.Serial, b.ByPath = "0123456789ABCDEF", "pci-0000:02:00.0-nvme-1"
		data := b
		data.KName, data.ByPath = "nvme1n1", "pci-0000:03:00.0-nvme-1"
		data.Signatures = []baremetal.TargetSignature{{Kind: "fs", UUID: "11111111-2222-4333-8444-555555555555"}}
		u.env.hw.Blocks = []BlockInfo{b, data}
	}
	u := newUnattended(t)
	twins(u)
	res, err := u.run(`"diskMapping":{"d0":"serial.0123456789ABCDEF"},"confirmErase":["serial.0123456789ABCDEF"]`)
	fin := u.finish()
	if err == nil || res == nil || res.Status != api.RecoveryFailed || fin == nil || !strings.Contains(fmt.Sprint(fin.Warnings), baremetal.ProblemMappingInvalid) {
		t.Fatalf("result %+v %v, finish %+v\n%s", res, err, fin, u.out.String())
	}
	u.nothingWritten("a mapping by an identity two disks report")
	if !strings.Contains(u.out.String(), "/dev/nvme0n1 is path.pci-0000:02:00.0-nvme-1") || !strings.Contains(u.out.String(), "/dev/nvme1n1 is path.pci-0000:03:00.0-nvme-1") {
		t.Errorf("the refusal does not name the disks:\n%s", u.out.String())
	}
	assertKnownCodes(t, fin.Warnings)
	// By its own identity: the first disk, and only it.
	u = newUnattended(t)
	twins(u)
	res, err = u.run(`"diskMapping":{"d0":"path.pci-0000:02:00.0-nvme-1"},"confirmErase":["path.pci-0000:02:00.0-nvme-1"]`)
	if err != nil || res == nil || res.Status != api.RecoverySucceeded {
		t.Fatalf("by path: %+v %v\n%s", res, err, u.out.String())
	}
	lines := u.exe.lines()
	if !strings.Contains(lines, "wipefs -a /dev/nvme0n1\n") || strings.Contains(lines, "/dev/nvme1n1") {
		t.Errorf("the wrong disk, or both:\n%s", lines[:min(len(lines), 600)])
	}
}

// startedSignatures are the identities the scan finds on the disk a first
// run partitioned and formatted (blkid on the disk and its partitions).
func startedSignatures(m *baremetal.Manifest, all bool) []baremetal.TargetSignature {
	d := m.Linux.Disks[0]
	sigs := []baremetal.TargetSignature{{Kind: "disk_guid", UUID: d.Table.ID}}
	for _, p := range d.Table.Partitions {
		n := p.Number
		sigs = append(sigs, baremetal.TargetSignature{Kind: "part_uuid", UUID: deref(p.UUID), PartNumber: &n})
	}
	if all {
		for _, c := range m.Linux.LUKS {
			sigs = append(sigs, baremetal.TargetSignature{Kind: "luks", UUID: c.UUID, Type: strPtrT("crypto_LUKS")})
		}
	}
	return sigs
}

// TestRecoverAfterInterruptionBeforeTheMarker: a first run died after
// sfdisk and before the root was mounted. The disk carries the table of
// the backup and no marker. Declining the offer to continue leads to the
// question what becomes of the disk; chosen as the target it is erased
// after the usual confirmation. Unattended, the automatic mapping never
// erases it and says how to.
func TestRecoverAfterInterruptionBeforeTheMarker(t *testing.T) {
	a := newAttended(t)
	m, _ := baremetal.Decode(a.raw)
	a.env.hw.Blocks[0].Signatures = startedSignatures(m, false)
	// After the code: no to the offer, the first target disk for d0, no
	// command list, the passphrase twice, the tail of the identity (the
	// disk carries data), the erase word.
	script := append(a.upToCode(spkiOf(t, a.f)), "n", "1")
	script = append(script, passLines...)
	script = append(script, "get0", "ERASE")
	a.run(script, "", "2")
	if a.err != nil || a.res == nil || a.res.Status != api.RecoverySucceeded {
		t.Fatalf("run: %v %+v\n%s\n%s", a.err, a.res, a.out.String(), a.exe.lines())
	}
	out := a.out.String()
	for _, want := range []string{T(LangEN, "resume.offer", "id", shortID(a.f.snapshotID)), T(LangEN, "map.partial"), T(LangEN, "map.choose", "disk", "d0"),
		T(LangEN, "ui.confirm_erase", "word", "ERASE")} {
		if !strings.Contains(out, want) {
			t.Errorf("the console lacks %q:\n%s", want, out)
		}
	}
	if i, j := strings.Index(out, T(LangEN, "resume.offer", "id", shortID(a.f.snapshotID))), strings.Index(out, T(LangEN, "map.choose", "disk", "d0")); i < 0 || j < i {
		t.Error("the mapping was asked before the offer to continue")
	}
	lines := a.exe.lines()
	if !strings.HasPrefix(lines, "probe-write /dev/nvme0n1\nop release /dev/nvme0n1\n") || !strings.Contains(lines, "wipefs -a /dev/nvme0n1\n") || !strings.Contains(lines, "luksFormat") {
		t.Errorf("the disk was not erased and written again:\n%s", lines[:min(len(lines), 400)])
	}
	// The text after a resume without a marker says what really follows.
	for _, lang := range []string{LangEN, LangDE} {
		if s := T(lang, "resume.no_marker"); strings.Contains(s, "the plan then erases") || strings.Contains(s, "der Plan löscht") {
			t.Errorf("resume.no_marker (%s) still promises an erase by itself: %s", lang, s)
		}
	}
	if strings.Contains(ErrNoStartedRecovery.Error(), "the plan then erases") {
		t.Error("ErrNoStartedRecovery still promises an erase by itself")
	}

	// Unattended with the automatic mapping: not erased, and the console
	// names the way.
	u := newUnattended(t)
	u.env.hw.Blocks[0].Signatures = startedSignatures(u.m, false)
	res, _ := u.run(`"diskMapping":"auto","confirmErase":["serial.restow-e2e-target0"]`)
	if res == nil || res.Status != api.RecoveryFailed || !strings.Contains(u.out.String(), T(LangEN, "plan.partial")) {
		t.Errorf("unattended, automatic: %+v\n%s", res, u.out.String())
	}
	u.nothingWritten("the automatic mapping on a disk with identities of the backup")
}

// TestRecoverResumeOnTheChosenDisk: the first run had two free disks and
// the operator chose the second. It was interrupted during the restore.
// The second start continues on the disk that carries the identities of
// the backup: no question about the mapping, nothing erased, the volume
// of the first run opened on that disk.
func TestRecoverResumeOnTheChosenDisk(t *testing.T) {
	a := newAttended(t)
	m, _ := baremetal.Decode(a.raw)
	free := a.env.hw.Blocks[0]
	chosen := free
	chosen.KName, chosen.Serial = "nvme1n1", "restow-e2e-target1"
	chosen.Signatures = startedSignatures(m, true)
	a.env.hw.Blocks = []BlockInfo{free, chosen}
	root, err := OpenRootfs(a.env.target)
	if err != nil {
		t.Fatal(err)
	}
	first := Marker{SnapshotID: a.f.snapshotID, LayoutSHA256: a.f.layoutSHA, PlanSHA256: strings.Repeat("9b", 32), LastStep: 23, Phase: "restore",
		Disks: []MarkerDisk{{Source: "d0", Action: baremetal.ActionErase}}}
	if err := WriteMarker(chownless{root}, first); err != nil {
		t.Fatal(err)
	}
	// After the code: yes to the offer, no command list, the passphrase of
	// the first run.
	script := append(a.upToCode(spkiOf(t, a.f)), "")
	script = append(script, passLines...)
	a.run(script, "", "3")
	if a.err != nil || a.res == nil || a.res.Status != api.RecoverySucceeded {
		t.Fatalf("run: %v %+v\n%s\n%s", a.err, a.res, a.out.String(), a.exe.lines())
	}
	out, lines := a.out.String(), a.exe.lines()
	if strings.Contains(out, T(LangEN, "map.choose", "disk", "d0")) || strings.Contains(out, T(LangEN, "ui.confirm_erase", "word", "ERASE")) {
		t.Errorf("the resume asked for a mapping or an erase:\n%s", out)
	}
	if !strings.Contains(lines, "cryptsetup open --key-file - /dev/nvme1n1p3 nvme0n1p3_crypt") || strings.Contains(lines, "/dev/nvme0n1p") {
		t.Errorf("the resume did not open the disk the first run wrote:\n%s", lines)
	}
	for _, never := range []string{"wipefs", "sfdisk", "luksFormat", "pvcreate", "mkfs.", "probe-write"} {
		if strings.Contains(lines, never) {
			t.Errorf("%s in a resumed run", never)
		}
	}
	// After the unclean end the restore compares the content (the plan
	// the executor ended with is the one built from the marker).
	if args := restoreArgs(t, a.env.executor.Plan); !strings.Contains(args, "--overwrite always") {
		t.Errorf("an unclean end resumed with: %s", args)
	}
	if m := a.env.executor.Plan.Mapping; len(m) != 1 || deref(m[0].Target) != "t1" {
		t.Errorf("mapping %+v", m)
	}
}

// adoptedMachine is raid5-spare after a first run: a new system disk that
// recover wrote, and the three data disks that were adopted (they carry
// the same kind of identities).
func adoptedMachine(t *testing.T, started bool) (*baremetal.Manifest, *baremetal.Target, *baremetal.Facts) {
	t.Helper()
	m := loadManifestFile(t, "raid5-spare")
	fb, err := os.ReadFile("../baremetal/testdata/facts/raid5-spare.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := baremetal.ParseFacts(fb)
	if err != nil {
		t.Fatal(err)
	}
	tg, _, err := baremetal.SyntheticTarget(m, baremetal.TargetSame, f)
	if err != nil {
		t.Fatal(err)
	}
	tg.Kind = "hardware"
	l := m.Linux
	tg.Disks[0].Serial, tg.Disks[0].EUI64, tg.Disks[0].WWN, tg.Disks[0].NGUID = strPtrT("NEWSYS"), nil, nil, nil
	tg.Disks[0].Identity = strPtrT("serial.NEWSYS")
	for i := range tg.Disks {
		d := l.Disks[i]
		if i == 0 && !started {
			continue
		}
		sigs := []baremetal.TargetSignature{{Kind: "disk_guid", UUID: d.Table.ID}}
		for _, p := range d.Table.Partitions {
			n := p.Number
			sigs = append(sigs, baremetal.TargetSignature{Kind: "part_uuid", UUID: deref(p.UUID), PartNumber: &n})
		}
		if i > 0 {
			sigs = append(sigs, baremetal.TargetSignature{Kind: "md", UUID: l.MD[0].UUID})
		}
		if i == 1 {
			sigs = append(sigs, baremetal.TargetSignature{Kind: "pv", UUID: l.LVM.PVs[0].UUID},
				baremetal.TargetSignature{Kind: "fs", UUID: deref(l.Filesystems[2].UUID), Type: strPtrT("xfs")})
		}
		tg.Disks[i].Signatures = sigs
	}
	return m, tg, f
}

func restoreArgs(t *testing.T, p *baremetal.RestorePlan) string {
	t.Helper()
	for _, s := range p.Steps {
		if s.Kind == "restore" {
			return strings.Join(s.Args, " ")
		}
	}
	t.Fatal("the plan has no restore step")
	return ""
}

// TestResumedPlanKeepsTheAdoption: the data array was adopted in the first
// run, so its mount points were left out of the restore. On the disks it
// looks like the system disk recover wrote. The resumed run reads from
// the marker what was adopted and leaves the same mount points out;
// without that the restore would overwrite files nobody confirmed.
func TestResumedPlanKeepsTheAdoption(t *testing.T) {
	m, fresh, f := adoptedMachine(t, false)
	first, _ := baremetal.Plan(m, fresh, f, baremetal.Choices{})
	if !first.OK || len(first.Adopted) == 0 || !strings.Contains(restoreArgs(t, first), "--exclude /srv/share") {
		t.Fatalf("fixture: the first run adopts the data array: %v %s", first.Problems, restoreArgs(t, first))
	}
	_, started, _ := adoptedMachine(t, true)
	resume, _ := baremetal.PlanWith(m, started, f, baremetal.Choices{Shrink: "auto"}, baremetal.PlanOptions{Snapshot: "snap", Resume: baremetal.ResumeClean})
	if !resume.OK {
		t.Fatalf("the plan of the resume: %v", resume.Problems)
	}
	if strings.Contains(restoreArgs(t, resume), "--exclude") {
		t.Fatal("fixture: before the marker is read nothing says what was adopted")
	}
	for _, clean := range []bool{true, false} {
		mk := &Marker{CleanStop: clean, Disks: MarkerDisksOf(first)}
		next, err := resumedPlan(m, started, f, baremetal.Choices{Shrink: "auto"}, resume, mk, "snap")
		if err != nil || next == nil {
			t.Fatalf("clean %v: %v", clean, err)
		}
		args := restoreArgs(t, next)
		want := "--overwrite if-changed"
		if !clean {
			want = "--overwrite always"
		}
		if !strings.Contains(args, "--exclude /srv/share") || !strings.Contains(args, want) {
			t.Errorf("clean %v: the resumed restore: %s", clean, args)
		}
		if len(next.Adopted) != len(first.Adopted) {
			t.Errorf("clean %v: adopted %+v, first run %+v", clean, next.Adopted, first.Adopted)
		}
	}
	// A marker of a run that recorded no mapping: as before (the plan of
	// the resume after a clean stop, the unclean plan otherwise).
	if next, err := resumedPlan(m, started, f, baremetal.Choices{}, resume, &Marker{CleanStop: true}, "snap"); err != nil || next != nil {
		t.Errorf("clean, no mapping: %v %v", next, err)
	}
	if next, err := resumedPlan(m, started, f, baremetal.Choices{}, resume, &Marker{}, "snap"); err != nil || next == nil || !strings.Contains(restoreArgs(t, next), "--overwrite always") {
		t.Errorf("unclean, no mapping: %v", err)
	}
	// The marker names a disk recover wrote that no disk carries now.
	gone := &Marker{CleanStop: true, Disks: append(MarkerDisksOf(first), MarkerDisk{Source: "d9", Action: baremetal.ActionErase})}
	if _, err := resumedPlan(m, started, f, baremetal.Choices{}, resume, gone, "snap"); err == nil || !strings.Contains(err.Error(), "d9") {
		t.Errorf("a written disk that is gone: %v", err)
	}
	// The marker says the system disk was missing, but a disk carries its
	// identities now (the old disk came back): the plan cannot go on.
	back := &Marker{CleanStop: true}
	for _, d := range MarkerDisksOf(first) {
		if d.Source == "d0" {
			d.Action = baremetal.ActionMissing
		}
		back.Disks = append(back.Disks, d)
	}
	if _, err := resumedPlan(m, started, f, baremetal.Choices{}, resume, back, "snap"); err == nil {
		t.Error("a disk that was missing in the first run and is there now was accepted")
	}
}
