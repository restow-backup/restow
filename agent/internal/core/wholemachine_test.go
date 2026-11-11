package core

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/fssnap"
	"github.com/restow-backup/restow/agent/internal/paths"
)

func loadCaptured(t *testing.T, name string) *baremetal.Manifest {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "baremetal", "testdata", "capture", name, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := baremetal.Decode(bytes.TrimRight(b, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestWholeMachineSources(t *testing.T) {
	cases := map[string]struct {
		want, not []string
		excl      []string
	}{
		"debian12-uefi-luks-lvm":      {want: []string{"/", "/boot", "/boot/efi", "/home"}},
		"fedora-btrfs-nested-zstd":    {want: []string{"/", "/boot", "/boot/efi", "/home", "/var/lib/machines", "/var/lib/portables", "/home/anna/vm-images"}},
		"opensuse-snapper-root-quota": {want: []string{"/", "/home", "/opt", "/var", "/root", "/.snapshots/2/info.xml"}, not: []string{"/.snapshots"}, excl: []string{"/.snapshots"}},
		"esp-noauto":                  {want: []string{"/", "/boot/efi"}},
		"esp-automount":               {want: []string{"/", "/efi"}},
		"ubuntu2204-bios-mdadm":       {want: []string{"/"}, excl: []string{"/swap.img"}},
		"swapfile-btrfs":              {want: []string{"/", "/swap", "/boot/efi"}, excl: []string{"/swap/swapfile"}},
		"btrfs-raid1-multi":           {want: []string{"/", "/boot/efi", "/srv/pool", "/srv/pool/photos", "/srv/pool/backup"}},
		"pve-raw-lvs":                 {want: []string{"/", "/boot/efi"}, not: []string{"/proc"}},
		"dual-boot-windows":           {want: []string{"/", "/boot/efi"}},
		"ubuntu-zfs":                  {want: []string{"/boot/efi"}, not: []string{"/", "/boot"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			m := loadCaptured(t, name)
			src, _ := wholeMachineSources(m)
			set := map[string]bool{}
			for _, s := range src {
				set[s] = true
			}
			for _, w := range c.want {
				if !set[w] {
					t.Errorf("missing %s in %v", w, src)
				}
			}
			for _, n := range c.not {
				if set[n] {
					t.Errorf("%s must not be a source: %v", n, src)
				}
			}
			ex := strings.Join(wholeMachineExcludes(m), ",")
			for _, e := range c.excl {
				if !strings.Contains(ex, e) {
					t.Errorf("exclude %s missing: %s", e, ex)
				}
			}
			for i := 1; i < len(src); i++ {
				if src[i-1] >= src[i] {
					t.Fatalf("not sorted and unique: %v", src)
				}
			}
		})
	}
	// Docker with the btrfs storage driver: every image subvolume is a source.
	src, _ := wholeMachineSources(loadCaptured(t, "docker-btrfs-many"))
	n := 0
	for _, s := range src {
		if strings.HasPrefix(s, "/var/lib/docker/btrfs/subvolumes/") {
			n++
		}
	}
	if n != 205 {
		t.Fatalf("%d image subvolumes", n)
	}
	// A removable disk outside fstab and the boot path is left out.
	m := loadCaptured(t, "nvme-two-ns")
	m.Linux.Disks[1].Removable = true
	src, notes := wholeMachineSources(m)
	if strings.Contains(strings.Join(src, ","), "/srv") && !strings.Contains(m.Linux.Fstab[len(m.Linux.Fstab)-1].Target, "/srv") {
		t.Fatalf("%v", src)
	}
	m.Linux.Fstab = m.Linux.Fstab[:len(m.Linux.Fstab)-1]
	src, notes = wholeMachineSources(m)
	if strings.Contains(strings.Join(src, ","), "/srv") || len(notes) != 1 {
		t.Fatalf("removable /srv: %v %v", src, notes)
	}
	// A system on a USB disk is backed up in full (boot path).
	m = loadCaptured(t, "ubuntu2404-default")
	tr := "usb"
	m.Linux.Disks[0].Transport = &tr
	if src, _ := wholeMachineSources(m); !strings.Contains(strings.Join(src, ","), "/boot/efi") {
		t.Fatalf("%v", src)
	}
}

func TestMountinfoSources(t *testing.T) {
	mi := "22 1 253:1 / / rw - ext4 /dev/mapper/vg-root rw\n23 22 0:21 / /proc rw - proc proc rw\n" +
		"30 22 259:2 / /boot rw - ext4 /dev/nvme0n1p2 rw\n31 22 259:2 /srv /mnt/bind rw - ext4 /dev/nvme0n1p2 rw\n" +
		"40 22 0:45 /@home /home rw - btrfs /dev/sdb1 rw,subvolid=257\n41 22 0:46 / /mnt/nfs rw - nfs4 nas:/x rw\n"
	if got := strings.Join(mountinfoSources([]byte(mi)), ","); got != "/,/boot,/home,/mnt/bind" {
		t.Fatal(got)
	}
}

func TestAgentExcludes(t *testing.T) {
	linux := paths.Layout{StateDir: "/etc/restow-agent", DataDir: "/var/lib/restow-agent", LogDir: "/var/log/restow-agent"}
	ex := strings.Join(agentExcludes(linux, "linux", nil), "\n")
	for _, want := range []string{"/etc/restow-agent/state.json", "/etc/restow-agent/.state-*.tmp", "/etc/restow-pve/state.json",
		"/etc/restow-pve/.state.json.*", "/var/lib/restow-agent/cache", "/var/lib/restow-agent/tmp", "Restow-Restore-*"} {
		if !strings.Contains(ex+"\n", want+"\n") {
			t.Errorf("linux: %s missing:\n%s", want, ex)
		}
	}
	fl := ParseFirmlinks(mustRead(t, "testdata/firmlinks/macos-15"))
	ex = strings.Join(agentExcludes(linux, "darwin", fl), "\n")
	for _, want := range []string{"/etc/restow-agent/state.json", "/private/etc/restow-agent/state.json", "/System/Volumes/Data/private/etc/restow-agent/state.json",
		"/private/etc/restow-agent/.state-*.tmp", "/System/Volumes/Data/private/var/lib/restow-agent/cache"} {
		if !strings.Contains(ex+"\n", want+"\n") {
			t.Errorf("darwin: %s missing:\n%s", want, ex)
		}
	}
	if strings.Contains(ex, "restow-pve") {
		t.Error("darwin has no restow-pve")
	}
	win := paths.Layout{StateDir: `C:\ProgramData\Restow\state`, DataDir: `C:\ProgramData\Restow\data`, LogDir: `C:\ProgramData\Restow\logs`}
	ex = strings.Join(agentExcludes(win, "windows", nil), "\n")
	// Each list has the separators of its target, whatever system the test
	// runs on (the Windows CI job runs the Linux and macOS lists as well).
	for _, want := range []string{`C:\ProgramData\Restow\state\state.json`, `C:\ProgramData\Restow\state\.state-*.tmp`,
		`C:\ProgramData\Restow\data\cache`, `C:\ProgramData\Restow\data\tmp`} {
		if !strings.Contains(ex+"\n", want+"\n") {
			t.Errorf("windows: %s missing:\n%s", want, ex)
		}
	}
	if strings.Contains(ex, "/") {
		t.Errorf("windows: a forward slash in the excludes:\n%s", ex)
	}
	for _, goos := range []string{"linux", "darwin"} {
		if ex := strings.Join(agentExcludes(linux, goos, fl), "\n"); strings.Contains(ex, `\`) {
			t.Errorf("%s: a backslash in the excludes:\n%s", goos, ex)
		}
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestExpandDarwinExcludes(t *testing.T) {
	for _, v := range []string{"14", "15", "26"} {
		fl := ParseFirmlinks(mustRead(t, "testdata/firmlinks/macos-"+v))
		if len(fl) < 15 {
			t.Fatalf("macos-%s: %d firmlinks", v, len(fl))
		}
		got := expandDarwinExcludes([]string{"/etc/x", "/private/var/y", "/Users/anna/Library/Caches", "*.tmp", "/tmp/z"}, fl, "")
		want := []string{"/etc/x", "/private/etc/x", "/System/Volumes/Data/private/etc/x",
			"/private/var/y", "/var/y", "/System/Volumes/Data/private/var/y",
			"/Users/anna/Library/Caches", "/System/Volumes/Data/Users/anna/Library/Caches",
			"*.tmp", "/tmp/z", "/private/tmp/z", "/System/Volumes/Data/private/tmp/z"}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("macos-%s:\n got %q\nwant %q", v, got, want)
		}
		snap := expandDarwinExcludes([]string{"/Users/anna/x"}, fl, "/private/var/run/restow-agent/apfs")
		if snap[len(snap)-1] != "/private/var/run/restow-agent/apfs/Users/anna/x" {
			t.Fatalf("%q", snap)
		}
	}
}

func TestConsistencyOfFS(t *testing.T) {
	plan := fssnap.Plan{Requested: true, Method: "lvm", Sources: []fssnap.PlannedSource{
		{Source: fssnap.Source{Path: "/"}, Method: fssnap.MethodLVM}, {Source: fssnap.Source{Path: "/home"}, Method: fssnap.MethodLVM},
		{Source: fssnap.Source{Path: "/boot"}, Method: fssnap.MethodLive, LiveReason: "partition"}}}
	cases := []struct {
		name  string
		plan  fssnap.Plan
		out   fssnap.Outcome
		state string
		live  string
	}{
		{"all held", plan, fssnap.Outcome{Snapshotted: []string{"/", "/home"}, Live: []string{"/boot"}}, api.ConsistencyUsed, "/boot"},
		{"one failed", plan, fssnap.Outcome{Snapshotted: []string{"/"}, Failed: []fssnap.Failure{{Path: "/home"}}, Live: []string{"/boot"}}, api.ConsistencyPartial, "/boot,/home"},
		{"no method only", fssnap.Plan{Requested: true}, fssnap.Outcome{Live: []string{"/", "/boot"}}, api.ConsistencyUnavailable, "/,/boot"},
		{"all failed", plan, fssnap.Outcome{Failed: []fssnap.Failure{{Path: "/"}, {Path: "/home"}}, Live: []string{"/boot"}}, api.ConsistencyUnavailable, "/,/boot,/home"},
		{"tools missing", plan, fssnap.Outcome{Unavailable: "lvm2 missing", Live: []string{"/", "/home", "/boot"}}, api.ConsistencyUnavailable, ""},
		{"off", fssnap.Plan{}, fssnap.Outcome{Live: []string{"/"}}, api.ConsistencyOff, ""},
		{"mixed", fssnap.Plan{Requested: true, Method: "mixed"}, fssnap.Outcome{Snapshotted: []string{"/", "/srv"}}, api.ConsistencyUsed, ""},
	}
	for _, c := range cases {
		got := consistencyOfFS(c.plan, c.out)
		if got.State != c.state || strings.Join(got.LiveFilesystems, ",") != c.live {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
	if c := consistencyOfFS(cases[6].plan, cases[6].out); c.Method != "mixed" {
		t.Fatal(c)
	}
	e := fsSnapshotFailedErrors(plan, []fssnap.Failure{{Path: "/home", Message: "busy"}}, false)
	if len(e) != 1 || e[0].Code != "snapshot_failed" || e[0].Path != "/home" || !strings.Contains(e[0].Message, "LVM snapshot") {
		t.Fatalf("%+v", e)
	}
	u := fsSnapshotUnavailableError("btrfs", "x", true)
	if u.Code != "snapshot_unavailable" || !strings.Contains(u.Message, "btrfs snapshot") || strings.Contains(u.Message, "Volume Shadow Copy") {
		t.Fatal(u)
	}
	if snapshotLogHintFor("lvm") != "lvs, vgs, journalctl -k" || snapshotLogHintFor("vss") != snapshotLogHint || snapshotNoun("vss") != "shadow copy" {
		t.Fatal("hints")
	}
}
