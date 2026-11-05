//go:build linux && agentroot

package recovery

// Root tests of recover (docs/BAREMETAL.md 21.2, CI job agent-root): the
// isolation of 10.14 with real namespaces, a real execution on loop
// devices with the real restic, the release of holders and the O_DIRECT
// probe. Root and RESTOW_AGENT_ROOT=1 only: they change the storage of the
// machine they run on.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/restic"
)

func rootOnly(t *testing.T) string {
	t.Helper()
	if os.Getenv("RESTOW_AGENT_ROOT") != "1" {
		t.Skip("agent-root test: set RESTOW_AGENT_ROOT=1 and run as root (CI job agent-root)")
	}
	if os.Geteuid() != 0 {
		t.Fatal("RESTOW_AGENT_ROOT=1 but not root")
	}
	work, err := os.MkdirTemp("/var/tmp", "restow-recover-root-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(work) })
	return work
}

func sh(t *testing.T, name string, args ...string) string {
	t.Helper()
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func loopDev(t *testing.T, work, name string, mib int) string {
	t.Helper()
	file := filepath.Join(work, name+".img")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(int64(mib) << 20); err != nil {
		t.Fatal(err)
	}
	f.Close()
	dev := sh(t, "losetup", "-f", "--show", file)
	t.Cleanup(func() { _ = exec.Command("losetup", "-d", dev).Run() })
	return dev
}

// goBuild builds a static binary of pkg (a path relative to this package
// or a folder with a main.go).
func goBuild(t *testing.T, out, pkg string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, pkg)
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	_, file, _, _ := runtime.Caller(0)
	cmd.Dir = filepath.Dir(file)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build %s: %v\n%s", pkg, err, b)
	}
}

const hookSource = `package main

import (
	"encoding/json"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func main() {
	res := map[string]string{}
	try := func(name string, err error) {
		if err == nil {
			res[name] = "ok"
		} else {
			res[name] = err.Error()
		}
	}
	c, err := net.DialTimeout("tcp", "1.1.1.1:53", 2*time.Second)
	if c != nil {
		c.Close()
	}
	try("net", err)
	envb, err := os.ReadFile("/proc/1/environ")
	try("environ", err)
	res["environ_len"] = strconv.Itoa(len(envb))
	_, err = os.ReadFile("/proc/1/mem")
	try("mem", err)
	ents, _ := os.ReadDir("/proc")
	var pids []string
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err == nil {
			pids = append(pids, e.Name())
		}
	}
	res["pids"] = strings.Join(pids, ",")
	res["self"] = strconv.Itoa(os.Getpid())
	f, err := os.OpenFile(os.Args[1], os.O_WRONLY, 0)
	if err == nil {
		_, err = f.Write([]byte("x"))
		f.Close()
	}
	try("otherdev", err)
	f, err = os.OpenFile(os.Args[2], os.O_WRONLY, 0)
	if err == nil {
		_, err = f.Write([]byte("ok"))
		f.Close()
	}
	try("allowed", err)
	try("mknod", syscall.Mknod("/tmp/evil", syscall.S_IFBLK|0o600, 7<<8))
	try("mount", syscall.Mount("tmpfs", "/mnt", "tmpfs", 0, ""))
	try("chroot", syscall.Chroot(".."))
	try("unshare", syscall.Unshare(syscall.CLONE_NEWNS))
	if _, _, e := syscall.Syscall(304, 3, 0, 0); e != 0 {
		try("open_by_handle_at", e)
	} else {
		try("open_by_handle_at", nil)
	}
	if _, _, e := syscall.Syscall(syscall.SYS_PTRACE, 16, 1, 0); e != 0 {
		try("ptrace", e)
	} else {
		try("ptrace", nil)
	}
	try("syswrite", os.WriteFile("/sys/kernel/mm/ksm/run", []byte("1"), 0))
	// Opened for writing only, never written: on a failed isolation the
	// test must not change the machine it runs on.
	openW := func(p string) error {
		f, err := os.OpenFile(p, os.O_WRONLY, 0)
		if err == nil {
			f.Close()
		}
		return err
	}
	try("core_pattern", openW("/proc/sys/kernel/core_pattern"))
	try("sysrq", openW("/proc/sysrq-trigger"))
	try("procirq", openW("/proc/irq/default_smp_affinity"))
	kcore := "masked"
	if st, err := os.Stat("/proc/kcore"); err == nil && st.Mode()&os.ModeDevice == 0 {
		kcore = "ok"
	}
	res["kcore"] = kcore
	_, err = os.Stat("/sys/firmware/efi/efivars/BootOrder-8be4df61-93ca-11d2-aa0d-00e098032b8c")
	try("efivars", err)
	if st, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, l := range strings.Split(string(st), "\n") {
			if strings.HasPrefix(l, "CapEff:") {
				res["capeff"] = strings.TrimSpace(strings.TrimPrefix(l, "CapEff:"))
			}
		}
	}
	errno := func(name string, e syscall.Errno) {
		if e == 0 {
			res[name] = "ok"
		} else {
			res[name] = e.Error()
		}
	}
	atFdcwd := -100
	procSys, _ := syscall.BytePtrFromString("/proc/sys")
	// open_tree(AT_FDCWD, "/proc/sys", OPEN_TREE_CLONE|AT_RECURSIVE)
	fd, _, e := syscall.Syscall(428, uintptr(atFdcwd), uintptr(unsafe.Pointer(procSys)), 1|0x8000)
	if e == 0 {
		syscall.Close(int(fd))
	}
	errno("open_tree", e)
	// open_tree_attr with attr_clr MOUNT_ATTR_RDONLY: a writable copy of
	// the read-only /proc/sys; core_pattern is then opened, never written.
	attr := [4]uint64{0, 1, 0, 0}
	fd, _, e = syscall.Syscall6(467, uintptr(atFdcwd), uintptr(unsafe.Pointer(procSys)), 1|0x8000, uintptr(unsafe.Pointer(&attr[0])), 32, 0)
	errno("open_tree_attr", e)
	if e == 0 {
		cp, _ := syscall.BytePtrFromString("kernel/core_pattern")
		w, _, e2 := syscall.Syscall6(syscall.SYS_OPENAT, fd, uintptr(unsafe.Pointer(cp)), syscall.O_WRONLY, 0, 0, 0)
		if e2 == 0 {
			syscall.Close(int(w))
		}
		errno("core_pattern_clone", e2)
		syscall.Close(int(fd))
	}
	// file_getattr (468): newer than the filter's table.
	_, _, e = syscall.Syscall6(468, ^uintptr(0), 0, 0, 0, 0, 0)
	errno("unknown_syscall", e)
	// ioctl requests on /dev/null: the filter answers before the driver
	// (EPERM); a request it lets through gets ENOTTY from /dev/null.
	null, err := os.Open("/dev/null")
	if err == nil {
		for name, req := range map[string]uintptr{"dm_version": 0xc138fd00, "dm_remove_all": 0xc138fd01, "dm_create": 0xc138fd03,
			"dm_suspend": 0xc138fd06, "dm_table_load": 0xc138fd09, "dm_target_msg": 0xc138fd0e, "nvme_admin": 0xc0484e41,
			"nvme_io": 0xc0484e43, "tiocsti": 0x5412, "md_raid_version": 0x800c0910, "md_get_array_info": 0x80480911,
			"md_get_disk_info": 0x80140912, "md_add_new_disk": 0x40140921, "md_set_array_info": 0x40480923, "md_hot_add_disk": 0x928,
			"md_set_disk_faulty": 0x929, "md_run_array": 0x400c0930, "md_stop_array": 0x932} {
			_, _, e := syscall.Syscall(syscall.SYS_IOCTL, null.Fd(), req, 0)
			errno("ioctl_"+name, e)
		}
		null.Close()
	}
	// Device nodes restored onto the target tree outside /dev (a block
	// node of the other disk, a char node, a node on a submount of the
	// root): opened for writing only, never written.
	for _, p := range []string{"/root/evil-blk", "/root/evil-chr", "/srv/evil-blk"} {
		n, err := syscall.Open(p, syscall.O_WRONLY, 0)
		if err == nil {
			syscall.Close(n)
		}
		try("node"+p, err)
	}
	for _, p := range []string{"/", "/srv"} {
		var sfs syscall.Statfs_t
		if err := syscall.Statfs(p, &sfs); err == nil {
			res["flags"+p] = strconv.FormatInt(int64(sfs.Flags), 16)
		}
	}
	// AF_VSOCK is not network-namespaced; io_uring could open sockets
	// past the filter.
	for name, family := range map[string]int{"vsock": 40, "unix": syscall.AF_UNIX, "inet": syscall.AF_INET, "netlink": syscall.AF_NETLINK} {
		typ := syscall.SOCK_STREAM
		if family == syscall.AF_NETLINK {
			typ = syscall.SOCK_RAW
		}
		s, err := syscall.Socket(family, typ, 0)
		if err == nil {
			syscall.Close(s)
		}
		try("socket_"+name, err)
	}
	var params [120]byte
	ring, _, e := syscall.Syscall(425, 1, uintptr(unsafe.Pointer(&params[0])), 0)
	if e == 0 {
		syscall.Close(int(ring))
	}
	errno("io_uring_setup", e)
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err == nil {
		tty.Close()
	}
	try("tty", err)
	res["env"] = strings.Join(os.Environ(), " ")
	b, _ := json.Marshal(res)
	_ = os.WriteFile("/result.json", b, 0o644)
}
`

// TestRootIsolation: a program of the "target" tries to leave its
// isolation (10.14, R4 to R6); every attempt must fail, and the device
// of the plan stays usable.
func TestRootIsolation(t *testing.T) {
	work := rootOnly(t)
	root := filepath.Join(work, "root")
	for _, d := range []string{"proc", "sys", "dev", "run", "tmp", "mnt", "root", "srv"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	hookDir := filepath.Join(work, "hook")
	_ = os.MkdirAll(hookDir, 0o755)
	_ = os.WriteFile(filepath.Join(hookDir, "main.go"), []byte(hookSource), 0o644)
	_ = os.WriteFile(filepath.Join(hookDir, "go.mod"), []byte("module hook\n\ngo 1.22\n"), 0o644)
	cmd := exec.Command("go", "build", "-o", filepath.Join(root, "hook"), ".")
	cmd.Dir, cmd.Env = hookDir, append(os.Environ(), "CGO_ENABLED=0", "GOFLAGS=")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build the hook: %v\n%s", err, b)
	}
	agent := filepath.Join(work, "restow-agent")
	goBuild(t, agent, "../../cmd/restow-agent")
	other := loopDev(t, work, "other", 4)
	allowed := loopDev(t, work, "allowed", 4)
	// Device nodes as restic restores them from a snapshot, outside /dev:
	// a block node of the other disk and a char node (1:3) on the root,
	// and one on a submount of the root without nodev (as recover's own
	// mounts of the target were).
	var st syscall.Stat_t
	if err := syscall.Stat(other, &st); err != nil {
		t.Fatal(err)
	}
	sh(t, "mount", "-t", "tmpfs", "-o", "mode=0755,size=1m", "tmpfs", filepath.Join(root, "srv"))
	t.Cleanup(func() { _ = syscall.Unmount(filepath.Join(root, "srv"), syscall.MNT_DETACH) })
	for p, n := range map[string][2]uint32{"root/evil-blk": {syscall.S_IFBLK, uint32(st.Rdev)}, "root/evil-chr": {syscall.S_IFCHR, 1<<8 | 3},
		"srv/evil-blk": {syscall.S_IFBLK, uint32(st.Rdev)}} {
		if err := syscall.Mknod(filepath.Join(root, p), n[0]|0o600, int(n[1])); err != nil {
			t.Fatal(err)
		}
	}
	spec := IsolateSpec{Root: root, Argv: []string{"/hook", other, allowed}, Devices: []string{allowed}, TimeoutSeconds: 60}
	// Without and with CAP_SYS_ADMIN (the grub steps on LVM or LUKS keep
	// it): every attempt must fail in both.
	for _, sysAdmin := range []bool{false, true} {
		t.Run(fmt.Sprintf("CapSysAdmin=%v", sysAdmin), func(t *testing.T) {
			_ = os.Remove(filepath.Join(root, "result.json"))
			if err := os.WriteFile(allowed, make([]byte, 2), 0o600); err != nil {
				t.Fatal(err)
			}
			spec := spec
			spec.CapSysAdmin = sysAdmin
			res, err := RunIsolated(context.Background(), agent, spec, 0)
			if err != nil || res.ExitCode != 0 {
				t.Fatalf("isolated run: %v exit %d\n%s", err, res.ExitCode, res.Output)
			}
			checkIsolationResult(t, root, allowed, sysAdmin, res.Output)
		})
	}
	// A symlink as a mount point of the target is refused.
	_ = os.Remove(filepath.Join(root, "run"))
	_ = os.Symlink("/", filepath.Join(root, "run"))
	if res, err := RunIsolated(context.Background(), agent, spec, 0); err == nil && res.ExitCode == 0 {
		t.Error("a symlinked /run was accepted")
	}
}

// checkIsolationResult checks what the hook of TestRootIsolation wrote.
func checkIsolationResult(t *testing.T, root, allowed string, sysAdmin bool, output []byte) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "result.json"))
	if err != nil {
		t.Fatalf("no result: %v\n%s", err, output)
	}
	var r map[string]string
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	t.Logf("results: %v", r)
	// With CAP_SYS_ADMIN the kernel (6.18 here) lets a reader open
	// /proc/1/environ and /proc/1/auxv of the non-dumpable helper (read
	// mode); its environment is empty, and /proc/1/mem (attach mode) stays
	// closed.
	if r["environ"] == "ok" && (!sysAdmin || r["environ_len"] != "0") {
		t.Errorf("/proc/1/environ is readable (%s bytes)", r["environ_len"])
	}
	for _, k := range []string{"net", "mem", "otherdev", "mknod", "mount", "chroot", "unshare", "open_by_handle_at", "ptrace",
		"syswrite", "efivars", "core_pattern", "sysrq", "procirq", "kcore", "open_tree", "tty"} {
		if r[k] == "ok" || r[k] == "" {
			t.Errorf("%s did not fail: %q", k, r[k])
		}
	}
	eperm, enosys := syscall.EPERM.Error(), syscall.ENOSYS.Error()
	for _, k := range []string{"open_tree_attr", "ioctl_dm_remove_all", "ioctl_dm_create", "ioctl_dm_suspend", "ioctl_dm_table_load",
		"ioctl_dm_target_msg", "ioctl_nvme_admin", "ioctl_nvme_io", "ioctl_tiocsti", "ioctl_md_add_new_disk", "ioctl_md_set_array_info",
		"ioctl_md_hot_add_disk", "ioctl_md_set_disk_faulty", "ioctl_md_run_array", "ioctl_md_stop_array"} {
		if r[k] != eperm {
			t.Errorf("%s: %q, want %q from the filter", k, r[k], eperm)
		}
	}
	// Restored device nodes cannot be opened: the whole target tree is
	// nodev and nosuid (ST_NOSUID 0x2, ST_NODEV 0x4), submounts included.
	eacces := syscall.EACCES.Error()
	for _, k := range []string{"node/root/evil-blk", "node/root/evil-chr", "node/srv/evil-blk"} {
		if r[k] != eacces {
			t.Errorf("%s: %q, want %q (nodev)", k, r[k], eacces)
		}
	}
	for _, k := range []string{"flags/", "flags/srv"} {
		if f, err := strconv.ParseUint(r[k], 16, 64); err != nil || f&0x6 != 0x6 {
			t.Errorf("%s: %q, want nodev and nosuid", k, r[k])
		}
	}
	if r["socket_vsock"] != syscall.EAFNOSUPPORT.Error() {
		t.Errorf("socket(AF_VSOCK): %q, want %q", r["socket_vsock"], syscall.EAFNOSUPPORT.Error())
	}
	for _, k := range []string{"socket_unix", "socket_inet", "socket_netlink"} {
		if r[k] != "ok" {
			t.Errorf("%s: %q, want ok", k, r[k])
		}
	}
	if r["io_uring_setup"] != eperm {
		t.Errorf("io_uring_setup: %q, want %q", r["io_uring_setup"], eperm)
	}
	if v, ok := r["core_pattern_clone"]; ok {
		t.Errorf("open_tree_attr gave a copy of /proc/sys; core_pattern through it: %q", v)
	}
	if r["unknown_syscall"] != enosys {
		t.Errorf("a system call newer than the table: %q, want %q", r["unknown_syscall"], enosys)
	}
	// A read-only device-mapper request passes the filter (and /dev/null
	// refuses it itself).
	for _, k := range []string{"ioctl_dm_version", "ioctl_md_raid_version", "ioctl_md_get_array_info", "ioctl_md_get_disk_info"} {
		if r[k] == eperm || r[k] == "" {
			t.Errorf("%s was refused by the filter: %q", k, r[k])
		}
	}
	capEff, err := strconv.ParseUint(r["capeff"], 16, 64)
	if err != nil {
		t.Fatalf("CapEff %q: %v", r["capeff"], err)
	}
	if got := capEff&(1<<capSysAdmin) != 0; got != sysAdmin {
		t.Errorf("CapEff %#x: CAP_SYS_ADMIN %v, want %v", capEff, got, sysAdmin)
	}
	for _, c := range capsToDrop(sysAdmin) {
		if capEff&(1<<uint(c)) != 0 {
			t.Errorf("CapEff %#x has capability %d", capEff, c)
		}
	}
	if r["allowed"] != "ok" {
		t.Errorf("the device of the plan is not usable: %s", r["allowed"])
	}
	for _, p := range strings.Split(r["pids"], ",") {
		if p != "1" && p != r["self"] {
			t.Errorf("/proc shows pid %s (only 1 and %s expected)", p, r["self"])
		}
	}
	if r["env"] != "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 SYSTEMD_OFFLINE=1" {
		t.Errorf("environment %q", r["env"])
	}
	head := make([]byte, 2)
	f, _ := os.Open(allowed)
	_, _ = f.Read(head)
	f.Close()
	if string(head) != "ok" {
		t.Errorf("the write to the allowed device did not arrive: %q", head)
	}
}

// TestRootExecuteExt4WholeDisk runs a plan on two loop devices without a
// partition table: wipe, zero, mkfs with readback, mount, a real restic
// restore, mkdirs, the fstab fixup and the fstab check.
func TestRootExecuteExt4WholeDisk(t *testing.T) {
	work := rootOnly(t)
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY")
	}
	for _, tool := range []string{"mkfs.ext4", "wipefs", "blkid", "dumpe2fs", "mount"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s missing", tool)
		}
	}
	sys := loopDev(t, work, "sys", 128)
	data := loopDev(t, work, "data", 64)
	// Old content that must go: a signature on the data disk.
	sh(t, "mkfs.ext4", "-q", "-F", data)
	// The snapshot: an fstab with kernel device names, a file on each.
	src := filepath.Join(work, "src")
	files := map[string]string{"etc/fstab": sys + " / ext4 defaults 0 1\n" + data + " /srv ext4 defaults 0 2\n", "etc/hostname": "loop\n", "srv/data.txt": "data\n", "usr/bin/tool": "#!/bin/sh\n"}
	for p, c := range files {
		_ = os.MkdirAll(filepath.Join(src, filepath.Dir(p)), 0o755)
		_ = os.WriteFile(filepath.Join(src, p), []byte(c), 0o644)
	}
	repo := filepath.Join(work, "repo")
	env := append(os.Environ(), "RESTIC_PASSWORD=pw", "RESTIC_REPOSITORY="+repo, "RESTIC_CACHE_DIR="+filepath.Join(work, "cache"))
	for _, args := range [][]string{{"init", "-q"}, {"backup", "-q", "."}} {
		c := exec.Command(bin, args...)
		c.Env, c.Dir = env, src
		if b, err := c.CombinedOutput(); err != nil {
			t.Fatalf("restic %v: %v\n%s", args, err, b)
		}
	}
	const rootUUID, dataUUID = "f3000000-0000-4000-8000-0000000000a1", "f3000000-0000-4000-8000-0000000000a2"
	features := "none,has_journal,ext_attr,resize_inode,dir_index,filetype,extent,flex_bg,sparse_super,large_file,huge_file,dir_nlink,extra_isize"
	target := filepath.Join(work, "target")
	step := func(phase, kind, tgt string, args ...string) baremetal.Step {
		s := baremetal.Step{Phase: phase, Kind: kind, Args: args, Reason: kind}
		if tgt != "" {
			s.Target = &tgt
		}
		return s
	}
	steps := []baremetal.Step{
		step("prepare", "release_holders", sys, "release-holders", sys),
		step("prepare", "wipe", sys, "wipefs", "-a", sys),
		step("prepare", "zero_range", sys, "blkzero", "--head=1048576", "--tail=1048576", sys),
		step("prepare", "release_holders", data, "release-holders", data),
		step("prepare", "wipe", data, "wipefs", "-a", data),
		step("prepare", "zero_range", data, "blkzero", "--head=1048576", "--tail=1048576", data),
		step("mkfs", "mkfs", sys, "mkfs.ext4", "-F", "-t", "ext4", "-U", rootUUID, "-b", "4096", "-O", features, sys),
		step("mkfs", "mkfs", data, "mkfs.ext4", "-F", "-t", "ext4", "-U", dataUUID, "-b", "4096", "-O", features, data),
		step("mount", "mount", sys, "mount", "-t", "ext4", sys, "{target_root}"),
		step("mount", "mount", data, "mount", "-t", "ext4", data, "{target_root}/srv"),
		step("restore", "restore", "", "restic", "restore", "--json", "--no-lock", "--no-cache", "--target", "{target_root}", "--sparse", "--verify", "--overwrite", "never", "latest"),
		step("post", "mkdirs", "", "mkdirs", "/proc:0555", "/sys:0555", "/dev:0755", "/run:0755", "/tmp:1777", "/srv:0755"),
		step("post", "fixup", "/etc/fstab", "fixup", "/etc/fstab", "fstab"),
		step("post", "verify", "", "verify"),
	}
	for i := range steps {
		steps[i].N = int64(i + 1)
	}
	plan := &baremetal.RestorePlan{Format: baremetal.PlanFormat, OK: true, Steps: steps}
	var logs []string
	exe := CmdExec{Runner: cmdrun.ExecRunner{OwnProcessGroup: true}, Log: func(s string) { logs = append(logs, s) }}
	var rootfs *DirRootfs
	ops := &LinuxOps{Exec: exe, Holders: &Holders{Exec: exe}, TmpDir: filepath.Join(work, "tmp"), Rootfs: func() *DirRootfs { return rootfs }}
	runner := &restic.Runner{Bin: bin, Repo: repo, PasswordBytes: []byte("pw"), TmpDir: filepath.Join(work, "rtmp")}
	fx := baremetal.FixupContext{DeviceNames: map[string]string{sys: "UUID=" + rootUUID, data: "UUID=" + dataUUID}, PartUUIDs: map[string]string{},
		SubvolIDs: map[int64]string{}, MACs: map[string]string{}, PlainSources: map[string]string{}, MD: map[string]baremetal.MDCount{}, NotRestored: map[string]bool{}}
	x := &Executor{Plan: plan, PlanSHA256: "p", Snapshot: "latest", TargetRoot: target, Exec: exe, Ops: ops, Restic: ResticExec{Runner: runner},
		Secrets: &Secrets{}, Fixups: fx, Log: func(s string) { logs = append(logs, s) },
		OpenRootfs: func() (Rootfs, error) {
			r, err := OpenRootfs(target)
			rootfs = r
			return r, err
		}}
	verifier := &fstabOnly{}
	x.Verifier = verifier
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	t.Cleanup(func() { _ = ops.UnmountAll(context.Background(), target) })
	rep, err := x.Run(ctx)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, strings.Join(logs, "\n"))
	}
	if got := sh(t, "blkid", "-p", "-o", "value", "-s", "UUID", sys); got != rootUUID {
		t.Errorf("root UUID %s", got)
	}
	if b, _ := os.ReadFile(filepath.Join(target, "srv/data.txt")); string(b) != "data\n" {
		t.Errorf("data file on the second disk: %q", b)
	}
	fstab, _ := os.ReadFile(filepath.Join(target, "etc/fstab"))
	if !strings.Contains(string(fstab), "UUID="+rootUUID) || strings.Contains(string(fstab), sys) {
		t.Errorf("fstab:\n%s", fstab)
	}
	if st, err := os.Stat(filepath.Join(target, "tmp")); err != nil || st.Mode()&os.ModeSticky == 0 {
		t.Errorf("/tmp: %v", err)
	}
	if len(rep.Fixups) != 1 || verifier.result == "" {
		t.Errorf("fixups %+v, check %q", rep.Fixups, verifier.result)
	}
	if verifier.result != "ok" {
		t.Errorf("fstab check: %s", verifier.findings)
	}
	if _, err := os.Stat(filepath.Join(target, MarkerPath)); err == nil {
		t.Error("the marker is still there")
	}
}

type fstabOnly struct {
	result   string
	findings string
}

type realEnv struct{}

// Exists resolves /dev/disk/by-uuid with blkid when udev made no link
// (containers without udev).
func (realEnv) Exists(dev string) bool {
	if _, err := os.Stat(dev); err == nil {
		return true
	}
	if u, ok := strings.CutPrefix(dev, "/dev/disk/by-uuid/"); ok {
		return exec.Command("blkid", "-U", u).Run() == nil
	}
	return false
}
func (realEnv) Statfs(string) (int64, int64, error)                            { return 1, 2, nil }
func (realEnv) BootOrder() []int64                                             { return nil }
func (realEnv) BootEntries() map[int]baremetal.LoadOption                      { return nil }
func (realEnv) ReadHead(string, int) ([]byte, error)                           { return nil, nil }
func (realEnv) Signatures(context.Context, string) []baremetal.TargetSignature { return nil }

func (f *fstabOnly) Verify(ctx context.Context, x *Executor) []*Check {
	_ = exec.Command("udevadm", "settle").Run()
	c := StandardVerifier{Env: realEnv{}}.fstab(x.Rootfs())
	f.result = c.Result
	f.findings = fmt.Sprint(c.Findings)
	return []*Check{c}
}

// TestRootHoldersRelease: a mounted ext4 and an active swap area on loop
// devices are released.
func TestRootHoldersRelease(t *testing.T) {
	work := rootOnly(t)
	fsDev := loopDev(t, work, "fs", 32)
	swapDev := loopDev(t, work, "swap", 32)
	sh(t, "mkfs.ext4", "-q", "-F", fsDev)
	sh(t, "mkswap", swapDev)
	mnt := filepath.Join(work, "mnt")
	_ = os.MkdirAll(mnt, 0o755)
	sh(t, "mount", fsDev, mnt)
	sh(t, "swapon", swapDev)
	t.Cleanup(func() { _ = exec.Command("swapoff", swapDev).Run(); _ = exec.Command("umount", mnt).Run() })
	exe := CmdExec{Runner: cmdrun.ExecRunner{}}
	h := &Holders{Exec: exe}
	for _, d := range []string{fsDev, swapDev} {
		if err := h.Release(context.Background(), d); err != nil {
			t.Fatalf("release %s: %v", d, err)
		}
	}
	mi, _ := os.ReadFile("/proc/self/mountinfo")
	if strings.Contains(string(mi), " "+mnt+" ") {
		t.Error("still mounted")
	}
	sw, _ := os.ReadFile("/proc/swaps")
	if strings.Contains(string(sw), swapDev) {
		t.Error("swap still active")
	}
}

// TestRootHoldersReleaseStack releases a real stack on a target disk (21.2):
// md RAID1 over two loop devices, LUKS2 on the md, a VG on the mapping
// with a mounted LV and a swap LV. Releasing one member disk must leave
// nothing on it: LVs removed one by one (dmsetup remove, not vgchange -an),
// the mapping closed, the md stopped, swap off.
func TestRootHoldersReleaseStack(t *testing.T) {
	work := rootOnly(t)
	if miss := missingTools("mdadm", "cryptsetup", "pvcreate", "vgcreate", "lvcreate", "dmsetup", "mkfs.ext4", "mkswap", "swapon"); len(miss) > 0 {
		t.Skipf("needs %s (CI job agent-root)", strings.Join(miss, ", "))
	}
	const mdName, cryptName, vg = "/dev/md/rsthold", "rsthold_crypt", "rstholdvg"
	a := loopDev(t, work, "md-a", 96)
	b := loopDev(t, work, "md-b", 96)
	mapper := "/dev/mapper/" + cryptName
	mnt := filepath.Join(work, "mnt")
	_ = os.MkdirAll(mnt, 0o755)
	// Cleanup in reverse order whatever the release left (it runs before
	// the loop devices are detached: t.Cleanup is last in, first out).
	t.Cleanup(func() {
		_ = exec.Command("swapoff", "/dev/mapper/"+vg+"-swap").Run()
		_ = exec.Command("umount", mnt).Run()
		_ = exec.Command("dmsetup", "remove", "--retry", vg+"-swap").Run()
		_ = exec.Command("dmsetup", "remove", "--retry", vg+"-data").Run()
		_ = exec.Command("cryptsetup", "close", cryptName).Run()
		_ = exec.Command("mdadm", "--stop", mdName).Run()
		_ = exec.Command("mdadm", "--zero-superblock", a, b).Run()
	})
	withStdin := func(stdin string, name string, args ...string) {
		t.Helper()
		c := exec.Command(name, args...)
		c.Stdin = strings.NewReader(stdin)
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
		}
	}
	withStdin("y\n", "mdadm", "--create", mdName, "--run", "--level=1", "--raid-devices=2", "--metadata=1.2", "--assume-clean", a, b)
	md, err := filepath.EvalSymlinks(mdName)
	if err != nil {
		t.Fatalf("no %s: %v", mdName, err)
	}
	withStdin("pw", "cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", "-", md)
	withStdin("pw", "cryptsetup", "open", "--key-file", "-", md, cryptName)
	sh(t, "pvcreate", "--devices", mapper, "--yes", mapper)
	sh(t, "vgcreate", "--devices", mapper, vg, mapper)
	sh(t, "lvcreate", "--devices", mapper, "--yes", "-n", "data", "-L", "32m", vg)
	sh(t, "lvcreate", "--devices", mapper, "--yes", "-n", "swap", "-L", "16m", vg)
	data, swap := "/dev/mapper/"+vg+"-data", "/dev/mapper/"+vg+"-swap"
	sh(t, "mkfs.ext4", "-q", "-F", data)
	sh(t, "mkswap", swap)
	sh(t, "mount", data, mnt)
	sh(t, "swapon", swap)
	swapDM, _ := filepath.EvalSymlinks(swap)
	exe := CmdExec{Runner: cmdrun.ExecRunner{}}
	if err := (&Holders{Exec: exe}).Release(context.Background(), a); err != nil {
		t.Fatalf("release %s: %v", a, err)
	}
	if hs, _ := os.ReadDir(filepath.Join("/sys/class/block", filepath.Base(a), "holders")); len(hs) > 0 {
		t.Errorf("%s still has holders: %v", a, hs)
	}
	if st, _ := os.ReadFile("/proc/mdstat"); strings.Contains(string(st), filepath.Base(md)+" :") {
		t.Errorf("%s still active:\n%s", md, st)
	}
	if ls, _ := exec.Command("dmsetup", "ls").CombinedOutput(); strings.Contains(string(ls), vg+"-") || strings.Contains(string(ls), cryptName) {
		t.Errorf("device-mapper devices left:\n%s", ls)
	}
	if sw, _ := os.ReadFile("/proc/swaps"); swapDM != "" && strings.Contains(string(sw), swapDM) {
		t.Errorf("swap still active:\n%s", sw)
	}
	if mi, _ := os.ReadFile("/proc/self/mountinfo"); strings.Contains(string(mi), " "+mnt+" ") {
		t.Error("the LV is still mounted")
	}
}

// TestRootDirectIOProbe reads and writes back the first and last MiB.
func TestRootDirectIOProbe(t *testing.T) {
	work := rootOnly(t)
	dev := loopDev(t, work, "probe", 16)
	f, _ := os.OpenFile(dev, os.O_WRONLY, 0)
	_, _ = f.WriteAt([]byte("marker"), 0)
	f.Close()
	if err := ProbeIO(dev, 16<<20, true); err != nil {
		t.Fatalf("probe: %v", err)
	}
	b := make([]byte, 6)
	f, _ = os.Open(dev)
	_, _ = f.ReadAt(b, 0)
	f.Close()
	if string(b) != "marker" {
		t.Errorf("the probe changed the content: %q", b)
	}
	if err := ProbeIO(filepath.Join(work, "nope"), 1<<20, false); err == nil {
		t.Error("a missing device passed")
	}
}

// missingTools names the tools of the list that are not installed.
func missingTools(tools ...string) []string {
	var out []string
	for _, tool := range tools {
		if _, err := exec.LookPath(tool); err != nil {
			out = append(out, tool)
		}
	}
	return out
}

// TestRootExecuteStack runs the full stack on a loop device through the
// executor: GPT with sfdisk (readback, PARTUUID wait), vfat, LUKS2 with
// the passphrase on stdin, LVM with --devices and XFS, mounted and
// restored with restic. It needs the tools of the ISO (CI job agent-root).
func TestRootExecuteStack(t *testing.T) {
	work := rootOnly(t)
	if miss := missingTools("sfdisk", "cryptsetup", "pvcreate", "vgcreate", "lvcreate", "mkfs.xfs", "mkfs.vfat", "udevadm"); len(miss) > 0 {
		t.Skipf("needs %s (CI job agent-root)", strings.Join(miss, ", "))
	}
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY")
	}
	file := filepath.Join(work, "stack.img")
	f, _ := os.Create(file)
	_ = f.Truncate(512 << 20)
	f.Close()
	dev := sh(t, "losetup", "-f", "-P", "--show", file)
	t.Cleanup(func() { _ = exec.Command("losetup", "-d", dev).Run() })
	src := filepath.Join(work, "src")
	_ = os.MkdirAll(filepath.Join(src, "etc"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "etc/hostname"), []byte("stack\n"), 0o644)
	repo := filepath.Join(work, "repo")
	env := append(os.Environ(), "RESTIC_PASSWORD=pw", "RESTIC_REPOSITORY="+repo, "RESTIC_CACHE_DIR="+filepath.Join(work, "cache"))
	for _, args := range [][]string{{"init", "-q"}, {"backup", "-q", "."}} {
		c := exec.Command(bin, args...)
		c.Env, c.Dir = env, src
		if b, err := c.CombinedOutput(); err != nil {
			t.Fatalf("restic %v: %v\n%s", args, err, b)
		}
	}
	script := "label: gpt\nunit: sectors\nsector-size: 512\n\n" + dev + "p1 : start=2048, size=204800, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, uuid=5E1C4D0A-1B2C-4D3E-8F90-A1B2C3D4E5F6\n" +
		dev + "p2 : start=206848, size=819200, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, uuid=6F2D5E1B-2C3D-4E4F-9A01-B2C3D4E5F607\n"
	pass := "passphrase"
	target := filepath.Join(work, "target")
	name := "restowstack_crypt"
	step := func(phase, kind, tgt string, stdin *string, secret *string, args ...string) baremetal.Step {
		s := baremetal.Step{Phase: phase, Kind: kind, Args: args, Stdin: stdin, StdinSecret: secret, Reason: kind}
		if tgt != "" {
			s.Target = &tgt
		}
		return s
	}
	steps := []baremetal.Step{
		step("prepare", "release_holders", dev, nil, nil, "release-holders", dev),
		step("prepare", "wipe", dev, nil, nil, "wipefs", "-a", dev),
		step("partition", "partition", dev, &script, nil, "sfdisk", "--no-reread", "--wipe", "always", dev),
		step("luks", "luks_format", dev+"p2", nil, &pass, "cryptsetup", "luksFormat", "--type", "luks2", "--uuid", "2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d", "--pbkdf", "pbkdf2", "--iter-time", "100", "--batch-mode", "--key-file", "-", dev+"p2"),
		step("luks", "luks_open", dev+"p2", nil, &pass, "cryptsetup", "open", "--key-file", "-", dev+"p2", name),
		step("lvm", "pv_create", "/dev/mapper/"+name, nil, nil, "pvcreate", "--devices", "/dev/mapper/"+name, "--yes", "/dev/mapper/"+name),
		step("lvm", "vg_create", "rstvg", nil, nil, "vgcreate", "--devices", "/dev/mapper/"+name, "rstvg", "/dev/mapper/"+name),
		step("lvm", "lv_create", "rstvg/root", nil, nil, "lvcreate", "--devices", "/dev/mapper/"+name, "--yes", "-n", "root", "-L", "320m", "rstvg"),
		step("mkfs", "mkfs", dev+"p1", nil, nil, "mkfs.vfat", "-F", "32", "-i", "1A2B3C4D", "-S", "512", dev+"p1"),
		step("mkfs", "mkfs", "/dev/rstvg/root", nil, nil, "mkfs.xfs", "-f", "-m", "uuid=f3000000-0000-4000-8000-0000000000b1", "/dev/rstvg/root"),
		step("mount", "mount", "/dev/rstvg/root", nil, nil, "mount", "-t", "xfs", "/dev/rstvg/root", "{target_root}"),
		step("mount", "mount", dev+"p1", nil, nil, "mount", "-t", "vfat", "-o", "quiet", dev+"p1", "{target_root}/boot/efi"),
		step("restore", "restore", "", nil, nil, "restic", "restore", "--json", "--no-lock", "--no-cache", "--target", "{target_root}", "--sparse", "--verify", "--overwrite", "never", "latest"),
		step("post", "mkdirs", "", nil, nil, "mkdirs", "/proc:0555", "/boot/efi:0755"),
	}
	for i := range steps {
		steps[i].N = int64(i + 1)
	}
	var logs []string
	exe := CmdExec{Runner: cmdrun.ExecRunner{OwnProcessGroup: true}, Log: func(s string) { logs = append(logs, s) }}
	var rootfs *DirRootfs
	ops := &LinuxOps{Exec: exe, Holders: &Holders{Exec: exe}, TmpDir: filepath.Join(work, "tmp"), Rootfs: func() *DirRootfs { return rootfs }}
	sec := &Secrets{}
	sec.SetPassphrase([]byte("correct-horse-battery-staple"))
	x := &Executor{Plan: &baremetal.RestorePlan{Format: baremetal.PlanFormat, OK: true, Steps: steps}, PlanSHA256: "p", Snapshot: "latest", TargetRoot: target,
		Exec: exe, Ops: ops, Restic: ResticExec{Runner: &restic.Runner{Bin: bin, Repo: repo, PasswordBytes: []byte("pw"), TmpDir: filepath.Join(work, "rtmp")}},
		Secrets: sec, Log: func(s string) { logs = append(logs, s) },
		OpenRootfs: func() (Rootfs, error) { r, err := OpenRootfs(target); rootfs = r; return r, err }}
	t.Cleanup(func() {
		_ = ops.UnmountAll(context.Background(), target)
		_ = exec.Command("vgchange", "--devices", "/dev/mapper/"+name, "-an", "rstvg").Run()
		_ = exec.Command("cryptsetup", "close", name).Run()
	})
	if _, err := x.Run(context.Background()); err != nil {
		t.Fatalf("run: %v\n%s", err, strings.Join(logs, "\n"))
	}
	if b, _ := os.ReadFile(filepath.Join(target, "etc/hostname")); string(b) != "stack\n" {
		t.Errorf("restored: %q", b)
	}
	if strings.Contains(strings.Join(logs, "\n"), "correct-horse") {
		t.Error("the passphrase is in the log")
	}
}
