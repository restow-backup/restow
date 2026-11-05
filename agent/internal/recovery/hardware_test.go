package recovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

func loadHW(t *testing.T, name string) HardwareInput {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata/hw", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var in HardwareInput
	if err := json.Unmarshal(b, &in); err != nil {
		t.Fatal(err)
	}
	return in
}

func diskList(ds []baremetal.TargetDisk) string {
	var p []string
	for _, d := range ds {
		p = append(p, d.Path+"="+deref(d.Identity))
	}
	return strings.Join(p, " ")
}

func TestBuildTarget(t *testing.T) {
	for _, c := range []struct {
		name, disks, others string
		notes               []string
	}{
		{"nvme-sata", "/dev/nvme0n1=eui.0025385b71b0e1a2 /dev/sda=wwn.5000c500a1b2c3d4", "", []string{"/dev/sdb:live_medium"}},
		{"nvme-two-ns", "/dev/nvme0n1=serial.S1-1 /dev/nvme0n2=serial.S1-2", "", nil},
		{"hidden-nvme", "/dev/nvme0n1=serial.S1-1", "", []string{"/dev/nvme0c0n1:hidden_nvme_path"}},
		{"multipath", "/dev/sdc=wwn.600a0b8000112233 /dev/sdk=wwn.600a0b8000112233", "", nil},
		{"mmc", "/dev/mmcblk0=serial.0x1234", "", []string{"/dev/mmcblk0boot0:mmc_boot_or_rpmb", "/dev/mmcblk0boot1:mmc_boot_or_rpmb", "/dev/mmcblk0rpmb:mmc_boot_or_rpmb"}},
		{"zoned-ro", "/dev/sdd=wwn.5000000000000004", "", []string{"/dev/sda:zoned", "/dev/sdb:read_only", "/dev/sdc:zero_size"}},
		{"san", "/dev/sda=wwn.5000000000000011 /dev/sdb=wwn.5000000000000012 /dev/sdc=wwn.5000000000000013", "", nil},
		{"virtio-bypath", "/dev/vda=path.pci-0000:00:05.0", "", nil},
		{"old-disk", "/dev/sda=wwn.5000000000000021", "/dev/sdb=wwn.5000000000000022", []string{"/dev/sdb:read_only", "/dev/sdc:live_medium"}},
	} {
		tg, notes := BuildTarget(loadHW(t, c.name))
		if got := diskList(tg.Disks); got != c.disks {
			t.Errorf("%s: disks %q, want %q", c.name, got, c.disks)
		}
		if got := diskList(tg.Others); got != c.others {
			t.Errorf("%s: others %q, want %q", c.name, got, c.others)
		}
		var ns []string
		for _, n := range notes {
			ns = append(ns, n.Device+":"+n.Reason)
		}
		if strings.Join(ns, ",") != strings.Join(c.notes, ",") {
			t.Errorf("%s: notes %v, want %v", c.name, ns, c.notes)
		}
		// The target is valid for the planner.
		b, err := json.Marshal(tg)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := baremetal.ParseTarget(b); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

// TestBuildTargetMultipathProblem: two paths of one LUN are a problem of
// the plan, never two targets.
func TestBuildTargetMultipathProblem(t *testing.T) {
	m := loadManifestFile(t, "debian12-uefi-luks-lvm")
	tg, _ := BuildTarget(loadHW(t, "multipath"))
	p, _ := baremetal.Plan(m, tg, nil, baremetal.Choices{})
	found := false
	for _, f := range p.Problems {
		found = found || f.Code == baremetal.ProblemMultipathDetected
	}
	if !found || p.OK {
		t.Errorf("no multipath problem: %+v", p.Problems)
	}
}

func TestExchangeHardware(t *testing.T) {
	tg, _ := BuildTarget(loadHW(t, "nvme-sata"))
	h := ExchangeHardware(tg)
	if h.Firmware != "uefi" || len(h.Disks) != 2 || h.Disks[1].WWN != "0x5000c500a1b2c3d4" || h.RAMBytes != 17179869184 {
		t.Errorf("%+v", h)
	}
	if FormatBytes(512110190592) != "476.9 GiB" || FormatBytes(1<<20) != "1.0 MiB" || FormatBytes(12) != "12 B" {
		t.Error("format bytes")
	}
}

func loadManifestFile(t *testing.T, name string) *baremetal.Manifest {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("../baremetal/testdata/manifests", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := baremetal.Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// TestQEMUIdentities: the disks of the end-to-end cases as recover sees
// them under QEMU. The same fixture is checked by
// scripts/recovery-e2e/run.test.mjs (identityOf), so the answers files of
// the cases name the identities recover reports (C-M4-4).
func TestQEMUIdentities(t *testing.T) {
	b, err := os.ReadFile("testdata/hw/qemu-e2e.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Expect map[string]string `json:"expectIdentity"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	in := loadHW(t, "qemu-e2e")
	if len(in.Blocks) != len(fx.Expect) {
		t.Fatalf("%d blocks, %d expected identities", len(in.Blocks), len(fx.Expect))
	}
	for _, blk := range in.Blocks {
		if got := Identity(blk); got != fx.Expect[blk.KName] {
			t.Errorf("%s: %q, want %q", blk.KName, got, fx.Expect[blk.KName])
		}
	}
}

// TestIdentityNVMeWWID: lsblk shows an NVMe namespace's wwid in its WWN
// column; it is no WWN and never gives a wwn. identity.
func TestIdentityNVMeWWID(t *testing.T) {
	for _, c := range []struct {
		b    BlockInfo
		want string
	}{
		{BlockInfo{WWN: "eui.525400E2E0000002", Serial: "S", NSID: 1}, "eui.525400e2e0000002"},
		{BlockInfo{WWN: "eui.525400e2e0000002", EUI64: "525400e2e0000002", Serial: "S", NSID: 1}, "eui.525400e2e0000002"},
		{BlockInfo{WWN: "eui.0123456789abcdef0123456789abcdef", Serial: "S", NSID: 1}, "nguid.0123456789abcdef0123456789abcdef"},
		{BlockInfo{WWN: "nvme.1b36-72657374-51454d55-00000001", Serial: "S", NSID: 1}, "serial.S-1"},
		{BlockInfo{WWN: "0x5000C500A1B2C3D4", Serial: "S"}, "wwn.5000c500a1b2c3d4"},
		{BlockInfo{WWN: "naa.600a0b8000112233", Serial: "S"}, "wwn.600a0b8000112233"},
	} {
		if got := Identity(c.b); got != c.want {
			t.Errorf("%+v: %q, want %q", c.b, got, c.want)
		}
	}
}
