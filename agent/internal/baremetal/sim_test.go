package baremetal

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// The capture fixtures in testdata/capture are synthetic (docs/BAREMETAL.md
// 21.1 and 27.1: recordings of real systems replace them). A simMachine
// describes a system compactly and answers the tool calls of the
// collectors in the documented output formats of the tools; a recording of
// those answers (cmd/NN.cmd, .out, .err, .exit) plus the file tree (root/)
// is what the capture test replays with cmdrun.FakeRunner and DirHost,
// exactly as it would replay a recording of a real machine.

type simMount struct {
	Target, Root, Opts string
	SubvolID           int64
}

type simExt struct {
	BlockSize, InodeSize, InodeCount, FreeInodes, BlockCount, Reserved, Flex int64
	Features, Journal                                                        string
}

type simXFS struct {
	ISize, AGCount, SectSz, BSize, LogBlocks int64
	CRC, Finobt, Sparse, Rmapbt, Reflink     int
	Bigtime, Inobtcount, Ftype               int
	Nrext64                                  int
	Log, Realtime                            string
}

type simNode struct {
	KName, Name, Type          string
	Size                       int64
	MajMin                     string
	FSType, FSVer, UUID, Label string
	PartUUID, PartType         string
	PartLabel, PartFlags       string
	PartStart                  int64
	Bootable                   bool
	Model, Serial, Tran, WWN   string
	Rota, RM, RO               bool
	LogSec, PhySec             int64
	PTType, PTUUID             string
	FSUsed, FSSize             int64
	Mounts                     []simMount
	Children                   []*simNode
	Blkid                      map[string]string
	Ext                        *simExt
	XFS                        *simXFS
	// Disk only: sysfs device path and the drivers on the way to the root.
	DevPath string
	Drivers []simDriver
	// NVMe identifiers.
	EUI, NGUID, NSID string
	BootCode         string // grub, none, other
	PMBR             bool
	// VFAT boot sector values.
	SecPerClus int
}

type simDriver struct{ Dir, Driver, Modalias string }

type simMD struct {
	KName, UUID, Level, Metadata, Name string
	Devices                            int
	Members                            []simMDMember
	Chunk                              int64
	Layout, Bitmap, ArrayState         string
	Degraded                           int
	SyncAction, Policy                 string
}

type simMDMember struct{ Dev, Role, State string }

type simLV struct {
	Name, UUID, Attr, Layout, SegType string
	Size                              int64
	Pool, Origin, Tags                string
	DataPct, MetaPct, SnapPct         string
	Major, Minor                      int
	Stripes, StripeSize, Chunk, Meta  int64
}

type simPV struct {
	Name, UUID string
	Size       int64
}

type simVG struct {
	Name, UUID, SystemID string
	Size, Free, Extent   int64
	PVs                  []simPV
	LVs                  []simLV
}

type simLVM struct {
	VGs                  []simVG
	UseDevicesFile       bool
	Filter, GlobalFilter string
	DevicesFile          string
	OrphanPVs            []simPV
}

type simSubvol struct {
	ID, Parent, TopLevel int64
	Path, UUID, PUUID    string
	RO                   bool
}

type simBtrfs struct {
	Subvols            []simSubvol
	Default            int64
	Quota              bool
	Data, Meta, System string
	NodeSize           int64
	Features           []string
	Used, Size         int64
	NoCow              []string
	Csum               string // crc32c when empty
}

type simBootEntry struct {
	Num      uint16
	Label    string
	PartUUID string
	PartNum  uint32
	Path     string
	Active   bool
}

type simAnswer struct {
	Out, Err string
	Exit     int
}

type simMachine struct {
	Name, Source string
	Hostname     string
	OSRelease    string
	Kernel       string
	Cmdline      string
	Arch         string
	NoSystemd    bool
	Container    bool
	UEFI         bool
	SecureBoot   *bool
	SetupMode    *bool
	BootEntries  []simBootEntry
	BootOrder    []uint16
	BootCurrent  *uint16
	Sbat         string
	DB           []testSigner
	DBX          [][]byte
	MOK          []testSigner
	Disks        []*simNode
	MD           []simMD
	LVM          *simLVM
	LUKS         map[string]string
	DMCrypt      string
	Btrfs        map[string]*simBtrfs
	Swaps        string
	Files        map[string]string
	Bin          map[string][]byte
	Links        map[string]string
	Statfs       map[string]Statfs
	Extra        map[string]simAnswer
	Interfaces   []simNet
}

type simNet struct {
	Name, MAC, DevDir, Driver, Modalias string
}

func (s *simMachine) all() []*simNode {
	var out []*simNode
	seen := map[*simNode]bool{}
	var walk func(n *simNode)
	walk = func(n *simNode) {
		if seen[n] {
			return
		}
		seen[n] = true
		out = append(out, n)
		for _, ch := range n.Children {
			walk(ch)
		}
	}
	for _, d := range s.Disks {
		walk(d)
	}
	return out
}

func (n *simNode) path() string {
	switch n.Type {
	case "crypt", "lvm", "dm", "mpath":
		return "/dev/mapper/" + n.name()
	}
	return "/dev/" + n.KName
}

func (n *simNode) name() string {
	if n.Name != "" {
		return n.Name
	}
	return n.KName
}

func (s *simMachine) byPath(p string) *simNode {
	for _, n := range s.all() {
		if n.path() == p || "/dev/"+n.KName == p {
			return n
		}
	}
	return nil
}

func (s *simMachine) byMount(target string) *simNode {
	for _, n := range s.all() {
		for _, m := range n.Mounts {
			if m.Target == target {
				return n
			}
		}
	}
	return nil
}

func (s *simMachine) lsblk() string {
	var conv func(n *simNode, parent *simNode) map[string]any
	conv = func(n *simNode, parent *simNode) map[string]any {
		var mps []any
		for _, m := range n.Mounts {
			mps = append(mps, m.Target)
		}
		if len(mps) == 0 {
			mps = []any{nil}
		}
		str := func(v string) any {
			if v == "" {
				return nil
			}
			return v
		}
		num := func(v int64) any {
			if v == 0 {
				return nil
			}
			return v
		}
		m := map[string]any{
			"name": n.name(), "kname": n.KName, "path": n.path(), "maj:min": n.MajMin, "fstype": str(n.FSType), "fsver": str(n.FSVer),
			"label": str(n.Label), "uuid": str(n.UUID), "ptuuid": str(n.PTUUID), "pttype": str(n.PTType), "parttype": str(n.PartType),
			"partlabel": str(n.PartLabel), "partuuid": str(n.PartUUID), "partflags": str(n.PartFlags), "ro": n.RO, "rm": n.RM,
			"model": str(n.Model), "serial": str(n.Serial), "size": n.Size, "log-sec": n.LogSec, "phy-sec": n.PhySec, "rota": n.Rota,
			"type": n.Type, "wwn": str(n.WWN), "tran": str(n.Tran), "zoned": "none", "mountpoints": mps,
			"fssize": num(n.FSSize), "fsused": num(n.FSUsed),
		}
		if parent != nil {
			m["pkname"] = parent.KName
		} else {
			m["pkname"] = nil
		}
		if len(n.Children) > 0 {
			var kids []any
			for _, ch := range n.Children {
				kids = append(kids, conv(ch, n))
			}
			m["children"] = kids
		}
		return m
	}
	var devs []any
	for _, d := range s.Disks {
		devs = append(devs, conv(d, nil))
	}
	b, _ := json.MarshalIndent(map[string]any{"blockdevices": devs}, "", "   ")
	return string(b) + "\n"
}

func (s *simMachine) sfdiskJSON(d *simNode) string {
	sec := d.LogSec
	type part struct {
		Node     string `json:"node"`
		Start    int64  `json:"start"`
		Size     int64  `json:"size"`
		Type     string `json:"type"`
		UUID     string `json:"uuid,omitempty"`
		Name     string `json:"name,omitempty"`
		Attrs    string `json:"attrs,omitempty"`
		Bootable bool   `json:"bootable,omitempty"`
	}
	t := map[string]any{"label": d.PTType, "id": d.PTUUID, "device": d.path(), "unit": "sectors", "sectorsize": sec}
	if d.PTType == "gpt" {
		t["firstlba"] = 2048
		t["lastlba"] = d.Size/sec - 34
	}
	var parts []part
	for _, p := range d.Children {
		if p.Type != "part" {
			continue
		}
		pp := part{Node: p.path(), Start: p.PartStart, Size: p.Size / sec, Type: p.PartType, Attrs: p.PartFlags, Bootable: p.Bootable}
		if d.PTType == "gpt" {
			pp.UUID, pp.Name = p.PartUUID, p.PartLabel
		}
		parts = append(parts, pp)
	}
	t["partitions"] = parts
	b, _ := json.MarshalIndent(map[string]any{"partitiontable": t}, "", "   ")
	return string(b) + "\n"
}

func (s *simMachine) sfdiskDump(d *simNode) string {
	var b strings.Builder
	fmt.Fprintf(&b, "label: %s\nlabel-id: %s\ndevice: %s\nunit: sectors\n", d.PTType, d.PTUUID, d.path())
	if d.PTType == "gpt" {
		fmt.Fprintf(&b, "first-lba: 2048\nlast-lba: %d\ntable-length: 128\n", d.Size/d.LogSec-34)
	}
	fmt.Fprintf(&b, "sector-size: %d\n\n", d.LogSec)
	for _, p := range d.Children {
		if p.Type != "part" {
			continue
		}
		fmt.Fprintf(&b, "%s : start=%12d, size=%12d, type=%s", p.path(), p.PartStart, p.Size/d.LogSec, p.PartType)
		if d.PTType == "gpt" && p.PartUUID != "" {
			fmt.Fprintf(&b, ", uuid=%s", p.PartUUID)
		}
		if p.PartLabel != "" {
			fmt.Fprintf(&b, ", name=%q", p.PartLabel)
		}
		if p.Bootable {
			b.WriteString(", bootable")
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (s *simMachine) blkid(n *simNode) simAnswer {
	if n.FSType == "" {
		return simAnswer{Exit: 2}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "DEVNAME=%s\n", n.path())
	if n.Label != "" {
		fmt.Fprintf(&b, "LABEL=%s\n", n.Label)
	}
	if n.UUID != "" {
		fmt.Fprintf(&b, "UUID=%s\n", n.UUID)
	}
	keys := make([]string, 0, len(n.Blkid))
	for k := range n.Blkid {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%s\n", k, n.Blkid[k])
	}
	if n.FSVer != "" {
		fmt.Fprintf(&b, "VERSION=%s\n", n.FSVer)
	}
	fmt.Fprintf(&b, "TYPE=%s\nUSAGE=%s\n", n.FSType, map[bool]string{true: "crypto", false: "filesystem"}[n.FSType == "crypto_LUKS"])
	return simAnswer{Out: b.String()}
}

func (s *simMachine) mdExport(md simMD) string {
	var b strings.Builder
	fmt.Fprintf(&b, "MD_LEVEL=%s\nMD_DEVICES=%d\nMD_METADATA=%s\nMD_UUID=%s\nMD_DEVNAME=%s\n", md.Level, md.Devices, md.Metadata, md.UUID, strings.TrimPrefix(md.KName, "md"))
	if md.Name != "" {
		fmt.Fprintf(&b, "MD_NAME=%s\n", md.Name)
	}
	for _, m := range md.Members {
		k := strings.ReplaceAll(strings.TrimPrefix(m.Dev, "/"), "/", "_")
		fmt.Fprintf(&b, "MD_DEVICE_%s_ROLE=%s\nMD_DEVICE_%s_DEV=%s\n", k, m.Role, k, m.Dev)
	}
	return b.String()
}

func (s *simMachine) lvmReport() string {
	type obj = map[string]any
	var report []any
	pvRow := func(pv simPV, vg string) obj {
		return obj{"pv_fmt": "lvm2", "pv_uuid": pv.UUID, "dev_size": strconv.FormatInt(pv.Size+4194304, 10), "pv_name": pv.Name,
			"pv_size": strconv.FormatInt(pv.Size, 10), "vg_name": vg}
	}
	for _, vg := range s.LVM.VGs {
		var pvs, lvs, segs []any
		for _, pv := range vg.PVs {
			pvs = append(pvs, pvRow(pv, vg.Name))
		}
		for _, lv := range vg.LVs {
			attr := lv.Attr
			if attr == "" {
				attr = "-wi-ao----"
			}
			active := "active"
			if len(attr) > 4 && attr[4] != 'a' {
				active = ""
			}
			lvs = append(lvs, obj{"lv_uuid": lv.UUID, "lv_name": lv.Name, "lv_full_name": vg.Name + "/" + lv.Name, "lv_layout": lv.Layout,
				"lv_attr": attr, "lv_size": strconv.FormatInt(lv.Size, 10), "pool_lv": lv.Pool, "origin": lv.Origin,
				"data_percent": lv.DataPct, "metadata_percent": lv.MetaPct, "snap_percent": lv.SnapPct, "lv_tags": lv.Tags,
				"lv_active": active, "lv_kernel_major": strconv.Itoa(lv.Major), "lv_kernel_minor": strconv.Itoa(lv.Minor),
				"lv_metadata_size": map[bool]string{true: strconv.FormatInt(lv.Meta, 10), false: ""}[lv.Meta > 0]})
			st := lv.SegType
			if st == "" {
				st = "linear"
			}
			stripes := lv.Stripes
			if stripes == 0 {
				stripes = 1
			}
			segs = append(segs, obj{"lv_uuid": lv.UUID, "segtype": st, "stripes": strconv.FormatInt(stripes, 10),
				"stripe_size": strconv.FormatInt(lv.StripeSize, 10), "chunk_size": strconv.FormatInt(lv.Chunk, 10)})
		}
		report = append(report, obj{
			"vg": []any{obj{"vg_fmt": "lvm2", "vg_uuid": vg.UUID, "vg_name": vg.Name, "vg_attr": "wz--n-", "vg_size": strconv.FormatInt(vg.Size, 10),
				"vg_free": strconv.FormatInt(vg.Free, 10), "vg_systemid": vg.SystemID, "vg_extent_size": strconv.FormatInt(vg.Extent, 10)}},
			"pv": pvs, "lv": lvs, "pvseg": []any{}, "seg": segs})
	}
	if len(s.LVM.OrphanPVs) > 0 {
		var pvs []any
		for _, pv := range s.LVM.OrphanPVs {
			pvs = append(pvs, pvRow(pv, ""))
		}
		report = append(report, obj{"vg": []any{}, "pv": pvs, "lv": []any{}, "pvseg": []any{}, "seg": []any{}})
	}
	b, _ := json.MarshalIndent(obj{"report": report}, "  ", "    ")
	return "  " + string(b) + "\n"
}

func (s *simMachine) dumpe2fs(n *simNode) string {
	e := n.Ext
	var b strings.Builder
	fmt.Fprintf(&b, "dumpe2fs 1.47.0 (5-Feb-2023)\nFilesystem volume name:   %s\n", map[bool]string{true: "<none>", false: n.Label}[n.Label == ""])
	fmt.Fprintf(&b, "Filesystem UUID:          %s\nFilesystem magic number:  0xEF53\nFilesystem features:      %s\n", n.UUID, e.Features)
	fmt.Fprintf(&b, "Inode count:              %d\nBlock count:              %d\nReserved block count:     %d\n", e.InodeCount, e.BlockCount, e.Reserved)
	fmt.Fprintf(&b, "Free inodes:              %d\nBlock size:               %d\n", e.FreeInodes, e.BlockSize)
	if e.Flex > 0 {
		fmt.Fprintf(&b, "Flex block group size:    %d\n", e.Flex)
	}
	fmt.Fprintf(&b, "Inode size:\t          %d\n", e.InodeSize)
	if e.Journal != "" {
		fmt.Fprintf(&b, "Journal features:         journal_incompat_revoke journal_64bit journal_checksum_v3\nTotal journal size:       %s\nJournal size:             %s\n", e.Journal, e.Journal)
	}
	return b.String()
}

func (s *simMachine) xfsInfo(n *simNode) string {
	x := n.XFS
	log := x.Log
	if log == "" {
		log = "internal log"
	}
	rt := x.Realtime
	if rt == "" {
		rt = "none"
	}
	return fmt.Sprintf(`meta-data=%-22s isize=%-6d agcount=%d, agsize=24413696 blks
         =                       sectsz=%-5d attr=2, projid32bit=1
         =                       crc=%-8d finobt=%d, sparse=%d, rmapbt=%d
         =                       reflink=%-4d bigtime=%d inobtcount=%d, nrext64=%d
data     =                       bsize=%-6d blocks=%d, imaxpct=25
         =                       sunit=0      swidth=0 blks
naming   =version 2              bsize=4096   ascii-ci=0, ftype=%d
log      =%-22s bsize=%-6d blocks=%d, version=2
         =                       sectsz=%-5d sunit=0 blks, lazy-count=1
realtime =%-22s extsz=4096   blocks=0, rtextents=0
`, n.path(), x.ISize, x.AGCount, x.SectSz, x.CRC, x.Finobt, x.Sparse, x.Rmapbt, x.Reflink, x.Bigtime, x.Inobtcount, x.Nrext64,
		x.BSize, n.Size/x.BSize, x.Ftype, log, x.BSize, x.LogBlocks, x.SectSz, rt)
}

func (s *simMachine) btrfsOf(target string) (*simNode, *simBtrfs) {
	n := s.byMount(target)
	if n == nil {
		n = s.byPath(target)
	}
	if n == nil || n.FSType != "btrfs" {
		return nil, nil
	}
	return n, s.Btrfs[n.UUID]
}

func (s *simMachine) dumpSuper(n *simNode, b *simBtrfs) string {
	var out strings.Builder
	fmt.Fprintf(&out, "superblock: bytenr=65536, device=%s\n---------------------------------------------------------\n", n.path())
	csum := b.Csum
	if csum == "" {
		csum = "crc32c"
	}
	csumNum := map[string]int{"crc32c": 0, "xxhash": 1, "sha256": 2, "blake2": 3}[csum]
	fmt.Fprintf(&out, "csum_type\t\t%d (%s)\nfsid\t\t\t%s\nlabel\t\t\t%s\nnodesize\t\t%d\nsectorsize\t\t4096\n", csumNum, csum, n.UUID, n.Label, b.NodeSize)
	var inc, ro []string
	for _, f := range b.Features {
		if strings.HasPrefix(f, "free_space_tree") || f == "block_group_tree" {
			ro = append(ro, strings.ToUpper(f))
		} else {
			inc = append(inc, strings.ToUpper(f))
		}
	}
	flags := func(name string, list []string) {
		fmt.Fprintf(&out, "%s\t\t0x%x\n", name, len(list))
		for i, f := range list {
			prefix := "\t\t\t  "
			if i == 0 {
				prefix = "\t\t\t( "
			}
			suffix := " |"
			if i == len(list)-1 {
				suffix = " )"
			}
			fmt.Fprintf(&out, "%s%s%s\n", prefix, f, suffix)
		}
	}
	flags("compat_flags", nil)
	flags("compat_ro_flags", ro)
	flags("incompat_flags", inc)
	fmt.Fprintf(&out, "cache_generation\t0\nuuid_tree_generation\t2344\ndev_item.uuid\t\t%s\n", n.Blkid["UUID_SUB"])
	return out.String()
}

func (s *simMachine) btrfsUsage(b *simBtrfs) string {
	return fmt.Sprintf(`Overall:
    Device size:		%20d
    Device allocated:		%20d
    Device unallocated:		%20d
    Device missing:		%20d
    Device slack:		%20d
    Used:			%20d
    Free (estimated):		%20d	(min: %d)
    Free (statfs, df):		%20d
    Data ratio:			                1.00
    Metadata ratio:		                2.00
    Global reserve:		            26476544	(used: 0)
    Multiple profiles:		                  no

Data,%s: Size:%d, Used:%d (50.00%%)

Metadata,%s: Size:1073741824, Used:310378496 (28.91%%)

System,%s: Size:8388608, Used:16384 (0.20%%)
`, b.Size, b.Used+1<<30, b.Size-b.Used-1<<30, 0, 0, b.Used, b.Size-b.Used, (b.Size-b.Used)/2, b.Size-b.Used,
		prof(b.Data), b.Used*2, b.Used, prof(b.Meta), prof(b.System))
}

func prof(p string) string {
	if p == "single" {
		return p
	}
	return strings.ToUpper(p)
}

func (s *simMachine) subvolList(b *simBtrfs, full, roOnly bool) string {
	var out strings.Builder
	for _, sv := range b.Subvols {
		if roOnly && !sv.RO {
			continue
		}
		if full {
			pu := sv.PUUID
			if pu == "" {
				pu = "-"
			}
			fmt.Fprintf(&out, "ID %d gen %d parent %d top level %d parent_uuid %-36s uuid %s path <FS_TREE>/%s\n", sv.ID, 1000+sv.ID, sv.Parent, sv.TopLevel, pu, sv.UUID, sv.Path)
		} else {
			fmt.Fprintf(&out, "ID %d gen %d top level %d path <FS_TREE>/%s\n", sv.ID, 1000+sv.ID, sv.TopLevel, sv.Path)
		}
	}
	return out.String()
}

// Run answers a tool call.
func (s *simMachine) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	a := s.answer(append([]string{name}, args...))
	if a.Exit == 127 {
		return nil, fmt.Errorf("%s: %w", name, cmdrun.ErrNotFound)
	}
	if a.Exit != 0 {
		return []byte(a.Out), &cmdrun.ExitError{Argv: append([]string{name}, args...), Code: a.Exit, Stderr: a.Err}
	}
	return []byte(a.Out), nil
}

func (s *simMachine) answer(argv []string) simAnswer {
	key := strings.Join(argv, " ")
	if a, ok := s.Extra[key]; ok {
		return a
	}
	last := argv[len(argv)-1]
	switch {
	case key == "lsblk -J -b -O":
		return simAnswer{Out: s.lsblk()}
	case len(argv) == 3 && argv[0] == "sfdisk":
		d := s.byPath(last)
		if d == nil || d.PTType == "" {
			return simAnswer{Exit: 1, Err: "sfdisk: " + last + ": does not contain a recognized partition table"}
		}
		if argv[1] == "--json" {
			return simAnswer{Out: s.sfdiskJSON(d)}
		}
		return simAnswer{Out: s.sfdiskDump(d)}
	case argv[0] == "blkid" && len(argv) == 5:
		if n := s.byPath(last); n != nil {
			return s.blkid(n)
		}
		return simAnswer{Exit: 2}
	case argv[0] == "mdadm":
		for _, md := range s.MD {
			if "/dev/"+md.KName != last {
				continue
			}
			if argv[2] == "--export" {
				return simAnswer{Out: s.mdExport(md)}
			}
			return simAnswer{Out: fmt.Sprintf("%s:\n           Version : %s\n        Raid Level : %s\n      Raid Devices : %d\n             State : %s\n              UUID : %s\n", last, md.Metadata, md.Level, md.Devices, md.ArrayState, md.UUID)}
		}
	case argv[0] == "lvm" && argv[1] == "fullreport" && s.LVM != nil:
		return simAnswer{Out: s.lvmReport()}
	case argv[0] == "lvmconfig" && s.LVM != nil:
		uf := 0
		if s.LVM.UseDevicesFile {
			uf = 1
		}
		filter, gf := s.LVM.Filter, s.LVM.GlobalFilter
		if filter == "" {
			filter = `"a|.*|"`
		}
		if gf == "" {
			gf = `"a|.*|"`
		}
		return simAnswer{Out: fmt.Sprintf("use_devicesfile=%d\nfilter=%s\nglobal_filter=%s\nallow_mixed_block_sizes=0\n", uf, filter, gf)}
	case argv[0] == "cryptsetup":
		if out, ok := s.LUKS[last]; ok {
			return simAnswer{Out: out}
		}
		return simAnswer{Exit: 1, Err: "Device " + last + " is not a valid LUKS device."}
	case key == "dmsetup table --target crypt":
		return simAnswer{Out: s.DMCrypt}
	case argv[0] == "dumpe2fs":
		if n := s.byPath(last); n != nil && n.Ext != nil {
			return simAnswer{Out: s.dumpe2fs(n)}
		}
	case argv[0] == "xfs_info":
		n := s.byMount(last)
		if n == nil {
			n = s.byPath(last)
		}
		if n != nil && n.XFS != nil {
			return simAnswer{Out: s.xfsInfo(n)}
		}
	case argv[0] == "btrfs":
		n, b := s.btrfsOf(last)
		if b == nil {
			return simAnswer{Exit: 1, Err: "ERROR: not a btrfs filesystem: " + last}
		}
		switch strings.Join(argv[1:len(argv)-1], " ") {
		case "inspect-internal dump-super":
			return simAnswer{Out: s.dumpSuper(n, b)}
		case "filesystem usage --raw":
			return simAnswer{Out: s.btrfsUsage(b)}
		case "subvolume list -a -p -u -q":
			return simAnswer{Out: s.subvolList(b, true, false)}
		case "subvolume list -a -r":
			return simAnswer{Out: s.subvolList(b, false, true)}
		case "subvolume get-default":
			for _, sv := range b.Subvols {
				if sv.ID == b.Default {
					return simAnswer{Out: fmt.Sprintf("ID %d gen %d top level %d path %s\n", sv.ID, 1000+sv.ID, sv.TopLevel, sv.Path)}
				}
			}
			return simAnswer{Out: "ID 5 (FS_TREE)\n"}
		case "qgroup show":
			if b.Quota {
				return simAnswer{Out: "Qgroupid    Referenced    Exclusive   Path \n--------    ----------    ---------   ---- \n0/5           16.00KiB     16.00KiB   <toplevel>\n"}
			}
			return simAnswer{Exit: 1, Err: "ERROR: can't list qgroups: quotas not enabled"}
		}
	case argv[0] == "lsattr":
		var out strings.Builder
		for _, d := range argv[2:] {
			flags := "--------------e-------"
			for _, b := range s.Btrfs {
				for _, nc := range b.NoCow {
					if nc == d {
						flags = "---------------C------"
					}
				}
			}
			fmt.Fprintf(&out, "%s %s\n", flags, d)
		}
		return simAnswer{Out: out.String()}
	}
	return simAnswer{Exit: 127}
}

// efiVar is an efivarfs file: attributes and value.
func efiVar(v []byte) []byte {
	b := make([]byte, 4, 4+len(v))
	binary.LittleEndian.PutUint32(b, 0x7)
	return append(b, v...)
}

func utf16z(s string) []byte {
	var b []byte
	for _, c := range utf16.Encode([]rune(s)) {
		b = binary.LittleEndian.AppendUint16(b, c)
	}
	return append(b, 0, 0)
}

func guidBytes(g string) []byte {
	h := strings.ReplaceAll(g, "-", "")
	raw := make([]byte, 16)
	for i := 0; i < 16; i++ {
		v, _ := strconv.ParseUint(h[2*i:2*i+2], 16, 8)
		raw[i] = byte(v)
	}
	out := make([]byte, 16)
	// First three fields little endian.
	out[0], out[1], out[2], out[3] = raw[3], raw[2], raw[1], raw[0]
	out[4], out[5] = raw[5], raw[4]
	out[6], out[7] = raw[7], raw[6]
	copy(out[8:], raw[8:])
	return out
}

func loadOption(e simBootEntry) []byte {
	var dp []byte
	if e.PartUUID != "" {
		node := make([]byte, 42)
		node[0], node[1] = 4, 1
		binary.LittleEndian.PutUint16(node[2:], 42)
		binary.LittleEndian.PutUint32(node[4:], e.PartNum)
		binary.LittleEndian.PutUint64(node[8:], 2048)
		binary.LittleEndian.PutUint64(node[16:], 1048576)
		copy(node[24:40], guidBytes(e.PartUUID))
		node[40], node[41] = 2, 2
		dp = append(dp, node...)
	}
	if e.Path != "" {
		p := utf16z(e.Path)
		node := make([]byte, 4)
		node[0], node[1] = 4, 4
		binary.LittleEndian.PutUint16(node[2:], uint16(4+len(p)))
		dp = append(dp, append(node, p...)...)
	}
	dp = append(dp, 0x7f, 0xff, 4, 0)
	var b []byte
	attr := uint32(0)
	if e.Active {
		attr = 1
	}
	b = binary.LittleEndian.AppendUint32(b, attr)
	b = binary.LittleEndian.AppendUint16(b, uint16(len(dp)))
	b = append(b, utf16z(e.Label)...)
	return append(b, dp...)
}

func sigList(typ string, entries [][]byte) []byte {
	if len(entries) == 0 {
		return nil
	}
	size := 16 + len(entries[0])
	var body []byte
	for _, e := range entries {
		body = append(body, make([]byte, 16)...)
		body = append(body, e...)
	}
	b := append([]byte(nil), guidBytes(typ)...)
	b = binary.LittleEndian.AppendUint32(b, uint32(28+len(body)))
	b = binary.LittleEndian.AppendUint32(b, 0)
	b = binary.LittleEndian.AppendUint32(b, uint32(size))
	return append(b, body...)
}

func certList(signers []testSigner) []byte {
	var out []byte
	for _, s := range signers {
		out = append(out, sigList(certX509GUID, [][]byte{s.der})...)
	}
	return out
}

// writeTree writes root/ and statfs.json for the machine.
func (s *simMachine) writeTree(dir string) error {
	root := filepath.Join(dir, "root")
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	files := map[string][]byte{}
	for k, v := range s.Files {
		files[k] = []byte(v)
	}
	for k, v := range s.Bin {
		files[k] = v
	}
	links := map[string]string{}
	for k, v := range s.Links {
		links[k] = v
	}
	put := func(p, v string) {
		if _, ok := files[p]; !ok {
			files[p] = []byte(v)
		}
	}
	if s.OSRelease != "" {
		put("/etc/os-release", s.OSRelease)
	}
	put("/proc/cmdline", s.Cmdline+"\n")
	put("/proc/sys/kernel/osrelease", s.Kernel+"\n")
	arch := s.Arch
	if arch == "" {
		arch = "x86_64"
	}
	put("/proc/sys/kernel/arch", arch+"\n")
	if !s.NoSystemd {
		put("/proc/1/comm", "systemd\n")
	} else {
		put("/proc/1/comm", "init\n")
	}
	if s.Container {
		put("/run/systemd/container", "lxc\n")
	}
	put("/etc/machine-id", "0123456789abcdef0123456789abcdef\n")
	swaps := s.Swaps
	if swaps == "" {
		swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n"
	}
	put("/proc/swaps", swaps)
	// mountinfo
	var mi strings.Builder
	id := 21
	fmt.Fprintf(&mi, "%d 1 0:20 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw\n", id)
	id++
	fmt.Fprintf(&mi, "%d 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw\n", id)
	id++
	fmt.Fprintf(&mi, "%d 1 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=8000000k,nr_inodes=2000000,mode=755\n", id)
	id++
	fmt.Fprintf(&mi, "%d 1 0:22 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=1600000k,mode=755\n", id)
	id++
	anon := 40
	type ml struct {
		target string
		line   string
	}
	var mlines []ml
	for _, n := range s.all() {
		for _, m := range n.Mounts {
			mm := n.MajMin
			opts := "rw"
			if n.FSType == "btrfs" {
				mm = fmt.Sprintf("0:%d", anon)
				anon++
				opts = fmt.Sprintf("rw,ssd,space_cache=v2,subvolid=%d,subvol=%s", m.SubvolID, m.Root)
			}
			if n.FSType == "vfat" {
				opts = "rw,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=mixed,utf8,errors=remount-ro"
			}
			mo := m.Opts
			if mo == "" {
				mo = "rw,relatime"
			}
			root := m.Root
			if root == "" {
				root = "/"
			}
			src := n.path()
			if n.FSType == "btrfs" {
				src = "/dev/" + n.KName
			}
			mlines = append(mlines, ml{m.Target, fmt.Sprintf("%s %s %s - %s %s %s", root, escapeMount(m.Target), mo, n.FSType, src, opts) + "|" + mm})
		}
	}
	for _, e := range s.Files {
		_ = e
	}
	sort.SliceStable(mlines, func(i, j int) bool {
		return strings.Count(mlines[i].target, "/") < strings.Count(mlines[j].target, "/") || mlines[i].target == "/"
	})
	for _, l := range mlines {
		line, mm, _ := strings.Cut(l.line, "|")
		parts := strings.SplitN(line, " ", 2)
		fmt.Fprintf(&mi, "%d 1 %s %s %s\n", id, mm, parts[0], parts[1])
		id++
	}
	if extra, ok := s.Files["/proc/self/mountinfo.extra"]; ok {
		mi.WriteString(extra)
		delete(files, "/proc/self/mountinfo.extra")
	}
	put("/proc/self/mountinfo", mi.String())
	// sysfs: disks, drivers, NVMe ids, md, network
	for _, d := range s.Disks {
		if d.DevPath != "" {
			links["/sys/block/"+d.KName] = d.DevPath
		}
		for _, drv := range d.Drivers {
			links[drv.Dir+"/driver"] = "/sys/bus/pci/drivers/" + drv.Driver
			if drv.Modalias != "" {
				put(drv.Dir+"/modalias", drv.Modalias+"\n")
			}
		}
		if d.EUI != "" {
			put("/sys/block/"+d.KName+"/eui", d.EUI+"\n")
		}
		if d.NGUID != "" {
			put("/sys/block/"+d.KName+"/nguid", d.NGUID+"\n")
		}
		if d.NSID != "" {
			put("/sys/block/"+d.KName+"/nsid", d.NSID+"\n")
		}
		mbr := make([]byte, 512)
		switch d.BootCode {
		case "grub":
			copy(mbr[0:], []byte{0xeb, 0x63, 0x90})
			copy(mbr[0x180:], "GRUB \x00Geom\x00Hard Disk\x00Read\x00 Error")
		case "other":
			copy(mbr[0:], []byte{0xfa, 0x33, 0xc0, 0x8e, 0xd0})
		}
		if d.PMBR {
			mbr[446] = 0x80
		}
		mbr[510], mbr[511] = 0x55, 0xaa
		if _, ok := files["/dev/"+d.KName]; !ok {
			files["/dev/"+d.KName] = mbr
		}
	}
	for _, n := range s.all() {
		if n.FSType == "vfat" {
			bs := make([]byte, 512)
			binary.LittleEndian.PutUint16(bs[11:], uint16(n.LogSecOr512()))
			spc := n.SecPerClus
			if spc == 0 {
				spc = 8
			}
			bs[13] = byte(spc)
			files["/dev/"+n.KName] = bs
		}
	}
	for _, md := range s.MD {
		base := "/sys/block/" + md.KName + "/md/"
		if md.Chunk > 0 {
			put(base+"chunk_size", strconv.FormatInt(md.Chunk, 10)+"\n")
		}
		if md.Layout != "" {
			put(base+"layout", md.Layout+"\n")
		}
		bm := md.Bitmap
		if bm == "" {
			bm = "+8"
		}
		put(base+"bitmap/location", bm+"\n")
		st := md.ArrayState
		if st == "" {
			st = "clean"
		}
		put(base+"array_state", st+"\n")
		put(base+"degraded", strconv.Itoa(md.Degraded)+"\n")
		sa := md.SyncAction
		if sa == "" {
			sa = "idle"
		}
		put(base+"sync_action", sa+"\n")
		pol := md.Policy
		if pol == "" {
			pol = "bitmap"
		}
		put(base+"consistency_policy", pol+"\n")
		for _, m := range md.Members {
			put(base+"dev-"+strings.TrimPrefix(m.Dev, "/dev/")+"/state", m.State+"\n")
		}
	}
	for _, ni := range s.Interfaces {
		dev := ni.DevDir
		if dev == "" {
			dev = "/sys/devices/virtual"
		}
		links["/sys/class/net/"+ni.Name] = dev + "/net/" + ni.Name
		put("/sys/class/net/"+ni.Name+"/address", ni.MAC+"\n")
		if ni.Driver != "" {
			links[dev+"/driver"] = "/sys/bus/pci/drivers/" + ni.Driver
		}
		if ni.Modalias != "" {
			put(dev+"/modalias", ni.Modalias+"\n")
		}
	}
	// efivars
	if s.UEFI {
		ev := "/sys/firmware/efi/efivars/"
		put("/sys/firmware/efi/fw_platform_size", "64\n")
		if s.SecureBoot != nil {
			files[ev+"SecureBoot-"+EFIGlobalGUID] = efiVar([]byte{map[bool]byte{true: 1, false: 0}[*s.SecureBoot]})
		}
		if s.SetupMode != nil {
			files[ev+"SetupMode-"+EFIGlobalGUID] = efiVar([]byte{map[bool]byte{true: 1, false: 0}[*s.SetupMode]})
		}
		for _, e := range s.BootEntries {
			files[fmt.Sprintf("%sBoot%04X-%s", ev, e.Num, EFIGlobalGUID)] = efiVar(loadOption(e))
		}
		if len(s.BootOrder) > 0 {
			var bo []byte
			for _, n := range s.BootOrder {
				bo = binary.LittleEndian.AppendUint16(bo, n)
			}
			files[ev+"BootOrder-"+EFIGlobalGUID] = efiVar(bo)
		}
		if s.BootCurrent != nil {
			files[ev+"BootCurrent-"+EFIGlobalGUID] = efiVar(binary.LittleEndian.AppendUint16(nil, *s.BootCurrent))
		}
		if s.Sbat != "" {
			files[ev+"SbatLevelRT-"+ShimLockGUID] = efiVar([]byte(s.Sbat))
		}
		if len(s.DB) > 0 {
			files[ev+"db-"+EFISecDBGUID] = efiVar(certList(s.DB))
		}
		if len(s.DBX) > 0 {
			files[ev+"dbx-"+EFISecDBGUID] = efiVar(sigList(certSHA256GUID, s.DBX))
		}
		if len(s.MOK) > 0 {
			files[ev+"MokListRT-"+ShimLockGUID] = efiVar(certList(s.MOK))
		}
		// Variables outside the allow-list are never read.
		files[ev+"PlatformLang-"+EFIGlobalGUID] = efiVar([]byte("en-US\x00"))
		files[ev+"MokPWStore-"+ShimLockGUID] = efiVar([]byte("never-read-secret"))
	}
	// Every name is written as FixtureName does, so the tree checks out on
	// every system (sysfs has names with a colon).
	for p, b := range files {
		full := FixturePath(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if strings.HasSuffix(p, "/") {
			if err := os.MkdirAll(full, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			return err
		}
	}
	for p, t := range links {
		full := FixturePath(root, p) + ".link"
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, []byte(t+"\n"), 0o644); err != nil {
			return err
		}
	}
	// Mount points exist as directories.
	for _, n := range s.all() {
		for _, m := range n.Mounts {
			_ = os.MkdirAll(FixturePath(root, m.Target), 0o755)
		}
	}
	// git keeps no empty directory: one that holds nothing (a mount point)
	// gets the file DirHost does not show.
	if err := keepEmptyDirs(root); err != nil {
		return err
	}
	st := s.Statfs
	if st == nil {
		st = map[string]Statfs{}
	}
	for _, n := range s.all() {
		for _, m := range n.Mounts {
			if _, ok := st[m.Target]; !ok && n.FSType != "vfat" {
				st[m.Target] = Statfs{Files: 3276800, FilesFree: 3276800 - 312000}
			}
		}
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	return os.WriteFile(filepath.Join(dir, "statfs.json"), append(b, '\n'), 0o644)
}

// keepEmptyDirs writes FixtureKeep into every directory below root that
// holds nothing.
func keepEmptyDirs(root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return err
		}
		ents, err := os.ReadDir(p)
		if err != nil || len(ents) > 0 {
			return err
		}
		return os.WriteFile(filepath.Join(p, FixtureKeep), nil, 0o644)
	})
}

func (n *simNode) LogSecOr512() int64 {
	if n.LogSec > 0 {
		return n.LogSec
	}
	return 512
}

func escapeMount(p string) string {
	return strings.NewReplacer(" ", `\040`, "\t", `\011`, "\n", `\012`, `\`, `\134`).Replace(p)
}

// recorder wraps a runner and keeps every distinct call with its answer.
type recorder struct {
	next  cmdrun.Runner
	order []string
	recs  map[string]cmdrun.Recorded
	argv  map[string][]string
}

func newRecorder(next cmdrun.Runner) *recorder {
	return &recorder{next: next, recs: map[string]cmdrun.Recorded{}, argv: map[string][]string{}}
}

func (r *recorder) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	argv := append([]string{name}, args...)
	out, err := r.next.Run(ctx, name, args...)
	k := strings.Join(argv, "\x00")
	if _, ok := r.recs[k]; !ok {
		rec := cmdrun.Recorded{Stdout: string(out)}
		var ee *cmdrun.ExitError
		switch {
		case err == nil:
		case cmdrun.IsNotFound(err):
			rec.Exit = 127
		case asExit(err, &ee):
			rec.Exit, rec.Stderr = ee.Code, ee.Stderr
		default:
			rec.Exit, rec.Stderr = 1, err.Error()
		}
		r.recs[k] = rec
		r.argv[k] = argv
		r.order = append(r.order, k)
	}
	return out, err
}

func asExit(err error, target **cmdrun.ExitError) bool {
	e, ok := err.(*cmdrun.ExitError)
	if ok {
		*target = e
	}
	return ok
}

// write stores the recordings as cmd/NN.{cmd,out,err,exit}.
func (r *recorder) write(dir string) error {
	cmdDir := filepath.Join(dir, "cmd")
	if err := os.RemoveAll(cmdDir); err != nil {
		return err
	}
	if err := os.MkdirAll(cmdDir, 0o755); err != nil {
		return err
	}
	for i, k := range r.order {
		base := filepath.Join(cmdDir, fmt.Sprintf("%03d", i+1))
		rec := r.recs[k]
		if err := os.WriteFile(base+".cmd", []byte(strings.Join(r.argv[k], "\n")+"\n"), 0o644); err != nil {
			return err
		}
		if rec.Stdout != "" {
			if err := os.WriteFile(base+".out", []byte(rec.Stdout), 0o644); err != nil {
				return err
			}
		}
		if rec.Stderr != "" {
			if err := os.WriteFile(base+".err", []byte(rec.Stderr), 0o644); err != nil {
				return err
			}
		}
		if rec.Exit != 0 {
			if err := os.WriteFile(base+".exit", []byte(strconv.Itoa(rec.Exit)+"\n"), 0o644); err != nil {
				return err
			}
		}
	}
	if len(r.order) == 0 {
		// No call, no folder: git would not keep the empty one, and the
		// replay reads a missing folder as no recordings.
		return os.Remove(cmdDir)
	}
	return nil
}

var _ = bytes.Equal
var _ = path.Join
