package baremetal

import (
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// archNames maps kernel machine names to Go architecture names.
var archNames = map[string]string{"x86_64": "amd64", "aarch64": "arm64", "i686": "386", "armv7l": "arm", "riscv64": "riscv64", "ppc64le": "ppc64le", "s390x": "s390x"}

// captureOS reads os-release, the kernel and its command line (redacted),
// SELinux, the init system, Proxmox VE, whether a machine id exists, and
// whether the machine is a container (then there is no storage stack to
// capture).
func captureOS(c *capture) error {
	o := &c.l.OS
	rel, ok := c.readHost("/etc/os-release")
	if !ok {
		rel, ok = c.readHost("/usr/lib/os-release")
	}
	if ok {
		kv := sysparse.ParseOSRelease([]byte(rel))
		c.addRaw("os-release", []byte(rel))
		o.ID = clean(kv["ID"])
		o.IDLike = strings.Fields(clean(kv["ID_LIKE"]))
		o.VersionID = cleanPtr(kv["VERSION_ID"])
		o.PrettyName = cleanPtr(kv["PRETTY_NAME"])
	}
	if o.ID == "" {
		o.ID = "linux"
	}
	o.Arch = c.o.Arch
	if a, ok := readString(c.h, "/proc/sys/kernel/arch"); ok && a != "" {
		if n, ok := archNames[a]; ok {
			o.Arch = n
		} else {
			o.Arch = clean(a)
		}
	}
	o.Kernel, _ = readString(c.h, "/proc/sys/kernel/osrelease")
	o.Kernel = clean(o.Kernel)
	if cl, ok := readString(c.h, "/proc/cmdline"); ok {
		c.cmdline = cl
		o.Cmdline = cleanString(RedactCmdline(cl), maxCmdlineBytes)
		c.addRaw("proc-cmdline.txt", []byte(o.Cmdline+"\n"))
	}
	if b, ok := c.readHost("/etc/selinux/config"); ok {
		switch strings.ToLower(sysparse.ParseOSRelease([]byte(b))["SELINUX"]) {
		case "enforcing":
			o.SELinux = strPtr("enforcing")
		case "permissive":
			o.SELinux = strPtr("permissive")
		case "disabled":
			o.SELinux = strPtr("disabled")
		}
	}
	if comm, ok := readString(c.h, "/proc/1/comm"); ok && comm == "systemd" || exists(c.h, "/run/systemd/system") {
		o.Init = "systemd"
	} else {
		o.Init = "other"
	}
	o.ProxmoxVE = exists(c.h, "/usr/bin/pveversion") || exists(c.h, "/usr/share/pve-manager")
	o.MachineID = exists(c.h, "/etc/machine-id")
	if isContainer(c.h) {
		c.container = true
		c.note(CodeContainer, "", "", SeverityUnsupported)
	}
	return nil
}

// isContainer recognises LXC, Docker, Podman and systemd-nspawn the way
// sysinfo does for the heartbeat.
func isContainer(h Host) bool {
	if v, ok := readString(h, "/run/systemd/container"); ok && v != "" {
		return true
	}
	if exists(h, "/.dockerenv") || exists(h, "/run/.containerenv") {
		return true
	}
	if b, err := h.ReadFile("/proc/1/environ", 64<<10); err == nil {
		for _, kv := range strings.Split(string(b), "\x00") {
			if strings.HasPrefix(kv, "container=") {
				return true
			}
		}
	}
	return false
}
