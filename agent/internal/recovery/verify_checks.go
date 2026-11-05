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
		c.Fail(ProblemSystemFilesIncomplete, "", fmt.Sprintf("%d files below the system paths are missing", rep.SystemErrors), nil)
	} else if rep.RestoreErrors > 0 {
		c.Warn(WarnRestoreFileErrors, "", fmt.Sprintf("%d files could not be restored", rep.RestoreErrors), nil)
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
				c.Fail(ProblemVerifyFailed, want.dev, "blkid: "+err.Error(), nil)
				continue
			}
			kv := parseExport(string(out.Output))
			if (want.uuid != "" && !strings.EqualFold(kv["UUID"], want.uuid)) || (want.typ != "" && kv["TYPE"] != want.typ) {
				c.Fail(ProblemMkfsReadbackMismatch, want.dev, fmt.Sprintf("UUID %s type %s, want %s %s", kv["UUID"], kv["TYPE"], want.uuid, want.typ), nil)
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
				c.Fail(ProblemVerifyFailed, dev, dev+" is missing", nil)
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
	for _, p := range []struct{ pre, dir string }{{"UUID=", "by-uuid"}, {"PARTUUID=", "by-partuuid"}, {"LABEL=", "by-label"}, {"PARTLABEL=", "by-partlabel"}} {
		if v, ok := strings.CutPrefix(src, p.pre); ok {
			v = strings.Trim(v, `"`)
			if p.pre == "UUID=" || p.pre == "PARTUUID=" {
				v = strings.ToLower(v)
			}
			return "/dev/disk/" + p.dir + "/" + v
		}
	}
	return src
}

// fstab: every entry without noauto or nofail points to a device that
// exists, and its mount point exists in the target.
func (v StandardVerifier) fstab(r Rootfs) *Check {
	c := NewCheck(CheckFstab)
	if r == nil {
		return c.Fail(ProblemVerifyFailed, "/etc/fstab", "the target is not mounted", nil)
	}
	b, err := r.ReadFile("/etc/fstab", 1<<20)
	if err != nil {
		return c.Warn(ProblemVerifyFailed, "/etc/fstab", "no fstab: "+err.Error(), nil)
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
		if strings.HasPrefix(dev, "/dev/") && !strings.HasPrefix(dev, "/dev/mapper/") && !v.Env.Exists(dev) {
			c.Fail(ProblemVerifyFailed, e.source, fmt.Sprintf("line %d: %s does not exist", e.line, e.source), map[string]string{"line": strconv.Itoa(e.line)})
		}
		if strings.HasPrefix(e.mount, "/") && e.fstype != "swap" {
			if st, err := r.Lstat(e.mount); err != nil || !st.IsDir() {
				c.Fail(ProblemVerifyFailed, e.mount, fmt.Sprintf("line %d: mount point %s is missing", e.line, e.mount), map[string]string{"line": strconv.Itoa(e.line)})
			}
		}
	}
	c.Set("entries", n)
	return c
}

// crypttab: every entry names a LUKS volume of the plan; a plain entry
// (swap, tmp, plain) resolves to exactly the planned partition.
func (v StandardVerifier) crypttab(x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckCrypttab)
	if r == nil {
		return c.Fail(ProblemVerifyFailed, "/etc/crypttab", "the target is not mounted", nil)
	}
	b, err := r.ReadFile("/etc/crypttab", 1<<20)
	if err != nil {
		c.Set("present", false)
		return c
	}
	luks := map[string]bool{}
	plain := map[string]bool{}
	if x.Manifest != nil && x.Manifest.Linux != nil {
		for _, l := range x.Manifest.Linux.LUKS {
			luks[strings.ToLower(l.UUID)] = true
		}
	}
	for _, src := range x.Fixups.PlainSources {
		plain[src] = true
	}
	n := 0
	for _, e := range parseTab(b, 2) {
		n++
		// crypttab: name, source, key file, options.
		name, src := e.source, e.mount
		isPlain := hasOpt(e.opts, "swap") || hasOpt(e.opts, "tmp") || hasOpt(e.opts, "plain") || strings.Contains(e.opts, "tmp=")
		line := map[string]string{"line": strconv.Itoa(e.line)}
		if isPlain {
			if !plain[src] {
				c.Fail(ProblemVerifyFailed, name, fmt.Sprintf("line %d: the plain volume %s does not name the planned partition", e.line, name), line)
				continue
			}
			if !v.Env.Exists(sourceDevice(src)) {
				c.Fail(ProblemVerifyFailed, name, fmt.Sprintf("line %d: %s does not exist", e.line, src), line)
			}
			continue
		}
		if u, ok := strings.CutPrefix(src, "UUID="); ok {
			if !luks[strings.ToLower(u)] {
				c.Fail(ProblemVerifyFailed, name, fmt.Sprintf("line %d: %s is no LUKS volume of the plan", e.line, src), line)
			}
		} else if !v.Env.Exists(sourceDevice(src)) {
			c.Warn(ProblemVerifyFailed, name, fmt.Sprintf("line %d: %s does not exist", e.line, src), line)
		}
	}
	c.Set("entries", n)
	return c
}

// initramfs: the image of the default kernel is newer than the start of
// the recovery, readable by the generator's lister, holds the storage
// drivers, and /boot has at least 10 percent free.
func (v StandardVerifier) initramfs(ctx context.Context, x *Executor, r Rootfs) *Check {
	c := NewCheck(CheckInitramfs)
	if x.Manifest == nil || x.Manifest.Linux == nil || r == nil {
		return c
	}
	l := x.Manifest.Linux
	var def *baremetal.Kernel
	for i := range l.Kernels {
		if l.Kernels[i].Default && !l.Kernels[i].UKI {
			def = &l.Kernels[i]
		}
	}
	if free, total, err := v.Env.Statfs(x.TargetRoot + "/boot"); err == nil && total > 0 {
		pct := free * 100 / total
		c.Set("bootFreePercent", pct)
		if pct < 10 {
			c.Warn(WarnBootSpaceLow, "/boot", fmt.Sprintf("/boot has %d percent free", pct), map[string]string{"percent": strconv.FormatInt(pct, 10)})
		}
	}
	for _, k := range x.Report().NotAdaptedKernels {
		c.Warn(WarnInitramfsNotRebuilt, k, "not enough space on /boot", nil)
	}
	if def == nil || def.Initramfs == nil {
		return c
	}
	img := *def.Initramfs
	c.Set("kernel", def.Version).Set("image", img)
	st, err := r.Lstat(img)
	if err != nil {
		return c.Fail(WarnInitramfsNotRebuilt, def.Version, img+" is missing", nil)
	}
	if st.ModTime().Before(x.Report().StartedAt.Add(-time.Minute)) {
		c.Warn(WarnInitramfsNotRebuilt, def.Version, img+" was not rebuilt", nil)
	}
	lister := map[string][]string{"initramfs-tools": {"lsinitramfs", img}, "dracut": {"lsinitrd", img}, "mkinitcpio": {"lsinitcpio", img}}[deref(l.Initramfs.Generator)]
	if lister == nil || x.Isolator == nil {
		return c
	}
	disks, extra := x.isolatedDevices("verify")
	spec := IsolateSpec{Root: x.TargetRoot, Argv: lister, TimeoutSeconds: 600}
	spec.Devices, spec.DevLinks = x.Ops.DeviceSet(disks, extra)
	res, err := x.Isolator.Run(ctx, spec)
	if err != nil || res == nil || res.ExitCode != 0 {
		c.Set("readable", false)
		return c.Fail(ProblemVerifyFailed, img, img+" is not completely readable", nil)
	}
	c.Set("readable", true)
	listing := string(res.Output)
	for _, d := range x.Plan.Drivers.Storage {
		if d.Builtin || d.Module == nil || *d.Module == "" {
			continue
		}
		mod := strings.ReplaceAll(*d.Module, "-", "_")
		if !strings.Contains(strings.ReplaceAll(listing, "-", "_"), "/"+mod+".ko") {
			c.Fail(ProblemVerifyFailed, *d.Module, "the initramfs lacks the storage driver "+*d.Module, nil)
		}
	}
	return c
}

// bootEntries: UEFI: the new entries are in BootOrder and their loaders
// are on the ESP with the backed-up Authenticode hash; the fallback path
// is complete. BIOS: GRUB boot code in the MBR of every boot disk.
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
				c.Fail(ProblemVerifyFailed, *s.Target, "no GRUB boot code in the MBR of "+*s.Target, nil)
			}
		}
		return c.Set("bootDisks", n)
	}
	order := map[int64]bool{}
	for _, n := range v.Env.BootOrder() {
		order[n] = true
	}
	entries := v.Env.BootEntries()
	for _, n := range x.Report().BootEntries {
		if !order[int64(n)] {
			c.Fail(ProblemVerifyFailed, fmt.Sprintf("Boot%04X", n), "the entry is not in BootOrder", nil)
		}
		e, ok := entries[n]
		if !ok {
			c.Fail(ProblemVerifyFailed, fmt.Sprintf("Boot%04X", n), "the entry is missing", nil)
			continue
		}
		if msg := v.loaderOK(x, r, e.Path); msg != "" {
			c.Fail(ProblemVerifyFailed, e.Path, msg, nil)
		}
	}
	c.Set("entries", len(x.Report().BootEntries))
	if r != nil {
		for _, esp := range x.espRoots() {
			if _, err := r.Lstat(path.Join(esp, "EFI/BOOT/BOOTX64.EFI")); err == nil {
				c.Set("fallbackPath", true)
			}
		}
	}
	return c
}

// loaderOK checks a loader on the ESP against the backed-up hash.
func (v StandardVerifier) loaderOK(x *Executor, r Rootfs, efiPath string) string {
	if r == nil || x.Manifest == nil || x.Manifest.Linux == nil {
		return ""
	}
	p := strings.ReplaceAll(efiPath, `\`, "/")
	for _, ld := range x.Manifest.Linux.Loaders {
		if !strings.EqualFold(strings.TrimPrefix(ld.Path, "/"), strings.TrimPrefix(p, "/")) && !strings.HasSuffix(strings.ToLower(ld.Path), strings.ToLower(p)) {
			continue
		}
		b, err := r.ReadFile(ld.Path, 256<<20)
		if err != nil {
			return ld.Path + " is missing on the ESP"
		}
		info, err := baremetal.InspectLoader(bytes.NewReader(b), int64(len(b)))
		if err != nil || info.AuthenticodeSha256 != ld.AuthenticodeSha256 {
			return ld.Path + " differs from the backup"
		}
		return ""
	}
	return ""
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
				c.Fail(ProblemVerifyFailed, f, f+" is missing", nil)
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
				c.Fail(ProblemVerifyFailed, f, fmt.Sprintf("%s names UUID %s, which does not exist", f, u), nil)
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
				c.Fail(WarnOldDiskPresent, o.Path, fmt.Sprintf("%s carries %s %s of this system", o.Path, s.Kind, s.UUID),
					map[string]string{"model": deref(o.Model), "identity": deref(o.Identity)})
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
		return c.Fail(ProblemVerifyFailed, "/", "the target is not mounted", nil)
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
				c.Fail(ProblemVerifyFailed, p, p+" is missing", nil)
			case !st.IsDir():
				c.Fail(ProblemVerifyFailed, p, p+" is not a folder", nil)
			case p == "/proc" || p == "/sys" || p == "/dev" || p == "/run" || p == "/tmp":
				want := fs.FileMode(mode & 0o777)
				if st.Mode().Perm() != want {
					c.Warn(ProblemVerifyFailed, p, fmt.Sprintf("%s has mode %o, want %o", p, st.Mode().Perm(), want), nil)
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
			c.Warn(ProblemVerifyFailed, lc.Path, lc.Path+": "+lc.Verdict, nil)
		}
		if msg := v.loaderOK(x, r, lc.Path); msg != "" {
			c.Fail(ProblemVerifyFailed, lc.Path, msg, nil)
		}
	}
	if x.Report().MokPassword != "" {
		c.Warn(WarnMokEnrollPending, "", "a machine owner key waits for enrolment", nil)
	}
	return c
}
