// Package sysparse reads Linux system files and tool output shared by the
// bare-metal capture and the file system snapshots: mountinfo, fstab and
// systemd mount units, crypttab, /proc/swaps, os-release, `lvm fullreport`
// and the btrfs subvolume list and usage. It only parses; nothing here
// touches the system, so it builds and is tested on every platform.
package sysparse

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Unescape decodes the octal escapes the kernel and fstab use for
// whitespace and backslashes in paths (\040 space, \011 tab, \012 newline,
// \134 backslash).
func Unescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			n, _ := strconv.ParseUint(s[i+1:i+4], 8, 8)
			b.WriteByte(byte(n))
			i += 3
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isOctal(c byte) bool { return c >= '0' && c <= '7' }

// MountInfo is one line of /proc/self/mountinfo.
type MountInfo struct {
	ID, ParentID int
	MajMin       string
	// Root is the path within the file system that is mounted (a bind
	// mount or btrfs subvolume: not "/").
	Root   string
	Target string
	// Options are the per-mount options, SuperOptions those of the file system.
	Options      string
	Optional     []string
	FSType       string
	Source       string
	SuperOptions string
}

// Option returns the value of name in the mount or super options (name=value), or "".
func (m MountInfo) Option(name string) (string, bool) {
	for _, set := range []string{m.Options, m.SuperOptions} {
		for _, o := range strings.Split(set, ",") {
			if o == name {
				return "", true
			}
			if v, ok := strings.CutPrefix(o, name+"="); ok {
				return v, true
			}
		}
	}
	return "", false
}

// ParseMountinfo parses /proc/self/mountinfo (proc(5)).
func ParseMountinfo(data []byte) ([]MountInfo, error) {
	var out []MountInfo
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	line := 0
	for sc.Scan() {
		line++
		f := strings.Fields(sc.Text())
		if len(f) == 0 {
			continue
		}
		sep := -1
		for i := 6; i < len(f); i++ {
			if f[i] == "-" {
				sep = i
				break
			}
		}
		if len(f) < 10 || sep < 0 || sep+3 > len(f) {
			return nil, fmt.Errorf("mountinfo line %d: malformed", line)
		}
		id, err1 := strconv.Atoi(f[0])
		parent, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("mountinfo line %d: bad ids", line)
		}
		m := MountInfo{ID: id, ParentID: parent, MajMin: f[2], Root: Unescape(f[3]), Target: Unescape(f[4]),
			Options: f[5], Optional: append([]string(nil), f[6:sep]...), FSType: f[sep+1], Source: Unescape(f[sep+2])}
		if sep+3 < len(f) {
			m.SuperOptions = f[sep+3]
		}
		out = append(out, m)
	}
	return out, sc.Err()
}

// FstabLine is one entry of /etc/fstab.
type FstabLine struct {
	Source, Target, Type, Options string
	Freq, Pass                    int
	Line                          int
}

// HasOption reports whether the comma separated options contain name (or name=...).
func HasOption(options, name string) bool {
	_, ok := OptionValue(options, name)
	return ok
}

// OptionValue returns the value of name=value in comma separated options.
func OptionValue(options, name string) (string, bool) {
	for _, o := range strings.Split(options, ",") {
		if o == name {
			return "", true
		}
		if v, ok := strings.CutPrefix(o, name+"="); ok {
			return v, true
		}
	}
	return "", false
}

// ParseFstab parses fstab(5): comments, blank lines, octal escapes; missing
// fields take their defaults (options "defaults", freq and pass 0).
func ParseFstab(data []byte) []FstabLine {
	var out []FstabLine
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	n := 0
	for sc.Scan() {
		n++
		t := strings.TrimSpace(sc.Text())
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		f := strings.Fields(t)
		if len(f) < 2 {
			continue
		}
		e := FstabLine{Source: Unescape(f[0]), Target: Unescape(f[1]), Type: "auto", Options: "defaults", Line: n}
		if len(f) > 2 {
			e.Type = f[2]
		}
		if len(f) > 3 {
			e.Options = f[3]
		}
		if len(f) > 4 {
			e.Freq, _ = strconv.Atoi(f[4])
		}
		if len(f) > 5 {
			e.Pass, _ = strconv.Atoi(f[5])
		}
		out = append(out, e)
	}
	return out
}

// Unit is what a systemd .mount, .swap or .automount unit declares.
type Unit struct {
	What, Where, Type, Options string
	// Section is Mount, Swap or Automount.
	Section string
}

// ParseSystemdMountUnit reads the [Mount], [Swap] or [Automount] section.
func ParseSystemdMountUnit(data []byte) (Unit, bool) {
	var u Unit
	section := ""
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		if t == "" || t[0] == '#' || t[0] == ';' {
			continue
		}
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			section = t[1 : len(t)-1]
			continue
		}
		if section != "Mount" && section != "Swap" && section != "Automount" {
			continue
		}
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		u.Section = section
		switch k {
		case "What":
			u.What = v
		case "Where":
			u.Where = v
		case "Type":
			u.Type = v
		case "Options":
			u.Options = v
		}
	}
	return u, u.Section != "" && (u.What != "" || u.Where != "")
}

// CrypttabLine is one entry of /etc/crypttab.
type CrypttabLine struct {
	Name, Device, KeyFile, Options string
}

// ParseCrypttab parses crypttab(5).
func ParseCrypttab(data []byte) []CrypttabLine {
	var out []CrypttabLine
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		f := strings.Fields(t)
		if len(f) < 2 {
			continue
		}
		e := CrypttabLine{Name: f[0], Device: Unescape(f[1])}
		if len(f) > 2 {
			e.KeyFile = Unescape(f[2])
		}
		if len(f) > 3 {
			e.Options = f[3]
		}
		out = append(out, e)
	}
	return out
}

// SwapLine is one line of /proc/swaps.
type SwapLine struct {
	Filename string
	Type     string
	SizeKiB  int64
	UsedKiB  int64
	Priority string
}

// ParseProcSwaps parses /proc/swaps.
func ParseProcSwaps(data []byte) []SwapLine {
	var out []SwapLine
	sc := bufio.NewScanner(bytes.NewReader(data))
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 5 {
			continue
		}
		size, _ := strconv.ParseInt(f[2], 10, 64)
		used, _ := strconv.ParseInt(f[3], 10, 64)
		out = append(out, SwapLine{Filename: Unescape(f[0]), Type: f[1], SizeKiB: size, UsedKiB: used, Priority: f[4]})
	}
	return out
}

// ParseOSRelease parses os-release(5) (also /etc/default/keyboard and
// other shell-style KEY=value files without expansion).
func ParseOSRelease(data []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		t = strings.TrimPrefix(t, "export ")
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if i := strings.Index(v, " #"); i >= 0 && !strings.HasPrefix(v, `"`) && !strings.HasPrefix(v, `'`) {
			v = strings.TrimSpace(v[:i])
		}
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			q := v[0]
			v = v[1 : len(v)-1]
			if q == '"' {
				v = strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\$`, `$`, "\\`", "`").Replace(v)
			}
		}
		out[k] = v
	}
	return out
}

// LVMReport is `lvm fullreport --reportformat json --units b --nosuffix`:
// one entry per volume group (and one for orphan PVs). Values stay text.
type LVMReport struct {
	VGs []LVMRow
	PVs []LVMRow
	LVs []LVMRow
	// Segs are the LV segments (segtype, stripes, chunk size per lv_uuid).
	Segs []LVMRow
}

// LVMRow is one row of a report.
type LVMRow map[string]string

// Int returns the field as an integer (0 when empty or not a number).
func (r LVMRow) Int(k string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(r[k]), 10, 64)
	return n
}

// Float returns a percentage field (data_percent and the like).
func (r LVMRow) Float(k string) (float64, bool) {
	s := strings.TrimSpace(r[k])
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

// ParseLVMFullReport parses the JSON report of `lvm fullreport` (and of
// `lvs --reportformat json`, which has only "lv").
func ParseLVMFullReport(data []byte) (*LVMReport, error) {
	var raw struct {
		Report []map[string][]map[string]any `json:"report"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("lvm report: %w", err)
	}
	if raw.Report == nil {
		return nil, errors.New("lvm report: no report")
	}
	rows := func(in []map[string]any) []LVMRow {
		var out []LVMRow
		for _, m := range in {
			r := LVMRow{}
			for k, v := range m {
				switch t := v.(type) {
				case string:
					r[k] = t
				case float64:
					r[k] = strconv.FormatFloat(t, 'f', -1, 64)
				case nil:
					r[k] = ""
				default:
					r[k] = fmt.Sprint(t)
				}
			}
			out = append(out, r)
		}
		return out
	}
	rep := &LVMReport{}
	for _, part := range raw.Report {
		vgs, pvs, lvs, segs := rows(part["vg"]), rows(part["pv"]), rows(part["lv"]), rows(part["seg"])
		// fullreport has one entry per VG; its rows need not repeat the name.
		if len(vgs) == 1 {
			for _, set := range [][]LVMRow{pvs, lvs, segs} {
				for _, r := range set {
					if r["vg_name"] == "" {
						r["vg_name"] = vgs[0]["vg_name"]
					}
				}
			}
		}
		rep.VGs = append(rep.VGs, vgs...)
		rep.PVs = append(rep.PVs, pvs...)
		rep.LVs = append(rep.LVs, lvs...)
		rep.Segs = append(rep.Segs, segs...)
	}
	return rep, nil
}

// BtrfsSubvol is one line of `btrfs subvolume list -a -p -u -q`.
type BtrfsSubvol struct {
	ID, Gen, Parent, TopLevel int64
	ParentUUID                string
	UUID                      string
	// Path is relative to the top level (subvolid=5), "<FS_TREE>/" removed.
	Path string
}

// ParseBtrfsSubvolumeList parses `btrfs subvolume list -a -p -u -q <mnt>`.
func ParseBtrfsSubvolumeList(data []byte) ([]BtrfsSubvol, error) {
	var out []BtrfsSubvol
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		t := sc.Text()
		if strings.TrimSpace(t) == "" {
			continue
		}
		i := strings.Index(t, " path ")
		if i < 0 {
			return nil, fmt.Errorf("btrfs subvolume list: no path in %q", t)
		}
		var s BtrfsSubvol
		s.Path = strings.TrimPrefix(t[i+len(" path "):], "<FS_TREE>/")
		f := strings.Fields(t[:i])
		for j := 0; j < len(f); j++ {
			next := func() string {
				if j+1 < len(f) {
					j++
					return f[j]
				}
				return ""
			}
			switch f[j] {
			case "ID":
				s.ID, _ = strconv.ParseInt(next(), 10, 64)
			case "gen":
				s.Gen, _ = strconv.ParseInt(next(), 10, 64)
			case "parent":
				s.Parent, _ = strconv.ParseInt(next(), 10, 64)
			case "top":
				if next() == "level" {
					s.TopLevel, _ = strconv.ParseInt(next(), 10, 64)
				}
			case "parent_uuid":
				s.ParentUUID = next()
			case "uuid":
				s.UUID = next()
			case "received_uuid", "cgen":
				next()
			case "otime":
				// "otime <date> <time>"
				next()
				next()
			}
		}
		if s.ParentUUID == "-" {
			s.ParentUUID = ""
		}
		if s.ID == 0 {
			return nil, fmt.Errorf("btrfs subvolume list: no id in %q", t)
		}
		out = append(out, s)
	}
	return out, sc.Err()
}

// BtrfsUsage is what `btrfs filesystem usage --raw <mnt>` reports.
type BtrfsUsage struct {
	DeviceSize      int64
	DeviceAllocated int64
	Unallocated     int64
	Used            int64
	FreeEstimated   int64
	// Profiles of the block groups, lower case (single, dup, raid1 ...).
	DataProfile, MetadataProfile, SystemProfile string
}

// ParseBtrfsUsageRaw parses `btrfs filesystem usage --raw`.
func ParseBtrfsUsageRaw(data []byte) (BtrfsUsage, error) {
	var u BtrfsUsage
	seen := false
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		k, v, ok := strings.Cut(t, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		first := v
		if f := strings.Fields(v); len(f) > 0 {
			first = f[0]
		}
		num := func() int64 { n, _ := strconv.ParseInt(first, 10, 64); return n }
		switch {
		case k == "Device size":
			u.DeviceSize, seen = num(), true
		case k == "Device allocated":
			u.DeviceAllocated = num()
		case k == "Device unallocated":
			u.Unallocated = num()
		case k == "Used":
			u.Used = num()
		case k == "Free (estimated)":
			u.FreeEstimated = num()
		case strings.HasPrefix(k, "Data,"):
			u.DataProfile = strings.ToLower(strings.TrimPrefix(k, "Data,"))
		case strings.HasPrefix(k, "Metadata,"):
			u.MetadataProfile = strings.ToLower(strings.TrimPrefix(k, "Metadata,"))
		case strings.HasPrefix(k, "System,"):
			u.SystemProfile = strings.ToLower(strings.TrimPrefix(k, "System,"))
		}
	}
	if !seen {
		return u, errors.New("btrfs filesystem usage: no device size")
	}
	return u, nil
}
