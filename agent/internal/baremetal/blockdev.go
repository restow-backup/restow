package baremetal

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// blkNode is one device of `lsblk -J -b -O`. lsblk prints booleans as
// true/false (util-linux 2.33 and later) or "0"/"1", sizes as numbers with
// -b; the accessors accept every form.
type blkNode struct {
	f        map[string]any
	children []*blkNode
	parent   *blkNode
}

func (n *blkNode) str(k string) string {
	switch v := n.f[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	case bool:
		if v {
			return "1"
		}
		return "0"
	}
	return ""
}

func (n *blkNode) int(k string) int64 {
	s := n.str(k)
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

func (n *blkNode) bool(k string) bool {
	s := n.str(k)
	return s == "1" || s == "true"
}

func (n *blkNode) typ() string    { return n.str("type") }
func (n *blkNode) fstype() string { return n.str("fstype") }
func (n *blkNode) kname() string  { return n.str("kname") }

// path is the device node (/dev/sda1, /dev/mapper/vg0-root).
func (n *blkNode) path() string {
	if p := n.str("path"); p != "" {
		return p
	}
	return "/dev/" + n.kname()
}

// mountpoints lists where the device is mounted (lsblk 2.37: mountpoints).
func (n *blkNode) mountpoints() []string {
	var out []string
	if l, ok := n.f["mountpoints"].([]any); ok {
		for _, v := range l {
			if s, ok := v.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	}
	if len(out) == 0 {
		if s := n.str("mountpoint"); s != "" {
			out = append(out, s)
		}
	}
	return out
}

var rePartSuffix = regexp.MustCompile(`(\d+)$`)

// partNumber is the partition number: lsblk's PARTN (2.39), else the
// trailing digits of the kernel name.
func (n *blkNode) partNumber() int64 {
	if v := n.int("partn"); v > 0 {
		return v
	}
	if m := rePartSuffix.FindString(n.kname()); m != "" {
		v, _ := strconv.ParseInt(m, 10, 64)
		return v
	}
	return 0
}

// skippedTypes are devices that are not part of the storage stack.
var skippedTypes = map[string]bool{"loop": true, "rom": true, "ram": true}

// diskTypes are the lsblk types recorded as disks (the agent-root tests add
// loop devices, on which they build their stacks).
var diskTypes = map[string]bool{"disk": true}

// captureBlockDevices reads `lsblk -J -b -O` and assigns the identifiers of
// disks, md arrays, LUKS and plain dm-crypt devices and LVs (contract C1:
// d<n>, m<n>, c<n>, p<n>; LVs by VG and name).
func captureBlockDevices(c *capture) error {
	out, err := c.run("lsblk", "-J", "-b", "-O")
	if err != nil {
		if strings.Contains(err.Error(), "not installed") {
			return missingTool("lsblk")
		}
		return err
	}
	var raw struct {
		Blockdevices []json.RawMessage `json:"blockdevices"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return fmt.Errorf("lsblk: %w", err)
	}
	c.addRaw("lsblk.json", out)
	seen := map[string]bool{}
	var walk func(msg json.RawMessage, parent *blkNode) error
	walk = func(msg json.RawMessage, parent *blkNode) error {
		var f map[string]any
		if err := json.Unmarshal(msg, &f); err != nil {
			return err
		}
		var kids []json.RawMessage
		if ch, ok := f["children"]; ok {
			b, _ := json.Marshal(ch)
			_ = json.Unmarshal(b, &kids)
			delete(f, "children")
		}
		n := &blkNode{f: f, parent: parent}
		if parent != nil && n.str("pkname") == "" {
			n.f["pkname"] = parent.kname()
		}
		if !seen[n.kname()] {
			seen[n.kname()] = true
			c.nodes = append(c.nodes, n)
			c.byKName[n.kname()] = n
			c.byPath[n.path()] = n
			if mm := n.str("maj:min"); mm != "" {
				c.byMajMin[mm] = n
			}
		}
		canon := c.byKName[n.kname()]
		if parent != nil && !containsNode(parent.children, canon) {
			parent.children = append(parent.children, canon)
		}
		for _, k := range kids {
			if err := walk(k, canon); err != nil {
				return err
			}
		}
		return nil
	}
	for _, d := range raw.Blockdevices {
		if err := walk(d, nil); err != nil {
			return fmt.Errorf("lsblk: %w", err)
		}
	}
	// Disks.
	di := 0
	for _, n := range c.nodes {
		if n.parent != nil || skippedTypes[n.typ()] || !diskTypes[n.typ()] || strings.HasPrefix(n.kname(), "zram") {
			continue
		}
		if di >= maxDisks {
			c.note(CodeCaptureFailed, "blockdev", fmt.Sprintf("more than %d disks; the rest is not recorded", maxDisks), SeverityWarning)
			break
		}
		id := fmt.Sprintf("d%d", di)
		di++
		c.diskOf[n] = id
		d := Disk{ID: id, KName: clean(n.kname()), SizeBytes: n.int("size"),
			LogicalSectorSize: n.int("log-sec"), PhysicalSectorSize: n.int("phy-sec"),
			Model: cleanPtr(n.str("model")), Serial: cleanPtr(n.str("serial")), WWN: cleanPtr(n.str("wwn")),
			Transport: cleanPtr(n.str("tran")), Rotational: n.bool("rota"), Removable: n.bool("rm"), ReadOnly: n.bool("ro"),
			Zoned: clean(n.str("zoned")), MajMin: clean(n.str("maj:min")), BootCode: "none"}
		if d.Zoned == "" {
			d.Zoned = "none"
		}
		sys := "/sys/block/" + n.kname()
		if v, ok := readString(c.h, sys+"/eui"); ok && v != "" {
			d.EUI64 = strPtr(normalizeID(v))
		}
		if v, ok := readString(c.h, sys+"/nguid"); ok && v != "" {
			d.NGUID = strPtr(normalizeID(v))
		}
		if v, ok := readString(c.h, sys+"/nsid"); ok {
			if x, err := strconv.ParseInt(v, 10, 64); err == nil {
				d.NSID = &x
			}
		}
		c.l.Disks = append(c.l.Disks, d)
	}
	// md arrays, LUKS headers, plain dm-crypt mappings and LVs, in lsblk order.
	mi, ci, pi := 0, 0, 0
	for _, n := range c.nodes {
		switch {
		case strings.HasPrefix(n.typ(), "raid") || n.typ() == "md" || (n.parent == nil && strings.HasPrefix(n.kname(), "md") && n.typ() != "disk"):
			c.mdOf[n] = fmt.Sprintf("m%d", mi)
			mi++
		case n.typ() == "mpath":
			c.note(CodeMultipathUnsupported, n.kname(), "", SeverityUnsupported)
		case n.typ() == "lvm":
			if vg, lv, ok := splitDMName(n.str("name")); ok {
				c.lvOf[n] = [2]string{vg, lv}
			}
		}
		if n.fstype() == "crypto_LUKS" {
			c.luksOf[n] = fmt.Sprintf("c%d", ci)
			ci++
		}
		if n.typ() == "crypt" {
			if p := c.byKName[n.str("pkname")]; p == nil || p.fstype() != "crypto_LUKS" {
				c.plainOf[n] = fmt.Sprintf("p%d", pi)
				pi++
			}
		}
		if n.typ() == "dm" && (strings.HasSuffix(n.str("name"), "_dif") || strings.Contains(n.str("name"), "integrity")) {
			c.note(CodeIntegrityUnsupported, n.kname(), "", SeverityUnsupported)
		}
	}
	return nil
}

func containsNode(list []*blkNode, n *blkNode) bool {
	for _, x := range list {
		if x == n {
			return true
		}
	}
	return false
}

// splitDMName splits a device mapper name of an LV: "vg--a-lv--b" is VG
// "vg-a" and LV "lv-b" (LVM doubles dashes in both names).
func splitDMName(name string) (string, string, bool) {
	for i := 0; i < len(name); i++ {
		if name[i] != '-' {
			continue
		}
		if i+1 < len(name) && name[i+1] == '-' {
			i++
			continue
		}
		vg := strings.ReplaceAll(name[:i], "--", "-")
		lv := strings.ReplaceAll(name[i+1:], "--", "-")
		if vg == "" || lv == "" {
			return "", "", false
		}
		return vg, lv, true
	}
	return "", "", false
}

// normalizeID removes separators from a sysfs identifier ("00 25 38 b1" or
// "00:25:38:b1" becomes "002538b1").
func normalizeID(s string) string {
	return strings.ToLower(strings.NewReplacer(" ", "", ":", "", "\n", "").Replace(strings.TrimSpace(s)))
}

// captureDriverChains records, for each disk, the drivers from the device
// up to the PCI root and their modaliases (sysfs only).
func captureDriverChains(c *capture) error {
	for i := range c.l.Disks {
		d := &c.l.Disks[i]
		dev, ok := resolveLink(c.h, "/sys/block/"+d.KName)
		if !ok {
			continue
		}
		chain, aliases := driverChain(c.h, dev)
		d.DriverChain, d.DriverModaliases = chain, aliases
	}
	return nil
}

// driverChain walks from a sysfs device directory to /sys/devices.
func driverChain(h Host, dev string) ([]string, []string) {
	chain, aliases := []string{}, []string{}
	seen := map[string]bool{}
	for p := dev; strings.HasPrefix(p, "/sys/devices/") && len(chain) < 16; p = path.Dir(p) {
		drv, ok := resolveLink(h, p+"/driver")
		if !ok {
			continue
		}
		name := path.Base(drv)
		if seen[name] {
			continue
		}
		seen[name] = true
		chain = append(chain, clean(name))
		if a, ok := readString(h, p+"/modalias"); ok && a != "" {
			aliases = append(aliases, clean(a))
		}
	}
	return chain, aliases
}

// sortedKeys returns the keys of a set, sorted.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
