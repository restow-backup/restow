package baremetal

import (
	"regexp"
	"sort"
	"strings"
)

// LVM RAID logical volumes (docs/BAREMETAL.md 2.1, 10.9, 10.10). The
// manifest records the segment type and the segment's stripe count, which
// for a RAID or mirror segment is its number of images (sub-LVs, parity
// included). From these the planner derives the space an LV takes in its VG
// and the lvcreate arguments. A RAID LV whose image count is missing or does
// not fit its type is a problem of the plan, never a linear LV.

// raidMetaFloor is the space reserved for the rmeta sub-LV of one image
// (at least one extent).
const raidMetaFloor = 4 * mib

var reLVMRaidType = regexp.MustCompile(`^(raid0|raid0_meta|raid1|raid4|raid5(_[a-z0-9]+)?|raid6(_[a-z0-9]+)?|raid10)$`)

// lvmRaid is the geometry of a RAID or mirror LV.
type lvmRaid struct {
	images int64 // sub-LVs (data and parity, or copies)
	data   int64 // data stripes: the usable size is data times one image
	copies int64 // raid1 and raid10: copies of each block (the -m of lvcreate is copies-1)
	meta   bool  // one rmeta sub-LV per image
}

// isLVMRaid: the LV is a RAID or (old) mirror LV.
func isLVMRaid(lv *LogicalVolume) bool {
	return strings.HasPrefix(lv.Type, "raid") || lv.Type == "mirror"
}

// lvmRaidOf returns the geometry of a RAID LV; ok is false for an LV that
// is not RAID or whose image count is unknown or impossible for its type.
func lvmRaidOf(lv *LogicalVolume) (lvmRaid, bool) {
	if !isLVMRaid(lv) || lv.Stripes == nil || *lv.Stripes < 1 {
		return lvmRaid{}, false
	}
	n := *lv.Stripes
	t := lv.Type
	switch {
	case t == "raid0" || t == "raid0_meta":
		return lvmRaid{images: n, data: n, copies: 1, meta: t == "raid0_meta"}, n >= 2
	case t == "raid1" || t == "mirror":
		// An old mirror LV is recreated as raid1 with the same number of legs.
		return lvmRaid{images: n, data: 1, copies: n, meta: true}, n >= 2
	case t == "raid4" || strings.HasPrefix(t, "raid5"):
		return lvmRaid{images: n, data: n - 1, copies: 1, meta: true}, n >= 3 && reLVMRaidType.MatchString(t)
	case strings.HasPrefix(t, "raid6"):
		return lvmRaid{images: n, data: n - 2, copies: 1, meta: true}, n >= 5 && reLVMRaidType.MatchString(t)
	case t == "raid10":
		// LVM's raid10 keeps two copies of every stripe.
		return lvmRaid{images: n, data: n / 2, copies: 2, meta: true}, n >= 4 && n%2 == 0
	}
	return lvmRaid{}, false
}

// raidImage is the space one image of an LV of usable size takes: its
// share of the data in whole extents plus its rmeta sub-LV.
func raidImage(g lvmRaid, size, ext int64) int64 {
	n := alignUp((max(size, 0)+g.data-1)/g.data, ext)
	if g.meta {
		n += alignUp(raidMetaFloor, ext)
	}
	return n
}

// lvFootprint is the space an LV of usable size takes in its VG: the size
// itself for a linear, striped or thin-pool LV, every image for a RAID LV.
func lvFootprint(lv *LogicalVolume, size, ext int64) int64 {
	g, ok := lvmRaidOf(lv)
	if !ok {
		return size
	}
	return g.images * raidImage(g, size, ext)
}

// lvUsable is the largest usable size of an LV whose footprint is at most
// footprint (in whole extents; 0 when nothing fits).
func lvUsable(lv *LogicalVolume, footprint, ext int64) int64 {
	g, ok := lvmRaidOf(lv)
	if !ok {
		if footprint <= 0 {
			return 0
		}
		return alignDown(footprint, ext)
	}
	per := footprint / g.images
	if g.meta {
		per -= alignUp(raidMetaFloor, ext)
	}
	per = alignDown(per, ext)
	if per <= 0 {
		return 0
	}
	return per * g.data
}

// raidSizeArgs are the lvcreate arguments of a RAID LV before -L.
func raidSizeArgs(lv *LogicalVolume) []string {
	g, ok := lvmRaidOf(lv)
	if !ok {
		return nil
	}
	stripeSize := func(args []string) []string {
		if lv.StripeBytes != nil && *lv.StripeBytes >= 4096 {
			args = append(args, "-I", itoa(*lv.StripeBytes/1024)+"k")
		}
		return args
	}
	switch {
	case lv.Type == "raid1" || lv.Type == "mirror":
		return []string{"--type", "raid1", "-m", itoa(g.copies - 1)}
	case lv.Type == "raid10":
		return stripeSize([]string{"--type", "raid10", "-i", itoa(g.data), "-m", itoa(g.copies - 1)})
	default:
		return stripeSize([]string{"--type", lv.Type, "-i", itoa(g.data)})
	}
}

// raidPlacement puts the images of the VG's RAID LVs on its PVs, before
// any other LV: largest image first, each on the PVs with the most free
// space (ties: the order of the PVs). caps is the usable space per PV in
// the order of x.vgPVs, sizes the usable size per LV name. It returns the
// PV indexes per LV and the space the images take per PV; ok is false when
// an LV does not find enough PVs with room.
func (x *layoutModel) raidPlacement(vg *VolumeGroup, sizes map[string]int64, caps []int64) (map[string][]int, []int64, bool) {
	ext := max(vg.ExtentBytes, 1)
	type item struct {
		lv    *LogicalVolume
		g     lvmRaid
		image int64
	}
	var items []item
	for i := range vg.LVs {
		lv := &vg.LVs[i]
		g, ok := lvmRaidOf(lv)
		if !ok || !x.lvCreated(vg, lv) {
			continue
		}
		items = append(items, item{lv: lv, g: g, image: raidImage(g, sizes[lv.Name], ext)})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].image > items[j].image })
	free := append([]int64{}, caps...)
	load := make([]int64, len(caps))
	out := map[string][]int{}
	ok := true
	for _, it := range items {
		order := make([]int, len(free))
		for i := range order {
			order[i] = i
		}
		sort.SliceStable(order, func(i, j int) bool { return free[order[i]] > free[order[j]] })
		if int64(len(order)) < it.g.images {
			ok = false
			continue
		}
		chosen := order[:it.g.images]
		if free[chosen[len(chosen)-1]] < it.image {
			ok = false
			continue
		}
		picked := append([]int{}, chosen...)
		sort.Ints(picked)
		for _, i := range picked {
			free[i] -= it.image
			load[i] += it.image
		}
		out[it.lv.Name] = picked
	}
	return out, load, ok
}

// vgHasRaid: the VG holds a RAID LV that is created.
func (x *layoutModel) vgHasRaid(vg *VolumeGroup) bool {
	for i := range vg.LVs {
		if isLVMRaid(&vg.LVs[i]) && x.lvCreated(vg, &vg.LVs[i]) {
			return true
		}
	}
	return false
}

// raidMinimumLoad is the space the RAID images take on each PV of the VG
// at the LVs' minimum sizes, placed on the recorded PV sizes (index of
// x.vgPVs). A PV of a minimal target must hold at least its load.
func (x *layoutModel) raidMinimumLoad(vg *VolumeGroup) []int64 {
	pvs := x.vgPVs[vg.Name]
	caps := make([]int64, len(pvs))
	for i, pv := range pvs {
		caps[i] = pv.SizeBytes
	}
	sizes := map[string]int64{}
	for i := range vg.LVs {
		sizes[vg.LVs[i].Name] = x.lvMinimum(vg, &vg.LVs[i])
	}
	_, load, _ := x.raidPlacement(vg, sizes, caps)
	return load
}

// raidGeometryFindings: a RAID LV the planner cannot reproduce (no or an
// impossible image count, an unknown RAID type) blocks the plan.
func (x *layoutModel) raidGeometryFindings() []Finding {
	var out []Finding
	for vi := range x.l.LVM.VGs {
		vg := &x.l.LVM.VGs[vi]
		for i := range vg.LVs {
			lv := &vg.LVs[i]
			if !isLVMRaid(lv) || !x.lvCreated(vg, lv) {
				continue
			}
			if _, ok := lvmRaidOf(lv); !ok {
				ref := vg.Name + "/" + lv.Name
				out = append(out, newFinding(ProblemLayoutUnsupported, ref, "reason", "LVM "+lv.Type+" LV "+ref+" with an unknown number of images",
					"codes", []string{"lvm_raid_geometry_unknown"}))
			}
		}
	}
	return out
}
