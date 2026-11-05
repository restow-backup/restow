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
	bpfAndK     = 0x54 // BPF_ALU | BPF_AND | BPF_K
	bpfJeqK     = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
	bpfJgeK     = 0x35 // BPF_JMP | BPF_JGE | BPF_K
	bpfJsetK    = 0x45 // BPF_JMP | BPF_JSET | BPF_K
	bpfRetK     = 0x06 // BPF_RET | BPF_K
	seccompKill = 0x80000000
	seccompErr  = 0x00050000
	seccompOK   = 0x7fff0000
	errnoEPERM  = 1
	errnoENOSYS = 38
	// offsets in struct seccomp_data (the low 32 bits of an argument on a
	// little-endian machine; amd64 and arm64 both are)
	offNr   = 0
	offArch = 4
	offArg0 = 16
	offArg1 = 24
	// x32 system calls on amd64 have this bit set.
	x32Bit = 0x40000000
	// cloneNewMask are the CLONE_NEW* flags clone(2) accepts in its first
	// argument (NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID,
	// NEWNET; CLONE_NEWTIME is only valid for clone3 and unshare).
	cloneNewMask = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
	// firstUnknownSyscall is the first system call number the filter does
	// not know (amd64 and arm64 share the numbers from 424 on): 443 to 466
	// are known and harmless (quotactl_fd, landlock, memfd_secret,
	// process_mrelease, the futex2 calls, set_mempolicy_home_node,
	// cachestat, fchmodat2, map_shadow_stack, statmount, listmount, the LSM
	// attribute calls, mseal, the *xattrat calls); open_tree_attr (467) is
	// denied, and everything from 467 on answers ENOSYS, so a newer kernel
	// cannot add a mount-API call the filter lets through unnoticed (the C
	// library falls back as it does for clone3).
	firstUnknownSyscall = 467
)

// ioctl request numbers (_IOC: number in bits 0-7, type in bits 8-15;
// the kernel reads the request as an unsigned int).
const (
	ioctlTypeMask = 0xff00
	ioctlNrMask   = 0x00ff
	// ioctlTypeDM is device-mapper ('\xfd', /dev/mapper/control); every
	// command needs only CAP_SYS_ADMIN (dm-ioctl.c ctl_ioctl), and a table
	// names its devices as major:minor, so a reload could point a bound
	// node at any disk.
	ioctlTypeDM = 0xfd00
	// ioctlTypeNVMe is 'N' (NVMe passthrough; with CAP_SYS_ADMIN any
	// admin command on any namespace, nvme_cmd_allowed).
	ioctlTypeNVMe = 0x4e00
	// tiocsti and tioclinux push input into a terminal (TIOCSTI) or paste
	// the console selection (TIOCLINUX); a program of the target must not
	// type into the console of recover.
	tiocsti   = 0x5412
	tioclinux = 0x541c
)

// dmReadOnlyCommands are the device-mapper commands a step may send: the
// read-only ones grub-probe (libdevmapper: version, list, info, deps,
// table) and vgimportdevices need. DM_VERSION 0, DM_LIST_DEVICES 2,
// DM_DEV_STATUS 7, DM_TABLE_DEPS 11, DM_TABLE_STATUS 12 (grub reads the
// table of linear mappings), DM_LIST_VERSIONS 13, DM_GET_TARGET_VERSION
// 17. Everything else (remove all, create, remove, rename, suspend and
// resume, wait, table load and clear, target messages, geometry, poll and
// later commands) answers EPERM.
var dmReadOnlyCommands = []uint32{0, 2, 7, 11, 12, 13, 17}

// syscallTable is the architecture's audit value and the numbers the
// filter needs.
type syscallTable struct {
	audit  uint32
	x32    bool
	denied map[string]int
	clone  int
	clone3 int
	ioctl  int
}

// deniedSyscalls answer EPERM (10.14 plus R4: chroot and the file handle
// calls; plus delete_module, fspick, mount_setattr, open_tree_attr,
// swapon, swapoff and, on amd64, iopl and ioperm).
var deniedSyscalls = []string{"mount", "umount2", "pivot_root", "open_tree", "open_tree_attr", "move_mount", "fsopen", "fsmount",
	"fsconfig", "fspick", "mount_setattr", "mknod", "mknodat", "init_module", "finit_module", "delete_module", "kexec_load",
	"kexec_file_load", "reboot", "ptrace", "process_vm_readv", "process_vm_writev", "bpf", "perf_event_open", "unshare",
	"setns", "chroot", "open_by_handle_at", "name_to_handle_at", "swapon", "swapoff", "iopl", "ioperm"}

// bpfAsm builds a classic BPF program with forward jumps to labels.
type bpfAsm struct {
	prog   []SockFilter
	jumps  map[int][2]string
	labels map[string]int
}

func (a *bpfAsm) ins(code uint16, k uint32) { a.prog = append(a.prog, SockFilter{Code: code, K: k}) }

// jump is a conditional jump; an empty label is the next instruction.
func (a *bpfAsm) jump(code uint16, k uint32, jt, jf string) {
	if a.jumps == nil {
		a.jumps = map[int][2]string{}
	}
	a.jumps[len(a.prog)] = [2]string{jt, jf}
	a.ins(code, k)
}

// retIf returns ret when the accumulator equals k.
func (a *bpfAsm) retIf(k, ret uint32) {
	a.prog = append(a.prog, SockFilter{Code: bpfJeqK, Jt: 0, Jf: 1, K: k}, SockFilter{Code: bpfRetK, K: ret})
}

func (a *bpfAsm) label(name string) {
	if a.labels == nil {
		a.labels = map[string]int{}
	}
	a.labels[name] = len(a.prog)
}

func (a *bpfAsm) assemble() ([]SockFilter, error) {
	for pc, j := range a.jumps {
		for i, l := range j {
			if l == "" {
				continue
			}
			to, ok := a.labels[l]
			if !ok || to <= pc || to-pc-1 > 255 {
				return nil, fmt.Errorf("seccomp: bad jump to %s at %d", l, pc)
			}
			if i == 0 {
				a.prog[pc].Jt = uint8(to - pc - 1)
			} else {
				a.prog[pc].Jf = uint8(to - pc - 1)
			}
		}
	}
	return a.prog, nil
}

// BuildSeccomp builds the filter for arch (amd64 or arm64): a wrong
// architecture kills the process, x32 calls and the denied calls get
// EPERM, system calls newer than the table get ENOSYS, clone with any
// CLONE_NEW* flag gets EPERM, clone3 gets ENOSYS (so the C library falls
// back to clone, whose flags the filter can read), ioctl gets EPERM for
// the device-mapper commands that change mappings, for every NVMe
// passthrough command and for TIOCSTI and TIOCLINUX; everything else is
// allowed.
func BuildSeccomp(arch string) ([]SockFilter, error) {
	tab, ok := syscallTables[arch]
	if !ok {
		return nil, fmt.Errorf("seccomp: no system call table for %s", arch)
	}
	const (
		eperm  = seccompErr | errnoEPERM
		enosys = seccompErr | errnoENOSYS
	)
	a := &bpfAsm{}
	a.ins(bpfLdWAbs, offArch)
	a.jump(bpfJeqK, tab.audit, "nr", "")
	a.ins(bpfRetK, seccompKill)
	a.label("nr")
	a.ins(bpfLdWAbs, offNr)
	if tab.x32 {
		a.jump(bpfJgeK, x32Bit, "", "native")
		a.ins(bpfRetK, eperm)
		a.label("native")
	}
	var nrs []int
	for _, name := range deniedSyscalls {
		if nr, ok := tab.denied[name]; ok {
			nrs = append(nrs, nr)
		}
	}
	sort.Ints(nrs)
	for _, nr := range nrs {
		a.retIf(uint32(nr), eperm)
	}
	a.jump(bpfJgeK, firstUnknownSyscall, "", "known")
	a.ins(bpfRetK, enosys)
	a.label("known")
	a.retIf(uint32(tab.clone3), enosys)
	a.jump(bpfJeqK, uint32(tab.clone), "", "not_clone")
	a.ins(bpfLdWAbs, offArg0)
	a.jump(bpfJsetK, cloneNewMask, "", "allow")
	a.ins(bpfRetK, eperm)
	a.label("not_clone")
	a.jump(bpfJeqK, uint32(tab.ioctl), "", "allow")
	a.ins(bpfLdWAbs, offArg1)
	a.ins(bpfAndK, ioctlTypeMask)
	a.jump(bpfJeqK, ioctlTypeDM, "dm", "")
	a.retIf(ioctlTypeNVMe, eperm)
	a.ins(bpfLdWAbs, offArg1)
	a.retIf(tiocsti, eperm)
	a.retIf(tioclinux, eperm)
	a.ins(bpfRetK, seccompOK)
	a.label("dm")
	a.ins(bpfLdWAbs, offArg1)
	a.ins(bpfAndK, ioctlNrMask)
	for _, c := range dmReadOnlyCommands {
		a.jump(bpfJeqK, c, "allow", "")
	}
	a.ins(bpfRetK, eperm)
	a.label("allow")
	a.ins(bpfRetK, seccompOK)
	return a.assemble()
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
