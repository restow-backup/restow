package recovery

import (
	"encoding/binary"
	"testing"
)

// runBPF is a small classic BPF interpreter for the seccomp programs
// (loads of 32-bit words from struct seccomp_data, jumps, returns).
func runBPF(t *testing.T, prog []SockFilter, nr int, arch uint32, arg0 uint64) uint32 {
	t.Helper()
	data := make([]byte, 64)
	binary.LittleEndian.PutUint32(data[0:], uint32(int32(nr)))
	binary.LittleEndian.PutUint32(data[4:], arch)
	binary.LittleEndian.PutUint64(data[16:], arg0)
	var acc uint32
	for pc := 0; pc < len(prog); pc++ {
		ins := prog[pc]
		switch ins.Code {
		case bpfLdWAbs:
			acc = binary.LittleEndian.Uint32(data[ins.K:])
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
			"bpf", "perf_event_open", "unshare", "setns", "chroot", "open_by_handle_at", "name_to_handle_at", "kexec_load", "reboot", "open_tree", "move_mount", "fsopen"} {
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
	env := IsolatedEnv(nil)
	if len(env) != 3 || env[2] != "SYSTEMD_OFFLINE=1" {
		t.Errorf("env %v", env)
	}
}
