package baremetal

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// stackTypes are signatures of the storage stack, not file systems.
var stackTypes = map[string]bool{"": true, "crypto_LUKS": true, "LVM2_member": true, "linux_raid_member": true, "swap": true,
	"isw_raid_member": true, "ddf_raid_member": true, "bcache": true, "drbd": true}

// blkidOf runs `blkid -p -o export <dev>` once per device (low-level probe:
// it reads the device, not the cache).
func (c *capture) blkidOf(dev string) map[string]string {
	kv, _ := c.blkidProbe(dev)
	return kv
}

func (c *capture) blkidProbe(dev string) (map[string]string, error) {
	if v, ok := c.blkid[dev]; ok {
		return v, nil
	}
	out, err := c.r.Run(c.ctx, "blkid", "-p", "-o", "export", dev)
	if err != nil && cmdrun.IsNotFound(err) {
		return map[string]string{}, ErrToolsMissing
	}
	kv := map[string]string{}
	if err == nil || len(out) > 0 {
		kv = sysparse.ParseOSRelease(out)
	}
	c.blkid[dev] = kv
	return kv, nil
}

// typeFromBlkid fills the file system type, UUID and label of a mounted
// node that lsblk reported without a type, from `blkid -p`; when blkid
// does not know it either, the capture says so.
func (c *capture) typeFromBlkid(n *blkNode) error {
	bid, err := c.blkidProbe(n.path())
	if err != nil {
		return err
	}
	t := bid["TYPE"]
	if t == "" {
		c.note(CodeCaptureFailed, n.path(), fmt.Sprintf("%s is mounted at %s, but neither lsblk nor blkid knows its file system; it is not recorded",
			n.path(), strings.Join(n.mountpoints(), ", ")), SeverityWarning)
		return nil
	}
	n.f["fstype"] = t
	for key, tag := range map[string]string{"uuid": "UUID", "label": "LABEL"} {
		if n.str(key) == "" && bid[tag] != "" {
			n.f[key] = bid[tag]
		}
	}
	return nil
}

// captureFilesystems records each file system (btrfs across all its
// devices): blkid, then the mkfs parameters per type (dumpe2fs -h,
// xfs_info, btrfs inspect-internal dump-super, the FAT boot sector).
func captureFilesystems(c *capture) error {
	var errs []string
	fi := 0
	byUUID := map[string]int{}
	for _, n := range c.nodes {
		t := n.fstype()
		if t == "" && !skippedTypes[n.typ()] && len(n.mountpoints()) > 0 {
			// lsblk takes the type from the udev database, which lags behind
			// a file system made a moment ago and is empty without udev. A
			// mounted device has a file system: blkid reads it from the
			// device. Without this the mount stays in the manifest and its
			// file system is missing, without a word.
			if err := c.typeFromBlkid(n); err != nil {
				return err
			}
			t = n.fstype()
		}
		if stackTypes[t] || skippedTypes[n.typ()] {
			continue
		}
		ref, ok := c.refOf(n)
		if !ok {
			continue
		}
		uuid := n.str("uuid")
		if t == "btrfs" && uuid != "" {
			if i, ok := byUUID[uuid]; ok {
				c.l.Filesystems[i].Devices = append(c.l.Filesystems[i].Devices, ref)
				c.fsOfNode[n] = c.l.Filesystems[i].ID
				continue
			}
		}
		if fi >= maxFilesystems {
			break
		}
		bid, err := c.blkidProbe(n.path())
		if err != nil {
			return err
		}
		fs := Filesystem{ID: fmt.Sprintf("f%d", fi), Devices: []BlockRef{ref}, Type: clean(t), UUID: cleanPtr(uuid),
			UUIDSub: cleanPtr(bid["UUID_SUB"]), Label: cleanPtr(n.str("label")), SizeBytes: n.int("fssize"), UsedBytes: n.int("fsused")}
		if fs.UUID == nil {
			fs.UUID = cleanPtr(bid["UUID"])
		}
		if fs.Label == nil {
			fs.Label = cleanPtr(bid["LABEL"])
		}
		if fs.SizeBytes == 0 {
			fs.SizeBytes = n.int("size")
		}
		fi++
		mps := n.mountpoints()
		switch t {
		case "ext2", "ext3", "ext4":
			if err := c.extInfo(n, &fs); err != nil {
				errs = append(errs, err.Error())
			}
		case "xfs":
			target := n.path()
			if len(mps) > 0 {
				target = mps[0]
			}
			if err := c.xfsInfo(target, &fs); err != nil {
				errs = append(errs, err.Error())
			}
		case "btrfs":
			if err := c.btrfsSuper(n, &fs); err != nil {
				errs = append(errs, err.Error())
			}
		case "vfat":
			c.vfatInfo(n, bid, &fs)
		}
		if len(mps) > 0 && fs.InodesUsed == nil && t != "vfat" {
			if st, err := c.h.Statfs(mps[0]); err == nil && st.Files > 0 {
				used := st.Files - st.FilesFree
				fs.InodesUsed = &used
			}
		}
		if uuid != "" {
			byUUID[uuid] = len(c.l.Filesystems)
			if fs.UUID != nil {
				c.fsByUUID[*fs.UUID] = nil
			}
		}
		c.fsOfNode[n] = fs.ID
		c.l.Filesystems = append(c.l.Filesystems, fs)
	}
	for i := range c.l.Filesystems {
		if u := c.l.Filesystems[i].UUID; u != nil {
			c.fsByUUID[*u] = &c.l.Filesystems[i]
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func (c *capture) fsByID(id string) *Filesystem {
	for i := range c.l.Filesystems {
		if c.l.Filesystems[i].ID == id {
			return &c.l.Filesystems[i]
		}
	}
	return nil
}

// parseSize reads dumpe2fs sizes ("64M", "1024k", "128M").
func parseSize(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	mult := int64(1)
	switch s[len(s)-1] {
	case 'k', 'K':
		mult, s = 1<<10, s[:len(s)-1]
	case 'M':
		mult, s = 1<<20, s[:len(s)-1]
	case 'G':
		mult, s = 1<<30, s[:len(s)-1]
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, false
	}
	return n * mult, true
}

func (c *capture) extInfo(n *blkNode, fs *Filesystem) error {
	out, err := c.run("dumpe2fs", "-h", n.path())
	if err != nil && len(out) == 0 {
		return fmt.Errorf("dumpe2fs %s: %v", n.path(), err)
	}
	kv := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	num := func(k string) int64 { x, _ := strconv.ParseInt(kv[k], 10, 64); return x }
	e := &ExtInfo{BlockSize: num("Block size"), InodeSize: num("Inode size"), InodeCount: num("Inode count"), Features: []string{}}
	for _, f := range strings.Fields(kv["Filesystem features"]) {
		e.Features = append(e.Features, clean(f))
	}
	if blocks := num("Block count"); blocks > 0 {
		e.ReservedPercent = (num("Reserved block count")*100 + blocks/2) / blocks
	}
	if v := num("Flex block group size"); v > 0 {
		e.FlexBgSize = &v
	}
	if v, ok := parseSize(kv["Journal size"]); ok {
		e.JournalBytes = &v
	}
	if free := kv["Free inodes"]; free != "" && len(n.mountpoints()) == 0 {
		used := e.InodeCount - num("Free inodes")
		fs.InodesUsed = &used
	}
	fs.Ext = e
	return nil
}

func (c *capture) xfsInfo(target string, fs *Filesystem) error {
	out, err := c.run("xfs_info", target)
	if err != nil {
		return fmt.Errorf("xfs_info %s: %v", target, err)
	}
	x := &XFSInfo{Features: []string{}}
	section := ""
	kv := map[string]map[string]string{}
	var logTarget, rtTarget string
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, "="); i > 0 && strings.TrimSpace(line[:i]) != "" {
			section = strings.TrimSpace(line[:i])
			rest := strings.TrimSpace(line[i+1:])
			switch section {
			case "log":
				logTarget = strings.Fields(rest + " x")[0]
			case "realtime":
				rtTarget = strings.Fields(rest + " x")[0]
			}
		}
		if kv[section] == nil {
			kv[section] = map[string]string{}
		}
		for _, f := range strings.Fields(strings.NewReplacer(",", " ").Replace(line)) {
			if k, v, ok := strings.Cut(f, "="); ok && k != "" && v != "" {
				if _, dup := kv[section][k]; !dup {
					kv[section][k] = v
				}
			}
		}
	}
	num := func(sec, k string) int64 { n, _ := strconv.ParseInt(kv[sec][k], 10, 64); return n }
	x.BlockSize = num("data", "bsize")
	x.SectorSize = num("meta-data", "sectsz")
	x.AGCount = num("meta-data", "agcount")
	for _, feat := range []string{"crc", "finobt", "reflink", "rmapbt", "bigtime", "inobtcount", "sparse", "nrext64"} {
		if kv["meta-data"][feat] == "1" {
			x.Features = append(x.Features, feat)
		}
	}
	if kv["naming"]["ftype"] == "1" {
		x.Features = append(x.Features, "ftype")
	}
	x.LogBytes = num("log", "blocks") * num("log", "bsize")
	x.ExternalLog = logTarget != "" && logTarget != "internal"
	x.Realtime = rtTarget != "" && rtTarget != "none"
	fs.XFS = x
	return nil
}

func (c *capture) btrfsSuper(n *blkNode, fs *Filesystem) error {
	out, err := c.run("btrfs", "inspect-internal", "dump-super", n.path())
	if err != nil {
		return fmt.Errorf("btrfs dump-super %s: %v", n.path(), err)
	}
	b := &BtrfsInfo{Features: []string{}, Subvolumes: []Subvolume{}, NoCowDirs: []string{}, DefaultSubvolume: SubvolRef{ID: 5, Path: ""}}
	inFlags := false
	for _, line := range strings.Split(string(out), "\n") {
		t := strings.TrimSpace(line)
		f := strings.Fields(t)
		if len(f) >= 2 {
			switch f[0] {
			case "nodesize":
				b.NodeSize, _ = strconv.ParseInt(f[1], 10, 64)
			case "sectorsize":
				b.SectorSize, _ = strconv.ParseInt(f[1], 10, 64)
			case "csum_type":
				// "csum_type		0 (crc32c)"
				if len(f) >= 3 {
					name := strings.Trim(f[2], "()")
					if oneOf(name, "crc32c", "xxhash", "sha256", "blake2") {
						b.Csum = strPtr(name)
					}
				}
			case "incompat_flags", "compat_ro_flags":
				inFlags = true
				continue
			}
		}
		if inFlags {
			if !strings.HasPrefix(t, "(") && !strings.HasSuffix(t, "|") && !strings.HasSuffix(t, ")") {
				inFlags = false
				continue
			}
			for _, w := range strings.FieldsFunc(t, func(r rune) bool { return r == '(' || r == ')' || r == '|' || r == ' ' }) {
				b.Features = append(b.Features, strings.ToLower(clean(w)))
			}
			if strings.HasSuffix(t, ")") {
				inFlags = false
			}
		}
	}
	fs.Btrfs = b
	return nil
}

// vfatInfo reads the FAT boot sector: bytes per sector (11), sectors per
// cluster (13); FAT size from blkid.
func (c *capture) vfatInfo(n *blkNode, bid map[string]string, fs *Filesystem) {
	v := &VFATInfo{VolumeID: strings.ToUpper(strings.ReplaceAll(deref(fs.UUID), "-", ""))}
	switch strings.ToUpper(bid["VERSION"]) {
	case "FAT12":
		v.FatBits = 12
	case "FAT16":
		v.FatBits = 16
	default:
		v.FatBits = 32
	}
	if f, _, err := c.h.Open("/dev/" + n.kname()); err == nil {
		buf := make([]byte, 64)
		if _, err := f.ReadAt(buf, 0); err == nil {
			v.LogicalSectorSize = int64(buf[11]) | int64(buf[12])<<8
			v.SectorsPerCluster = int64(buf[13])
		}
		f.Close()
	}
	fs.VFAT = v
}
