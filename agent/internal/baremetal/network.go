package baremetal

import (
	"bufio"
	"bytes"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
)

var (
	rePCIAddr = regexp.MustCompile(`^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$`)
	reMAC     = regexp.MustCompile(`(?i)\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b`)
	reDevName = regexp.MustCompile(`/dev/(?:sd[a-z]+[0-9]*|hd[a-z]+[0-9]*|vd[a-z]+[0-9]*|xvd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(?:p[0-9]+)?|mmcblk[0-9]+(?:p[0-9]+)?)`)
)

// captureNetwork lists the network interfaces (/sys/class/net) with MAC,
// driver, modalias and PCI path, and the configuration files that name a
// MAC address (netplan, NetworkManager, ifcfg, udev rules, networkd).
func captureNetwork(c *capture) error {
	ents, err := c.h.ReadDir("/sys/class/net")
	if err != nil {
		return nil
	}
	for _, e := range ents {
		name := e.Name()
		if name == "lo" || name == "bonding_masters" || len(c.l.Network) >= maxNetwork {
			continue
		}
		ni := NetInterface{Name: clean(name)}
		base := "/sys/class/net/" + name
		if mac, ok := readString(c.h, base+"/address"); ok && mac != "" && mac != "00:00:00:00:00:00" {
			ni.MAC = strPtr(clean(strings.ToLower(mac)))
		}
		if real, ok := resolveLink(c.h, base); ok && !strings.Contains(real, "/devices/virtual/") {
			dev := path.Dir(path.Dir(real))
			ni.Physical = true
			if drv, ok := resolveLink(c.h, dev+"/driver"); ok {
				ni.Driver = strPtr(clean(path.Base(drv)))
			}
			if a, ok := readString(c.h, dev+"/modalias"); ok && a != "" {
				ni.Modalias = strPtr(clean(a))
			}
			if b := path.Base(dev); rePCIAddr.MatchString(b) {
				ni.PCIPath = strPtr(b)
			}
		}
		c.l.Network = append(c.l.Network, ni)
	}
	var files []string
	for _, pat := range []string{"/etc/netplan/*.yaml", "/etc/NetworkManager/system-connections/*", "/etc/sysconfig/network-scripts/ifcfg-*",
		"/etc/udev/rules.d/*.rules", "/etc/systemd/network/*.network", "/etc/systemd/network/*.link", "/etc/network/interfaces"} {
		m, _ := c.h.Glob(pat)
		files = append(files, m...)
	}
	for _, f := range files {
		if len(c.l.NetConfigs) >= maxNetConfigs {
			break
		}
		b, err := c.h.ReadFile(f, 1<<20)
		if err != nil {
			continue
		}
		macs := map[string]bool{}
		for _, m := range reMAC.FindAllString(string(b), -1) {
			macs[strings.ToLower(m)] = true
		}
		if len(macs) > 0 {
			c.l.NetConfigs = append(c.l.NetConfigs, NetConfigRef{Path: clean(f), MACs: sortedKeys(macs)})
		}
	}
	return nil
}

// configFiles are hashed (their content is in the snapshot).
var configFiles = []string{"/etc/fstab", "/etc/crypttab", "/etc/mdadm/mdadm.conf", "/etc/mdadm.conf", "/etc/default/grub",
	"/etc/kernel/cmdline", "/etc/lvm/lvm.conf", "/etc/lvm/devices/system.devices", "/etc/initramfs-tools/conf.d/resume",
	"/etc/vconsole.conf", "/etc/default/keyboard"}

// captureConfigs records path and SHA-256 of the configuration files a
// restore adjusts.
func captureConfigs(c *capture) error {
	for _, p := range configFiles {
		if b, err := c.h.ReadFile(p, 1<<20); err == nil {
			c.l.Configs = append(c.l.Configs, FileHash{Path: p, SHA256: sha256Hex(b)})
		}
	}
	return nil
}

// fixupFiles are adjusted by the restore anyway (docs/BAREMETAL.md, 10.13);
// device names in them are no finding.
var fixupFiles = map[string]bool{"/etc/fstab": true, "/etc/crypttab": true, "/etc/mdadm/mdadm.conf": true, "/etc/mdadm.conf": true,
	"/etc/default/grub": true, "/etc/kernel/cmdline": true, "/etc/lvm/lvm.conf": true, "/etc/initramfs-tools/conf.d/resume": true}

// skipEtcDirs hold no configuration that names devices, or secrets.
var skipEtcDirs = map[string]bool{"/etc/ssl": true, "/etc/pki": true, "/etc/ca-certificates": true, "/etc/restow-agent": true,
	"/etc/restow-pve": true, "/etc/alternatives": true, "/etc/selinux": true, "/etc/fonts": true, "/etc/X11": true, "/etc/lvm/archive": true,
	"/etc/lvm/backup": true, "/etc/udev/hwdb.d": true, "/etc/ld.so.cache": true}

const (
	maxEtcFiles   = 20000
	maxEtcFileLen = 1 << 20
)

// scanDeviceNames finds kernel device names (/dev/sda1, /dev/nvme0n1p2, ...)
// in text files below /etc, for display (docs/BAREMETAL.md, 10.13).
func scanDeviceNames(c *capture) error {
	files := 0
	var walk func(dir string)
	walk = func(dir string) {
		ents, err := c.h.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range ents {
			if files >= maxEtcFiles || len(c.l.DeviceNameRefs) >= maxDeviceNameRefs || c.ctx.Err() != nil {
				return
			}
			p := path.Join(dir, e.Name())
			if skipEtcDirs[p] {
				continue
			}
			if e.IsDir() {
				walk(p)
				continue
			}
			if e.Type()&fs.ModeType != 0 || fixupFiles[p] {
				continue
			}
			files++
			b, err := c.h.ReadFile(p, maxEtcFileLen)
			if err != nil || bytes.IndexByte(b, 0) >= 0 {
				continue
			}
			sc := bufio.NewScanner(bytes.NewReader(b))
			sc.Buffer(make([]byte, 64<<10), maxEtcFileLen)
			line := int64(0)
			for sc.Scan() {
				line++
				t := sc.Text()
				if strings.HasPrefix(strings.TrimSpace(t), "#") {
					continue
				}
				for _, m := range reDevName.FindAllString(t, -1) {
					if len(c.l.DeviceNameRefs) >= maxDeviceNameRefs {
						break
					}
					c.l.DeviceNameRefs = append(c.l.DeviceNameRefs, DeviceNameRef{Path: clean(p), Line: line, Device: m})
				}
			}
		}
	}
	walk("/etc")
	sort.SliceStable(c.l.DeviceNameRefs, func(i, j int) bool { return c.l.DeviceNameRefs[i].Path < c.l.DeviceNameRefs[j].Path })
	return nil
}

// allowedBootTypes are the lsblk types in the path to /, /boot and the ESP.
var allowedBootTypes = map[string]bool{"disk": true, "part": true, "crypt": true, "lvm": true, "md": true}

// checkBootPath walks from the devices of /, /boot, /boot/efi and /efi up
// to the disks and reports a device of a kind 0.5.0 cannot recreate.
func checkBootPath(c *capture) error {
	markRawLVs(c)
	var check func(n *blkNode, depth int)
	check = func(n *blkNode, depth int) {
		if n == nil || depth > 16 {
			return
		}
		t := n.typ()
		switch {
		case t == "mpath":
			c.note(CodeMultipathUnsupported, n.kname(), "", SeverityUnsupported)
		case !allowedBootTypes[t] && !strings.HasPrefix(t, "raid"):
			c.note(CodeUnknownDeviceInBootPath, n.kname(), "device "+n.kname()+" ("+t+") is in the path to a system mount", SeverityUnsupported)
		}
		if t == "disk" {
			return
		}
		// md arrays have several parents; lsblk lists the array below each.
		for _, p := range c.parentsOf(n) {
			check(p, depth+1)
		}
	}
	for _, m := range c.mountinfo {
		if m.Target != "/" && m.Target != "/boot" && m.Target != "/boot/efi" && m.Target != "/efi" {
			continue
		}
		if PseudoFSTypes[m.FSType] || networkFSTypes[m.FSType] {
			continue
		}
		if n := c.mountNode(m.MountInfo); n != nil {
			check(n, 0)
		}
	}
	return nil
}

// parentsOf returns every node that lists n as a child.
func (c *capture) parentsOf(n *blkNode) []*blkNode {
	var out []*blkNode
	for _, p := range c.nodes {
		for _, ch := range p.children {
			if ch == n {
				out = append(out, p)
			}
		}
	}
	return out
}
