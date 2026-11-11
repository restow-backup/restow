//go:build linux && agentroot

package recovery

// Root tests on loop devices for what recover may and may not write: the
// scan writes nowhere, the confirmed disk stays the confirmed disk, and
// the signatures on old partitions go before the table.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// ioSectors are the sectors read from and written to a block device so
// far (/sys/block/<name>/stat, fields 3 and 7).
func ioSectors(t *testing.T, dev string) (read, written int64) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("/sys/block", filepath.Base(dev), "stat"))
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(b))
	if len(f) < 7 {
		t.Fatalf("stat of %s: %q", dev, b)
	}
	read, _ = strconv.ParseInt(f[2], 10, 64)
	written, _ = strconv.ParseInt(f[6], 10, 64)
	return read, written
}

// fakeDisk makes the loop device dev look like the disk /dev/<name> of a
// machine: an entry in a private /sys/block and a node in a private /dev.
func fakeDisk(t *testing.T, sys, devRoot, name, dev string, size int64) {
	t.Helper()
	base := filepath.Join(sys, "block", name)
	for p, v := range map[string]string{"size": strconv.FormatInt(size/512, 10), "ro": "0", "removable": "0",
		"queue/logical_block_size": "512", "queue/physical_block_size": "512", "queue/zoned": "none"} {
		full := filepath.Join(base, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(devRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dev, filepath.Join(devRoot, name)); err != nil {
		t.Fatal(err)
	}
}

// TestRootScanDoesNotWrite: the hardware scan runs before the operator
// has seen or confirmed anything, on every disk of the machine. On a disk
// without signatures (new, or with content blkid does not know) it reads
// both ends and writes nothing. The write probe exists and writes: it is
// for the confirmed disks, after the confirmation.
func TestRootScanDoesNotWrite(t *testing.T) {
	work := rootOnly(t)
	const size = 16 << 20
	dev := loopDev(t, work, "blank", 16)
	sys, devRoot := filepath.Join(work, "sys"), filepath.Join(work, "dev")
	fakeDisk(t, sys, devRoot, "sdq", dev, size)
	exe := CmdExec{Runner: cmdrun.ExecRunner{OwnProcessGroup: true}, Log: func(string) {}}
	r0, w0 := ioSectors(t, dev)
	h := &HardwareCollector{Exec: exe, SysRoot: sys, DevRoot: devRoot, ProcRoot: filepath.Join(work, "proc"), Probe: true}
	in, err := h.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(in.Blocks) != 1 || in.Blocks[0].KName != "sdq" || in.Blocks[0].SizeBytes != size || len(in.Blocks[0].Signatures) != 0 {
		t.Fatalf("scan: %+v", in.Blocks)
	}
	if in.Blocks[0].IOError {
		t.Error("the read probe failed on a healthy disk")
	}
	r1, w1 := ioSectors(t, dev)
	if r1-r0 < 2*(1<<20)/512 {
		t.Errorf("the scan read %d sectors: the probe of both ends did not run", r1-r0)
	}
	if w1 != w0 {
		t.Errorf("the scan wrote %d sectors to a disk nobody confirmed", w1-w0)
	}
	// The probe after the confirmation does write (the same bytes back).
	if err := ProbeIO(dev, size, true); err != nil {
		t.Fatal(err)
	}
	if _, w2 := ioSectors(t, dev); w2-w1 < 2*(1<<20)/512 {
		t.Errorf("the write probe wrote %d sectors", w2-w1)
	}
	// The scan before every step reads identities only: no probe at all.
	r2, w2 := ioSectors(t, dev)
	light := &HardwareCollector{Exec: exe, SysRoot: sys, DevRoot: devRoot, ProcRoot: filepath.Join(work, "proc"), Probe: true, IdentityOnly: true}
	if in, err = light.Collect(context.Background()); err != nil || len(in.Blocks) != 1 || in.Blocks[0].SizeBytes != size {
		t.Fatalf("identity scan: %v %+v", err, in.Blocks)
	}
	if r3, w3 := ioSectors(t, dev); r3 != r2 || w3 != w2 {
		t.Errorf("the identity scan did I/O on the disk: read %d, written %d sectors", r3-r2, w3-w2)
	}
}

// devNode makes a block device node /dev/<name> for the device behind
// dev and returns its path; replace gives the name to another device (as
// the kernel does with sdb when a disk is pulled and another enumerated).
func devNode(t *testing.T, name, dev string) (path string, replace func(other string)) {
	t.Helper()
	path = "/dev/" + name
	mk := func(src string) {
		var st syscall.Stat_t
		if err := syscall.Stat(src, &st); err != nil {
			t.Fatal(err)
		}
		_ = os.Remove(path)
		if err := syscall.Mknod(path, syscall.S_IFBLK|0o600, int(st.Rdev)); err != nil {
			t.Fatalf("mknod %s: %v", path, err)
		}
	}
	mk(dev)
	t.Cleanup(func() { _ = os.Remove(path) })
	return path, mk
}

// TestRootGuardKeepsTheConfirmedDisk: the operator confirmed the disk
// behind a name. Then the name goes to another disk, one with data that
// nobody confirmed. The guard holds the confirmed disk and refuses before
// the first step; the other disk keeps its content. A disk that changes
// its size under the name is refused too.
func TestRootGuardKeepsTheConfirmedDisk(t *testing.T) {
	work := rootOnly(t)
	if miss := missingTools("mkfs.ext4", "blkid", "wipefs", "losetup"); len(miss) > 0 {
		t.Skipf("needs %s", strings.Join(miss, ", "))
	}
	const size = 64 << 20
	confirmedDev := loopDev(t, work, "confirmed", 64)
	precious := loopDev(t, work, "precious", 64)
	sh(t, "mkfs.ext4", "-q", "-F", "-L", "PRECIOUS", precious)
	name := fmt.Sprintf("restow-test-%d-sdb", os.Getpid())
	path, replace := devNode(t, name, confirmedDev)

	// What cannot be the confirmed disk is not held.
	if _, err := HoldDevice(path, size/2); err == nil {
		t.Error("a device of another size was held")
	}
	file := filepath.Join(work, "plain")
	_ = os.WriteFile(file, make([]byte, 4096), 0o600)
	if _, err := HoldDevice(file, 4096); err == nil {
		t.Error("a regular file was held")
	}

	hw := HardwareInput{Blocks: []BlockInfo{{KName: name, SizeBytes: size, Logical: 512, Physical: 512, Serial: "CONFIRMED"}}}
	target, _ := BuildTarget(hw)
	if len(target.Disks) != 1 || target.Disks[0].Path != path {
		t.Fatalf("target %+v", target.Disks)
	}
	d := path
	steps := []baremetal.Step{
		{N: 1, Phase: "prepare", Kind: "wipe", Target: &d, Reason: "wipe", Args: []string{"wipefs", "-a", path}},
		{N: 2, Phase: "prepare", Kind: "zero_range", Target: &d, Reason: "zero", Args: []string{"blkzero", "--head=1048576", "--tail=1048576", path}},
	}
	reason := "identity"
	plan := &baremetal.RestorePlan{Format: baremetal.PlanFormat, OK: true, Steps: steps,
		Mapping: []baremetal.DiskAssignment{{Source: "d0", Action: baremetal.ActionErase, Target: &target.Disks[0].ID, Reason: &reason}}}
	guard := &DiskGuard{Hold: HoldDevice}
	if err := guard.Arm(context.Background(), func(context.Context) (HardwareInput, error) { return hw, nil }, target, plan, false); err != nil {
		t.Fatalf("arm: %v", err)
	}
	defer guard.Close()
	if err := guard.Check(context.Background()); err != nil {
		t.Fatalf("the confirmed disk: %v", err)
	}
	// While it is held the kernel does not let the loop device go: the
	// name of a held disk cannot move to another backing file.
	_ = exec.Command("losetup", "-d", confirmedDev).Run()
	if out, err := exec.Command("losetup", confirmedDev, filepath.Join(work, "precious.img")).CombinedOutput(); err == nil {
		t.Errorf("the held device was given another backing file: %s", out)
	}
	if err := guard.Check(context.Background()); err != nil {
		t.Errorf("the held disk after the attempt to detach it: %v", err)
	}

	// The name now leads to the other disk.
	replace(precious)
	var logs []string
	exe := CmdExec{Runner: cmdrun.ExecRunner{OwnProcessGroup: true}, Log: func(s string) { logs = append(logs, s) }}
	x := &Executor{Plan: plan, PlanSHA256: "p", Snapshot: "latest", TargetRoot: filepath.Join(work, "target"), Exec: exe,
		Ops: &LinuxOps{Exec: exe, Holders: &Holders{Exec: exe}, TmpDir: filepath.Join(work, "tmp")}, Secrets: &Secrets{}, Guard: guard,
		Log: func(s string) { logs = append(logs, s) }}
	rep, err := x.Run(context.Background())
	if !errors.Is(err, ErrDisksChanged) || rep.Completed != 0 || rep.FailedStep != 1 {
		t.Fatalf("run on the swapped name: %v, report %+v\n%s", err, rep, strings.Join(logs, "\n"))
	}
	if got := sh(t, "blkid", "-p", "-o", "value", "-s", "LABEL", precious); got != "PRECIOUS" {
		t.Errorf("the disk nobody confirmed lost its file system (label %q)", got)
	}
	// Back on the confirmed disk the same plan runs.
	replace(confirmedDev)
	if _, err := x.Run(context.Background()); err != nil {
		t.Fatalf("run on the confirmed disk: %v\n%s", err, strings.Join(logs, "\n"))
	}

	// A disk whose size changes under its name.
	grown := loopDev(t, work, "grown", 32)
	h, err := HoldDevice(grown, 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err := h.Check(); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(filepath.Join(work, "grown.img"), 48<<20); err != nil {
		t.Fatal(err)
	}
	sh(t, "losetup", "-c", grown)
	if err := h.Check(); err == nil {
		t.Error("a disk that changed its size passed")
	}
}

// writeMBR writes a DOS partition table with the given partitions (start
// and size in MiB) to an image.
func writeMBR(t *testing.T, dev string, parts [][2]int64) {
	t.Helper()
	mbr := make([]byte, 512)
	binary.LittleEndian.PutUint32(mbr[440:], 0xa1b2c3d0)
	for i, p := range parts {
		e := mbr[446+16*i:]
		e[1], e[2], e[3] = 0xfe, 0xff, 0xff
		e[4] = 0x83
		e[5], e[6], e[7] = 0xfe, 0xff, 0xff
		binary.LittleEndian.PutUint32(e[8:], uint32(p[0]<<20/512))
		binary.LittleEndian.PutUint32(e[12:], uint32(p[1]<<20/512))
	}
	mbr[510], mbr[511] = 0x55, 0xaa
	f, err := os.OpenFile(dev, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteAt(mbr, 0); err != nil {
		t.Fatal(err)
	}
}

// signatureAt is the file system type blkid finds at an offset of a disk
// ("" when there is none).
func signatureAt(dev string, offset int64) string {
	out, _ := exec.Command("blkid", "-p", "-O", strconv.FormatInt(offset, 10), "-o", "value", "-s", "TYPE", dev).Output()
	return strings.TrimSpace(string(out))
}

// TestRootWipePartitions: an old disk with a file system in a partition
// that starts beyond the first 16 MiB. wipefs on the disk and the zeroed
// ends leave that file system where it is, ready to show again in a new
// partition at the same place; the wipe-partitions step removes it.
func TestRootWipePartitions(t *testing.T) {
	work := rootOnly(t)
	if miss := missingTools("mkfs.ext4", "blkid", "wipefs", "partx"); len(miss) > 0 {
		t.Skipf("needs %s", strings.Join(miss, ", "))
	}
	const at = int64(40) << 20
	run := func(name string, withStep bool) (string, []string, error) {
		dev := loopDev(t, work, name, 128)
		writeMBR(t, dev, [][2]int64{{1, 8}, {40, 32}})
		sh(t, "partx", "-a", dev)
		t.Cleanup(func() { _ = exec.Command("partx", "-d", dev).Run() })
		deadline := time.Now().Add(10 * time.Second)
		for {
			if _, err := os.Stat(dev + "p2"); err == nil || time.Now().After(deadline) {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		sh(t, "mkfs.ext4", "-q", "-F", "-L", "OLDDATA", dev+"p2")
		if got := signatureAt(dev, at); got != "ext4" {
			t.Fatalf("fixture: no ext4 at 40 MiB of %s (%q)", dev, got)
		}
		var logs []string
		exe := CmdExec{Runner: cmdrun.ExecRunner{OwnProcessGroup: true}, Log: func(s string) { logs = append(logs, s) }}
		ops := &LinuxOps{Exec: exe, Holders: &Holders{Exec: exe}, TmpDir: filepath.Join(work, "tmp")}
		parts, err := ops.Partitions(dev)
		if err != nil || len(parts) != 2 || parts[0] != dev+"p1" || parts[1] != dev+"p2" {
			t.Fatalf("partitions of %s: %v %v", dev, parts, err)
		}
		d := dev
		step := func(kind string, args ...string) baremetal.Step {
			return baremetal.Step{Phase: "prepare", Kind: kind, Target: &d, Reason: kind, Args: args}
		}
		steps := []baremetal.Step{step("release_holders", "release-holders", dev)}
		if withStep {
			steps = append(steps, step("wipe_partitions", "wipe-partitions", dev))
		}
		steps = append(steps, step("wipe", "wipefs", "-a", dev), step("zero_range", "blkzero", "--head=16777216", "--tail=16777216", dev))
		for i := range steps {
			steps[i].N = int64(i + 1)
		}
		x := &Executor{Plan: &baremetal.RestorePlan{Format: baremetal.PlanFormat, OK: true, Steps: steps}, PlanSHA256: "p", Snapshot: "latest",
			TargetRoot: filepath.Join(work, "target"), Exec: exe, Ops: ops, Secrets: &Secrets{}, Log: func(s string) { logs = append(logs, s) }}
		_, err = x.Run(context.Background())
		return signatureAt(dev, at), logs, err
	}
	// What the plan did before: the old file system survives.
	left, logs, err := run("before", false)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, strings.Join(logs, "\n"))
	}
	if left != "ext4" {
		t.Fatalf("fixture: without the step the old signature is gone already (%q); the test shows nothing", left)
	}
	left, logs, err = run("now", true)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, strings.Join(logs, "\n"))
	}
	if left != "" {
		t.Errorf("the file system of the old partition is still there (%s)\n%s", left, strings.Join(logs, "\n"))
	}
}
