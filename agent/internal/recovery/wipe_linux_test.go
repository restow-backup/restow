//go:build linux

package recovery

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// oldDiskMachine is the replacement machine of debian12-uefi-luks-lvm with
// the old system disk still connected (/dev/sdb, serial OLDSYS, the disk
// GUID of d0): the plan maps d0 to the new disk and fails with the
// identity conflict alone.
func oldDiskMachine(t *testing.T) (*baremetal.Manifest, *baremetal.Facts, *testEnv, *baremetal.Target, baremetal.Choices, *baremetal.RestorePlan) {
	t.Helper()
	m := loadManifestFile(t, "debian12-uefi-luks-lvm")
	fb, err := os.ReadFile("../baremetal/testdata/facts/debian12-uefi-luks-lvm.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := baremetal.ParseFacts(fb)
	if err != nil {
		t.Fatal(err)
	}
	hw := hardwareFor(m)
	old := hw.Blocks[0]
	old.KName, old.Serial = "sdb", "OLDSYS"
	old.Signatures = []baremetal.TargetSignature{{Kind: "disk_guid", UUID: m.Linux.Disks[0].Table.ID},
		{Kind: "part_uuid", UUID: deref(m.Linux.Disks[0].Table.Partitions[0].UUID)}}
	hw.Blocks = append(hw.Blocks, old)
	exe := newFakeExec()
	env := &testEnv{t: t, hw: hw, exec: exe}
	tg, _ := BuildTarget(hw)
	c := baremetal.Choices{DiskMapping: map[string]string{"d0": "t0"}, Shrink: "auto"}
	p, _ := baremetal.PlanWith(m, tg, f, c, baremetal.PlanOptions{})
	if p.OK || !onlyConflicts(p) || tg.Disks[1].Path != "/dev/sdb" {
		t.Fatalf("the plan should fail with the conflict on /dev/sdb alone: %+v", p.Problems)
	}
	return m, f, env, tg, c, p
}

func TestWipeConflictsUnattended(t *testing.T) {
	m, f, env, tg, c, p := oldDiskMachine(t)
	r, out := consoleRecover(LangEN, "")
	r.Env = env
	r.Answers = &Answers{Source: SourceFWCfg, ConfirmErase: []string{"serial.OLDSYS", "serial.restow-e2e-target0"}}
	np, nt, _, err := r.wipeConflicts(context.Background(), m, tg, f, c, p, baremetal.PlanOptions{}, nil, "")
	if err != nil || np == nil || !np.OK {
		t.Fatalf("wipe: %v %+v\n%s", err, np, out.String())
	}
	if lines := env.exec.lines(); lines != "wipe-other /dev/sdb\n" {
		t.Errorf("commands:\n%s", lines)
	}
	if len(nt.Disks[1].Signatures) != 0 || env.scans != 1 {
		t.Errorf("the disks were not read again after the wipe: %d scans, %+v", env.scans, nt.Disks[1])
	}
	logged := strings.Join(r.Log.All(), "\n")
	if !strings.Contains(logged, "wiping /dev/sdb") || !strings.Contains(logged, "named in confirmErase") || !strings.Contains(logged, "/dev/sdb (serial.OLDSYS) was wiped") {
		t.Errorf("the wipe is not in the session's log:\n%s", logged)
	}
	if ok, _ := r.confirm(context.Background(), np, nt, SharedIdentities(env.hw)); !ok {
		t.Errorf("confirmErase with the wiped disk was refused:\n%s", out.String())
	}
	// A session that has ended takes no progress: the plan is only shown.
	r.session = &Session{}
	r.session.closed.Store(true)
	r.showPlan(context.Background(), np, nt)
	if !strings.Contains(out.String(), "/dev/sdb") || !strings.Contains(out.String(), "emptied with wipefs -a (identity conflict)") {
		t.Errorf("the plan does not show the wipe:\n%s", out.String())
	}

	// Not named, named without the target, --plan-only, a resumed run:
	// nothing is wiped and the plan stays failing.
	for name, set := range map[string]func(r *Recover, o *baremetal.PlanOptions){
		"not named": func(r *Recover, o *baremetal.PlanOptions) {
			r.Answers.ConfirmErase = []string{"serial.restow-e2e-target0"}
		},
		"target missing": func(r *Recover, o *baremetal.PlanOptions) { r.Answers.ConfirmErase = []string{"serial.OLDSYS"} },
		"plan only":      func(r *Recover, o *baremetal.PlanOptions) { r.PlanOnly = true },
		"resume":         func(r *Recover, o *baremetal.PlanOptions) { o.Resume = baremetal.ResumeClean },
	} {
		m, f, env, tg, c, p := oldDiskMachine(t)
		r, _ := consoleRecover(LangEN, "")
		r.Env = env
		r.Answers = &Answers{Source: SourceFWCfg, ConfirmErase: []string{"serial.OLDSYS", "serial.restow-e2e-target0"}}
		o := baremetal.PlanOptions{}
		set(r, &o)
		np, _, _, err := r.wipeConflicts(context.Background(), m, tg, f, c, p, o, nil, "")
		if err != nil || np != nil || strings.Contains(env.exec.lines(), "wipe") || len(r.wiped) != 0 {
			t.Errorf("%s: %+v %v\n%s", name, np, err, env.exec.lines())
		}
	}
}

func TestWipeConflictsAttended(t *testing.T) {
	m, f, env, tg, c, p := oldDiskMachine(t)
	r, out := consoleRecover(LangDE, "j\nDSYS\n")
	r.Env = env
	np, _, _, err := r.wipeConflicts(context.Background(), m, tg, f, c, p, baremetal.PlanOptions{}, nil, "")
	if err != nil || np == nil || !np.OK || env.exec.lines() != "wipe-other /dev/sdb\n" {
		t.Fatalf("wipe: %v %+v\n%s\n%s", err, np, env.exec.lines(), out.String())
	}
	for _, s := range []string{"Identitätskonflikt", "Soll recover /dev/sdb jetzt mit wipefs -a leeren?", "wird jetzt GELEERT", "wurde mit wipefs -a geleert"} {
		if !strings.Contains(out.String(), s) {
			t.Errorf("the console lacks %q:\n%s", s, out.String())
		}
	}
	// No: nothing is wiped.
	m, f, env, tg, c, p = oldDiskMachine(t)
	r, _ = consoleRecover(LangEN, "\n")
	r.Env = env
	if np, _, _, err := r.wipeConflicts(context.Background(), m, tg, f, c, p, baremetal.PlanOptions{}, nil, ""); np != nil || err != nil || env.exec.lines() != "\n" {
		t.Errorf("declined: %+v %v %q", np, err, env.exec.lines())
	}
}

// TestWipeConflictsFailures: a failing wipefs, or other disks after the
// wipe than before, stop the run before the plan is confirmed.
func TestWipeConflictsFailures(t *testing.T) {
	m, f, env, tg, c, p := oldDiskMachine(t)
	env.wipeErr = errors.New("Device or resource busy")
	r, _ := consoleRecover(LangEN, "y\nDSYS\n")
	r.Env = env
	if np, _, _, err := r.wipeConflicts(context.Background(), m, tg, f, c, p, baremetal.PlanOptions{}, nil, ""); np != nil || err == nil {
		t.Errorf("wipefs failed: %+v %v", np, err)
	}
	m, f, env, tg, c, p = oldDiskMachine(t)
	env.rescan = func(n int) (HardwareInput, bool) {
		hw := env.hw
		hw.Blocks = append(append([]BlockInfo(nil), hw.Blocks...), BlockInfo{KName: "sdc", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "NEW"})
		return hw, true
	}
	r, _ = consoleRecover(LangEN, "y\nDSYS\n")
	r.Env = env
	if np, _, _, err := r.wipeConflicts(context.Background(), m, tg, f, c, p, baremetal.PlanOptions{}, nil, ""); np != nil || !errors.Is(err, ErrDisksChanged) {
		t.Errorf("a disk came: %+v %v", np, err)
	}
}
