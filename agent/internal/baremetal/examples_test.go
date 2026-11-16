package baremetal

import (
	"fmt"
	"strings"
)

// Hand-built manifests for the shared test data (testdata/manifests). They
// exercise every type of the schema; the manifests captured from the
// fixtures in testdata/capture are added to the same folder by
// `go test -run TestManifests -update`.

func hexOf(c byte) string { return strings.Repeat(string([]byte{c}), 64) }

func header(host string) Header {
	return Header{Format: Format, SchemaVersion: SchemaVersion, Platform: PlatformLinux,
		CapturedAt: "2026-11-04T21:00:03Z", AgentVersion: "0.5.0", Hostname: host}
}

// exampleDebian is the C1 example, filled out: UEFI with Secure Boot, ESP,
// /boot, LUKS2 on the third partition, LVM inside with root, swap and home.
func exampleDebian() *Manifest {
	l := &LinuxLayout{
		OS: OSInfo{ID: "debian", IDLike: []string{}, VersionID: strPtr("12"), PrettyName: strPtr("Debian GNU/Linux 12 (bookworm)"),
			Arch: "amd64", Kernel: "6.1.0-27-amd64", Cmdline: "BOOT_IMAGE=/vmlinuz-6.1.0-27-amd64 root=/dev/mapper/vg0-root ro quiet",
			Init: "systemd", MachineID: true},
		Firmware: Firmware{Mode: "uefi", SecureBoot: boolPtr(true), SetupMode: boolPtr(false),
			Entries: []EFIEntry{
				{Num: 1, Label: "debian", PartUUID: strPtr("5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6"), PartNumber: intPtr(1), Loader: strPtr(`\EFI\debian\shimx64.efi`), Active: true},
				{Num: 0, Label: "UEFI: PXE IPv4", Active: true},
			},
			BootOrder: []int64{1, 0}, BootCurrent: intPtr(1),
			SbatLevel: []string{"sbat,1,2024010900", "shim,4", "grub,3", "grub.debian,4"},
			DB:        []CertRef{{Subject: "CN=Microsoft Corporation UEFI CA 2011,O=Microsoft Corporation,L=Redmond,ST=Washington,C=US", SHA256: hexOf('a')}},
			DBXSha256: strPtr(hexOf('b')),
			MOK:       []MokRef{{Subject: strPtr("CN=DKMS module signing key"), SHA256: hexOf('c')}},
		},
		Loaders: []Loader{{Path: "/boot/efi/EFI/debian/shimx64.efi", Bytes: 959904, AuthenticodeSha256: hexOf('d'),
			Signer: &Signer{Issuer: "CN=Microsoft Corporation UEFI CA 2011,O=Microsoft Corporation,L=Redmond,ST=Washington,C=US",
				Subject: "CN=Microsoft Windows UEFI Driver Publisher,O=Microsoft Corporation,L=Redmond,ST=Washington,C=US", Serial: "33000000"},
			Sbat: []string{"sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md", "shim,4,UEFI shim,shim,1,https://github.com/rhboot/shim"}}},
		Disks: []Disk{{ID: "d0", KName: "nvme0n1", SizeBytes: 512110190592, LogicalSectorSize: 512, PhysicalSectorSize: 512,
			Model: strPtr("Samsung SSD 980 PRO 512GB"), Serial: strPtr("S5GXNX0T123456"), EUI64: strPtr("002538b111b2c3d4"), NSID: intPtr(1),
			Transport: strPtr("nvme"), Zoned: "none", MajMin: "259:0", BootCode: "none",
			DriverChain: []string{"nvme", "pcieport"}, DriverModaliases: []string{"pci:v0000144Dd0000A80Asv0000144Dsd0000A801bc01sc08i02"},
			Table: &PartitionTable{Type: "gpt", ID: "0F6C5E2A-1B3D-4C5E-9F70-8192A3B4C5D6", SectorSize: 512,
				FirstLBA: intPtr(2048), LastLBA: intPtr(1000215182), TableLength: intPtr(128),
				Partitions: []Partition{
					{Number: 1, StartBytes: 1048576, SizeBytes: 536870912, Type: "C12A7328-F81F-11D2-BA4B-00A0C93EC93B", UUID: strPtr("5E1C4D0A-1B2C-4D3E-8F90-A1B2C3D4E5F6"), Name: strPtr("EFI System Partition")},
					{Number: 2, StartBytes: 537919488, SizeBytes: 1023410176, Type: "0FC63DAF-8483-4772-8E79-3D69D8477DE4", UUID: strPtr("6F2D5E1B-2C3D-4E4F-9A01-B2C3D4E5F607")},
					{Number: 3, StartBytes: 1561329664, SizeBytes: 510547755008, Type: "0FC63DAF-8483-4772-8E79-3D69D8477DE4", UUID: strPtr("7A3E6F2C-3D4E-4F50-8B12-C3D4E5F60718"), Grow: boolPtr(true)},
				}}}},
		LUKS: []LUKSVolume{{ID: "c0", Device: PartRef("d0", 3), Version: 2, UUID: "2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d",
			Cipher: "aes-xts-plain64", KeyBits: 512, SectorSize: 512,
			PBKDF:    PBKDF{Type: "argon2id", MemoryKiB: intPtr(1048576), Time: intPtr(4), Parallel: intPtr(4)},
			Keyslots: 1, Flags: []string{"allow-discards"}, MappedName: strPtr("nvme0n1p3_crypt"), CrypttabName: strPtr("nvme0n1p3_crypt")}},
		LVM: LVM{
			PVs: []PV{{Device: LUKSRef("c0"), UUID: "Ab12Cd-34Ef-56Gh-78Ij-90Kl-12Mn-34OpQr", SizeBytes: 510530977792, VG: strPtr("vg0")}},
			VGs: []VolumeGroup{{Name: "vg0", UUID: "Zy98Xw-76Vu-54Ts-32Rq-10Po-98Nm-76LkJi", ExtentBytes: 4194304, SizeBytes: 510526783488, FreeBytes: 48318382080,
				LVs: []LogicalVolume{
					{Name: "root", UUID: "lvroot-0000-0000-0000-0000-0000-000001", Type: "linear", SizeBytes: 53687091200, Stripes: intPtr(1), Active: true},
					{Name: "swap", UUID: "lvswap-0000-0000-0000-0000-0000-000002", Type: "linear", SizeBytes: 8589934592, Stripes: intPtr(1), Active: true},
					{Name: "home", UUID: "lvhome-0000-0000-0000-0000-0000-000003", Type: "linear", SizeBytes: 399931375616, Stripes: intPtr(1), Active: true, Grow: boolPtr(true)},
				}}}},
		Filesystems: []Filesystem{
			{ID: "f0", Devices: []BlockRef{PartRef("d0", 1)}, Type: "vfat", UUID: strPtr("1A2B-3C4D"), SizeBytes: 536870912, UsedBytes: 6291456,
				VFAT: &VFATInfo{FatBits: 32, VolumeID: "1A2B3C4D", SectorsPerCluster: 8, LogicalSectorSize: 512}},
			{ID: "f1", Devices: []BlockRef{PartRef("d0", 2)}, Type: "ext4", UUID: strPtr("8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e"), SizeBytes: 1023410176, UsedBytes: 120586240, InodesUsed: intPtr(342),
				Ext: &ExtInfo{BlockSize: 4096, InodeSize: 256, InodeCount: 62464, Features: []string{"has_journal", "ext_attr", "resize_inode", "dir_index", "filetype", "extent", "64bit", "flex_bg", "sparse_super", "large_file", "huge_file", "dir_nlink", "extra_isize", "metadata_csum"}, ReservedPercent: 5, FlexBgSize: intPtr(16), JournalBytes: intPtr(16777216)}},
			{ID: "f2", Devices: []BlockRef{LVRef("vg0", "root")}, Type: "ext4", UUID: strPtr("9c0d1e2f-3a4b-5c6d-7e8f-9a0b1c2d3e4f"), SizeBytes: 53687091200, UsedBytes: 9123456789, InodesUsed: intPtr(312000),
				Ext: &ExtInfo{BlockSize: 4096, InodeSize: 256, InodeCount: 3276800, Features: []string{"has_journal", "ext_attr", "resize_inode", "dir_index", "filetype", "extent", "64bit", "flex_bg", "sparse_super", "large_file", "huge_file", "dir_nlink", "extra_isize", "metadata_csum"}, ReservedPercent: 5, FlexBgSize: intPtr(16), JournalBytes: intPtr(268435456)}},
			{ID: "f3", Devices: []BlockRef{LVRef("vg0", "home")}, Type: "xfs", UUID: strPtr("0d1e2f3a-4b5c-6d7e-8f9a-0b1c2d3e4f50"), Label: strPtr("home"), SizeBytes: 399931375616, UsedBytes: 120034123776, InodesUsed: intPtr(1200000),
				XFS: &XFSInfo{BlockSize: 4096, SectorSize: 512, AGCount: 4, Features: []string{"crc", "finobt", "ftype", "reflink", "sparse"}, LogBytes: 195305472}},
		},
		Swap: []Swap{{Kind: "partition", Device: refPtr(LVRef("vg0", "swap")), UUID: strPtr("1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5061"), SizeBytes: 8589934592, Priority: "-2"}},
		Mounts: []Mount{
			{Target: "/", FS: strPtr("f2"), Source: "/dev/mapper/vg0-root", Type: "ext4", Options: "rw,relatime,errors=remount-ro"},
			{Target: "/boot", FS: strPtr("f1"), Source: "/dev/nvme0n1p2", Type: "ext4", Options: "rw,relatime"},
			{Target: "/boot/efi", FS: strPtr("f0"), Source: "/dev/nvme0n1p1", Type: "vfat", Options: "rw,relatime,fmask=0077,dmask=0077"},
			{Target: "/home", FS: strPtr("f3"), Source: "/dev/mapper/vg0-home", Type: "xfs", Options: "rw,relatime,attr2,inode64"},
		},
		Fstab: []FstabEntry{
			{Source: "/dev/mapper/vg0-root", Target: "/", Type: "ext4", Options: "errors=remount-ro", Origin: "fstab", Resolved: &FstabResolved{FS: strPtr("f2")}},
			{Source: "UUID=8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e", Target: "/boot", Type: "ext4", Options: "defaults", Origin: "fstab", Resolved: &FstabResolved{FS: strPtr("f1")}},
			{Source: "UUID=1A2B-3C4D", Target: "/boot/efi", Type: "vfat", Options: "umask=0077", Origin: "fstab", Resolved: &FstabResolved{FS: strPtr("f0")}},
			{Source: "/dev/mapper/vg0-home", Target: "/home", Type: "xfs", Options: "defaults", Origin: "fstab", Resolved: &FstabResolved{FS: strPtr("f3")}},
			{Source: "/dev/mapper/vg0-swap", Target: "none", Type: "swap", Options: "sw", Origin: "fstab", Resolved: &FstabResolved{Swap: intPtr(0)}},
		},
		Bootloader: Bootloader{Kind: "grub", Platform: strPtr("x86_64-efi"), Shim: true, ESPs: []string{"f0"}, EFIDirectory: strPtr("/boot/efi"),
			BootloaderID: strPtr("debian"), GrubCfg: strPtr("/boot/grub/grub.cfg"), FallbackChain: true},
		Initramfs: Initramfs{Generator: strPtr("initramfs-tools"), Modules: strPtr("most"),
			Keymap: Keymap{Layout: strPtr("de"), Variant: strPtr("nodeadkeys"), Source: strPtr("/etc/default/keyboard"), InInitramfs: true}},
		Kernels: []Kernel{{Version: "6.1.0-27-amd64", Image: "/boot/vmlinuz-6.1.0-27-amd64", Initramfs: strPtr("/boot/initrd.img-6.1.0-27-amd64"),
			ImageBytes: 8224448, InitramfsBytes: intPtr(61234567), Default: true, Signer: strPtr("Debian Secure Boot Signer 2022 - linux")}},
		Configs:    []FileHash{{Path: "/etc/crypttab", SHA256: hexOf('e')}, {Path: "/etc/fstab", SHA256: hexOf('f')}},
		Network:    []NetInterface{{Name: "enp3s0", MAC: strPtr("3c:ec:ef:12:34:56"), Driver: strPtr("igb"), Modalias: strPtr("pci:v00008086d00001533sv000015D9sd00001533bc02sc00i00"), PCIPath: strPtr("0000:03:00.0"), Physical: true}},
		NetConfigs: []NetConfigRef{{Path: "/etc/udev/rules.d/70-persistent-net.rules", MACs: []string{"3c:ec:ef:12:34:56"}}},
		Backup: Backup{Sources: []string{"/", "/boot", "/boot/efi", "/home"}, Excludes: []string{"/etc/restow-agent/.state-*.tmp", "/etc/restow-agent/state.json", "/var/tmp/*"},
			FSSnapshots: map[string]string{"/": "lvm", "/boot": "live", "/boot/efi": "live", "/home": "lvm"},
			LiveReasons: map[string]string{"/boot": "partition", "/boot/efi": "vfat"}},
		Agent: AgentInfo{Hooks: "off"},
		Raw:   []RawRef{{Name: "lsblk.json", SHA256: hexOf('1')}, {Name: "sfdisk-d0.dump", SHA256: hexOf('2')}, {Name: "vg0.vg", SHA256: hexOf('3')}},
	}
	m := &Manifest{Header: header("srv01"), Linux: l}
	l.Verdict, l.Unsupported = Assess(m)
	return m
}

// exampleBIOS is BIOS with MBR, md RAID1 over two disks, btrfs on the
// array, plain dm-crypt swap and an unresolved data entry.
func exampleBIOS() *Manifest {
	l := &LinuxLayout{
		OS: OSInfo{ID: "ubuntu", IDLike: []string{"debian"}, VersionID: strPtr("22.04"), PrettyName: strPtr("Ubuntu 22.04.5 LTS"),
			Arch: "amd64", Kernel: "5.15.0-125-generic", Cmdline: "BOOT_IMAGE=/vmlinuz root=UUID=4a5b ro rootflags=subvol=@ cryptkey=<redacted>",
			SELinux: nil, Init: "systemd", MachineID: true},
		Firmware: Firmware{Mode: "bios"},
	}
	disk := func(id, kname, serial string) Disk {
		return Disk{ID: id, KName: kname, SizeBytes: 2000398934016, LogicalSectorSize: 512, PhysicalSectorSize: 4096,
			Model: strPtr("WDC WD20EFRX-68E"), Serial: strPtr(serial), WWN: strPtr(map[string]string{"d0": "0x50014ee2b5c6d7e8", "d1": "0x50014ee2b5c6d7e9"}[id]), Transport: strPtr("sata"),
			Rotational: true, Zoned: "none", MajMin: map[string]string{"d0": "8:0", "d1": "8:16"}[id], BootCode: "grub",
			DriverChain: []string{"ahci"},
			Table: &PartitionTable{Type: "dos", ID: map[string]string{"d0": "0xa1b2c3d4", "d1": "0xb2c3d4e5"}[id], SectorSize: 512,
				Partitions: []Partition{
					{Number: 1, StartBytes: 1048576, SizeBytes: 1998000000000, Type: "fd", Attrs: "", Bootable: true, Grow: boolPtr(true)},
					{Number: 2, StartBytes: 1998001048576, SizeBytes: 2397884416, Type: "82"},
				}}}
	}
	l.Disks = []Disk{disk("d0", "sda", "WD-WCC4E1234567"), disk("d1", "sdb", "WD-WCC4E7654321")}
	l.MD = []MDArray{{ID: "m0", Name: strPtr("srv02:0"), KName: "md0", UUID: "a1b2c3d4:e5f60718:293a4b5c:6d7e8f90", Level: "raid1", Metadata: "1.2",
		RaidDevices: 2, SizeBytes: 1997864984576, Members: []MDMember{
			{Device: PartRef("d0", 1), Role: intPtr(0), State: "active sync"},
			{Device: PartRef("d1", 1), Role: intPtr(1), WriteMostly: true, State: "active sync writemostly"},
		}, Bitmap: "internal", Homehost: strPtr("srv02"), State: "clean"}}
	l.PlainCrypt = []PlainCrypt{{ID: "p0", Device: PartRef("d0", 2), MappedName: "cswap", Cipher: "aes-xts-plain64", KeyBits: 256, Purpose: "swap", KeySource: "/dev/urandom", CrypttabName: strPtr("cswap")}}
	l.Filesystems = []Filesystem{{ID: "f0", Devices: []BlockRef{MDRef("m0")}, Type: "btrfs", UUID: strPtr("4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d"),
		UUIDSub: strPtr("5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"), SizeBytes: 1997864984576, UsedBytes: 412345678901,
		Btrfs: &BtrfsInfo{DataProfile: "single", MetadataProfile: "dup", SystemProfile: "dup", NodeSize: 16384, SectorSize: 4096,
			Features:         []string{"extended_iref", "mixed_backref", "no_holes", "skinny_metadata"},
			DefaultSubvolume: SubvolRef{ID: 5, Path: ""},
			Subvolumes: []Subvolume{
				{ID: 256, Path: "@", ParentID: 5, UUID: "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f", Mounted: []string{"/"}, Kind: SubvolNormal},
				{ID: 257, Path: "@home", ParentID: 5, UUID: "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a", Mounted: []string{"/home"}, Kind: SubvolNormal},
				{ID: 258, Path: "@/var/lib/machines", ParentID: 256, UUID: "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b", Mounted: []string{}, Kind: SubvolMachines},
				{ID: 259, Path: "timeshift-btrfs/snapshots/2026-11-01_00-00-01/@", ParentID: 5, UUID: "9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c", ParentUUID: strPtr("6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f"), ReadOnly: true, Mounted: []string{}, Kind: SubvolTimeshift},
			},
			NoCowDirs: []string{"/var/lib/libvirt/images"}}}}
	l.Swap = []Swap{{Kind: "plain", Device: refPtr(PlainRef("p0")), SizeBytes: 2397884416, Priority: "-2"}}
	l.Mounts = []Mount{
		{Target: "/", FS: strPtr("f0"), Source: "/dev/md0", Type: "btrfs", Options: "rw,relatime,space_cache=v2,subvolid=256,subvol=/@", Subvol: strPtr("/@"), SubvolID: intPtr(256)},
		{Target: "/home", FS: strPtr("f0"), Source: "/dev/md0", Type: "btrfs", Options: "rw,relatime,space_cache=v2,subvolid=257,subvol=/@home", Subvol: strPtr("/@home"), SubvolID: intPtr(257)},
		{Target: "/mnt/backup", Source: "nas:/backup", Type: "nfs4", Options: "rw,relatime,vers=4.2"},
	}
	l.Fstab = []FstabEntry{
		{Source: "UUID=4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d", Target: "/", Type: "btrfs", Options: "defaults,subvol=@", Origin: "fstab", Resolved: &FstabResolved{FS: strPtr("f0")}},
		{Source: "UUID=4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d", Target: "/home", Type: "btrfs", Options: "defaults,subvol=@home", Origin: "fstab", Resolved: &FstabResolved{FS: strPtr("f0")}},
		{Source: "/dev/mapper/cswap", Target: "none", Type: "swap", Options: "sw", Origin: "fstab", Resolved: &FstabResolved{Block: refPtr(PlainRef("p0"))}},
		{Source: "nas:/backup", Target: "/mnt/backup", Type: "nfs4", Options: "defaults,_netdev", Origin: "fstab"},
		{Source: "LABEL=usbdisk", Target: "/media/usb", Type: "ext4", Options: "noauto,nofail", Origin: "fstab", Noauto: true, Nofail: true},
		{Source: "/srv/backup.mount", Target: "/srv/backup", Type: "ext4", Options: "x-systemd.automount", Origin: "unit", Unit: strPtr("srv-backup.mount"), Automount: true},
	}
	l.Bootloader = Bootloader{Kind: "grub", Platform: strPtr("i386-pc"), GrubCfg: strPtr("/boot/grub/grub.cfg"), BIOSDisks: []string{"d0", "d1"}, DeviceMap: true}
	l.Initramfs = Initramfs{Generator: strPtr("initramfs-tools"), Modules: strPtr("dep"), AddDevices: []string{},
		Keymap: Keymap{Layout: strPtr("ch"), Variant: nil, Source: strPtr("/etc/default/keyboard"), InInitramfs: false}}
	l.Kernels = []Kernel{
		{Version: "5.15.0-125-generic", Image: "/boot/vmlinuz-5.15.0-125-generic", Initramfs: strPtr("/boot/initrd.img-5.15.0-125-generic"), ImageBytes: 11711232, InitramfsBytes: intPtr(73400320), Default: true},
		{Version: "5.15.0-124-generic", Image: "/boot/vmlinuz-5.15.0-124-generic", ImageBytes: 11711232},
	}
	l.DKMS = []DKMSModule{{Module: "r8125", Version: "9.013.02", Kernel: "5.15.0-125-generic", Kind: "net"}}
	l.DeviceNameRefs = []DeviceNameRef{{Path: "/etc/mdadm/mdadm.conf", Line: 12, Device: "/dev/sda1"}}
	l.Network = []NetInterface{
		{Name: "eno1", MAC: strPtr("00:25:90:ab:cd:ef"), Driver: strPtr("e1000e"), PCIPath: strPtr("0000:00:19.0"), Physical: true},
		{Name: "docker0", MAC: strPtr("02:42:ac:11:00:01"), Physical: false},
	}
	l.NetConfigs = []NetConfigRef{{Path: "/etc/netplan/00-installer-config.yaml", MACs: []string{"00:25:90:ab:cd:ef"}}}
	l.Backup = Backup{Sources: []string{"/", "/home", "/var/lib/machines"}, Excludes: []string{"/etc/restow-agent/.state-*.tmp", "/etc/restow-agent/state.json", "/etc/restow-pve/.state.json.*", "/etc/restow-pve/state.json", "/timeshift/*", "**/lost+found/*"},
		FSSnapshots: map[string]string{"/": "btrfs", "/home": "btrfs", "/var/lib/machines": "btrfs"}, LiveReasons: map[string]string{}}
	l.Agent = AgentInfo{Hooks: "scripts"}
	l.Raw = []RawRef{{Name: "mdadm-detail-m0.txt", SHA256: hexOf('4')}}
	m := &Manifest{Header: header("srv02"), Linux: l}
	l.Verdict, l.Unsupported = Assess(m)
	return m
}

// exampleContainer has no storage stack of its own.
func exampleContainer() *Manifest {
	l := &LinuxLayout{
		OS:         OSInfo{ID: "alpine", Arch: "amd64", Kernel: "6.8.12-4-pve", Cmdline: "", Init: "other"},
		Firmware:   Firmware{Mode: "bios"},
		Bootloader: Bootloader{Kind: "none"},
		Mounts:     []Mount{{Target: "/", Source: "/dev/mapper/pve-vm--101--disk--0", Type: "ext4", Options: "rw,relatime"}},
		Agent:      AgentInfo{Hooks: "off"},
		Unsupported: []Unsupported{{Code: CodeContainer, Message: assessMessages[CodeContainer], Severity: SeverityUnsupported},
			{Code: CodeCaptureFailed, Ref: strPtr("firmware"), Message: "firmware: /sys/firmware is not readable", Severity: SeverityWarning}},
		Backup: Backup{Sources: []string{"/"}},
	}
	m := &Manifest{Header: header("ct101"), Linux: l}
	m.normalize()
	l.Verdict, l.Unsupported = Assess(m)
	return m
}

func exampleDarwin() *Manifest {
	d := &DarwinLayout{
		MacOS:        map[string]any{"productVersion": "15.1", "buildVersion": "24B83", "arch": "arm64"},
		Users:        []map[string]any{{"name": "anna", "uid": 501, "home": "/Users/anna"}},
		Applications: []map[string]any{{"path": "/Applications/Firefox.app", "bundleId": "org.mozilla.firefox", "source": "dragdrop"}},
		Backup:       Backup{Sources: []string{"/System/Volumes/Data"}, Excludes: []string{"/private/etc/restow-agent/state.json"}},
		Agent:        AgentInfo{Hooks: "off"},
		Verdict:      VerdictSupported,
	}
	h := header("mac01")
	h.Platform = PlatformDarwin
	return &Manifest{Header: h, Darwin: d}
}

// exampleTooLarge stays within every list limit but exceeds 512 KiB.
func exampleTooLarge() *Manifest {
	m := exampleDebian()
	for i := 0; i < 2600; i++ {
		m.Linux.Mounts = append(m.Linux.Mounts, Mount{Target: fmt.Sprintf("/srv/data/volume-%04d", i), Source: fmt.Sprintf("/dev/mapper/data-volume%04d", i),
			Type: "ext4", Options: "rw,nosuid,nodev,noexec,relatime,errors=remount-ro,commit=60,stripe=256,data=ordered,x-gvfs-hide"})
	}
	return m
}
