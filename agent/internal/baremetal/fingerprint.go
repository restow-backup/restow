package baremetal

import (
	"errors"
	"sort"
	"strconv"
	"strings"
)

// LayoutFingerprint is the fingerprint of the restorable structure of a
// Linux layout (contract C1; docs/BAREMETAL.md, 12.4): the hex SHA-256 of
// the canonical JSON of a projection that leaves out what changes between
// backups of the same machine (sizes in use, free space, time stamps). The
// TypeScript layoutFingerprint computes the same value; the shared test
// data hold it as <name>.fingerprint. Darwin follows in M6.
func LayoutFingerprint(m *Manifest) (string, error) {
	if m.Platform != PlatformLinux || m.Linux == nil {
		return "", errors.New("layout fingerprint: only Linux layouts in this version")
	}
	l := m.Linux
	type obj = map[string]any
	lower := strings.ToLower

	disks := append([]Disk(nil), l.Disks...)
	sort.SliceStable(disks, func(i, j int) bool { return disks[i].ID < disks[j].ID })
	dl := []any{}
	for _, d := range disks {
		var table, tableID any
		parts := []any{}
		if d.Table != nil {
			table, tableID = d.Table.Type, lower(d.Table.ID)
			ps := append([]Partition(nil), d.Table.Partitions...)
			sort.SliceStable(ps, func(i, j int) bool { return ps[i].Number < ps[j].Number })
			for _, p := range ps {
				parts = append(parts, obj{"n": p.Number, "type": lower(p.Type), "uuid": lower(deref(p.UUID)), "size": p.SizeBytes})
			}
		}
		dl = append(dl, obj{"id": d.ID, "table": table, "tableId": tableID, "parts": parts})
	}

	mds := append([]MDArray(nil), l.MD...)
	sort.SliceStable(mds, func(i, j int) bool { return mds[i].UUID < mds[j].UUID })
	ml := []any{}
	for _, md := range mds {
		ml = append(ml, obj{"uuid": md.UUID, "level": md.Level, "metadata": md.Metadata, "devices": md.RaidDevices})
	}

	lks := append([]LUKSVolume(nil), l.LUKS...)
	sort.SliceStable(lks, func(i, j int) bool { return lks[i].UUID < lks[j].UUID })
	ll := []any{}
	for _, c := range lks {
		ll = append(ll, obj{"uuid": c.UUID, "version": c.Version, "cipher": c.Cipher, "keyBits": c.KeyBits, "sectorSize": c.SectorSize})
	}

	pcs := append([]PlainCrypt(nil), l.PlainCrypt...)
	sort.SliceStable(pcs, func(i, j int) bool { return pcs[i].MappedName < pcs[j].MappedName })
	pl := []any{}
	for _, c := range pcs {
		pl = append(pl, obj{"name": c.MappedName, "cipher": c.Cipher, "keyBits": c.KeyBits, "purpose": c.Purpose})
	}

	vgs := append([]VolumeGroup(nil), l.LVM.VGs...)
	sort.SliceStable(vgs, func(i, j int) bool { return vgs[i].Name < vgs[j].Name })
	vl := []any{}
	for _, vg := range vgs {
		lvs := append([]LogicalVolume(nil), vg.LVs...)
		sort.SliceStable(lvs, func(i, j int) bool { return lvs[i].Name < lvs[j].Name })
		lvl := []any{}
		for _, lv := range lvs {
			lvl = append(lvl, obj{"name": lv.Name, "type": lv.Type, "size": lv.SizeBytes, "pool": optString(lv.Pool)})
		}
		vl = append(vl, obj{"name": vg.Name, "lvs": lvl})
	}

	fss := append([]Filesystem(nil), l.Filesystems...)
	sort.SliceStable(fss, func(i, j int) bool {
		a, b := deref(fss[i].UUID), deref(fss[j].UUID)
		if a != b {
			return a < b
		}
		return fss[i].ID < fss[j].ID
	})
	fl := []any{}
	fsUUID := map[string]any{}
	type subv struct {
		fs, path string
		fsv      any
	}
	var subs []subv
	for _, fs := range fss {
		features := []string{}
		if fs.Ext != nil {
			features = append(features, fs.Ext.Features...)
		}
		if fs.XFS != nil {
			features = append(features, fs.XFS.Features...)
		}
		if fs.Btrfs != nil {
			features = append(features, fs.Btrfs.Features...)
		}
		if fs.VFAT != nil {
			features = append(features, "fat"+strconv.FormatInt(fs.VFAT.FatBits, 10))
		}
		sort.Strings(features)
		fa := make([]any, len(features))
		for i, f := range features {
			fa[i] = f
		}
		fl = append(fl, obj{"type": fs.Type, "uuid": optString(fs.UUID), "label": optString(fs.Label), "features": fa})
	}
	for _, fs := range l.Filesystems {
		fsUUID[fs.ID] = optString(fs.UUID)
		if fs.Btrfs == nil {
			continue
		}
		for _, s := range fs.Btrfs.Subvolumes {
			if s.Kind == SubvolNormal || s.Kind == SubvolMachines {
				subs = append(subs, subv{fs: deref(fs.UUID), path: s.Path, fsv: optString(fs.UUID)})
			}
		}
	}
	sort.SliceStable(subs, func(i, j int) bool {
		if subs[i].fs != subs[j].fs {
			return subs[i].fs < subs[j].fs
		}
		return subs[i].path < subs[j].path
	})
	sl := []any{}
	for _, s := range subs {
		sl = append(sl, obj{"fs": s.fsv, "path": s.path})
	}

	mounts := append([]Mount(nil), l.Mounts...)
	sort.SliceStable(mounts, func(i, j int) bool { return mounts[i].Target < mounts[j].Target })
	mnt := []any{}
	for _, mo := range mounts {
		var fs any
		if mo.FS != nil {
			fs = fsUUID[*mo.FS]
		}
		mnt = append(mnt, obj{"target": mo.Target, "fs": fs})
	}

	ft := []any{}
	for _, e := range l.Fstab {
		ft = append(ft, obj{"source": e.Source, "target": e.Target, "type": e.Type, "options": e.Options})
	}

	proj := obj{
		"v": 1, "platform": PlatformLinux, "firmware": l.Firmware.Mode,
		"disks": dl, "md": ml, "luks": ll, "plain": pl, "vgs": vl, "fs": fl, "subvols": sl,
		"mounts": mnt, "fstab": ft,
		"bootloader": l.Bootloader.Kind, "initramfs": optString(l.Initramfs.Generator),
		"keymap": deref(l.Initramfs.Keymap.Layout) + ":" + deref(l.Initramfs.Keymap.Variant),
	}
	b, err := Canonical(proj)
	if err != nil {
		return "", err
	}
	return sha256Hex(b), nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func optString(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
