package baremetal

import (
	"sort"
	"strings"
)

// mkfs arguments (docs/BAREMETAL.md 10.11) only from recorded values, never
// from the defaults of the mkfs in the ISO: newer versions turn on
// features older kernels and GRUB versions cannot read. Option and value
// are always separate argv entries or one --opt=value entry; manifest text
// never becomes part of another option.
//
// The feature tables are those of the tool versions in Debian trixie
// (e2fsprogs 1.47, xfsprogs 6.x, btrfs-progs 6.x); M4 verifies them against
// the tools of the recovery ISO [CI].

// extFeatures are the ext features mke2fs 1.47 can set with -O.
var extFeatures = map[string]bool{
	"has_journal": true, "ext_attr": true, "resize_inode": true, "dir_index": true, "filetype": true,
	"extent": true, "extents": true, "64bit": true, "flex_bg": true, "sparse_super": true, "sparse_super2": true,
	"large_file": true, "huge_file": true, "dir_nlink": true, "extra_isize": true, "metadata_csum": true,
	"metadata_csum_seed": true, "orphan_file": true, "uninit_bg": true, "quota": true, "project": true,
	"encrypt": true, "casefold": true, "inline_data": true, "mmp": true, "bigalloc": true, "large_dir": true,
	"ea_inode": true, "stable_inodes": true, "verity": true, "meta_bg": true, "fast_commit": true,
	"journal_dev": false,
}

// extRuntime are state flags dumpe2fs lists among the features; they are
// not features to create.
var extRuntime = map[string]bool{"needs_recovery": true, "orphan_present": true, "recover": true}

// xfsKnown are the XFS features the planner sets explicitly.
var xfsKnown = []string{"crc", "finobt", "rmapbt", "reflink", "bigtime", "inobtcount", "sparse", "nrext64", "ftype"}

// btrfsFeatureMap maps the kernel flags of dump-super to mkfs.btrfs -O
// features; btrfsIgnored are flags mkfs sets itself or that are not
// features.
var btrfsFeatureMap = map[string]string{
	"extended_iref": "extref", "skinny_metadata": "skinny-metadata", "no_holes": "no-holes", "raid56": "raid56",
	"raid1c34": "raid1c34", "mixed_groups": "mixed-bg", "zoned": "zoned", "free_space_tree": "free-space-tree",
	"block_group_tree": "block-group-tree", "simple_quota": "squota", "raid_stripe_tree": "raid-stripe-tree",
}

var btrfsIgnored = map[string]bool{"mixed_backref": true, "big_metadata": true, "default_subvol": true,
	"free_space_tree_valid": true, "metadata_uuid": true}

// MkfsArgs returns the argv that creates fs on devs: blockSize is the
// effective logical block size of the device (10.9), sizeBytes its size
// and inodes the inode count for ext (0: derive). The findings are
// problems (unknown feature, type) and warnings (raised sizes).
func MkfsArgs(fs Filesystem, devs []string, blockSize int64, sizeBytes int64, inodes int64) ([]string, []Finding) {
	var out []Finding
	if blockSize < 512 {
		blockSize = 512
	}
	label := func(flag string) []string {
		if fs.Label == nil || *fs.Label == "" {
			return nil
		}
		return []string{flag, *fs.Label}
	}
	switch fs.Type {
	case "ext2", "ext3", "ext4":
		e := fs.Ext
		if e == nil {
			return nil, []Finding{newFinding(ProblemMkfsUnsupportedType, fs.ID, "fs", fs.ID, "type", fs.Type, "reason", "no ext parameters recorded")}
		}
		args := []string{"mkfs.ext4", "-F", "-t", fs.Type}
		if fs.UUID != nil {
			args = append(args, "-U", *fs.UUID)
		}
		args = append(args, label("-L")...)
		bs := max(e.BlockSize, blockSize)
		if bs > e.BlockSize && e.BlockSize > 0 {
			out = append(out, newFinding(WarnExtBlockSizeRaised, fs.ID, "fs", fs.ID, "blockSize", bs, "sourceBlockSize", e.BlockSize))
		}
		args = append(args, "-b", itoa(bs))
		if e.InodeSize > 0 {
			args = append(args, "-I", itoa(e.InodeSize))
		}
		if inodes > 0 {
			args = append(args, "-N", itoa(inodes))
		}
		args = append(args, "-m", itoa(e.ReservedPercent))
		feats := []string{"none"}
		for _, f := range e.Features {
			if extRuntime[f] {
				continue
			}
			if !extFeatures[f] {
				out = append(out, newFinding(ProblemMkfsFeatureUnknown, fs.ID, "fs", fs.ID, "type", fs.Type, "feature", f))
				continue
			}
			feats = append(feats, f)
		}
		args = append(args, "-O", strings.Join(feats, ","))
		if e.FlexBgSize != nil && hasString(e.Features, "flex_bg") {
			args = append(args, "-G", itoa(*e.FlexBgSize))
		}
		if e.JournalBytes != nil && *e.JournalBytes > 0 && hasString(e.Features, "has_journal") {
			args = append(args, "-J", "size="+itoa(max(*e.JournalBytes/mib, 1)))
		}
		return append(args, devs...), out
	case "xfs":
		x := fs.XFS
		if x == nil {
			return nil, []Finding{newFinding(ProblemMkfsUnsupportedType, fs.ID, "fs", fs.ID, "type", fs.Type, "reason", "no XFS parameters recorded")}
		}
		if x.ExternalLog || x.Realtime {
			return nil, []Finding{newFinding(ProblemMkfsUnsupportedType, fs.ID, "fs", fs.ID, "type", fs.Type, "reason", "external log or realtime section")}
		}
		on := map[string]bool{}
		for _, f := range x.Features {
			known := false
			for _, k := range xfsKnown {
				known = known || k == f
			}
			if !known {
				out = append(out, newFinding(ProblemMkfsFeatureUnknown, fs.ID, "fs", fs.ID, "type", fs.Type, "feature", f))
				continue
			}
			on[f] = true
		}
		b := func(name string) string {
			if on[name] {
				return name + "=1"
			}
			return name + "=0"
		}
		meta := "uuid=" + deref(fs.UUID) + "," + strings.Join([]string{b("crc"), b("finobt"), b("rmapbt"), b("reflink"), b("bigtime"), b("inobtcount")}, ",")
		if fs.UUID == nil {
			meta = strings.Join([]string{b("crc"), b("finobt"), b("rmapbt"), b("reflink"), b("bigtime"), b("inobtcount")}, ",")
		}
		isize := "512"
		if !on["crc"] {
			isize = "256"
		}
		args := []string{"mkfs.xfs", "-f", "-m", meta, "-i", "size=" + isize + "," + b("sparse") + "," + b("nrext64"), "-n", b("ftype")}
		bsize := x.BlockSize
		if bsize <= 0 {
			bsize = 4096
		}
		sect := max(x.SectorSize, blockSize)
		if sect > bsize {
			out = append(out, newFinding(ProblemSectorSizeIncompatible, fs.ID, "object", "file system "+fs.ID, "sizes", itoa(blockSize), "fs", fs.ID))
		}
		args = append(args, "-b", "size="+itoa(bsize), "-s", "size="+itoa(sect))
		args = append(args, label("-L")...)
		if x.LogBytes > 0 {
			args = append(args, "-l", "size="+itoa(max(x.LogBytes/1024, 1))+"k")
		}
		return append(args, devs...), out
	case "btrfs":
		bt := fs.Btrfs
		if bt == nil {
			return nil, []Finding{newFinding(ProblemMkfsUnsupportedType, fs.ID, "fs", fs.ID, "type", fs.Type, "reason", "no btrfs parameters recorded")}
		}
		args := []string{"mkfs.btrfs", "-f"}
		if fs.UUID != nil {
			args = append(args, "-U", *fs.UUID)
		}
		args = append(args, label("-L")...)
		if bt.NodeSize > 0 {
			args = append(args, "-n", itoa(bt.NodeSize))
		}
		sect := bt.SectorSize
		if sect <= 0 {
			sect = 4096
		}
		if blockSize > sect {
			out = append(out, newFinding(ProblemSectorSizeIncompatible, fs.ID, "object", "file system "+fs.ID, "sizes", itoa(blockSize), "fs", fs.ID))
		}
		args = append(args, "-s", itoa(sect))
		csum := "crc32c"
		if bt.Csum != nil {
			csum = *bt.Csum
		} else {
			out = append(out, newFinding(WarnBtrfsCsumAssumed, fs.ID, "fs", fs.ID))
		}
		args = append(args, "--csum", csum)
		set := map[string]bool{}
		var feats []string
		for _, f := range bt.Features {
			f = strings.ToLower(f)
			if btrfsIgnored[f] || strings.HasPrefix(f, "compress_") {
				continue
			}
			m, ok := btrfsFeatureMap[f]
			if !ok {
				out = append(out, newFinding(ProblemMkfsFeatureUnknown, fs.ID, "fs", fs.ID, "type", fs.Type, "feature", f))
				continue
			}
			if !set[m] {
				set[m] = true
				feats = append(feats, m)
			}
		}
		sort.Strings(feats)
		// Newer mkfs.btrfs turns these on by default; off when the source had them off.
		for _, def := range []string{"no-holes", "free-space-tree"} {
			if !set[def] {
				feats = append(feats, "^"+def)
			}
		}
		args = append(args, "-O", strings.Join(feats, ","))
		data, metaP := strings.ToLower(bt.DataProfile), strings.ToLower(bt.MetadataProfile)
		if data == "" {
			data = "single"
		}
		if metaP == "" {
			metaP = "dup"
		}
		args = append(args, "-d", data, "-m", metaP)
		return append(args, devs...), out
	case "vfat":
		v := fs.VFAT
		bits, cluster, srcSect := int64(32), int64(8), int64(512)
		volID := strings.ToUpper(strings.ReplaceAll(deref(fs.UUID), "-", ""))
		if v != nil {
			bits, cluster = v.FatBits, v.SectorsPerCluster
			if v.LogicalSectorSize > 0 {
				srcSect = v.LogicalSectorSize
			}
			if v.VolumeID != "" {
				volID = v.VolumeID
			}
		}
		if cluster <= 0 {
			cluster = 8
		}
		spc := max(cluster*srcSect/blockSize, 1)
		if blockSize != srcSect {
			out = append(out, newFinding(WarnVFATSectorSizeChanged, fs.ID, "fs", fs.ID, "sectorSize", blockSize, "sourceSectorSize", srcSect))
		}
		args := []string{"mkfs.vfat", "-F", itoa(bits)}
		if volID != "" {
			args = append(args, "-i", volID)
		}
		args = append(args, label("-n")...)
		args = append(args, "-S", itoa(blockSize), "-s", itoa(spc))
		return append(args, devs...), out
	case "swap":
		args := []string{"mkswap"}
		if fs.UUID != nil {
			args = append(args, "-U", *fs.UUID)
		}
		args = append(args, label("-L")...)
		return append(args, devs...), out
	}
	return nil, []Finding{newFinding(ProblemMkfsUnsupportedType, fs.ID, "fs", fs.ID, "type", fs.Type, "reason", "the type is not supported")}
}

// extInodes is -N for a new ext file system of newSize bytes:
// inodeCount scaled to the new size, at least inodesUsed times 1.2.
func extInodes(e *ExtInfo, oldSize, newSize, inodesUsed int64) int64 {
	if e == nil || e.InodeCount <= 0 {
		return 0
	}
	n := e.InodeCount
	if oldSize > 0 && newSize != oldSize {
		n = mulDiv(e.InodeCount, newSize, oldSize)
	}
	n = max(n, mulDivUp(inodesUsed, 12, 10))
	const extMaxInodes = 1<<32 - 1
	if bs := max(e.BlockSize, 1024); newSize > 0 {
		n = min(n, newSize/bs)
	}
	return max(min(n, extMaxInodes), 16)
}

func hasString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
