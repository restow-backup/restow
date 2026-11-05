package recovery

import (
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Isolation of the programs of the restored system (docs/BAREMETAL.md
// 10.14): initramfs generators, grub-install, bootctl and the like come
// from a machine that may have been compromised. Each runs through the
// hidden helper restow-agent chroot-exec (isolate_linux.go) in new mount,
// PID, network, IPC and UTS namespaces, with pivot_root into the target
// (a chroot could be left with chroot("..") or open_by_handle_at, R4), a
// fresh /proc, a read-only /sys, a /dev with only the null devices and
// the target devices, a reduced capability bounding set, no new
// privileges and the seccomp filter below.

// IsolateSpec is what recover hands the helper (JSON over fd 3).
type IsolateSpec struct {
	// Root is the target root (paths.RecoveryTargetRoot).
	Root string `json:"root"`
	// Devices are device nodes (/dev/sda, /dev/sda1, /dev/mapper/x) bound
	// into the new /dev; a symlink (/dev/vg/lv) is recreated and its node
	// bound.
	Devices []string `json:"devices"`
	// DevLinks are /dev/disk/by-* links recreated in the new /dev.
	DevLinks []string `json:"devLinks"`
	// CapSysAdmin keeps CAP_SYS_ADMIN (device-mapper ioctls of grub-probe
	// on LVM or LUKS, grub2-mkconfig, vgimportdevices).
	CapSysAdmin bool `json:"capSysAdmin"`
	// Env is the environment of the program (PATH, LANG and
	// SYSTEMD_OFFLINE are always set).
	Env []string `json:"env"`
	// Argv is the program of the target system and its arguments.
	Argv []string `json:"argv"`
	// Cwd is the working directory inside the target (default /).
	Cwd string `json:"cwd"`
	// TimeoutSeconds bounds the program (0: 30 minutes).
	TimeoutSeconds int `json:"timeoutSeconds"`
}

var (
	reDevNode = regexp.MustCompile(`^/dev/[A-Za-z0-9_.:+-]+(/[A-Za-z0-9_.:+-]+)?$`)
	reDevLink = regexp.MustCompile(`^/dev/disk/by-[a-z-]+/[A-Za-z0-9_.:+\\-]+$`)
	reEnvKey  = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
)

// CheckIsolateSpec checks a spec before it is used (the helper does too).
func CheckIsolateSpec(s IsolateSpec) error {
	if !strings.HasPrefix(s.Root, "/") || s.Root == "/" || strings.Contains(s.Root, "..") {
		return fmt.Errorf("chroot-exec: invalid root %q", s.Root)
	}
	if len(s.Argv) == 0 || s.Argv[0] == "" || strings.Contains(s.Argv[0], "..") {
		return errors.New("chroot-exec: no program")
	}
	for _, d := range s.Devices {
		if !reDevNode.MatchString(d) || strings.Contains(d, "..") {
			return fmt.Errorf("chroot-exec: invalid device %q", d)
		}
	}
	for _, l := range s.DevLinks {
		if !reDevLink.MatchString(l) || strings.Contains(l, "..") {
			return fmt.Errorf("chroot-exec: invalid device link %q", l)
		}
	}
	for _, e := range s.Env {
		k, _, ok := strings.Cut(e, "=")
		if !ok || !reEnvKey.MatchString(k) {
			return fmt.Errorf("chroot-exec: invalid environment entry %q", e)
		}
	}
	if s.Cwd != "" && (!strings.HasPrefix(s.Cwd, "/") || strings.Contains(s.Cwd, "..")) {
		return fmt.Errorf("chroot-exec: invalid working directory %q", s.Cwd)
	}
	if s.TimeoutSeconds < 0 || s.TimeoutSeconds > 24*3600 {
		return errors.New("chroot-exec: invalid timeout")
	}
	return nil
}

// IsolatedEnv is the environment of the target program: only PATH, LANG,
// SYSTEMD_OFFLINE and what the step adds (GRUB_DISABLE_OS_PROBER).
func IsolatedEnv(extra []string) []string {
	env := []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "SYSTEMD_OFFLINE=1"}
	return append(env, extra...)
}

// Capabilities (linux/capability.h).
const (
	capDacReadSearch = 2
	capNetAdmin      = 12
	capSysModule     = 16
	capSysRawio      = 17
	capSysChroot     = 18
	capSysPtrace     = 19
	capSysAdmin      = 21
	capSysBoot       = 22
	capSysTime       = 25
	capMknod         = 27
	capPerfmon       = 38
	capBPF           = 39
)

// capsToDrop are the capabilities removed from the bounding set (10.14,
// plus CAP_SYS_CHROOT and CAP_DAC_READ_SEARCH for R4, CAP_SYS_PTRACE for
// R6, CAP_BPF and CAP_PERFMON); CAP_SYS_ADMIN only when the step does not
// need it.
func capsToDrop(keepSysAdmin bool) []int {
	caps := []int{capDacReadSearch, capNetAdmin, capSysModule, capSysRawio, capSysChroot, capSysPtrace, capSysBoot,
		capSysTime, capMknod, capPerfmon, capBPF}
	if !keepSysAdmin {
		caps = append(caps, capSysAdmin)
	}
	sort.Ints(caps)
	return caps
}

// SockFilter is one classic BPF instruction (struct sock_filter).
type SockFilter struct {
	Code uint16
	Jt   uint8
	Jf   uint8
	K    uint32
}

// Classic BPF and seccomp constants.
const (
	bpfLdWAbs   = 0x20 // BPF_LD | BPF_W | BPF_ABS
	bpfJeqK     = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
	bpfJgeK     = 0x35 // BPF_JMP | BPF_JGE | BPF_K
	bpfJsetK    = 0x45 // BPF_JMP | BPF_JSET | BPF_K
	bpfRetK     = 0x06 // BPF_RET | BPF_K
	seccompKill = 0x80000000
	seccompErr  = 0x00050000
	seccompOK   = 0x7fff0000
	errnoEPERM  = 1
	errnoENOSYS = 38
	// offsets in struct seccomp_data
	offNr   = 0
	offArch = 4
	offArg0 = 16
	// x32 system calls on amd64 have this bit set.
	x32Bit = 0x40000000
	// cloneNewMask are the CLONE_NEW* flags clone(2) accepts in its first
	// argument (NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID,
	// NEWNET; CLONE_NEWTIME is only valid for clone3 and unshare).
	cloneNewMask = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
)

// syscallTable is the architecture's audit value and the numbers the
// filter needs.
type syscallTable struct {
	audit  uint32
	x32    bool
	denied map[string]int
	clone  int
	clone3 int
}

// deniedSyscalls answer EPERM (10.14 plus R4: chroot and the file handle
// calls; plus delete_module, fspick, mount_setattr, swapon, swapoff and,
// on amd64, iopl and ioperm).
var deniedSyscalls = []string{"mount", "umount2", "pivot_root", "open_tree", "move_mount", "fsopen", "fsmount", "fsconfig",
	"fspick", "mount_setattr", "mknod", "mknodat", "init_module", "finit_module", "delete_module", "kexec_load",
	"kexec_file_load", "reboot", "ptrace", "process_vm_readv", "process_vm_writev", "bpf", "perf_event_open", "unshare",
	"setns", "chroot", "open_by_handle_at", "name_to_handle_at", "swapon", "swapoff", "iopl", "ioperm"}

// BuildSeccomp builds the filter for arch (amd64 or arm64): a wrong
// architecture kills the process, x32 calls and the denied calls get
// EPERM, clone with any CLONE_NEW* flag gets EPERM, clone3 gets ENOSYS
// (so the C library falls back to clone, whose flags the filter can
// read), everything else is allowed.
func BuildSeccomp(arch string) ([]SockFilter, error) {
	tab, ok := syscallTables[arch]
	if !ok {
		return nil, fmt.Errorf("seccomp: no system call table for %s", arch)
	}
	p := []SockFilter{
		{Code: bpfLdWAbs, K: offArch},
		{Code: bpfJeqK, Jt: 1, Jf: 0, K: tab.audit},
		{Code: bpfRetK, K: seccompKill},
		{Code: bpfLdWAbs, K: offNr},
	}
	if tab.x32 {
		p = append(p, SockFilter{Code: bpfJgeK, Jt: 0, Jf: 1, K: x32Bit}, SockFilter{Code: bpfRetK, K: seccompErr | errnoEPERM})
	}
	var nrs []int
	for _, name := range deniedSyscalls {
		if nr, ok := tab.denied[name]; ok {
			nrs = append(nrs, nr)
		}
	}
	sort.Ints(nrs)
	for _, nr := range nrs {
		p = append(p, SockFilter{Code: bpfJeqK, Jt: 0, Jf: 1, K: uint32(nr)}, SockFilter{Code: bpfRetK, K: seccompErr | errnoEPERM})
	}
	p = append(p,
		SockFilter{Code: bpfJeqK, Jt: 0, Jf: 1, K: uint32(tab.clone3)},
		SockFilter{Code: bpfRetK, K: seccompErr | errnoENOSYS},
		SockFilter{Code: bpfJeqK, Jt: 0, Jf: 3, K: uint32(tab.clone)},
		SockFilter{Code: bpfLdWAbs, K: offArg0},
		SockFilter{Code: bpfJsetK, Jt: 0, Jf: 1, K: cloneNewMask},
		SockFilter{Code: bpfRetK, K: seccompErr | errnoEPERM},
		SockFilter{Code: bpfRetK, K: seccompOK},
	)
	return p, nil
}

// EncodeFilter is the program as the kernel reads it (little endian
// struct sock_filter).
func EncodeFilter(p []SockFilter) []byte {
	b := make([]byte, 0, 8*len(p))
	for _, f := range p {
		b = binary.LittleEndian.AppendUint16(b, f.Code)
		b = append(b, f.Jt, f.Jf)
		b = binary.LittleEndian.AppendUint32(b, f.K)
	}
	return b
}
