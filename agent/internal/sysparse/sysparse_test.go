package sysparse

import (
	"os"
	"path/filepath"
	"testing"
)

func read(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseMountinfo(t *testing.T) {
	m, err := ParseMountinfo(read(t, "mountinfo.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 7 {
		t.Fatalf("%d entries", len(m))
	}
	home := m[5]
	if home.Target != "/home" || home.Root != "/@home" || home.FSType != "btrfs" || home.Source != "/dev/sdb1" ||
		len(home.Optional) != 2 || home.Optional[1] != "master:2" || home.MajMin != "0:45" {
		t.Fatalf("%+v", home)
	}
	if v, ok := home.Option("subvolid"); !ok || v != "257" {
		t.Fatalf("subvolid %q %v", v, ok)
	}
	if v, ok := home.Option("compress"); !ok || v != "zstd:1" {
		t.Fatalf("compress %q", v)
	}
	if m[6].Target != "/mnt/my data" || m[6].Root != "/srv/data" {
		t.Fatalf("escape: %+v", m[6])
	}
	if _, err := ParseMountinfo([]byte("1 2 3\n")); err == nil {
		t.Fatal("malformed accepted")
	}
}

func TestParseFstab(t *testing.T) {
	f := ParseFstab(read(t, "fstab.txt"))
	if len(f) != 6 {
		t.Fatalf("%d entries: %+v", len(f), f)
	}
	if f[0].Target != "/" || f[0].Pass != 1 || f[0].Options != "errors=remount-ro" {
		t.Fatalf("%+v", f[0])
	}
	if f[4].Source != "LABEL=usb disk" || !HasOption(f[4].Options, "noauto") || !HasOption(f[4].Options, "x-systemd.automount") {
		t.Fatalf("%+v", f[4])
	}
	if f[5].Options != "defaults" || f[5].Type != "nfs4" {
		t.Fatalf("%+v", f[5])
	}
}

func TestParseSystemdMountUnit(t *testing.T) {
	u, ok := ParseSystemdMountUnit([]byte("[Unit]\nDescription=x\n\n[Mount]\nWhat=/dev/disk/by-uuid/abc\nWhere=/srv/data\nType=xfs\nOptions=noatime\n"))
	if !ok || u.What != "/dev/disk/by-uuid/abc" || u.Where != "/srv/data" || u.Type != "xfs" || u.Section != "Mount" {
		t.Fatalf("%+v", u)
	}
	if _, ok := ParseSystemdMountUnit([]byte("[Unit]\nDescription=x\n")); ok {
		t.Fatal("no mount section accepted")
	}
}

func TestParseCrypttab(t *testing.T) {
	c := ParseCrypttab(read(t, "crypttab.txt"))
	if len(c) != 3 || c[1].KeyFile != "/etc/luks-keys/data.key" || c[2].Options != "swap,cipher=aes-xts-plain64,size=256" {
		t.Fatalf("%+v", c)
	}
}

func TestParseProcSwaps(t *testing.T) {
	s := ParseProcSwaps(read(t, "proc-swaps.txt"))
	if len(s) != 2 || s[0].Priority != "-2" || s[0].SizeKiB != 8388604 || s[1].Filename != "/swap/swap file" || s[1].Type != "file" {
		t.Fatalf("%+v", s)
	}
}

func TestParseOSRelease(t *testing.T) {
	o := ParseOSRelease(read(t, "os-release.txt"))
	if o["ID"] != "debian" || o["VERSION_ID"] != "12" || o["PRETTY_NAME"] != "Debian GNU/Linux 12 (bookworm)" || o["ID_LIKE"] != "rhel fedora" {
		t.Fatalf("%v", o)
	}
}

func TestParseLVMFullReport(t *testing.T) {
	r, err := ParseLVMFullReport(read(t, "lvm-fullreport.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.VGs) != 1 || r.VGs[0]["vg_name"] != "vg0" || r.VGs[0].Int("vg_free") != 48318382080 {
		t.Fatalf("%+v", r.VGs)
	}
	if len(r.PVs) != 1 || len(r.LVs) != 3 || len(r.Segs) != 2 {
		t.Fatalf("%d %d %d", len(r.PVs), len(r.LVs), len(r.Segs))
	}
	if p, ok := r.LVs[1].Float("data_percent"); !ok || p != 50.12 {
		t.Fatalf("%v", p)
	}
	if _, ok := r.LVs[0].Float("data_percent"); ok {
		t.Fatal("empty percent parsed")
	}
	if _, err := ParseLVMFullReport([]byte(`{}`)); err == nil {
		t.Fatal("empty accepted")
	}
}

func TestParseBtrfsSubvolumeList(t *testing.T) {
	s, err := ParseBtrfsSubvolumeList(read(t, "btrfs-subvolumes.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if len(s) != 4 {
		t.Fatalf("%d", len(s))
	}
	if s[2].ID != 258 || s[2].Parent != 256 || s[2].TopLevel != 256 || s[2].Path != "root/var/lib/machines" || s[2].ParentUUID != "" {
		t.Fatalf("%+v", s[2])
	}
	if s[3].ParentUUID != "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f" || s[3].Path != "root/.snapshots/1/snapshot with space" {
		t.Fatalf("%+v", s[3])
	}
}

func TestParseBtrfsUsageRaw(t *testing.T) {
	u, err := ParseBtrfsUsageRaw(read(t, "btrfs-usage.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if u.DeviceSize != 107374182400 || u.FreeEstimated != 92341796864 || u.DataProfile != "single" || u.MetadataProfile != "dup" || u.SystemProfile != "dup" || u.Used != 12884901888 {
		t.Fatalf("%+v", u)
	}
	if _, err := ParseBtrfsUsageRaw([]byte("nothing")); err == nil {
		t.Fatal("accepted")
	}
}

func TestUnescape(t *testing.T) {
	for in, want := range map[string]string{`a\040b`: "a b", `a\134b`: `a\b`, `a\04`: `a\04`, `\011x`: "\tx", "plain": "plain"} {
		if got := Unescape(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}
