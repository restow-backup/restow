package baremetal

import (
	"sort"
	"strings"
)

// Mapping of source disks to target disks, adoption of intact parts and
// identity conflicts (docs/BAREMETAL.md 10.6, 10.7).

// Actions of a DiskAssignment.
const (
	ActionErase   = "erase"
	ActionAdopt   = "adopt"
	ActionMissing = "missing"
)

// DiskAssignment says what becomes of one source disk.
type DiskAssignment struct {
	Source string  `json:"source"`
	Target *string `json:"target"`
	Action string  `json:"action"`
	Reason *string `json:"reason"`
}

// AdoptedPart is a part of the source stack that exists intact on the
// target and is kept: nothing on it is erased, its mount points are left
// out of the restore.
type AdoptedPart struct {
	Kind    string   `json:"kind"`
	Ref     string   `json:"ref"`
	Targets []string `json:"targets"`
	Mounts  []string `json:"mounts"`
}

// normUUID makes UUIDs of different notations comparable (mdadm writes
// a:b:c:d, blkid 8-4-4-4-12; sfdisk writes the disk signature of an MBR as
// 0xa1b2c3d0, blkid reports it as PTUUID a1b2c3d0).
func normUUID(s string) string {
	s = strings.ToLower(strings.NewReplacer("-", "", ":", "", " ", "").Replace(s))
	return strings.TrimPrefix(s, "0x")
}

// identityRef is an identity of the manifest and the source disks it lives on.
type identityRef struct {
	kind  string // disk_guid, part_uuid, fs, md, pv, luks
	ref   string
	disks []string
}

// mapper holds the state of the mapping.
type mapper struct {
	x        *layoutModel
	t        *Target
	c        Choices
	assign   map[string]*DiskAssignment
	targets  map[string]*TargetDisk
	used     map[string]string // target id -> source disk
	ids      map[string][]identityRef
	adopted  map[string]bool // node keys of adopted devices
	units    []AdoptedPart
	findings []Finding
	// resume: the plan continues a started recovery (PlanOptions.Resume).
	resume bool
}

func (mp *mapper) add(f Finding) { mp.findings = append(mp.findings, f) }

// disksUnder returns the source disks a device sits on.
func (x *layoutModel) disksUnder(r BlockRef) []string {
	seen := map[string]bool{}
	var walk func(r BlockRef, depth int)
	walk = func(r BlockRef, depth int) {
		if depth > 64 {
			return
		}
		switch r.Kind {
		case RefDisk, RefPartition:
			seen[r.Disk] = true
		case RefMD:
			if md := x.md[r.ID]; md != nil {
				for _, mem := range md.Members {
					walk(mem.Device, depth+1)
				}
				for _, s := range md.Spares {
					walk(s, depth+1)
				}
			}
		case RefLUKS:
			if c := x.luks[r.ID]; c != nil {
				walk(c.Device, depth+1)
			}
		case RefPlain:
			if c := x.plain[r.ID]; c != nil {
				walk(c.Device, depth+1)
			}
		case RefLV:
			for _, pv := range x.vgPVs[r.VG] {
				walk(pv.Device, depth+1)
			}
		}
	}
	walk(r, 0)
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// identities indexes every identity of the manifest by normalized UUID.
func (x *layoutModel) identities() map[string][]identityRef {
	ids := map[string][]identityRef{}
	put := func(uuid, kind, ref string, disks []string) {
		if uuid == "" {
			return
		}
		k := normUUID(uuid)
		ids[k] = append(ids[k], identityRef{kind: kind, ref: ref, disks: disks})
	}
	for _, d := range x.l.Disks {
		if d.Table != nil {
			put(d.Table.ID, "disk_guid", d.ID, []string{d.ID})
			for _, p := range d.Table.Partitions {
				if p.UUID != nil {
					put(*p.UUID, "part_uuid", partLabel(&d, &p), []string{d.ID})
				}
			}
		}
	}
	for _, md := range x.l.MD {
		put(md.UUID, "md", md.ID, x.disksUnder(MDRef(md.ID)))
	}
	for _, c := range x.l.LUKS {
		put(c.UUID, "luks", c.ID, x.disksUnder(LUKSRef(c.ID)))
	}
	for _, pv := range x.l.LVM.PVs {
		put(pv.UUID, "pv", pv.UUID, x.disksUnder(pv.Device))
	}
	for _, fs := range x.l.Filesystems {
		var disks []string
		for _, dv := range fs.Devices {
			disks = append(disks, x.disksUnder(dv)...)
		}
		put(deref(fs.UUID), "fs", fs.ID, disks)
	}
	return ids
}

// manifestSignatures returns the signatures of a target device that are
// identities of the manifest.
func (mp *mapper) manifestSignatures(td *TargetDisk) []TargetSignature {
	var out []TargetSignature
	for _, s := range td.Signatures {
		if _, ok := mp.ids[normUUID(s.UUID)]; ok && s.UUID != "" {
			out = append(out, s)
		}
	}
	return out
}

// ownerDisks returns the source disks a target carries signatures of,
// preferring partition and disk GUIDs (unique to one disk).
func (mp *mapper) ownerDisks(td *TargetDisk) []string {
	strong, weak := map[string]bool{}, map[string]bool{}
	for _, s := range mp.manifestSignatures(td) {
		for _, id := range mp.ids[normUUID(s.UUID)] {
			for _, d := range id.disks {
				if id.kind == "part_uuid" || id.kind == "disk_guid" {
					strong[d] = true
				} else {
					weak[d] = true
				}
			}
		}
	}
	pick := strong
	if len(pick) == 0 {
		pick = weak
	}
	out := make([]string, 0, len(pick))
	for d := range pick {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

func sameIdentity(d *Disk, td *TargetDisk) bool {
	eq := func(a, b *string) bool { return deref(a) != "" && strings.EqualFold(deref(a), deref(b)) }
	if eq(d.WWN, td.WWN) || eq(d.EUI64, td.EUI64) || eq(d.NGUID, td.NGUID) {
		return true
	}
	if eq(d.Serial, td.Serial) {
		if d.NSID == nil || td.NSID == nil {
			return d.NSID == nil && td.NSID == nil
		}
		return *d.NSID == *td.NSID
	}
	return false
}

// unusable says why a target disk cannot be written, or "".
func unusable(td *TargetDisk) string {
	switch {
	case td.ReadOnly:
		return "read_only"
	case td.Zoned != "" && td.Zoned != "none":
		return "zoned"
	case td.SizeBytes == 0:
		return "zero_size"
	}
	return ""
}

func (mp *mapper) allowed(td *TargetDisk) bool {
	for _, a := range mp.c.AllowDevices {
		if a == td.ID {
			return true
		}
	}
	tr := deref(td.Transport)
	return !td.Removable && tr != "fc" && tr != "iscsi"
}

func (mp *mapper) set(src, action, target, reason string) {
	a := &DiskAssignment{Source: src, Action: action}
	if target != "" {
		a.Target = strPtr(target)
		mp.used[target] = src
	}
	if reason != "" {
		a.Reason = strPtr(reason)
	}
	mp.assign[src] = a
}

// mapDisks fills assign: the choices first, then the automatic mapping.
func (mp *mapper) mapDisks(minimum map[string]int64) {
	x := mp.x
	// Multipath and locked disks.
	byWWN := map[string][]string{}
	for _, list := range [][]TargetDisk{mp.t.Disks, mp.t.Others} {
		for _, td := range list {
			if w := strings.ToLower(deref(td.WWN)); w != "" {
				byWWN[w] = append(byWWN[w], td.ID)
			}
		}
	}
	wwns := make([]string, 0, len(byWWN))
	for w := range byWWN {
		wwns = append(wwns, w)
	}
	sort.Strings(wwns)
	for _, w := range wwns {
		if ids := byWWN[w]; len(ids) > 1 {
			mp.add(newFinding(ProblemMultipathDetected, ids[0], "targets", ids, "wwn", w))
		}
	}

	// Explicit choices.
	keys := make([]string, 0, len(mp.c.DiskMapping))
	for k := range mp.c.DiskMapping {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, src := range keys {
		v := mp.c.DiskMapping[src]
		if x.disks[src] == nil {
			mp.add(newFinding(ProblemMappingInvalid, src, "reason", "unknown_source", "disk", src))
			continue
		}
		switch v {
		case ActionMissing:
			mp.set(src, ActionMissing, "", "choice")
		case ActionAdopt:
			found := ""
			for i := range mp.t.Disks {
				td := &mp.t.Disks[i]
				if _, taken := mp.used[td.ID]; taken {
					continue
				}
				for _, d := range mp.ownerDisks(td) {
					if d == src && found == "" {
						found = td.ID
					}
				}
			}
			if found == "" {
				mp.add(newFinding(ProblemAdoptIncomplete, src, "unit", "disk "+src, "reason", "no target disk carries its identities"))
				mp.set(src, ActionMissing, "", "choice")
				continue
			}
			mp.set(src, ActionAdopt, found, "choice")
		default:
			td := mp.targets[v]
			if td == nil {
				mp.add(newFinding(ProblemMappingInvalid, src, "reason", "unknown_target", "disk", src, "target", v))
				continue
			}
			if other, taken := mp.used[v]; taken {
				mp.add(newFinding(ProblemMappingInvalid, src, "reason", "target_used_twice", "disk", src, "target", v, "other", other))
				continue
			}
			mp.set(src, ActionErase, v, "choice")
		}
	}

	// Units the operator adopts: their disks are adopted.
	for _, u := range mp.c.Adopt {
		disks, ok := mp.unitDisks(u)
		if !ok {
			mp.add(newFinding(ProblemMappingInvalid, "", "reason", "unknown_adopt", "unit", u))
			continue
		}
		for _, d := range disks {
			if a := mp.assign[d]; a != nil {
				if a.Action == ActionErase {
					mp.add(newFinding(ProblemMappingInvalid, d, "reason", "adopt_and_erase", "disk", d, "unit", u))
				}
				continue
			}
			found := ""
			for i := range mp.t.Disks {
				td := &mp.t.Disks[i]
				if _, taken := mp.used[td.ID]; taken || found != "" {
					continue
				}
				for _, o := range mp.ownerDisks(td) {
					if o == d {
						found = td.ID
					}
				}
			}
			if found == "" {
				mp.add(newFinding(ProblemAdoptIncomplete, d, "unit", u, "reason", "no target disk carries disk "+d))
				continue
			}
			mp.set(d, ActionAdopt, found, "choice")
		}
	}

	if mp.resume {
		mp.mapResume()
		return
	}

	// Automatic: a target with signatures of a source disk is adopted,
	// never erased.
	for i := range mp.t.Disks {
		td := &mp.t.Disks[i]
		if _, taken := mp.used[td.ID]; taken {
			continue
		}
		owners := mp.ownerDisks(td)
		if len(owners) == 1 && mp.assign[owners[0]] == nil {
			mp.set(owners[0], ActionAdopt, td.ID, "signatures")
		}
	}

	var srcs []string
	for _, d := range x.l.Disks {
		if mp.assign[d.ID] == nil {
			srcs = append(srcs, d.ID)
		}
	}
	if len(srcs) == 0 {
		return
	}
	var free []*TargetDisk
	var locked []string
	for i := range mp.t.Disks {
		td := &mp.t.Disks[i]
		if _, taken := mp.used[td.ID]; taken || len(mp.manifestSignatures(td)) > 0 {
			continue
		}
		if td.IOError {
			locked = append(locked, td.ID)
			continue
		}
		if unusable(td) != "" || !mp.allowed(td) {
			continue
		}
		free = append(free, td)
	}
	// Same identity first (same hardware). An identity that two free
	// targets share (bridges and clones report the same serial) names no
	// disk: it decides nothing, the later rules or the operator do.
	rest := srcs[:0:0]
	for _, s := range srcs {
		d := x.disks[s]
		var same []*TargetDisk
		for _, td := range free {
			if _, taken := mp.used[td.ID]; !taken && sameIdentity(d, td) {
				same = append(same, td)
			}
		}
		if len(same) == 1 {
			mp.set(s, ActionErase, same[0].ID, "identity")
		} else {
			rest = append(rest, s)
		}
	}
	var avail []*TargetDisk
	for _, td := range free {
		if _, taken := mp.used[td.ID]; !taken {
			avail = append(avail, td)
		}
	}
	if len(rest) == 0 {
		return
	}
	if len(avail) > len(rest) {
		// More free disks than source disks: the operator chooses.
		ids := make([]string, 0, len(avail))
		for _, td := range avail {
			ids = append(ids, td.ID)
		}
		mp.add(newFinding(ProblemMappingInvalid, "", "reason", "choice_required", "disks", rest, "targets", ids))
		return
	}
	// Same size and transport.
	rest2 := rest[:0:0]
	for _, s := range rest {
		d := x.disks[s]
		matched := false
		for _, td := range avail {
			if _, taken := mp.used[td.ID]; !taken && td.SizeBytes == d.SizeBytes && deref(td.Transport) == deref(d.Transport) {
				mp.set(s, ActionErase, td.ID, "size_transport")
				matched = true
				break
			}
		}
		if !matched {
			rest2 = append(rest2, s)
		}
	}
	var left []*TargetDisk
	for _, td := range avail {
		if _, taken := mp.used[td.ID]; !taken {
			left = append(left, td)
		}
	}
	if len(rest2) == 0 {
		return
	}
	if len(left) != len(rest2) {
		if len(left) < len(rest2) {
			for _, id := range locked {
				mp.add(newFinding(ProblemSEDLocked, id, "target", id))
			}
			for _, s := range rest2 {
				mp.add(newFinding(ProblemTargetMissing, s, "disk", s, "kname", x.disks[s].KName, "minBytes", minimum[s]))
			}
		} else {
			ids := make([]string, 0, len(left))
			for _, td := range left {
				ids = append(ids, td.ID)
			}
			mp.add(newFinding(ProblemMappingInvalid, "", "reason", "choice_required", "disks", rest2, "targets", ids))
		}
		return
	}
	// Size descending against minimum descending.
	sort.SliceStable(rest2, func(i, j int) bool { return minimum[rest2[i]] > minimum[rest2[j]] })
	sort.SliceStable(left, func(i, j int) bool { return left[i].SizeBytes > left[j].SizeBytes })
	for i, s := range rest2 {
		mp.set(s, ActionErase, left[i].ID, "size")
	}
}

// mapResume maps the disks the choices left open in a resumed plan
// (10.18). Nothing is erased, so identity and size decide nothing: the
// target that carries the identities of a source disk is the one the
// first run wrote, whichever disk the operator chose then. Disks whose
// identities are shared (members of one array or of one btrfs without a
// partition table) take the carriers in order; a source disk that no
// target carries was missing in the first run. A second carrier of the
// same identities (the old disk next to the new one) stays unused and is
// an identity conflict.
func (mp *mapper) mapResume() {
	owners := map[string][]string{}
	for i := range mp.t.Disks {
		td := &mp.t.Disks[i]
		if _, taken := mp.used[td.ID]; !taken {
			owners[td.ID] = mp.ownerDisks(td)
		}
	}
	for i := range mp.t.Disks {
		td := &mp.t.Disks[i]
		if o := owners[td.ID]; len(o) == 1 && mp.assign[o[0]] == nil {
			mp.set(o[0], ActionErase, td.ID, "resume")
		}
	}
	for _, d := range mp.x.l.Disks {
		if mp.assign[d.ID] != nil {
			continue
		}
		for i := range mp.t.Disks {
			td := &mp.t.Disks[i]
			if _, taken := mp.used[td.ID]; !taken && hasString(owners[td.ID], d.ID) {
				mp.set(d.ID, ActionErase, td.ID, "resume")
				break
			}
		}
		if mp.assign[d.ID] == nil {
			mp.set(d.ID, ActionMissing, "", "resume")
		}
	}
}

// unitDisks resolves an adopt entry ("md:<id|kname|name>", "vg:<name>",
// "luks:<id>", "fs:<id>") to its source disks.
func (mp *mapper) unitDisks(u string) ([]string, bool) {
	x := mp.x
	kind, name, ok := strings.Cut(u, ":")
	if !ok {
		return nil, false
	}
	switch kind {
	case "md":
		for _, md := range x.l.MD {
			if md.ID == name || md.KName == name || deref(md.Name) == name {
				return x.disksUnder(MDRef(md.ID)), true
			}
		}
	case "vg":
		if vg := x.vgs[name]; vg != nil {
			var out []string
			for _, pv := range x.vgPVs[name] {
				out = append(out, x.disksUnder(pv.Device)...)
			}
			return uniqueSorted(out), true
		}
	case "luks":
		if c := x.luks[name]; c != nil {
			return x.disksUnder(LUKSRef(c.ID)), true
		}
	case "fs":
		if fs := x.fs[name]; fs != nil {
			var out []string
			for _, d := range fs.Devices {
				out = append(out, x.disksUnder(d)...)
			}
			return uniqueSorted(out), true
		}
	}
	return nil, false
}

func uniqueSorted(s []string) []string {
	sort.Strings(s)
	out := s[:0]
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}

// adoptedTargetSignatures returns the signatures of the adopted targets.
func (mp *mapper) adoptedSignatures() map[string]TargetSignature {
	out := map[string]TargetSignature{}
	for _, d := range mp.x.l.Disks {
		a := mp.assign[d.ID]
		if a == nil || a.Action != ActionAdopt || a.Target == nil {
			continue
		}
		for _, s := range mp.targets[*a.Target].Signatures {
			out[s.Kind+"|"+normUUID(s.UUID)] = s
		}
	}
	return out
}

// resolveAdoption derives the adopted devices from the adopted disks,
// checks each adopted unit against the target's signatures and builds
// units.
func (mp *mapper) resolveAdoption() {
	x := mp.x
	adoptedDisk := map[string]bool{}
	for d, a := range mp.assign {
		if a.Action == ActionAdopt {
			adoptedDisk[d] = true
		}
	}
	if len(adoptedDisk) == 0 {
		return
	}
	targetsOf := func(disks []string) []string {
		var out []string
		for _, d := range disks {
			if a := mp.assign[d]; a != nil && a.Action == ActionAdopt && a.Target != nil {
				out = append(out, *a.Target)
			}
		}
		return uniqueSorted(out)
	}
	allAdopted := func(r BlockRef) bool {
		disks := x.disksUnder(r)
		if len(disks) == 0 {
			return false
		}
		for _, d := range disks {
			if !adoptedDisk[d] && mp.assign[d] != nil && mp.assign[d].Action != ActionMissing {
				return false
			}
			if mp.assign[d] == nil {
				return false
			}
		}
		for _, d := range disks {
			if adoptedDisk[d] {
				return true
			}
		}
		return false
	}
	sigs := mp.adoptedSignatures()
	has := func(kind, uuid string) bool { _, ok := sigs[kind+"|"+normUUID(uuid)]; return ok }
	for _, d := range x.l.Disks {
		if !adoptedDisk[d.ID] {
			continue
		}
		mp.adopted[DiskRef(d.ID).key()] = true
		if d.Table != nil {
			for _, p := range d.Table.Partitions {
				mp.adopted[PartRef(d.ID, p.Number).key()] = true
			}
		}
	}
	for _, md := range x.l.MD {
		r := MDRef(md.ID)
		if !allAdopted(r) {
			continue
		}
		mp.adopted[r.key()] = true
		count := 0
		for i := range mp.t.Disks {
			for _, s := range mp.t.Disks[i].Signatures {
				if s.Kind == "md" && normUUID(s.UUID) == normUUID(md.UUID) {
					count++
					break
				}
			}
		}
		if int64(count) < mdNeeded(&md) {
			mp.add(newFinding(ProblemAdoptIncomplete, md.ID, "unit", "md "+md.KName, "reason", "too few members carry the array UUID"))
		}
		mp.units = append(mp.units, AdoptedPart{Kind: "md", Ref: md.ID, Targets: targetsOf(x.disksUnder(r)), Mounts: []string{}})
	}
	for _, c := range x.l.LUKS {
		r := LUKSRef(c.ID)
		if !allAdopted(r) {
			continue
		}
		mp.adopted[r.key()] = true
		if !has("luks", c.UUID) {
			mp.add(newFinding(ProblemAdoptIncomplete, c.ID, "unit", "luks "+c.ID, "reason", "the LUKS UUID is not on the target"))
		}
		mp.units = append(mp.units, AdoptedPart{Kind: "luks", Ref: c.ID, Targets: targetsOf(x.disksUnder(r)), Mounts: []string{}})
	}
	for _, vg := range x.l.LVM.VGs {
		pvs := x.vgPVs[vg.Name]
		if len(pvs) == 0 {
			continue
		}
		all := true
		for _, pv := range pvs {
			all = all && allAdopted(pv.Device)
		}
		if !all {
			continue
		}
		for _, lv := range vg.LVs {
			mp.adopted[LVRef(vg.Name, lv.Name).key()] = true
		}
		for _, pv := range pvs {
			if !has("pv", pv.UUID) {
				mp.add(newFinding(ProblemAdoptIncomplete, vg.Name, "unit", "vg "+vg.Name, "reason", "physical volume "+pv.UUID+" is not on the target"))
				break
			}
		}
		var disks []string
		for _, pv := range pvs {
			disks = append(disks, x.disksUnder(pv.Device)...)
		}
		mp.units = append(mp.units, AdoptedPart{Kind: "vg", Ref: vg.Name, Targets: targetsOf(uniqueSorted(disks)), Mounts: []string{}})
	}
	for _, fs := range x.l.Filesystems {
		all := len(fs.Devices) > 0
		for _, d := range fs.Devices {
			all = all && mp.adopted[d.key()]
		}
		if !all {
			continue
		}
		ok := false
		for _, s := range sigs {
			if s.Kind == "fs" && normUUID(s.UUID) == normUUID(deref(fs.UUID)) && (s.Type == nil || *s.Type == fs.Type) {
				ok = true
			}
		}
		if !ok {
			mp.add(newFinding(ProblemAdoptIncomplete, fs.ID, "unit", "fs "+fs.ID, "reason", "the file system UUID and type are not on the target"))
		}
		var disks []string
		for _, d := range fs.Devices {
			disks = append(disks, x.disksUnder(d)...)
		}
		mounts := append([]string{}, x.mounts[fs.ID]...)
		mp.units = append(mp.units, AdoptedPart{Kind: "fs", Ref: fs.ID, Targets: targetsOf(uniqueSorted(disks)), Mounts: mounts})
	}
	// An adopted disk must not carry anything that is not adopted.
	for _, d := range x.l.Disks {
		if !adoptedDisk[d.ID] {
			continue
		}
		var nodes []BlockRef
		if d.Table == nil {
			nodes = append(nodes, DiskRef(d.ID))
		} else {
			for _, p := range d.Table.Partitions {
				nodes = append(nodes, PartRef(d.ID, p.Number))
			}
		}
		for _, r := range nodes {
			if !mp.contentAdopted(r.key()) {
				mp.add(newFinding(ProblemAdoptIncomplete, d.ID, "unit", "disk "+d.ID, "reason", "it also carries "+r.String()+", which is not adopted"))
				break
			}
		}
	}
}

// contentAdopted: what sits on the device is adopted (or nothing sits on it).
func (mp *mapper) contentAdopted(key string) bool {
	x := mp.x
	kind, v := x.contentOf(key)
	switch kind {
	case contentNone:
		return true
	case contentFS, contentBtrfs:
		fs := v.(*Filesystem)
		for _, u := range mp.units {
			if u.Kind == "fs" && u.Ref == fs.ID {
				return true
			}
		}
		return false
	case contentMD:
		return mp.adopted[MDRef(v.(*MDArray).ID).key()]
	case contentLUKS:
		return mp.adopted[LUKSRef(v.(*LUKSVolume).ID).key()]
	case contentPV:
		pv := v.(*PV)
		for _, u := range mp.units {
			if u.Kind == "vg" && u.Ref == deref(pv.VG) {
				return true
			}
		}
		return false
	}
	return false
}

// mdNeeded is the number of members an array needs to run.
func mdNeeded(md *MDArray) int64 {
	n := md.RaidDevices
	switch strings.TrimPrefix(strings.ToLower(md.Level), "raid") {
	case "1":
		return 1
	case "10":
		c := raid10Copies(md)
		return (n + c - 1) / c
	case "4", "5":
		return n - 1
	case "6":
		return n - 2
	}
	return n
}

// checkMissing checks the disks mapped as missing (10.7): every array on
// them still runs, and their other partitions are redundant boot
// partitions only.
func (mp *mapper) checkMissing() {
	x := mp.x
	missing := map[string]bool{}
	for d, a := range mp.assign {
		if a.Action == ActionMissing {
			missing[d] = true
		}
	}
	if len(missing) == 0 {
		return
	}
	degraded := map[string]bool{}
	for _, d := range x.l.Disks {
		if !missing[d.ID] {
			continue
		}
		var nodes []BlockRef
		if d.Table == nil {
			nodes = append(nodes, DiskRef(d.ID))
		} else {
			for _, p := range d.Table.Partitions {
				nodes = append(nodes, PartRef(d.ID, p.Number))
			}
		}
		for _, r := range nodes {
			key := r.key()
			kind, v := x.contentOf(key)
			switch {
			case kind == contentMD:
				degraded[v.(*MDArray).ID] = true
			case kind == contentBtrfs:
				mp.add(newFinding(ProblemBtrfsRaidMissingDevice, v.(*Filesystem).ID, "fs", v.(*Filesystem).ID, "disk", d.ID))
			case r.Kind == RefPartition && mp.redundantBoot(&d, key):
				mp.add(newFinding(WarnRedundantBootPartitionDropped, partLabel(&d, x.parts[key]), "partition", partLabel(&d, x.parts[key]), "disk", d.ID))
			case kind == contentNone && r.Kind == RefPartition:
				// An empty partition of unknown type: nothing to restore.
			case kind == contentPV:
				pv := v.(*PV)
				vg := x.vgs[deref(pv.VG)]
				raid := false
				if vg != nil {
					for _, lv := range vg.LVs {
						if strings.HasPrefix(lv.Type, "raid") || lv.Type == "mirror" {
							raid = true
							mp.add(newFinding(ProblemLVMRaidMissingPV, vg.Name+"/"+lv.Name, "vg", vg.Name, "lv", lv.Name, "disk", d.ID))
						}
					}
				}
				if !raid {
					mp.add(newFinding(ProblemTargetMissing, d.ID, "disk", d.ID, "kname", d.KName, "minBytes", x.diskMinimum(&d)))
				}
			default:
				mp.add(newFinding(ProblemTargetMissing, d.ID, "disk", d.ID, "kname", d.KName, "minBytes", x.diskMinimum(&d)))
			}
		}
	}
	for _, md := range x.l.MD {
		if !degraded[md.ID] {
			continue
		}
		present := int64(0)
		for _, mem := range md.Members {
			for _, dd := range x.disksUnder(mem.Device) {
				if !missing[dd] {
					present++
				}
			}
		}
		if present < mdNeeded(&md) {
			mp.add(newFinding(ProblemMDTooFewMembers, md.ID, "md", md.KName, "have", present, "need", mdNeeded(&md)))
		} else {
			mp.add(newFinding(WarnMDDegradedFirstBoot, md.ID, "md", md.KName, "have", present, "need", md.RaidDevices))
		}
	}
}

// redundantBoot: a BIOS boot partition, or an ESP that is not in fstab or
// carries nofail.
func (mp *mapper) redundantBoot(d *Disk, key string) bool {
	x := mp.x
	p := x.parts[key]
	if p == nil {
		return false
	}
	if strings.ToLower(p.Type) == gptBIOSBoot {
		return true
	}
	if !x.isESPPartition(d, p) {
		return false
	}
	fs := x.fsOn[key]
	if fs == nil {
		return true
	}
	for _, e := range x.l.Fstab {
		if e.Resolved != nil && e.Resolved.FS != nil && *e.Resolved.FS == fs.ID && !e.Nofail {
			return false
		}
	}
	return true
}

// identityConflicts reports devices that are neither target nor adopted
// and carry an identity of the manifest.
func (mp *mapper) identityConflicts() {
	check := func(td *TargetDisk) {
		for _, s := range mp.manifestSignatures(td) {
			mp.add(newFinding(ProblemIdentityConflict, td.ID, "device", td.Path, "kind", s.Kind, "uuid", s.UUID))
			return
		}
	}
	for i := range mp.t.Disks {
		if _, used := mp.used[mp.t.Disks[i].ID]; !used {
			check(&mp.t.Disks[i])
		}
	}
	for i := range mp.t.Others {
		check(&mp.t.Others[i])
	}
}

// checkTargets reports mapped targets that cannot be written.
func (mp *mapper) checkTargets() {
	for _, d := range mp.x.l.Disks {
		a := mp.assign[d.ID]
		if a == nil || a.Action != ActionErase || a.Target == nil {
			continue
		}
		td := mp.targets[*a.Target]
		if td.IOError {
			mp.add(newFinding(ProblemSEDLocked, td.ID, "target", td.ID))
		} else if why := unusable(td); why != "" {
			mp.add(newFinding(ProblemTargetUnusable, td.ID, "target", td.ID, "reason", why))
		}
	}
}
