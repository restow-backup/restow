package recovery

import (
	"encoding/binary"
	"testing"
)

// runBPF is a small classic BPF interpreter for the seccomp programs
// (loads of 32-bit words from struct seccomp_data, jumps, returns).
func runBPF(t *testing.T, prog []SockFilter, nr int, arch uint32, args ...uint64) uint32 {
	t.Helper()
	data := make([]byte, 64)
	binary.LittleEndian.PutUint32(data[0:], uint32(int32(nr)))
	binary.LittleEndian.PutUint32(data[4:], arch)
	for i, a := range args {
		binary.LittleEndian.PutUint64(data[16+8*i:], a)
	}
	var acc uint32
	for pc := 0; pc < len(prog); pc++ {
		ins := prog[pc]
		switch ins.Code {
		case bpfLdWAbs:
			acc = binary.LittleEndian.Uint32(data[ins.K:])
		case bpfAndK:
			acc &= ins.K
		case bpfJeqK, bpfJgeK, bpfJsetK:
			var cond bool
			switch ins.Code {
			case bpfJeqK:
				cond = acc == ins.K
			case bpfJgeK:
				cond = acc >= ins.K
			default:
				cond = acc&ins.K != 0
			}
			if cond {
				pc += int(ins.Jt)
			} else {
				pc += int(ins.Jf)
			}
		case bpfRetK:
			return ins.K
		default:
			t.Fatalf("unknown instruction %#x at %d", ins.Code, pc)
		}
	}
	t.Fatal("the program ran off its end")
	return 0
}

func TestSeccompFilter(t *testing.T) {
	const (
		eperm  = seccompErr | errnoEPERM
		enosys = seccompErr | errnoENOSYS
	)
	for _, arch := range []string{"amd64", "arm64"} {
		tab := syscallTables[arch]
		prog, err := BuildSeccomp(arch)
		if err != nil {
			t.Fatal(err)
		}
		if len(prog) > 4096 {
			t.Fatalf("%s: program too long", arch)
		}
		for name, nr := range tab.denied {
			if got := runBPF(t, prog, nr, tab.audit, 0); got != eperm {
				t.Errorf("%s %s: %#x, want EPERM", arch, name, got)
			}
		}
		for _, name := range []string{"mount", "umount2", "pivot_root", "mknodat", "init_module", "finit_module", "ptrace", "process_vm_readv",
			"bpf", "perf_event_open", "unshare", "setns", "chroot", "open_by_handle_at", "name_to_handle_at", "kexec_load", "reboot", "open_tree", "open_tree_attr", "move_mount", "fsopen"} {
			if _, ok := tab.denied[name]; !ok {
				t.Errorf("%s: %s is not denied", arch, name)
			}
		}
		// Ordinary calls pass: read, write, openat, execve, wait4, ioctl.
		ordinary := map[string]map[string]int{
			"amd64": {"read": 0, "write": 1, "openat": 257, "execve": 59, "wait4": 61, "ioctl": 16, "fork": 57},
			"arm64": {"read": 63, "write": 64, "openat": 56, "execve": 221, "wait4": 260, "ioctl": 29},
		}[arch]
		for name, nr := range ordinary {
			if got := runBPF(t, prog, nr, tab.audit, 0); got != seccompOK {
				t.Errorf("%s %s: %#x, want allow", arch, name, got)
			}
		}
		// clone: a plain fork passes, any namespace flag is refused.
		if got := runBPF(t, prog, tab.clone, tab.audit, 0x01200011); got != seccompOK {
			t.Errorf("%s clone (fork flags): %#x", arch, got)
		}
		for _, flag := range []uint64{0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000} {
			if got := runBPF(t, prog, tab.clone, tab.audit, flag|0x11); got != eperm {
				t.Errorf("%s clone with %#x: %#x", arch, flag, got)
			}
		}
		if got := runBPF(t, prog, tab.clone3, tab.audit, 0); got != enosys {
			t.Errorf("%s clone3: %#x, want ENOSYS", arch, got)
		}
		// System calls newer than the table answer ENOSYS; the known ones
		// from 443 to 466 (fchmodat2, futex2, statmount, mseal, ...) pass.
		for _, nr := range []int{468, 469, 470, 500, 1000} {
			if got := runBPF(t, prog, nr, tab.audit, 0); got != enosys {
				t.Errorf("%s unknown call %d: %#x, want ENOSYS", arch, nr, got)
			}
		}
		for nr := 443; nr < firstUnknownSyscall; nr++ {
			if got := runBPF(t, prog, nr, tab.audit, 0); got != seccompOK {
				t.Errorf("%s known call %d: %#x, want allow", arch, nr, got)
			}
		}
		if got := runBPF(t, prog, 467, tab.audit, 0); got != eperm {
			t.Errorf("%s open_tree_attr: %#x, want EPERM", arch, got)
		}
		// ioctl: read-only device-mapper commands pass, the others and
		// every NVMe command answer EPERM; ordinary requests pass.
		dm := func(nr uint64) uint64 { return 0xc138fd00 | nr }
		for _, nr := range []uint64{0, 2, 7, 11, 12, 13, 17} {
			if got := runBPF(t, prog, tab.ioctl, tab.audit, 3, dm(nr)); got != seccompOK {
				t.Errorf("%s DM command %d: %#x, want allow", arch, nr, got)
			}
		}
		for _, nr := range []uint64{1, 3, 4, 5, 6, 8, 9, 10, 14, 15, 16, 18, 19, 0xff} {
			if got := runBPF(t, prog, tab.ioctl, tab.audit, 3, dm(nr)); got != eperm {
				t.Errorf("%s DM command %d: %#x, want EPERM", arch, nr, got)
			}
		}
		// The upper 32 bits of the request are ignored by the kernel.
		if got := runBPF(t, prog, tab.ioctl, tab.audit, 3, 0xffffffff00000000|dm(9)); got != eperm {
			t.Errorf("%s DM_TABLE_LOAD with high bits: %#x", arch, got)
		}
		for _, req := range []uint64{0xc0484e41, 0xc0484e43, 0x4e40, 0x4e44, 0x4e45, 0x5412, 0x541c} {
			if got := runBPF(t, prog, tab.ioctl, tab.audit, 3, req); got != eperm {
				t.Errorf("%s ioctl %#x: %#x, want EPERM", arch, req, got)
			}
		}
		for _, req := range []uint64{0x5401, 0x80081272, 0x1260, 0x5413, 0x40086602, 0x125d} {
			if got := runBPF(t, prog, tab.ioctl, tab.audit, 3, req); got != seccompOK {
				t.Errorf("%s ioctl %#x: %#x, want allow", arch, req, got)
			}
		}
		// Another architecture's calls kill the process.
		if got := runBPF(t, prog, 0, 0x40000003, 0); got != seccompKill {
			t.Errorf("%s wrong arch: %#x", arch, got)
		}
	}
	amd := syscallTables["amd64"]
	prog, _ := BuildSeccomp("amd64")
	if got := runBPF(t, prog, 0x40000000|0, amd.audit, 0); got != seccompErr|errnoEPERM {
		t.Errorf("x32 read: %#x", got)
	}
	if _, err := BuildSeccomp("riscv64"); err == nil {
		t.Error("an architecture without a table")
	}
	if b := EncodeFilter(prog); len(b) != 8*len(prog) {
		t.Error("encoding")
	}
}

func TestCapsAndSpec(t *testing.T) {
	has := func(l []int, c int) bool {
		for _, x := range l {
			if x == c {
				return true
			}
		}
		return false
	}
	for _, c := range []int{capSysModule, capSysRawio, capSysBoot, capSysPtrace, capNetAdmin, capMknod, capSysTime, capSysChroot, capDacReadSearch} {
		if !has(capsToDrop(true), c) || !has(capsToDrop(false), c) {
			t.Errorf("capability %d kept", c)
		}
	}
	if has(capsToDrop(true), capSysAdmin) || !has(capsToDrop(false), capSysAdmin) {
		t.Error("CAP_SYS_ADMIN")
	}
	ok := IsolateSpec{Root: "/mnt/restow-target", Argv: []string{"update-initramfs", "-u"}, Devices: []string{"/dev/sda", "/dev/mapper/root", "/dev/vg0/root"},
		DevLinks: []string{"/dev/disk/by-uuid/1234-ABCD"}, Env: []string{"GRUB_DISABLE_OS_PROBER=true"}}
	if err := CheckIsolateSpec(ok); err != nil {
		t.Error(err)
	}
	for _, bad := range []IsolateSpec{
		{Root: "/", Argv: []string{"x"}},
		{Root: "/mnt/../etc", Argv: []string{"x"}},
		{Root: "/mnt/t", Argv: nil},
		{Root: "/mnt/t", Argv: []string{"x"}, Devices: []string{"/dev/../etc/shadow"}},
		{Root: "/mnt/t", Argv: []string{"x"}, Devices: []string{"/etc/passwd"}},
		{Root: "/mnt/t", Argv: []string{"x"}, DevLinks: []string{"/dev/sda"}},
		{Root: "/mnt/t", Argv: []string{"x"}, Env: []string{"LD_PRELOAD"}},
	} {
		if CheckIsolateSpec(bad) == nil {
			t.Errorf("accepted: %+v", bad)
		}
	}
	// CAP_SYS_ADMIN only for the grub and LVM programs, and only with a
	// device-mapper node among the devices of the step.
	plain := []string{"/dev/sda", "/dev/sda1", "/dev/sda2"}
	stacked := []string{"/dev/dm-0", "/dev/mapper/vg-root", "/dev/sda", "/dev/sda1"}
	for _, c := range []struct {
		prog    string
		devices []string
		want    bool
	}{
		{"grub-install", plain, false},
		{"update-grub", []string{"/dev/mapper/control", "/dev/sda"}, false},
		{"grub-install", stacked, true},
		{"grub2-mkconfig", []string{"/dev/mapper/luks-1"}, true},
		{"vgimportdevices", stacked, true},
		{"update-initramfs", stacked, false},
		{"dracut", stacked, false},
	} {
		if got := needsSysAdmin(c.prog, c.devices); got != c.want {
			t.Errorf("needsSysAdmin(%s, %v) = %v", c.prog, c.devices, got)
		}
	}
	env := IsolatedEnv(nil)
	if len(env) != 3 || env[2] != "SYSTEMD_OFFLINE=1" {
		t.Errorf("env %v", env)
	}
}
