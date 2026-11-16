package baremetal

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRedactCmdline(t *testing.T) {
	cases := map[string]string{
		"root=/dev/sda1 ro quiet":           "root=/dev/sda1 ro quiet",
		"rd.iscsi.password=hunter2 ip=dhcp": "rd.iscsi.password=<redacted> ip=dhcp",
		"netroot=iscsi:user:pass@192.0.2.1::3260::iqn.2026-11.org.example:t1 rd.iscsi.initiator=iqn.x": "netroot=iscsi:<redacted>@192.0.2.1::3260::iqn.2026-11.org.example:t1 rd.iscsi.initiator=iqn.x",
		"netroot=iscsi:a:b:c:d@srv::3260::iqn.x":                                                       "netroot=iscsi:<redacted>@srv::3260::iqn.x",
		"cryptkey=rootfs:/key.bin cryptdevice=UUID=x:root":                                             "cryptkey=<redacted> cryptdevice=UUID=x:root",
		"rd.luks.key=/etc/k rd.vconsole.keymap=de":                                                     "rd.luks.key=<redacted> rd.vconsole.keymap=de",
		"wpa_psk=x API_TOKEN=y my.secret=z passwd=q":                                                   "wpa_psk=<redacted> API_TOKEN=<redacted> my.secret=<redacted> passwd=<redacted>",
		"inst.repo=http://user:pw@mirror/x  console=ttyS0":                                             "inst.repo=http://<redacted>@mirror/x console=ttyS0",
		`foo="a b" key="x y"`:                                                                          `foo="a b" key=<redacted>`,
		"keyboard=us keytable=de":                                                                      "keyboard=us keytable=de",
	}
	for in, want := range cases {
		if got := RedactCmdline(in); got != want {
			t.Errorf("%q:\n got %q\nwant %q", in, got, want)
		}
	}
	if got := SplitCmdline(`a "b c" d"e f"g`); len(got) != 3 || got[1] != `"b c"` || got[2] != `d"e f"g` {
		t.Fatalf("%q", got)
	}
}

func TestEFIParsers(t *testing.T) {
	e := simBootEntry{Num: 3, Label: "debian", PartUUID: "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", PartNum: 1, Path: `\EFI\debian\shimx64.efi`, Active: true}
	raw := efiVar(loadOption(e))
	attrs, v, err := ParseEFIVar(raw)
	if err != nil || attrs != 7 {
		t.Fatal(err)
	}
	o, err := ParseLoadOption(v)
	if err != nil || o.Description != "debian" || o.PartUUID != e.PartUUID || o.PartNumber != 1 || o.Path != e.Path || !o.Active() {
		t.Fatalf("%+v %v", o, err)
	}
	if _, err := ParseLoadOption(v[:8]); err == nil {
		t.Fatal("truncated accepted")
	}
	if got := ParseBootOrder([]byte{1, 0, 0, 0, 0x10, 0}); len(got) != 3 || got[2] != 16 {
		t.Fatalf("%v", got)
	}
	list := append(certList([]testSigner{msThirdParty}), sigList(certSHA256GUID, [][]byte{bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)})...)
	sl, err := ParseSignatureList(list)
	if err != nil || len(sl.Certs) != 1 || len(sl.Hashes) != 2 || !strings.Contains(sl.Certs[0].Subject, "Microsoft Windows UEFI Driver Publisher") {
		t.Fatalf("%+v %v", sl, err)
	}
	if HashListSHA256(sl.Hashes) != HashListSHA256([]string{sl.Hashes[1], sl.Hashes[0]}) {
		t.Fatal("dbx hash depends on order")
	}
	if _, err := ParseSignatureList(list[:20]); err == nil {
		t.Fatal("truncated list accepted")
	}
	if got := ParseSbatLevel([]byte("sbat,1,2024010900\n\nshim,4\ngrub,3\n\x00")); strings.Join(got, "|") != "sbat,1,2024010900|shim,4|grub,3" {
		t.Fatalf("%q", got)
	}
	bad := make([]byte, 10)
	binary.LittleEndian.PutUint16(bad[4:], 200)
	if _, err := ParseLoadOption(bad); err == nil {
		t.Fatal("bad length accepted")
	}
}

func TestCheckString(t *testing.T) {
	for _, s := range []string{"a\x00", "\x1b[2K", "a\rb", "\x7f", "\u0085", "\u009b", "\u2028", "\u2029", "\xff"} {
		if checkString(s) == nil {
			t.Errorf("%q accepted", s)
		}
	}
	for _, s := range []string{"", "Ünïcode ✓", "tab-free", "\u00a0nbsp", "emoji 🙂"} {
		if err := checkString(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	if got := cleanString("a\x1bb\xffc", 0); got != "a?b?c" {
		t.Fatalf("%q", got)
	}
	if got := cleanString("äöü", 3); got != "ä" {
		t.Fatalf("cut inside a rune: %q", got)
	}
}

// assessCase changes the clean Debian example so that exactly one code fires.
func TestAssessCodes(t *testing.T) {
	base := func() *Manifest {
		m := exampleDebian()
		m.Linux.Unsupported = nil
		return m
	}
	lv := func(m *Manifest) *LogicalVolume { return &m.Linux.LVM.VGs[0].LVs[0] }
	cases := map[string]func(m *Manifest){
		CodeFSTypeUnsupported:  func(m *Manifest) { m.Linux.Mounts[0].Type = "zfs" },
		CodeLVMTypeUnsupported: func(m *Manifest) { lv(m).Type = "cache" },
		CodeMDContainerUnsupported: func(m *Manifest) {
			m.Linux.MD = []MDArray{{ID: "m0", KName: "md126", UUID: "u", Level: "container", Metadata: "imsm", Bitmap: "none", State: "clean"}}
		},
		CodeMDJournalUnsupported: func(m *Manifest) {
			m.Linux.MD = []MDArray{{ID: "m0", KName: "md0", UUID: "u", Level: "raid5", Metadata: "1.2", Bitmap: "none", State: "clean", Journal: true}}
		},
		CodeMDReshapeInProgress: func(m *Manifest) {
			m.Linux.MD = []MDArray{{ID: "m0", KName: "md0", UUID: "u", Level: "raid5", Metadata: "1.2", Bitmap: "none", State: "active,reshape"}}
		},
		CodeIntegrityUnsupported:   func(m *Manifest) { m.Linux.LUKS[0].Integrity = strPtr("hmac(sha256)") },
		CodeNetworkRootUnsupported: func(m *Manifest) { m.Linux.Mounts[0].Type, m.Linux.Mounts[0].FS = "nfs4", nil },
		CodeXFSExternalLog:         func(m *Manifest) { m.Linux.Filesystems[3].XFS.ExternalLog = true },
		CodeBootloaderUnsupported:  func(m *Manifest) { m.Linux.Bootloader.Kind = "other" },
		CodeInitramfsUnsupported:   func(m *Manifest) { m.Linux.Initramfs.Generator = strPtr("other") },
		CodeUKIWithoutGenerator:    func(m *Manifest) { m.Linux.Loaders[0].UKI = true },
		CodeFstabUnresolvable:      func(m *Manifest) { m.Linux.Fstab[1].Resolved = nil },
		CodeLUKSToken:              func(m *Manifest) { m.Linux.LUKS[0].TokenTypes = []string{"systemd-tpm2"} },
		CodeSnapshotSubvolumes:     func(m *Manifest) { addBtrfs(m, SubvolSnapper, 1) },
		CodeLVMSnapshotLVs:         func(m *Manifest) { lv(m).Origin = strPtr("home") },
		CodeRawLVs:                 func(m *Manifest) { lv(m).Raw = true },
		CodePVEGuestVolumes:        func(m *Manifest) { lv(m).Raw = true; m.Linux.OS.ProxmoxVE = true },
		CodeDockerBtrfsMany:        func(m *Manifest) { addBtrfs(m, SubvolDocker, 201) },
		CodeDataFSUnsupported:      func(m *Manifest) { m.Linux.Mounts[3].Type = "ntfs3" },
		CodeUntestedDistribution:   func(m *Manifest) { m.Linux.OS.ID = "gentoo" },
		CodeNonSystemdInit:         func(m *Manifest) { m.Linux.OS.Init = "other" },
		CodeSecureBootOwnKeys: func(m *Manifest) {
			m.Linux.Loaders[0].Signer = &Signer{Issuer: "CN=Own CA", Subject: "CN=Own", Serial: "1"}
		},
		CodeDKMSMok: func(m *Manifest) {
			m.Linux.DKMS = []DKMSModule{{Module: "r8125", Version: "1", Kernel: "6.1", Signer: strPtr("DKMS"), Kind: "net"}}
		},
		CodeBIOSNeedsCSM:    func(m *Manifest) { m.Linux.Firmware.Mode = "bios" },
		CodeDualBootWindows: func(m *Manifest) { m.Linux.Disks[0].Table.Partitions[1].Type = strings.ToUpper(msReservedGUID) },
		CodeLVMDeviceIDs:    func(m *Manifest) { m.Linux.LVM.UseDevicesFile = true },
		CodeDeviceNameRefs: func(m *Manifest) {
			m.Linux.DeviceNameRefs = []DeviceNameRef{{Path: "/etc/x", Line: 1, Device: "/dev/sda1"}}
		},
		CodeMDDegraded: func(m *Manifest) {
			m.Linux.MD = []MDArray{{ID: "m0", KName: "md0", UUID: "u", Level: "raid1", Metadata: "1.2", Bitmap: "none", State: "clean,degraded"}}
		},
	}
	if v, list := Assess(base()); v != VerdictSupported || len(list) != 0 {
		t.Fatalf("base: %s %+v", v, list)
	}
	for code, mutate := range cases {
		m := base()
		mutate(m)
		v, list := Assess(m)
		if len(list) != 1 || list[0].Code != code {
			t.Errorf("%s: %+v", code, list)
			continue
		}
		wantVerdict := VerdictSupportedWithWarnings
		for _, c := range UnsupportedCodes {
			if c == code {
				wantVerdict = VerdictUnsupported
			}
		}
		if v != wantVerdict || list[0].Message == "" {
			t.Errorf("%s: verdict %s, message %q", code, v, list[0].Message)
		}
	}
	// Collector findings are kept.
	m := base()
	for _, c := range []string{CodeMultipathUnsupported, CodeLUKSDetachedHeader, CodeUnknownDeviceInBootPath, CodeContainer, CodeCaptureFailed} {
		m.Linux.Unsupported = append(m.Linux.Unsupported, Unsupported{Code: c, Message: "x", Severity: SeverityUnsupported})
	}
	m.Linux.Unsupported = append(m.Linux.Unsupported, Unsupported{Code: CodeBIOSNeedsCSM, Message: "stale", Severity: SeverityWarning})
	_, list := Assess(m)
	if len(list) != 5 {
		t.Fatalf("%+v", list)
	}
	if v, l := Assess(exampleDarwin()); v != VerdictSupported || len(l) != 0 {
		t.Fatal("darwin")
	}
}

func addBtrfs(m *Manifest, kind string, n int) {
	b := &BtrfsInfo{DataProfile: "single", MetadataProfile: "dup", SystemProfile: "dup", NodeSize: 16384, SectorSize: 4096}
	for i := 0; i < n; i++ {
		b.Subvolumes = append(b.Subvolumes, Subvolume{ID: int64(256 + i), Path: "p", ParentID: 5, UUID: "u", Kind: kind})
	}
	m.Linux.Filesystems = append(m.Linux.Filesystems, Filesystem{ID: "f9", Devices: []BlockRef{PartRef("d0", 2)}, Type: "btrfs", Btrfs: b})
}

func TestGrowDefaults(t *testing.T) {
	m := exampleDebian()
	l := m.Linux
	for i := range l.Disks[0].Table.Partitions {
		l.Disks[0].Table.Partitions[i].Grow = nil
	}
	for i := range l.LVM.VGs[0].LVs {
		l.LVM.VGs[0].LVs[i].Grow = nil
	}
	setGrowDefaults(l)
	p := l.Disks[0].Table.Partitions
	if p[2].Grow == nil || p[0].Grow != nil || p[1].Grow != nil {
		t.Fatalf("partition grow: %+v", p)
	}
	lvs := l.LVM.VGs[0].LVs
	if lvs[2].Grow == nil || lvs[0].Grow != nil || lvs[1].Grow != nil {
		t.Fatalf("lv grow: %+v", lvs)
	}
	// Only root and swap: root grows. The last partition is an ESP: none.
	l.LVM.VGs[0].LVs = lvs[:2]
	l.LVM.VGs[0].LVs[0].Grow, l.LVM.VGs[0].LVs[1].Grow = nil, nil
	l.Disks[0].Table.Partitions = p[:1]
	l.Disks[0].Table.Partitions[0].Grow = nil
	setGrowDefaults(l)
	if l.LVM.VGs[0].LVs[0].Grow == nil || l.Disks[0].Table.Partitions[0].Grow != nil {
		t.Fatalf("%+v %+v", l.LVM.VGs[0].LVs, l.Disks[0].Table.Partitions)
	}
}

func TestTriggerAutomounts(t *testing.T) {
	m, _, _ := replay(t, "esp-automount")
	_ = m
	host := DirHost{Root: filepath.Join(captureDir, "esp-automount", "root")}
	var seen []string
	failed := TriggerAutomounts(context.Background(), host, func(ctx context.Context, p string) error {
		seen = append(seen, p)
		if p == "/efi" {
			return nil
		}
		return errors.New("x")
	})
	if strings.Join(seen, ",") != "/efi" || len(failed) != 0 {
		t.Fatalf("seen %v failed %v", seen, failed)
	}
	old := AutomountTimeout
	AutomountTimeout = 50 * time.Millisecond
	defer func() { AutomountTimeout = old }()
	failed = TriggerAutomounts(context.Background(), host, func(ctx context.Context, p string) error {
		<-ctx.Done()
		return ctx.Err()
	})
	if len(failed) != 1 {
		t.Fatalf("hanging automount: %v", failed)
	}
}

func TestWriteBaremetalDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "baremetal")
	b, _ := exampleDebian().Encode()
	if err := WriteBaremetalDir(dir, b, RawSet{"old.txt": []byte("x")}); err != nil {
		t.Fatal(err)
	}
	if err := WriteBaremetalDir(dir, b, RawSet{"lsblk.json": []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, LayoutFile))
	if err != nil || !bytes.Equal(got, b) {
		t.Fatal("layout.json differs from the canonical bytes")
	}
	if _, err := os.Stat(filepath.Join(dir, "raw", "old.txt")); !os.IsNotExist(err) {
		t.Fatal("old raw file kept")
	}
	if st, _ := os.Stat(dir); st.Mode().Perm() != 0o700 && os.PathSeparator == '/' {
		t.Fatalf("mode %v", st.Mode())
	}
	if err := WriteBaremetalDir(dir, b, RawSet{"../x": nil}); err == nil {
		t.Fatal("path accepted")
	}
	_ = time.Now
}
