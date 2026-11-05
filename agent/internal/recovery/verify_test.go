package recovery

import (
	"context"
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

	// initramfs: rebuilt and readable with the drivers; /boot low is a
	// warning; an unreadable image fails.
	h, env, v = verifyHarness(t)
	h.root.put("/boot/initrd.img-6.1.0-27-amd64", "img")
	h.iso.reply = func(s IsolateSpec) string { return "usr/lib/modules/6.1.0-27-amd64/kernel/drivers/nvme/host/nvme.ko\n" }
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("initramfs ok: %+v", c.Findings)
	}
	env.free = 5
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyWarning {
		t.Errorf("boot space: %s", c.Result)
	}
	h.iso.exit = 1
	if c := v.initramfs(ctx, h.x, h.root); c.Result != api.VerifyFailed {
		t.Error("unreadable image passed")
	}

	// boot_entries: UEFI entry in BootOrder ok, missing fails; BIOS boot code.
	h, env, v = verifyHarness(t)
	h.x.report.BootEntries = []int{3}
	env.order = []int64{3, 0}
	env.entries = map[int]baremetal.LoadOption{3: {Path: `\EFI\nonexistent\x.efi`}}
	if c := v.bootEntries(h.x, h.root); c.Result != api.VerifyOK {
		t.Errorf("entries ok: %+v", c.Findings)
	}
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
