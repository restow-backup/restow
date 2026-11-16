package recovery

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// VerifyEnv is what the checks need from the machine (verify_linux.go).
type VerifyEnv interface {
	// Exists reports a device node or a /dev link.
	Exists(dev string) bool
	// Statfs is free and total bytes of a path of the ISO.
	Statfs(p string) (free, total int64, err error)
	// BootOrder and BootEntries are the EFI boot variables (UEFI).
	BootOrder() []int64
	BootEntries() map[int]baremetal.LoadOption
	// ReadHead reads the first n bytes of a device (the MBR).
	ReadHead(dev string, n int) ([]byte, error)
	// Signatures are the identities on a device (blkid -p).
	Signatures(ctx context.Context, dev string) []baremetal.TargetSignature
}

// StandardVerifier runs the ten checks of 10.17.
type StandardVerifier struct {
	Env    VerifyEnv
	Target *baremetal.Target
}

// Verify implements Verifier.
func (v StandardVerifier) Verify(ctx context.Context, x *Executor) []*Check {
	r := x.Rootfs()
	return []*Check{
		v.resticVerify(x),
		v.storageStack(ctx, x),
		v.fstab(r),
		v.crypttab(x, r),
		v.initramfs(ctx, x, r),
		v.bootEntries(x, r),
		v.bootConfig(x, r),
		v.identityConflicts(ctx, x),
		v.mountPoints(x, r),
		v.secureBoot(x, r),
	}
}

func (v StandardVerifier) resticVerify(x *Executor) *Check {
	c := NewCheck(CheckResticVerify)
	rep := x.Report()
	c.Set("errors", rep.RestoreErrors)
	if rep.SystemErrors > 0 {
		c.Set("systemErrors", rep.SystemErrors)
		c.FailT(ProblemSystemFilesIncomplete, "", nil, "sys_missing", "count", rep.SystemErrors)
	} else if rep.RestoreErrors > 0 {
		c.WarnT(WarnRestoreFileErrors, "", nil, "files_missing", "count", rep.RestoreErrors)
	}
	return c
}

// storageStack: every file system of the plan with its UUID, type and
// label (blkid -p), arrays and LVs present, LUKS volumes open.
func (v StandardVerifier) storageStack(ctx context.Context, x *Executor) *Check {
	c := NewCheck(CheckStorageStack)
	fsCount, devCount := 0, 0
	for _, s := range x.Plan.Steps {
		switch s.Kind {
		case "mkfs", "mkswap":
			want := mkfsExpect(s.Args)
			if want.dev == "" {
				continue
			}
			fsCount++
			out, err := x.Exec.Run(ctx, RunSpec{Argv: []string{"blkid", "-p", "-o", "export", want.dev}, Timeout: time.Minute})
			if err != nil {
				c.FailT(ProblemVerifyFailed, want.dev, nil, "blkid", "device", want.dev, "reason", err.Error())
				continue
			}
			kv := parseExport(string(out.Output))
			if (want.uuid != "" && !strings.EqualFold(kv["UUID"], want.uuid)) || (want.typ != "" && kv["TYPE"] != want.typ) {
				c.FailT(ProblemMkfsReadbackMismatch, want.dev, nil, "fs_mismatch", "device", want.dev, "uuid", kv["UUID"], "type", kv["TYPE"], "wantUuid", want.uuid, "wantType", want.typ)
			}
		case "md_create", "md_assemble", "luks_open", "lv_create":
			dev := ""
			switch s.Kind {
			case "luks_open":
				dev = "/dev/mapper/" + s.Args[len(s.Args)-1]
			case "lv_create":
				dev = "/dev/" + deref(s.Target)
			default:
				dev = deref(s.Target)
			}
			devCount++
			if !v.Env.Exists(dev) {
				c.FailT(ProblemVerifyFailed, dev, nil, "missing", "what", dev)
			}
		}
	}
	c.Set("filesystems", fsCount).Set("devices", devCount)
	return c
}

// fstabEntry is one line of fstab.
type fstabEntry struct {
	line          int
	source, mount string
	fstype, opts  string
}

func parseTab(b []byte, minFields int) []fstabEntry {
	var out []fstabEntry
	for i, l := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		f := strings.Fields(t)
		if len(f) < minFields {
			continue
		}
		e := fstabEntry{line: i + 1, source: f[0], mount: f[1]}
		if len(f) > 2 {
			e.fstype = f[2]
		}
		if len(f) > 3 {
			e.opts = f[3]
		}
		out = append(out, e)
	}
	return out
}

func hasOpt(opts, name string) bool {
	for _, o := range strings.Split(opts, ",") {
		if o == name {
			return true
		}
	}
	return false
}

// sourceDevice is the /dev path of an fstab or crypttab source.
func sourceDevice(src string) string {
	return sourceDevices(src)[0]
}

// sourceDevices are the /dev paths an fstab or crypttab source may have:
// first as written. udev names a UUID link with the case blkid reports,
// lower case for ext4, XFS and LUKS, upper case for vfat and NTFS
// ("UUID=1A2B-3C4D", the ESP of every Debian and Ubuntu installation);
// a UUID or PARTUUID written in the other case is tried too.
func sourceDevices(src string) []string {
	for _, p := range []struct{ pre, dir string }{{"UUID=", "by-uuid"}, {"PARTUUID=", "by-partuuid"}, {"LABEL=", "by-label"}, {"PARTLABEL=", "by-partlabel"}} {
		if v, ok := strings.CutPrefix(src, p.pre); ok {
			v = strings.Trim(v, `"`)
			out := []string{"/dev/disk/" + p.dir + "/" + v}
			if p.pre == "UUID=" || p.pre == "PARTUUID=" {
				for _, other := range []string{strings.ToLower(v), strings.ToUpper(v)} {
					if other != v {
						out = append(out, "/dev/disk/"+p.dir+"/"+other)
					}
				}
			}
			return out
		}
	}
	return []string{src}
}

// sourceExists reports whether one of the paths of a source exists.
func (v StandardVerifier) sourceExists(src string) bool {
	for _, dev := range sourceDevices(src) {
		if v.Env.Exists(dev) {
			return true
		}
	}
	return false
}

// fstab: every entry without noauto or nofail points to a device that
// exists, and its mount point exists in the target.
func (v StandardVerifier) fstab(r Rootfs) *Check {
	c := NewCheck(CheckFstab)
	if r == nil {
		return c.FailT(ProblemVerifyFailed, "/etc/fstab", nil, "not_mounted")
	}
	b, err := r.ReadFile("/etc/fstab", 1<<20)
	if err != nil {
		return c.WarnT(ProblemVerifyFailed, "/etc/fstab", nil, "no_fstab", "reason", err.Error())
	}
	n := 0
	for _, e := range parseTab(b, 2) {
		n++
		if hasOpt(e.opts, "noauto") || hasOpt(e.opts, "nofail") || e.fstype == "swap" && strings.HasPrefix(e.source, "/") && !strings.HasPrefix(e.source, "/dev/") {
			continue
		}
		if e.fstype == "tmpfs" || e.fstype == "proc" || e.fstype == "sysfs" || e.fstype == "devpts" || e.fstype == "nfs" || e.fstype == "nfs4" || e.fstype == "cifs" || strings.HasPrefix(e.fstype, "fuse") {
			continue
		}
		dev := sourceDevice(e.source)
		if strings.HasPrefix(dev, "/dev/") && !strings.HasPrefix(dev, "/dev/mapper/") && !v.sourceExists(e.source) {
			c.FailT(ProblemVerifyFailed, e.source, map[string]string{"line": strconv.Itoa(e.line)}, "tab_no_dev", "line", e.line, "source", e.source)
		}
		if strings.HasPrefix(e.mount, "/") && e.fstype != "swap" {
			if st, err := r.Lstat(e.mount); err != nil || !st.IsDir() {
				c.FailT(ProblemVerifyFailed, e.mount, map[string]string{"line": strconv.Itoa(e.line)}, "tab_no_dir", "line", e.line, "path", e.mount)
			}
		}
	}
	c.Set("entries", n)
	return c
}

// randomKey reports a key field of crypttab that makes a new key at every
// start: the volume has no header and is formatted each time.
func randomKey(key string) bool {
	return key == "/dev/urandom" || key == "/dev/random" || key == "/dev/hw_random"
}

// crypttab: every entry names a LUKS volume of the plan; a plain entry
// resolves to exactly the planned partition. An entry is plain by its
// options (swap, tmp, plain), by a random key without the option luks, or
// because the backup recorded its name as plain dm-crypt: at the start
// such a volume is opened without a header and written, so a source that
// is a device name could be another disk on new hardware.
func (v StandardVerifier) crypttab(x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckCrypttab)
	if r == nil {
		return c.FailT(ProblemVerifyFailed, "/etc/crypttab", nil, "not_mounted")
	}
	b, err := r.ReadFile("/etc/crypttab", 1<<20)
	if err != nil {
		c.Set("present", false)
		return c
	}
	luks := map[string]bool{}
	luksName := map[string]bool{}
	plainName := map[string]bool{}
	if x.Manifest != nil && x.Manifest.Linux != nil {
		for _, l := range x.Manifest.Linux.LUKS {
			luks[strings.ToLower(l.UUID)] = true
			for _, n := range []*string{l.CrypttabName, l.MappedName} {
				if n != nil && *n != "" {
					luksName[*n] = true
				}
			}
		}
		for _, pc := range x.Manifest.Linux.PlainCrypt {
			plainName[pc.MappedName] = true
			if pc.CrypttabName != nil {
				plainName[*pc.CrypttabName] = true
			}
		}
	}
	planned := x.Fixups.PlainSources
	n, plains := 0, 0
	for _, e := range parseTab(b, 2) {
		n++
		// crypttab: name, source, key file, options.
		name, src, key := e.source, e.mount, e.fstype
		isLUKS := hasOpt(e.opts, "luks") || luksName[name]
		isPlain := hasOpt(e.opts, "swap") || hasOpt(e.opts, "tmp") || hasOpt(e.opts, "plain") || strings.Contains(e.opts, "tmp=") ||
			(!isLUKS && (randomKey(key) || plainName[name]))
		line := map[string]string{"line": strconv.Itoa(e.line)}
		if isPlain {
			plains++
			if want, ok := planned[name]; !ok || want != src {
				c.FailT(ProblemVerifyFailed, name, line, "plain_wrong", "line", e.line, "name", name, "source", src)
				continue
			}
			if !v.sourceExists(src) {
				c.FailT(ProblemVerifyFailed, name, line, "tab_no_dev", "line", e.line, "source", src)
			}
			continue
		}
		if u, ok := strings.CutPrefix(src, "UUID="); ok {
			if !luks[strings.ToLower(u)] {
				c.FailT(ProblemVerifyFailed, name, line, "luks_unknown", "line", e.line, "source", src)
			}
		} else if !v.sourceExists(src) {
			c.WarnT(ProblemVerifyFailed, name, line, "tab_no_dev", "line", e.line, "source", src)
		}
	}
	c.Set("entries", n).Set("plain", plains)
	return c
}

// rootNeeds names what the storage under / is built of (luks, md, lvm)
// and whether its file system spans several devices: the initramfs must
// bring the tools that assemble it.
func rootNeeds(l *baremetal.LinuxLayout) (needs map[string]bool, multiDevice bool) {
	needs = map[string]bool{}
	var root *baremetal.Filesystem
	for _, m := range l.Mounts {
		if m.Target != "/" || m.FS == nil {
			continue
		}
		for i := range l.Filesystems {
			if l.Filesystems[i].ID == *m.FS {
				root = &l.Filesystems[i]
			}
		}
	}
	if root == nil {
		return needs, false
	}
	var walk func(r baremetal.BlockRef, depth int)
	walk = func(r baremetal.BlockRef, depth int) {
		if depth > 64 {
			return
		}
		switch r.Kind {
		case baremetal.RefMD:
			needs["md"] = true
			for _, md := range l.MD {
				if md.ID == r.ID {
					for _, mem := range md.Members {
						walk(mem.Device, depth+1)
					}
				}
			}
		case baremetal.RefLUKS:
			needs["luks"] = true
			for _, c := range l.LUKS {
				if c.ID == r.ID {
					walk(c.Device, depth+1)
				}
			}
		case baremetal.RefLV:
			needs["lvm"] = true
			for _, pv := range l.LVM.PVs {
				if pv.VG != nil && *pv.VG == r.VG {
					walk(pv.Device, depth+1)
				}
			}
		}
	}
	for _, d := range root.Devices {
		walk(d, 0)
	}
	return needs, root.Type == "btrfs" && len(root.Devices) > 1
}

// listed reports whether a listing of an initramfs (one path per line, or
// lines of ls -l) names a file with one of the base names.
func listed(listing string, names ...string) bool {
	for _, l := range strings.Split(listing, "\n") {
		for _, f := range strings.Fields(l) {
			base := path.Base(f)
			for _, n := range names {
				if base == n {
					return true
				}
			}
		}
	}
	return false
}

// initramfs: the image the system starts with (the default kernel's, or
// its unified kernel image) exists and is newer than the start of the
// recovery; the generator's lister can read it; it holds the storage
// drivers and the tools the storage under / needs; /boot has at least 10
// percent free. An image that was not rebuilt fails the check: it knows
// only the old hardware. What could not be looked at is a warning, never
// a silent ok.
func (v StandardVerifier) initramfs(ctx context.Context, x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckInitramfs)
	if x.Manifest == nil || x.Manifest.Linux == nil || r == nil {
		return c.FailT(ProblemVerifyFailed, "/boot", nil, "not_mounted")
	}
	l := x.Manifest.Linux
	// The kernel whose initramfs the plan rebuilds is the one that starts.
	planned, ukiPlanned := "", false
	for _, s := range x.Plan.Steps {
		switch {
		case s.Kind == "initramfs" && s.Target != nil:
			planned = *s.Target
		case s.Kind == "uki":
			ukiPlanned = true
		}
	}
	gen := deref(l.Initramfs.Generator)
	ukiPlanned = ukiPlanned || (planned != "" && gen == "mkinitcpio" && l.Initramfs.UKIPresets)
	var def, uki *baremetal.Kernel
	for i := range l.Kernels {
		k := &l.Kernels[i]
		switch {
		case k.UKI:
			if k.Default || uki == nil {
				uki = k
			}
		case k.Version == planned || (planned == "" && k.Default):
			def = k
		}
	}
	if free, total, err := v.Env.Statfs(x.TargetRoot + "/boot"); err == nil && total > 0 {
		pct := free * 100 / total
		c.Set("bootFreePercent", pct)
		if pct < 10 {
			c.WarnT(WarnBootSpaceLow, "/boot", map[string]string{"percent": strconv.FormatInt(pct, 10)}, "boot_low", "percent", pct)
		}
	}
	for _, k := range x.Report().NotAdaptedKernels {
		c.WarnT(WarnInitramfsNotRebuilt, k, nil, "kernel_skipped", "kernel", k)
	}
	stale := func(img string) (missing, old bool) {
		st, err := r.Lstat(img)
		if err != nil {
			return true, false
		}
		return false, st.ModTime().Before(x.Report().StartedAt.Add(-time.Minute))
	}
	if def == nil {
		if uki == nil {
			return c.WarnT(WarnInitramfsNotRebuilt, "", nil, "no_kernel")
		}
		// The system starts a unified kernel image: kernel, initramfs and
		// command line in one file.
		c.Set("kernel", uki.Version).Set("image", uki.Image).Set("uki", true)
		missing, old := stale(uki.Image)
		switch {
		case missing:
			return c.FailT(WarnInitramfsNotRebuilt, uki.Version, nil, "img_missing", "image", uki.Image, "kernel", uki.Version)
		case old && ukiPlanned:
			return c.FailT(WarnInitramfsNotRebuilt, uki.Version, nil, "img_stale", "image", uki.Image, "kernel", uki.Version)
		case old:
			// The plan has no way to rebuild it (10.16): said, not hidden.
			c.WarnT(WarnInitramfsNotRebuilt, uki.Version, nil, "uki_stale", "image", uki.Image)
		}
		return c.Set("rebuilt", !old)
	}
	c.Set("kernel", def.Version)
	if def.Initramfs == nil {
		return c.WarnT(WarnInitramfsNotRebuilt, def.Version, nil, "img_unknown", "kernel", def.Version)
	}
	img := *def.Initramfs
	c.Set("image", img)
	missing, old := stale(img)
	if missing {
		return c.FailT(WarnInitramfsNotRebuilt, def.Version, nil, "img_missing", "image", img, "kernel", def.Version)
	}
	c.Set("rebuilt", !old)
	if old {
		c.FailT(WarnInitramfsNotRebuilt, def.Version, nil, "img_stale", "image", img, "kernel", def.Version)
	}
	lister := map[string][]string{"initramfs-tools": {"lsinitramfs", img}, "dracut": {"lsinitrd", img}, "mkinitcpio": {"lsinitcpio", img}}[gen]
	if lister == nil || x.Isolator == nil {
		return c.WarnT(ProblemVerifyFailed, img, nil, "img_unlisted", "image", img)
	}
	disks, extra := x.isolatedDevices("verify")
	spec := IsolateSpec{Root: x.TargetRoot, Argv: lister, TimeoutSeconds: 600}
	spec.Devices, spec.DevLinks = x.Ops.DeviceSet(disks, extra)
	res, err := x.Isolator.Run(ctx, spec)
	if ferr := x.thawAfter(lister[0]); ferr != nil {
		return c.FailT(ProblemVerifyFailed, img, nil, "detail", "detail", ferr.Error())
	}
	if err != nil || res == nil || res.ExitCode != 0 {
		c.Set("readable", false)
		return c.FailT(ProblemVerifyFailed, img, nil, "img_unreadable", "image", img)
	}
	c.Set("readable", true)
	listing := string(res.Output)
	for _, d := range x.Plan.Drivers.Storage {
		if d.Builtin || d.Module == nil || *d.Module == "" {
			continue
		}
		mod := strings.ReplaceAll(*d.Module, "-", "_")
		if !strings.Contains(strings.ReplaceAll(listing, "-", "_"), "/"+mod+".ko") {
			c.FailT(ProblemVerifyFailed, *d.Module, nil, "drv_missing", "module", *d.Module)
		}
	}
	// The tools that assemble the storage under /: without them the
	// initramfs finds no root file system.
	needs, multi := rootNeeds(l)
	for _, t := range []struct {
		need  string
		names []string
	}{{"luks", []string{"cryptsetup", "systemd-cryptsetup"}}, {"md", []string{"mdadm"}}, {"lvm", []string{"lvm"}}} {
		if needs[t.need] && !listed(listing, t.names...) {
			c.FailT(ProblemVerifyFailed, t.names[0], nil, "tool_missing", "tool", t.names[0])
		}
	}
	if multi && !listed(listing, "btrfs") {
		c.WarnT(ProblemVerifyFailed, "btrfs", nil, "btrfs_tool")
	}
	if needs["lvm"] && l.LVM.UseDevicesFile {
		// Evidence only: without the file in the image LVM scans every
		// device, which finds the volume group as well.
		c.Set("lvmDevicesFile", strings.Contains(listing, "etc/lvm/devices/system.devices"))
	}
	return c
}

// bootEntries: UEFI: every boot entry the plan wanted was written, is in
// BootOrder, and its loader is on the ESP (with the backed-up Authenticode
// hash when the backup has one; a loader the backup does not list is a
// warning, because nothing proves its content); the fallback path the plan
// set up exists. With no entry at all the system starts only over the
// fallback path (a warning), and without that it does not start (failed).
// BIOS: GRUB boot code in the MBR of every boot disk.
func (v StandardVerifier) bootEntries(x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckBootEntries)
	if v.Target != nil && v.Target.Firmware.Mode == "bios" {
		n := 0
		for _, s := range x.Plan.Steps {
			if s.Kind != "bootloader_bios" || s.Target == nil {
				continue
			}
			n++
			head, err := v.Env.ReadHead(*s.Target, 512)
			if err != nil || !bytes.Contains(head, []byte("GRUB")) {
				c.FailT(ProblemVerifyFailed, *s.Target, nil, "no_mbr_code", "device", *s.Target)
			}
		}
		if n == 0 {
			c.WarnT(ProblemVerifyFailed, "", nil, "no_boot_disk")
		}
		return c.Set("bootDisks", n)
	}
	planned, fallbackPlanned := 0, false
	for _, s := range x.Plan.Steps {
		switch s.Kind {
		case "nvram":
			planned++
		case "fallback_path":
			fallbackPlanned = true
		}
	}
	order := map[int64]bool{}
	for _, n := range v.Env.BootOrder() {
		order[n] = true
	}
	entries := v.Env.BootEntries()
	written := x.Report().BootEntries
	c.Set("entries", len(written)).Set("plannedEntries", planned)
	if len(written) < planned {
		c.FailT(ProblemVerifyFailed, "", nil, "entry_count", "written", len(written), "planned", planned)
	}
	for _, n := range written {
		name := fmt.Sprintf("Boot%04X", n)
		if !order[int64(n)] {
			c.FailT(ProblemVerifyFailed, name, nil, "entry_order", "entry", name)
		}
		e, ok := entries[n]
		if !ok {
			c.FailT(ProblemVerifyFailed, name, nil, "entry_missing", "entry", name)
			continue
		}
		switch state, where := v.loaderState(x, r, e.Path); state {
		case loaderMissing:
			c.FailT(ProblemVerifyFailed, e.Path, nil, "ldr_missing", "path", where)
		case loaderDiffers:
			c.FailT(ProblemVerifyFailed, e.Path, nil, "ldr_differs", "path", where)
		case loaderUnlisted:
			c.WarnT(ProblemVerifyFailed, e.Path, nil, "ldr_unlisted", "path", where)
		}
	}
	fallback := false
	if r != nil {
		for _, esp := range x.espRoots() {
			for _, name := range []string{"EFI/BOOT/BOOTX64.EFI", "EFI/BOOT/BOOTAA64.EFI"} {
				if p := findNoCase(r, esp, name); p != "" {
					fallback = true
					if state, where := v.loaderState(x, r, p); state == loaderDiffers {
						c.FailT(ProblemVerifyFailed, p, nil, "ldr_differs", "path", where)
					}
				}
			}
		}
	}
	c.Set("fallbackPath", fallback)
	switch {
	case fallbackPlanned && x.Fallback && !fallback:
		c.FailT(ProblemVerifyFailed, `\EFI\BOOT`, nil, "no_fallback")
	case len(written) == 0 && !fallback:
		c.FailT(ProblemVerifyFailed, "", nil, "no_entry")
	case len(written) == 0:
		c.WarnT(ProblemVerifyFailed, `\EFI\BOOT`, nil, "only_fallback")
	}
	return c
}

// findNoCase finds rel below dir whatever the case of its parts (the
// firmware and FAT do not tell cases apart): the path as it is stored, or
// "".
func findNoCase(r Rootfs, dir, rel string) string {
	cur := dir
	for _, part := range strings.Split(strings.Trim(rel, "/"), "/") {
		if part == "" {
			continue
		}
		names, err := r.ReadDir(cur)
		if err != nil {
			return ""
		}
		found := ""
		for _, n := range names {
			if n == part {
				found = n
				break
			}
			if found == "" && strings.EqualFold(n, part) {
				found = n
			}
		}
		if found == "" {
			return ""
		}
		cur = path.Join(cur, found)
	}
	if _, err := r.Lstat(cur); err != nil {
		return ""
	}
	return cur
}

// What loaderState found.
const (
	loaderOK       = ""
	loaderMissing  = "missing"
	loaderDiffers  = "differs"
	loaderUnlisted = "unlisted"
)

// loaderState checks a loader (a path of the firmware, \EFI\..., or a path
// of the root file system) against the ESP and the backup: it must be
// there, and when the backup lists it, with the backed-up hash. The
// second value is the path it was looked for.
func (v StandardVerifier) loaderState(x *Executor, r Rootfs, efiPath string) (string, string) {
	if r == nil || x.Manifest == nil || x.Manifest.Linux == nil {
		return loaderUnlisted, efiPath
	}
	p := strings.ReplaceAll(efiPath, `\`, "/")
	for _, ld := range x.Manifest.Linux.Loaders {
		if !strings.EqualFold(strings.TrimPrefix(ld.Path, "/"), strings.TrimPrefix(p, "/")) && !strings.HasSuffix(strings.ToLower(ld.Path), strings.ToLower(p)) {
			continue
		}
		b, err := r.ReadFile(ld.Path, 256<<20)
		if err != nil {
			return loaderMissing, ld.Path
		}
		info, err := baremetal.InspectLoader(bytes.NewReader(b), int64(len(b)))
		if err != nil || info.AuthenticodeSha256 != ld.AuthenticodeSha256 {
			return loaderDiffers, ld.Path
		}
		return loaderOK, ld.Path
	}
	// Not in the backup's list: it must at least be on an ESP.
	if _, err := r.Lstat(p); err == nil && strings.HasPrefix(p, "/") {
		return loaderUnlisted, p
	}
	for _, esp := range x.espRoots() {
		if found := findNoCase(r, esp, p); found != "" {
			return loaderUnlisted, found
		}
	}
	return loaderMissing, efiPath
}

var reUUIDRef = regexp.MustCompile(`(?:UUID=|--fs-uuid(?:\s+--set=\S+)?\s+|root=UUID=)([0-9A-Fa-f-]{8,36})`)

// bootConfig: grub.cfg or the loader entries name only UUIDs that exist.
func (v StandardVerifier) bootConfig(x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckBootConfig)
	if r == nil || x.Manifest == nil || x.Manifest.Linux == nil {
		return c
	}
	files := []string{}
	if cfg := deref(x.Manifest.Linux.Bootloader.GrubCfg); cfg != "" {
		files = append(files, cfg)
	}
	for _, dir := range []string{"/boot/loader/entries", "/efi/loader/entries", "/boot/efi/loader/entries"} {
		if names, err := r.ReadDir(dir); err == nil {
			for _, n := range names {
				if strings.HasSuffix(n, ".conf") {
					files = append(files, path.Join(dir, n))
				}
			}
		}
	}
	checked := 0
	for _, f := range files {
		b, err := r.ReadFile(f, 8<<20)
		if err != nil {
			if f == deref(x.Manifest.Linux.Bootloader.GrubCfg) {
				c.FailT(ProblemVerifyFailed, f, nil, "missing", "what", f)
			}
			continue
		}
		checked++
		seen := map[string]bool{}
		for _, m := range reUUIDRef.FindAllSubmatch(b, -1) {
			u := strings.ToLower(string(m[1]))
			if seen[u] {
				continue
			}
			seen[u] = true
			if !v.Env.Exists("/dev/disk/by-uuid/"+u) && !v.Env.Exists("/dev/disk/by-uuid/"+strings.ToUpper(u)) && !x.knownUUID(u) {
				c.FailT(ProblemVerifyFailed, f, nil, "cfg_uuid", "path", f, "uuid", u)
			}
		}
	}
	c.Set("files", checked)
	return c
}

// knownUUID: a UUID the plan created (LUKS volumes are not in by-uuid
// once opened under their name).
func (x *Executor) knownUUID(u string) bool {
	if x.Manifest == nil || x.Manifest.Linux == nil {
		return false
	}
	for _, l := range x.Manifest.Linux.LUKS {
		if strings.EqualFold(l.UUID, u) {
			return true
		}
	}
	for _, f := range x.Manifest.Linux.Filesystems {
		if f.UUID != nil && strings.EqualFold(*f.UUID, u) {
			return true
		}
	}
	return false
}

// ManifestIdentities are the identities of the manifest (file systems,
// LUKS, md, PVs, PARTUUIDs, disk GUIDs), normalised.
func ManifestIdentities(m *baremetal.Manifest) map[string]bool {
	out := map[string]bool{}
	if m == nil || m.Linux == nil {
		return out
	}
	add := func(s string) {
		if s != "" {
			out[normIdent(s)] = true
		}
	}
	l := m.Linux
	for _, f := range l.Filesystems {
		add(deref(f.UUID))
	}
	for _, x := range l.LUKS {
		add(x.UUID)
	}
	for _, x := range l.MD {
		add(x.UUID)
	}
	for _, x := range l.LVM.PVs {
		add(x.UUID)
	}
	for _, d := range l.Disks {
		if d.Table != nil {
			add(d.Table.ID)
			for _, p := range d.Table.Partitions {
				add(deref(p.UUID))
			}
		}
	}
	return out
}

func normIdent(s string) string {
	return strings.ToLower(strings.NewReplacer("-", "", ":", "", "0x", "").Replace(s))
}

// identityConflicts: no device that is neither a target nor adopted
// carries an identity of the restored system (10.7).
func (v StandardVerifier) identityConflicts(ctx context.Context, x *Executor) *Check {
	c := NewCheck(CheckIdentityConflicts)
	if v.Target == nil {
		return c
	}
	ids := ManifestIdentities(x.Manifest)
	for _, o := range v.Target.Others {
		for _, s := range v.Env.Signatures(ctx, o.Path) {
			if ids[normIdent(s.UUID)] {
				c.FailT(WarnOldDiskPresent, o.Path, map[string]string{"model": deref(o.Model), "identity": deref(o.Identity)},
					"old_identity", "device", o.Path, "kind", s.Kind, "uuid", s.UUID)
				x.hint(HintOldDiskPresent, map[string]string{"model": deref(o.Model), "identity": deref(o.Identity)})
				break
			}
		}
	}
	c.Set("others", len(v.Target.Others))
	return c
}

// mountPoints: the mount points and API folders exist with the modes of
// 10.12.
func (v StandardVerifier) mountPoints(x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckMountPoints)
	if r == nil {
		return c.FailT(ProblemVerifyFailed, "/", nil, "not_mounted")
	}
	n := 0
	for _, s := range x.Plan.Steps {
		if s.Kind != "mkdirs" {
			continue
		}
		for _, sp := range s.Args[1:] {
			p, m, _ := strings.Cut(sp, ":")
			mode, _ := strconv.ParseUint(m, 8, 32)
			n++
			st, err := r.Lstat(p)
			switch {
			case err != nil:
				c.FailT(ProblemVerifyFailed, p, nil, "missing", "what", p)
			case !st.IsDir():
				c.FailT(ProblemVerifyFailed, p, nil, "not_dir", "path", p)
			case p == "/proc" || p == "/sys" || p == "/dev" || p == "/run" || p == "/tmp":
				want := fs.FileMode(mode & 0o777)
				if st.Mode().Perm() != want {
					c.WarnT(ProblemVerifyFailed, p, nil, "mode", "path", p, "mode", fmt.Sprintf("%o", st.Mode().Perm()), "want", fmt.Sprintf("%o", want))
				}
			}
		}
	}
	return c.Set("folders", n)
}

// secureBoot: with Secure Boot on, the chain the plan checked before the
// erase is on the ESP unchanged (same loaders, same hashes); a queued MOK
// waits for enrolment.
func (v StandardVerifier) secureBoot(x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckSecureBoot)
	on := v.Target != nil && v.Target.Firmware.SecureBoot != nil && *v.Target.Firmware.SecureBoot
	c.Set("secureBoot", on)
	if !on {
		return c
	}
	for _, lc := range x.Plan.SecureBoot.Loaders {
		if lc.Verdict != "ok" {
			c.WarnT(ProblemVerifyFailed, lc.Path, nil, "sb_verdict", "path", lc.Path, "verdict", lc.Verdict)
		}
		switch state, where := v.loaderState(x, r, lc.Path); state {
		case loaderMissing:
			c.FailT(ProblemVerifyFailed, lc.Path, nil, "ldr_missing", "path", where)
		case loaderDiffers:
			c.FailT(ProblemVerifyFailed, lc.Path, nil, "ldr_differs", "path", where)
		}
	}
	if x.Report().MokPassword != "" {
		c.WarnT(WarnMokEnrollPending, "", nil, "mok_pending")
	}
	return c
}
