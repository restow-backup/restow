//go:build !windows

package pve

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// fakeBridge makes a Linux bridge with these ports in the tester's /sys/class/net.
func fakeBridge(t *testing.T, b *BootTester, bridge string, ports ...string) {
	t.Helper()
	if b.SysNet == "" {
		b.SysNet = filepath.Join(t.TempDir(), "sys-class-net")
	}
	for _, dir := range []string{filepath.Join(b.SysNet, bridge, "bridge"), filepath.Join(b.SysNet, bridge, "brif")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, port := range ports {
		if err := os.WriteFile(filepath.Join(b.SysNet, bridge, "brif", port), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// startSnapshot records the configuration of the temporary guest at the moment it starts.
func startSnapshot(f *fakeNode, b *BootTester) *map[string]string {
	seen := map[string]string{}
	b.Cmd = runnerFunc(func(ctx context.Context, name string, args ...string) (string, error) {
		if len(args) > 1 && args[0] == "start" {
			id, _ := strconv.Atoi(args[1])
			for k, v := range f.guests[id].conf {
				seen[k] = v
			}
		}
		return f.Run(ctx, name, args...)
	})
	return &seen
}

func noRestore(t *testing.T, f *fakeNode) {
	t.Helper()
	for _, c := range f.commands {
		if strings.HasPrefix(c, "restore") || strings.HasPrefix(c, "qmrestore") || strings.Contains(c, " start ") {
			t.Fatalf("restored or started: %v", f.commands)
		}
	}
}

func noStart(t *testing.T, f *fakeNode) {
	t.Helper()
	for _, c := range f.commands {
		if strings.HasPrefix(c, "qm start") || strings.HasPrefix(c, "pct start") {
			t.Fatalf("started: %v", f.commands)
		}
	}
}

// Raw QEMU arguments with a network, a host disk or a host device: never booted, and nothing
// restored (removing them might keep the copy from booting: a false red).
func TestBootTestSkipsAVMWithRawQemuArgs(t *testing.T) {
	for _, args := range []string{
		"-netdev user,id=n1 -device e1000,netdev=n1",
		"-device vfio-pci,host=0000:01:00.0",
		"-drive file=/dev/disk/by-id/ata-XYZ,if=virtio",
		"-cpu host -drive file=/dev/sdb",
		`-cpu "host"`,
	} {
		f := newFakeNode()
		f.restoreConfig = parseConfigText(vmConfig)
		f.restoreConfig["args"] = args
		f.agentAfter = 1
		b := newTester(t, f)
		res, err := b.Run(context.Background(), vmParams())
		if err != nil || res.Outcome != "skipped" || res.Reason != "custom_qemu_args" || !strings.Contains(res.Message, args) {
			t.Fatalf("%q: %+v %v", args, res, err)
		}
		noRestore(t, f)
	}
}

// Arguments that only tune the CPU, SMBIOS or the clock stay: the copy may need them to boot.
func TestBootTestKeepsHarmlessQemuArgs(t *testing.T) {
	for _, args := range []string{"-cpu host,+invtsc", "-smbios type=1,manufacturer=Dell -rtc base=localtime"} {
		if !safeQemuArgs(args) {
			t.Fatalf("%q counted unsafe", args)
		}
	}
	for _, args := range []string{"", "-device x", "-cpu host -netdev user,id=n", "-object memory-backend-file,mem-path=/dev/hugepages"} {
		if safeQemuArgs(args) {
			t.Fatalf("%q counted safe", args)
		}
	}
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.restoreConfig["args"] = "-cpu host,+invtsc"
	f.agentAfter = 1
	b := newTester(t, f)
	seen := startSnapshot(f, b)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" || (*seen)["args"] != "-cpu host,+invtsc" {
		t.Fatalf("%+v %v, config at start %v", res, err, *seen)
	}
}

// ivshmem, audio, the host's random source, hugepages and the NUMA binding go before the start.
func TestBootTestRemovesSharedMemoryHugepagesAndNUMABinding(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	for k, v := range map[string]string{
		"ivshmem":       "size=32,name=looking-glass",
		"audio0":        "device=ich9-intel-hda,driver=spice",
		"rng0":          "source=/dev/hwrng",
		"hugepages":     "1024",
		"keephugepages": "1",
		"numa":          "1",
		"numa0":         "cpus=0-1,hostnodes=1,memory=4096,policy=bind",
	} {
		f.restoreConfig[k] = v
	}
	f.agentAfter = 1
	b := newTester(t, f)
	seen := startSnapshot(f, b)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" {
		t.Fatalf("%+v %v", res, err)
	}
	for _, k := range []string{"ivshmem", "audio0", "rng0", "hugepages", "keephugepages", "numa0", "hostpci0", "usb0", "serial0", "hookscript"} {
		if v, ok := (*seen)[k]; ok {
			t.Errorf("%s still configured at the start: %q", k, v)
		}
	}
	if (*seen)["numa"] != "1" || (*seen)["memory"] != "4096" {
		t.Errorf("config at start %v", *seen)
	}
}

// A key the set did not remove: the read-back finds it, the guest is never started.
func TestBootTestReadBackFindsEveryIsolatedKey(t *testing.T) {
	for _, key := range []string{"ivshmem", "hostpci0", "hugepages", "numa0"} {
		f := newFakeNode()
		f.restoreConfig = parseConfigText(vmConfig)
		f.restoreConfig["ivshmem"] = "size=32,name=lg"
		f.restoreConfig["hugepages"] = "1024"
		f.restoreConfig["numa0"] = "cpus=0-1,hostnodes=1,memory=4096"
		f.keepKeys = map[string]bool{key: true}
		f.agentAfter = 1
		b := newTester(t, f)
		res, err := b.Run(context.Background(), vmParams())
		if err == nil || res.Outcome != "" || !strings.Contains(err.Error(), key+" is still configured") {
			t.Fatalf("%s: %+v %v", key, res, err)
		}
		noStart(t, f)
		if !res.CleanedUp || len(f.guests) != 0 {
			t.Fatalf("%s: not cleaned up %+v", key, res)
		}
	}
	b := &BootTester{}
	for _, c := range []struct{ kind, text string }{
		{"ct", "hostname: x\nlxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir\n"},
		{"ct", "hostname: x\nlxc.net.0.type: phys\n"},
		{"ct", "hostname: x\ndev0: /dev/ttyUSB0\n"},
		{"ct", "hostname: x\nmp1: /mnt/host,mp=/host\n"},
		{"ct", "hostname: x\nnet0: name=eth0,bridge=vmbr0\n"},
		{"vm", "name: x\nargs: -netdev user,id=n1\n"},
		{"vm", "name: x\nide2: local:iso/x.iso,media=cdrom\n"},
		{"vm", "name: x\nscsi1: /dev/disk/by-id/ata-XYZ,size=500G\n"},
		{"vm", "name: x\nvirtiofs0: dirid=share\n"},
	} {
		if err := b.checkIsolated(c.kind, c.text, ""); err == nil {
			t.Errorf("%s %q passed the read-back", c.kind, c.text)
		}
	}
	if err := b.checkIsolated("ct", "hostname: x\nmp0: local-lvm:vm-1-disk-1,mp=/srv\nlxc.idmap: u 0 100000 65536\n", ""); err != nil {
		t.Errorf("read-back of an isolated container: %v", err)
	}
}

// A disk on a host path that the restore kept: the copy would open the original's device.
func TestBootTestSkipsAVMWithAHostDisk(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.restoreConfig["scsi1"] = "/dev/disk/by-id/ata-WDC_WD5000-XYZ,size=500G"
	f.agentAfter = 1
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "skipped" || res.Reason != "host_disk" || !strings.Contains(res.Message, "/dev/disk/by-id/ata-WDC_WD5000-XYZ") {
		t.Fatalf("%+v %v", res, err)
	}
	noStart(t, f)
	if !res.CleanedUp || len(f.guests) != 0 {
		t.Fatalf("not cleaned up: %+v", res)
	}
}

// The isolated bridge is looked at before every test: only ports of guests.
func TestBootTestSkipsABridgeWithAnUplink(t *testing.T) {
	cases := []struct {
		name  string
		ports []string
		ok    bool
	}{
		{"guest ports only", []string{"tap101i0", "veth200i0", "fwpr300p0"}, true},
		{"empty", nil, true},
		{"a network card", []string{"eno1", "tap101i0"}, false},
		{"a bond", []string{"bond0"}, false},
		{"a VLAN", []string{"eno1.20"}, false},
		{"missing", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNode()
			f.restoreConfig = parseConfigText(vmConfig)
			f.agentAfter = 1
			b := newTester(t, f)
			b.State.BootTestBridge = "vmbr99"
			if c.name == "missing" {
				fakeBridge(t, b, "vmbr0", "eno1")
			} else {
				fakeBridge(t, b, "vmbr99", c.ports...)
			}
			res, err := b.Run(context.Background(), vmParams())
			if c.ok {
				if err != nil || res.Outcome != "green" {
					t.Fatalf("%+v %v", res, err)
				}
				return
			}
			if err != nil || res.Outcome != "skipped" || res.Reason != "bridge_not_isolated" {
				t.Fatalf("%+v %v", res, err)
			}
			noRestore(t, f)
		})
	}
}

// A start that fails for want of memory of the node is no red boot test.
func TestBootTestStartWithoutNodeMemoryIsSkipped(t *testing.T) {
	for msg, want := range map[string]string{
		"start failed: hugepage allocation failed":                                      "node_resources",
		"kvm: cannot set up guest memory 'pc.ram': Cannot allocate memory":              "node_resources",
		"start failed: QEMU exited with code 1":                                         "start_failed",
		"kvm: -drive file=/dev/zvol/rpool/vm-9001-disk-0: Could not open: No such file": "start_failed",
	} {
		f := newFakeNode()
		f.restoreConfig = parseConfigText(vmConfig)
		f.startFails, f.startErr = true, msg
		b := newTester(t, f)
		res, err := b.Run(context.Background(), vmParams())
		if err != nil || res.Reason != want || (want == "node_resources") != (res.Outcome == "skipped") || !res.CleanedUp {
			t.Fatalf("%q: %+v %v", msg, res, err)
		}
	}
}
