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

var ctBootConfig = map[string]string{
	"hostname": "db01", "memory": "1024", "rootfs": "local-lvm:vm-200-disk-0,size=8G",
	"net0": "name=eth0,bridge=vmbr0,ip=dhcp", "unprivileged": "1",
}

func ctBootParams() BootTestParams {
	return BootTestParams{Volname: "backup/ct/200/2030-01-01T00:00:00Z", Kind: "ct", VMID: 200, DataBytes: 2 << 30}
}

func ctNode() *fakeNode {
	f := newFakeNode()
	f.restoreConfig = map[string]string{}
	for k, v := range ctBootConfig {
		f.restoreConfig[k] = v
	}
	return f
}

// fakeProc gives the process pid the comm (and the exe, when not empty) in a fake /proc.
func fakeProc(t *testing.T, b *BootTester, pid int, comm, exe string) {
	t.Helper()
	b.ProcRoot = filepath.Join(t.TempDir(), "proc")
	dir := filepath.Join(b.ProcRoot, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if exe != "" {
		if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
			t.Fatal(err)
		}
	}
}

func TestContainerBootEvidence(t *testing.T) {
	cases := []struct {
		name            string
		prep            func(t *testing.T, f *fakeNode, b *BootTester)
		outcome, reason string
		message         string
	}{
		{"systemd running", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm, f.systemState = "systemd", "running"
		}, "green", "system_running", "systemd reports the system running"},
		{"PID 1 from the host, exec of cat fails (an OCI image)", func(t *testing.T, f *fakeNode, b *BootTester) {
			f.lxcPID, f.execBroken, f.systemState = 4242, true, "running"
			fakeProc(t, b, 4242, "init", "/usr/lib/systemd/systemd")
		}, "green", "system_running", ""},
		{"an application as PID 1, nothing inside", func(t *testing.T, f *fakeNode, b *BootTester) {
			f.lxcPID, f.execBroken = 4243, true
			fakeProc(t, b, 4243, "nginx", "")
		}, "yellow", "init_running_unverified", "(nginx)"},
		{"degraded, only network units", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm, f.systemState = "systemd", "degraded"
			f.failedUnits = []string{"networking.service", "systemd-networkd-wait-online.service", "ifup@eth0.service"}
		}, "green", "system_running", "networking.service"},
		{"degraded with a database unit", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm, f.systemState = "systemd", "degraded"
			f.failedUnits = []string{"networking.service", "mariadb.service"}
		}, "yellow", "system_degraded", "mariadb.service"},
		{"emergency mode", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm, f.systemState = "systemd", "maintenance"
		}, "red", "system_maintenance", "did not reach multi-user"},
		{"still starting at the timeout", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm, f.systemState = "systemd", "starting"
		}, "yellow", "system_starting", "(starting)"},
		{"OpenRC", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm = "init"
		}, "yellow", "init_running_unverified", "(init)"},
		{"nothing can be read", func(_ *testing.T, f *fakeNode, _ *BootTester) {}, "yellow", "init_unknown", ""},
		{"stops while booting", func(_ *testing.T, f *fakeNode, _ *BootTester) {
			f.initComm = "init"
			f.stopCTAfterStatus = 2
		}, "red", "guest_stopped", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := ctNode()
			b := newTester(t, f)
			c.prep(t, f, b)
			res, err := b.Run(context.Background(), ctBootParams())
			if err != nil || res.Outcome != c.outcome || res.Reason != c.reason || !strings.Contains(res.Message, c.message) || !res.CleanedUp {
				t.Fatalf("%+v %v", res, err)
			}
			if (res.Outcome == "green") != (res.BootSeconds != nil) {
				t.Fatalf("boot seconds %v", res.BootSeconds)
			}
		})
	}
}

func TestVMBootEvidence(t *testing.T) {
	cases := []struct {
		name            string
		prep            func(f *fakeNode)
		outcome, reason string
		message         string
	}{
		{"guest panicked", func(f *fakeNode) { f.qmpStatus = "guest-panicked" }, "red", "guest_panicked", "panicked"},
		{"internal error", func(f *fakeNode) { f.qmpStatus = "internal-error" }, "red", "guest_internal_error", ""},
		{"io error of the test storage", func(f *fakeNode) { f.qmpStatus = "io-error" }, "skipped", "storage_io_error", "boot test storage"},
		{"paused", func(f *fakeNode) { f.qmpStatus = "paused" }, "yellow", "guest_paused", ""},
		{"running, agent switched on by the test", func(f *fakeNode) { f.qmpStatus = "running" }, "yellow", "no_guest_agent", "not installed?"},
		{"running, the guest has the agent enabled", func(f *fakeNode) {
			f.qmpStatus = "running"
			f.restoreConfig["agent"] = "1,fstrim_cloned_disks=1"
		}, "yellow", "agent_not_answering", "did not answer within 5m0s: the guest probably did not finish booting"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNode()
			f.restoreConfig = parseConfigText(vmConfig)
			c.prep(f)
			b := newTester(t, f)
			res, err := b.Run(context.Background(), vmParams())
			if err != nil || res.Outcome != c.outcome || res.Reason != c.reason || !strings.Contains(res.Message, c.message) || !res.CleanedUp {
				t.Fatalf("%+v %v", res, err)
			}
			if strings.Contains(res.Message, "not installed") && c.reason != "no_guest_agent" {
				t.Fatalf("blames a missing agent: %q", res.Message)
			}
		})
	}
}

const arcstats = `13 1 0x01 123 33456 4382367188 4416730102542
name                            type data
hits                            4    123456789
c                               4    64424509440
c_min                           4    4294967296
c_max                           4    68719476736
size                            4    60129542144
`

// On ZFS the ARC gives memory back for a guest, which MemAvailable does not count.
func TestBootTestCountsTheZFSARC(t *testing.T) {
	path := filepath.Join(t.TempDir(), "arcstats")
	if err := os.WriteFile(path, []byte(arcstats), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := zfsARCReclaimable(path); got != 60129542144-4294967296 {
		t.Fatalf("reclaimable %d", got)
	}
	if got := zfsARCReclaimable(filepath.Join(t.TempDir(), "none")); got != 0 {
		t.Fatalf("without ZFS %d", got)
	}
	// 2 GiB available, 52 GiB in the ARC above c_min: a 4 GiB guest boots.
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	b := newTester(t, f)
	b.MemAvailable = func() (uint64, error) { return 2 << 30, nil }
	b.ARCReclaimable = func() uint64 { return zfsARCReclaimable(path) }
	if res, err := b.Run(context.Background(), vmParams()); err != nil || res.Outcome != "green" {
		t.Fatalf("%+v %v", res, err)
	}
	// Too little even with the ARC: the skip names it.
	f = newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	b = newTester(t, f)
	b.MemAvailable = func() (uint64, error) { return 1 << 30, nil }
	b.ARCReclaimable = func() uint64 { return 2 << 30 }
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Reason != "node_memory" || !strings.Contains(res.Message, "2048 MiB of them in the ZFS ARC") {
		t.Fatalf("%+v %v", res, err)
	}
}
