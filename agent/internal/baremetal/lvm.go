package baremetal

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// lvmFacts is the LVM report of the capture.
type lvmFacts struct {
	rep *sysparse.LVMReport
}

// lvmReportArgs is the report command (docs/BAREMETAL.md, 4.1).
var lvmReportArgs = []string{"fullreport", "--reportformat", "json", "--units", "b", "--nosuffix"}

var reDeviceNameFilter = regexp.MustCompile(`/dev/(sd|hd|vd|xvd|nvme|mmcblk)`)

// captureLVM reads `lvm fullreport`, the device settings from lvmconfig and
// the devices file, and (on the machine) the metadata with vgcfgbackup for
// raw/<vg>.vg. Nothing is called when the machine has no PV.
func captureLVM(c *capture) error {
	hasPV := false
	for _, n := range c.nodes {
		if n.fstype() == "LVM2_member" || n.typ() == "lvm" {
			hasPV = true
			break
		}
	}
	if !hasPV {
		return nil
	}
	out, err := c.run("lvm", lvmReportArgs...)
	if err != nil {
		return err
	}
	rep, err := sysparse.ParseLVMFullReport(out)
	if err != nil {
		return err
	}
	c.lvmReport = &lvmFacts{rep: rep}
	segs := map[string]sysparse.LVMRow{}
	for _, s := range rep.Segs {
		if _, ok := segs[s["lv_uuid"]]; !ok {
			segs[s["lv_uuid"]] = s
		}
	}
	// LV nodes by kernel major:minor, to name lsblk's devices.
	for _, lv := range rep.LVs {
		if mm := lv["lv_kernel_major"] + ":" + lv["lv_kernel_minor"]; lv["lv_kernel_major"] != "" && lv["lv_kernel_major"] != "-1" {
			if n := c.byMajMin[mm]; n != nil {
				c.lvOf[n] = [2]string{lv["vg_name"], lv["lv_name"]}
			}
		}
	}
	vgIndex := map[string]int{}
	for _, vg := range rep.VGs {
		name := vg["vg_name"]
		if name == "" || len(c.l.LVM.VGs) >= maxVGs {
			continue
		}
		v := VolumeGroup{Name: clean(name), UUID: clean(vg["vg_uuid"]), ExtentBytes: vg.Int("vg_extent_size"),
			SizeBytes: vg.Int("vg_size"), FreeBytes: vg.Int("vg_free"), SystemID: cleanPtr(vg["vg_systemid"])}
		vgIndex[name] = len(c.l.LVM.VGs)
		c.l.LVM.VGs = append(c.l.LVM.VGs, v)
	}
	for _, lv := range rep.LVs {
		name := lv["lv_name"]
		vgName := lv["vg_name"]
		if vgName == "" {
			if full := lv["lv_full_name"]; strings.Contains(full, "/") {
				vgName = strings.SplitN(full, "/", 2)[0]
			}
		}
		i, ok := vgIndex[vgName]
		if !ok || strings.HasPrefix(name, "[") || !reLVMName.MatchString(name) {
			continue
		}
		seg := segs[lv["lv_uuid"]]
		out := LogicalVolume{Name: name, UUID: clean(lv["lv_uuid"]), Type: lvType(lv, seg), SizeBytes: lv.Int("lv_size"),
			Pool: cleanPtr(lv["pool_lv"]), Origin: cleanPtr(lv["origin"]), Tags: splitTags(lv["lv_tags"]),
			Active: lv["lv_active"] == "active" || (len(lv["lv_attr"]) > 4 && lv["lv_attr"][4] == 'a')}
		if seg != nil {
			if x := seg.Int("stripes"); x > 0 {
				out.Stripes = &x
			}
			if x := seg.Int("stripe_size"); x > 0 {
				out.StripeBytes = &x
			}
			if x := seg.Int("chunk_size"); x > 0 {
				out.ChunkBytes = &x
			}
		}
		if x := lv.Int("lv_metadata_size"); x > 0 {
			out.MetadataBytes = &x
		}
		if out.Type == "thin" {
			v := out.SizeBytes
			out.VirtualBytes = &v
		}
		c.l.LVM.VGs[i].LVs = append(c.l.LVM.VGs[i].LVs, out)
	}
	for _, pv := range rep.PVs {
		if len(c.l.LVM.PVs) >= maxPVs {
			break
		}
		n := c.nodeOfDevice(pv["pv_name"])
		ref, ok := c.refOf(n)
		if !ok {
			c.note(CodeCaptureFailed, "lvm", "physical volume "+pv["pv_name"]+" is not a known device", SeverityWarning)
			continue
		}
		c.l.LVM.PVs = append(c.l.LVM.PVs, PV{Device: ref, UUID: clean(pv["pv_uuid"]), SizeBytes: pv.Int("pv_size"), VG: cleanPtr(pv["vg_name"])})
	}
	// Device settings.
	if cfg, err := c.run("lvmconfig", "--typeconfig", "full", "devices/use_devicesfile", "devices/filter", "devices/global_filter", "devices/allow_mixed_block_sizes"); err == nil {
		kv := sysparse.ParseOSRelease(cfg)
		c.l.LVM.AllowMixedBlockSizes = kv["allow_mixed_block_sizes"] == "1"
		c.l.LVM.FilterHasDeviceNames = reDeviceNameFilter.MatchString(kv["filter"]) || reDeviceNameFilter.MatchString(kv["global_filter"])
		if kv["use_devicesfile"] == "1" {
			if b, ok := c.readHost("/etc/lvm/devices/system.devices"); ok {
				c.l.LVM.UseDevicesFile = true
				types := map[string]bool{}
				for _, line := range strings.Split(b, "\n") {
					for _, f := range strings.Fields(line) {
						if v, ok := strings.CutPrefix(f, "IDTYPE="); ok {
							types[clean(v)] = true
						}
					}
				}
				c.l.LVM.DevicesFileIDTypes = sortedKeys(types)
			}
		}
	} else {
		c.failed("lvmconfig", err)
	}
	if dir := c.o.VGBackupDir; dir != "" {
		if _, err := c.run("vgcfgbackup", "-f", filepath.Join(dir, "%s.vg")); err == nil {
			for _, vg := range c.l.LVM.VGs {
				if b, err := os.ReadFile(filepath.Join(dir, vg.Name+".vg")); err == nil {
					c.addRaw(vg.Name+".vg", b)
				}
			}
		}
	}
	return nil
}

func splitTags(s string) []string {
	out := []string{}
	for _, t := range strings.Split(s, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, clean(t))
		}
	}
	sort.Strings(out)
	return out
}

// lvType is the segment type of an LV (linear, striped, thin, thin-pool,
// raid1, cache, vdo, snapshot ...).
func lvType(lv, seg sysparse.LVMRow) string {
	attr := lv["lv_attr"]
	if len(attr) > 0 {
		switch attr[0] {
		case 's', 'S':
			return "snapshot"
		}
	}
	if seg != nil && seg["segtype"] != "" {
		return clean(seg["segtype"])
	}
	layout := lv["lv_layout"]
	switch {
	case strings.Contains(layout, "thin") && strings.Contains(layout, "pool"):
		return "thin-pool"
	case strings.Contains(layout, "thin"):
		return "thin"
	case layout != "":
		return clean(strings.Split(layout, ",")[0])
	}
	return "linear"
}

// markRawLVs sets LogicalVolume.Raw: an active LV that carries no file
// system, no swap, no PV and no LUKS header (guest disks, raw devices).
func markRawLVs(c *capture) {
	for n, v := range c.lvOf {
		if n.fstype() != "" || len(n.children) > 0 {
			continue
		}
		for i := range c.l.LVM.VGs {
			vg := &c.l.LVM.VGs[i]
			if vg.Name != v[0] {
				continue
			}
			for j := range vg.LVs {
				lv := &vg.LVs[j]
				if lv.Name == v[1] && lv.Active && lv.Type != "thin-pool" && lv.Type != "snapshot" && !hasTag(lv.Tags, "restow-agent-snapshot") {
					lv.Raw = true
				}
			}
		}
	}
}

func (c *capture) vg(name string) *VolumeGroup {
	for i := range c.l.LVM.VGs {
		if c.l.LVM.VGs[i].Name == name {
			return &c.l.LVM.VGs[i]
		}
	}
	return nil
}

var _ = fmt.Sprintf
