//go:build !windows

package pve

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// A VM with a GPU through a device mapping, a USB dongle, virtiofs and raw QEMU arguments. PVE's
// restore permission check lets only root@pam restore those (and a mapping needs Mapping.Use),
// so the node's token could neither restore, check nor boot test such a VM.
const passthroughVMConfig = `boot: order=scsi0
memory: 2048
name: plex
hostpci0: mapping=gpu,pcie=1
usb0: host=1-2
usb1: spice
virtiofs0: dirid=share
args: -cpu host,+invtsc
serial0: socket
net0: virtio=BC:24:11:00:00:09,bridge=vmbr0
scsi0: local-lvm:vm-101-disk-0,size=32G
`

func TestRootOnlyVMKeys(t *testing.T) {
	got := rootOnlyVMKeys(parseConfigText(passthroughVMConfig))
	if fmt.Sprint(got) != "[args hostpci0 usb0 virtiofs0]" {
		t.Fatalf("keys %v", got)
	}
	if got := rootOnlyVMKeys(parseConfigText(vmConfig)); fmt.Sprint(got) != "[hookscript hostpci0 serial0 usb0]" {
		t.Fatalf("keys %v", got)
	}
	if got := hostDeviceKeys([]string{"hookscript", "hostpci0"}); fmt.Sprint(got) != "[hostpci0]" {
		t.Fatalf("devices %v", got)
	}
}

func TestAVMWithPassthroughIsRestoredAsRoot(t *testing.T) {
	for _, check := range []bool{false, true} {
		f := newFakeNode()
		f.restoreConfig = parseConfigText(passthroughVMConfig)
		f.ctime = 1_900_000_300
		s := restoreService(t, f, "vm", passthroughVMConfig)
		task := restoreTaskOf(t, "vm", check)
		result, err := s.task(context.Background(), task)
		if err != nil || f.refusedRoot {
			t.Fatalf("check %v: %v %v (refused %v)", check, result, err, f.refusedRoot)
		}
		all := strings.Join(f.commands, "\n")
		if !strings.Contains(all, "qmrestore restow:backup/vm/114/2030-01-01T00:00:00Z 9001 --storage local-lvm --unique 1 --pool restow-restore") {
			t.Fatalf("check %v: commands\n%s", check, all)
		}
		if result["restoredAsRoot"] != true || !strings.Contains(fmt.Sprint(result["upid"]), ":qmrestore:9001:root@pam:") {
			t.Fatalf("check %v: result %v", check, result)
		}
		if check {
			if result["deleted"] != true || len(f.guests) != 0 || result["keptDevices"] != nil {
				t.Fatalf("result %v, guests %v", result, f.guests)
			}
			continue
		}
		if fmt.Sprint(result["keptDevices"]) != "[args hostpci0 usb0 virtiofs0]" || len(f.guests) != 1 {
			t.Fatalf("result %v", result)
		}
	}
}

// A VM without such keys is restored by the token, as before.
func TestAPlainVMIsRestoredByTheToken(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(plainVMConfig)
	s := restoreService(t, f, "vm", plainVMConfig)
	result, err := s.task(context.Background(), restoreTaskOf(t, "vm", false))
	if err != nil || result["restoredAsRoot"] != nil {
		t.Fatalf("%v %v", result, err)
	}
	all := strings.Join(f.commands, "\n")
	if strings.Contains(all, "qmrestore") || !strings.Contains(all, "restore vm 9001 restow:backup/vm/114/2030-01-01T00:00:00Z local-lvm restow-restore") {
		t.Fatalf("commands\n%s", all)
	}
}

// The boot test of such a VM: restored as root, the devices removed before the start, green.
// When its wait ends while the restore runs, root's restore task is stopped before the guest
// is removed.
func TestABootTestOfAVMWithPassthrough(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(passthroughVMConfig)
	f.agentAfter = 1
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" || !res.CleanedUp || f.refusedRoot {
		t.Fatalf("%+v %v", res, err)
	}
	for _, k := range []string{"--delete hostpci0,usb0,usb1,virtiofs0", "qm destroy 9001"} {
		if !strings.Contains(strings.Join(f.commands, "\n"), k) {
			t.Fatalf("no %q in %v", k, f.commands)
		}
	}

	f = newFakeNode()
	f.restoreConfig = parseConfigText(passthroughVMConfig)
	f.restoreRunning = true
	f.waitErr = errors.New("the PVE API did not answer for 10 min")
	b = newTester(t, f)
	res, err = b.Run(context.Background(), vmParams())
	if err == nil || res.Outcome != "" || !res.CleanedUp || len(f.guests) != 0 {
		t.Fatalf("%+v %v, guests %v", res, err, f.guests)
	}
	if len(f.stoppedTasks) != 1 || !strings.Contains(f.stoppedTasks[0], ":qmrestore:9001:root@pam:") {
		t.Fatalf("stopped %v", f.stoppedTasks)
	}
}

// A root restore that ends with warnings succeeds with them, as any restore.
func TestARootRestoreWithWarnings(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(passthroughVMConfig)
	f.restoreExit, f.taskLog = "WARNINGS: 1", "WARN: hostpci0: device 0000:01:00.0 not found on this node\nTASK WARNINGS: 1\n"
	s := restoreService(t, f, "vm", passthroughVMConfig)
	result, err := s.task(context.Background(), restoreTaskOf(t, "vm", false))
	if err != nil || fmt.Sprint(result["warnings"]) != "[WARN: hostpci0: device 0000:01:00.0 not found on this node]" {
		t.Fatalf("%v %v", result, err)
	}
}

// The outcome of a root restore whose task PVE did not list: from qmrestore's own output.
func TestCLIExit(t *testing.T) {
	cases := []struct {
		r    cliResult
		want string
	}{
		{cliResult{out: "progress 100%\nTASK OK"}, "OK"},
		{cliResult{out: "WARN: x\nTASK WARNINGS: 2\n"}, "WARNINGS: 2"},
		{cliResult{out: "error before\nTASK ERROR: unable to restore VM 9001 - no space\n", err: errors.New("exit status 255")}, "unable to restore VM 9001 - no space"},
		{cliResult{out: "done"}, "OK"},
		{cliResult{out: "boom", err: errors.New("exit status 2")}, "boom"},
	}
	for _, c := range cases {
		if got := cliExit(c.r); got != c.want {
			t.Errorf("%q: got %q, want %q", c.r.out, got, c.want)
		}
	}
}
