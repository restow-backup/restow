package recovery

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// Identity conflicts (10.7, E9 of 21.2): the system disk of the backup is
// still connected next to the new one, the data RAID is adopted. recover
// empties the old disk only when the operator or confirmErase names it,
// and never a disk the plan uses.

const (
	e9New = "serial.NEWSYS-1"
	e9Old = "serial.OLDSYS"
)

// e9Plan is raid5-spare on a new system disk (t0) with the data disks
// adopted (t1 to t4) and the old system disk (t5, /dev/vda) still there,
// carrying the disk GUID of d0; change edits the old disk.
func e9Plan(t *testing.T, change func(m *baremetal.Manifest, tg *baremetal.Target)) (*baremetal.Manifest, *baremetal.Target, *baremetal.Facts, baremetal.Choices, *baremetal.RestorePlan) {
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
	tb, err := os.ReadFile("../baremetal/testdata/targets/raid5-spare.adopt-data.json")
	if err != nil {
		t.Fatal(err)
	}
	tg, err := baremetal.ParseTarget(tb)
	if err != nil {
		t.Fatal(err)
	}
	old := tg.Disks[0]
	id, serial := e9Old, "OLDSYS"
	old.ID, old.Path, old.Identity, old.Serial, old.NSID = "t5", "/dev/vda", &id, &serial, nil
	old.Signatures = []baremetal.TargetSignature{{Kind: "disk_guid", UUID: m.Linux.Disks[0].Table.ID}}
	tg.Disks = append(tg.Disks, old)
	if change != nil {
		change(m, tg)
	}
	c := baremetal.Choices{DiskMapping: map[string]string{"d0": "t0"}, Adopt: []string{"md:" + m.Linux.MD[0].KName}}
	p, _ := baremetal.Plan(m, tg, f, c)
	return m, tg, f, c, p
}

func TestConflictDisksE9(t *testing.T) {
	_, tg, _, _, p := e9Plan(t, nil)
	if p.OK || !onlyConflicts(p) {
		t.Fatalf("the plan should fail with the identity conflict alone: %+v", p.Problems)
	}
	cs := conflictDisks(p, tg, nil)
	if len(cs) != 1 || cs[0].Disk.Path != "/dev/vda" || cs[0].Refusal != "" {
		t.Fatalf("conflicts %+v", cs)
	}
	got, err := answersWipe(p, tg, nil, []string{e9Old, e9New})
	if err != nil || len(got) != 1 || got[0].Path != "/dev/vda" {
		t.Fatalf("confirmErase with the old disk: %+v %v", got, err)
	}
	// Without the old disk in confirmErase nothing is wiped, and the plan
	// fails as before.
	if got, err := answersWipe(p, tg, nil, []string{e9New}); err != nil || got != nil {
		t.Errorf("confirmErase without the old disk: %+v %v", got, err)
	}
}

// TestAnswersWipeRefusals: confirmErase names the old disk, but nothing is
// wiped.
func TestAnswersWipeRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(m *baremetal.Manifest, tg *baremetal.Target)
		ce     []string
		edit   func(p *baremetal.RestorePlan)
		want   string
	}{
		{name: "the target is not confirmed", ce: []string{e9Old}, want: "exactly"},
		{name: "an identity too many", ce: []string{e9Old, e9New, "wwn.50014ee2b5c6d7ea"}, want: "exactly"},
		{name: "a duplicate entry", ce: []string{e9Old, e9New, e9Old}, want: "exactly"},
		{name: "another problem", ce: []string{e9Old, e9New}, want: "other problems",
			edit: func(p *baremetal.RestorePlan) {
				p.Problems = append(p.Problems, baremetal.Finding{Code: baremetal.ProblemTargetTooSmall, Severity: baremetal.FindingProblem})
			}},
		{name: "a SAN LUN", ce: []string{e9Old, e9New}, want: "san",
			change: func(m *baremetal.Manifest, tg *baremetal.Target) {
				iscsi := "iscsi"
				tg.Disks[5].Transport = &iscsi
			}},
		{name: "a second conflict not named", ce: []string{e9Old, e9New}, want: "does not name",
			change: func(m *baremetal.Manifest, tg *baremetal.Target) {
				second := tg.Disks[5]
				id := "serial.OLDSYS2"
				second.ID, second.Path, second.Identity = "t6", "/dev/vdz", &id
				tg.Disks = append(tg.Disks, second)
			}},
		{name: "the plan adopts the disk", ce: []string{e9Old, e9New}, want: "adopted",
			edit: func(p *baremetal.RestorePlan) {
				p.Adopted[0].Targets = append(p.Adopted[0].Targets, "t5")
			}},
		{name: "the plan maps the disk", ce: []string{e9Old, e9New}, want: "mapped",
			edit: func(p *baremetal.RestorePlan) {
				t5 := "t5"
				p.Mapping = append(p.Mapping, baremetal.DiskAssignment{Source: "d9", Target: &t5, Action: baremetal.ActionAdopt})
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, tg, _, _, p := e9Plan(t, tc.change)
			if tc.edit != nil {
				tc.edit(p)
			}
			got, err := answersWipe(p, tg, nil, tc.ce)
			if err == nil || got != nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "nothing was wiped") &&
				!strings.Contains(err.Error(), "Nothing was wiped") {
				t.Errorf("got %+v, %v; want a refusal with %q", got, err, tc.want)
			}
		})
	}
	// An identity two devices report names no disk.
	_, tg, _, _, p := e9Plan(t, nil)
	shared := map[string][]string{e9Old: {"/dev/vda", "/dev/sdx"}}
	if got, err := answersWipe(p, tg, shared, []string{e9Old, e9New}); err == nil || got != nil {
		t.Errorf("shared identity: %+v %v", got, err)
	}
}

func TestConflictDiskRefusals(t *testing.T) {
	_, tg, _, _, p := e9Plan(t, nil)
	ref := func(id string) *string { return &id }
	conflict := func(id string) baremetal.Finding {
		return baremetal.Finding{Code: baremetal.ProblemIdentityConflict, Severity: baremetal.FindingProblem, Ref: ref(id), Params: map[string]any{"device": "/dev/x"}}
	}
	// A disk of the plan (erased or adopted) and a device that is no target
	// are never wiped, whatever names them.
	tg.Others = append(tg.Others, baremetal.TargetDisk{ID: "o0", Path: "/dev/sr9", Identity: ref("serial.RO")})
	noID := tg.Disks[5]
	noID.ID, noID.Path, noID.Identity = "t6", "/dev/vdy", nil
	tg.Disks = append(tg.Disks, noID)
	p.Problems = []baremetal.Finding{conflict("t0"), conflict("t1"), conflict("o0"), conflict("t6"), conflict("t5"), conflict("t5")}
	want := map[string]string{"t0": wipeMapped, "t1": wipeMapped, "o0": wipeNotDisk, "t6": wipeNoIdentity, "t5": ""}
	cs := conflictDisks(p, tg, nil)
	if len(cs) != len(want) {
		t.Fatalf("each device once: %+v", cs)
	}
	for _, c := range cs {
		if c.Refusal != want[c.Disk.ID] {
			t.Errorf("%s: refusal %q, want %q", c.Disk.ID, c.Refusal, want[c.Disk.ID])
		}
	}
}

// TestConfirmCountsTheWipedDisks: confirmErase names the wiped old disk
// besides the target; the confirmation takes it only when this run wiped
// that disk.
func TestConfirmCountsTheWipedDisks(t *testing.T) {
	m, tg, f, c, _ := e9Plan(t, nil)
	tg.Disks[5].Signatures = nil
	p, _ := baremetal.Plan(m, tg, f, c)
	if !p.OK {
		t.Fatalf("plan after the wipe: %+v", p.Problems)
	}
	r, out := consoleRecover(LangEN, "")
	r.Answers = &Answers{Source: SourceFWCfg, ConfirmErase: []string{e9Old, e9New}}
	if ok, _ := r.confirm(context.Background(), p, tg, nil); ok {
		t.Errorf("confirmed with a disk that was not wiped:\n%s", out.String())
	}
	r.wiped = []baremetal.TargetDisk{tg.Disks[5]}
	if ok, _ := r.confirm(context.Background(), p, tg, nil); !ok {
		t.Errorf("not confirmed:\n%s", out.String())
	}
	r.Answers.ConfirmErase = []string{e9Old}
	if ok, _ := r.confirm(context.Background(), p, tg, nil); ok {
		t.Error("confirmed without the target")
	}
}

// TestAskWipe: the operator says yes and types the last four characters
// of the identity; anything else wipes nothing.
func TestAskWipe(t *testing.T) {
	_, tg, _, _, p := e9Plan(t, nil)
	cs := conflictDisks(p, tg, nil)
	for input, wiped := range map[string]bool{
		"\n":                     false,
		"n\n":                    false,
		"y\nOLD\nSYS1\nxxxx\n":   false,
		"y\nLDSYS\nxx\nOLDSYS\n": false,
		"y\ndsys\n":              true,
	} {
		r, out := consoleRecover(LangEN, input)
		got := r.askWipe(cs)
		if (len(got) == 1) != wiped || len(got) > 1 {
			t.Errorf("input %q: %+v\n%s", input, got, out.String())
		}
		if !wiped && !strings.Contains(out.String(), T(LangEN, "wipe.kept")) {
			t.Errorf("input %q: the console does not say that the disk is kept:\n%s", input, out.String())
		}
	}
	// German, with "Sie".
	r, out := consoleRecover(LangDE, "j\nDSYS\n")
	if got := r.askWipe(cs); len(got) != 1 || !strings.Contains(out.String(), "wird jetzt GELEERT") {
		t.Errorf("German: %+v\n%s", got, out.String())
	}
	// A device recover must not wipe: named, nothing asked.
	cs[0].Refusal = wipeAdopted
	r, out = consoleRecover(LangEN, "y\ndsys\n")
	if got := r.askWipe(cs); got != nil || !strings.Contains(out.String(), T(LangEN, "wipe.why.adopted")) || strings.Contains(out.String(), "WIPED") {
		t.Errorf("refused device: %+v\n%s", got, out.String())
	}
}
