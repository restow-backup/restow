//go:build linux

package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// HardwareCollector reads the replacement machine (docs/BAREMETAL.md
// 10.6): /sys/block, the driver chains up to the PCI root, lsblk, blkid
// on every node, the live medium and the network cards.
type HardwareCollector struct {
	Exec Exec
	// SysRoot, DevRoot, ProcRoot are /sys, /dev and /proc (tests).
	SysRoot  string
	DevRoot  string
	ProcRoot string
	EFI      EFIVars
	// Probe runs the read and write probe of the first and last MiB.
	Probe bool
}

func (h *HardwareCollector) path(root, def, rel string) string {
	if root == "" {
		root = def
	}
	return filepath.Join(root, rel)
}

func (h *HardwareCollector) sys(rel string) string  { return h.path(h.SysRoot, "/sys", rel) }
func (h *HardwareCollector) dev(rel string) string  { return h.path(h.DevRoot, "/dev", rel) }
func (h *HardwareCollector) proc(rel string) string { return h.path(h.ProcRoot, "/proc", rel) }

func readTrim(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readInt64(p string) int64 {
	n, _ := strconv.ParseInt(readTrim(p), 10, 64)
	return n
}

// Collect gathers the hardware input.
func (h *HardwareCollector) Collect(ctx context.Context) (HardwareInput, error) {
	in := HardwareInput{Firmware: h.EFI.Firmware(), RAMBytes: h.ram(), LiveMedium: h.liveMedium(ctx), NICs: h.nics()}
	entries, err := os.ReadDir(h.sys("block"))
	if err != nil {
		return in, err
	}
	lsblk := h.lsblk(ctx)
	byPath := h.byPath()
	for _, e := range entries {
		k := e.Name()
		if reVirtual.MatchString(k) {
			continue
		}
		b := BlockInfo{KName: k}
		base := h.sys(filepath.Join("block", k))
		b.SizeBytes = readInt64(filepath.Join(base, "size")) * 512
		b.Logical = readInt64(filepath.Join(base, "queue/logical_block_size"))
		b.Physical = readInt64(filepath.Join(base, "queue/physical_block_size"))
		b.ReadOnly = readTrim(filepath.Join(base, "ro")) == "1"
		b.Removable = readTrim(filepath.Join(base, "removable")) == "1"
		b.Zoned = readTrim(filepath.Join(base, "queue/zoned"))
		b.Model = firstNonEmpty(readTrim(filepath.Join(base, "device/model")), lsblk[k].Model)
		b.Serial = firstNonEmpty(readTrim(filepath.Join(base, "device/serial")), lsblk[k].Serial)
		b.EUI64 = strings.ReplaceAll(readTrim(filepath.Join(base, "eui")), " ", "")
		b.NGUID = strings.ReplaceAll(readTrim(filepath.Join(base, "nguid")), "-", "")
		if isZeroHex(b.EUI64) {
			b.EUI64 = ""
		}
		if isZeroHex(b.NGUID) {
			b.NGUID = ""
		}
		b.NSID = readInt64(filepath.Join(base, "nsid"))
		b.WWN = lsblk[k].WWN
		if b.WWN == "" {
			if w := readTrim(filepath.Join(base, "device/wwid")); strings.HasPrefix(w, "naa.") {
				b.WWN = "0x" + strings.TrimPrefix(w, "naa.")
			}
		}
		b.Transport = firstNonEmpty(lsblk[k].Tran, h.transport(k))
		b.ByPath = byPath[k]
		b.DriverChain, b.Modaliases = h.driverChain(k)
		b.Signatures = h.signatures(ctx, k)
		if h.Probe && b.SizeBytes > 0 && !b.ReadOnly {
			b.IOError = ProbeIO(h.dev(k), b.SizeBytes, len(b.Signatures) == 0) != nil
		}
		in.Blocks = append(in.Blocks, b)
	}
	return in, nil
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func isZeroHex(s string) bool { return strings.Trim(s, "0") == "" }

func (h *HardwareCollector) ram() int64 {
	b, err := os.ReadFile(h.proc("meminfo"))
	if err != nil {
		return 0
	}
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, "MemTotal:"); ok {
			f := strings.Fields(v)
			if len(f) > 0 {
				n, _ := strconv.ParseInt(f[0], 10, 64)
				return n * 1024
			}
		}
	}
	return 0
}

type lsblkDev struct {
	Name   string `json:"name"`
	Tran   string `json:"tran"`
	Model  string `json:"model"`
	Serial string `json:"serial"`
	WWN    string `json:"wwn"`
}

func (h *HardwareCollector) lsblk(ctx context.Context) map[string]lsblkDev {
	out := map[string]lsblkDev{}
	res, err := h.Exec.Run(ctx, RunSpec{Argv: []string{"lsblk", "-J", "-b", "-d", "-o", "NAME,TRAN,MODEL,SERIAL,WWN"}, Timeout: time.Minute})
	if err != nil {
		return out
	}
	var doc struct {
		Blockdevices []map[string]any `json:"blockdevices"`
	}
	if json.Unmarshal(res.Output, &doc) != nil {
		return out
	}
	for _, d := range doc.Blockdevices {
		s := func(k string) string { v, _ := d[k].(string); return strings.TrimSpace(v) }
		out[s("name")] = lsblkDev{Name: s("name"), Tran: s("tran"), Model: s("model"), Serial: s("serial"), WWN: s("wwn")}
	}
	return out
}

func (h *HardwareCollector) transport(k string) string {
	if strings.HasPrefix(k, "nvme") {
		return "nvme"
	}
	if strings.HasPrefix(k, "vd") {
		return "virtio"
	}
	if strings.HasPrefix(k, "mmcblk") {
		return "mmc"
	}
	if t, err := filepath.EvalSymlinks(h.sys(filepath.Join("block", k))); err == nil && strings.Contains(t, "/usb") {
		return "usb"
	}
	return ""
}

func (h *HardwareCollector) byPath() map[string]string {
	out := map[string]string{}
	links, _ := filepath.Glob(h.dev("disk/by-path/*"))
	sort.Strings(links)
	for _, l := range links {
		name := filepath.Base(l)
		if strings.Contains(name, "-part") {
			continue
		}
		if r, err := filepath.EvalSymlinks(l); err == nil {
			k := filepath.Base(r)
			if _, ok := out[k]; !ok {
				out[k] = name
			}
		}
	}
	return out
}

// driverChain walks from the disk up to the PCI root and notes the
// driver and the modalias of every level (10.8).
func (h *HardwareCollector) driverChain(k string) (drivers, aliases []string) {
	dev, err := filepath.EvalSymlinks(h.sys(filepath.Join("block", k, "device")))
	if err != nil {
		return []string{}, []string{}
	}
	root := h.sys("devices")
	seen := map[string]bool{}
	for p := dev; strings.HasPrefix(p, root) && p != root; p = filepath.Dir(p) {
		if d, err := os.Readlink(filepath.Join(p, "driver")); err == nil {
			name := filepath.Base(d)
			if !seen["d:"+name] {
				seen["d:"+name] = true
				drivers = append(drivers, name)
			}
		}
		if m := readTrim(filepath.Join(p, "modalias")); m != "" && !seen["m:"+m] {
			seen["m:"+m] = true
			aliases = append(aliases, m)
		}
	}
	if drivers == nil {
		drivers = []string{}
	}
	if aliases == nil {
		aliases = []string{}
	}
	return drivers, aliases
}

// signatures reads the identities on a disk and its partitions with
// blkid -p (disk GUID, PARTUUIDs, file systems, md members, PVs, LUKS).
func (h *HardwareCollector) signatures(ctx context.Context, k string) []baremetal.TargetSignature {
	out := []baremetal.TargetSignature{}
	nodes := []string{k}
	parts, _ := os.ReadDir(h.sys(filepath.Join("block", k)))
	for _, p := range parts {
		if _, err := os.Stat(h.sys(filepath.Join("block", k, p.Name(), "partition"))); err == nil {
			nodes = append(nodes, p.Name())
		}
	}
	for _, n := range nodes {
		res, err := h.Exec.Run(ctx, RunSpec{Argv: []string{"blkid", "-p", "-o", "export", "/dev/" + n}, Timeout: time.Minute})
		if err != nil && len(res.Output) == 0 {
			continue
		}
		kv := parseExport(string(res.Output))
		if v := kv["PTUUID"]; v != "" && n == k {
			out = append(out, baremetal.TargetSignature{Kind: "disk_guid", UUID: v})
		}
		var num *int64
		if v := kv["PART_ENTRY_NUMBER"]; v != "" {
			x, _ := strconv.ParseInt(v, 10, 64)
			num = &x
		}
		if v := kv["PART_ENTRY_UUID"]; v != "" {
			out = append(out, baremetal.TargetSignature{Kind: "part_uuid", UUID: v, PartNumber: num})
		}
		typ, uuid := kv["TYPE"], kv["UUID"]
		if uuid == "" {
			continue
		}
		kind := "fs"
		switch typ {
		case "linux_raid_member":
			kind = "md"
		case "LVM2_member":
			kind = "pv"
		case "crypto_LUKS":
			kind = "luks"
		}
		t := typ
		out = append(out, baremetal.TargetSignature{Kind: kind, UUID: uuid, Type: &t, PartNumber: num})
	}
	return out
}

// liveMedium is the disk the ISO started from.
func (h *HardwareCollector) liveMedium(ctx context.Context) string {
	res, err := h.Exec.Run(ctx, RunSpec{Argv: []string{"findmnt", "-n", "-o", "SOURCE", "/run/live/medium"}, Timeout: time.Minute})
	if err != nil {
		return ""
	}
	src := strings.TrimSpace(string(res.Output))
	if r, err := filepath.EvalSymlinks(src); err == nil {
		src = r
	}
	k := filepath.Base(src)
	// A partition: its parent is the disk.
	if t, err := filepath.EvalSymlinks(h.sys(filepath.Join("class/block", k))); err == nil {
		if _, err := os.Stat(filepath.Join(t, "partition")); err == nil {
			return filepath.Base(filepath.Dir(t))
		}
	}
	return k
}

// nics lists the physical network cards (those with a device link).
func (h *HardwareCollector) nics() []baremetal.TargetNIC {
	out := []baremetal.TargetNIC{}
	entries, _ := os.ReadDir(h.sys("class/net"))
	for _, e := range entries {
		base := h.sys(filepath.Join("class/net", e.Name()))
		if _, err := os.Stat(filepath.Join(base, "device")); err != nil {
			continue
		}
		n := baremetal.TargetNIC{Name: e.Name()}
		if m := readTrim(filepath.Join(base, "address")); m != "" {
			n.MAC = &m
		}
		if d, err := os.Readlink(filepath.Join(base, "device/driver")); err == nil {
			s := filepath.Base(d)
			n.Driver = &s
		}
		if m := readTrim(filepath.Join(base, "device/modalias")); m != "" {
			n.Modalias = &m
		}
		out = append(out, n)
	}
	return out
}

// ProbeIO reads the first and last MiB of a disk with O_DIRECT and, when
// write is set, writes the same bytes back (10.6); a locked
// self-encrypting drive fails here, before anything is erased.
func ProbeIO(dev string, size int64, write bool) error {
	flags := os.O_RDONLY
	if write {
		flags = os.O_RDWR
	}
	f, err := os.OpenFile(dev, flags|syscall.O_DIRECT, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	const n = 1 << 20
	buf := alignedBuffer(n, 4096)
	for _, off := range []int64{0, max(size-n, 0) &^ 4095} {
		if _, err := f.ReadAt(buf, off); err != nil {
			return fmt.Errorf("%s: read at %d: %w", dev, off, err)
		}
		if write {
			if _, err := f.WriteAt(buf, off); err != nil {
				return fmt.Errorf("%s: write at %d: %w", dev, off, err)
			}
		}
	}
	return nil
}

func alignedBuffer(n, align int) []byte {
	b := make([]byte, n+align)
	off := int(uintptr(unsafe.Pointer(&b[0])) & uintptr(align-1))
	if off != 0 {
		off = align - off
	}
	return b[off : off+n]
}

var reIdentityTail = regexp.MustCompile(`^[\x21-\x7e]{1,4}$`)

// WipeOther clears the signatures of a device that is neither a target
// nor adopted (an identity conflict, 10.7); only after the operator typed
// the last four characters of its identity.
func WipeOther(ctx context.Context, x Exec, d baremetal.TargetDisk, typedTail string) error {
	id := deref(d.Identity)
	if id == "" || !reIdentityTail.MatchString(typedTail) || !strings.EqualFold(IdentityTail(id), typedTail) {
		return errors.New("the identity was not confirmed; nothing was wiped")
	}
	_, err := x.Run(ctx, RunSpec{Argv: []string{"wipefs", "-a", d.Path}, NoKill: true, Timeout: 5 * time.Minute})
	return err
}
