package baremetal

import (
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Fixups (docs/BAREMETAL.md 10.13): pure text rewrites of configuration
// files of the restored system, each tested with tables. recover (M4)
// reads and writes the files below the target with openat2 and keeps the
// previous file as <file>.restow-<time>; M2 only plans them. A file that
// needs no change comes back byte for byte.

// FixupContext holds what the rewrites need.
type FixupContext struct {
	// DeviceNames maps a device name of the source ("/dev/sda2",
	// "/dev/disk/by-path/…") to a stable reference: "UUID=…" of what sits on
	// it, else "PARTUUID=…".
	DeviceNames map[string]string
	// PartUUIDs maps a partition device of the source to "PARTUUID=…".
	PartUUIDs map[string]string
	// SubvolIDs maps btrfs subvolume ids to their paths.
	SubvolIDs map[int64]string
	// MACs maps old MAC addresses (lowercase) to the new ones.
	MACs map[string]string
	// MissingESPs are the UUIDs of ESPs that are not restored.
	MissingESPs []string
	// PlainSources maps the crypttab name of a plain dm-crypt volume to
	// its stable source ("PARTUUID=…" or "/dev/disk/by-id/wwn-…").
	PlainSources map[string]string
	// MD holds the member and spare counts per normalized array UUID.
	MD map[string]MDCount
	// PVUUIDs are the PV UUIDs an LVM accept filter names.
	PVUUIDs []string
	// AllowMixedBlockSizes sets devices/allow_mixed_block_sizes = 1.
	AllowMixedBlockSizes bool
	// NotRestored are fstab sources and targets of file systems that are
	// not restored (missing disks).
	NotRestored map[string]bool
	// BIOSInstallDevices and ESPInstallDevices are the new devices for
	// grub-pc/install_devices, grub_installdevice and grub-efi/install_devices.
	BIOSInstallDevices []string
	ESPInstallDevices  []string
	// ResumeOffset is the new resume_offset of a swap file, when known.
	ResumeOffset *int64
}

// MDCount is the device and spare count of an md array on the target.
type MDCount struct {
	Devices int64
	Spares  int64
}

// FixupChange records one change of a fixup.
type FixupChange struct {
	Line int64  `json:"line"`
	Rule string `json:"rule"`
	From string `json:"from"`
	To   string `json:"to"`
}

// PlannedFixup is a file and the rules the plan applies to it.
type PlannedFixup struct {
	Path  string   `json:"path"`
	Rules []string `json:"rules"`
}

// lines splits text into lines that keep their line ending.
func lines(in []byte) []string {
	s := string(in)
	var out []string
	for len(s) > 0 {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			out = append(out, s)
			break
		}
		out = append(out, s[:i+1])
		s = s[i+1:]
	}
	return out
}

// span is a field of a line: its byte offsets.
type span struct{ a, b int }

// fieldSpans returns the whitespace-separated fields of a line (without
// its line ending).
func fieldSpans(line string) []span {
	var out []span
	i := 0
	for i < len(line) {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t' || line[i] == '\n' || line[i] == '\r') {
			i++
		}
		if i >= len(line) {
			break
		}
		j := i
		for j < len(line) && line[j] != ' ' && line[j] != '\t' && line[j] != '\n' && line[j] != '\r' {
			j++
		}
		out = append(out, span{i, j})
		i = j
	}
	return out
}

func replaceSpan(line string, s span, v string) string { return line[:s.a] + v + line[s.b:] }

func isComment(line string) bool {
	t := strings.TrimLeft(line, " \t")
	return t == "" || t == "\n" || strings.HasPrefix(t, "#")
}

// byPath turns UUID=x and PARTUUID=x into /dev/disk/by-uuid/x and
// /dev/disk/by-partuuid/x.
func byPath(ref string) string {
	if v, ok := strings.CutPrefix(ref, "UUID="); ok {
		return "/dev/disk/by-uuid/" + v
	}
	if v, ok := strings.CutPrefix(ref, "PARTUUID="); ok {
		return "/dev/disk/by-partuuid/" + v
	}
	return ref
}

func (c FixupContext) device(dev string) (string, bool) {
	ref, ok := c.DeviceNames[dev]
	return ref, ok && ref != "" && ref != dev
}

// FixFstab rewrites /etc/fstab: device names to UUID= or PARTUUID=,
// subvolid= to subvol=, and entries of file systems that are not restored
// get nofail and a comment.
func FixFstab(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	for n, line := range lines(in) {
		if isComment(line) {
			out.WriteString(line)
			continue
		}
		f := fieldSpans(line)
		if len(f) < 2 {
			out.WriteString(line)
			continue
		}
		orig := line
		src, target := line[f[0].a:f[0].b], line[f[1].a:f[1].b]
		notRestored := c.NotRestored[src] || c.NotRestored[target]
		// Work from the right so earlier offsets stay valid.
		if len(f) >= 4 {
			opts := line[f[3].a:f[3].b]
			newOpts := fixSubvolID(opts, c)
			if notRestored && !hasOption(newOpts, "nofail") {
				newOpts += ",nofail"
			}
			if newOpts != opts {
				line = replaceSpan(line, f[3], newOpts)
				changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "fstab_options", From: opts, To: newOpts})
			}
		}
		if ref, ok := c.device(src); ok {
			line = replaceSpan(line, f[0], ref)
			changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "fstab_source", From: src, To: ref})
		}
		if notRestored && line != orig {
			out.WriteString("# restow: the file system of the next line was not restored\n")
		}
		out.WriteString(line)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

func hasOption(opts, name string) bool {
	for _, o := range strings.Split(opts, ",") {
		if o == name {
			return true
		}
	}
	return false
}

// fixSubvolID replaces subvolid=N by subvol=<path>; with a subvol= next
// to it the subvolid= is dropped.
func fixSubvolID(opts string, c FixupContext) string {
	parts := strings.Split(opts, ",")
	hasSubvol := false
	for _, p := range parts {
		hasSubvol = hasSubvol || strings.HasPrefix(p, "subvol=")
	}
	var out []string
	changed := false
	for _, p := range parts {
		if v, ok := strings.CutPrefix(p, "subvolid="); ok {
			id, err := strconv.ParseInt(v, 10, 64)
			if pth, known := c.SubvolIDs[id]; err == nil && known {
				changed = true
				if !hasSubvol {
					out = append(out, "subvol=/"+strings.TrimPrefix(pth, "/"))
				}
				continue
			}
		}
		out = append(out, p)
	}
	if !changed {
		return opts
	}
	return strings.Join(out, ",")
}

// FixCrypttab rewrites /etc/crypttab: device names to UUID=; plain
// dm-crypt entries (swap, tmp, plain, or a random key) always to their
// PARTUUID= or by-id source, so a first start on new hardware never
// formats another disk that now has the old name.
func FixCrypttab(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	for n, line := range lines(in) {
		if isComment(line) {
			out.WriteString(line)
			continue
		}
		f := fieldSpans(line)
		if len(f) < 2 {
			out.WriteString(line)
			continue
		}
		name, src := line[f[0].a:f[0].b], line[f[1].a:f[1].b]
		if stable, ok := c.PlainSources[name]; ok && stable != src {
			line = replaceSpan(line, f[1], stable)
			changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "crypttab_plain", From: src, To: stable})
		} else if ref, ok := c.device(src); ok {
			line = replaceSpan(line, f[1], ref)
			changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "crypttab_source", From: src, To: ref})
		}
		out.WriteString(line)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

var reMDNum = regexp.MustCompile(`\b(num-devices|spares)=([0-9]+)\b`)

// FixMdadmConf rewrites mdadm.conf: DEVICE lines with device names become
// "DEVICE partitions containers"; ARRAY lines keep their UUID and get the
// actual num-devices= and spares=.
func FixMdadmConf(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	for n, line := range lines(in) {
		if isComment(line) {
			out.WriteString(line)
			continue
		}
		f := fieldSpans(line)
		if len(f) == 0 {
			out.WriteString(line)
			continue
		}
		word := line[f[0].a:f[0].b]
		end := line[len(strings.TrimRight(line, "\r\n")):]
		switch strings.ToUpper(word) {
		case "DEVICE":
			names := false
			for _, s := range f[1:] {
				names = names || strings.HasPrefix(line[s.a:s.b], "/dev/")
			}
			if names {
				nl := "DEVICE partitions containers" + end
				changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "mdadm_device", From: strings.TrimRight(line, "\r\n"), To: "DEVICE partitions containers"})
				line = nl
			}
		case "ARRAY":
			var uuid string
			for _, s := range f[1:] {
				if v, ok := strings.CutPrefix(line[s.a:s.b], "UUID="); ok {
					uuid = normUUID(v)
				}
			}
			if cnt, ok := c.MD[uuid]; ok && uuid != "" {
				nl := reMDNum.ReplaceAllStringFunc(line, func(m string) string {
					k, _, _ := strings.Cut(m, "=")
					if k == "spares" {
						return k + "=" + itoa(cnt.Spares)
					}
					return k + "=" + itoa(cnt.Devices)
				})
				if nl != line {
					changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "mdadm_array", From: strings.TrimRight(line, "\r\n"), To: strings.TrimRight(nl, "\r\n")})
					line = nl
				}
			}
		}
		out.WriteString(line)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

var reCmdParam = regexp.MustCompile(`(^|[\s"'=])(root|resume|cryptdevice|cryptkey|md|rd\.luks\.key|resume_offset)=([^\s"']*)`)

// FixKernelCmdline rewrites kernel parameters wherever they are written:
// /etc/default/grub (GRUB_CMDLINE_LINUX*), /etc/kernel/cmdline, the
// options lines of BLS and systemd-boot entries. root= and resume= get
// UUID=; the device parts of cryptdevice=, cryptkey= and rd.luks.key= too;
// md= gets PARTUUID= members; resume_offset= the new offset when known.
// rd.md.uuid, rd.luks.uuid and rd.lvm.lv stay (their values do not change).
func FixKernelCmdline(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	for n, line := range lines(in) {
		if isComment(line) {
			out.WriteString(line)
			continue
		}
		nl := reCmdParam.ReplaceAllStringFunc(line, func(m string) string {
			sub := reCmdParam.FindStringSubmatch(m)
			lead, key, val := sub[1], sub[2], sub[3]
			nv := val
			switch key {
			case "root", "resume":
				if ref, ok := c.device(val); ok {
					nv = ref
				}
			case "cryptdevice", "cryptkey", "rd.luks.key":
				parts := strings.Split(val, ":")
				for i, p := range parts {
					if ref, ok := c.device(p); ok {
						parts[i] = ref
					}
				}
				nv = strings.Join(parts, ":")
			case "md":
				parts := strings.Split(val, ",")
				for i, p := range parts {
					if ref, ok := c.PartUUIDs[p]; ok {
						parts[i] = ref
					}
				}
				nv = strings.Join(parts, ",")
			case "resume_offset":
				if c.ResumeOffset != nil {
					nv = strconv.FormatInt(*c.ResumeOffset, 10)
				}
			}
			if nv != val {
				changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "cmdline_" + key, From: key + "=" + val, To: key + "=" + nv})
			}
			return lead + key + "=" + nv
		})
		out.WriteString(nl)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

// FixResumeConf rewrites /etc/initramfs-tools/conf.d/resume: RESUME=<dev>
// to UUID=.
func FixResumeConf(in []byte, c FixupContext) ([]byte, []FixupChange) {
	return fixAssignments(in, c, "RESUME", "resume", func(ref string) string { return ref })
}

// FixMountUnit rewrites What=/dev/… of systemd .mount and .swap units to
// /dev/disk/by-uuid/… (or by-partuuid).
func FixMountUnit(in []byte, c FixupContext) ([]byte, []FixupChange) {
	return fixAssignments(in, c, "What", "mount_unit", byPath)
}

func fixAssignments(in []byte, c FixupContext, key, rule string, form func(string) string) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	for n, line := range lines(in) {
		t := strings.TrimLeft(line, " \t")
		if v, ok := strings.CutPrefix(t, key+"="); ok && !isComment(line) {
			body := strings.TrimRight(v, "\r\n")
			end := v[len(body):]
			val := strings.Trim(body, `"`)
			if ref, ok := c.device(val); ok {
				quoted := strings.HasPrefix(body, `"`)
				nv := form(ref)
				if quoted {
					nv = `"` + nv + `"`
				}
				changes = append(changes, FixupChange{Line: int64(n + 1), Rule: rule, From: val, To: form(ref)})
				line = line[:len(line)-len(t)] + key + "=" + nv + end
			}
		}
		out.WriteString(line)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

var reDevToken = regexp.MustCompile(`/dev/[A-Za-z0-9/_.:+-]+`)

// FixDracutAddDevice rewrites add_device+=" /dev/… " in dracut.conf.d to
// /dev/disk/by-uuid/….
func FixDracutAddDevice(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	for n, line := range lines(in) {
		if !isComment(line) && strings.Contains(line, "add_device") {
			nl := reDevToken.ReplaceAllStringFunc(line, func(dev string) string {
				if ref, ok := c.device(dev); ok {
					changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "dracut_add_device", From: dev, To: byPath(ref)})
					return byPath(ref)
				}
				return dev
			})
			line = nl
		}
		out.WriteString(line)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

var (
	reLVMFilter  = regexp.MustCompile(`^(\s*)(global_filter|filter)(\s*=\s*)(.*?)(\s*)$`)
	reKernelName = regexp.MustCompile(`/dev/(sd|hd|vd|xvd|nvme|mmcblk|md)[a-z0-9]`)
	reMixedLine  = regexp.MustCompile(`^(\s*allow_mixed_block_sizes\s*=\s*)0(\s*)$`)
)

// FixLVMFilter rewrites filter and global_filter lines of lvm.conf that
// name kernel devices into an accept list of the PVs by UUID
// (/dev/disk/by-id/lvm-pv-uuid-…) and sets allow_mixed_block_sizes = 1
// when the plan needs it. A filter spread over several lines is left as
// it is: the plan cannot see lvm.conf, recover (M4) reports it.
func FixLVMFilter(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	sawMixed := false
	for n, line := range lines(in) {
		body := strings.TrimRight(line, "\r\n")
		end := line[len(body):]
		if !isComment(line) {
			if m := reLVMFilter.FindStringSubmatch(body); m != nil && reKernelName.MatchString(m[4]) &&
				strings.HasPrefix(strings.TrimSpace(m[4]), "[") && strings.HasSuffix(strings.TrimSpace(m[4]), "]") && len(c.PVUUIDs) > 0 {
				var accept []string
				for _, u := range c.PVUUIDs {
					accept = append(accept, `"a|^/dev/disk/by-id/lvm-pv-uuid-`+regexp.QuoteMeta(u)+`$|"`)
				}
				val := "[ " + strings.Join(append(accept, `"r|.*|"`), ", ") + " ]"
				changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "lvm_" + m[2], From: m[4], To: val})
				line = m[1] + m[2] + m[3] + val + m[5] + end
			} else if m := reMixedLine.FindStringSubmatch(body); m != nil {
				sawMixed = true
				if c.AllowMixedBlockSizes {
					changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "lvm_mixed_block_sizes", From: "0", To: "1"})
					line = m[1] + "1" + m[2] + end
				}
			} else if strings.Contains(body, "allow_mixed_block_sizes") {
				sawMixed = true
			}
		}
		out.WriteString(line)
	}
	res := out.String()
	if c.AllowMixedBlockSizes && !sawMixed {
		if i := strings.Index(res, "devices {"); i >= 0 {
			j := i + len("devices {")
			res = res[:j] + "\n\tallow_mixed_block_sizes = 1" + res[j:]
		} else {
			if !strings.HasSuffix(res, "\n") && res != "" {
				res += "\n"
			}
			res += "devices {\n\tallow_mixed_block_sizes = 1\n}\n"
		}
		changes = append(changes, FixupChange{Rule: "lvm_mixed_block_sizes", From: "", To: "1"})
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(res), changes
}

// FixGrubInstallDevices rewrites the GRUB install devices: in the debconf
// database the values of grub-pc/install_devices and
// grub-efi/install_devices, in SUSE's /etc/default/grub_installdevice the
// device lines (keywords such as activate stay).
func FixGrubInstallDevices(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	if strings.Contains(string(in), "Name: grub-") {
		current := ""
		for n, line := range lines(in) {
			body := strings.TrimRight(line, "\r\n")
			end := line[len(body):]
			if v, ok := strings.CutPrefix(body, "Name: "); ok {
				current = v
			} else if body == "" {
				current = ""
			}
			if v, ok := strings.CutPrefix(body, "Value: "); ok {
				var list []string
				switch current {
				case "grub-pc/install_devices":
					list = c.BIOSInstallDevices
				case "grub-efi/install_devices":
					list = c.ESPInstallDevices
				}
				if list != nil {
					nv := strings.Join(list, ", ")
					if nv != v {
						changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "debconf_" + strings.TrimPrefix(current, "grub-"), From: v, To: nv})
						line = "Value: " + nv + end
					}
				}
			}
			out.WriteString(line)
		}
	} else {
		wrote := false
		for n, line := range lines(in) {
			body := strings.TrimSpace(line)
			if strings.HasPrefix(body, "/dev/") {
				if !wrote {
					for _, d := range c.BIOSInstallDevices {
						out.WriteString(d + "\n")
					}
					wrote = true
				}
				if !hasString(c.BIOSInstallDevices, body) {
					changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "grub_installdevice", From: body, To: strings.Join(c.BIOSInstallDevices, " ")})
				}
				continue
			}
			out.WriteString(line)
		}
		if len(changes) == 0 && !sameStringsAsDevices(in, c.BIOSInstallDevices) {
			changes = append(changes, FixupChange{Rule: "grub_installdevice", To: strings.Join(c.BIOSInstallDevices, " ")})
		}
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

func sameStringsAsDevices(in []byte, devs []string) bool {
	var have []string
	for _, line := range lines(in) {
		if b := strings.TrimSpace(line); strings.HasPrefix(b, "/dev/") {
			have = append(have, b)
		}
	}
	if len(have) != len(devs) {
		return false
	}
	for i := range have {
		if have[i] != devs[i] {
			return false
		}
	}
	return true
}

// FixProxmoxBootUUIDs removes the UUIDs of ESPs that are not restored
// from /etc/kernel/proxmox-boot-uuids.
func FixProxmoxBootUUIDs(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	missing := map[string]bool{}
	for _, u := range c.MissingESPs {
		missing[strings.ToUpper(u)] = true
	}
	for n, line := range lines(in) {
		body := strings.TrimSpace(line)
		uuid, _, _ := strings.Cut(body, ",")
		if body != "" && missing[strings.ToUpper(uuid)] {
			changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "proxmox_boot_uuids", From: body})
			continue
		}
		out.WriteString(line)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

var reMACText = regexp.MustCompile(`(?i)\b[0-9a-f]{2}(:[0-9a-f]{2}){5}\b`)

// FixMACs replaces old MAC addresses by the new ones in network
// configurations (netplan, NetworkManager, ifcfg, networkd); in udev's
// 70-persistent-net.rules the rules of old MACs are removed instead (the
// new card then keeps its own name or the .link file renames it).
func FixMACs(in []byte, c FixupContext) ([]byte, []FixupChange) {
	var out strings.Builder
	var changes []FixupChange
	udev := strings.Contains(string(in), "SUBSYSTEM==\"net\"")
	all := lines(in)
	for n := 0; n < len(all); n++ {
		line := all[n]
		if isComment(line) && !(udev && n+1 < len(all) && macRule(all[n+1], c)) {
			out.WriteString(line)
			continue
		}
		if udev {
			if macRule(line, c) {
				changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "persistent_net_removed", From: strings.TrimRight(line, "\r\n")})
				continue
			}
			if isComment(line) {
				// The comment above a removed rule goes with it.
				continue
			}
			out.WriteString(line)
			continue
		}
		nl := reMACText.ReplaceAllStringFunc(line, func(mac string) string {
			repl, ok := c.MACs[strings.ToLower(mac)]
			if !ok || strings.EqualFold(repl, mac) {
				return mac
			}
			if mac == strings.ToUpper(mac) {
				repl = strings.ToUpper(repl)
			} else {
				repl = strings.ToLower(repl)
			}
			changes = append(changes, FixupChange{Line: int64(n + 1), Rule: "mac", From: mac, To: repl})
			return repl
		})
		out.WriteString(nl)
	}
	if len(changes) == 0 {
		return in, nil
	}
	return []byte(out.String()), changes
}

// macRule: a udev rule line that names an old MAC that changes.
func macRule(line string, c FixupContext) bool {
	if isComment(line) {
		return false
	}
	for _, mac := range reMACText.FindAllString(line, -1) {
		if repl, ok := c.MACs[strings.ToLower(mac)]; ok && !strings.EqualFold(repl, mac) {
			return true
		}
	}
	return false
}

// DeviceMapAction returns the GRUB device.map files the plan deletes
// (GRUB writes a new one when it needs it; an old one gives "disk hd0 not
// found").
func DeviceMapAction(m *Manifest) []string {
	if m == nil || m.Linux == nil || !m.Linux.Bootloader.DeviceMap {
		return nil
	}
	cfg := deref(m.Linux.Bootloader.GrubCfg)
	if strings.Contains(cfg, "grub2") {
		return []string{"/boot/grub2/device.map"}
	}
	return []string{"/boot/grub/device.map"}
}

// NewFixupContext builds the device names, subvolume ids, md counts, PV
// UUIDs and plain dm-crypt sources from a manifest. recover adds the
// MACs, the install devices and the missing ESPs of its plan.
func NewFixupContext(m *Manifest) FixupContext {
	c := FixupContext{DeviceNames: map[string]string{}, PartUUIDs: map[string]string{}, SubvolIDs: map[int64]string{},
		MACs: map[string]string{}, PlainSources: map[string]string{}, MD: map[string]MDCount{}, NotRestored: map[string]bool{}}
	if m == nil || m.Linux == nil {
		return c
	}
	x := newLayoutModel(m, nil, "skip")
	l := m.Linux
	refOf := func(r BlockRef) string {
		key := r.key()
		if fs := x.fsOn[key]; fs != nil && fs.UUID != nil {
			return "UUID=" + *fs.UUID
		}
		if lk := x.luksOn[key]; lk != nil {
			return "UUID=" + lk.UUID
		}
		if s := x.swapOn[key]; s != nil && s.UUID != nil {
			return "UUID=" + *s.UUID
		}
		return ""
	}
	partUUID := func(d *Disk, p *Partition) string {
		if d.Table.Type == "dos" {
			id := strings.ToLower(strings.TrimPrefix(d.Table.ID, "0x"))
			for len(id) < 8 {
				id = "0" + id
			}
			return "PARTUUID=" + id + "-" + leftPad(strconv.FormatInt(p.Number, 16), 2)
		}
		if p.UUID != nil {
			return "PARTUUID=" + strings.ToLower(*p.UUID)
		}
		return ""
	}
	for i := range l.Disks {
		d := &l.Disks[i]
		dev := "/dev/" + d.KName
		if ref := refOf(DiskRef(d.ID)); ref != "" {
			c.DeviceNames[dev] = ref
		}
		if d.Table == nil {
			continue
		}
		for j := range d.Table.Partitions {
			p := &d.Table.Partitions[j]
			pdev := partPath(dev, p.Number)
			pu := partUUID(d, p)
			if pu != "" {
				c.PartUUIDs[pdev] = pu
			}
			if ref := refOf(PartRef(d.ID, p.Number)); ref != "" {
				c.DeviceNames[pdev] = ref
			} else if pu != "" {
				c.DeviceNames[pdev] = pu
			}
		}
	}
	for _, md := range l.MD {
		if ref := refOf(MDRef(md.ID)); ref != "" {
			c.DeviceNames["/dev/"+md.KName] = ref
			if md.Name != nil {
				n := *md.Name
				if i := strings.LastIndexByte(n, ':'); i >= 0 {
					n = n[i+1:]
				}
				c.DeviceNames["/dev/md/"+n] = ref
			}
		}
		c.MD[normUUID(md.UUID)] = MDCount{Devices: md.RaidDevices, Spares: int64(len(md.Spares))}
	}
	for _, e := range l.Fstab {
		if e.Resolved != nil && e.Resolved.FS != nil && strings.HasPrefix(e.Source, "/dev/") && !strings.HasPrefix(e.Source, "/dev/mapper/") {
			if fs := x.fs[*e.Resolved.FS]; fs != nil && fs.UUID != nil && len(fs.Devices) > 0 && fs.Devices[0].Kind != RefLV {
				if _, ok := c.DeviceNames[e.Source]; !ok && (strings.HasPrefix(e.Source, "/dev/disk/by-path/") || strings.HasPrefix(e.Source, "/dev/disk/by-id/")) {
					c.DeviceNames[e.Source] = "UUID=" + *fs.UUID
				}
			}
		}
	}
	for _, fs := range l.Filesystems {
		if fs.Btrfs != nil {
			for _, s := range fs.Btrfs.Subvolumes {
				c.SubvolIDs[s.ID] = s.Path
			}
		}
	}
	for _, pc := range l.PlainCrypt {
		name := pc.MappedName
		if pc.CrypttabName != nil {
			name = *pc.CrypttabName
		}
		if pc.PartUUID != nil {
			c.PlainSources[name] = "PARTUUID=" + *pc.PartUUID
		} else if pc.Device.Kind == RefPartition {
			if d := x.disks[pc.Device.Disk]; d != nil && d.Table != nil {
				if p := x.parts[pc.Device.key()]; p != nil {
					if pu := partUUID(d, p); pu != "" {
						c.PlainSources[name] = pu
					}
				}
			}
		} else if pc.Device.Kind == RefDisk {
			if d := x.disks[pc.Device.Disk]; d != nil && d.WWN != nil {
				c.PlainSources[name] = "/dev/disk/by-id/wwn-" + strings.ToLower(*d.WWN)
			}
		}
	}
	for _, pv := range l.LVM.PVs {
		c.PVUUIDs = append(c.PVUUIDs, pv.UUID)
	}
	c.AllowMixedBlockSizes = l.LVM.AllowMixedBlockSizes
	return c
}

func leftPad(s string, n int) string {
	for len(s) < n {
		s = "0" + s
	}
	return s
}

// PlannedFixups returns the files the plan rewrites and the rules for
// each (path and rules only, no content).
func PlannedFixups(m *Manifest) []PlannedFixup {
	if m == nil || m.Linux == nil {
		return nil
	}
	l := m.Linux
	var out []PlannedFixup
	add := func(p string, rules ...string) {
		for i := range out {
			if out[i].Path == p {
				out[i].Rules = uniqueSorted(append(out[i].Rules, rules...))
				return
			}
		}
		out = append(out, PlannedFixup{Path: p, Rules: uniqueSorted(rules)})
	}
	if len(l.Fstab) > 0 {
		add("/etc/fstab", "fstab")
	}
	crypttab := len(l.PlainCrypt) > 0
	for _, c := range l.LUKS {
		crypttab = crypttab || c.CrypttabName != nil
	}
	if crypttab {
		add("/etc/crypttab", "crypttab")
	}
	if len(l.MD) > 0 {
		add("/etc/mdadm/mdadm.conf", "mdadm")
		add("/etc/mdadm.conf", "mdadm")
	}
	if l.Bootloader.Kind == "grub" {
		add("/etc/default/grub", "cmdline")
	}
	if l.Bootloader.Kind == "systemd-boot" || l.Initramfs.UKIPresets || l.Initramfs.KernelInstallLayout != nil {
		add("/etc/kernel/cmdline", "cmdline")
	}
	if l.Bootloader.BLS || l.Bootloader.Kind == "systemd-boot" {
		add("/boot/loader/entries/*.conf", "cmdline")
	}
	if deref(l.Initramfs.Generator) == "initramfs-tools" {
		for _, s := range l.Swap {
			_ = s
			add("/etc/initramfs-tools/conf.d/resume", "resume")
			break
		}
	}
	for _, e := range l.Fstab {
		if e.Origin == "unit" && e.Unit != nil && (strings.HasSuffix(*e.Unit, ".mount") || strings.HasSuffix(*e.Unit, ".swap")) && !strings.Contains(*e.Unit, "/") {
			add(path.Join("/etc/systemd/system", *e.Unit), "mount_unit")
		}
	}
	if len(l.Initramfs.AddDevices) > 0 {
		add("/etc/dracut.conf.d/*.conf", "dracut_add_device")
	}
	if l.LVM.FilterHasDeviceNames || l.LVM.AllowMixedBlockSizes {
		add("/etc/lvm/lvm.conf", "lvm_filter")
	}
	if l.LVM.UseDevicesFile {
		add("/etc/lvm/devices/system.devices", "set_aside")
	}
	if l.Firmware.Mode == "bios" || len(l.Bootloader.ESPs) > 1 {
		if l.OS.ID == "opensuse-leap" || l.OS.ID == "opensuse-tumbleweed" || l.OS.ID == "sles" || hasString(l.OS.IDLike, "suse") {
			add("/etc/default/grub_installdevice", "grub_install_devices")
		} else {
			add("/var/cache/debconf/config.dat", "grub_install_devices")
		}
	}
	if l.Bootloader.ProxmoxBootTool {
		add("/etc/kernel/proxmox-boot-uuids", "proxmox_boot_uuids")
	}
	for _, nc := range l.NetConfigs {
		add(nc.Path, "mac")
	}
	for _, p := range DeviceMapAction(m) {
		add(p, "delete")
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}
