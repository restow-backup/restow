package sysinfo

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Virtualization kinds reported to the server.
const (
	VirtContainer = "container"
	VirtVM        = "vm"
	VirtNone      = "none"
)

// Machine is what the agent tells the server about the machine it runs on
// (agent 0.4.0 and later): whether it is a container or a virtual machine,
// whether a desktop is installed, and which folders where applications keep
// their data exist with files in them. The server uses the first two to pick
// the profile at enrollment and the folders to warn when a backup job leaves
// them out. Only folder names from a fixed list are reported, never file names.
type Machine struct {
	// Virtualization is VirtContainer, VirtVM or VirtNone.
	Virtualization string
	// Technology names it as systemd-detect-virt does (lxc, docker, kvm,
	// vmware, ...); empty when unknown.
	Technology string
	// Desktop is true when a graphical session is installed.
	Desktop bool
	// DataFolders are the entries of DataFolderCandidates that exist and hold
	// at least one file; nil on systems without candidates (macOS).
	DataFolders []string
}

// DataFolderCandidate is one folder the agent checks for data.
type DataFolderCandidate struct {
	Path string
	// Ignore names entries directly in Path that do not count as data
	// (Docker keeps its volume database next to the volumes).
	Ignore []string
}

// DataFolderCandidates are the Linux folders the agent checks. The server
// keeps the same list (packages/core/src/endpoints/data-folders.ts) and drops
// any other name.
var DataFolderCandidates = []DataFolderCandidate{
	{Path: "/opt"},
	{Path: "/usr/local"},
	{Path: "/srv"},
	{Path: "/var/www"},
	{Path: "/var/lib/docker/volumes", Ignore: []string{"metadata.db", "backingFsBlockDev"}},
	{Path: "/var/lib/containers/storage/volumes"},
	{Path: "/var/lib/postgresql"},
	{Path: "/var/lib/pgsql"},
	{Path: "/var/lib/mysql"},
	{Path: "/var/lib/mongodb"},
}

const (
	// dataFolderDepth is how deep below a candidate a file still counts
	// (volumes/<name>/_data/<file> is three levels down).
	dataFolderDepth = 4
	// dataFolderBudget bounds the directory entries read per candidate. A
	// folder with more entries than that is counted as holding data.
	dataFolderBudget = 2000
)

// DetectMachine looks at the machine the agent runs on. It reads a few small
// files and lists at most a bounded number of directory entries; it never
// fails, an unreadable fact is reported as unknown.
func DetectMachine() Machine {
	if runtime.GOOS != "linux" {
		return Machine{Virtualization: VirtNone}
	}
	return detectMachine("/")
}

func detectMachine(root string) Machine {
	kind, tech := detectVirtualization(root)
	return Machine{
		Virtualization: kind,
		Technology:     tech,
		Desktop:        hasDesktop(root),
		DataFolders:    DataFolders(root),
	}
}

// DataFolders returns the candidates below root that exist and hold at least
// one regular file within a few levels. Symbolic links inside a candidate are
// not followed; a candidate that is itself a link to a folder counts.
func DataFolders(root string) []string {
	found := []string{}
	for _, c := range DataFolderCandidates {
		if holdsData(filepath.Join(root, c.Path), c.Ignore) {
			found = append(found, c.Path)
		}
	}
	return found
}

func holdsData(dir string, ignore []string) bool {
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return false
	}
	type level struct {
		path  string
		depth int
	}
	queue := []level{{dir, 1}}
	budget := dataFolderBudget
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		entries, err := os.ReadDir(cur.path)
		if err != nil {
			continue
		}
		for _, e := range entries {
			budget--
			if budget < 0 {
				return true
			}
			if cur.depth == 1 && contains(ignore, e.Name()) {
				continue
			}
			switch {
			case e.Type().IsRegular():
				return true
			case e.IsDir() && cur.depth < dataFolderDepth:
				queue = append(queue, level{filepath.Join(cur.path, e.Name()), cur.depth + 1})
			}
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// detectVirtualization tells a container from a virtual machine the way
// systemd-detect-virt does, from files only: a container first (an LXC
// container on a VM is a container), then the hardware a hypervisor shows.
func detectVirtualization(root string) (kind, technology string) {
	if tech := containerTechnology(root); tech != "" {
		return VirtContainer, tech
	}
	if tech := vmTechnology(root); tech != "" {
		return VirtVM, tech
	}
	return VirtNone, ""
}

func readTrimmed(root, name string) string {
	b, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func exists(root, name string) bool {
	_, err := os.Lstat(filepath.Join(root, name))
	return err == nil
}

func containerTechnology(root string) string {
	// systemd and LXC write the container manager here.
	if v := readTrimmed(root, "run/systemd/container"); v != "" {
		return sanitizeTech(v)
	}
	// The container= variable of PID 1 (readable by root, which the agent is).
	if b, err := os.ReadFile(filepath.Join(root, "proc/1/environ")); err == nil {
		for _, kv := range bytes.Split(b, []byte{0}) {
			if v, ok := strings.CutPrefix(string(kv), "container="); ok && strings.TrimSpace(v) != "" {
				return sanitizeTech(v)
			}
		}
	}
	switch {
	case exists(root, ".dockerenv"):
		return "docker"
	case exists(root, "run/.containerenv"):
		return "podman"
	}
	return ""
}

// vmVendors maps what the DMI tables of a virtual machine say to the name
// systemd-detect-virt uses.
var vmVendors = []struct{ match, tech string }{
	{"qemu", "qemu"},
	{"kvm", "kvm"},
	{"vmware", "vmware"},
	{"virtualbox", "oracle"},
	{"innotek", "oracle"},
	{"xen", "xen"},
	{"bochs", "bochs"},
	{"parallels", "parallels"},
	{"bhyve", "bhyve"},
	{"openstack", "kvm"},
	{"amazon ec2", "amazon"},
	{"google compute engine", "google"},
	{"apple virtualization", "apple"},
}

func vmTechnology(root string) string {
	vendor := strings.ToLower(readTrimmed(root, "sys/class/dmi/id/sys_vendor"))
	product := strings.ToLower(readTrimmed(root, "sys/class/dmi/id/product_name"))
	board := strings.ToLower(readTrimmed(root, "sys/class/dmi/id/board_vendor"))
	if strings.Contains(vendor, "microsoft") && strings.Contains(product, "virtual machine") {
		return "microsoft"
	}
	for _, v := range vmVendors {
		if strings.Contains(vendor, v.match) || strings.Contains(product, v.match) || strings.Contains(board, v.match) {
			return v.tech
		}
	}
	if t := strings.ToLower(readTrimmed(root, "sys/hypervisor/type")); t != "" {
		return sanitizeTech(t)
	}
	// Any x86 guest: the CPU says it runs under a hypervisor.
	if b, err := os.ReadFile(filepath.Join(root, "proc/cpuinfo")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "flags" {
				for _, f := range strings.Fields(v) {
					if f == "hypervisor" {
						return "vm-other"
					}
				}
				break
			}
		}
	}
	return ""
}

// sanitizeTech keeps a technology name short and plain.
func sanitizeTech(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	var b strings.Builder
	for _, r := range v {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= 32 {
			break
		}
	}
	return b.String()
}

// hasDesktop reports whether a graphical session is installed: a session
// file of a display manager (X11 or Wayland).
func hasDesktop(root string) bool {
	for _, dir := range []string{"usr/share/xsessions", "usr/share/wayland-sessions"} {
		entries, err := os.ReadDir(filepath.Join(root, dir))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".desktop") {
				return true
			}
		}
	}
	return false
}
