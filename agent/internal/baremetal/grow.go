package baremetal

// growableFS can be enlarged after a restore onto a larger disk.
var growableFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true}

// setGrowDefaults marks what grows on a larger target (docs/BAREMETAL.md,
// 4.2): per disk the last partition when it carries a PV, an md member, a
// LUKS container or a file system that can grow; per VG the largest LV
// that is not root, not swap and not raw, else root. Marks already set
// are kept.
func setGrowDefaults(l *LinuxLayout) {
	carried := map[BlockRef]bool{}
	for _, pv := range l.LVM.PVs {
		carried[pv.Device] = true
	}
	for _, md := range l.MD {
		for _, m := range md.Members {
			carried[m.Device] = true
		}
	}
	for _, c := range l.LUKS {
		carried[c.Device] = true
	}
	for _, fs := range l.Filesystems {
		if growableFS[fs.Type] {
			for _, d := range fs.Devices {
				carried[d] = true
			}
		}
	}
	for i := range l.Disks {
		t := l.Disks[i].Table
		if t == nil || len(t.Partitions) == 0 {
			continue
		}
		last, marked := -1, false
		for j, p := range t.Partitions {
			if p.Grow != nil {
				marked = true
			}
			if last < 0 || p.StartBytes > t.Partitions[last].StartBytes {
				last = j
			}
		}
		if marked {
			continue
		}
		p := &t.Partitions[last]
		if carried[PartRef(l.Disks[i].ID, p.Number)] {
			p.Grow = boolPtr(true)
		}
	}
	swapLV := map[BlockRef]bool{}
	for _, s := range l.Swap {
		if s.Device != nil {
			swapLV[*s.Device] = true
		}
	}
	for i := range l.LVM.VGs {
		vg := &l.LVM.VGs[i]
		best, root, marked := -1, -1, false
		for j, lv := range vg.LVs {
			if lv.Grow != nil {
				marked = true
			}
			switch lv.Type {
			case "linear", "striped", "thin-pool", "raid0", "raid1", "raid4", "raid5", "raid6", "raid10":
			default:
				continue
			}
			if lv.Raw || swapLV[LVRef(vg.Name, lv.Name)] || lv.Name == "swap" {
				continue
			}
			if lv.Name == "root" {
				root = j
				continue
			}
			if best < 0 || lv.SizeBytes > vg.LVs[best].SizeBytes {
				best = j
			}
		}
		if marked {
			continue
		}
		if best < 0 {
			best = root
		}
		if best >= 0 {
			vg.LVs[best].Grow = boolPtr(true)
		}
	}
}
