//go:build linux && agentroot

package baremetal

// The layout capture on real storage stacks built from loop devices
// (docs/BAREMETAL.md 21.2, CI job agent-root): GPT with an ESP, ext4 and
// an LVM PV with XFS; md RAID1; LUKS2; btrfs with nested subvolumes. The
// expectations are the structure each stack must produce (the identifiers
// of loop devices and UUIDs differ per run). The real machine's own disks
// are captured as well, which checks the collectors against whatever the
// runner has. Root and RESTOW_AGENT_ROOT=1 only: the tests change the
// storage of the machine they run on. With RESTOW_AGENTROOT_OUT set, the
// manifest and raw files are written there (material for the recordings of
// 27.1).

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type rootEnv struct {
	t    *testing.T
	ctx  context.Context
	work string
}

func newRootEnv(t *testing.T) *rootEnv {
	t.Helper()
	if os.Getenv("RESTOW_AGENT_ROOT") != "1" {
		t.Skip("agent-root test: set RESTOW_AGENT_ROOT=1 and run as root (CI job agent-root)")
	}
	if os.Geteuid() != 0 {
		t.Fatal("RESTOW_AGENT_ROOT=1 but not root")
	}
	work, err := os.MkdirTemp("/var/tmp", "restow-agentroot-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(work) })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	t.Cleanup(cancel)
	if err := os.MkdirAll(filepath.Join(work, "mnt"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &rootEnv{t: t, ctx: ctx, work: work}
}

func (e *rootEnv) sh(name string, args ...string) string {
	e.t.Helper()
	out, err := exec.CommandContext(e.ctx, name, args...).CombinedOutput()
	if err != nil {
		e.t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out)
}

func (e *rootEnv) try(name string, args ...string) {
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		e.t.Logf("cleanup %s %s: %v %s", name, strings.Join(args, " "), err, out)
	}
}

func have(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}

// image creates a sparse image file; sfdisk input, when given, partitions
// it before it is attached (the kernel then scans the partitions).
func (e *rootEnv) loop(name string, mib int, sfdisk string) string {
	e.t.Helper()
	file := filepath.Join(e.work, name+".img")
	e.sh("truncate", "-s", strconv.Itoa(mib)+"M", file)
	if sfdisk != "" {
		cmd := exec.CommandContext(e.ctx, "sfdisk", "-q", file)
		cmd.Stdin = strings.NewReader(sfdisk)
		if out, err := cmd.CombinedOutput(); err != nil {
			e.t.Fatalf("sfdisk: %v\n%s", err, out)
		}
	}
	dev := strings.TrimSpace(e.sh("losetup", "--find", "--show", "-P", file))
	e.t.Cleanup(func() { e.try("losetup", "-d", dev) })
	if have("udevadm") {
		_, _ = exec.Command("udevadm", "settle").CombinedOutput()
	}
	return dev
}

func (e *rootEnv) mount(dev, name string, opts ...string) string {
	e.t.Helper()
	mnt := filepath.Join(e.work, "mnt", name)
	if err := os.MkdirAll(mnt, 0o755); err != nil {
		e.t.Fatal(err)
	}
	args := []string{}
	if len(opts) > 0 {
		args = append(args, "-o", strings.Join(opts, ","))
	}
	e.sh("mount", append(args, dev, mnt)...)
	e.t.Cleanup(func() { e.try("umount", "-l", mnt) })
	return mnt
}

// includeLoops records loop devices as disks for the length of a test.
func includeLoops(t *testing.T) {
	skipped, disk := skippedTypes["loop"], diskTypes["loop"]
	skippedTypes["loop"], diskTypes["loop"] = false, true
	t.Cleanup(func() { skippedTypes["loop"], diskTypes["loop"] = skipped, disk })
}

func (m *Manifest) diskByKName(kname string) *Disk {
	for i := range m.Linux.Disks {
		if m.Linux.Disks[i].KName == kname {
			return &m.Linux.Disks[i]
		}
	}
	return nil
}

func (m *Manifest) fsByUUID(uuid string) *Filesystem {
	for i := range m.Linux.Filesystems {
		if u := m.Linux.Filesystems[i].UUID; u != nil && strings.EqualFold(*u, uuid) {
			return &m.Linux.Filesystems[i]
		}
	}
	return nil
}

func (e *rootEnv) blkid(dev, tag string) string {
	return strings.TrimSpace(e.sh("blkid", "-p", "-s", tag, "-o", "value", dev))
}

// capture runs the real capture and checks what every manifest must be:
// valid, canonical, byte-identical after decode and encode.
func (e *rootEnv) capture() (*Manifest, RawSet, []byte) {
	e.t.Helper()
	// The stacks were made a moment ago: udev may not have recorded the
	// last of them yet (lsblk reads its types from udev). A machine whose
	// layout the agent captures before a backup has long settled; the
	// capture copes without udev for mounted file systems
	// (TestCaptureMountedWithoutUdevType), the test waits like the
	// machine would have.
	if have("udevadm") {
		_, _ = exec.Command("udevadm", "settle", "--timeout=30").CombinedOutput()
	}
	m, raw, err := CaptureLocal(e.ctx, Options{Hostname: "agentroot", AgentVersion: "0.5.0-agentroot", Hooks: "off"})
	if err != nil {
		e.t.Fatalf("capture: %v", err)
	}
	b, err := m.Encode()
	if err != nil {
		e.t.Fatalf("encode: %v", err)
	}
	back, err := Decode(b)
	if err != nil {
		e.t.Fatalf("decode: %v", err)
	}
	if b2, err := back.Encode(); err != nil || !bytes.Equal(b, b2) {
		e.t.Fatalf("not byte-identical after decode and encode: %v", err)
	}
	for _, u := range m.Linux.Unsupported {
		e.t.Logf("finding %s %s: %s", u.Severity, u.Code, u.Message)
	}
	if out := os.Getenv("RESTOW_AGENTROOT_OUT"); out != "" {
		dir := filepath.Join(out, e.t.Name())
		if err := WriteBaremetalDir(dir, b, raw); err != nil {
			e.t.Logf("writing %s: %v", dir, err)
		}
	}
	return m, raw, b
}

// TestRootCaptureStacks captures the loop-device stacks.
func TestRootCaptureStacks(t *testing.T) {
	e := newRootEnv(t)
	for _, tool := range []string{"sfdisk", "lsblk", "blkid", "pvcreate", "mdadm", "cryptsetup", "mkfs.btrfs", "mkfs.xfs", "mkfs.ext4"} {
		if !have(tool) {
			t.Fatalf("%s is missing (the CI job installs it)", tool)
		}
	}
	includeLoops(t)
	tag := strconv.FormatInt(time.Now().UnixNano()%1_000_000, 10)

	// A: GPT with an ESP, an ext4 /boot and an LVM PV with XFS.
	a := e.loop("gpt", 2048, "label: gpt\nsize=64MiB, type=uefi\nsize=256MiB, type=linux\ntype=lvm\n")
	espFS := "ext4"
	if have("mkfs.vfat") {
		espFS = "vfat"
		e.sh("mkfs.vfat", "-F", "32", a+"p1")
	} else {
		e.sh("mkfs.ext4", "-q", a+"p1")
	}
	e.sh("mkfs.ext4", "-q", a+"p2")
	vg := "rtcap" + tag
	e.sh("pvcreate", "-ff", "-y", a+"p3")
	e.sh("vgcreate", vg, a+"p3")
	t.Cleanup(func() { e.try("vgchange", "-an", vg); e.try("vgremove", "-ff", "-y", vg) })
	e.sh("lvcreate", "-y", "-L", "512M", "-n", "root", vg)
	e.sh("mkfs.xfs", "-q", "-f", "/dev/"+vg+"/root")
	rootMnt := e.mount("/dev/"+vg+"/root", "root")
	bootMnt := e.mount(a+"p2", "boot")
	e.mount(a+"p1", "esp")

	// B: md RAID1 of two loop devices.
	b1, b2 := e.loop("md1", 256, ""), e.loop("md2", 256, "")
	md := "/dev/md/rtcap" + tag
	e.sh("mdadm", "--create", md, "--run", "--level=1", "--raid-devices=2", "--metadata=1.2", b1, b2)
	t.Cleanup(func() {
		e.try("mdadm", "--stop", md)
		e.try("mdadm", "--zero-superblock", b1)
		e.try("mdadm", "--zero-superblock", b2)
	})
	e.sh("mkfs.ext4", "-q", md)
	e.mount(md, "md")

	// C: LUKS2 (quick key derivation; the key file stays in the work dir).
	c := e.loop("luks", 128, "")
	key := filepath.Join(e.work, "luks.key")
	secret := "agentroot-secret-" + tag
	if err := os.WriteFile(key, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	e.sh("cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", c, key)
	name := "rtcap" + tag
	e.sh("cryptsetup", "open", "--key-file", key, c, name)
	t.Cleanup(func() { e.try("cryptsetup", "close", name) })
	e.sh("mkfs.ext4", "-q", "/dev/mapper/"+name)
	e.mount("/dev/mapper/"+name, "crypt")
	luksUUID := strings.TrimSpace(e.sh("cryptsetup", "luksUUID", c))

	// D: btrfs with nested subvolumes.
	d := e.loop("btrfs", 1024, "")
	e.sh("mkfs.btrfs", "-q", "-f", d)
	top := e.mount(d, "btrfs-top")
	e.sh("btrfs", "subvolume", "create", filepath.Join(top, "@data"))
	e.sh("btrfs", "subvolume", "create", filepath.Join(top, "@data", "nested"))
	e.sh("umount", top)
	btrfsMnt := e.mount(d, "btrfs", "subvol=@data")

	m, raw, enc := e.capture()

	// A.
	disk := m.diskByKName(filepath.Base(a))
	if disk == nil || disk.Table == nil || disk.Table.Type != "gpt" || len(disk.Table.Partitions) != 3 {
		t.Fatalf("GPT disk %s: %+v", a, disk)
	}
	if p := disk.Table.Partitions[0]; !strings.EqualFold(p.Type, "c12a7328-f81f-11d2-ba4b-00a0c93ec93b") || p.Number != 1 {
		t.Fatalf("ESP partition: %+v", p)
	}
	var vgOK bool
	for _, v := range m.Linux.LVM.VGs {
		if v.Name == vg {
			vgOK = len(v.LVs) == 1 && v.LVs[0].Name == "root" && v.SizeBytes > 0 && v.FreeBytes > 0
		}
	}
	if !vgOK {
		t.Fatalf("volume group %s: %+v", vg, m.Linux.LVM.VGs)
	}
	if f := m.fsByUUID(e.blkid("/dev/"+vg+"/root", "UUID")); f == nil || f.Type != "xfs" || f.XFS == nil || len(f.Devices) != 1 || f.Devices[0].Kind != "lv" {
		t.Fatalf("XFS on the LV: %+v", f)
	}
	if f := m.fsByUUID(e.blkid(a+"p1", "UUID")); f == nil || f.Type != espFS {
		t.Fatalf("ESP file system: %+v", f)
	}
	mounted := map[string]bool{}
	for _, mt := range m.Linux.Mounts {
		mounted[mt.Target] = true
	}
	for _, p := range []string{rootMnt, bootMnt, btrfsMnt} {
		if !mounted[p] {
			t.Errorf("mount %s missing", p)
		}
	}

	// B.
	var mdOK bool
	for _, a := range m.Linux.MD {
		if a.Level == "raid1" && a.RaidDevices == 2 && len(a.Members) == 2 {
			mdOK = true
		}
	}
	if !mdOK {
		t.Fatalf("md RAID1: %+v", m.Linux.MD)
	}

	// C: recorded, and no secret material anywhere.
	var luksID string
	for _, l := range m.Linux.LUKS {
		if strings.EqualFold(l.UUID, luksUUID) {
			luksID = l.ID
			if l.Version != 2 || l.Keyslots < 1 || l.PBKDF.Type != "pbkdf2" {
				t.Fatalf("LUKS2: %+v", l)
			}
		}
	}
	if luksID == "" {
		t.Fatalf("LUKS %s missing: %+v", luksUUID, m.Linux.LUKS)
	}
	dump := e.sh("cryptsetup", "luksDump", "--dump-json-metadata", c)
	secrets := []string{secret}
	for _, field := range []string{`"salt":"`, `"digest":"`} {
		for _, part := range strings.Split(dump, field)[1:] {
			if v, _, ok := strings.Cut(part, `"`); ok && v != "" {
				secrets = append(secrets, v)
			}
		}
	}
	all := [][]byte{enc}
	for _, b := range raw {
		all = append(all, b)
	}
	for _, s := range secrets {
		for _, b := range all {
			if bytes.Contains(b, []byte(s)) {
				t.Fatalf("secret material %q in the output", s)
			}
		}
	}
	if _, ok := raw["luks-"+luksID+".json"]; !ok {
		t.Errorf("raw/luks-%s.json missing", luksID)
	}

	// D.
	var nested bool
	if f := m.fsByUUID(e.blkid(d, "UUID")); f != nil && f.Btrfs != nil {
		for _, sv := range f.Btrfs.Subvolumes {
			nested = nested || sv.Path == "@data/nested"
		}
	}
	if !nested {
		t.Fatalf("btrfs subvolume @data/nested missing")
	}

	// M2: the captured stacks plan on the same hardware without problems.
	if m.Linux.Verdict == VerdictUnsupported {
		t.Logf("verdict unsupported (the runner's own disks); the plan check is skipped")
		return
	}
	tg, choices, err := SyntheticTarget(m, TargetSame, nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, _ := Plan(m, tg, nil, choices)
	for _, p := range plan.Problems {
		t.Errorf("plan problem %s: %s", p.Code, p.Message)
	}
	if _, err := EncodePlan(plan); err != nil {
		t.Fatal(err)
	}
}

// TestRootCaptureCommand: `restow-agent baremetal capture --raw-dir --out`
// on the machine itself (its real disks; loop devices are not disks
// there).
func TestRootCaptureCommand(t *testing.T) {
	e := newRootEnv(t)
	bin := filepath.Join(e.work, "restow-agent")
	if out, err := exec.Command("go", "build", "-o", bin, "github.com/restow-backup/restow/agent/cmd/restow-agent").CombinedOutput(); err != nil {
		t.Fatalf("building restow-agent: %v\n%s", err, out)
	}
	rawDir, out := filepath.Join(e.work, "raw"), filepath.Join(e.work, "layout.json")
	cmd := exec.CommandContext(e.ctx, bin, "baremetal", "capture", "--raw-dir", rawDir, "--out", out)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("baremetal capture: %v\n%s", err, stderr.String())
	}
	t.Logf("%s", stderr.String())
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Decode(bytes.TrimSuffix(b, []byte("\n")))
	if err != nil {
		t.Fatalf("the written manifest does not decode: %v", err)
	}
	if len(m.Linux.Disks) == 0 || len(m.Linux.Mounts) == 0 {
		t.Fatalf("no disks or mounts on the runner: %d %d", len(m.Linux.Disks), len(m.Linux.Mounts))
	}
	if _, err := os.Stat(filepath.Join(rawDir, "lsblk.json")); err != nil {
		t.Fatalf("raw dir: %v", err)
	}
	if st, err := os.Stat(out); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("manifest file mode: %v %v", st.Mode(), err)
	}
	fmt.Fprintf(os.Stderr, "runner verdict: %s\n", m.Linux.Verdict)
}
