package baremetal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
)

// The restore planner (docs/BAREMETAL.md 10.4 to 10.15, contract C-M2-5):
// a pure function from a manifest, a target, facts from the snapshot and
// the operator's choices to a list of steps. It starts no process and
// reads no file; recover (M4) executes the steps, stage 1 on the server
// only reads the findings and the minimum sizes. The planner files
// (plan*.go, facts.go, target.go, sizing.go, mapping.go, drivers.go,
// secureboot.go, mkfs.go, fixups.go) import no package that runs programs
// (TestPlannerImports).

// RestorePlan is the planner's output (restow-plan-v1).
type RestorePlan struct {
	Format       string           `json:"format"`
	Target       string           `json:"target"`
	OK           bool             `json:"ok"`
	Problems     []Finding        `json:"problems"`
	Warnings     []Finding        `json:"warnings"`
	Mapping      []DiskAssignment `json:"mapping"`
	Adopted      []AdoptedPart    `json:"adopted"`
	MinimumSizes MinimumSizes     `json:"minimumSizes"`
	Disks        []PlannedDisk    `json:"disks"`
	Steps        []Step           `json:"steps"`
	SecureBoot   ChainCheck       `json:"secureBoot"`
	Drivers      DriverCheck      `json:"drivers"`
}

// Step is one action of the plan. Args never hold a secret; StdinSecret
// names what recover feeds on stdin (passphrase, old_passphrase, keyfile).
// The tokens {snapshot} and {target_root} in Args are filled in by
// recover. Args starting with a name that is not a program (release-holders,
// blkzero, pmbr-boot, fixup, mkdirs, swapfile, keyfile, nvram,
// fallback-path, mok-import, selinux, verify, chroot-exec) are operations
// recover carries out itself (agent/internal/recovery, ops_linux.go); the
// token {kernelopts} is the kernel command line after the fixups.
type Step struct {
	N           int64    `json:"n"`
	Phase       string   `json:"phase"`
	Kind        string   `json:"kind"`
	Target      *string  `json:"target"`
	Args        []string `json:"args"`
	Stdin       *string  `json:"stdin"`
	StdinSecret *string  `json:"stdinSecret"`
	Reason      string   `json:"reason"`
}

// planner is the state of one Plan call.
type planner struct {
	m        *Manifest
	l        *LinuxLayout
	t        *Target
	f        *Facts
	c        Choices
	x        *layoutModel
	mp       *mapper
	plan     *RestorePlan
	snapshot string
	resume   string

	partSize   map[string]int64 // planned partition sizes (node key)
	lvSize     map[string]int64 // planned LV sizes (vg/lv)
	raidPVs    map[string][]int // RAID LV (vg/lv) -> indexes of the PVs that hold its images (x.vgPVs)
	lbs        map[string]int64 // effective logical block size per node key
	luksSector map[string]int64
	mixedVG    map[string]bool
	unplaced   map[string]bool // source disks whose layout did not fit
	findings   []Finding
}

func (pl *planner) add(fs ...Finding) { pl.findings = append(pl.findings, fs...) }

// PlanOptions are optional inputs of PlanWith.
type PlanOptions struct {
	// Snapshot replaces the token {snapshot} in the restore step.
	Snapshot string
	// Resume continues a recovery that was started before (10.18): "clean"
	// after a clean stop, "unclean" after a power loss or crash, "" for a
	// new recovery. A resumed plan erases, partitions and formats nothing;
	// it assembles, opens, activates and mounts what the first run created
	// and restores again (if-changed after a clean stop, always after an
	// unclean one, plus a second pass over the system paths).
	Resume string
}

// Values of PlanOptions.Resume.
const (
	ResumeClean   = "clean"
	ResumeUnclean = "unclean"
)

// Plan computes the restore plan of m for target t (docs: baremetal.Plan).
// f may be nil (restore sizes then come from the space in use, drivers are
// not checked). The findings are also in the plan.
func Plan(m *Manifest, t *Target, f *Facts, c Choices) (*RestorePlan, []Finding) {
	return PlanWith(m, t, f, c, PlanOptions{})
}

// PlanWith is Plan with options.
func PlanWith(m *Manifest, t *Target, f *Facts, c Choices, o PlanOptions) (*RestorePlan, []Finding) {
	plan := &RestorePlan{Format: PlanFormat, Target: t.Kind, Problems: []Finding{}, Warnings: []Finding{},
		Mapping: []DiskAssignment{}, Adopted: []AdoptedPart{}, Disks: []PlannedDisk{}, Steps: []Step{},
		MinimumSizes: MinimumSizes{Disks: []DiskMinimum{}, Filesystems: []FSMinimum{}, LVs: []LVMinimum{}, ThinPools: []LVMinimum{}},
		SecureBoot:   ChainCheck{Loaders: []LoaderCheck{}, TargetSecureBoot: t.Firmware.SecureBoot},
		Drivers:      DriverCheck{Storage: []DriverMatch{}, NICs: []DriverMatch{}}}
	pl := &planner{m: m, t: t, f: f, c: c, plan: plan, snapshot: o.Snapshot, resume: o.Resume,
		partSize: map[string]int64{}, lvSize: map[string]int64{}, raidPVs: map[string][]int{}, lbs: map[string]int64{}, luksSector: map[string]int64{}, mixedVG: map[string]bool{}, unplaced: map[string]bool{}}
	pl.run()
	pl.finish()
	return plan, append(append([]Finding{}, plan.Problems...), plan.Warnings...)
}

// AnswersLabel is the label of the medium the recovery ISO reads its
// answers from (restow.answers=media, docs/BAREMETAL.md 10.20).
const AnswersLabel = "RESTOWANS"

// IsAnswersLabel reports whether a file system, LUKS or md label would be
// taken for the answers medium (vfat labels are compared without case).
func IsAnswersLabel(label string) bool {
	label = strings.TrimSpace(label)
	if i := strings.LastIndexByte(label, ':'); i >= 0 {
		label = label[i+1:]
	}
	return strings.EqualFold(label, AnswersLabel)
}

// checkReservedLabels refuses a layout whose file systems, swap areas,
// LUKS volumes or md arrays carry the label of the answers medium: the
// restore would put a medium on the target that a later run of the ISO
// with restow.answers=media could take for the operator's (10.20).
func (pl *planner) checkReservedLabels() {
	var objs []string
	for _, fs := range pl.l.Filesystems {
		if fs.Label != nil && IsAnswersLabel(*fs.Label) {
			objs = append(objs, "file system "+fs.ID)
		}
	}
	for i, sw := range pl.l.Swap {
		if sw.Label != nil && IsAnswersLabel(*sw.Label) {
			objs = append(objs, "swap "+itoa(int64(i)))
		}
	}
	for _, c := range pl.l.LUKS {
		if c.Label != nil && IsAnswersLabel(*c.Label) {
			objs = append(objs, "LUKS volume "+c.ID)
		}
	}
	for _, md := range pl.l.MD {
		if md.Name != nil && IsAnswersLabel(*md.Name) {
			objs = append(objs, "md array "+md.ID)
		}
	}
	for _, o := range objs {
		pl.add(newFinding(ProblemLayoutUnsupported, "", "reason", o+" is labelled "+AnswersLabel+", the label reserved for the answers medium of the recovery ISO"))
	}
}

func (pl *planner) finish() {
	seen := map[string]bool{}
	for _, f := range pl.findings {
		b, _ := json.Marshal(f)
		if seen[string(b)] {
			continue
		}
		seen[string(b)] = true
		if f.Severity == FindingProblem {
			pl.plan.Problems = append(pl.plan.Problems, f)
		} else {
			pl.plan.Warnings = append(pl.plan.Warnings, f)
		}
	}
	pl.plan.OK = len(pl.plan.Problems) == 0
	for i := range pl.plan.Steps {
		pl.plan.Steps[i].N = int64(i + 1)
	}
}

func (pl *planner) run() {
	m := pl.m
	if m.Platform != PlatformLinux || m.Linux == nil {
		pl.add(newFinding(ProblemLayoutUnsupported, "", "reason", "platform "+m.Platform))
		return
	}
	pl.l = m.Linux
	rawLVs := pl.c.RawLVs
	if rawLVs == "" {
		rawLVs = "skip"
	}
	pl.x = newLayoutModel(m, pl.f, rawLVs)
	pl.x.fillMinimums(&pl.plan.MinimumSizes)
	pl.add(pl.x.findings...)
	// Distributions that are not tested and init systems other than systemd
	// may be restored (24.7); the plan carries the assessment's warning.
	for _, u := range pl.l.Unsupported {
		if u.Code == CodeUntestedDistribution || u.Code == CodeNonSystemdInit {
			pl.add(newFinding(u.Code, "", "os", osName(&pl.l.OS), "init", pl.l.OS.Init))
		}
	}
	if pl.l.Verdict == VerdictUnsupported {
		var codes []string
		for _, u := range pl.l.Unsupported {
			if u.Severity == SeverityUnsupported {
				codes = append(codes, u.Code)
			}
		}
		pl.add(newFinding(ProblemLayoutUnsupported, "", "reason", strings.Join(uniqueSorted(codes), ", "), "codes", uniqueSorted(codes)))
		return
	}
	pl.add(pl.x.raidGeometryFindings()...)
	pl.checkReservedLabels()
	pl.checkFirmwareMode()
	minimum := map[string]int64{}
	for _, d := range pl.plan.MinimumSizes.Disks {
		minimum[d.Disk] = d.MinBytes
	}
	mp := &mapper{x: pl.x, t: pl.t, c: pl.c, assign: map[string]*DiskAssignment{}, targets: map[string]*TargetDisk{},
		used: map[string]string{}, adopted: map[string]bool{}}
	for i := range pl.t.Disks {
		mp.targets[pl.t.Disks[i].ID] = &pl.t.Disks[i]
	}
	mp.ids = pl.x.identities()
	mp.mapDisks(minimum)
	mp.resolveAdoption()
	mp.checkMissing()
	mp.checkTargets()
	mp.identityConflicts()
	pl.mp = mp
	pl.add(mp.findings...)
	for _, d := range pl.l.Disks {
		if a := mp.assign[d.ID]; a != nil {
			pl.plan.Mapping = append(pl.plan.Mapping, *a)
		}
	}
	pl.plan.Adopted = append(pl.plan.Adopted, mp.units...)

	pl.checkBIOS4Kn()
	pl.place()
	pl.blockSizes()

	// Drivers of the disks that carry the system.
	dc, df := CheckDrivers(m, pl.f, pl.t, pl.bootTargets(), pl.t.Kind == TargetOtherController)
	pl.plan.Drivers = dc
	pl.add(df...)
	cc, cf := pl.x.checkChain(pl.t, pl.f, pl.c)
	pl.plan.SecureBoot = cc
	pl.add(cf...)
	pl.layoutWarnings()
	pl.steps()
}

// checkFirmwareMode compares the boot mode of the source and the target
// (10.5): a BIOS system on GPT with a BIOS boot partition and an ESP
// starts in both modes.
func (pl *planner) checkFirmwareMode() {
	src, dst := pl.l.Firmware.Mode, pl.t.Firmware.Mode
	if src == dst {
		return
	}
	both := false
	if src == "bios" {
		biosBoot, esp := false, false
		for _, d := range pl.l.Disks {
			if d.Table == nil || d.Table.Type != "gpt" {
				continue
			}
			for _, p := range d.Table.Partitions {
				t := strings.ToLower(p.Type)
				biosBoot = biosBoot || t == gptBIOSBoot
				esp = esp || t == gptESP
			}
		}
		both = biosBoot && esp
	}
	if !both {
		pl.add(newFinding(ProblemFirmwareModeMismatch, "", "source", src, "target", dst))
	}
}

// checkBIOS4Kn: BIOS does not start from a disk with 4096-byte sectors.
func (pl *planner) checkBIOS4Kn() {
	if pl.t.Firmware.Mode != "bios" {
		return
	}
	var bootTargets []string
	for _, d := range pl.l.Disks {
		a := pl.mp.assign[d.ID]
		if a == nil || a.Target == nil || a.Action == ActionMissing {
			continue
		}
		boot := d.BootCode == "grub" || hasString(pl.l.Bootloader.BIOSDisks, d.ID)
		if !boot {
			continue
		}
		td := pl.mp.targets[*a.Target]
		bootTargets = append(bootTargets, td.ID)
		if td.LogicalSectorSize >= 4096 {
			pl.add(newFinding(ProblemBIOS4Kn, td.ID, "target", td.ID))
		}
	}
	if len(bootTargets) > 0 && len(pl.t.Disks) > 1 {
		pl.add(newFinding(WarnBIOSBootDisk, bootTargets[0], "target", bootTargets[0]))
	}
}

// bootTargets are the target disks that carry /, /boot, /usr or an ESP.
func (pl *planner) bootTargets() []string {
	want := map[string]bool{}
	for _, fs := range pl.l.Filesystems {
		sys := pl.x.esps[fs.ID]
		for _, t := range pl.x.mounts[fs.ID] {
			sys = sys || t == "/" || t == "/boot" || t == "/usr"
		}
		if !sys {
			continue
		}
		for _, dv := range fs.Devices {
			for _, d := range pl.x.disksUnder(dv) {
				if a := pl.mp.assign[d]; a != nil && a.Target != nil && a.Action != ActionMissing {
					want[*a.Target] = true
				}
			}
		}
	}
	var out []string
	for _, td := range pl.t.Disks {
		if want[td.ID] {
			out = append(out, td.ID)
		}
	}
	return out
}

// place lays out every erased disk and then the LVs.
func (pl *planner) place() {
	shrinkAuto := pl.c.Shrink == "auto"
	for _, d := range pl.l.Disks {
		a := pl.mp.assign[d.ID]
		if a == nil || a.Target == nil {
			continue
		}
		td := pl.mp.targets[*a.Target]
		if a.Action == ActionAdopt {
			if d.Table != nil {
				for _, p := range d.Table.Partitions {
					pl.partSize[PartRef(d.ID, p.Number).key()] = p.SizeBytes
				}
			}
			pl.partSize[DiskRef(d.ID).key()] = d.SizeBytes
			continue
		}
		dd := d
		pd, fs := pl.x.placeDisk(&dd, *td, shrinkAuto)
		pl.add(fs...)
		failed := false
		for _, f := range fs {
			failed = failed || f.Severity == FindingProblem
		}
		if failed {
			pl.unplaced[d.ID] = true
			continue
		}
		pl.partSize[DiskRef(d.ID).key()] = td.SizeBytes
		for _, p := range pd.Partitions {
			pl.partSize[PartRef(d.ID, p.Number).key()] = p.SizeBytes
		}
		pl.plan.Disks = append(pl.plan.Disks, pd)
	}
	pl.placeLVs(shrinkAuto)
}

// present: the device exists on the target (its disks are mapped).
func (pl *planner) present(r BlockRef) bool {
	switch r.Kind {
	case RefDisk, RefPartition:
		a := pl.mp.assign[r.Disk]
		return a != nil && a.Action != ActionMissing && a.Target != nil
	case RefMD:
		md := pl.x.md[r.ID]
		if md == nil {
			return false
		}
		n := int64(0)
		for _, mem := range md.Members {
			if pl.present(mem.Device) {
				n++
			}
		}
		return n >= mdNeeded(md) && n > 0
	case RefLUKS:
		c := pl.x.luks[r.ID]
		return c != nil && pl.present(c.Device)
	case RefPlain:
		c := pl.x.plain[r.ID]
		return c != nil && pl.present(c.Device)
	case RefLV:
		pvs := pl.x.vgPVs[r.VG]
		if len(pvs) == 0 {
			return false
		}
		for _, pv := range pvs {
			if !pl.present(pv.Device) {
				return false
			}
		}
		return true
	}
	return false
}

// unchanged: the device keeps its recorded size on the target.
func (pl *planner) unchanged(r BlockRef) bool {
	x := pl.x
	switch r.Kind {
	case RefDisk, RefPartition:
		n, ok := pl.partSize[r.key()]
		return ok && n == x.sizeOf(r.key(), r)
	case RefMD:
		md := x.md[r.ID]
		if md == nil {
			return false
		}
		for _, mem := range md.Members {
			if !pl.present(mem.Device) || !pl.unchanged(mem.Device) {
				return false
			}
		}
		return true
	case RefLUKS:
		c := x.luks[r.ID]
		return c != nil && pl.unchanged(c.Device)
	case RefPlain:
		c := x.plain[r.ID]
		return c != nil && pl.unchanged(c.Device)
	case RefLV:
		n, ok := pl.lvSize[r.VG+"/"+r.LV]
		return ok && n == x.sizeOf(r.key(), r)
	}
	return false
}

// newSize is the size of a device on the target.
func (pl *planner) newSize(r BlockRef) int64 {
	x := pl.x
	if pl.unchanged(r) {
		return x.sizeOf(r.key(), r)
	}
	switch r.Kind {
	case RefDisk, RefPartition:
		return pl.partSize[r.key()]
	case RefMD:
		md := x.md[r.ID]
		var member int64 = -1
		for _, mem := range md.Members {
			if !pl.present(mem.Device) {
				continue
			}
			if s := pl.newSize(mem.Device); member < 0 || s < member {
				member = s
			}
		}
		if member < 0 {
			return 0
		}
		num, den := mdFactor(md)
		return mulDiv(max(member-mdOverhead(md), 0), num, den)
	case RefLUKS:
		c := x.luks[r.ID]
		return max(pl.newSize(c.Device)-luksHeaderBytes(c), 0)
	case RefPlain:
		return pl.newSize(x.plain[r.ID].Device)
	case RefLV:
		return pl.lvSize[r.VG+"/"+r.LV]
	}
	return 0
}

// pvCapacity is the usable size of a PV on the target: the device less
// 1 MiB of metadata, in whole extents; less the slack the source had
// beyond that estimate.
func (pl *planner) pvCapacity(pv *PV, ext int64) int64 {
	x := pl.x
	if pl.unchanged(pv.Device) {
		return pv.SizeBytes
	}
	return max(alignDown(pl.newSize(pv.Device)-pvOverhead-x.pvSlack(pv), ext), 0)
}

type lvFit struct {
	lv      *LogicalVolume
	size    int64
	min     int64
	grow    bool
	fixed   bool
	created bool
}

// placeLVs sizes the LVs of every VG that is created: unchanged PVs keep
// every LV; a grown VG lets the grow LV take the rest; a smaller one
// shrinks the grow LV first, then (shrink auto) the others with the
// largest surplus.
func (pl *planner) placeLVs(shrinkAuto bool) {
	x := pl.x
	for vi := range pl.l.LVM.VGs {
		vg := &pl.l.LVM.VGs[vi]
		pvs := x.vgPVs[vg.Name]
		adoptedVG := len(vg.LVs) > 0 && pl.mp.adopted[LVRef(vg.Name, vg.LVs[0].Name).key()]
		unplaced := false
		for _, pv := range pvs {
			for _, d := range x.disksUnder(pv.Device) {
				unplaced = unplaced || pl.unplaced[d]
			}
		}
		if unplaced {
			continue
		}
		if len(pvs) == 0 || !pl.present(LVRef(vg.Name, "x")) || adoptedVG {
			for _, lv := range vg.LVs {
				pl.lvSize[vg.Name+"/"+lv.Name] = x.sizeOf(LVRef(vg.Name, lv.Name).key(), LVRef(vg.Name, lv.Name))
			}
			continue
		}
		ext := max(vg.ExtentBytes, 1)
		unchangedVG := true
		var capacity int64
		for _, pv := range pvs {
			unchangedVG = unchangedVG && pl.unchanged(pv.Device)
			capacity += pl.pvCapacity(pv, ext)
		}
		var fits []*lvFit
		var growLV *lvFit
		var total int64
		for i := range vg.LVs {
			lv := &vg.LVs[i]
			f := &lvFit{lv: lv, created: x.lvCreated(vg, lv)}
			if !f.created || !lvPhysical(lv) {
				continue
			}
			f.min = x.lvMinimum(vg, lv)
			f.size = max(alignUp(lv.SizeBytes, lvAlign(lv, ext)), f.min)
			ref := LVRef(vg.Name, lv.Name)
			f.fixed = lv.Raw || (lv.Type != "thin-pool" && x.fixedNode(ref.key(), ref))
			if f.fixed {
				f.min = f.size
			}
			f.grow = lv.Grow != nil && *lv.Grow
			if f.grow {
				growLV = f
			}
			total += lvFootprint(lv, f.size, ext)
			fits = append(fits, f)
		}
		// fp is the space an LV of size n takes in the VG; shrinkTo the
		// size of f once the VG must give back deficit bytes (at least f.min).
		fp := func(f *lvFit, n int64) int64 { return lvFootprint(f.lv, n, ext) }
		shrinkTo := func(f *lvFit, deficit int64) int64 {
			return max(f.min, lvUsable(f.lv, fp(f, f.size)-deficit, ext))
		}
		changed := false
		for _, f := range fits {
			changed = changed || f.size != f.lv.SizeBytes
		}
		switch {
		case unchangedVG && !changed:
			// Keep every LV.
		case total <= capacity:
			if growLV != nil && capacity > vg.SizeBytes {
				growLV.size = max(growLV.size, lvUsable(growLV.lv, fp(growLV, growLV.size)+capacity-total, ext))
			}
		default:
			deficit := total - capacity
			if growLV != nil {
				old := fp(growLV, growLV.size)
				growLV.size = shrinkTo(growLV, deficit)
				deficit -= old - fp(growLV, growLV.size)
			}
			if deficit > 0 {
				var cands []*lvFit
				for _, f := range fits {
					if f != growLV && !f.fixed && f.size > f.min {
						cands = append(cands, f)
					}
				}
				surplus := func(f *lvFit) int64 { return fp(f, f.size) - fp(f, f.min) }
				sort.SliceStable(cands, func(i, j int) bool { return surplus(cands[i]) > surplus(cands[j]) })
				var proposal []any
				for _, f := range cands {
					if deficit <= 0 {
						break
					}
					old, to := fp(f, f.size), shrinkTo(f, deficit)
					proposal = append(proposal, map[string]any{"lv": f.lv.Name, "fromBytes": f.size, "toBytes": to})
					f.size = to
					deficit -= old - fp(f, to)
				}
				if deficit > 0 {
					var need int64
					for _, f := range fits {
						need += fp(f, f.min)
					}
					pl.add(newFinding(ProblemTargetTooSmall, vg.Name, "disk", "vg "+vg.Name, "target", vg.Name, "needBytes", need, "haveBytes", capacity))
				} else if !shrinkAuto && len(proposal) > 0 {
					pl.add(newFinding(ProblemShrinkNeedsConfirmation, vg.Name, "disk", "vg "+vg.Name, "target", vg.Name, "proposal", proposal))
				}
			}
		}
		pl.placeRaid(vg, pvs, fits, growLV, ext)
		for _, f := range fits {
			pl.lvSize[vg.Name+"/"+f.lv.Name] = f.size
		}
		// Thin LVs keep their virtual size (at least their minimum).
		for i := range vg.LVs {
			lv := &vg.LVs[i]
			if lv.Type == "thin" && x.lvCreated(vg, lv) {
				ref := LVRef(vg.Name, lv.Name)
				pl.lvSize[vg.Name+"/"+lv.Name] = max(x.sizeOf(ref.key(), ref), x.lvMinimum(vg, lv))
			}
		}
		// Report the LVs under the disk of the first PV.
		disks := x.disksUnder(pvs[0].Device)
		for di := range pl.plan.Disks {
			if len(disks) == 0 || pl.plan.Disks[di].Disk != disks[0] {
				continue
			}
			for i := range vg.LVs {
				lv := &vg.LVs[i]
				n, ok := pl.lvSize[vg.Name+"/"+lv.Name]
				if !ok || !x.lvCreated(vg, lv) {
					continue
				}
				src := lv.SizeBytes
				if lv.Type == "thin" && lv.VirtualBytes != nil {
					src = *lv.VirtualBytes
				}
				e := PlannedLV{VG: vg.Name, LV: lv.Name, SizeBytes: n, Grown: n > src, Shrunk: n < src}
				if e.Shrunk {
					pl.add(newFinding(WarnLVShrunk, vg.Name+"/"+lv.Name, "vg", vg.Name, "lv", lv.Name, "fromBytes", src, "toBytes", n))
				}
				pl.plan.Disks[di].LVs = append(pl.plan.Disks[di].LVs, e)
			}
		}
	}
}

// lvAlign is the granularity of an LV's size: whole extents, per data
// stripe for a RAID LV.
func lvAlign(lv *LogicalVolume, ext int64) int64 {
	if g, ok := lvmRaidOf(lv); ok {
		return ext * g.data
	}
	return ext
}

// placeRaid puts the images of the VG's RAID LVs on its PVs (lvmraid.go):
// lvcreate gets the chosen PVs, so the images of one LV land on distinct
// PVs that have room, before the linear LVs take the rest. A grown RAID LV
// gives back what keeps its images from fitting; when they still do not
// fit, the target is too small.
func (pl *planner) placeRaid(vg *VolumeGroup, pvs []*PV, fits []*lvFit, growLV *lvFit, ext int64) {
	x := pl.x
	if !x.vgHasRaid(vg) {
		return
	}
	caps := make([]int64, len(pvs))
	for i, pv := range pvs {
		caps[i] = pl.pvCapacity(pv, ext)
	}
	sizes := map[string]int64{}
	for _, f := range fits {
		sizes[f.lv.Name] = f.size
	}
	assign, load, ok := x.raidPlacement(vg, sizes, caps)
	// The images do not fit although the total does: RAID LVs that grew or
	// are shrunk anyway (the grow LV first, then the largest surplus) give
	// back what keeps them from fitting, never below their minimum. An LV
	// that keeps its recorded size is not shrunk here.
	var cands []*lvFit
	for _, f := range fits {
		if isLVMRaid(f.lv) && !f.fixed && f.size > f.min && (f == growLV || f.size < alignUp(f.lv.SizeBytes, lvAlign(f.lv, ext))) {
			cands = append(cands, f)
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if (cands[i] == growLV) != (cands[j] == growLV) {
			return cands[i] == growLV
		}
		return cands[i].size-cands[i].min > cands[j].size-cands[j].min
	})
	for _, f := range cands {
		if ok {
			break
		}
		// The largest size between the minimum and the current size that
		// fits, in steps of the LV's granularity.
		step := lvAlign(f.lv, ext)
		lo, hi := int64(0), (f.size-f.min)/step
		for lo < hi {
			mid := (lo + hi + 1) / 2
			sizes[f.lv.Name] = f.min + mid*step
			if _, _, fit := x.raidPlacement(vg, sizes, caps); fit {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		f.size = f.min + lo*step
		sizes[f.lv.Name] = f.size
		assign, load, ok = x.raidPlacement(vg, sizes, caps)
	}
	if !ok {
		var need, have int64
		for i := range load {
			have = max(have, caps[i])
		}
		for i := range vg.LVs {
			lv := &vg.LVs[i]
			if g, isRaid := lvmRaidOf(lv); isRaid && x.lvCreated(vg, lv) {
				need = max(need, raidImage(g, sizes[lv.Name], ext))
			}
		}
		pl.add(newFinding(ProblemTargetTooSmall, vg.Name, "disk", "vg "+vg.Name, "target", vg.Name, "needBytes", need, "haveBytes", have))
		return
	}
	for name, idx := range assign {
		pl.raidPVs[vg.Name+"/"+name] = idx
	}
}

// blockSizes computes the effective logical block size per device (10.9):
// the target disk's, the maximum over md members and PVs, the LUKS sector
// size.
func (pl *planner) blockSizes() {
	x := pl.x
	var lbs func(r BlockRef, depth int) int64
	lbs = func(r BlockRef, depth int) int64 {
		if v, ok := pl.lbs[r.key()]; ok || depth > 64 {
			return v
		}
		var n int64 = 512
		switch r.Kind {
		case RefDisk, RefPartition:
			if a := pl.mp.assign[r.Disk]; a != nil && a.Target != nil {
				n = pl.mp.targets[*a.Target].LogicalSectorSize
			}
		case RefMD:
			for _, mem := range x.md[r.ID].Members {
				if pl.present(mem.Device) {
					n = max(n, lbs(mem.Device, depth+1))
				}
			}
		case RefLUKS:
			c := x.luks[r.ID]
			dev := lbs(c.Device, depth+1)
			sect := c.SectorSize
			if sect < dev {
				if sect > 0 {
					pl.add(newFinding(WarnLUKSSectorSizeChanged, c.ID, "luks", c.ID, "sectorSize", dev, "sourceSectorSize", sect))
				}
				sect = dev
			}
			pl.luksSector[c.ID] = sect
			n = max(dev, sect)
		case RefPlain:
			n = lbs(x.plain[r.ID].Device, depth+1)
		case RefLV:
			sizes := map[int64]bool{}
			for _, pv := range x.vgPVs[r.VG] {
				if pl.present(pv.Device) {
					s := lbs(pv.Device, depth+1)
					sizes[s] = true
					n = max(n, s)
				}
			}
			if len(sizes) > 1 {
				pl.mixedVG[r.VG] = true
			}
		}
		pl.lbs[r.key()] = n
		return n
	}
	for _, d := range pl.l.Disks {
		lbs(DiskRef(d.ID), 0)
		if d.Table != nil {
			for _, p := range d.Table.Partitions {
				lbs(PartRef(d.ID, p.Number), 0)
			}
		}
	}
	for _, md := range pl.l.MD {
		lbs(MDRef(md.ID), 0)
	}
	for _, c := range pl.l.LUKS {
		if pl.present(c.Device) && !pl.mp.adopted[LUKSRef(c.ID).key()] {
			lbs(LUKSRef(c.ID), 0)
		}
	}
	for _, vg := range pl.l.LVM.VGs {
		for _, lv := range vg.LVs {
			lbs(LVRef(vg.Name, lv.Name), 0)
		}
	}
	// Mixed block sizes in a VG: allowed when everything on it is 4K-capable.
	names := make([]string, 0, len(pl.mixedVG))
	for n := range pl.mixedVG {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		vg := x.vgs[name]
		ok := true
		var bad string
		for _, lv := range vg.LVs {
			fs := x.fsOn[LVRef(name, lv.Name).key()]
			if fs == nil {
				continue
			}
			switch fs.Type {
			case "ext2", "ext3", "ext4", "swap":
			case "xfs":
				ok = ok && fs.XFS != nil && fs.XFS.BlockSize >= 4096
			case "btrfs":
				ok = ok && fs.Btrfs != nil && fs.Btrfs.SectorSize >= 4096
			default:
				ok = false
			}
			if !ok && bad == "" {
				bad = fs.ID
			}
		}
		if ok {
			pl.add(newFinding(WarnLVMMixedBlockSizesAllowed, name, "object", "vg "+name))
		} else {
			pl.add(newFinding(ProblemSectorSizeIncompatible, name, "object", "vg "+name, "sizes", "512, 4096", "fs", bad))
		}
	}
}

// layoutWarnings are warnings about what the restore leaves out.
func (pl *planner) layoutWarnings() {
	x := pl.x
	var raw []string
	for _, vg := range pl.l.LVM.VGs {
		for _, lv := range vg.LVs {
			if lv.Raw {
				raw = append(raw, vg.Name+"/"+lv.Name)
			}
		}
	}
	if len(raw) > 0 {
		code := WarnRawLVsSkipped
		if x.rawLVs == "create" {
			code = WarnRawLVsCreatedEmpty
		}
		pl.add(newFinding(code, "", "count", int64(len(raw)), "lvs", raw))
	}
	for _, u := range pl.l.Unsupported {
		if u.Code == "dual_boot_windows" {
			pl.add(newFinding(WarnDualBootWindowsNotRestored, ""))
		}
	}
	for _, fs := range pl.l.Filesystems {
		if !recreatable(fs.Type) && pl.present(fs.Devices[0]) && !pl.mp.adopted[fs.Devices[0].key()] {
			pl.add(newFinding(WarnFSNotRecreated, fs.ID, "fs", fs.ID, "type", fs.Type))
		}
	}
	for _, c := range pl.l.LUKS {
		if len(c.TokenTypes) > 0 && !pl.mp.adopted[LUKSRef(c.ID).key()] {
			pl.add(newFinding(WarnLUKSTokensNotRestored, c.ID, "luks", c.ID, "tokens", c.TokenTypes))
		}
	}
	for _, md := range pl.l.MD {
		if int64(len(md.Members)) < md.RaidDevices && !pl.mp.adopted[MDRef(md.ID).key()] {
			pl.add(newFinding(WarnMDDegradedFirstBoot, md.ID, "md", md.KName, "have", int64(len(md.Members)), "need", md.RaidDevices))
		}
	}
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

var (
	reSafeName    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+-]{0,126}$`)
	reSafeText    = regexp.MustCompile(`^[\x20-\x7e]*$`)
	rePartType    = regexp.MustCompile(`^(0x)?[0-9A-Fa-f]{1,2}$|^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
	reUUIDText    = regexp.MustCompile(`^[0-9A-Fa-f-]{1,64}$`)
	reTableID     = regexp.MustCompile(`^(0x[0-9A-Fa-f]{1,8}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$`)
	reGPTAttrs    = regexp.MustCompile(`^[A-Za-z0-9:, ]*$`)
	reMountPath   = regexp.MustCompile(`^/[^\x00]*$`)
	reCompressOpt = regexp.MustCompile(`^compress(-force)?(=[a-z0-9]+(:[0-9]+)?)?$`)
)

func (pl *planner) step(phase, kind, target string, args []string, stdin *string, secret string, reason string) {
	s := Step{Phase: phase, Kind: kind, Args: args, Stdin: stdin, Reason: reason}
	if target != "" {
		s.Target = strPtr(target)
	}
	if secret != "" {
		s.StdinSecret = strPtr(secret)
	}
	pl.plan.Steps = append(pl.plan.Steps, s)
}

// partPath is the device of partition n on disk dev (nvme0n1 -> nvme0n1p1).
func partPath(dev string, n int64) string {
	if dev != "" && dev[len(dev)-1] >= '0' && dev[len(dev)-1] <= '9' {
		return dev + "p" + itoa(n)
	}
	return dev + itoa(n)
}

func mdName(md *MDArray) string {
	if md.Name != nil {
		n := *md.Name
		if i := strings.LastIndexByte(n, ':'); i >= 0 {
			n = n[i+1:]
		}
		if reSafeName.MatchString(n) {
			return n
		}
	}
	if reSafeName.MatchString(md.KName) {
		return md.KName
	}
	return "restow-" + md.ID
}

func luksName(c *LUKSVolume) string {
	for _, n := range []*string{c.CrypttabName, c.MappedName} {
		if n != nil && reSafeName.MatchString(*n) {
			return *n
		}
	}
	return "restow-" + c.ID
}

// devPath is the device of a manifest node on the target.
func (pl *planner) devPath(r BlockRef) string {
	x := pl.x
	switch r.Kind {
	case RefDisk:
		if a := pl.mp.assign[r.Disk]; a != nil && a.Target != nil {
			return pl.mp.targets[*a.Target].Path
		}
	case RefPartition:
		if a := pl.mp.assign[r.Disk]; a != nil && a.Target != nil {
			return partPath(pl.mp.targets[*a.Target].Path, r.Number)
		}
	case RefMD:
		return "/dev/md/" + mdName(x.md[r.ID])
	case RefLUKS:
		return "/dev/mapper/" + luksName(x.luks[r.ID])
	case RefPlain:
		if c := x.plain[r.ID]; c != nil && reSafeName.MatchString(c.MappedName) {
			return "/dev/mapper/" + c.MappedName
		}
		return "/dev/mapper/restow-" + r.ID
	case RefLV:
		return "/dev/" + r.VG + "/" + r.LV
	}
	return ""
}

func (pl *planner) steps() {
	mp := pl.mp
	if len(pl.l.Disks) == 0 {
		return
	}
	var erased []*Disk
	for i := range pl.l.Disks {
		d := &pl.l.Disks[i]
		if a := mp.assign[d.ID]; a != nil && a.Action == ActionErase && a.Target != nil && pl.resume == "" {
			erased = append(erased, d)
		}
	}
	// prepare
	for _, d := range erased {
		dev := pl.devPath(DiskRef(d.ID))
		pl.step("prepare", "release_holders", dev, []string{"release-holders", dev}, nil, "", "stop everything that holds "+dev+" (mounts, swap, LVM, md, dm)")
		pl.step("prepare", "wipe", dev, []string{"wipefs", "-a", dev}, nil, "", "remove the signatures of the old content of "+dev+" (its partitions first)")
		pl.step("prepare", "zero_range", dev, []string{"blkzero", "--head=16777216", "--tail=16777216", dev}, nil, "", "zero the first and last 16 MiB of "+dev)
	}
	// partition
	byDisk := map[string]PlannedDisk{}
	for _, pd := range pl.plan.Disks {
		byDisk[pd.Disk] = pd
	}
	for _, d := range erased {
		pd, ok := byDisk[d.ID]
		if !ok || d.Table == nil || len(pd.Partitions) == 0 && len(d.Table.Partitions) > 0 {
			continue
		}
		pl.partitionSteps(d, pd)
	}
	// md, luks, lvm in dependency order
	pl.stackSteps()
	// mkfs
	pl.mkfsSteps()
	// mount and restore
	pl.mountSteps()
	snap := "{snapshot}"
	if pl.snapshot != "" {
		snap = pl.snapshot
	}
	overwrite, reason := "never", "restore the files of the snapshot"
	switch pl.resume {
	case ResumeClean:
		overwrite, reason = "if-changed", "restore the files of the snapshot again after a clean stop (files that are complete are only read)"
	case ResumeUnclean:
		overwrite, reason = "always", "restore the files of the snapshot again after an unclean end (restic compares the content)"
	}
	args := []string{"restic", "restore", "--json", "--no-lock", "--no-cache", "--target", "{target_root}", "--sparse", "--verify", "--overwrite", overwrite}
	var excludes []string
	for _, u := range mp.units {
		excludes = append(excludes, u.Mounts...)
	}
	for _, e := range uniqueSorted(excludes) {
		args = append(args, "--exclude", e)
	}
	args = append(args, snap)
	pl.step("restore", "restore", "", args, nil, "", reason)
	if pl.resume == ResumeUnclean {
		args := []string{"restic", "restore", "--json", "--no-lock", "--no-cache", "--target", "{target_root}", "--sparse", "--verify", "--overwrite", "always"}
		for _, p := range pl.systemPaths() {
			args = append(args, "--include", p)
		}
		args = append(args, snap)
		pl.step("restore", "restore_verify", "", args, nil, "", "check the system paths completely against the snapshot after an unclean end")
	}
	pl.postSteps()
}

// partitionSteps writes the sfdisk script of one disk; names that are not
// plain ASCII get their own --part-label step, so manifest text never
// lands in a quoted context.
func (pl *planner) partitionSteps(d *Disk, pd PlannedDisk) {
	dev := pl.devPath(DiskRef(d.ID))
	var b strings.Builder
	fmt.Fprintf(&b, "label: %s\n", d.Table.Type)
	if reTableID.MatchString(d.Table.ID) {
		fmt.Fprintf(&b, "label-id: %s\n", d.Table.ID)
	}
	fmt.Fprintf(&b, "unit: sectors\nsector-size: %d\n\n", pd.SectorSize)
	src := map[int64]*Partition{}
	for i := range d.Table.Partitions {
		src[d.Table.Partitions[i].Number] = &d.Table.Partitions[i]
	}
	type label struct {
		n    int64
		name string
	}
	var labels []label
	for _, pp := range pd.Partitions {
		p := src[pp.Number]
		fields := []string{fmt.Sprintf("start=%d", pp.StartLBA), fmt.Sprintf("size=%d", pp.SizeLBA)}
		if rePartType.MatchString(p.Type) {
			fields = append(fields, "type="+p.Type)
		}
		if p.UUID != nil && reUUIDText.MatchString(*p.UUID) && d.Table.Type == "gpt" {
			fields = append(fields, "uuid="+*p.UUID)
		}
		if p.Name != nil && *p.Name != "" {
			if reSafeText.MatchString(*p.Name) && !strings.ContainsAny(*p.Name, `"\`) {
				fields = append(fields, `name="`+*p.Name+`"`)
			} else {
				labels = append(labels, label{pp.Number, *p.Name})
			}
		}
		if p.Attrs != "" && reGPTAttrs.MatchString(p.Attrs) && d.Table.Type == "gpt" {
			fields = append(fields, `attrs="`+p.Attrs+`"`)
		}
		if p.Bootable && d.Table.Type == "dos" {
			fields = append(fields, "bootable")
		}
		fmt.Fprintf(&b, "%s : %s\n", partPath(dev, pp.Number), strings.Join(fields, ", "))
	}
	script := b.String()
	pl.step("partition", "partition", dev, []string{"sfdisk", "--no-reread", "--wipe", "always", dev}, &script, "",
		"recreate the "+strings.ToUpper(d.Table.Type)+" of "+d.ID+" with its identifiers (PARTUUIDs stay)")
	for _, l := range labels {
		pl.step("partition", "part_label", dev, []string{"sfdisk", "--part-label", dev, itoa(l.n), l.name}, nil, "", "set the name of partition "+itoa(l.n))
	}
	if d.PMBRBoot && d.Table.Type == "gpt" {
		pl.step("partition", "pmbr_boot", dev, []string{"pmbr-boot", dev}, nil, "", "set the boot flag of the protective MBR (sfdisk drops it)")
	}
}

// lvmDevices is the --devices list of every LVM call: the target and
// adopted devices that carry PVs.
func (pl *planner) lvmDevices() string {
	var devs []string
	for _, pv := range pl.l.LVM.PVs {
		if pl.present(pv.Device) {
			devs = append(devs, pl.devPath(pv.Device))
		}
	}
	return strings.Join(uniqueSorted(devs), ",")
}

func (pl *planner) lvmArgs(cmd string, vg string) []string {
	args := []string{cmd, "--devices", pl.lvmDevices()}
	if pl.mixedVG[vg] {
		args = append(args, "--config", "devices/allow_mixed_block_sizes=1")
	}
	return args
}

// stackSteps creates (or assembles) md arrays, LUKS volumes and LVM in
// the order their devices become available.
func (pl *planner) stackSteps() {
	x := pl.x
	mp := pl.mp
	ready := map[string]bool{}
	for _, d := range pl.l.Disks {
		if pl.present(DiskRef(d.ID)) {
			ready[DiskRef(d.ID).key()] = true
			if d.Table != nil {
				for _, p := range d.Table.Partitions {
					ready[PartRef(d.ID, p.Number).key()] = true
				}
			}
		}
	}
	doneMD, doneLUKS, doneVG := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for round := 0; round < 64; round++ {
		progress := false
		for i := range pl.l.MD {
			md := &pl.l.MD[i]
			if doneMD[md.ID] || !pl.present(MDRef(md.ID)) {
				continue
			}
			all := true
			for _, mem := range md.Members {
				if pl.present(mem.Device) && !ready[mem.Device.key()] {
					all = false
				}
			}
			if !all {
				continue
			}
			doneMD[md.ID], progress = true, true
			ready[MDRef(md.ID).key()] = true
			dev := pl.devPath(MDRef(md.ID))
			if mp.adopted[MDRef(md.ID).key()] || pl.resume != "" {
				args := []string{"mdadm", "--assemble", "--uuid=" + md.UUID, dev}
				for _, mem := range md.Members {
					args = append(args, pl.devPath(mem.Device))
				}
				for _, sp := range md.Spares {
					if pl.present(sp) {
						args = append(args, pl.devPath(sp))
					}
				}
				reason := "assemble the adopted array " + md.KName + "; nothing on it is erased"
				if !mp.adopted[MDRef(md.ID).key()] {
					reason = "assemble the array " + md.KName + " the first run created"
				}
				pl.step("md", "md_assemble", dev, args, nil, "", reason)
				continue
			}
			args := []string{"mdadm", "--create", dev, "--run", "--level=" + md.Level, "--raid-devices=" + itoa(md.RaidDevices),
				"--metadata=" + md.Metadata, "--uuid=" + md.UUID, "--name=" + mdName(md)}
			if md.Homehost != nil && reSafeName.MatchString(*md.Homehost) {
				args = append(args, "--homehost="+*md.Homehost)
			}
			if md.ChunkBytes != nil && *md.ChunkBytes > 0 {
				args = append(args, "--chunk="+itoa(*md.ChunkBytes/1024)+"K")
			}
			if md.Layout != nil && reSafeName.MatchString(*md.Layout) {
				args = append(args, "--layout="+*md.Layout)
			}
			if md.Bitmap == "internal" {
				args = append(args, "--bitmap=internal")
			}
			slots := make([]string, md.RaidDevices)
			for j := range slots {
				slots[j] = "missing"
			}
			next := 0
			for _, mem := range md.Members {
				if !pl.present(mem.Device) {
					continue
				}
				slot := next
				if mem.Role != nil && *mem.Role >= 0 && *mem.Role < md.RaidDevices && slots[*mem.Role] == "missing" {
					slot = int(*mem.Role)
				} else {
					for slot < len(slots) && slots[slot] != "missing" {
						slot++
					}
				}
				if slot >= len(slots) {
					continue
				}
				dv := pl.devPath(mem.Device)
				if mem.WriteMostly {
					dv = "--write-mostly=" + dv
				}
				slots[slot] = dv
				next = slot + 1
			}
			for _, s := range slots {
				if v, ok := strings.CutPrefix(s, "--write-mostly="); ok {
					args = append(args, "--write-mostly", v)
				} else {
					args = append(args, s)
				}
			}
			pl.step("md", "md_create", dev, args, nil, "", "create the md array "+md.KName+" with its UUID (no --assume-clean: it resyncs)")
		}
		for i := range pl.l.LUKS {
			c := &pl.l.LUKS[i]
			if doneLUKS[c.ID] || !ready[c.Device.key()] {
				continue
			}
			doneLUKS[c.ID], progress = true, true
			ready[LUKSRef(c.ID).key()] = true
			dev := pl.devPath(c.Device)
			name := luksName(c)
			if mp.adopted[LUKSRef(c.ID).key()] {
				pl.step("luks", "luks_open", dev, []string{"cryptsetup", "open", "--key-file", "-", dev, name}, nil, "old_passphrase", "open the adopted LUKS volume "+c.ID+" with its old passphrase")
				continue
			}
			if pl.resume != "" {
				pl.step("luks", "luks_open", dev, []string{"cryptsetup", "open", "--key-file", "-", dev, name}, nil, "passphrase", "open "+c.ID+" with the passphrase of the first run")
				continue
			}
			args := []string{"cryptsetup", "luksFormat", "--type", "luks" + itoa(c.Version), "--uuid", c.UUID, "--cipher", c.Cipher,
				"--key-size", itoa(c.KeyBits), "--sector-size", itoa(max(pl.luksSector[c.ID], 512))}
			if c.Label != nil && *c.Label != "" {
				args = append(args, "--label", *c.Label)
			}
			if c.Subsystem != nil && *c.Subsystem != "" {
				args = append(args, "--subsystem", *c.Subsystem)
			}
			pbkdf := c.PBKDF.Type
			if pbkdf == "" {
				pbkdf = "argon2id"
			}
			args = append(args, "--pbkdf", pbkdf, "--iter-time", "2000")
			if strings.HasPrefix(pbkdf, "argon2") && c.PBKDF.MemoryKiB != nil {
				memKiB := *c.PBKDF.MemoryKiB
				if pl.t.RAMBytes > 0 {
					memKiB = min(memKiB, pl.t.RAMBytes/4/1024)
				}
				args = append(args, "--pbkdf-memory", itoa(max(memKiB, 32)))
			}
			args = append(args, "--batch-mode", "--key-file", "-", dev)
			pl.step("luks", "luks_format", dev, args, nil, "passphrase", "create LUKS volume "+c.ID+" with a new master key and its UUID")
			pl.step("luks", "luks_open", dev, []string{"cryptsetup", "open", "--key-file", "-", dev, name}, nil, "passphrase", "open "+c.ID+" under its crypttab name")
			if c.Version == 2 && len(c.Flags) > 0 {
				args := []string{"cryptsetup", "refresh", "--persistent", "--key-file", "-"}
				for _, fl := range c.Flags {
					switch fl {
					case "allow-discards", "same-cpu-crypt", "submit-from-crypt-cpus", "no-read-workqueue", "no-write-workqueue":
						args = append(args, "--"+fl)
					}
				}
				args = append(args, name)
				pl.step("luks", "luks_refresh", dev, args, nil, "passphrase", "store the activation flags of "+c.ID)
			}
		}
		for vi := range pl.l.LVM.VGs {
			vg := &pl.l.LVM.VGs[vi]
			pvs := x.vgPVs[vg.Name]
			if doneVG[vg.Name] || len(pvs) == 0 || !pl.present(LVRef(vg.Name, "x")) {
				continue
			}
			all := true
			for _, pv := range pvs {
				all = all && ready[pv.Device.key()]
			}
			if !all {
				continue
			}
			doneVG[vg.Name], progress = true, true
			for _, lv := range vg.LVs {
				ready[LVRef(vg.Name, lv.Name).key()] = true
			}
			if adopted := len(vg.LVs) > 0 && mp.adopted[LVRef(vg.Name, vg.LVs[0].Name).key()]; adopted || pl.resume != "" {
				args := append(pl.lvmArgs("vgchange", vg.Name), "-ay", vg.Name)
				reason := "activate the adopted volume group " + vg.Name + "; nothing on it is erased"
				if !adopted {
					reason = "activate the volume group " + vg.Name + " the first run created"
				}
				pl.step("lvm", "vg_activate", vg.Name, args, nil, "", reason)
				continue
			}
			var devs []string
			for _, pv := range pvs {
				dev := pl.devPath(pv.Device)
				devs = append(devs, dev)
				args := append(pl.lvmArgs("pvcreate", vg.Name), "--uuid", pv.UUID, "--norestorefile", "--yes", dev)
				pl.step("lvm", "pv_create", dev, args, nil, "", "create the physical volume with its UUID")
			}
			args := append(pl.lvmArgs("vgcreate", vg.Name), "-s", itoa(max(vg.ExtentBytes, 1024)/1024)+"k")
			if vg.SystemID != nil && reSafeName.MatchString(*vg.SystemID) {
				args = append(args, "--systemid", *vg.SystemID)
			}
			args = append(append(args, vg.Name), devs...)
			pl.step("lvm", "vg_create", vg.Name, args, nil, "", "create the volume group "+vg.Name)
			// RAID LVs first (on the PVs placeRaid chose), thin pools before thin LVs.
			order := []*LogicalVolume{}
			for i := range vg.LVs {
				if isLVMRaid(&vg.LVs[i]) {
					order = append(order, &vg.LVs[i])
				}
			}
			for i := range vg.LVs {
				if vg.LVs[i].Type != "thin" && !isLVMRaid(&vg.LVs[i]) {
					order = append(order, &vg.LVs[i])
				}
			}
			for i := range vg.LVs {
				if vg.LVs[i].Type == "thin" {
					order = append(order, &vg.LVs[i])
				}
			}
			for _, lv := range order {
				if !x.lvCreated(vg, lv) {
					continue
				}
				raidPVs, placed := pl.raidPVs[vg.Name+"/"+lv.Name]
				if isLVMRaid(lv) && !placed {
					// Unknown geometry or no room (a problem of the plan): never linear.
					continue
				}
				size := pl.lvSize[vg.Name+"/"+lv.Name]
				args := append(pl.lvmArgs("lvcreate", vg.Name), "--yes", "-n", lv.Name)
				switch lv.Type {
				case "thin":
					args = append(args, "-V", itoa(size)+"b", "--thinpool", deref(lv.Pool))
				case "thin-pool":
					args = append(args, "--type", "thin-pool", "-L", itoa(size)+"b")
					if lv.ChunkBytes != nil {
						args = append(args, "--chunksize", itoa(*lv.ChunkBytes/1024)+"k")
					}
					if lv.MetadataBytes != nil {
						args = append(args, "--poolmetadatasize", itoa(*lv.MetadataBytes/1024)+"k")
					}
				case "striped":
					args = append(args, "--type", "striped", "-L", itoa(size)+"b")
					if lv.Stripes != nil {
						args = append(args, "-i", itoa(*lv.Stripes))
					}
					if lv.StripeBytes != nil {
						args = append(args, "-I", itoa(*lv.StripeBytes/1024)+"k")
					}
				default:
					if isLVMRaid(lv) {
						args = append(args, raidSizeArgs(lv)...)
					}
					args = append(args, "-L", itoa(size)+"b")
				}
				for _, tag := range lv.Tags {
					if reSafeName.MatchString(tag) {
						args = append(args, "--addtag", tag)
					}
				}
				args = append(args, vg.Name)
				for _, i := range raidPVs {
					args = append(args, pl.devPath(pvs[i].Device))
				}
				pl.step("lvm", "lv_create", vg.Name+"/"+lv.Name, args, nil, "", "create LV "+vg.Name+"/"+lv.Name)
			}
		}
		if !progress {
			break
		}
	}
}

// mkfsSteps creates the file systems, swap areas and btrfs subvolumes.
func (pl *planner) mkfsSteps() {
	x := pl.x
	mp := pl.mp
	if pl.resume != "" {
		return
	}
	for _, fs := range pl.l.Filesystems {
		if len(fs.Devices) == 0 || !recreatable(fs.Type) || mp.adopted[fs.Devices[0].key()] {
			continue
		}
		present := true
		var devs []string
		var bs, size int64
		for _, d := range fs.Devices {
			present = present && pl.present(d)
			devs = append(devs, pl.devPath(d))
			bs = max(bs, pl.lbs[d.key()])
			size += pl.newSize(d)
		}
		if !present {
			continue
		}
		var inodes int64
		if fs.Ext != nil {
			used := x.inodes[fs.ID]
			if fs.InodesUsed != nil {
				used = *fs.InodesUsed
			}
			inodes = extInodes(fs.Ext, fs.SizeBytes, size, used)
		}
		args, f := MkfsArgs(fs, devs, bs, size, inodes)
		pl.add(f...)
		if args == nil {
			continue
		}
		pl.step("mkfs", "mkfs", devs[0], args, nil, "", "create "+fs.Type+" "+fs.ID+" with its UUID and recorded features")
		if fs.Btrfs != nil {
			pl.btrfsSteps(&fs, devs)
		}
	}
	for _, s := range pl.l.Swap {
		if s.Device == nil || s.Kind == "file" || s.Device.Kind == RefPlain || !pl.present(*s.Device) || mp.adopted[s.Device.key()] {
			continue
		}
		dev := pl.devPath(*s.Device)
		args, f := MkfsArgs(Filesystem{ID: "swap", Type: "swap", UUID: s.UUID, Label: s.Label}, []string{dev}, 0, 0, 0)
		pl.add(f...)
		pl.step("mkfs", "mkswap", dev, args, nil, "", "create the swap area with its UUID")
	}
}

// btrfsTop is where recover mounts the top level of a btrfs during mkfs.
func btrfsTop(fsID string) string { return "{target_root}/.restow-btrfs-" + fsID }

func (pl *planner) btrfsSteps(fs *Filesystem, devs []string) {
	b := fs.Btrfs
	top := btrfsTop(fs.ID)
	opts := "subvolid=5"
	for _, d := range devs {
		opts += ",device=" + d
	}
	pl.step("mkfs", "mount", devs[0], []string{"mount", "-t", "btrfs", "-o", opts, devs[0], top}, nil, "", "mount the top level of "+fs.ID+" to create its subvolumes")
	// The default subvolume and its parents are always created.
	keep := map[string]bool{}
	if b.DefaultSubvolume.Path != "" {
		p := b.DefaultSubvolume.Path
		for p != "." && p != "/" && p != "" {
			keep[p] = true
			p = path.Dir(p)
		}
	}
	subs := append([]Subvolume(nil), b.Subvolumes...)
	sort.SliceStable(subs, func(i, j int) bool {
		di, dj := strings.Count(subs[i].Path, "/"), strings.Count(subs[j].Path, "/")
		if di != dj {
			return di < dj
		}
		return subs[i].Path < subs[j].Path
	})
	created := map[string]bool{}
	for _, s := range subs {
		want := keep[s.Path] || s.Kind == SubvolNormal || s.Kind == SubvolMachines || s.Kind == SubvolDocker
		if !want || strings.Contains(s.Path, "..") || s.Path == "" {
			continue
		}
		// A subvolume inside one that is not created is a plain directory.
		parentOK := true
		for p := path.Dir(s.Path); p != "." && p != "/"; p = path.Dir(p) {
			for _, o := range subs {
				if o.Path == p && !created[p] {
					parentOK = false
				}
			}
		}
		if !parentOK {
			continue
		}
		created[s.Path] = true
		pl.step("mkfs", "btrfs_subvolume", s.Path, []string{"btrfs", "subvolume", "create", top + "/" + s.Path}, nil, "", "create subvolume "+s.Path)
	}
	if b.DefaultSubvolume.ID != 5 && b.DefaultSubvolume.Path != "" && created[b.DefaultSubvolume.Path] {
		pl.step("mkfs", "btrfs_default", b.DefaultSubvolume.Path, []string{"btrfs", "subvolume", "set-default", top + "/" + b.DefaultSubvolume.Path}, nil, "", "make "+b.DefaultSubvolume.Path+" the default subvolume")
	}
	pl.step("mkfs", "umount", devs[0], []string{"umount", top}, nil, "", "unmount the top level of "+fs.ID)
}

type mountItem struct {
	target string
	fs     *Filesystem
}

// mountSteps mounts every file system at its target below {target_root},
// in the order of the path depth.
func (pl *planner) mountSteps() {
	x := pl.x
	var items []mountItem
	for i := range pl.l.Filesystems {
		fs := &pl.l.Filesystems[i]
		if len(fs.Devices) == 0 || !recreatable(fs.Type) || !pl.present(fs.Devices[0]) {
			continue
		}
		for _, t := range x.mounts[fs.ID] {
			if reMountPath.MatchString(t) && !strings.Contains(t, "/../") {
				items = append(items, mountItem{target: t, fs: fs})
			}
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		di, dj := strings.Count(strings.TrimSuffix(items[i].target, "/"), "/"), strings.Count(strings.TrimSuffix(items[j].target, "/"), "/")
		if items[i].target == "/" {
			di = 0
		}
		if items[j].target == "/" {
			dj = 0
		}
		if di != dj {
			return di < dj
		}
		return items[i].target < items[j].target
	})
	for _, it := range items {
		fs := it.fs
		var devs []string
		for _, d := range fs.Devices {
			devs = append(devs, pl.devPath(d))
		}
		args := []string{"mount", "-t", fs.Type}
		switch fs.Type {
		case "btrfs":
			opts := []string{}
			for _, mo := range pl.l.Mounts {
				if mo.Target == it.target && mo.FS != nil && *mo.FS == fs.ID {
					if mo.Subvol != nil && *mo.Subvol != "" && *mo.Subvol != "/" {
						opts = append(opts, "subvol="+strings.TrimPrefix(*mo.Subvol, "/"))
					}
					for _, o := range strings.Split(mo.Options, ",") {
						if reCompressOpt.MatchString(o) {
							opts = append(opts, o)
						}
					}
				}
			}
			for _, d := range devs {
				opts = append(opts, "device="+d)
			}
			args = append(args, "-o", strings.Join(opts, ","))
		case "vfat":
			args = append(args, "-o", "quiet")
		}
		target := "{target_root}" + strings.TrimSuffix(it.target, "/")
		if it.target == "/" {
			target = "{target_root}"
		}
		args = append(args, devs[0], target)
		reason := "mount " + fs.ID + " at " + it.target
		if pl.mp.adopted[fs.Devices[0].key()] {
			reason += " (adopted: left out of the restore)"
		}
		pl.step("mount", "mount", devs[0], args, nil, "", reason)
	}
	for _, fs := range pl.l.Filesystems {
		if fs.Btrfs == nil || pl.resume != "" || !pl.present(fs.Devices[0]) || pl.mp.adopted[fs.Devices[0].key()] {
			continue
		}
		for _, dir := range fs.Btrfs.NoCowDirs {
			if reMountPath.MatchString(dir) && !strings.Contains(dir, "..") {
				pl.step("mount", "nocow", dir, []string{"chattr", "+C", "{target_root}" + dir}, nil, "", "set nodatacow on "+dir+" before the restore")
			}
		}
	}
}

// postSteps are the steps after the restore.
func (pl *planner) postSteps() {
	x := pl.x
	l := pl.l
	dirs := []string{"mkdirs", "/proc:0555", "/sys:0555", "/dev:0755", "/run:0755", "/tmp:1777"}
	var targets []string
	for _, ts := range x.mounts {
		targets = append(targets, ts...)
	}
	for _, t := range uniqueSorted(targets) {
		if t != "/" && reMountPath.MatchString(t) {
			dirs = append(dirs, t+":0755")
		}
	}
	// btrfs quota only after the restore: active qgroups slow a large
	// restore down a lot (10.11).
	for _, fs := range l.Filesystems {
		if fs.Btrfs == nil || !fs.Btrfs.Quota || len(fs.Devices) == 0 || !pl.present(fs.Devices[0]) || pl.mp.adopted[fs.Devices[0].key()] {
			continue
		}
		mts := uniqueSorted(x.mounts[fs.ID])
		if len(mts) == 0 || !reMountPath.MatchString(mts[0]) {
			continue
		}
		mt := "{target_root}" + strings.TrimSuffix(mts[0], "/")
		if mts[0] == "/" {
			mt = "{target_root}"
		}
		pl.step("post", "btrfs_quota", fs.ID, []string{"btrfs", "quota", "enable", mt}, nil, "", "turn the quota of "+fs.ID+" on again")
		pl.step("post", "btrfs_quota", fs.ID, []string{"btrfs", "quota", "rescan", "-w", mt}, nil, "", "count the qgroups of "+fs.ID+" after the restore")
	}
	pl.step("post", "mkdirs", "", dirs, nil, "", "create mount points and API folders that the snapshot may lack")
	// MACs change only on other hardware.
	targetMACs := map[string]bool{}
	for _, n := range pl.t.NICs {
		targetMACs[strings.ToLower(deref(n.MAC))] = true
	}
	macsChange := false
	for _, n := range l.Network {
		if n.Physical && n.MAC != nil && !targetMACs[strings.ToLower(*n.MAC)] {
			macsChange = true
		}
	}
	for _, fx := range PlannedFixups(pl.m) {
		if len(fx.Rules) == 1 && fx.Rules[0] == "mac" && !macsChange {
			continue
		}
		args := append([]string{"fixup", fx.Path}, fx.Rules...)
		pl.step("post", "fixup", fx.Path, args, nil, "", "rewrite device references in "+fx.Path)
	}
	for _, c := range l.LUKS {
		if c.KeyFile == nil || *c.KeyFile == "" || pl.mp.adopted[LUKSRef(c.ID).key()] || !pl.present(c.Device) {
			continue
		}
		dev := pl.devPath(c.Device)
		pl.step("post", "keyfile", dev, []string{"keyfile", "{target_root}" + *c.KeyFile, dev}, nil, "passphrase", "create a new key file and add it as a second key slot")
		pl.add(newFinding(WarnKeyfileRegenerated, c.ID, "luks", c.ID, "path", *c.KeyFile))
	}
	pl.mokSteps()
	for _, s := range l.Swap {
		if s.Kind == "file" && s.Path != nil {
			pl.step("post", "swapfile", *s.Path, []string{"swapfile", "{target_root}" + *s.Path, itoa(s.SizeBytes)}, nil, "", "recreate the swap file (and its resume offset)")
		}
	}
	if l.LVM.UseDevicesFile {
		pl.step("post", "lvm_devices", "", []string{"chroot-exec", "vgimportdevices", "--all", "--config", "devices/obtain_device_list_from_udev=0"}, nil, "", "write the LVM devices file for the new disks")
	}
	pl.initramfsSteps()
	if l.Bootloader.Kind == "grub" {
		cfg := deref(l.Bootloader.GrubCfg)
		switch {
		case strings.Contains(cfg, "grub2"):
			pl.step("post", "grub_config", cfg, []string{"chroot-exec", "grub2-mkconfig", "-o", cfg}, nil, "", "write the GRUB configuration")
		case cfg != "":
			pl.step("post", "grub_config", cfg, []string{"chroot-exec", "grub-mkconfig", "-o", cfg}, nil, "", "write the GRUB configuration")
		}
		if pl.rhel8() {
			// grubenv has a fixed 1024-byte format: never edited as text.
			pl.step("post", "grub_env", "/boot/grub2/grubenv", []string{"chroot-exec", "grub2-editenv", "-", "set", "kernelopts={kernelopts}"}, nil, "",
				"store the new kernel command line in grubenv (kernelopts)")
		}
	}
	if pl.t.Firmware.Mode == "bios" {
		tool := "grub-install"
		if strings.Contains(deref(l.Bootloader.GrubCfg), "grub2") {
			tool = "grub2-install"
		}
		for _, d := range l.Disks {
			a := pl.mp.assign[d.ID]
			if a == nil || a.Action != ActionErase || (d.BootCode != "grub" && !hasString(l.Bootloader.BIOSDisks, d.ID)) {
				continue
			}
			dev := pl.devPath(DiskRef(d.ID))
			pl.step("post", "bootloader_bios", dev, []string{"chroot-exec", tool, "--target=i386-pc", "--no-nvram", dev}, nil, "", "install the BIOS boot code of GRUB")
		}
	}
	if pl.t.Firmware.Mode == "uefi" {
		roots := x.espMounts()
		if l.Bootloader.Kind == "systemd-boot" && len(roots) > 0 {
			esp := roots[0]
			if l.Bootloader.EFIDirectory != nil && reMountPath.MatchString(*l.Bootloader.EFIDirectory) {
				esp = *l.Bootloader.EFIDirectory
			}
			pl.step("post", "bootctl_install", esp, []string{"chroot-exec", "bootctl", "--esp-path=" + esp, "install", "--no-variables"}, nil, "",
				"install systemd-boot on "+esp+" (only when its files are missing; the boot entry is written by recover)")
		}
		hasFallback := false
		for _, ld := range l.Loaders {
			base := strings.ToUpper(path.Base(ld.Path))
			if (base == "BOOTX64.EFI" || base == "BOOTAA64.EFI") && strings.EqualFold(path.Base(path.Dir(ld.Path)), "BOOT") {
				hasFallback = true
			}
		}
		for _, e := range l.Firmware.Entries {
			if !e.Active || e.Loader == nil || e.PartUUID == nil || isMicrosoftLoader(strings.ReplaceAll(*e.Loader, `\`, "/")) {
				continue
			}
			ok := false
			for _, d := range l.Disks {
				if d.Table == nil {
					continue
				}
				for _, p := range d.Table.Partitions {
					if p.UUID != nil && strings.EqualFold(*p.UUID, *e.PartUUID) && pl.present(PartRef(d.ID, p.Number)) {
						ok = true
					}
				}
			}
			if !ok {
				continue
			}
			pl.step("post", "nvram", *e.PartUUID, []string{"nvram", "--label", e.Label, "--partuuid", *e.PartUUID, "--loader", *e.Loader}, nil, "", "create the boot entry "+e.Label)
		}
		if !hasFallback && len(roots) > 0 {
			pl.step("post", "fallback_path", roots[0], []string{"fallback-path", "{target_root}" + roots[0]}, nil, "", "set up \\EFI\\BOOT\\BOOTX64.EFI for firmware that forgets boot entries")
		}
	}
	if se := deref(l.OS.SELinux); se != "" && se != "disabled" {
		pl.step("post", "selinux", "", []string{"selinux"}, nil, "", "check the SELinux labels of the restore; relabel only what recover created or changed")
	}
	pl.step("post", "verify", "", []string{"verify"}, nil, "", "check the restored system (identities, fstab, boot files)")
}

// systemPaths are the paths a restore must bring back completely (10.12):
// /boot, /usr, /etc, /lib*, /bin, /sbin and the ESPs.
func (pl *planner) systemPaths() []string {
	out := []string{"/bin", "/boot", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/sbin", "/usr"}
	for _, r := range pl.x.espMounts() {
		if r != "/" && reMountPath.MatchString(r) {
			out = append(out, r)
		}
	}
	return uniqueSorted(out)
}

// rhel8 reports a RHEL 8 family system with BLS, whose kernel command
// line lives in grubenv (kernelopts).
func (pl *planner) rhel8() bool {
	l := pl.l
	if !l.Bootloader.BLS {
		return false
	}
	rhel := l.OS.ID == "rhel" || hasString(l.OS.IDLike, "rhel")
	return rhel && strings.HasPrefix(deref(l.OS.VersionID), "8")
}

// mkinitcpioPreset is the preset of a kernel (linux, linux-lts, ...), or
// "" when it cannot be told.
func mkinitcpioPreset(k *Kernel) string {
	if base, ok := strings.CutPrefix(path.Base(k.Image), "vmlinuz-"); ok && reSafeName.MatchString(base) {
		return base
	}
	v := k.Version
	for _, suffix := range []string{"lts", "zen", "hardened", "rt"} {
		if strings.HasSuffix(v, "-"+suffix) {
			return "linux-" + suffix
		}
	}
	if strings.Contains(v, "-arch") {
		return "linux"
	}
	return ""
}

// initramfsSteps rebuild the initramfs (10.15): first for the default
// kernel, then (initramfs_extra) for every other kernel; recover runs an
// extra step only when /boot has room for it. A UKI is rebuilt by the
// generator of the target after /etc/kernel/cmdline has its fixup.
func (pl *planner) initramfsSteps() {
	l := pl.l
	kver := deref(pl.plan.Drivers.Kernel)
	var def *Kernel
	var extra []*Kernel
	for i := range l.Kernels {
		k := &l.Kernels[i]
		if k.UKI || !reSafeName.MatchString(k.Version) {
			continue
		}
		if k.Version == kver || (kver == "" && k.Default && def == nil) {
			def = k
			kver = k.Version
			continue
		}
		extra = append(extra, k)
	}
	gen := deref(l.Initramfs.Generator)
	dracutArgs := func(v string, uefi bool) []string {
		args := []string{"chroot-exec", "dracut", "--force", "--no-hostonly"}
		if uefi {
			args = append(args, "--uefi")
		}
		return append(args, "--include", "/etc/crypttab", "/etc/crypttab", "--include", "/etc/vconsole.conf", "/etc/vconsole.conf", "--kver", v)
	}
	one := func(kind, v string, k *Kernel) {
		switch gen {
		case "initramfs-tools":
			pl.step("post", kind, v, []string{"chroot-exec", "update-initramfs", "-u", "-k", v}, nil, "", "rebuild the initramfs of "+v+" with MODULES=most")
		case "dracut":
			pl.step("post", kind, v, dracutArgs(v, false), nil, "", "rebuild the initramfs of "+v+" without hostonly")
		case "mkinitcpio":
			preset := ""
			if k != nil {
				preset = mkinitcpioPreset(k)
			}
			if preset != "" {
				pl.step("post", kind, v, []string{"chroot-exec", "mkinitcpio", "-p", preset}, nil, "", "rebuild the initramfs of preset "+preset+" (with its fallback image)")
			} else if kind == "initramfs" {
				pl.step("post", kind, v, []string{"chroot-exec", "mkinitcpio", "-P"}, nil, "", "rebuild the initramfs of every preset")
			}
		}
	}
	if kver != "" {
		one("initramfs", kver, def)
	}
	for _, k := range extra {
		one("initramfs_extra", k.Version, k)
	}
	// UKI: mkinitcpio presets with a UKI are rebuilt above.
	uki := false
	for _, ld := range l.Loaders {
		uki = uki || ld.UKI
	}
	for _, k := range l.Kernels {
		uki = uki || k.UKI
	}
	if !uki || kver == "" || (gen == "mkinitcpio" && l.Initramfs.UKIPresets) {
		return
	}
	switch {
	case deref(l.Initramfs.KernelInstallLayout) == "uki":
		pl.step("post", "uki", kver, []string{"chroot-exec", "kernel-install", "add", kver, "/usr/lib/modules/" + kver + "/vmlinuz"}, nil, "", "rebuild the unified kernel image of "+kver+" with the new command line")
	case gen == "dracut":
		pl.step("post", "uki", kver, dracutArgs(kver, true), nil, "", "rebuild the unified kernel image of "+kver+" with the new command line")
	}
}

// mokSteps import the machine owner keys the target lacks (10.5): only
// with Secure Boot on and when the key file is in the backup.
func (pl *planner) mokSteps() {
	if pl.t.Firmware.SecureBoot == nil || !*pl.t.Firmware.SecureBoot || pl.f == nil {
		return
	}
	paths := map[string]string{}
	for _, mf := range pl.f.MokFiles {
		if mf.Present && mf.SHA256 != nil && reMountPath.MatchString(mf.Path) && !strings.Contains(mf.Path, "..") {
			paths[strings.ToLower(*mf.SHA256)] = mf.Path
		}
	}
	done := map[string]bool{}
	for _, f := range pl.findings {
		if f.Code != WarnMokEnrollRequired || f.Ref == nil || f.Params["fileMissing"] == true {
			continue
		}
		p, ok := paths[strings.ToLower(*f.Ref)]
		if !ok || done[p] {
			continue
		}
		done[p] = true
		pl.step("post", "mok_import", p, []string{"mok-import", "{target_root}" + p}, nil, "", "queue the machine owner key "+p+" for enrolment at the first start (MokManager)")
	}
}

// EncodePlan writes the plan as JSON with sorted keys and without HTML
// escaping (deterministic: the same input gives the same bytes).
func EncodePlan(p *RestorePlan) ([]byte, error) {
	return encodeSorted(p)
}

func encodeSorted(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	var tree any
	dec := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	dec.UseNumber()
	if err := dec.Decode(&tree); err != nil {
		return nil, err
	}
	buf.Reset()
	enc = json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(tree); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
