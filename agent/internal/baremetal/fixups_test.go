package baremetal

import (
	"strings"
	"testing"
)

// fixupCase is one table row: input, expected output ("" = unchanged,
// which must come back byte for byte) and the number of changes.
type fixupCase struct {
	name    string
	in, out string
	changes int
}

func runFixups(t *testing.T, fn func([]byte, FixupContext) ([]byte, []FixupChange), c FixupContext, cases []fixupCase) {
	t.Helper()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := []byte(tc.in)
			out, changes := fn(in, c)
			want := tc.out
			if want == "" {
				want = tc.in
				if &out[0] != &in[0] && len(in) > 0 {
					t.Errorf("unchanged input was copied")
				}
			}
			if string(out) != want {
				t.Errorf("got\n%q\nwant\n%q", out, want)
			}
			if len(changes) != tc.changes {
				t.Errorf("%d changes, want %d: %+v", len(changes), tc.changes, changes)
			}
		})
	}
}

func testContext() FixupContext {
	c := FixupContext{
		DeviceNames: map[string]string{
			"/dev/sda1": "UUID=1111", "/dev/sda2": "UUID=2222", "/dev/nvme0n1p3": "UUID=c0c0", "/dev/md127": "UUID=m127",
			"/dev/disk/by-path/pci-0000:00:17.0-ata-1-part1": "UUID=1111", "/dev/sdb1": "PARTUUID=b1b1", "/dev/sdc1": "PARTUUID=c1c1",
		},
		PartUUIDs:          map[string]string{"/dev/sdb1": "PARTUUID=b1b1", "/dev/sdc1": "PARTUUID=c1c1"},
		SubvolIDs:          map[int64]string{256: "@", 257: "@home"},
		MACs:               map[string]string{"3c:ec:ef:12:34:56": "a0:36:9f:00:00:01"},
		MissingESPs:        []string{"AAAA-1111"},
		PlainSources:       map[string]string{"cswap": "PARTUUID=ae100000-0000-4000-8000-000000000003"},
		MD:                 map[string]MDCount{normUUID("a1b2c3d4:e5f60718:293a4b5c:6d7e8f90"): {Devices: 2, Spares: 0}},
		PVUUIDs:            []string{"Ab12Cd-34Ef"},
		NotRestored:        map[string]bool{"/srv/old": true},
		BIOSInstallDevices: []string{"/dev/disk/by-id/ata-NEW1"},
		ESPInstallDevices:  []string{"/dev/disk/by-id/nvme-NEW-part1"},
		ResumeOffset:       int64Ptr(34816),
	}
	return c
}

func int64Ptr(n int64) *int64 { return &n }

func TestFixFstab(t *testing.T) {
	runFixups(t, FixFstab, testContext(), []fixupCase{
		{"device names", "/dev/sda1\t/boot\text4\tdefaults\t0 2\n/dev/disk/by-path/pci-0000:00:17.0-ata-1-part1 /x ext4 defaults 0 0\n",
			"UUID=1111\t/boot\text4\tdefaults\t0 2\nUUID=1111 /x ext4 defaults 0 0\n", 2},
		{"stable sources stay", "# comment\nUUID=2222 / ext4 errors=remount-ro 0 1\n/dev/mapper/vg-home /home ext4 defaults 0 2\n\ntmpfs /tmp tmpfs defaults 0 0\n", "", 0},
		{"subvolid", "UUID=2222 / btrfs subvolid=256,compress=zstd:1 0 0\nUUID=2222 /home btrfs subvol=/@home,subvolid=257 0 0\n",
			"UUID=2222 / btrfs subvol=/@,compress=zstd:1 0 0\nUUID=2222 /home btrfs subvol=/@home 0 0\n", 2},
		{"not restored", "UUID=9999 /srv/old xfs defaults 0 2\n",
			"# restow: the file system of the next line was not restored\nUUID=9999 /srv/old xfs defaults,nofail 0 2\n", 1},
		{"no final newline", "/dev/sda2 / ext4 defaults 0 1", "UUID=2222 / ext4 defaults 0 1", 1},
	})
}

func TestFixCrypttab(t *testing.T) {
	runFixups(t, FixCrypttab, testContext(), []fixupCase{
		{"luks device name", "nvme0n1p3_crypt /dev/nvme0n1p3 none luks,discard\n", "nvme0n1p3_crypt UUID=c0c0 none luks,discard\n", 1},
		{"plain always", "cswap /dev/vda3 /dev/urandom swap,cipher=aes-xts-plain64,size=256\n",
			"cswap PARTUUID=ae100000-0000-4000-8000-000000000003 /dev/urandom swap,cipher=aes-xts-plain64,size=256\n", 1},
		{"unchanged", "# <target name> <source device> <key file> <options>\ndata UUID=2b1f none luks\n", "", 0},
	})
}

func TestFixMdadmConf(t *testing.T) {
	runFixups(t, FixMdadmConf, testContext(), []fixupCase{
		{"device and spares", "DEVICE /dev/sda2 /dev/sdb2\nARRAY /dev/md/0 metadata=1.2 num-devices=3 spares=1 UUID=a1b2c3d4:e5f60718:293a4b5c:6d7e8f90 name=srv02:0\n",
			"DEVICE partitions containers\nARRAY /dev/md/0 metadata=1.2 num-devices=2 spares=0 UUID=a1b2c3d4:e5f60718:293a4b5c:6d7e8f90 name=srv02:0\n", 2},
		{"unchanged", "DEVICE partitions containers\n# definitions of existing MD arrays\nARRAY /dev/md/0 metadata=1.2 UUID=a1b2c3d4:e5f60718:293a4b5c:6d7e8f90 name=srv02:0\nMAILADDR root\n", "", 0},
	})
}

func TestFixKernelCmdline(t *testing.T) {
	runFixups(t, FixKernelCmdline, testContext(), []fixupCase{
		{"default grub", "GRUB_CMDLINE_LINUX_DEFAULT=\"quiet\"\nGRUB_CMDLINE_LINUX=\"root=/dev/sda2 resume=/dev/sda1 resume_offset=1234\"\n",
			"GRUB_CMDLINE_LINUX_DEFAULT=\"quiet\"\nGRUB_CMDLINE_LINUX=\"root=UUID=2222 resume=UUID=1111 resume_offset=34816\"\n", 3},
		{"mkinitcpio", "options cryptdevice=/dev/nvme0n1p3:root cryptkey=/dev/sda1:ext4:/key.bin root=/dev/mapper/root rw\n",
			"options cryptdevice=UUID=c0c0:root cryptkey=UUID=1111:ext4:/key.bin root=/dev/mapper/root rw\n", 2},
		{"md and rd.luks.key", "md=0,/dev/sdb1,/dev/sdc1 rd.luks.key=/etc/key:/dev/sda1 rd.md.uuid=a1b2 rd.lvm.lv=vg/root\n",
			"md=0,PARTUUID=b1b1,PARTUUID=c1c1 rd.luks.key=/etc/key:UUID=1111 rd.md.uuid=a1b2 rd.lvm.lv=vg/root\n", 2},
		{"bls entry", "# managed by kernel-install\ntitle\tFedora Linux\nversion 6.11.5\nlinux /vmlinuz-6.11.5\noptions\troot=UUID=2222 ro rootflags=subvol=@ rhgb quiet\n", "", 0},
		{"comment kept", "# root=/dev/sda2 was the old one\nroot=/dev/sda2 ro\n", "# root=/dev/sda2 was the old one\nroot=UUID=2222 ro\n", 1},
	})
}

func TestFixSmallFiles(t *testing.T) {
	c := testContext()
	runFixups(t, FixResumeConf, c, []fixupCase{
		{"resume", "RESUME=/dev/sda1\n", "RESUME=UUID=1111\n", 1},
		{"resume quoted", "RESUME=\"/dev/sda1\"\n", "RESUME=\"UUID=1111\"\n", 1},
		{"resume none", "RESUME=none\n", "", 0},
	})
	runFixups(t, FixMountUnit, c, []fixupCase{
		{"mount unit", "[Mount]\nWhat=/dev/sda2\nWhere=/srv\nType=ext4\n", "[Mount]\nWhat=/dev/disk/by-uuid/2222\nWhere=/srv\nType=ext4\n", 1},
		{"swap unit", "[Swap]\nWhat=/dev/sdb1\n", "[Swap]\nWhat=/dev/disk/by-partuuid/b1b1\n", 1},
		{"stable", "[Mount]\nWhat=/dev/disk/by-uuid/2222\n", "", 0},
	})
	runFixups(t, FixDracutAddDevice, c, []fixupCase{
		{"add_device", "add_device+=\" /dev/sda2 \"\nhostonly=\"yes\"\n", "add_device+=\" /dev/disk/by-uuid/2222 \"\nhostonly=\"yes\"\n", 1},
		{"other line", "install_items+=\" /dev/sda2 \"\n", "", 0},
	})
	runFixups(t, FixProxmoxBootUUIDs, c, []fixupCase{
		{"remove missing", "AAAA-1111\nBBBB-2222\n", "BBBB-2222\n", 1},
		{"keep", "BBBB-2222\n", "", 0},
	})
}

func TestFixLVMFilter(t *testing.T) {
	c := testContext()
	runFixups(t, FixLVMFilter, c, []fixupCase{
		{"filter", "devices {\n\tfilter = [ \"a|/dev/sda3|\", \"r|.*|\" ]\n}\n",
			"devices {\n\tfilter = [ \"a|^/dev/disk/by-id/lvm-pv-uuid-Ab12Cd-34Ef$|\", \"r|.*|\" ]\n}\n", 1},
		{"no device names", "devices {\n\tfilter = [ \"a|.*|\" ]\n}\n", "", 0},
		{"multi-line left alone", "devices {\n\tglobal_filter = [ \"a|/dev/sda3|\",\n\t\"r|.*|\" ]\n}\n", "", 0},
	})
	c.AllowMixedBlockSizes = true
	runFixups(t, FixLVMFilter, c, []fixupCase{
		{"mixed set", "devices {\n\tallow_mixed_block_sizes = 0\n}\n", "devices {\n\tallow_mixed_block_sizes = 1\n}\n", 1},
		{"mixed added", "devices {\n\tissue_discards = 1\n}\n", "devices {\n\tallow_mixed_block_sizes = 1\n\tissue_discards = 1\n}\n", 1},
	})
}

func TestFixGrubInstallDevices(t *testing.T) {
	c := testContext()
	debconf := "Name: grub-pc/install_devices\nTemplate: grub-pc/install_devices\nValue: /dev/disk/by-id/ata-OLD1, /dev/disk/by-id/ata-OLD2\nOwners: grub-pc\n\nName: grub-efi/install_devices\nTemplate: grub-efi/install_devices\nValue: /dev/disk/by-id/nvme-OLD-part1\n\nName: other\nValue: /dev/sda\n"
	runFixups(t, FixGrubInstallDevices, c, []fixupCase{
		{"debconf", debconf, strings.Replace(strings.Replace(debconf, "/dev/disk/by-id/ata-OLD1, /dev/disk/by-id/ata-OLD2", "/dev/disk/by-id/ata-NEW1", 1),
			"/dev/disk/by-id/nvme-OLD-part1", "/dev/disk/by-id/nvme-NEW-part1", 1), 2},
		{"suse", "/dev/disk/by-id/ata-OLD1\nactivate\n", "/dev/disk/by-id/ata-NEW1\nactivate\n", 1},
		{"suse unchanged", "/dev/disk/by-id/ata-NEW1\nactivate\n", "", 0},
	})
}

func TestFixMACs(t *testing.T) {
	runFixups(t, FixMACs, testContext(), []fixupCase{
		{"netplan", "network:\n  ethernets:\n    eth0:\n      match:\n        macaddress: 3c:ec:ef:12:34:56\n      set-name: enp3s0\n",
			"network:\n  ethernets:\n    eth0:\n      match:\n        macaddress: a0:36:9f:00:00:01\n      set-name: enp3s0\n", 1},
		{"networkmanager", "[ethernet]\nmac-address=3C:EC:EF:12:34:56\n", "[ethernet]\nmac-address=A0:36:9F:00:00:01\n", 1},
		{"ifcfg", "DEVICE=eno1\nHWADDR=3c:ec:ef:12:34:56\n", "DEVICE=eno1\nHWADDR=a0:36:9f:00:00:01\n", 1},
		{"networkd", "[Match]\nMACAddress=3c:ec:ef:12:34:56\n", "[Match]\nMACAddress=a0:36:9f:00:00:01\n", 1},
		{"persistent net", "# This file was automatically generated.\n\n# PCI device 0x8086:0x1533 (igb)\nSUBSYSTEM==\"net\", ACTION==\"add\", ATTR{address}==\"3c:ec:ef:12:34:56\", NAME=\"eth0\"\n# PCI device 0x8086:0x10d3 (e1000e)\nSUBSYSTEM==\"net\", ACTION==\"add\", ATTR{address}==\"00:11:22:33:44:55\", NAME=\"eth1\"\n",
			"# This file was automatically generated.\n\n# PCI device 0x8086:0x10d3 (e1000e)\nSUBSYSTEM==\"net\", ACTION==\"add\", ATTR{address}==\"00:11:22:33:44:55\", NAME=\"eth1\"\n", 1},
		{"other mac", "HWADDR=00:11:22:33:44:55\n", "", 0},
	})
}

func TestNewFixupContextAndPlanned(t *testing.T) {
	m := loadManifest(t, "plain-dmcrypt-swap")
	c := NewFixupContext(m)
	if c.DeviceNames["/dev/vda2"] != "UUID=ae000000-0000-4000-8000-000000000001" || c.PlainSources["cswap"] != "PARTUUID=ae100000-0000-4000-8000-000000000003" {
		t.Errorf("context %+v", c)
	}
	mbr := NewFixupContext(loadManifest(t, "bios-mbr-mdadm-raid1"))
	if mbr.PartUUIDs["/dev/sda1"] != "PARTUUID=a1b2c3d0-01" {
		t.Errorf("MBR PARTUUID %q", mbr.PartUUIDs["/dev/sda1"])
	}
	fx := PlannedFixups(loadManifest(t, "ubuntu2204-bios-mdadm"))
	var paths []string
	for _, f := range fx {
		paths = append(paths, f.Path)
	}
	for _, want := range []string{"/etc/fstab", "/etc/mdadm/mdadm.conf", "/etc/default/grub", "/var/cache/debconf/config.dat"} {
		if !hasString(paths, want) {
			t.Errorf("planned fixups %v lack %s", paths, want)
		}
	}
	if got := DeviceMapAction(&Manifest{Linux: &LinuxLayout{Bootloader: Bootloader{DeviceMap: true, GrubCfg: strPtr("/boot/grub2/grub.cfg")}}}); len(got) != 1 || got[0] != "/boot/grub2/device.map" {
		t.Errorf("device.map %v", got)
	}
}
