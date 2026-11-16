package baremetal

import (
	"bytes"
	"fmt"
	"strings"
)

// Synthetic systems of testdata/capture (docs/BAREMETAL.md 21.1). Each
// follows the documented output formats of the tools; the fixture's
// meta.json says "synthetic": true until a recording of a real machine
// (27.1, 21.4 item 1) replaces it.

const (
	GiB = int64(1) << 30
	MiB = int64(1) << 20
)

var osReleases = map[string]string{
	"debian12":   "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\nVERSION=\"12 (bookworm)\"\nID=debian\n",
	"debian13":   "PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"13\"\nID=debian\n",
	"ubuntu2204": "PRETTY_NAME=\"Ubuntu 22.04.5 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"22.04\"\nID=ubuntu\nID_LIKE=debian\n",
	"ubuntu2404": "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nID_LIKE=debian\n",
	"alma9":      "NAME=\"AlmaLinux\"\nVERSION=\"9.5 (Teal Serval)\"\nID=\"almalinux\"\nID_LIKE=\"rhel centos fedora\"\nVERSION_ID=\"9.5\"\nPRETTY_NAME=\"AlmaLinux 9.5 (Teal Serval)\"\n",
	"fedora":     "NAME=\"Fedora Linux\"\nVERSION=\"41 (Workstation Edition)\"\nID=fedora\nVERSION_ID=41\nPRETTY_NAME=\"Fedora Linux 41 (Workstation Edition)\"\n",
	"opensuse":   "NAME=\"openSUSE Leap\"\nVERSION=\"15.6\"\nID=\"opensuse-leap\"\nID_LIKE=\"suse opensuse\"\nVERSION_ID=\"15.6\"\nPRETTY_NAME=\"openSUSE Leap 15.6\"\n",
	"arch":       "NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\nBUILD_ID=rolling\n",
	"alpine":     "NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME=\"Alpine Linux v3.20\"\n",
}

type majmin struct{ sd, nvme, dm, md, vd int }

// finalize assigns major:minor numbers and fills in sector sizes.
func finalize(s *simMachine) *simMachine {
	mm := &majmin{}
	for _, n := range s.all() {
		if n.LogSec == 0 {
			n.LogSec = 512
		}
		if n.PhySec == 0 {
			n.PhySec = n.LogSec
		}
		if n.MajMin != "" {
			continue
		}
		switch {
		case n.Type == "crypt" || n.Type == "lvm" || n.Type == "dm" || n.Type == "mpath":
			n.KName = fmt.Sprintf("dm-%d", mm.dm)
			n.MajMin = fmt.Sprintf("253:%d", mm.dm)
			mm.dm++
		case strings.HasPrefix(n.Type, "raid"):
			n.MajMin = fmt.Sprintf("9:%s", strings.TrimPrefix(n.KName, "md"))
		case strings.HasPrefix(n.KName, "nvme"):
			n.MajMin = fmt.Sprintf("259:%d", mm.nvme)
			mm.nvme++
		case strings.HasPrefix(n.KName, "vd"):
			n.MajMin = fmt.Sprintf("252:%d", mm.vd)
			mm.vd++
		default:
			n.MajMin = fmt.Sprintf("8:%d", mm.sd)
			mm.sd++
		}
	}
	return s
}

func newDisk(kname string, size int64, pttype, ptuuid string) *simNode {
	d := &simNode{KName: kname, Type: "disk", Size: size, PTType: pttype, PTUUID: ptuuid, BootCode: "none"}
	switch {
	case strings.HasPrefix(kname, "nvme"):
		d.Tran, d.Model, d.Serial = "nvme", "Samsung SSD 980 PRO 1TB", "S5GXNX0T"+strings.ToUpper(kname[4:])
		ctrl := "nvme" + strings.Split(kname[4:], "n")[0]
		pci := "0000:3d:00.0"
		d.DevPath = "/sys/devices/pci0000:00/0000:00:1d.0/" + pci + "/nvme/" + ctrl + "/" + kname
		d.Drivers = []simDriver{{Dir: "/sys/devices/pci0000:00/0000:00:1d.0/" + pci, Driver: "nvme", Modalias: "pci:v0000144Dd0000A80Asv0000144Dsd0000A801bc01sc08i02"},
			{Dir: "/sys/devices/pci0000:00/0000:00:1d.0", Driver: "pcieport", Modalias: "pci:v00008086d0000A33Csv00008086sd00007270bc06sc04i00"}}
		d.EUI, d.NSID = "00 25 38 b1 11 b2 c3 d4", "1"
	case strings.HasPrefix(kname, "vd"):
		d.Tran = ""
		d.DevPath = "/sys/devices/pci0000:00/0000:00:05.0/virtio2/block/" + kname
		d.Drivers = []simDriver{{Dir: "/sys/devices/pci0000:00/0000:00:05.0/virtio2", Driver: "virtio_blk", Modalias: "virtio:d00000002v00001AF4"},
			{Dir: "/sys/devices/pci0000:00/0000:00:05.0", Driver: "virtio-pci", Modalias: "pci:v00001AF4d00001001sv00001AF4sd00000002bc01sc00i00"}}
	default:
		d.Tran, d.Model, d.Serial, d.WWN = "sata", "WDC WD20EFRX-68E", "WD-WCC4E"+strings.ToUpper(kname), "0x50014ee2b5c6d7e"+kname[len(kname)-1:]
		d.Rota = true
		d.DevPath = "/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/" + kname
		d.Drivers = []simDriver{{Dir: "/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0", Driver: "sd"},
			{Dir: "/sys/devices/pci0000:00/0000:00:17.0", Driver: "ahci", Modalias: "pci:v00008086d0000A352sv00001028sd0000085Abc01sc06i01"}}
	}
	return d
}

// addPart adds partition n (start and size in MiB).
func addPart(d *simNode, n int, startMiB, sizeMiB int64, typ, uuid, label string) *simNode {
	kname := fmt.Sprintf("%s%d", d.KName, n)
	if strings.HasPrefix(d.KName, "nvme") || strings.HasPrefix(d.KName, "mmcblk") {
		kname = fmt.Sprintf("%sp%d", d.KName, n)
	}
	sec := d.LogSec
	if sec == 0 {
		sec = 512
	}
	p := &simNode{KName: kname, Type: "part", Size: sizeMiB * MiB, PartStart: startMiB * MiB / sec, PartType: typ, PartUUID: uuid, PartLabel: label}
	d.Children = append(d.Children, p)
	return p
}

const (
	tESP      = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
	tLinux    = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"
	tLVM      = "E6D6D379-F507-44C2-A23C-238F2A3DF928"
	tRAID     = "A19D880F-05FC-4D3B-A006-743F0F84911E"
	tSwap     = "0657FD6D-A4AB-43C4-84E5-0933C84B4F4F"
	tBIOSBoot = "21686148-6449-6E6F-744E-656564454649"
	tXBOOT    = "BC13C2FF-59E6-4262-A352-B275FD6F7172"
	tMSR      = "E3C9E316-0B5C-4DB8-817D-F92DF00215AE"
	tMSData   = "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7"
)

func ext4(n *simNode, uuid string, mounts ...string) *simNode {
	n.FSType, n.FSVer, n.UUID = "ext4", "1.0", uuid
	blocks := n.Size / 4096
	n.Ext = &simExt{BlockSize: 4096, InodeSize: 256, InodeCount: blocks / 4, FreeInodes: blocks/4 - 30000, BlockCount: blocks, Reserved: blocks / 20, Flex: 16,
		Features: "has_journal ext_attr resize_inode dir_index filetype needs_recovery extent 64bit flex_bg sparse_super large_file huge_file dir_nlink extra_isize metadata_csum", Journal: "128M"}
	n.Blkid = map[string]string{"BLOCK_SIZE": "4096"}
	for _, m := range mounts {
		n.Mounts = append(n.Mounts, simMount{Target: m})
	}
	if len(mounts) > 0 {
		n.FSSize, n.FSUsed = n.Size-n.Size/20, n.Size/5
	}
	return n
}

func xfs(n *simNode, uuid string, mounts ...string) *simNode {
	n.FSType, n.UUID = "xfs", uuid
	n.XFS = &simXFS{ISize: 512, AGCount: 4, SectSz: 512, BSize: 4096, LogBlocks: 25600, CRC: 1, Finobt: 1, Sparse: 1, Reflink: 1, Bigtime: 1, Inobtcount: 1, Ftype: 1}
	n.Blkid = map[string]string{"BLOCK_SIZE": "512"}
	for _, m := range mounts {
		n.Mounts = append(n.Mounts, simMount{Target: m})
	}
	if len(mounts) > 0 {
		n.FSSize, n.FSUsed = n.Size, n.Size/4
	}
	return n
}

func vfat(n *simNode, uuid string, mounts ...string) *simNode {
	n.FSType, n.FSVer, n.UUID = "vfat", "FAT32", uuid
	n.Blkid = map[string]string{"SEC_TYPE": "msdos", "BLOCK_SIZE": "512"}
	for _, m := range mounts {
		n.Mounts = append(n.Mounts, simMount{Target: m})
	}
	if len(mounts) > 0 {
		n.FSSize, n.FSUsed = n.Size, 6*MiB
	}
	return n
}

func swapSig(n *simNode, uuid string) *simNode {
	n.FSType, n.FSVer, n.UUID = "swap", "1", uuid
	return n
}

func luks(n *simNode, uuid string, version int, mapped string) *simNode {
	n.FSType, n.UUID = "crypto_LUKS", uuid
	n.FSVer = fmt.Sprint(version)
	c := &simNode{KName: "dm-" + mapped, Name: mapped, Type: "crypt", Size: n.Size - 16*MiB}
	n.Children = append(n.Children, c)
	return c
}

func pv(n *simNode, uuid string) *simNode {
	n.FSType, n.FSVer, n.UUID = "LVM2_member", "LVM2 001", uuid
	return n
}

func lvNode(parent *simNode, vg, lv string, size int64) *simNode {
	esc := func(s string) string { return strings.ReplaceAll(s, "-", "--") }
	n := &simNode{KName: "dm-" + vg + "-" + lv, Name: esc(vg) + "-" + esc(lv), Type: "lvm", Size: size}
	parent.Children = append(parent.Children, n)
	return n
}

func luks2JSON(keySize int, tokens string, extraSlots string, integrity string) string {
	segIntegrity := ""
	if integrity != "" {
		segIntegrity = `,"integrity":{"type":"` + integrity + `","journal_encryption":"none","journal_integrity":"none"}`
	}
	return `{
  "keyslots":{
    "0":{"type":"luks2","key_size":` + fmt.Sprint(keySize) + `,"af":{"type":"luks1","stripes":4000,"hash":"sha256"},"area":{"type":"raw","offset":"32768","size":"258048","encryption":"aes-xts-plain64","key_size":64},"kdf":{"type":"argon2id","time":4,"memory":1048576,"cpus":4,"salt":"KDFSALT0SECRETdGhpcyBpcyBub3QgYSByZWFsIHNhbHQ="}}` + extraSlots + `
  },
  "tokens":{` + tokens + `},
  "segments":{"0":{"type":"crypt","offset":"16777216","size":"dynamic","iv_tweak":"0","encryption":"aes-xts-plain64","sector_size":512` + segIntegrity + `}},
  "digests":{"0":{"type":"pbkdf2","keyslots":["0"],"segments":["0"],"hash":"sha256","iterations":123456,"salt":"DIGESTSALT0SECRETc2FsdHNhbHQ=","digest":"DIGESTVALUE0SECRETZGlnZXN0"}},
  "config":{"json_size":"12288","keyslots_size":"16744448","flags":["allow-discards"],"requirements":{"mandatory":[]}}
}
`
}

const luks1Dump = `LUKS header information for /dev/sda2

Version:       	1
Cipher name:   	aes
Cipher mode:   	xts-plain64
Hash spec:     	sha256
Payload offset:	4096
MK bits:       	512
MK digest:     	SECRETMKDIGEST 0a 1b 2c 3d 4e 5f 60 71 82 93 a4 b5 c6 d7 e8 f9
MK salt:       	SECRETMKSALT 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff 00
MK iterations: 	123456
UUID:          	3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c

Key Slot 0: ENABLED
	Iterations:         	2000000
	Salt:               	SECRETSLOTSALT a1 b2 c3 d4 e5 f6 07 18 29 3a 4b 5c 6d 7e 8f 90
	Key material offset:	8
	AF stripes:            	4000
Key Slot 1: DISABLED
Key Slot 2: DISABLED
Key Slot 3: DISABLED
Key Slot 4: DISABLED
Key Slot 5: DISABLED
Key Slot 6: DISABLED
Key Slot 7: DISABLED
`

// distro sets os-release, kernel, init and the initramfs and boot files.
func distro(s *simMachine, name, kernel string) {
	s.OSRelease = osReleases[name]
	s.Kernel = kernel
	if s.Files == nil {
		s.Files = map[string]string{}
	}
	if s.Bin == nil {
		s.Bin = map[string][]byte{}
	}
	f := s.Files
	f["/lib/modules/"+kernel+"/modules.dep"] = ""
	switch {
	case strings.HasPrefix(name, "debian") || strings.HasPrefix(name, "ubuntu"):
		f["/etc/initramfs-tools/initramfs.conf"] = "MODULES=most\nBUSYBOX=auto\nKEYMAP=n\nCOMPRESS=zstd\n"
		f["/etc/default/keyboard"] = "XKBMODEL=\"pc105\"\nXKBLAYOUT=\"de\"\nXKBVARIANT=\"nodeadkeys\"\nXKBOPTIONS=\"\"\n"
		f["/etc/default/grub"] = "GRUB_DEFAULT=0\nGRUB_TIMEOUT=5\nGRUB_CMDLINE_LINUX_DEFAULT=\"quiet\"\n"
		f["/boot/grub/grub.cfg"] = "# generated by grub-mkconfig\nmenuentry 'Linux' {\n}\n"
		s.Bin["/boot/vmlinuz-"+kernel] = signedKernel()
		f["/boot/initrd.img-"+kernel] = strings.Repeat("initrd", 64)
	case name == "alma9" || name == "fedora":
		f["/etc/dracut.conf"] = "# dracut\n"
		f["/etc/dracut.conf.d/90-restow-test.conf"] = "hostonly=\"yes\"\nadd_drivers+=\" nvme \"\n"
		f["/etc/vconsole.conf"] = "KEYMAP=de-nodeadkeys\nFONT=eurlatgr\n"
		f["/etc/default/grub"] = "GRUB_TIMEOUT=5\nGRUB_ENABLE_BLSCFG=true\n"
		f["/boot/grub2/grub.cfg"] = "# generated\nblscfg\n"
		f["/boot/loader/entries/0123456789abcdef-"+kernel+".conf"] = "title Linux\nversion " + kernel + "\nlinux /vmlinuz-" + kernel + "\n"
		f["/boot/vmlinuz-"+kernel] = strings.Repeat("kernel", 128)
		f["/boot/initramfs-"+kernel+".img"] = strings.Repeat("initrd", 64)
		f["/etc/selinux/config"] = "SELINUX=enforcing\nSELINUXTYPE=targeted\n"
	case name == "opensuse":
		f["/etc/dracut.conf"] = "# dracut\n"
		f["/etc/vconsole.conf"] = "KEYMAP=de-latin1-nodeadkeys\n"
		f["/etc/default/grub"] = "GRUB_DEFAULT=saved\nSUSE_BTRFS_SNAPSHOT_BOOTING=\"true\"\n"
		f["/boot/grub2/grub.cfg"] = "# generated\n"
		f["/boot/vmlinuz-"+kernel] = strings.Repeat("kernel", 128)
		f["/boot/initrd-"+kernel] = strings.Repeat("initrd", 64)
	case name == "arch":
		f["/etc/mkinitcpio.conf"] = "MODULES=()\nHOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole block sd-encrypt filesystems fsck)\n"
		f["/etc/mkinitcpio.d/linux.preset"] = "ALL_kver=\"/boot/vmlinuz-linux\"\nPRESETS=('default')\ndefault_uki=\"/efi/EFI/Linux/arch-linux.efi\"\n"
		f["/etc/vconsole.conf"] = "KEYMAP=de-latin1\n"
		f["/lib/modules/"+kernel+"/vmlinuz"] = strings.Repeat("kernel", 128)
	}
}

func signedKernel() []byte {
	return buildPE([]peSection{{".text", bytes.Repeat([]byte{0xcc}, 4096)}}, &distroSigner)
}

// uefiBoot puts shim, GRUB and the fallback on the ESP mounted at mnt.
func uefiBoot(s *simMachine, mnt, vendor, espUUID string, secureBoot bool) {
	s.UEFI = true
	sb := secureBoot
	s.SecureBoot, s.SetupMode = &sb, boolPtr(false)
	shim := buildPE([]peSection{{".text", bytes.Repeat([]byte{0x90}, 2048)},
		{".sbat", []byte("sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md\nshim,4,UEFI shim,shim,1,https://github.com/rhboot/shim\nshim." + vendor + ",1," + vendor + ",shim,15.8,https://example.org\n")}}, &msThirdParty)
	grub := buildPE([]peSection{{".text", bytes.Repeat([]byte{0x91}, 2048)},
		{".sbat", []byte("sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md\ngrub,4,Free Software Foundation,grub,2.12,https://www.gnu.org/software/grub/\n")}}, &distroSigner)
	fb := buildPE([]peSection{{".text", bytes.Repeat([]byte{0x92}, 1024)}}, &msThirdParty)
	s.Bin[mnt+"/EFI/"+vendor+"/shimx64.efi"] = shim
	s.Bin[mnt+"/EFI/"+vendor+"/grubx64.efi"] = grub
	s.Bin[mnt+"/EFI/BOOT/BOOTX64.EFI"] = shim
	s.Bin[mnt+"/EFI/BOOT/fbx64.efi"] = fb
	s.Files[mnt+"/EFI/"+vendor+"/BOOTX64.CSV"] = "shimx64.efi," + vendor + ",,This is the boot entry for " + vendor + "\n"
	s.Files["/boot/grub/x86_64-efi/normal.mod"] = "mod"
	s.BootEntries = []simBootEntry{{Num: 1, Label: vendor, PartUUID: espUUID, PartNum: 1, Path: `\EFI\` + vendor + `\shimx64.efi`, Active: true},
		{Num: 0, Label: "UEFI: PXE IPv4 Intel(R) Ethernet", Active: true}}
	s.BootOrder = []uint16{1, 0}
	cur := uint16(1)
	s.BootCurrent = &cur
	s.Sbat = "sbat,1,2024010900\nshim,4\ngrub,3\ngrub.debian,4\n"
	s.DB = []testSigner{newTestSigner("Microsoft Corporation UEFI CA 2011", "Microsoft Corporation Third Party Marketplace Root", 0x6108, 5),
		newTestSigner("Microsoft Windows Production PCA 2011", "Microsoft Root Certificate Authority 2010", 0x61077, 6)}
	s.DBX = [][]byte{bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32)}
}

func biosGrub(s *simMachine, disks ...*simNode) {
	s.Files["/boot/grub/i386-pc/normal.mod"] = "mod"
	for _, d := range disks {
		d.BootCode = "grub"
	}
}

func nic(s *simMachine, name, mac, pci, driver string) {
	s.Interfaces = append(s.Interfaces, simNet{Name: name, MAC: mac, DevDir: "/sys/devices/pci0000:00/0000:00:1c.0/" + pci, Driver: driver,
		Modalias: "pci:v00008086d00001533sv000015D9sd00001533bc02sc00i00"})
}

func newSim(name, source, host string) *simMachine {
	return &simMachine{Name: name, Source: source, Hostname: host, Files: map[string]string{}, Bin: map[string][]byte{}, Links: map[string]string{},
		LUKS: map[string]string{}, Btrfs: map[string]*simBtrfs{}, Extra: map[string]simAnswer{}}
}

// debianLVMLuks is Debian 12 UEFI with LUKS2 and LVM (the guided
// encrypted installation).
func sysDebian12() *simMachine {
	s := newSim("debian12-uefi-luks-lvm", "Debian 12 guided installation with encrypted LVM, UEFI with Secure Boot", "srv01")
	distro(s, "debian12", "6.1.0-27-amd64")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-6.1.0-27-amd64 root=/dev/mapper/srv01--vg-root ro quiet"
	d := newDisk("nvme0n1", 512110190592, "gpt", "0F6C5E2A-1B3D-4C5E-9F70-8192A3B4C5D6")
	vfat(addPart(d, 1, 1, 512, tESP, "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", "EFI System Partition"), "1A2B-3C4D", "/boot/efi")
	ext4(addPart(d, 2, 513, 976, tLinux, "6f2d5e1b-2c3d-4e4f-9a01-b2c3d4e5f607", ""), "8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e", "/boot")
	p3 := addPart(d, 3, 1489, 486896, tLinux, "7a3e6f2c-3d4e-4f50-8b12-c3d4e5f60718", "")
	c := luks(p3, "2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d", 2, "nvme0n1p3_crypt")
	pv(c, "Ab12Cd-34Ef-56Gh-78Ij-90Kl-12Mn-34OpQr")
	ext4(lvNode(c, "srv01-vg", "root", 50*GiB), "9c0d1e2f-3a4b-5c6d-7e8f-9a0b1c2d3e4f", "/")
	swapSig(lvNode(c, "srv01-vg", "swap_1", 8*GiB), "1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5061")
	ext4(lvNode(c, "srv01-vg", "home", 400*GiB), "0d1e2f3a-4b5c-6d7e-8f9a-0b1c2d3e4f50", "/home")
	s.Disks = []*simNode{d}
	s.LUKS["/dev/nvme0n1p3"] = luks2JSON(64, "", "", "")
	s.LVM = &simLVM{VGs: []simVG{{Name: "srv01-vg", UUID: "Zy98Xw-76Vu-54Ts-32Rq-10Po-98Nm-76LkJi", Size: 510526783488, Free: 4 * MiB, Extent: 4 * MiB,
		PVs: []simPV{{Name: "/dev/mapper/nvme0n1p3_crypt", UUID: "Ab12Cd-34Ef-56Gh-78Ij-90Kl-12Mn-34OpQr", Size: 510526783488}},
		LVs: []simLV{{Name: "root", UUID: "lvroot-0001", Size: 50 * GiB, Layout: "linear", Major: 253, Minor: 1},
			{Name: "swap_1", UUID: "lvswap-0002", Size: 8 * GiB, Layout: "linear", Major: 253, Minor: 2},
			{Name: "home", UUID: "lvhome-0003", Size: 400 * GiB, Layout: "linear", Major: 253, Minor: 3}}}}}
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/dm-2                               partition\t8388604\t\t0\t\t-2\n"
	s.Files["/etc/fstab"] = "# /etc/fstab\n/dev/mapper/srv01--vg-root /               ext4    errors=remount-ro 0       1\nUUID=8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e /boot           ext4    defaults        0       2\nUUID=1A2B-3C4D  /boot/efi       vfat    umask=0077      0       1\n/dev/mapper/srv01--vg-home /home           ext4    defaults        0       2\n/dev/mapper/srv01--vg-swap_1 none            swap    sw              0       0\n"
	s.Files["/etc/crypttab"] = "nvme0n1p3_crypt UUID=2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d none luks,discard\n"
	uefiBoot(s, "/boot/efi", "debian", "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", true)
	nic(s, "enp3s0", "3c:ec:ef:12:34:56", "0000:03:00.0", "igb")
	s.Files["/etc/udev/rules.d/70-persistent-net.rules"] = "SUBSYSTEM==\"net\", ATTR{address}==\"3c:ec:ef:12:34:56\", NAME=\"enp3s0\"\n"
	return finalize(s)
}

func sysUbuntu2204BIOSMdadm() *simMachine {
	s := newSim("ubuntu2204-bios-mdadm", "Ubuntu 22.04 server installer, BIOS, GPT with BIOS boot partitions, mdadm RAID1", "srv02")
	distro(s, "ubuntu2204", "5.15.0-125-generic")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-5.15.0-125-generic root=UUID=4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d ro"
	var disks []*simNode
	md := &simNode{KName: "md0", Type: "raid1", Size: 1997864984576}
	ext4(md, "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d", "/")
	for i, k := range []string{"sda", "sdb"} {
		d := newDisk(k, 2000398934016, "gpt", fmt.Sprintf("1111111%d-2222-3333-4444-555555555555", i))
		addPart(d, 1, 1, 1, tBIOSBoot, fmt.Sprintf("aaaaaaa%d-0000-0000-0000-000000000001", i), "")
		p2 := addPart(d, 2, 2, 1905000, tRAID, fmt.Sprintf("aaaaaaa%d-0000-0000-0000-000000000002", i), "")
		p2.FSType, p2.UUID, p2.FSVer = "linux_raid_member", "a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90", "1.2"
		p2.Children = []*simNode{md}
		disks = append(disks, d)
	}
	biosGrub(s, disks...)
	s.Disks = disks
	s.MD = []simMD{{KName: "md0", UUID: "a1b2c3d4:e5f60718:293a4b5c:6d7e8f90", Level: "raid1", Metadata: "1.2", Name: "srv02:0", Devices: 2,
		Members: []simMDMember{{Dev: "/dev/sda2", Role: "0", State: "in_sync"}, {Dev: "/dev/sdb2", Role: "1", State: "in_sync"}}}}
	s.Files["/etc/fstab"] = "UUID=4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d / ext4 defaults 0 1\n/swap.img none swap sw 0 0\n"
	s.Files["/etc/mdadm/mdadm.conf"] = "ARRAY /dev/md0 metadata=1.2 UUID=a1b2c3d4:e5f60718:293a4b5c:6d7e8f90\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swap.img                               file\t\t4194300\t\t0\t\t-2\n"
	s.Extra["filefrag -v /swap.img"] = simAnswer{Out: "Filesystem type is: ef53\nFile size of /swap.img is 4294967296 (1048576 blocks of 4096 bytes)\n ext:     logical_offset:        physical_offset: length:   expected: flags:\n   0:        0..   32767:      34816..     67583:  32768:            \n/swap.img: 1 extent found\n"}
	nic(s, "eno1", "00:25:90:ab:cd:ef", "0000:00:19.0", "e1000e")
	s.Files["/etc/netplan/00-installer-config.yaml"] = "network:\n  ethernets:\n    eno1:\n      match:\n        macaddress: 00:25:90:ab:cd:ef\n      dhcp4: true\n  version: 2\n"
	return finalize(s)
}

func sysUbuntu2404() *simMachine {
	s := newSim("ubuntu2404-default", "Ubuntu 24.04 desktop default installation (ext4, UEFI)", "desk01")
	distro(s, "ubuntu2404", "6.8.0-48-generic")
	s.Cmdline = "BOOT_IMAGE=/boot/vmlinuz-6.8.0-48-generic root=UUID=5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e ro quiet splash"
	d := newDisk("nvme0n1", 1000204886016, "gpt", "2D3E4F50-6172-4384-95A6-B7C8D9EAFB0C")
	vfat(addPart(d, 1, 1, 1024, tESP, "a1000000-0000-4000-8000-000000000001", "EFI System Partition"), "B2C3-D4E5", "/boot/efi")
	ext4(addPart(d, 2, 1025, 952838, tLinux, "a1000000-0000-4000-8000-000000000002", ""), "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", "/")
	s.Disks = []*simNode{d}
	s.Files["/etc/fstab"] = "UUID=5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e / ext4 defaults 0 1\nUUID=B2C3-D4E5 /boot/efi vfat defaults 0 1\n/swap.img none swap sw 0 0\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swap.img                               file\t\t4194300\t\t0\t\t-2\n"
	s.Extra["filefrag -v /swap.img"] = simAnswer{Out: " ext:     logical_offset:        physical_offset: length:   expected: flags:\n   0:        0..   32767:     229376..    262143:  32768:            \n"}
	uefiBoot(s, "/boot/efi", "ubuntu", "a1000000-0000-4000-8000-000000000001", true)
	nic(s, "wlp2s0", "a4:c3:f0:11:22:33", "0000:02:00.0", "iwlwifi")
	return finalize(s)
}

func sysUbuntuZFS() *simMachine {
	s := newSim("ubuntu-zfs", "Ubuntu 22.04 with root on ZFS (must be unsupported)", "zfs01")
	distro(s, "ubuntu2204", "5.15.0-125-generic")
	s.Cmdline = "BOOT_IMAGE=/BOOT/ubuntu_x1y2z3@/vmlinuz-5.15.0-125-generic root=ZFS=rpool/ROOT/ubuntu_x1y2z3 ro"
	d := newDisk("sda", 500107862016, "gpt", "3E4F5061-7283-4495-A6B7-C8D9EAFB0C1D")
	vfat(addPart(d, 1, 1, 512, tESP, "b1000000-0000-4000-8000-000000000001", "EFI System Partition"), "C3D4-E5F6", "/boot/efi")
	p2 := addPart(d, 2, 513, 2048, "6A82CB45-1DD2-11B2-99A6-080020736631", "b1000000-0000-4000-8000-000000000002", "")
	p2.FSType, p2.UUID, p2.Label, p2.FSVer = "zfs_member", "1234567890123456789", "bpool", "5000"
	p3 := addPart(d, 3, 2561, 474000, "6A898CC3-1DD2-11B2-99A6-080020736631", "b1000000-0000-4000-8000-000000000003", "")
	p3.FSType, p3.UUID, p3.Label, p3.FSVer = "zfs_member", "9876543210987654321", "rpool", "5000"
	s.Disks = []*simNode{d}
	s.Files["/proc/self/mountinfo.extra"] = "60 1 0:50 / / rw,relatime shared:1 - zfs rpool/ROOT/ubuntu_x1y2z3 rw,xattr,posixacl\n61 60 0:51 / /boot rw,relatime shared:2 - zfs bpool/BOOT/ubuntu_x1y2z3 rw,xattr,posixacl\n"
	s.Files["/etc/fstab"] = "UUID=C3D4-E5F6 /boot/efi vfat umask=0022,fmask=0022,dmask=0022 0 1\n"
	uefiBoot(s, "/boot/efi", "ubuntu", "b1000000-0000-4000-8000-000000000001", false)
	return finalize(s)
}

func sysAlma9() *simMachine {
	s := newSim("alma9-xfs-lvm-devices", "AlmaLinux 9 default installation: XFS on LVM with system.devices, BLS, SELinux", "alma01")
	distro(s, "alma9", "5.14.0-503.11.1.el9_5.x86_64")
	s.Cmdline = "BOOT_IMAGE=(hd0,gpt2)/vmlinuz-5.14.0-503.11.1.el9_5.x86_64 root=/dev/mapper/almalinux-root ro crashkernel=1G-4G:192M resume=/dev/mapper/almalinux-swap rd.lvm.lv=almalinux/root rd.lvm.lv=almalinux/swap"
	d := newDisk("sda", 256060514304, "gpt", "4F506172-8394-45A6-B7C8-D9EAFB0C1D2E")
	vfat(addPart(d, 1, 1, 600, tESP, "c1000000-0000-4000-8000-000000000001", "EFI System Partition"), "D4E5-F607", "/boot/efi")
	xfs(addPart(d, 2, 601, 1024, tLinux, "c1000000-0000-4000-8000-000000000002", ""), "e1000000-0000-4000-8000-0000000000b0", "/boot")
	p3 := pv(addPart(d, 3, 1625, 242500, tLVM, "c1000000-0000-4000-8000-000000000003", ""), "pvalma-0000-0000-0000-0000-0000-000001")
	xfs(lvNode(p3, "almalinux", "root", 70*GiB), "e1000000-0000-4000-8000-0000000000a0", "/")
	swapSig(lvNode(p3, "almalinux", "swap", 8*GiB), "e1000000-0000-4000-8000-0000000000c0")
	xfs(lvNode(p3, "almalinux", "home", 158*GiB), "e1000000-0000-4000-8000-0000000000d0", "/home")
	s.Disks = []*simNode{d}
	s.LVM = &simLVM{UseDevicesFile: true, VGs: []simVG{{Name: "almalinux", UUID: "vgalma-0000-0000-0000-0000-0000-000001", Size: 254276829184, Free: 20 * GiB, Extent: 4 * MiB,
		PVs: []simPV{{Name: "/dev/sda3", UUID: "pvalma-0000-0000-0000-0000-0000-000001", Size: 254276829184}},
		LVs: []simLV{{Name: "root", UUID: "lvar-1", Size: 70 * GiB, Layout: "linear", Major: 253, Minor: 0},
			{Name: "swap", UUID: "lvas-2", Size: 8 * GiB, Layout: "linear", Major: 253, Minor: 1},
			{Name: "home", UUID: "lvah-3", Size: 158 * GiB, Layout: "linear", Major: 253, Minor: 2}}}}}
	s.Files["/etc/lvm/devices/system.devices"] = "# LVM uses devices listed in this file.\nVERSION=1.1.3\nIDTYPE=sys_wwid IDNAME=t10.ATA_____WDC_WD2500 DEVNAME=/dev/sda3 PVID=pvalma0000 PART=3\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/dm-1                               partition\t8388604\t\t0\t\t-2\n"
	s.Files["/etc/fstab"] = "/dev/mapper/almalinux-root /                       xfs     defaults        0 0\nUUID=e1000000-0000-4000-8000-0000000000b0 /boot xfs defaults 0 0\nUUID=D4E5-F607 /boot/efi vfat umask=0077,shortname=winnt 0 2\n/dev/mapper/almalinux-home /home xfs defaults 0 0\n/dev/mapper/almalinux-swap none swap defaults 0 0\n"
	uefiBoot(s, "/boot/efi", "almalinux", "c1000000-0000-4000-8000-000000000001", true)
	s.Files["/boot/grub/x86_64-efi/normal.mod"] = ""
	delete(s.Files, "/boot/grub/x86_64-efi/normal.mod")
	s.Files["/boot/efi/EFI/almalinux/grub.cfg"] = "search --no-floppy --fs-uuid --set=dev e1000000-0000-4000-8000-0000000000b0\nset prefix=($dev)/grub2\nconfigfile $prefix/grub.cfg\n"
	s.Files["/etc/sysconfig/network-scripts/ifcfg-ens192"] = "TYPE=Ethernet\nNAME=ens192\nHWADDR=00:50:56:aa:bb:cc\nONBOOT=yes\n"
	nic(s, "ens192", "00:50:56:aa:bb:cc", "0000:0b:00.0", "vmxnet3")
	return finalize(s)
}

func btrfsFS(n *simNode, uuid string, b *simBtrfs, s *simMachine, mounts ...simMount) {
	n.FSType, n.UUID = "btrfs", uuid
	n.Blkid = map[string]string{"UUID_SUB": "77777777-0000-4000-8000-" + uuid[len(uuid)-12:], "BLOCK_SIZE": "4096"}
	n.Mounts = append(n.Mounts, mounts...)
	if b.NodeSize == 0 {
		b.NodeSize = 16384
	}
	if b.Features == nil {
		b.Features = []string{"mixed_backref", "default_subvol", "big_metadata", "extended_iref", "skinny_metadata", "no_holes", "free_space_tree", "free_space_tree_valid"}
	}
	if b.Data == "" {
		b.Data, b.Meta, b.System = "single", "dup", "dup"
	}
	if b.Size == 0 {
		b.Size, b.Used = n.Size, n.Size/4
	}
	n.FSSize, n.FSUsed = b.Size, b.Used
	s.Btrfs[uuid] = b
}

func sysFedoraBtrfs() *simMachine {
	s := newSim("fedora-btrfs-nested-zstd", "Fedora 41 Workstation: btrfs root and home, nested /var/lib/machines, compress=zstd:1", "fed01")
	distro(s, "fedora", "6.11.5-300.fc41.x86_64")
	s.Cmdline = "BOOT_IMAGE=(hd0,gpt2)/vmlinuz-6.11.5-300.fc41.x86_64 root=UUID=f1000000-0000-4000-8000-000000000001 ro rootflags=subvol=root rhgb quiet"
	d := newDisk("nvme0n1", 1000204886016, "gpt", "506172F8-94A5-46B7-C8D9-EAFB0C1D2E3F")
	vfat(addPart(d, 1, 1, 600, tESP, "d1000000-0000-4000-8000-000000000001", "EFI System Partition"), "E5F6-0718", "/boot/efi")
	ext4(addPart(d, 2, 601, 1024, tLinux, "d1000000-0000-4000-8000-000000000002", ""), "f1000000-0000-4000-8000-0000000000b1", "/boot")
	p3 := addPart(d, 3, 1625, 952000, tLinux, "d1000000-0000-4000-8000-000000000003", "")
	btrfsFS(p3, "f1000000-0000-4000-8000-000000000001", &simBtrfs{Subvols: []simSubvol{
		{ID: 256, Parent: 5, TopLevel: 5, Path: "home", UUID: "a5000000-0000-4000-8000-000000000256"},
		{ID: 257, Parent: 5, TopLevel: 5, Path: "root", UUID: "a5000000-0000-4000-8000-000000000257"},
		{ID: 258, Parent: 257, TopLevel: 257, Path: "root/var/lib/machines", UUID: "a5000000-0000-4000-8000-000000000258"},
		{ID: 259, Parent: 257, TopLevel: 257, Path: "root/var/lib/portables", UUID: "a5000000-0000-4000-8000-000000000259"},
		{ID: 260, Parent: 256, TopLevel: 256, Path: "home/anna/vm-images", UUID: "a5000000-0000-4000-8000-000000000260"},
	}, NoCow: []string{"/var/lib/libvirt"}}, s,
		simMount{Target: "/", Root: "/root", SubvolID: 257, Opts: "rw,relatime"}, simMount{Target: "/home", Root: "/home", SubvolID: 256, Opts: "rw,relatime"})
	s.Files["/var/lib/libvirt/images/"] = ""
	s.Files["/var/lib/machines/"] = ""
	s.Disks = []*simNode{d}
	s.Files["/etc/fstab"] = "UUID=f1000000-0000-4000-8000-000000000001 / btrfs subvol=root,compress=zstd:1 0 0\nUUID=f1000000-0000-4000-8000-0000000000b1 /boot ext4 defaults 1 2\nUUID=E5F6-0718 /boot/efi vfat umask=0077,shortname=winnt 0 2\nUUID=f1000000-0000-4000-8000-000000000001 /home btrfs subvol=home,compress=zstd:1 0 0\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/zram0                              partition\t8388604\t\t0\t\t100\n"
	uefiBoot(s, "/boot/efi", "fedora", "d1000000-0000-4000-8000-000000000001", true)
	delete(s.Files, "/boot/grub/x86_64-efi/normal.mod")
	s.Files["/boot/grub2/x86_64-efi/normal.mod"] = "mod"
	nic(s, "enp0s31f6", "54:e1:ad:01:02:03", "0000:00:1f.6", "e1000e")
	return finalize(s)
}

func sysOpenSUSE() *simMachine {
	s := newSim("opensuse-snapper-root-quota", "openSUSE Leap 15.6 after snapper rollback: root is @/.snapshots/2/snapshot, quota on", "suse01")
	distro(s, "opensuse", "6.4.0-150600.23.25-default")
	s.Cmdline = "BOOT_IMAGE=/boot/vmlinuz-6.4.0-150600.23.25-default root=UUID=f2000000-0000-4000-8000-000000000001 splash=silent mitigations=auto quiet"
	d := newDisk("vda", 64424509440, "gpt", "61728394-A5B6-47C8-D9EA-FB0C1D2E3F40")
	addPart(d, 1, 1, 8, tBIOSBoot, "e1000000-0000-4000-8000-000000000001", "")
	p2 := addPart(d, 2, 9, 59000, tLinux, "e1000000-0000-4000-8000-000000000002", "")
	swapSig(addPart(d, 3, 59009, 2048, tSwap, "e1000000-0000-4000-8000-000000000003", ""), "f2000000-0000-4000-8000-0000000000c3")
	btrfsFS(p2, "f2000000-0000-4000-8000-000000000001", &simBtrfs{Default: 268, Quota: true, Subvols: []simSubvol{
		{ID: 256, Parent: 5, TopLevel: 5, Path: "@", UUID: "b6000000-0000-4000-8000-000000000256"},
		{ID: 257, Parent: 256, TopLevel: 256, Path: "@/.snapshots", UUID: "b6000000-0000-4000-8000-000000000257"},
		{ID: 258, Parent: 257, TopLevel: 257, Path: "@/.snapshots/1/snapshot", UUID: "b6000000-0000-4000-8000-000000000258", RO: true},
		{ID: 259, Parent: 256, TopLevel: 256, Path: "@/home", UUID: "b6000000-0000-4000-8000-000000000259"},
		{ID: 260, Parent: 256, TopLevel: 256, Path: "@/opt", UUID: "b6000000-0000-4000-8000-000000000260"},
		{ID: 261, Parent: 256, TopLevel: 256, Path: "@/var", UUID: "b6000000-0000-4000-8000-000000000261"},
		{ID: 262, Parent: 256, TopLevel: 256, Path: "@/root", UUID: "b6000000-0000-4000-8000-000000000262"},
		{ID: 268, Parent: 257, TopLevel: 257, Path: "@/.snapshots/2/snapshot", UUID: "b6000000-0000-4000-8000-000000000268", PUUID: "b6000000-0000-4000-8000-000000000258"},
	}}, s,
		simMount{Target: "/", Root: "/@/.snapshots/2/snapshot", SubvolID: 268},
		simMount{Target: "/.snapshots", Root: "/@/.snapshots", SubvolID: 257},
		simMount{Target: "/home", Root: "/@/home", SubvolID: 259},
		simMount{Target: "/opt", Root: "/@/opt", SubvolID: 260},
		simMount{Target: "/var", Root: "/@/var", SubvolID: 261},
		simMount{Target: "/root", Root: "/@/root", SubvolID: 262})
	s.Disks = []*simNode{d}
	biosGrub(s, d)
	s.Files["/boot/grub2/i386-pc/normal.mod"] = "mod"
	delete(s.Files, "/boot/grub/i386-pc/normal.mod")
	s.Files["/.snapshots/2/info.xml"] = "<?xml version=\"1.0\"?>\n<snapshot><type>single</type><num>2</num></snapshot>\n"
	s.Files["/etc/default/grub_installdevice"] = "/dev/disk/by-id/virtio-0001\nactivate\n"
	s.Files["/etc/fstab"] = "UUID=f2000000-0000-4000-8000-000000000001 / btrfs defaults 0 0\nUUID=f2000000-0000-4000-8000-000000000001 /.snapshots btrfs subvol=/@/.snapshots 0 0\nUUID=f2000000-0000-4000-8000-000000000001 /home btrfs subvol=/@/home 0 0\nUUID=f2000000-0000-4000-8000-000000000001 /opt btrfs subvol=/@/opt 0 0\nUUID=f2000000-0000-4000-8000-000000000001 /var btrfs subvol=/@/var 0 0\nUUID=f2000000-0000-4000-8000-000000000001 /root btrfs subvol=/@/root 0 0\nUUID=f2000000-0000-4000-8000-0000000000c3 swap swap defaults 0 0\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/vda3                               partition\t2097148\t\t0\t\t-2\n"
	return finalize(s)
}

func sysArchUKI() *simMachine {
	s := newSim("arch-sdboot-uki", "Arch Linux with systemd-boot and a UKI built by mkinitcpio (default_uki), ESP at /efi", "arch01")
	distro(s, "arch", "6.11.6-arch1-1")
	s.Cmdline = "initrd=\\EFI\\Linux\\arch-linux.efi root=UUID=f3000000-0000-4000-8000-000000000001 rw quiet"
	d := newDisk("nvme0n1", 512110190592, "gpt", "72839405-B6C7-48D9-EAFB-0C1D2E3F4051")
	vfat(addPart(d, 1, 1, 1024, tESP, "f1000000-0000-4000-8000-000000000001", "EFI"), "F607-1829", "/efi")
	ext4(addPart(d, 2, 1025, 487000, tLinux, "f1000000-0000-4000-8000-000000000002", "root"), "f3000000-0000-4000-8000-000000000001", "/")
	s.Disks = []*simNode{d}
	s.UEFI = true
	s.SecureBoot, s.SetupMode = boolPtr(false), boolPtr(false)
	sdboot := buildPE([]peSection{{".text", bytes.Repeat([]byte{0x93}, 2048)}, {".sbat", []byte("sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md\nsystemd-boot,1,The systemd Developers,systemd,256,https://systemd.io/\n")}}, nil)
	uki := buildPE([]peSection{{".osrel", []byte(osReleases["arch"])}, {".cmdline", []byte("root=UUID=f3000000-0000-4000-8000-000000000001 rw quiet\x00")},
		{".linux", bytes.Repeat([]byte{0x4c}, 4096)}, {".initrd", bytes.Repeat([]byte{0x49}, 2048)}}, nil)
	s.Bin["/efi/EFI/systemd/systemd-bootx64.efi"] = sdboot
	s.Bin["/efi/EFI/BOOT/BOOTX64.EFI"] = sdboot
	s.Bin["/efi/EFI/Linux/arch-linux.efi"] = uki
	s.Files["/efi/loader/loader.conf"] = "timeout 3\neditor no\n"
	s.BootEntries = []simBootEntry{{Num: 0, Label: "Linux Boot Manager", PartUUID: "f1000000-0000-4000-8000-000000000001", PartNum: 1, Path: `\EFI\systemd\systemd-bootx64.efi`, Active: true}}
	s.BootOrder = []uint16{0}
	s.Files["/etc/fstab"] = "UUID=f3000000-0000-4000-8000-000000000001 / ext4 rw,relatime 0 1\nUUID=F607-1829 /efi vfat rw,relatime,fmask=0022,dmask=0022 0 2\n"
	s.Files["/etc/systemd/network/20-wired.network"] = "[Match]\nMACAddress=f0:2f:74:aa:bb:cc\n\n[Network]\nDHCP=yes\n"
	nic(s, "enp4s0", "f0:2f:74:aa:bb:cc", "0000:04:00.0", "r8169")
	return finalize(s)
}

func sysBIOSMBRRaid1() *simMachine {
	s := newSim("bios-mbr-mdadm-raid1", "Debian 12, BIOS, MBR, mdadm RAID1 over two disks for / and /boot, swap partitions", "srv03")
	distro(s, "debian12", "6.1.0-27-amd64")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-6.1.0-27-amd64 root=UUID=a7000000-0000-4000-8000-000000000001 ro quiet"
	md0 := ext4(&simNode{KName: "md0", Type: "raid1", Size: 1022 * MiB}, "a7000000-0000-4000-8000-0000000000b0", "/boot")
	md1 := ext4(&simNode{KName: "md1", Type: "raid1", Size: 900 * GiB}, "a7000000-0000-4000-8000-000000000001", "/")
	var disks []*simNode
	for i, k := range []string{"sda", "sdb"} {
		d := newDisk(k, 1000204886016, "dos", fmt.Sprintf("0x%08x", 0xa1b2c3d0+i))
		p1 := addPart(d, 1, 1, 1024, "fd", "", "")
		p1.Bootable = true
		p1.FSType, p1.UUID, p1.FSVer = "linux_raid_member", "b7000000-0000-4000-8000-000000000000", "1.2"
		p1.Children = []*simNode{md0}
		p2 := addPart(d, 2, 1025, 921600, "fd", "", "")
		p2.FSType, p2.UUID, p2.FSVer = "linux_raid_member", "b7000000-0000-4000-8000-000000000001", "1.2"
		p2.Children = []*simNode{md1}
		swapSig(addPart(d, 3, 922625, 8192, "82", "", ""), fmt.Sprintf("c7000000-0000-4000-8000-00000000000%d", i))
		disks = append(disks, d)
	}
	biosGrub(s, disks...)
	s.Disks = disks
	s.MD = []simMD{
		{KName: "md0", UUID: "b7000000:00004000:80000000:00000000", Level: "raid1", Metadata: "1.2", Name: "srv03:0", Devices: 2,
			Members: []simMDMember{{Dev: "/dev/sda1", Role: "0", State: "in_sync"}, {Dev: "/dev/sdb1", Role: "1", State: "in_sync"}}},
		{KName: "md1", UUID: "b7000000:00004000:80000000:00000001", Level: "raid1", Metadata: "1.2", Name: "srv03:1", Devices: 2,
			Members: []simMDMember{{Dev: "/dev/sda2", Role: "0", State: "in_sync"}, {Dev: "/dev/sdb2", Role: "1", State: "in_sync,write_mostly"}}},
	}
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/sda3                               partition\t8388604\t\t0\t\t-2\n/dev/sdb3                               partition\t8388604\t\t0\t\t-3\n"
	s.Files["/etc/fstab"] = "UUID=a7000000-0000-4000-8000-000000000001 / ext4 errors=remount-ro 0 1\nUUID=a7000000-0000-4000-8000-0000000000b0 /boot ext4 defaults 0 2\nUUID=c7000000-0000-4000-8000-000000000000 none swap sw 0 0\nUUID=c7000000-0000-4000-8000-000000000001 none swap sw 0 0\n/srv/data /var/www/data none bind 0 0\n"
	// A bind mount of a folder of the root file system: no second mount of
	// /dev/md1 in the plan (Mount.Root).
	s.Files["/proc/self/mountinfo.extra"] = "27 25 9:1 /srv/data /var/www/data rw,relatime - ext4 /dev/md1 rw\n"
	s.Files["/etc/mdadm/mdadm.conf"] = "ARRAY /dev/md/0 metadata=1.2 UUID=b7000000:00004000:80000000:00000000 name=srv03:0\nARRAY /dev/md/1 metadata=1.2 UUID=b7000000:00004000:80000000:00000001 name=srv03:1\n"
	s.Files["/etc/default/grub"] = "GRUB_DEFAULT=0\nGRUB_CMDLINE_LINUX=\"\"\n"
	s.Files["/etc/smartd.conf"] = "/dev/sda -a -o on -S on\n/dev/sdb -a -o on -S on\n"
	return finalize(s)
}

func sysRAID5Spare() *simMachine {
	s := newSim("raid5-spare", "Data RAID5 of three disks with a hot spare, LVM on top; system on an NVMe", "nas01")
	distro(s, "debian12", "6.1.0-27-amd64")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-6.1.0-27-amd64 root=UUID=a8000000-0000-4000-8000-000000000001 ro"
	sys := newDisk("nvme0n1", 256060514304, "gpt", "8394A5B6-C7D8-49EA-FB0C-1D2E3F405162")
	vfat(addPart(sys, 1, 1, 512, tESP, "a8100000-0000-4000-8000-000000000001", ""), "1829-3A4B", "/boot/efi")
	ext4(addPart(sys, 2, 513, 243000, tLinux, "a8100000-0000-4000-8000-000000000002", ""), "a8000000-0000-4000-8000-000000000001", "/")
	md := pv(&simNode{KName: "md127", Type: "raid5", Size: 8 * 1000 * GiB}, "pvraid-0000")
	xfs(lvNode(md, "data", "share", 6000*GiB), "a8000000-0000-4000-8000-0000000000d1", "/srv/share")
	disks := []*simNode{sys}
	for i, k := range []string{"sda", "sdb", "sdc", "sdd"} {
		d := newDisk(k, 4000787030016, "gpt", fmt.Sprintf("9394A5B6-C7D8-49EA-FB0C-1D2E3F40516%d", i))
		p := addPart(d, 1, 1, 3815000, tRAID, fmt.Sprintf("a8200000-0000-4000-8000-00000000000%d", i), "")
		p.FSType, p.UUID, p.FSVer = "linux_raid_member", "c8000000-0000-4000-8000-000000000127", "1.2"
		p.Children = []*simNode{md}
		disks = append(disks, d)
	}
	s.Disks = disks
	s.MD = []simMD{{KName: "md127", UUID: "c8000000:00004000:80000000:00000127", Level: "raid5", Metadata: "1.2", Name: "nas01:data", Devices: 3,
		Chunk: 524288, Layout: "2",
		Members: []simMDMember{{Dev: "/dev/sda1", Role: "0", State: "in_sync"}, {Dev: "/dev/sdb1", Role: "1", State: "in_sync"},
			{Dev: "/dev/sdc1", Role: "2", State: "in_sync"}, {Dev: "/dev/sdd1", Role: "spare", State: "spare"}}}}
	s.LVM = &simLVM{VGs: []simVG{{Name: "data", UUID: "vgdata-0000", Size: 8 * 1000 * GiB, Free: 2000 * GiB, Extent: 4 * MiB,
		PVs: []simPV{{Name: "/dev/md127", UUID: "pvraid-0000", Size: 8 * 1000 * GiB}},
		LVs: []simLV{{Name: "share", UUID: "lvshare-1", Size: 6000 * GiB, Layout: "linear", Major: 253, Minor: 0}}}}}
	s.Files["/etc/fstab"] = "UUID=a8000000-0000-4000-8000-000000000001 / ext4 errors=remount-ro 0 1\nUUID=1829-3A4B /boot/efi vfat umask=0077 0 1\n/dev/data/share /srv/share xfs defaults,nofail 0 2\n"
	uefiBoot(s, "/boot/efi", "debian", "a8100000-0000-4000-8000-000000000001", false)
	return finalize(s)
}

func sysRAID1Degraded() *simMachine {
	s := sysBIOSMBRRaid1()
	s.Name, s.Source = "raid1-degraded", "BIOS MBR mdadm RAID1 with one member missing at capture time"
	s.Disks = s.Disks[:1]
	for i := range s.MD {
		s.MD[i].Members = s.MD[i].Members[:1]
		s.MD[i].ArrayState, s.MD[i].Degraded = "clean", 1
	}
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/sda3                               partition\t8388604\t\t0\t\t-2\n"
	s.Files["/etc/fstab"] = "UUID=a7000000-0000-4000-8000-000000000001 / ext4 errors=remount-ro 0 1\nUUID=a7000000-0000-4000-8000-0000000000b0 /boot ext4 defaults 0 2\nUUID=c7000000-0000-4000-8000-000000000000 none swap sw 0 0\n"
	return s
}

func sysLVMThin() *simMachine {
	s := newSim("lvm-thin", "Debian 13, UEFI without Secure Boot, root and home as thin LVs, systemd-boot", "thin01")
	distro(s, "debian13", "6.12.12-amd64")
	s.Cmdline = "root=/dev/mapper/vg0-root ro quiet"
	d := newDisk("sda", 500107862016, "gpt", "A4B5C6D7-E8F9-4A0B-1C2D-3E4F50617283")
	vfat(addPart(d, 1, 1, 1024, tESP, "a9000000-0000-4000-8000-000000000001", ""), "2A3B-4C5D", "/boot/efi")
	p2 := pv(addPart(d, 2, 1025, 475000, tLVM, "a9000000-0000-4000-8000-000000000002", ""), "pvthin-0000")
	ext4(lvNode(p2, "vg0", "root", 40*GiB), "a9100000-0000-4000-8000-000000000001", "/")
	ext4(lvNode(p2, "vg0", "home", 200*GiB), "a9100000-0000-4000-8000-000000000002", "/home")
	s.Disks = []*simNode{d}
	s.LVM = &simLVM{VGs: []simVG{{Name: "vg0", UUID: "vgthin-0000", Size: 498000000000, Free: 10 * GiB, Extent: 4 * MiB,
		PVs: []simPV{{Name: "/dev/sda2", UUID: "pvthin-0000", Size: 498000000000}},
		LVs: []simLV{
			{Name: "pool", UUID: "lvpool-1", Size: 450 * GiB, Layout: "thin,pool", Attr: "twi-aotz--", SegType: "thin-pool", DataPct: "50.00", MetaPct: "12.00", Chunk: 65536, Meta: 1 * GiB, Major: -1},
			{Name: "root", UUID: "lvroot-2", Size: 40 * GiB, Layout: "thin,sparse", Attr: "Vwi-aotz--", SegType: "thin", Pool: "pool", DataPct: "30.00", Major: 253, Minor: 0},
			{Name: "home", UUID: "lvhome-3", Size: 200 * GiB, Layout: "thin,sparse", Attr: "Vwi-aotz--", SegType: "thin", Pool: "pool", DataPct: "60.00", Major: 253, Minor: 1}}}}}
	s.Files["/etc/fstab"] = "/dev/mapper/vg0-root / ext4 errors=remount-ro 0 1\n/dev/mapper/vg0-home /home ext4 defaults 0 2\nUUID=2A3B-4C5D /boot/efi vfat umask=0077 0 1\n"
	s.UEFI = true
	s.SecureBoot, s.SetupMode = boolPtr(false), boolPtr(false)
	sd := buildPE([]peSection{{".text", bytes.Repeat([]byte{0x93}, 2048)}}, nil)
	s.Bin["/boot/efi/EFI/systemd/systemd-bootx64.efi"] = sd
	s.Bin["/boot/efi/EFI/BOOT/BOOTX64.EFI"] = sd
	s.Files["/boot/efi/loader/loader.conf"] = "default debian-*\n"
	s.Files["/boot/efi/loader/entries/debian-6.12.12-amd64.conf"] = "title Debian\nlinux /vmlinuz-6.12.12-amd64\n"
	delete(s.Files, "/etc/default/grub")
	delete(s.Files, "/boot/grub/grub.cfg")
	return finalize(s)
}

func sysPVE() *simMachine {
	s := newSim("pve-raw-lvs", "Proxmox VE 8 host: pve/root, pve/swap, thin pool pve/data with guest disks (raw LVs)", "pve01")
	distro(s, "debian12", "6.8.12-4-pve")
	s.Cmdline = "BOOT_IMAGE=/boot/vmlinuz-6.8.12-4-pve root=/dev/mapper/pve-root ro quiet"
	d := newDisk("nvme0n1", 1000204886016, "gpt", "B5C6D7E8-F90A-4B1C-2D3E-4F5061728394")
	addPart(d, 1, 1, 1, tBIOSBoot, "aa000000-0000-4000-8000-000000000001", "")
	vfat(addPart(d, 2, 2, 1024, tESP, "aa000000-0000-4000-8000-000000000002", ""), "3B4C-5D6E", "/boot/efi")
	p3 := pv(addPart(d, 3, 1026, 952000, tLVM, "aa000000-0000-4000-8000-000000000003", ""), "pvpve-0000")
	ext4(lvNode(p3, "pve", "root", 96*GiB), "aa100000-0000-4000-8000-000000000001", "/")
	swapSig(lvNode(p3, "pve", "swap", 8*GiB), "aa100000-0000-4000-8000-000000000002")
	lvNode(p3, "pve", "vm-100-disk-0", 32*GiB)
	lvNode(p3, "pve", "vm-101-disk-0", 64*GiB)
	s.Disks = []*simNode{d}
	s.LVM = &simLVM{VGs: []simVG{{Name: "pve", UUID: "vgpve-0000", Size: 998000000000, Free: 16 * GiB, Extent: 4 * MiB,
		PVs: []simPV{{Name: "/dev/nvme0n1p3", UUID: "pvpve-0000", Size: 998000000000}},
		LVs: []simLV{
			{Name: "root", UUID: "lvr-1", Size: 96 * GiB, Layout: "linear", Major: 253, Minor: 0},
			{Name: "swap", UUID: "lvs-2", Size: 8 * GiB, Layout: "linear", Major: 253, Minor: 1},
			{Name: "data", UUID: "lvd-3", Size: 794 * GiB, Layout: "thin,pool", Attr: "twi-aotz--", SegType: "thin-pool", DataPct: "20.00", MetaPct: "5.00", Chunk: 65536, Meta: 8 * GiB, Major: -1},
			{Name: "vm-100-disk-0", UUID: "lvv-4", Size: 32 * GiB, Layout: "thin,sparse", Attr: "Vwi-aotz--", SegType: "thin", Pool: "data", DataPct: "40.00", Major: 253, Minor: 2},
			{Name: "vm-101-disk-0", UUID: "lvv-5", Size: 64 * GiB, Layout: "thin,sparse", Attr: "Vwi-aotz--", SegType: "thin", Pool: "data", DataPct: "10.00", Major: 253, Minor: 3},
		}}}}
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/dm-1                               partition\t8388604\t\t0\t\t-2\n"
	s.Files["/etc/fstab"] = "/dev/pve/root / ext4 errors=remount-ro 0 1\nUUID=3B4C-5D6E /boot/efi vfat defaults 0 1\n/dev/pve/swap none swap sw 0 0\nproc /proc proc defaults 0 0\n"
	s.Files["/usr/bin/pveversion"] = "#!/usr/bin/perl\n"
	s.Files["/etc/kernel/proxmox-boot-uuids"] = "3B4C-5D6E\n"
	uefiBoot(s, "/boot/efi", "proxmox", "aa000000-0000-4000-8000-000000000002", false)
	nic(s, "eno1", "b4:2e:99:01:02:03", "0000:01:00.0", "igb")
	s.Files["/etc/network/interfaces"] = "auto vmbr0\niface vmbr0 inet static\n\taddress 192.0.2.10/24\n\tbridge-ports eno1\n\thwaddress b4:2e:99:01:02:03\n"
	return finalize(s)
}

func sysNVMe4Kn() *simMachine {
	s := sysUbuntu2404()
	s.Name, s.Source = "nvme-4kn", "Ubuntu 24.04 on an NVMe formatted with 4096-byte logical sectors"
	d := s.Disks[0]
	d.LogSec, d.PhySec = 4096, 4096
	for _, p := range d.Children {
		p.LogSec, p.PhySec = 4096, 4096
		p.PartStart = p.PartStart * 512 / 4096
	}
	for _, n := range s.all() {
		if n.FSType == "vfat" {
			n.SecPerClus = 1
		}
	}
	return s
}

func sysNVMeTwoNS() *simMachine {
	s := sysUbuntu2404()
	s.Name, s.Source = "nvme-two-ns", "NVMe controller with two namespaces; the second holds an XFS data file system"
	d2 := newDisk("nvme0n2", 500107862016, "gpt", "C6D7E8F9-0A1B-4C2D-3E4F-506172839405")
	d2.NSID, d2.EUI = "2", "00 25 38 b1 11 b2 c3 d5"
	d2.DevPath = strings.Replace(d2.DevPath, "nvme0n1", "nvme0n2", 1)
	xfs(addPart(d2, 1, 1, 476000, tLinux, "ab000000-0000-4000-8000-000000000001", "data"), "ab100000-0000-4000-8000-000000000001", "/srv").XFS.Nrext64 = 1
	s.Disks = append(s.Disks, d2)
	s.Files["/etc/fstab"] += "UUID=ab100000-0000-4000-8000-000000000001 /srv xfs defaults 0 2\n"
	for _, n := range s.all() {
		n.MajMin = ""
	}
	return finalize(s)
}

func sysBtrfsRAID1() *simMachine {
	s := newSim("btrfs-raid1-multi", "btrfs RAID1 for data and metadata over two whole disks, system on a third", "bfs01")
	distro(s, "debian12", "6.1.0-27-amd64")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-6.1.0-27-amd64 root=UUID=ac000000-0000-4000-8000-000000000001 ro"
	sys := newDisk("sda", 256060514304, "gpt", "D7E8F90A-1B2C-4D3E-4F50-6172839405A6")
	vfat(addPart(sys, 1, 1, 512, tESP, "ac100000-0000-4000-8000-000000000001", ""), "4C5D-6E7F", "/boot/efi")
	ext4(addPart(sys, 2, 513, 243000, tLinux, "ac100000-0000-4000-8000-000000000002", ""), "ac000000-0000-4000-8000-000000000001", "/")
	b := newDisk("sdb", 4000787030016, "", "")
	c := newDisk("sdc", 4000787030016, "", "")
	fs := &simBtrfs{Data: "raid1", Meta: "raid1", System: "raid1", Subvols: []simSubvol{
		{ID: 256, Parent: 5, TopLevel: 5, Path: "photos", UUID: "ac200000-0000-4000-8000-000000000256"},
		{ID: 257, Parent: 5, TopLevel: 5, Path: "backup", UUID: "ac200000-0000-4000-8000-000000000257"},
	}, Size: 8001574060032, Used: 3000000000000}
	btrfsFS(b, "ac300000-0000-4000-8000-000000000001", fs, s, simMount{Target: "/srv/pool", Root: "/", SubvolID: 5})
	c.FSType, c.UUID = "btrfs", b.UUID
	c.Blkid = map[string]string{"UUID_SUB": "77777777-0000-4000-8000-0000000000cc", "BLOCK_SIZE": "4096"}
	s.Disks = []*simNode{sys, b, c}
	s.Files["/etc/fstab"] = "UUID=ac000000-0000-4000-8000-000000000001 / ext4 errors=remount-ro 0 1\nUUID=4C5D-6E7F /boot/efi vfat umask=0077 0 1\nUUID=ac300000-0000-4000-8000-000000000001 /srv/pool btrfs defaults,noatime 0 0\n"
	uefiBoot(s, "/boot/efi", "debian", "ac100000-0000-4000-8000-000000000001", true)
	return finalize(s)
}

func sysLUKS1EncryptedBoot() *simMachine {
	s := newSim("luks1-encrypted-boot", "Debian 12, BIOS + GPT, LUKS1 with encrypted /boot (GRUB cryptodisk), LVM inside, key file in the initramfs", "lap01")
	distro(s, "debian12", "6.1.0-27-amd64")
	s.Cmdline = "BOOT_IMAGE=/boot/vmlinuz-6.1.0-27-amd64 root=/dev/mapper/vg-root ro cryptopts=source=UUID=3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c,keyscript=decrypt_keyctl quiet"
	d := newDisk("sda", 512110190592, "gpt", "E8F90A1B-2C3D-4E4F-5061-72839405A6B7")
	addPart(d, 1, 1, 1, tBIOSBoot, "ad000000-0000-4000-8000-000000000001", "")
	c := luks(addPart(d, 2, 2, 488000, tLinux, "ad000000-0000-4000-8000-000000000002", ""), "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c", 1, "sda2_crypt")
	pv(c, "pvlap-0000")
	ext4(lvNode(c, "vg", "root", 470*GiB), "ad100000-0000-4000-8000-000000000001", "/")
	swapSig(lvNode(c, "vg", "swap", 16*GiB), "ad100000-0000-4000-8000-000000000002")
	s.Disks = []*simNode{d}
	biosGrub(s, d)
	s.LUKS["/dev/sda2"] = luks1Dump
	s.LVM = &simLVM{VGs: []simVG{{Name: "vg", UUID: "vglap-0000", Size: 511000000000, Free: 0, Extent: 4 * MiB,
		PVs: []simPV{{Name: "/dev/mapper/sda2_crypt", UUID: "pvlap-0000", Size: 511000000000}},
		LVs: []simLV{{Name: "root", UUID: "lvlr-1", Size: 470 * GiB, Layout: "linear", Major: 253, Minor: 1},
			{Name: "swap", UUID: "lvls-2", Size: 16 * GiB, Layout: "linear", Major: 253, Minor: 2}}}}}
	s.Files["/etc/crypttab"] = "sda2_crypt UUID=3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c /etc/keys/root.key luks,discard,key-slot=1\n"
	s.Files["/etc/default/grub"] = "GRUB_ENABLE_CRYPTODISK=y\nGRUB_CMDLINE_LINUX=\"\"\n"
	s.Files["/etc/fstab"] = "/dev/mapper/vg-root / ext4 errors=remount-ro 0 1\n/dev/mapper/vg-swap none swap sw 0 0\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/dm-2                               partition\t16777212\t\t0\t\t-2\n"
	return finalize(s)
}

func sysLUKS2TPM2Clevis() *simMachine {
	s := sysDebian12()
	s.Name, s.Source = "luks2-tpm2-clevis", "Debian 12 with LUKS2 bound to a TPM2 (systemd-cryptenroll) and a Clevis/Tang token; token contents must never appear"
	tokens := `
    "0":{"type":"systemd-tpm2","keyslots":["1"],"tpm2-blob":"TOKENSECRET0AAAAtpm2blobdeadbeef","tpm2-pcrs":[7],"tpm2-pcr-bank":"sha256","tpm2-primary-alg":"ecc","tpm2-policy-hash":"TOKENSECRET1policyhash00ff","tpm2-pin":false},
    "1":{"type":"clevis","keyslots":["2"],"jwe":{"ciphertext":"TOKENSECRET2JWECIPHERTEXT","encrypted_key":"","iv":"TOKENSECRET3IV","protected":"TOKENSECRET4eyJhbGciOiJFQ0RILUVTIn0","tag":"TOKENSECRET5TAG"}}`
	slots := `,
    "1":{"type":"luks2","key_size":64,"af":{"type":"luks1","stripes":4000,"hash":"sha512"},"area":{"type":"raw","offset":"290816","size":"258048","encryption":"aes-xts-plain64","key_size":64},"kdf":{"type":"pbkdf2","hash":"sha512","iterations":1000,"salt":"KDFSALT1SECRETc2FsdDE="}},
    "2":{"type":"luks2","key_size":64,"af":{"type":"luks1","stripes":4000,"hash":"sha256"},"area":{"type":"raw","offset":"548864","size":"258048","encryption":"aes-xts-plain64","key_size":64},"kdf":{"type":"pbkdf2","hash":"sha256","iterations":1000,"salt":"KDFSALT2SECRETc2FsdDI="}}`
	s.LUKS["/dev/nvme0n1p3"] = luks2JSON(64, tokens, slots, "")
	s.Files["/etc/crypttab"] = "nvme0n1p3_crypt UUID=2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d none luks,discard,tpm2-device=auto\n"
	return s
}

// luks2Secrets are strings of the clevis fixture that must not leak.
var luks2Secrets = []string{"TOKENSECRET", "KDFSALT", "DIGESTSALT", "DIGESTVALUE", "SECRETMK", "SECRETSLOT", "never-read-secret", "tpm2-blob", "jwe", "ciphertext", "digests"}

func sysPlainSwap() *simMachine {
	s := newSim("plain-dmcrypt-swap", "Debian 12 with plain dm-crypt swap (/dev/urandom) and a data file system on a second disk", "srv04")
	distro(s, "debian12", "6.1.0-27-amd64")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-6.1.0-27-amd64 root=UUID=ae000000-0000-4000-8000-000000000001 ro"
	d := newDisk("vda", 68719476736, "gpt", "F90A1B2C-3D4E-4F50-6172-839405A6B7C8")
	vfat(addPart(d, 1, 1, 512, tESP, "ae100000-0000-4000-8000-000000000001", ""), "5D6E-7F80", "/boot/efi")
	ext4(addPart(d, 2, 513, 56800, tLinux, "ae100000-0000-4000-8000-000000000002", ""), "ae000000-0000-4000-8000-000000000001", "/")
	p3 := addPart(d, 3, 57313, 8192, tSwap, "ae100000-0000-4000-8000-000000000003", "")
	cs := &simNode{KName: "dm-0", Name: "cswap", Type: "crypt", Size: 8192 * MiB}
	swapSig(cs, "")
	p3.Children = []*simNode{cs}
	d2 := newDisk("vdb", 107374182400, "gpt", "0A1B2C3D-4E4F-5061-7283-9405A6B7C8D9")
	ext4(addPart(d2, 1, 1, 102000, tLinux, "ae200000-0000-4000-8000-000000000001", "data"), "ae300000-0000-4000-8000-000000000001", "/srv/data")
	d2.Children[0].Label = "data"
	s.Disks = []*simNode{d, d2}
	s.DMCrypt = "cswap: 0 16777216 crypt aes-xts-plain64 0000000000000000000000000000000000000000000000000000000000000000 0 252:3 0\n"
	s.Files["/etc/crypttab"] = "cswap /dev/disk/by-partuuid/ae100000-0000-4000-8000-000000000003 /dev/urandom swap,cipher=aes-xts-plain64,size=256\n"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/dm-0                               partition\t8388604\t\t0\t\t-2\n"
	s.Files["/etc/fstab"] = "UUID=ae000000-0000-4000-8000-000000000001 / ext4 errors=remount-ro 0 1\nUUID=5D6E-7F80 /boot/efi vfat umask=0077 0 1\n/dev/mapper/cswap none swap sw 0 0\nLABEL=data /srv/data ext4 defaults 0 2\n"
	uefiBoot(s, "/boot/efi", "debian", "ae100000-0000-4000-8000-000000000001", true)
	finalize(s)
	cs.MajMin = "253:0"
	return s
}

func sysSwapfileBtrfs() *simMachine {
	s := newSim("swapfile-btrfs", "Fedora with a swap file on btrfs in its own subvolume (No_COW)", "fed02")
	distro(s, "fedora", "6.11.5-300.fc41.x86_64")
	s.Cmdline = "root=UUID=af000000-0000-4000-8000-000000000001 ro rootflags=subvol=root resume=UUID=af000000-0000-4000-8000-000000000001 resume_offset=533760"
	d := newDisk("nvme0n1", 512110190592, "gpt", "1B2C3D4E-4F50-6172-8394-05A6B7C8D9EA")
	vfat(addPart(d, 1, 1, 600, tESP, "af100000-0000-4000-8000-000000000001", ""), "6E7F-8091", "/boot/efi")
	p2 := addPart(d, 2, 601, 487000, tLinux, "af100000-0000-4000-8000-000000000002", "")
	btrfsFS(p2, "af000000-0000-4000-8000-000000000001", &simBtrfs{Subvols: []simSubvol{
		{ID: 256, Parent: 5, TopLevel: 5, Path: "root", UUID: "af200000-0000-4000-8000-000000000256"},
		{ID: 257, Parent: 5, TopLevel: 5, Path: "swap", UUID: "af200000-0000-4000-8000-000000000257"},
	}, NoCow: []string{"/swap"}}, s, simMount{Target: "/", Root: "/root", SubvolID: 256}, simMount{Target: "/swap", Root: "/swap", SubvolID: 257})
	s.Disks = []*simNode{d}
	s.Files["/swap/swapfile"] = "swap"
	s.Swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swap/swapfile                          file\t\t16777212\t\t0\t\t-2\n"
	s.Extra["btrfs inspect-internal map-swapfile -r /swap/swapfile"] = simAnswer{Out: "533760\n"}
	s.Files["/etc/fstab"] = "UUID=af000000-0000-4000-8000-000000000001 / btrfs subvol=root 0 0\nUUID=af000000-0000-4000-8000-000000000001 /swap btrfs subvol=swap 0 0\nUUID=6E7F-8091 /boot/efi vfat umask=0077 0 2\n/swap/swapfile none swap defaults 0 0\n"
	uefiBoot(s, "/boot/efi", "fedora", "af100000-0000-4000-8000-000000000001", true)
	return finalize(s)
}

func sysESPAutomount() *simMachine {
	s := sysArchUKI()
	s.Name, s.Source = "esp-automount", "ESP mounted on demand through x-systemd.automount (autofs entry in mountinfo)"
	s.Files["/etc/fstab"] = "UUID=f3000000-0000-4000-8000-000000000001 / ext4 rw,relatime 0 1\nUUID=F607-1829 /efi vfat rw,noauto,x-systemd.automount,x-systemd.idle-timeout=1min,fmask=0077 0 2\n"
	s.Files["/proc/self/mountinfo.extra"] = "90 1 0:60 / /efi rw,relatime shared:50 - autofs systemd-1 rw,fd=45,pgrp=1,timeout=60,minproto=5,maxproto=5,direct\n"
	return s
}

func sysESPNoauto() *simMachine {
	s := sysUbuntu2404()
	s.Name, s.Source = "esp-noauto", "ESP in fstab with noauto, not mounted at capture time (the snapshot helper mounts it read-only)"
	for _, n := range s.all() {
		if n.FSType == "vfat" {
			n.Mounts, n.FSSize, n.FSUsed = nil, 0, 0
		}
	}
	s.Files["/etc/fstab"] = "UUID=5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e / ext4 defaults 0 1\nUUID=B2C3-D4E5 /boot/efi vfat noauto,umask=0077 0 1\n/swap.img none swap sw 0 0\n"
	return s
}

func sysDualBoot() *simMachine {
	s := sysUbuntu2404()
	s.Name, s.Source = "dual-boot-windows", "Ubuntu 24.04 next to Windows 11 on one NVMe: MSR, NTFS partitions, Windows Boot Manager on the shared ESP"
	d := s.Disks[0]
	d.Children = d.Children[:1]
	addPart(d, 2, 1025, 16, tMSR, "b0000000-0000-4000-8000-000000000002", "Microsoft reserved partition")
	w := addPart(d, 3, 1041, 400000, tMSData, "b0000000-0000-4000-8000-000000000003", "Basic data partition")
	w.FSType, w.UUID, w.Label = "ntfs", "0123456789ABCDEF", "Windows"
	ext4(addPart(d, 4, 401041, 500000, tLinux, "b0000000-0000-4000-8000-000000000004", ""), "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", "/")
	s.Bin["/boot/efi/EFI/Microsoft/Boot/bootmgfw.efi"] = buildPE([]peSection{{".text", bytes.Repeat([]byte{0x94}, 1024)}},
		ptr(newTestSigner("Microsoft Windows", "Microsoft Windows Production PCA 2011", 0x33000004, 7)))
	s.BootEntries = append(s.BootEntries, simBootEntry{Num: 2, Label: "Windows Boot Manager", PartUUID: "a1000000-0000-4000-8000-000000000001", PartNum: 1, Path: `\EFI\Microsoft\Boot\bootmgfw.efi`, Active: true})
	s.BootOrder = []uint16{1, 2, 0}
	for _, n := range s.all() {
		n.MajMin = ""
	}
	return finalize(s)
}

func ptr[T any](v T) *T { return &v }

func sysDockerBtrfsMany() *simMachine {
	s := newSim("docker-btrfs-many", "Ubuntu 22.04 on btrfs with the container image storage driver btrfs and 205 image subvolumes", "dock01")
	distro(s, "ubuntu2204", "5.15.0-125-generic")
	s.Cmdline = "BOOT_IMAGE=/vmlinuz-5.15.0-125-generic root=UUID=b1000000-0000-4000-8000-000000000001 ro rootflags=subvol=@"
	d := newDisk("sda", 500107862016, "gpt", "2C3D4E4F-5061-7283-9405-A6B7C8D9EAFB")
	vfat(addPart(d, 1, 1, 512, tESP, "b1100000-0000-4000-8000-000000000001", ""), "7F80-91A2", "/boot/efi")
	p2 := addPart(d, 2, 513, 476000, tLinux, "b1100000-0000-4000-8000-000000000002", "")
	subs := []simSubvol{{ID: 256, Parent: 5, TopLevel: 5, Path: "@", UUID: "b1200000-0000-4000-8000-000000000256"},
		{ID: 257, Parent: 5, TopLevel: 5, Path: "@home", UUID: "b1200000-0000-4000-8000-000000000257"}}
	for i := 0; i < 205; i++ {
		subs = append(subs, simSubvol{ID: int64(300 + i), Parent: 256, TopLevel: 256,
			Path: fmt.Sprintf("@/var/lib/docker/btrfs/subvolumes/%064x", i+1), UUID: fmt.Sprintf("b1300000-0000-4000-8000-%012d", i)})
	}
	btrfsFS(p2, "b1000000-0000-4000-8000-000000000001", &simBtrfs{Subvols: subs, Csum: "xxhash"}, s,
		simMount{Target: "/", Root: "/@", SubvolID: 256}, simMount{Target: "/home", Root: "/@home", SubvolID: 257})
	s.Disks = []*simNode{d}
	s.Files["/etc/fstab"] = "UUID=b1000000-0000-4000-8000-000000000001 / btrfs defaults,subvol=@ 0 1\nUUID=b1000000-0000-4000-8000-000000000001 /home btrfs defaults,subvol=@home 0 2\nUUID=7F80-91A2 /boot/efi vfat umask=0077 0 1\n"
	uefiBoot(s, "/boot/efi", "ubuntu", "b1100000-0000-4000-8000-000000000001", true)
	nic(s, "eno1", "0c:c4:7a:01:02:03", "0000:05:00.0", "ixgbe")
	s.Interfaces = append(s.Interfaces, simNet{Name: "docker0", MAC: "02:42:ac:11:00:01"})
	return finalize(s)
}

func sysContainer() *simMachine {
	s := newSim("container", "Alpine in an LXC container: no storage stack of its own", "ct101")
	s.OSRelease = osReleases["alpine"]
	s.Kernel = "6.8.12-4-pve"
	s.NoSystemd = true
	s.Container = true
	s.Files["/proc/self/mountinfo.extra"] = "100 1 253:5 / / rw,relatime - ext4 /dev/mapper/pve-vm--101--disk--0 rw,stripe=16\n"
	s.Files["/etc/fstab"] = "# empty\n"
	s.Interfaces = []simNet{{Name: "eth0", MAC: "bc:24:11:aa:bb:cc"}}
	return finalize(s)
}

// simSystems lists the fixtures of testdata/capture.
func simSystems() []*simMachine {
	return []*simMachine{
		sysDebian12(), sysUbuntu2204BIOSMdadm(), sysUbuntu2404(), sysUbuntuZFS(), sysAlma9(), sysFedoraBtrfs(),
		sysOpenSUSE(), sysArchUKI(), sysBIOSMBRRaid1(), sysRAID5Spare(), sysRAID1Degraded(), sysLVMThin(), sysPVE(),
		sysNVMe4Kn(), sysNVMeTwoNS(), sysBtrfsRAID1(), sysLUKS1EncryptedBoot(), sysLUKS2TPM2Clevis(), sysPlainSwap(),
		sysSwapfileBtrfs(), sysESPAutomount(), sysESPNoauto(), sysDualBoot(), sysDockerBtrfsMany(), sysContainer(),
	}
}
