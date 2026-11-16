//go:build linux

package recovery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Holders is the release of everything that holds a target disk before it
// is erased (docs/BAREMETAL.md 10.10 point 1): mounts and swap on the disk,
// its partitions and the md and device-mapper devices on top of them are
// stopped from the top down; afterwards nothing may hold the disk.
type Holders struct {
	Exec Exec
	// SysRoot, MountInfo and Swaps are /sys, /proc/self/mountinfo and
	// /proc/swaps (tests use fake files).
	SysRoot   string
	MountInfo string
	Swaps     string
	// Unmount replaces syscall.Unmount (tests).
	Unmount func(target string, flags int) error
}

func (h *Holders) sys() string {
	if h.SysRoot == "" {
		return "/sys"
	}
	return h.SysRoot
}

// holderNode is a block device of the tree on a disk.
type holderNode struct {
	name  string // kernel name: sda, sda1, dm-0, md127
	depth int
}

// tree lists the disk, its partitions and every holder above them, the
// highest first.
func (h *Holders) tree(disk string) []holderNode {
	seen := map[string]int{}
	var walk func(k string, depth int)
	walk = func(k string, depth int) {
		if d, ok := seen[k]; (ok && d >= depth) || depth > 32 {
			return
		}
		seen[k] = depth
		hs, _ := os.ReadDir(filepath.Join(h.sys(), "class/block", k, "holders"))
		for _, x := range hs {
			walk(x.Name(), depth+1)
		}
		if depth == 0 {
			parts, _ := os.ReadDir(filepath.Join(h.sys(), "block", k))
			for _, p := range parts {
				if _, err := os.Stat(filepath.Join(h.sys(), "block", k, p.Name(), "partition")); err == nil {
					walk(p.Name(), 1)
				}
			}
		}
	}
	walk(disk, 0)
	var out []holderNode
	for k, d := range seen {
		out = append(out, holderNode{name: k, depth: d})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].depth != out[j].depth {
			return out[i].depth > out[j].depth
		}
		return out[i].name < out[j].name
	})
	return out
}

func (h *Holders) read(rel string) string {
	b, err := os.ReadFile(filepath.Join(h.sys(), rel))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// mountsOf are the mount points of a device (by major:minor), deepest
// first.
func (h *Holders) mountsOf(devnum string) []string {
	mi := h.MountInfo
	if mi == "" {
		mi = "/proc/self/mountinfo"
	}
	b, err := os.ReadFile(mi)
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) > 4 && f[2] == devnum {
			out = append(out, unescapeMount(f[4]))
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.Count(out[i], "/") > strings.Count(out[j], "/") })
	return out
}

func unescapeMount(s string) string {
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

// swapsOf reports whether /dev/<name> is an active swap area.
func (h *Holders) swapOf(name string) bool {
	sw := h.Swaps
	if sw == "" {
		sw = "/proc/swaps"
	}
	b, err := os.ReadFile(sw)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n")[1:] {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		dev := f[0]
		if r, err := filepath.EvalSymlinks(dev); err == nil {
			dev = r
		}
		if strings.TrimPrefix(dev, "/dev/") == name {
			return true
		}
	}
	return false
}

// Release stops everything that holds dev and checks that nothing is
// left (holders_busy otherwise, with the list).
func (h *Holders) Release(ctx context.Context, dev string) error {
	disk := strings.TrimPrefix(dev, "/dev/")
	if r, err := filepath.EvalSymlinks(dev); err == nil && h.SysRoot == "" {
		disk = strings.TrimPrefix(r, "/dev/")
	}
	unmount := h.Unmount
	if unmount == nil {
		unmount = syscall.Unmount
	}
	run := func(argv ...string) error {
		_, err := h.Exec.Run(ctx, RunSpec{Argv: argv, NoKill: true, Timeout: 5 * time.Minute})
		return err
	}
	var errs []string
	for _, n := range h.tree(disk) {
		devnum := h.read(filepath.Join("class/block", n.name, "dev"))
		for _, m := range h.mountsOf(devnum) {
			if err := unmount(m, 0); err != nil {
				if err2 := unmount(m, syscall.MNT_DETACH); err2 != nil {
					errs = append(errs, fmt.Sprintf("umount %s: %v", m, err))
				}
			}
		}
		if h.swapOf(n.name) {
			if err := run("swapoff", "/dev/"+n.name); err != nil {
				errs = append(errs, err.Error())
			}
		}
		if n.name == disk || h.read(filepath.Join("class/block", n.name, "partition")) != "" {
			continue
		}
		switch {
		case strings.HasPrefix(n.name, "md"):
			if err := run("mdadm", "--stop", "/dev/"+n.name); err != nil {
				errs = append(errs, err.Error())
			}
		case strings.HasPrefix(n.name, "dm-"):
			uuid := h.read(filepath.Join("class/block", n.name, "dm/uuid"))
			name := h.read(filepath.Join("class/block", n.name, "dm/name"))
			if name == "" {
				continue
			}
			var err error
			switch {
			case strings.HasPrefix(uuid, "CRYPT-"):
				err = run("cryptsetup", "close", name)
			case strings.HasPrefix(uuid, "LVM-"):
				// Only this LV of the VG: other LVs may live on disks that
				// stay (an LV is a device-mapper device of its own).
				err = run("dmsetup", "remove", "--retry", name)
			default:
				err = run("dmsetup", "remove", "--retry", name)
			}
			if err != nil {
				errs = append(errs, err.Error())
			}
		}
	}
	// Nothing may hold the disk or its partitions now.
	var busy []string
	for _, n := range h.tree(disk) {
		if n.depth > 1 || (n.depth == 1 && h.read(filepath.Join("class/block", n.name, "partition")) == "") {
			busy = append(busy, n.name)
			continue
		}
		devnum := h.read(filepath.Join("class/block", n.name, "dev"))
		if len(h.mountsOf(devnum)) > 0 || h.swapOf(n.name) {
			busy = append(busy, n.name)
		}
	}
	if len(busy) > 0 {
		sort.Strings(busy)
		msg := strings.Join(busy, ", ")
		if len(errs) > 0 {
			msg += " (" + strings.Join(errs, "; ") + ")"
		}
		return &problemError{code: ProblemHoldersBusy, err: errors.New(msg)}
	}
	return nil
}
