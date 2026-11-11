package recovery

import (
	"bytes"
	"context"
	"encoding/binary"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

type fakeVerifyEnv struct {
	exists  map[string]bool
	free    int64
	order   []int64
	entries map[int]baremetal.LoadOption
	head    []byte
	sigs    map[string][]baremetal.TargetSignature
}

func (e *fakeVerifyEnv) Exists(dev string) bool { return e.exists[dev] }
func (e *fakeVerifyEnv) Statfs(p string) (int64, int64, error) {
	if e.free == 0 {
		return 50, 100, nil
	}
	return e.free, 100, nil
}
func (e *fakeVerifyEnv) BootOrder() []int64                         { return e.order }
func (e *fakeVerifyEnv) BootEntries() map[int]baremetal.LoadOption  { return e.entries }
func (e *fakeVerifyEnv) ReadHead(dev string, n int) ([]byte, error) { return e.head, nil }
func (e *fakeVerifyEnv) Signatures(ctx context.Context, dev string) []baremetal.TargetSignature {
	return e.sigs[dev]
}

func verifyHarness(t *testing.T) (*harness, *fakeVerifyEnv, StandardVerifier) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	env := &fakeVerifyEnv{exists: map[string]bool{}, sigs: map[string][]baremetal.TargetSignature{}}
	tg, _, _ := baremetal.SyntheticTarget(h.x.Manifest, baremetal.TargetSame, nil)
	v := StandardVerifier{Env: env, Target: tg}
	h.x.rootfs = h.root
	h.x.report = ExecReport{StartedAt: time.Now().Add(-time.Hour)}
	return h, env, v
}

func TestVerifyChecks(t *testing.T) {
	ctx := context.Background()
	// restic_verify
	h, _, v := verifyHarness(t)
	if c := v.resticVerify(h.x); c.Result != api.VerifyOK {
		t.Errorf("restic ok: %s", c.Result)
	}
	h.x.report.RestoreErrors = 2
	if c := v.resticVerify(h.x); c.Result != api.VerifyWarning {
		t.Errorf("restic warning: %s", c.Result)
	}
	h.x.report.SystemErrors = 1
	if c := v.resticVerify(h.x); c.Result != api.VerifyFailed {
		t.Errorf("restic failed: %s", c.Result)
	}

	// storage_stack: blkid shows what mkfs made; a missing LV fails.
	h, env, v := verifyHarness(t)
	for _, s := range h.x.Plan.Steps {
		if s.Kind == "mkfs" || s.Kind == "mkswap" {
			_, _ = h.exec.Run(ctx, RunSpec{Argv: s.Args})
		}
	}
	for _, d := range []string{"/dev/mapper/nvme0n1p3_crypt", "/dev/srv01-vg/root", "/dev/srv01-vg/swap_1", "/dev/srv01-vg/home"} {
		env.exists[d] = true
	}
	if c := v.storageStack(ctx, h.x); c.Result != api.VerifyOK {
		t.Errorf("stack ok: %+v", c.Findings)
	}
	env.exists["/dev/srv01-vg/home"] = false
	if c := v.storageStack(ctx, h.x); c.Result != api.VerifyFailed {
		t.Error("a missing LV passed")
	}

	// fstab
	h, env, v = verifyHarness(t)
	h.root.put("/etc/fstab", "UUID=8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e /boot ext4 defaults 0 2\n/dev/mapper/srv01--vg-root / ext4 errors=remount-ro 0 1\nUUID=dead-beef /data ext4 nofail 0 2\n")
	_ = h.root.MkdirAll("/boot", 0o755)
	env.exists["/dev/disk/by-uuid/8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e"] = true
	if c := v.fstab(h.root); c.Result != api.VerifyOK {
		t.Errorf("fstab ok: %+v", c.Findings)
	}
	h.root.put("/etc/fstab", "UUID=0000 /srv ext4 defaults 0 2\n")
	if c := v.fstab(h.root); c.Result != api.VerifyFailed || len(c.Findings) != 2 {
		t.Errorf("fstab failed: %+v", c.Findings)
	}
	h.root.Remove("/etc/fstab")
	if c := v.fstab(h.root); c.Result != api.VerifyWarning {
		t.Error("no fstab")
	}

	// crypttab: LUKS of the plan ok; an unknown UUID fails; a plain entry
	// must name the planned partition.
	h, env, v = verifyHarness(t)
	h.root.put("/etc/crypttab", "nvme0n1p3_crypt UUID=2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d none luks,discard\n")
	if c := v.crypttab(h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("crypttab ok: %+v", c.Findings)
	}
	h.root.put("/etc/crypttab", "x UUID=11111111-2222-3333-4444-555555555555 none luks\ncswap /dev/sdb2 /dev/urandom swap\n")
	if c := v.crypttab(h.x, h.root); c.Result != api.VerifyFailed || len(c.Findings) != 2 {
		t.Errorf("crypttab failed: %+v", c.Findings)
	}

	// initramfs: rebuilt and readable with the drivers and the tools of
	// the stack under /; /boot low is a warning; an unreadable image fails.
	h, env, v = verifyHarness(t)
	h.root.put("/boot/initrd.img-6.1.0-27-amd64", "img")
	h.iso.reply = func(s IsolateSpec) string {
		return "usr/lib/modules/6.1.0-27-amd64/kernel/drivers/nvme/host/nvme.ko\nusr/sbin/cryptsetup\nusr/sbin/lvm\n"
	}
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyOK || c.Evidence["rebuilt"] != true {
		t.Errorf("initramfs ok: %+v %v", c.Findings, c.Evidence)
	}
	env.free = 5
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyWarning {
		t.Errorf("boot space: %s", c.Result)
	}
	h.iso.exit = 1
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("unreadable image passed")
	}

	// boot_entries: a UEFI entry in BootOrder whose loader is on the ESP
	// with the hash of the backup is ok, outside BootOrder it fails; BIOS
	// boot code.
	h, env, v = verifyHarness(t)
	pe := minimalPE("loader")
	info, err := baremetal.InspectLoader(bytes.NewReader(pe), int64(len(pe)))
	if err != nil {
		t.Fatal(err)
	}
	h.x.Manifest.Linux.Loaders = []baremetal.Loader{{Path: "/boot/efi/EFI/debian/shimx64.efi", AuthenticodeSha256: info.AuthenticodeSha256}}
	h.root.put("/boot/efi/EFI/debian/shimx64.efi", string(pe))
	h.x.report.BootEntries = []int{3}
	env.order = []int64{3, 0}
	env.entries = map[int]baremetal.LoadOption{3: {Path: `\EFI\debian\shimx64.efi`}}
	if c := v.bootEntries(h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("entries ok: %+v", c.Findings)
	}
	h.root.put("/boot/efi/EFI/debian/shimx64.efi", string(minimalPE("another loader")))
	if c := v.bootEntries(h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("a loader that differs from the backup passed")
	}
	h.root.put("/boot/efi/EFI/debian/shimx64.efi", string(pe))
	env.order = []int64{0}
	if c := v.bootEntries(h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("entry outside BootOrder passed")
	}
	v.Target.Firmware.Mode = "bios"
	h.x.Plan.Steps = append(h.x.Plan.Steps, baremetal.Step{Kind: "bootloader_bios", Target: strPtrT("/dev/sda")})
	env.head = []byte("....GRUB ....")
	if c := v.bootEntries(h.x, h.root); c.Result != api.VerifyOK {
		t.Error("BIOS boot code")
	}
	env.head = make([]byte, 512)
	if c := v.bootEntries(h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("an empty MBR passed")
	}

	// boot_config: only existing UUIDs.
	h, env, v = verifyHarness(t)
	h.root.put("/boot/grub/grub.cfg", "search --no-floppy --fs-uuid --set=root 8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e\nlinux /vmlinuz root=UUID=9c0d1e2f-3a4b-5c6d-7e8f-9a0b1c2d3e4f ro\n")
	if c := v.bootConfig(h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("grub ok: %+v", c.Findings)
	}
	h.root.put("/boot/grub/grub.cfg", "linux /vmlinuz root=UUID=deadbeef-0000-0000-0000-000000000000 ro\n")
	if c := v.bootConfig(h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("an unknown UUID passed")
	}

	// identity_conflicts: an old disk with an identity of the system fails
	// and gives the hint.
	h, env, v = verifyHarness(t)
	v.Target.Others = []baremetal.TargetDisk{{ID: "o0", Path: "/dev/sdc", Model: strPtrT("Old SSD"), Identity: strPtrT("wwn.5000c500a1b2c3d4")}}
	if c := v.identityConflicts(ctx, h.x); c.Result != api.VerifyOK {
		t.Error("no conflict")
	}
	env.sigs["/dev/sdc"] = []baremetal.TargetSignature{{Kind: "fs", UUID: "9C0D1E2F-3A4B-5C6D-7E8F-9A0B1C2D3E4F"}}
	if c := v.identityConflicts(ctx, h.x); c.Result != api.VerifyFailed || c.Findings[0].Params["identity"] != "wwn.5000c500a1b2c3d4" {
		t.Errorf("conflict: %+v", c.Findings)
	}
	if len(h.x.report.Hints) != 1 || h.x.report.Hints[0].Code != HintOldDiskPresent {
		t.Error("no old_disk_present hint")
	}

	// mount_points
	h, _, v = verifyHarness(t)
	if c := v.mountPoints(h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("missing folders passed")
	}
	if err := h.x.mkdirs(mkdirsArgs(h.x.Plan)); err != nil {
		t.Fatal(err)
	}
	if c := v.mountPoints(h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("folders: %+v", c.Findings)
	}
	_ = h.root.Chmod("/tmp", 0o755)
	if c := v.mountPoints(h.x, h.root); c.Result != api.VerifyWarning {
		t.Error("a wrong mode of /tmp passed")
	}

	// secure_boot: off is ok; with a plan verdict other than ok a warning.
	h, _, v = verifyHarness(t)
	off := false
	v.Target.Firmware.SecureBoot = &off
	if c := v.secureBoot(h.x, h.root); c.Result != api.VerifyOK {
		t.Error("secure boot off")
	}
	on := true
	v.Target.Firmware.SecureBoot = &on
	h.x.Plan.SecureBoot.Loaders = []baremetal.LoaderCheck{{Path: "/boot/efi/EFI/debian/shimx64.efi", Verdict: "unsigned"}}
	if c := v.secureBoot(h.x, h.root); c.Result == api.VerifyOK {
		t.Error("an unsigned chain passed")
	}
}

func mkdirsArgs(p *baremetal.RestorePlan) []string {
	for _, s := range p.Steps {
		if s.Kind == "mkdirs" {
			return s.Args[1:]
		}
	}
	return nil
}

func TestVerifyAllTen(t *testing.T) {
	h, _, v := verifyHarness(t)
	checks := v.Verify(context.Background(), h.x)
	if len(checks) != 10 {
		t.Fatalf("%d checks", len(checks))
	}
	for i, c := range checks {
		if c.ID != CheckIDs[i] {
			t.Errorf("check %d is %s", i, c.ID)
		}
		for _, f := range c.Findings {
			if !knownCode(f.Code) {
				t.Errorf("%s: unknown code %s", c.ID, f.Code)
			}
		}
	}
	if !strings.Contains(sourceDevice("UUID=AbC"), "by-uuid/abc") || sourceDevice("/dev/sda1") != "/dev/sda1" {
		t.Error("source device")
	}
}

// minimalPE is a PE32+ EFI application with one section of the given
// content (unsigned): enough for InspectLoader to hash it.
func minimalPE(content string) []byte {
	const peOff, optSize, headers = 0x40, 240, 0x400
	buf := make([]byte, headers)
	copy(buf, "MZ")
	binary.LittleEndian.PutUint32(buf[0x3c:], peOff)
	copy(buf[peOff:], "PE\x00\x00")
	coff := buf[peOff+4:]
	binary.LittleEndian.PutUint16(coff[0:], 0x8664)
	binary.LittleEndian.PutUint16(coff[2:], 1)
	binary.LittleEndian.PutUint16(coff[16:], optSize)
	binary.LittleEndian.PutUint16(coff[18:], 0x0022)
	opt := buf[peOff+24:]
	binary.LittleEndian.PutUint16(opt[0:], 0x20b)
	binary.LittleEndian.PutUint32(opt[32:], 0x1000)
	binary.LittleEndian.PutUint32(opt[36:], 0x200)
	binary.LittleEndian.PutUint32(opt[56:], 0x2000)
	binary.LittleEndian.PutUint32(opt[60:], headers)
	binary.LittleEndian.PutUint16(opt[68:], 10)
	binary.LittleEndian.PutUint32(opt[108:], 16)
	sh := buf[peOff+24+optSize:]
	copy(sh[0:8], ".text")
	binary.LittleEndian.PutUint32(sh[8:], uint32(len(content)))
	binary.LittleEndian.PutUint32(sh[12:], 0x1000)
	binary.LittleEndian.PutUint32(sh[16:], 0x200)
	binary.LittleEndian.PutUint32(sh[20:], headers)
	binary.LittleEndian.PutUint32(sh[36:], 0x40000040)
	body := make([]byte, 0x200)
	copy(body, content)
	return append(buf, body...)
}

// Finding 8: the image the system starts with must have been rebuilt, and
// what the check could not look at is said, never a silent ok.
func TestVerifyInitramfsNotRebuilt(t *testing.T) {
	ctx := context.Background()
	const img = "/boot/initrd.img-6.1.0-27-amd64"
	full := func(IsolateSpec) string {
		return "usr/lib/modules/6.1.0-27-amd64/kernel/drivers/nvme/host/nvme.ko\nusr/sbin/cryptsetup\nusr/sbin/lvm\n"
	}
	has := func(c *Check, id string) bool {
		for i := range c.Findings {
			if i < len(c.texts) && c.texts[i].id == id {
				return true
			}
		}
		return false
	}
	// The image of the backup, restored and not rebuilt: it is older than
	// the start of the recovery.
	h, _, v := verifyHarness(t)
	h.iso.reply = full
	h.root.put(img, "img")
	h.x.report.StartedAt = time.Now().Add(time.Hour)
	c := v.initramfs(ctx, h.x, h.root)
	if c.Result != api.VerifyFailed || !has(c, "img_stale") || c.Evidence["rebuilt"] != false {
		t.Errorf("an initramfs that was not rebuilt: %s %+v %v", c.Result, c.Findings, c.Evidence)
	}
	if Judge([]api.RecoveryCheck{c.RecoveryCheck}) != api.VerifyFailed {
		t.Error("the report with a stale initramfs is not failed")
	}
	// Missing altogether.
	h, _, v = verifyHarness(t)
	h.iso.reply = full
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyFailed || !has(c, "img_missing") {
		t.Errorf("a missing initramfs: %s %+v", c.Result, c.Findings)
	}
	// The tools that open the storage under / (LUKS on LVM here).
	for _, tc := range []struct{ listing, missing string }{
		{"kernel/drivers/nvme/host/nvme.ko\nusr/sbin/lvm\n", "cryptsetup"},
		{"kernel/drivers/nvme/host/nvme.ko\nusr/sbin/cryptsetup\n", "lvm"},
		{"kernel/drivers/nvme/host/nvme.ko\nusr/lib/cryptsetup-nonsense/x\nusr/sbin/lvm\n", "cryptsetup"},
	} {
		h, _, v = verifyHarness(t)
		h.root.put(img, "img")
		h.iso.reply = func(IsolateSpec) string { return tc.listing }
		c := v.initramfs(ctx, h.x, h.root)
		if c.Result != api.VerifyFailed || len(c.Findings) != 1 || c.Findings[0].Ref != tc.missing {
			t.Errorf("an initramfs without %s: %s %+v", tc.missing, c.Result, c.Findings)
		}
	}
	h, _, v = verifyHarness(t)
	h.root.put(img, "img")
	h.iso.reply = func(IsolateSpec) string {
		return "-rwxr-xr-x 1 root root 1 Jan  1 00:00 usr/lib/systemd/systemd-cryptsetup\nkernel/drivers/nvme/host/nvme.ko\nlrwxrwxrwx 1 root root 3 Jan  1 00:00 usr/sbin/lvm -> lvm2\n"
	}
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("systemd-cryptsetup and lvm in an ls -l listing: %s %+v", c.Result, c.Findings)
	}
	// Nothing to list the image with: a warning, not ok.
	h, _, v = verifyHarness(t)
	h.root.put(img, "img")
	h.x.Isolator = nil
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyWarning || !has(c, "img_unlisted") {
		t.Errorf("an image nobody listed: %s %+v", c.Result, c.Findings)
	}
	// The backup names no initramfs for the default kernel, or no default
	// kernel at all: said as a warning.
	h, _, v = verifyHarness(t)
	h.x.Manifest.Linux.Kernels[0].Initramfs = nil
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyWarning || !has(c, "img_unknown") {
		t.Errorf("no initramfs in the manifest: %s %+v", c.Result, c.Findings)
	}
	h, _, v = verifyHarness(t)
	h.x.Manifest.Linux.Kernels = nil
	var steps []baremetal.Step
	for _, s := range h.x.Plan.Steps {
		if s.Kind != "initramfs" {
			steps = append(steps, s)
		}
	}
	h.x.Plan.Steps = steps
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyWarning || !has(c, "no_kernel") {
		t.Errorf("no default kernel: %s %+v", c.Result, c.Findings)
	}
	// The system starts a unified kernel image.
	const ukiPath = "/boot/efi/EFI/Linux/linux-6.1.0-27-amd64.efi"
	ukiHarness := func(planned bool) (*harness, StandardVerifier) {
		h, _, v := verifyHarness(t)
		h.x.Manifest.Linux.Kernels = []baremetal.Kernel{{Version: "6.1.0-27-amd64", Image: ukiPath, UKI: true, Default: true}}
		var steps []baremetal.Step
		for _, s := range h.x.Plan.Steps {
			if s.Kind != "initramfs" {
				steps = append(steps, s)
			}
		}
		if planned {
			steps = append(steps, baremetal.Step{Phase: "post", Kind: "uki", Target: strPtrT("6.1.0-27-amd64")})
		}
		h.x.Plan.Steps = steps
		return h, v
	}
	h, v = ukiHarness(true)
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyFailed || !has(c, "img_missing") {
		t.Errorf("a missing unified kernel image: %s %+v", c.Result, c.Findings)
	}
	h.root.put(ukiPath, "uki")
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyOK || c.Evidence["uki"] != true {
		t.Errorf("a rebuilt unified kernel image: %s %+v %v", c.Result, c.Findings, c.Evidence)
	}
	h.x.report.StartedAt = time.Now().Add(time.Hour)
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyFailed || !has(c, "img_stale") {
		t.Errorf("a unified kernel image the plan was to rebuild and did not: %s %+v", c.Result, c.Findings)
	}
	h, v = ukiHarness(false)
	h.root.put(ukiPath, "uki")
	h.x.report.StartedAt = time.Now().Add(time.Hour)
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyWarning || !has(c, "uki_stale") {
		t.Errorf("a unified kernel image the plan cannot rebuild: %s %+v", c.Result, c.Findings)
	}
}

// Finding 9: a UEFI target without a boot entry and without a fallback
// path does not start; a loader the backup does not list is at least on
// the ESP.
func TestVerifyBootEntriesHonest(t *testing.T) {
	without := func(h *harness, kinds ...string) {
		var steps []baremetal.Step
		for _, s := range h.x.Plan.Steps {
			drop := false
			for _, k := range kinds {
				drop = drop || s.Kind == k
			}
			if !drop {
				steps = append(steps, s)
			}
		}
		h.x.Plan.Steps = steps
	}
	text := func(c *Check) string {
		var ids []string
		for _, x := range c.texts {
			ids = append(ids, x.id)
		}
		return strings.Join(ids, ",")
	}
	// The plan wrote no entry (no active entry of the backup has its
	// partition) and there is no fallback path.
	h, env, v := verifyHarness(t)
	without(h, "nvram", "fallback_path")
	c := v.bootEntries(h.x, h.root)
	if c.Result != api.VerifyFailed || text(c) != "no_entry" {
		t.Errorf("no entry and no fallback path: %s %s %v", c.Result, text(c), c.Evidence)
	}
	// Only the fallback path: the system starts, the operator is told.
	h.root.put("/boot/efi/EFI/BOOT/BOOTX64.EFI", "fallback")
	h.x.Manifest.Linux.Loaders = nil
	c = v.bootEntries(h.x, h.root)
	if c.Result != api.VerifyWarning || text(c) != "only_fallback" || c.Evidence["fallbackPath"] != true {
		t.Errorf("only the fallback path: %s %s %v", c.Result, text(c), c.Evidence)
	}
	// The plan wanted an entry and none was written.
	h, env, v = verifyHarness(t)
	h.root.put("/boot/efi/EFI/BOOT/BOOTX64.EFI", "fallback")
	h.x.Manifest.Linux.Loaders = nil
	c = v.bootEntries(h.x, h.root)
	if c.Result != api.VerifyFailed || !strings.Contains(text(c), "entry_count") {
		t.Errorf("an entry of the plan that was not written: %s %s", c.Result, text(c))
	}
	// An entry whose loader the backup does not list: missing on the ESP
	// it fails, present it is a warning (nothing proves its content). The
	// firmware and FAT do not tell cases apart.
	h, env, v = verifyHarness(t)
	h.x.report.BootEntries = []int{3}
	env.order = []int64{3}
	env.entries = map[int]baremetal.LoadOption{3: {Path: `\EFI\nonexistent\x.efi`}}
	c = v.bootEntries(h.x, h.root)
	if c.Result != api.VerifyFailed || text(c) != "ldr_missing" {
		t.Errorf("a loader that is not on the ESP: %s %s", c.Result, text(c))
	}
	h.root.put("/boot/efi/EFI/Nonexistent/X.EFI", "loader")
	c = v.bootEntries(h.x, h.root)
	if c.Result != api.VerifyWarning || text(c) != "ldr_unlisted" {
		t.Errorf("a loader on the ESP the backup does not list: %s %s", c.Result, text(c))
	}
	// The fallback path the plan was to set up (and the operator did not
	// decline) is missing.
	h, env, v = verifyHarness(t)
	h.x.Plan.Steps = append(h.x.Plan.Steps, baremetal.Step{Phase: "post", Kind: "fallback_path", Target: strPtrT("/boot/efi")})
	h.x.Fallback = true
	h.x.report.BootEntries = []int{3}
	env.order = []int64{3}
	env.entries = map[int]baremetal.LoadOption{3: {Path: `\EFI\debian\x.efi`}}
	h.root.put("/boot/efi/EFI/debian/x.efi", "loader")
	c = v.bootEntries(h.x, h.root)
	if c.Result != api.VerifyFailed || !strings.Contains(text(c), "no_fallback") {
		t.Errorf("a planned fallback path that is missing: %s %s", c.Result, text(c))
	}
	h.x.Fallback = false
	if c = v.bootEntries(h.x, h.root); c.Result != api.VerifyWarning || strings.Contains(text(c), "no_fallback") {
		t.Errorf("a fallback path the operator declined: %s %s", c.Result, text(c))
	}
	// BIOS without a boot disk in the plan: nothing was proven.
	h, _, v = verifyHarness(t)
	v.Target.Firmware.Mode = "bios"
	if c = v.bootEntries(h.x, h.root); c.Result != api.VerifyWarning || text(c) != "no_boot_disk" {
		t.Errorf("BIOS without boot code in the plan: %s %s", c.Result, text(c))
	}
}

// Finding 10: a crypttab entry with a random key is plain dm-crypt whatever
// its options say: it is formatted at every start, so its source must be
// exactly the planned partition.
func TestVerifyCrypttabRandomKey(t *testing.T) {
	for _, tc := range []struct {
		name, tab string
		exists    []string
		plain     map[string]string
		want      string
		findings  int
	}{
		{"random key, device name that exists", "cdata /dev/sdb2 /dev/urandom\n", []string{"/dev/sdb2"}, nil, api.VerifyFailed, 1},
		{"random key with cipher options", "cscratch /dev/sdb3 /dev/urandom cipher=aes-xts-plain64,size=256\n", nil, nil, api.VerifyFailed, 1},
		{"/dev/random", "cdata /dev/sdb2 /dev/random noauto\n", []string{"/dev/sdb2"}, nil, api.VerifyFailed, 1},
		{"random key, another partition than planned", "cdata PARTUUID=0000 /dev/urandom\n", []string{"/dev/disk/by-partuuid/0000"},
			map[string]string{"cdata": "PARTUUID=abcd"}, api.VerifyFailed, 1},
		{"random key, the planned partition", "cdata PARTUUID=abcd /dev/urandom\n", []string{"/dev/disk/by-partuuid/abcd"},
			map[string]string{"cdata": "PARTUUID=abcd"}, api.VerifyOK, 0},
		{"the planned partition does not exist", "cdata PARTUUID=abcd /dev/urandom\n", nil, map[string]string{"cdata": "PARTUUID=abcd"}, api.VerifyFailed, 1},
		{"planned for another name", "cdata PARTUUID=abcd /dev/urandom swap\n", []string{"/dev/disk/by-partuuid/abcd"},
			map[string]string{"cswap": "PARTUUID=abcd"}, api.VerifyFailed, 1},
		{"LUKS by option with a device name", "cdata /dev/sdb2 none luks\n", []string{"/dev/sdb2"}, nil, api.VerifyOK, 0},
	} {
		h, env, v := verifyHarness(t)
		for _, d := range tc.exists {
			env.exists[d] = true
		}
		for k, val := range tc.plain {
			h.x.Fixups.PlainSources[k] = val
		}
		h.root.put("/etc/crypttab", tc.tab)
		c := v.crypttab(h.x, h.root)
		if c.Result != tc.want || len(c.Findings) != tc.findings {
			t.Errorf("%s: %s %+v, want %s with %d findings", tc.name, c.Result, c.Findings, tc.want, tc.findings)
		}
	}
	// A volume the backup recorded as plain dm-crypt, with a key file and
	// no telling option.
	h, env, v := verifyHarness(t)
	h.x.Manifest.Linux.PlainCrypt = []baremetal.PlainCrypt{{ID: "p0", MappedName: "cplain"}}
	env.exists["/dev/sdb4"] = true
	h.root.put("/etc/crypttab", "cplain /dev/sdb4 /etc/keys/plain.key\n")
	if c := v.crypttab(h.x, h.root); c.Result != api.VerifyFailed {
		t.Errorf("a plain volume of the backup with a device name: %s %+v", c.Result, c.Findings)
	}
}
