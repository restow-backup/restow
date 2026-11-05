package baremetal

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// captureMD reads each md array: `mdadm --detail --export` for level,
// metadata, UUID, name and member roles, `mdadm --detail` (text, for raw/),
// and /sys/block/mdX/md for state, chunk, layout, bitmap, journal and the
// member flags (write-mostly, spare).
func captureMD(c *capture) error {
	var ids []*blkNode
	for n := range c.mdOf {
		ids = append(ids, n)
	}
	sort.Slice(ids, func(i, j int) bool { return c.mdOf[ids[i]] < c.mdOf[ids[j]] })
	sort.SliceStable(ids, func(i, j int) bool {
		a, _ := strconv.Atoi(strings.TrimPrefix(c.mdOf[ids[i]], "m"))
		b, _ := strconv.Atoi(strings.TrimPrefix(c.mdOf[ids[j]], "m"))
		return a < b
	})
	var errs []string
	for _, n := range ids {
		id := c.mdOf[n]
		dev := "/dev/" + n.kname()
		out, err := c.run("mdadm", "--detail", "--export", dev)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", dev, err))
			continue
		}
		ex := sysparse.ParseOSRelease(out)
		if text, err := c.run("mdadm", "--detail", dev); err == nil {
			c.addRaw("mdadm-detail-"+id+".txt", text)
		}
		sys := "/sys/block/" + n.kname() + "/md"
		md := MDArray{ID: id, KName: clean(n.kname()), UUID: clean(ex["MD_UUID"]), Level: clean(ex["MD_LEVEL"]),
			Metadata: clean(ex["MD_METADATA"]), SizeBytes: n.int("size"), Bitmap: "none", State: "clean"}
		md.RaidDevices, _ = strconv.ParseInt(ex["MD_DEVICES"], 10, 64)
		if name := ex["MD_NAME"]; name != "" {
			md.Name = strPtr(clean(name))
			if host, _, ok := strings.Cut(name, ":"); ok && host != "" {
				md.Homehost = strPtr(clean(host))
			}
		}
		if v, ok := readString(c.h, sys+"/chunk_size"); ok {
			if x, err := strconv.ParseInt(v, 10, 64); err == nil && x > 0 {
				md.ChunkBytes = &x
			}
		}
		if v, ok := readString(c.h, sys+"/layout"); ok && v != "" && strings.HasPrefix(md.Level, "raid") && md.Level != "raid1" && md.Level != "raid0" {
			md.Layout = strPtr(clean(v))
		}
		if v, ok := readString(c.h, sys+"/bitmap/location"); ok {
			switch {
			case v == "none":
				md.Bitmap = "none"
			case v == "file":
				md.Bitmap = "external"
			case strings.HasPrefix(v, "+") || strings.HasPrefix(v, "-"):
				md.Bitmap = "internal"
			}
		}
		var states []string
		if v, ok := readString(c.h, sys+"/array_state"); ok && v != "" {
			states = append(states, v)
		}
		if v, ok := readString(c.h, sys+"/degraded"); ok && v != "" && v != "0" {
			states = append(states, "degraded")
		}
		if v, ok := readString(c.h, sys+"/sync_action"); ok && v != "" && v != "idle" {
			states = append(states, v)
		}
		if len(states) > 0 {
			md.State = clean(strings.Join(states, ","))
		}
		if v, ok := readString(c.h, sys+"/consistency_policy"); ok && (v == "journal" || v == "ppl") {
			md.Journal = true
		}
		// Members: MD_DEVICE_<dev>_ROLE and _DEV.
		var keys []string
		for k := range ex {
			if strings.HasPrefix(k, "MD_DEVICE_") && strings.HasSuffix(k, "_DEV") {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			devPath := ex[k]
			role := ex[strings.TrimSuffix(k, "_DEV")+"_ROLE"]
			mn := c.nodeOfDevice(devPath)
			ref, ok := c.refOf(mn)
			if !ok {
				c.note(CodeUnknownDeviceInBootPath, devPath, "md member "+devPath+" is not a known device", SeverityUnsupported)
				continue
			}
			mstate, _ := readString(c.h, sys+"/dev-"+strings.TrimPrefix(devPath, "/dev/")+"/state")
			if role == "spare" || strings.Contains(mstate, "spare") && !strings.Contains(mstate, "in_sync") {
				md.Spares = append(md.Spares, ref)
				continue
			}
			mem := MDMember{Device: ref, State: clean(strings.ReplaceAll(mstate, ",", " ")), WriteMostly: strings.Contains(mstate, "write_mostly")}
			if r, err := strconv.ParseInt(role, 10, 64); err == nil {
				mem.Role = &r
			}
			if mem.State == "" {
				mem.State = "active"
			}
			md.Members = append(md.Members, mem)
		}
		sort.SliceStable(md.Members, func(i, j int) bool {
			if md.Members[i].Role == nil || md.Members[j].Role == nil {
				return md.Members[j].Role == nil && md.Members[i].Role != nil
			}
			return *md.Members[i].Role < *md.Members[j].Role
		})
		c.l.MD = append(c.l.MD, md)
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}
