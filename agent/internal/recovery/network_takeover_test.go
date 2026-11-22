package recovery

import (
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func TestTakeoverNetOf(t *testing.T) {
	n, err := ParseOneshotNetwork(json.RawMessage(`{"interfaces":[{"name":"eth0","mac":"96:00:01:02:03:04","mtu":1500,"dhcp4":true,"slaac":false,
	  "addresses":[{"address":"203.0.113.7","prefix":32,"dynamic":true},{"address":"2001:db8:1::7","prefix":64,"dynamic":false}]}],
	  "routes":[{"family":"inet","gateway":"172.31.1.1","dev":"eth0","onlink":true},{"family":"inet6","gateway":"fe80::1","dev":"eth0","onlink":false}],
	  "dns":["185.12.64.1"],"searchDomains":["."],"cloud":{"name":"hetzner","platform":"hetzner","instanceId":"1","region":"fsn1"}}`))
	if err != nil {
		t.Fatal(err)
	}
	tn := TakeoverNetOf(n)
	i := tn.Interfaces[0]
	// The DHCP address and its route come from DHCP again; IPv6 is static with fe80::1.
	if tn.Cloud != "hetzner" || len(tn.Search) != 0 || !i.DHCP4 || i.MTU != 0 || len(i.Static) != 1 || i.Static[0] != "2001:db8:1::7/64" ||
		i.Gateway4 != "" || i.Gateway6 != "fe80::1" {
		t.Fatalf("%+v %+v", tn, i)
	}
}

func TestNetworkTakeoverKeepsWhatItTakesAway(t *testing.T) {
	rf := newMemRootfs()
	rf.put("/etc/netplan/50-cloud-init.yaml", "network:\n  ethernets:\n    eth0:\n      dhcp4: true\n")
	rf.files["/etc/netplan/50-cloud-init.yaml"].mode = 0o600
	rf.put("/etc/cloud/cloud.cfg", "datasource_list: [ Ec2 ]\n")
	rf.put("/etc/udev/rules.d/70-persistent-net.rules", "SUBSYSTEM==\"net\", ATTR{address}==\"52:54:00:11:22:33\", NAME=\"eth0\"\n")
	n := &OneshotNetwork{Interfaces: []api.OneshotInterface{{Name: "eth0", MAC: "96:00:01:02:03:04", Addresses: []api.OneshotAddress{{Address: "203.0.113.7", Prefix: 32}}}},
		Routes: []api.OneshotRoute{{Family: "inet", Gateway: "172.31.1.1", Dev: "eth0", OnLink: true}}, Cloud: &api.OneshotCloud{Name: "hetzner"}}
	nt := &NetworkTakeover{Net: TakeoverNetOf(n), Takeover: true, OldMACs: []string{"52:54:00:11:22:33"}, OldNames: []string{"eth0"},
		SessionID: "rs_1", Now: time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC)}
	fx, err := nt.Apply(rf)
	if err != nil {
		t.Fatal(err)
	}
	if len(nt.Problems) != 0 {
		t.Errorf("problems %v", nt.Problems)
	}
	read := func(p string) string { b, _ := rf.ReadFile(p, 1<<20); return string(b) }
	if !strings.Contains(read("/etc/netplan/60-restow.yaml"), "203.0.113.7/32") || !strings.Contains(read("/etc/netplan/60-restow.yaml"), "rs_1") {
		t.Errorf("netplan:\n%s", read("/etc/netplan/60-restow.yaml"))
	}
	for _, gone := range []string{"/etc/netplan/50-cloud-init.yaml", "/etc/udev/rules.d/70-persistent-net.rules"} {
		if _, err := rf.Lstat(gone); err == nil {
			t.Errorf("%s stays", gone)
		}
		b := NetworkBackupDir + "/rs_1" + gone
		if read(b) == "" {
			t.Errorf("%s was not kept", b)
		}
	}
	// The backup keeps the mode; the folder is root's alone.
	if st, _ := rf.Lstat(NetworkBackupDir + "/rs_1/etc/netplan/50-cloud-init.yaml"); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
	if st, _ := rf.Lstat(NetworkBackupDir); st.Mode().Perm() != 0o700 {
		t.Errorf("folder mode %v", st.Mode())
	}
	if !strings.Contains(read(NetworkBackupDir+"/rs_1/README"), "rs_1") || !strings.Contains(read(NetworkBackupDir+"/README"), "rs_1/") || !strings.Contains(read("/etc/cloud/cloud.cfg.d/99-restow-restored.cfg"), "config: disabled") {
		t.Error("README or cloud-init drop-in")
	}
	rules := map[string]bool{}
	for _, f := range fx {
		rules[f.Rule] = true
	}
	for _, r := range []string{"network_config", "network_old_config_set_aside", "network_binding_set_aside", "cloud_init"} {
		if !rules[r] {
			t.Errorf("no change %s in %+v", r, fx)
		}
	}
}

func TestNetworkTakeoverRefusesAnUnclearStackAndChangesNothing(t *testing.T) {
	rf := newMemRootfs()
	rf.put("/etc/systemd/system/multi-user.target.wants/NetworkManager.service", "")
	rf.put("/etc/systemd/system/multi-user.target.wants/systemd-networkd.service", "")
	rf.put("/etc/systemd/network/20-wired.network", "[Network]\nDHCP=yes\n")
	rf.put("/etc/NetworkManager/system-connections/e.nmconnection", "[connection]\ntype=ethernet\n")
	nt := &NetworkTakeover{Net: TakeoverNetOf(&OneshotNetwork{Interfaces: []api.OneshotInterface{{Name: "eth0", MAC: "96:00:01:02:03:04", DHCP4: true}}}),
		Takeover: true, Now: time.Now()}
	if _, err := nt.Apply(rf); err == nil {
		t.Fatal("an unclear stack was taken over")
	}
	if _, err := rf.Lstat("/etc/systemd/network/20-wired.network"); err != nil {
		t.Error("a file was taken away")
	}
	if _, err := rf.Lstat(NetworkBackupDir); err == nil {
		t.Error("the backup folder was made")
	}
}

// What the check of the takeover finds stands under point 9; the
// verification keeps its ten checks.
func TestNetworkFindingsGoToTheMountPointsCheck(t *testing.T) {
	x := &Executor{Network: &NetworkTakeover{Problems: []string{"the address 203.0.113.7/32 stands in 0 written files, not in one"}}}
	x.report.Checks = []*Check{NewCheck(CheckFstab), NewCheck(CheckMountPoints)}
	x.networkFindings()
	if len(x.report.Checks) != 2 || x.report.Checks[1].Result != api.VerifyFailed || x.report.Checks[0].Result != api.VerifyOK {
		t.Fatalf("%+v %+v", x.report.Checks[0].RecoveryCheck, x.report.Checks[1].RecoveryCheck)
	}
	if f := x.report.Checks[1].Findings; len(f) != 1 || !strings.Contains(f[0].Message, "203.0.113.7") {
		t.Errorf("findings %+v", f)
	}
}

// failingRootfs fails the write of one path.
type failingRootfs struct {
	*memRootfs
	failOn string
}

func (f failingRootfs) WriteFileAtomic(p string, data []byte, mode fs.FileMode, uid, gid int, backup string) error {
	if p == f.failOn {
		return errors.New("disk full")
	}
	return f.memRootfs.WriteFileAtomic(p, data, mode, uid, gid, backup)
}

func debianIfupdown() *memRootfs {
	rf := newMemRootfs()
	rf.put("/etc/systemd/system/network-online.target.wants/networking.service", "")
	rf.put("/etc/network/interfaces", "auto lo\niface lo inet loopback\nallow-hotplug eth0\niface eth0 inet dhcp\n")
	rf.put("/etc/udev/rules.d/70-persistent-net.rules", "SUBSYSTEM==\"net\", ATTR{address}==\"52:54:00:11:22:33\", NAME=\"eth0\"\n")
	return rf
}

func staticTakeover(id string) *NetworkTakeover {
	n := &OneshotNetwork{Interfaces: []api.OneshotInterface{{Name: "ens3", MAC: "96:00:01:02:03:04", Addresses: []api.OneshotAddress{{Address: "203.0.113.7", Prefix: 32}}}},
		Routes: []api.OneshotRoute{{Family: "inet", Gateway: "172.31.1.1", Dev: "ens3", OnLink: true}}}
	return &NetworkTakeover{Net: TakeoverNetOf(n), Takeover: true, OldMACs: []string{"52:54:00:11:22:33"}, SessionID: id, Now: time.Now()}
}

// The takeover leaves a working configuration whatever fails: a path that
// is no plain file stops it before anything is touched; a failed write
// puts every file back.
func TestNetworkTakeoverIsAllOrNothing(t *testing.T) {
	t.Run("a link in the way", func(t *testing.T) {
		rf := debianIfupdown()
		rf.files["/etc/network/interfaces"].mode = fs.ModeSymlink | 0o777
		if _, err := staticTakeover("rs_1").Apply(rf); err == nil || !strings.Contains(err.Error(), "no plain file") {
			t.Fatalf("err %v", err)
		}
		if _, err := rf.Lstat(NetworkBackupDir); err == nil {
			t.Error("something was touched")
		}
		if _, err := rf.Lstat("/etc/udev/rules.d/70-persistent-net.rules"); err != nil {
			t.Error("the udev rule was taken away")
		}
	})
	t.Run("a write fails", func(t *testing.T) {
		rf := debianIfupdown()
		before, _ := rf.ReadFile("/etc/network/interfaces", 1<<20)
		_, err := staticTakeover("rs_1").Apply(failingRootfs{rf, "/etc/network/interfaces.d/restow"})
		if err == nil || !strings.Contains(err.Error(), "left as restored") {
			t.Fatalf("err %v", err)
		}
		if after, _ := rf.ReadFile("/etc/network/interfaces", 1<<20); string(after) != string(before) {
			t.Errorf("interfaces not put back:\n%s", after)
		}
		for _, gone := range []string{"/etc/systemd/network/10-restow-0.link", "/etc/network/interfaces.d/restow"} {
			if _, err := rf.Lstat(gone); err == nil {
				t.Errorf("%s stays", gone)
			}
		}
		if _, err := rf.Lstat("/etc/udev/rules.d/70-persistent-net.rules"); err != nil {
			t.Error("the udev rule was taken away")
		}
	})
	t.Run("the check of the written files fails", func(t *testing.T) {
		rf := newMemRootfs()
		rf.put("/etc/systemd/system/multi-user.target.wants/systemd-networkd.service", "")
		rf.put("/etc/systemd/network/20-wired.network", "[Match]\nName=en*\n[Network]\nDHCP=yes\n")
		nt := staticTakeover("rs_1")
		// The same address on two interfaces: it would stand in two files.
		nt.Net.Interfaces = append(nt.Net.Interfaces, nt.Net.Interfaces[0])
		nt.Net.Interfaces[1].MAC = "96:00:01:02:03:05"
		if _, err := nt.Apply(rf); err == nil || !strings.Contains(err.Error(), "did not pass their check") {
			t.Fatalf("err %v", err)
		}
		if b, _ := rf.ReadFile("/etc/systemd/network/20-wired.network", 1<<20); !strings.Contains(string(b), "DHCP=yes") {
			t.Error("the old file was taken away")
		}
		if _, err := rf.Lstat("/etc/systemd/network/10-restow-0.network"); err == nil {
			t.Error("a new file stays")
		}
	})
}

func TestNetworkTakeoverKeepsAnEarlierRestoresBackup(t *testing.T) {
	rf := debianIfupdown()
	if _, err := staticTakeover("rs_1").Apply(rf); err != nil {
		t.Fatal(err)
	}
	if _, err := staticTakeover("rs_2").Apply(rf); err != nil {
		t.Fatal(err)
	}
	first, _ := rf.ReadFile(NetworkBackupDir+"/rs_1/etc/network/interfaces", 1<<20)
	second, _ := rf.ReadFile(NetworkBackupDir+"/rs_2/etc/network/interfaces", 1<<20)
	if !strings.Contains(string(first), "iface eth0 inet dhcp") || !strings.Contains(string(second), "Written by Restow") {
		t.Errorf("first %q\nsecond %q", first, second)
	}
	idx, _ := rf.ReadFile(NetworkBackupDir+"/README", 1<<20)
	if !strings.Contains(string(idx), "rs_1/") || !strings.Contains(string(idx), "rs_2/") {
		t.Errorf("index:\n%s", idx)
	}
	// A recovery id that is no plain name is not used as a folder.
	if d := (&NetworkTakeover{SessionID: "../x", Now: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}).BackupDir(); d != NetworkBackupDir+"/20260102T030405Z" {
		t.Errorf("dir %s", d)
	}
}
