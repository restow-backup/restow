package recovery

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// Identity conflicts (docs/BAREMETAL.md 10.7): a device that is neither a
// target nor adopted carries an identity of the backup (the old system
// disk is still connected next to the new one). The plan cannot run then.
// The operator disconnects the disk, or recover empties it with wipefs -a
// on an explicit choice: at the console after the last four characters of
// its identity were typed, unattended when answers.confirmErase names it
// (10.20). The disk is wiped before the confirmation of the plan, the
// hardware is read again and the plan made anew; the confirmation then
// names the disks to erase, and confirmErase the wiped ones too.

// Why recover does not wipe a device of an identity conflict.
const (
	// wipeNotDisk: not a possible target of this machine (read-only,
	// zoned, empty; the ISO medium and the answers medium are none).
	wipeNotDisk = "not_disk"
	// wipeMapped: the plan erases or adopts it.
	wipeMapped = "mapped"
	// wipeAdopted: it holds a part the plan adopts.
	wipeAdopted = "adopted"
	// wipeNoIdentity: no identity names it alone.
	wipeNoIdentity = "no_identity"
	// wipeShared: more than one device reports its identity.
	wipeShared = "shared"
	// wipeSAN: a SAN LUN may be another server's disk (10.6).
	wipeSAN = "san"
)

// conflictDisk is a device of an identity conflict of the plan and, when
// recover must not wipe it, why.
type conflictDisk struct {
	Disk    baremetal.TargetDisk
	Refusal string
}

// conflictDisks are the devices the plan reports as identity conflicts, in
// the order of the findings, each once.
func conflictDisks(p *baremetal.RestorePlan, t *baremetal.Target, shared map[string][]string) []conflictDisk {
	disks := map[string]baremetal.TargetDisk{}
	for _, d := range t.Disks {
		disks[d.ID] = d
	}
	others := map[string]baremetal.TargetDisk{}
	for _, d := range t.Others {
		others[d.ID] = d
	}
	mapped := map[string]bool{}
	for _, a := range p.Mapping {
		if a.Target != nil && a.Action != baremetal.ActionMissing {
			mapped[*a.Target] = true
		}
	}
	adopted := map[string]bool{}
	for _, a := range p.Adopted {
		for _, id := range a.Targets {
			adopted[id] = true
		}
	}
	count := map[string]int{}
	for _, list := range [][]baremetal.TargetDisk{t.Disks, t.Others} {
		for _, d := range list {
			if id := deref(d.Identity); id != "" {
				count[id]++
			}
		}
	}
	var out []conflictDisk
	seen := map[string]bool{}
	for _, f := range p.Problems {
		if f.Code != baremetal.ProblemIdentityConflict || f.Ref == nil || seen[*f.Ref] {
			continue
		}
		ref := *f.Ref
		seen[ref] = true
		d, isDisk := disks[ref]
		c := conflictDisk{Disk: d}
		id := deref(d.Identity)
		switch {
		case !isDisk:
			c.Disk = others[ref]
			if c.Disk.ID == "" {
				c.Disk = baremetal.TargetDisk{ID: ref, Path: paramString(f.Params["device"])}
			}
			c.Refusal = wipeNotDisk
		case mapped[ref]:
			c.Refusal = wipeMapped
		case adopted[ref]:
			c.Refusal = wipeAdopted
		case id == "":
			c.Refusal = wipeNoIdentity
		case count[id] != 1 || len(shared[id]) > 0:
			c.Refusal = wipeShared
		case isSAN(d):
			c.Refusal = wipeSAN
		}
		out = append(out, c)
	}
	return out
}

func isSAN(d baremetal.TargetDisk) bool {
	switch strings.ToLower(deref(d.Transport)) {
	case "fc", "iscsi":
		return true
	}
	return false
}

// onlyConflicts: the plan has problems, and every one is an identity
// conflict. Only then does a wipe make the plan runnable; recover wipes
// nothing for a plan that cannot run anyway.
func onlyConflicts(p *baremetal.RestorePlan) bool {
	if len(p.Problems) == 0 {
		return false
	}
	for _, f := range p.Problems {
		if f.Code != baremetal.ProblemIdentityConflict {
			return false
		}
	}
	return true
}

// confirmEraseMatches: the identities of confirmErase are exactly want,
// each once (a duplicate entry is no confirmation, 10.20).
func confirmEraseMatches(confirmErase, want []string) bool {
	have := map[string]bool{}
	for _, id := range confirmErase {
		have[id] = true
	}
	need := map[string]bool{}
	for _, id := range want {
		need[id] = true
	}
	if len(have) != len(confirmErase) || len(need) != len(want) || len(have) != len(need) {
		return false
	}
	for id := range need {
		if !have[id] {
			return false
		}
	}
	return true
}

// answersWipe decides the unattended wipe: the devices of the plan's
// identity conflicts that confirmErase names. Nothing is wiped (nil, nil)
// when confirmErase names none of them: the plan fails with the
// conflict, as without this. An error says why nothing is wiped although
// confirmErase names a conflict: the plan has other problems, a conflict
// is not named, a named device must not be wiped, or confirmErase is not
// exactly the disks the plan erases plus the ones to wipe (the
// confirmation that follows the wipe would refuse it).
func answersWipe(p *baremetal.RestorePlan, t *baremetal.Target, shared map[string][]string, confirmErase []string) ([]baremetal.TargetDisk, error) {
	conflicts := conflictDisks(p, t, shared)
	named := map[string]bool{}
	for _, id := range confirmErase {
		named[id] = true
	}
	isNamed := false
	for _, c := range conflicts {
		if id := deref(c.Disk.Identity); id != "" && named[id] {
			isNamed = true
		}
	}
	if !isNamed {
		return nil, nil
	}
	if !onlyConflicts(p) {
		var codes []string
		for _, f := range p.Problems {
			if f.Code != baremetal.ProblemIdentityConflict {
				codes = append(codes, f.Code)
			}
		}
		return nil, fmt.Errorf("answers: confirmErase names a disk of an identity conflict, but the plan has other problems (%s); nothing was wiped", strings.Join(codes, ", "))
	}
	var out []baremetal.TargetDisk
	want := []string{}
	for _, d := range erasedDisks(p, t) {
		want = append(want, deref(d.Identity))
	}
	for _, c := range conflicts {
		id := deref(c.Disk.Identity)
		switch {
		case c.Refusal != "":
			return nil, fmt.Errorf("answers: %s (%s) carries identities of the backup and cannot be wiped by recover (%s); disconnect it. Nothing was wiped", c.Disk.Path, nameIdentity(id), c.Refusal)
		case !named[id]:
			return nil, fmt.Errorf("answers: %s (%s) carries identities of the backup and confirmErase does not name it; nothing was wiped", c.Disk.Path, nameIdentity(id))
		}
		out = append(out, c.Disk)
		want = append(want, id)
	}
	for _, id := range confirmErase {
		if err := sharedIdentityError("confirmErase", id, shared, t); err != nil {
			return nil, err
		}
	}
	if !confirmEraseMatches(confirmErase, want) {
		sort.Strings(want)
		return nil, fmt.Errorf("answers: confirmErase must name exactly the disks to erase and to wipe (%s); nothing was wiped", strings.Join(want, ", "))
	}
	return out, nil
}

// withoutSignatures is t with the signatures of the devices at paths
// left out: what the scan after a wipe is compared with.
func withoutSignatures(t *baremetal.Target, paths map[string]bool) *baremetal.Target {
	c := *t
	strip := func(list []baremetal.TargetDisk) []baremetal.TargetDisk {
		out := make([]baremetal.TargetDisk, len(list))
		for i, d := range list {
			if paths[d.Path] {
				d.Signatures = nil
			}
			out[i] = d
		}
		return out
	}
	c.Disks, c.Others = strip(t.Disks), strip(t.Others)
	return &c
}

// askWipe asks the operator about the devices of the identity conflicts
// (the plan has no other problem): each one recover may wipe is wiped only
// after a yes (the default is no) and the last four characters of its
// identity. All or nothing: a device that cannot be wiped, or one the
// operator keeps, leaves the plan failing, so then nothing is wiped.
func (r *Recover) askWipe(conflicts []conflictDisk) []baremetal.TargetDisk {
	r.UI.Say("wipe.title")
	for _, c := range conflicts {
		if c.Refusal != "" {
			r.UI.Say("wipe.refused", "path", c.Disk.Path, "model", deref(c.Disk.Model), "identity", nameIdentity(deref(c.Disk.Identity)),
				"reason", r.UI.Text("wipe.why."+c.Refusal))
			return nil
		}
	}
	var out []baremetal.TargetDisk
	for _, c := range conflicts {
		d := c.Disk
		size := FormatBytes(d.SizeBytes)
		r.UI.Say("wipe.disk", "path", d.Path, "model", deref(d.Model), "size", size, "identity", deref(d.Identity))
		ok, err := r.UI.YesNo(r.UI.Text("wipe.ask", "path", d.Path), false)
		if err != nil || !ok {
			r.UI.Say("wipe.kept")
			return nil
		}
		ok, err = r.UI.TypeToWipe(d.Path, deref(d.Model), size, deref(d.Identity))
		if err != nil || !ok {
			r.UI.Say("wipe.kept")
			return nil
		}
		out = append(out, d)
	}
	return out
}

// wipeConflicts resolves the identity conflicts of the plan by wiping the
// devices the operator chose (askWipe) or confirmErase names
// (answersWipe), then reads the hardware again and plans anew. It returns
// nil plan when nothing was wiped. Nothing is wiped for --plan-only, for a
// resumed run (it erases nothing, 10.6) or for a plan with other problems.
// Unattended from a medium, the devices are shown for 30 seconds first; a
// key aborts (ErrAborted).
func (r *Recover) wipeConflicts(ctx context.Context, m *baremetal.Manifest, t *baremetal.Target, f *baremetal.Facts, c baremetal.Choices,
	p *baremetal.RestorePlan, o baremetal.PlanOptions, shared map[string][]string, answersDisk string) (*baremetal.RestorePlan, *baremetal.Target, HardwareInput, error) {
	var none HardwareInput
	if r.PlanOnly || o.Resume != "" || p.OK {
		return nil, nil, none, nil
	}
	var disks []baremetal.TargetDisk
	if r.unattended() {
		var err error
		disks, err = answersWipe(p, t, shared, r.Answers.ConfirmErase)
		if err != nil {
			r.logf("%v", err)
			r.UI.Raw(err.Error())
			return nil, nil, none, nil
		}
	} else if onlyConflicts(p) {
		conflicts := conflictDisks(p, t, shared)
		if len(conflicts) == 0 {
			return nil, nil, none, nil
		}
		disks = r.askWipe(conflicts)
	}
	if len(disks) == 0 {
		return nil, nil, none, nil
	}
	if r.unattended() && r.Answers.Source == SourceMedia {
		var lines []string
		for _, d := range disks {
			lines = append(lines, r.wipeLine(d))
		}
		if !r.countdown(ctx, "wipe.countdown", lines) {
			return nil, nil, none, ErrAborted
		}
	}
	if r.wasAborted() {
		return nil, nil, none, ErrAborted
	}
	paths := map[string]bool{}
	for _, d := range disks {
		how := "the operator typed its identity"
		if r.unattended() {
			how = "named in confirmErase"
		}
		// The session's log is the record of the wipe: what, why and on
		// whose word, before it happens and after.
		r.logf("identity conflict: wiping %s (%s, %s, %s) with wipefs -a, %s", d.Path, deref(d.Model), FormatBytes(d.SizeBytes), deref(d.Identity), how)
		r.flushLog(ctx)
		if err := r.Env.WipeDisk(ctx, d); err != nil {
			r.logf("wipefs on %s failed: %v", d.Path, err)
			r.UI.Say("wipe.failed", "path", d.Path, "reason", err.Error())
			return nil, nil, none, fmt.Errorf("wipe %s: %w", d.Path, err)
		}
		r.logf("identity conflict: %s (%s) was wiped", d.Path, deref(d.Identity))
		r.UI.Say("wipe.done", "path", d.Path, "model", deref(d.Model), "identity", deref(d.Identity))
		paths[d.Path] = true
		r.wiped = append(r.wiped, d)
	}
	r.flushLog(ctx)
	// The guard compares the disks before the first step with this scan,
	// so it must hold the wiped disks as they are now; apart from their
	// content nothing may have changed.
	hw, err := r.Env.Hardware(ctx)
	if err != nil {
		return nil, nil, none, fmt.Errorf("read the disks again after the wipe: %w", err)
	}
	hw.AnswersMedium = answersDisk
	nt, _ := BuildTarget(hw)
	if diff := targetChanges(withoutSignatures(t, paths), withoutSignatures(nt, paths)); len(diff) > 0 {
		return nil, nil, none, changed(diff)
	}
	np, _ := baremetal.PlanWith(m, nt, f, c, o)
	return np, nt, hw, nil
}

// wipeLine names a device that is wiped: path, model, size, identity.
func (r *Recover) wipeLine(d baremetal.TargetDisk) string {
	return r.UI.Text("wipe.line", "path", d.Path, "model", deref(d.Model), "size", FormatBytes(d.SizeBytes), "identity", deref(d.Identity))
}

// wipedIdentities are the identities of the devices this run wiped.
func (r *Recover) wipedIdentities() []string {
	var out []string
	for _, d := range r.wiped {
		out = append(out, deref(d.Identity))
	}
	return out
}
