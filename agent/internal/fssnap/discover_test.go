package fssnap

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

func discoverTree(t *testing.T) baremetal.Host {
	t.Helper()
	root := filepath.Join(t.TempDir(), "root")
	files := map[string]string{
		"proc/self/mountinfo": "22 1 253:1 / / rw,relatime shared:1 - ext4 /dev/mapper/vg0-root rw\n" +
			"23 22 0:21 / /proc rw,relatime - proc proc rw\n" +
			"30 22 259:2 / /boot rw,relatime - ext4 /dev/nvme0n1p2 rw\n" +
			"31 30 259:1 / /boot/efi rw,relatime - vfat /dev/nvme0n1p1 rw\n" +
			"32 22 253:3 / /home rw,relatime - xfs /dev/mapper/vg0-home rw\n" +
			"33 22 253:5 / /secret rw,relatime - ext4 /dev/mapper/secret rw\n" +
			"34 22 9:0 / /srv rw,relatime - ext4 /dev/md0 rw\n" +
			"40 22 0:45 /@data /data rw,relatime - btrfs /dev/sdb1 rw,subvolid=257,subvol=/@data\n",
		"etc/fstab":                         "/dev/mapper/vg0-root / ext4 defaults 0 1\nUUID=AAAA-BBBB /mnt/esp2 vfat noauto 0 0\nnas:/x /mnt/nas nfs noauto 0 0\n",
		"sys/dev/block/253:1/dm/name":       "vg0-root\n",
		"sys/dev/block/253:1/dm/uuid":       "LVM-abcdef\n",
		"sys/dev/block/253:3/dm/name":       "vg0-home\n",
		"sys/dev/block/253:3/dm/uuid":       "LVM-abcdeg\n",
		"sys/dev/block/253:5/dm/name":       "secret\n",
		"sys/dev/block/253:5/dm/uuid":       "CRYPT-LUKS2-1234-secret\n",
		"sys/dev/block/253:5/slaves/dm-4/x": "",
		"sys/block/dm-4/dm/uuid":            "LVM-abcdeh\n",
		"sys/dev/block/259:2/partition":     "2\n",
		"sys/dev/block/259:1/partition":     "1\n",
		"sys/dev/block/9:0/md/level":        "raid1\n",
		"sys/fs/btrfs/f5/devices/sdb1":      "",
	}
	for p, c := range files {
		// Names as a fixture tree stores them (sysfs has names with a colon).
		full := baremetal.FixturePath(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return baremetal.DirHost{Root: root}
}

func TestDiscover(t *testing.T) {
	h := discoverTree(t)
	f := cmdrun.NewFake(t)
	f.Add(append([]string{"lvs"}, lvsArgs...), `{"report":[{"lv":[
		{"vg_name":"vg0","lv_name":"root","lv_attr":"-wi-ao----","lv_size":"53687091200","pool_lv":"","data_percent":"","metadata_percent":"","lv_kernel_major":"253","lv_kernel_minor":"1"},
		{"vg_name":"vg0","lv_name":"home","lv_attr":"Vwi-aotz--","lv_size":"107374182400","pool_lv":"pool","data_percent":"20.00","metadata_percent":"","lv_kernel_major":"253","lv_kernel_minor":"3"},
		{"vg_name":"vg0","lv_name":"pool","lv_attr":"twi-aotz--","lv_size":"214748364800","pool_lv":"","data_percent":"40.00","metadata_percent":"10.00","lv_kernel_major":"-1","lv_kernel_minor":"-1"}]}]}`, 0)
	f.Add(append([]string{"vgs"}, vgsArgs...), `{"report":[{"vg":[{"vg_name":"vg0","vg_size":"500000000000","vg_free":"21474836480","vg_extent_size":"4194304"}]}]}`, 0)
	f.Add([]string{"btrfs", "filesystem", "usage", "--raw", "/data"}, "Overall:\n    Device size:\t\t1000000000000\n    Free (estimated):\t\t500000000000\t(min: 1)\n", 0)
	f.Add([]string{"btrfs", "subvolume", "list", "-a", "/data"}, "ID 257 gen 1 top level 5 path <FS_TREE>/@data\nID 258 gen 1 top level 257 path <FS_TREE>/@data/vm\n", 0)
	facts, err := Discover(context.Background(), f, h, []string{"/", "/boot", "/boot/efi", "/home", "/secret", "/srv", "/data", "/data/vm", "/data/vm/x", "/mnt/esp2", "/etc"}, true)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Source{}
	for _, s := range facts.Sources {
		by[s.Path] = s
	}
	check := func(p string, ok bool) {
		t.Helper()
		if !ok {
			t.Errorf("%s: %+v", p, by[p])
		}
	}
	check("/", by["/"].Kind == "lv" && by["/"].VG == "vg0" && by["/"].LV == "root" && !by["/"].Thin)
	check("/boot", by["/boot"].Kind == "partition")
	check("/boot/efi", by["/boot/efi"].FSType == "vfat")
	check("/home", by["/home"].Thin && by["/home"].Pool == "pool")
	check("/secret", by["/secret"].LUKSOnLV)
	check("/srv", by["/srv"].Kind == "md")
	check("/data", by["/data"].BtrfsUUID == "f5" && by["/data"].SubvolID == 257 && by["/data"].SubvolTarget == "/data")
	check("/data/vm", by["/data/vm"].SubvolID == 258 && by["/data/vm"].SubvolPath == "@data/vm" && by["/data/vm"].SubvolTarget == "/data/vm")
	check("/data/vm/x", by["/data/vm/x"].SubvolID == 258)
	check("/mnt/esp2", by["/mnt/esp2"].Noauto && by["/mnt/esp2"].Device == "/dev/disk/by-uuid/AAAA-BBBB")
	check("/etc", by["/etc"].MountTarget == "/" && by["/etc"].Kind == "lv")
	if facts.Root.MountTarget != "/" || facts.VGs["vg0"].FreeBytes != 21474836480 || facts.Pools["vg0/pool"].DataPercent != 40 {
		t.Fatalf("%+v", facts)
	}
	plan := MakePlan(facts, "auto")
	reasons := map[string]string{}
	for _, s := range plan.Sources {
		reasons[s.Path] = string(s.Method) + "/" + s.LiveReason
	}
	for p, want := range map[string]string{"/": "lvm/", "/home": "lvm/", "/secret": "live/luks_on_lv", "/srv": "live/md", "/boot": "live/partition",
		"/boot/efi": "live/vfat", "/data": "btrfs/", "/mnt/esp2": "live/vfat"} {
		if reasons[p] != want {
			t.Errorf("%s: %s, want %s", p, reasons[p], want)
		}
	}
	if plan.Method != "mixed" {
		t.Fatal(plan.Method)
	}
	// Without LVM tools.
	f2 := cmdrun.NewFake(t)
	f2.AllowMissing = true
	facts, _ = Discover(context.Background(), f2, h, []string{"/"}, false)
	if facts.Unavailable == "" || MakePlan(facts, "auto").Unavailable == "" {
		t.Fatalf("%+v", facts)
	}
}

// TestTreeMountsNested backs up "/" without wholeMachine: restic runs
// without -x, so every mount and btrfs subvolume below "/" must be in the
// snapshot tree (snapshotted or bound live), not just the root.
func TestTreeMountsNested(t *testing.T) {
	h := discoverTree(t)
	root := h.(baremetal.DirHost).Root
	mi, err := os.ReadFile(filepath.Join(root, "proc/self/mountinfo"))
	if err != nil {
		t.Fatal(err)
	}
	mi = append(mi, []byte("50 22 0:50 / /tmp rw,nosuid - tmpfs tmpfs rw\n"+
		"51 22 0:51 / /net rw - autofs systemd-1 rw\n"+
		"52 51 0:52 / /net/host rw - nfs4 host:/x rw\n"+
		"53 22 0:53 / /mnt/nas rw - autofs systemd-1 rw\n"+
		"54 53 0:54 / /mnt/nas rw - nfs4 nas:/x rw\n"+
		"55 23 0:55 / /proc/sys/fs/binfmt_misc rw - binfmt_misc binfmt_misc rw\n"+
		"56 22 0:56 / /run rw - tmpfs tmpfs rw\n"+
		"57 56 0:57 / /run/user/1000 rw - tmpfs tmpfs rw\n")...)
	if err := os.WriteFile(filepath.Join(root, "proc/self/mountinfo"), mi, 0o644); err != nil {
		t.Fatal(err)
	}
	f := cmdrun.NewFake(t)
	f.Add(append([]string{"lvs"}, lvsArgs...), `{"report":[{"lv":[
		{"vg_name":"vg0","lv_name":"root","lv_attr":"-wi-ao----","lv_size":"53687091200","pool_lv":"","data_percent":"","metadata_percent":"","lv_kernel_major":"253","lv_kernel_minor":"1"},
		{"vg_name":"vg0","lv_name":"home","lv_attr":"-wi-ao----","lv_size":"107374182400","pool_lv":"","data_percent":"","metadata_percent":"","lv_kernel_major":"253","lv_kernel_minor":"3"}]}]}`, 0)
	f.Add(append([]string{"vgs"}, vgsArgs...), `{"report":[{"vg":[{"vg_name":"vg0","vg_size":"500000000000","vg_free":"107374182400","vg_extent_size":"4194304"}]}]}`, 0)
	f.Add([]string{"btrfs", "filesystem", "usage", "--raw", "/data"}, "Overall:\n    Device size:\t\t1000000000000\n    Free (estimated):\t\t500000000000\t(min: 1)\n", 0)
	f.Add([]string{"btrfs", "subvolume", "list", "-a", "/data"}, "ID 257 gen 1 top level 5 path <FS_TREE>/@data\n"+
		"ID 258 gen 1 top level 257 path <FS_TREE>/@data/vm\nID 259 gen 1 top level 258 path <FS_TREE>/@data/vm/disks\n"+
		"ID 260 gen 1 top level 257 path <FS_TREE>/@data/.snapshots\nID 261 gen 1 top level 260 path <FS_TREE>/@data/.snapshots/1/snapshot\n", 0)
	facts, err := Discover(context.Background(), f, h, []string{"/"}, false)
	if err != nil {
		t.Fatal(err)
	}
	plan := MakePlan(facts, "auto")
	f.Add(LVCreateThick("vg0", "root", 5*GiB), "", 0)
	f.Add(LVCreateThick("vg0", "home", 10*GiB), "", 0)
	var lines []string
	created, out := Create(context.Background(), f, &fakeHelper{lines: &lines}, plan, "run-1")
	mounts := TreeMounts(plan, facts, created, TreeOptions{RunID: "run-1"})
	b, _ := json.MarshalIndent(mounts, "", "  ")
	checkGolden(t, "nested-root.mounts.json", append(b, '\n'))

	targets := map[string]Mount{}
	for _, m := range mounts[1:] { // [0] is the tmpfs below the root
		if _, dup := targets[m.Target]; dup {
			t.Errorf("%s mounted twice", m.Target)
		}
		targets[m.Target] = m
	}
	at := func(p string) string { return SnapTreeDir + p }
	for p, want := range map[string]string{
		"/boot": "bind:/boot", "/boot/efi": "bind:/boot/efi", "/home": "/dev/vg0/home_restowsnap", "/secret": "bind:/secret", "/srv": "bind:/srv",
		"/data": "/dev/sdb1", "/data/vm": "/dev/sdb1", "/data/vm/disks": "/dev/sdb1", "/data/.snapshots": "bind:/data/.snapshots",
		"/tmp": "bind:/tmp", "/mnt/nas": "bind:/mnt/nas",
	} {
		m, ok := targets[at(p)]
		got := m.Source
		if m.Bind {
			got = "bind:" + m.Source
		}
		if !ok || got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
	if m := targets[at("/data/vm")]; m.Options != "ro,subvol=.restow-snapshots/run-1/258" {
		t.Errorf("/data/vm: %+v", m)
	}
	for _, p := range []string{"/net/host", "/data/.snapshots/1/snapshot", "/proc/sys/fs/binfmt_misc", "/run/user/1000"} {
		if _, ok := targets[at(p)]; ok {
			t.Errorf("%s must not be in the tree", p)
		}
	}
	if len(facts.Notes) != 1 || !strings.Contains(facts.Notes[0], "/net/host") {
		t.Errorf("notes %v", facts.Notes)
	}
	if strings.Join(out.Snapshotted, ",") != "/,/data,/data/vm,/data/vm/disks,/home" {
		t.Errorf("snapshotted %v", out.Snapshotted)
	}
	if strings.Join(out.Live, ",") != "/boot,/boot/efi,/data/.snapshots,/mnt/nas,/secret,/srv,/tmp" {
		t.Errorf("live %v", out.Live)
	}
	for _, s := range facts.Sources[1:] {
		if !s.Nested {
			t.Errorf("%s not marked nested", s.Path)
		}
	}
	// With wholeMachine the sources are the mount points themselves: nothing
	// is added.
	f2 := cmdrun.NewFake(t)
	f2.AllowMissing = true
	whole, _ := Discover(context.Background(), f2, h, []string{"/"}, true)
	if len(whole.Sources) != 1 {
		t.Fatalf("%+v", whole.Sources)
	}
}

// TestTreeMountsSubvolBelowMount: a source in a btrfs subvolume below the
// mount point of its file system gets that mount in the tree first.
func TestTreeMountsSubvolBelowMount(t *testing.T) {
	h := discoverTree(t)
	f := cmdrun.NewFake(t)
	f.Add([]string{"btrfs", "filesystem", "usage", "--raw", "/data"}, "Overall:\n    Device size:\t\t1000000000000\n    Free (estimated):\t\t500000000000\t(min: 1)\n", 0)
	f.Add([]string{"btrfs", "subvolume", "list", "-a", "/data"}, "ID 257 gen 1 top level 5 path <FS_TREE>/@data\nID 258 gen 1 top level 257 path <FS_TREE>/@data/vm\n", 0)
	f.AllowMissing = true
	facts, _ := Discover(context.Background(), f, h, []string{"/data/vm/x"}, false)
	plan := MakePlan(facts, "auto")
	created, _ := Create(context.Background(), f, &fakeHelper{lines: &[]string{}}, plan, "run-1")
	var order []string
	for _, m := range TreeMounts(plan, facts, created, TreeOptions{}) {
		order = append(order, strings.TrimPrefix(m.Target, SnapTreeDir))
	}
	got := " " + strings.Join(order, " ") + " "
	i, j := strings.Index(got, " /data "), strings.Index(got, " /data/vm ")
	if i < 0 || j < i {
		t.Fatalf("%s", got)
	}
}
