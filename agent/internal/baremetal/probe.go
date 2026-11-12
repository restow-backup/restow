package baremetal

import (
	"bytes"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"unicode"
)

// The boot probe (docs/BAREMETAL.md 12.3): the lab restores a whole machine
// snapshot with recover in a virtual machine and boots the restored disks.
// The server decides what the probe restores in full and what it creates
// empty (@restow/core probe.ts); the planner and recover only apply that,
// and refuse anything that would leave a system path out.

// ProbeOptions are the probe part of the answers (answers.probe).
type ProbeOptions struct {
	// EmptyFilesystems are the mount points of file systems that are created
	// with their identity but not restored.
	EmptyFilesystems []string
	// EmptyDirs are folders inside a restored file system that stay empty.
	EmptyDirs []string
}

// ProbeFolderRoots are the folders whose subfolders a probe may leave empty.
var ProbeFolderRoots = []string{"/home", "/srv", "/var/lib"}

// ProbeSystemMountPoints are always restored in full (with the ESPs).
var ProbeSystemMountPoints = []string{"/", "/boot", "/usr", "/var"}

// ProbeProtectedDirs are never left empty (25.C10): the package and systemd
// databases make the system the one that was backed up.
var ProbeProtectedDirs = []string{
	"/var/lib/dkms", "/var/lib/dpkg", "/var/lib/pacman", "/var/lib/restow-agent",
	"/var/lib/rpm", "/var/lib/selinux", "/var/lib/shim-signed", "/var/lib/systemd",
}

// ProbeSystemMounts returns the mount points a probe of m restores in full:
// /, /boot, /usr, /var and the mount points of the ESPs and of XBOOTLDR.
func ProbeSystemMounts(m *Manifest) []string {
	set := map[string]bool{}
	for _, p := range ProbeSystemMountPoints {
		set[p] = true
	}
	if m != nil && m.Linux != nil {
		ids := map[string]bool{}
		for _, id := range m.Linux.Bootloader.ESPs {
			ids[id] = true
		}
		if x := m.Linux.Bootloader.XBootLdr; x != nil {
			ids[*x] = true
		}
		for _, mt := range m.Linux.Mounts {
			if mt.FS != nil && ids[*mt.FS] && strings.HasPrefix(mt.Target, "/") {
				set[path.Clean(mt.Target)] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func probeUnder(p, parent string) bool {
	return parent == "/" || p == parent || strings.HasPrefix(p, parent+"/")
}

// ProbePathShape checks the shape of a path of the probe answers: absolute,
// clean, no control characters, at most 1024 bytes.
func ProbePathShape(p string) error {
	if p == "" || len(p) > 1024 || !strings.HasPrefix(p, "/") || path.Clean(p) != p {
		return fmt.Errorf("probe: %q is not a clean absolute path", p)
	}
	for _, r := range p {
		if unicode.IsControl(r) {
			return fmt.Errorf("probe: %q contains a control character", p)
		}
	}
	return nil
}

// ProbeEmptyAllowed reports why p may not be left empty by a probe, or nil:
// it is no system mount, no parent of one, no protected folder and no
// parent of one (the same rule as @restow/core probeEmptyAllowed).
func ProbeEmptyAllowed(p string, system []string) error {
	if err := ProbePathShape(p); err != nil {
		return err
	}
	if p == "/" {
		return errors.New("probe: / is always restored")
	}
	for _, s := range system {
		if probeUnder(s, p) {
			return fmt.Errorf("probe: %s holds the system path %s and is restored in full", p, s)
		}
	}
	for _, d := range ProbeProtectedDirs {
		if probeUnder(p, d) || probeUnder(d, p) {
			return fmt.Errorf("probe: %s is a package or system database and is restored in full", p)
		}
	}
	return nil
}

// CheckProbe checks the probe options against the manifest: every path may
// be left empty, every empty file system is a mount point of m.
func CheckProbe(m *Manifest, o *ProbeOptions) error {
	if o == nil {
		return nil
	}
	system := ProbeSystemMounts(m)
	mounts := map[string]bool{}
	if m != nil && m.Linux != nil {
		for _, mt := range m.Linux.Mounts {
			mounts[path.Clean(mt.Target)] = true
		}
		for _, e := range m.Linux.Fstab {
			mounts[path.Clean(e.Target)] = true
		}
	}
	for _, p := range o.EmptyFilesystems {
		if err := ProbeEmptyAllowed(p, system); err != nil {
			return err
		}
		if !mounts[p] {
			return fmt.Errorf("probe: %s is no mount point of the backup", p)
		}
	}
	for _, p := range o.EmptyDirs {
		if err := ProbeEmptyAllowed(p, system); err != nil {
			return err
		}
		inRoot := false
		for _, r := range ProbeFolderRoots {
			if strings.HasPrefix(p, r+"/") {
				inRoot = true
			}
		}
		if !inRoot {
			return fmt.Errorf("probe: %s is not below %s", p, strings.Join(ProbeFolderRoots, ", "))
		}
	}
	return nil
}

// probeDropped are the kernel parameters a probe removes: they hide the
// console (and Plymouth would take the passphrase prompt away from it).
var probeDropped = map[string]bool{"quiet": true, "splash": true, "rhgb": true}

// probeConsole are appended to the kernel command line of a probe.
var probeConsole = []string{"console=tty0", "console=ttyS0,115200"}

// ProbeKernelCmdline returns line without quiet, splash and rhgb and with
// the serial console (console=tty0 console=ttyS0,115200) at the end.
func ProbeKernelCmdline(line string) string {
	var out []string
	for _, f := range strings.Fields(line) {
		if probeDropped[f] || f == probeConsole[0] || f == probeConsole[1] {
			continue
		}
		out = append(out, f)
	}
	return strings.Join(append(out, probeConsole...), " ")
}

func probeDropOnly(line string) string {
	var out []string
	for _, f := range strings.Fields(line) {
		if !probeDropped[f] {
			out = append(out, f)
		}
	}
	return strings.Join(out, " ")
}

// ProbeGrubDefault rewrites /etc/default/grub for a probe: the console goes
// to GRUB_CMDLINE_LINUX (added when missing), quiet, splash and rhgb leave
// both GRUB_CMDLINE_LINUX and GRUB_CMDLINE_LINUX_DEFAULT.
func ProbeGrubDefault(data []byte) []byte {
	lines := strings.Split(string(data), "\n")
	seen := false
	for i, l := range lines {
		t := strings.TrimSpace(l)
		for _, name := range []string{"GRUB_CMDLINE_LINUX_DEFAULT", "GRUB_CMDLINE_LINUX"} {
			if !strings.HasPrefix(t, name+"=") {
				continue
			}
			v := strings.TrimPrefix(t, name+"=")
			quote := ""
			if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
				quote, v = v[:1], v[1:len(v)-1]
			}
			if name == "GRUB_CMDLINE_LINUX" {
				v, seen = ProbeKernelCmdline(v), true
			} else {
				v = probeDropOnly(v)
			}
			if quote == "" {
				quote = `"`
			}
			lines[i] = name + "=" + quote + v + quote
			break
		}
	}
	out := strings.Join(lines, "\n")
	if !seen {
		if out != "" && !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += `GRUB_CMDLINE_LINUX="` + ProbeKernelCmdline("") + "\"\n"
	}
	return []byte(out)
}

// ProbeBLSEntry rewrites the options line of a Boot Loader Specification
// entry (and the kernel command line file /etc/kernel/cmdline, which is one
// line) for a probe. An options line that only names $kernelopts (grubenv)
// is left: grubenv carries the command line then.
func ProbeBLSEntry(data []byte, wholeFile bool) []byte {
	if wholeFile {
		return []byte(ProbeKernelCmdline(strings.TrimSpace(string(data))) + "\n")
	}
	lines := bytes.Split(data, []byte("\n"))
	for i, l := range lines {
		t := strings.TrimSpace(string(l))
		if !strings.HasPrefix(t, "options") || len(t) > 7 && t[7] != ' ' && t[7] != '\t' {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(t, "options"))
		if v == "$kernelopts" {
			continue
		}
		lines[i] = []byte("options " + ProbeKernelCmdline(v))
	}
	return bytes.Join(lines, []byte("\n"))
}

// ProbeUnitName is the unit a probe installs on the restored system.
const ProbeUnitName = "restow-probe.service"

// ProbeUnit writes RESTOW-PROBE-OK <boot id> <kernel> to the first serial
// port once multi-user.target is reached, and powers the machine off. In a
// unit file %% is a literal % and $$ a literal $ (systemd.unit, "Specifiers";
// systemd.service, "Command lines").
const ProbeUnit = `# Written by restow-agent recover for the boot probe of Restow (a lab copy;
# docs/BAREMETAL.md 12.3). Never on a restored production machine.
[Unit]
Description=Restow boot probe: report the start on the serial console
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'printf "RESTOW-PROBE-OK %%s %%s\n" "$$(cat /proc/sys/kernel/random/boot_id)" "$$(uname -r)" > /dev/ttyS0; systemctl --no-block poweroff'
`

// ProbeTargetDropIn makes multi-user.target want the probe unit (a drop-in
// instead of a symbolic link in .wants: the restored tree takes only files).
const ProbeTargetDropIn = `# Written by restow-agent recover for the boot probe of Restow.
[Unit]
Wants=restow-probe.service
`
