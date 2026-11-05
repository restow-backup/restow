package baremetal

import (
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// PseudoFSTypes are file systems that hold no data of their own; they are
// left out of mounts and of a whole-machine backup (docs/BAREMETAL.md, 5.2).
var PseudoFSTypes = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true, "ramfs": true,
	"cgroup": true, "cgroup2": true, "securityfs": true, "debugfs": true, "tracefs": true, "bpf": true,
	"pstore": true, "efivarfs": true, "configfs": true, "fusectl": true, "mqueue": true, "hugetlbfs": true,
	"binfmt_misc": true, "rpc_pipefs": true, "nsfs": true, "overlay": true, "squashfs": true,
	"selinuxfs": true, "autofs": false, "fuse.gvfsd-fuse": true, "fuse.portal": true, "fuse.lxcfs": true,
	"nfsd": true, "zonefs": false, "devfs": true, "rootfs": true,
}

// mountEntry is a mountinfo line with the file system it belongs to.
type mountEntry struct {
	sysparse.MountInfo
	fs string
}

// captureMounts reads /proc/self/mountinfo: every mount except pseudo
// file systems, with the file system id, subvolume and autofs flag.
func captureMounts(c *capture) error {
	b, ok := c.readHost("/proc/self/mountinfo")
	if !ok {
		return errNotReadable("/proc/self/mountinfo")
	}
	mi, err := sysparse.ParseMountinfo([]byte(b))
	if err != nil {
		return err
	}
	c.addRaw("mountinfo.txt", []byte(b))
	for _, e := range mi {
		me := mountEntry{MountInfo: e}
		if n := c.mountNode(e); n != nil {
			me.fs = c.fsOfNode[n]
		}
		c.mountinfo = append(c.mountinfo, me)
		if PseudoFSTypes[e.FSType] || strings.HasPrefix(e.FSType, "fuse.") && e.FSType != "fuse.sshfs" {
			continue
		}
		if len(c.l.Mounts) >= maxMounts {
			break
		}
		mo := Mount{Target: clean(e.Target), Source: clean(e.Source), Type: clean(e.FSType), Options: clean(e.Options), Autofs: e.FSType == "autofs"}
		if me.fs != "" {
			mo.FS = strPtr(me.fs)
		}
		if v, ok := e.Option("subvol"); ok && e.FSType == "btrfs" {
			mo.Subvol = strPtr(clean(v))
		}
		if v, ok := e.Option("subvolid"); ok && e.FSType == "btrfs" {
			if x, err := strconv.ParseInt(v, 10, 64); err == nil {
				mo.SubvolID = &x
			}
		}
		c.l.Mounts = append(c.l.Mounts, mo)
	}
	return nil
}

// mountNode finds the device of a mount: by major:minor, else (btrfs uses
// anonymous device numbers) by the source path.
func (c *capture) mountNode(e sysparse.MountInfo) *blkNode {
	if e.FSType != "btrfs" {
		if n := c.byMajMin[e.MajMin]; n != nil {
			return n
		}
	}
	if strings.HasPrefix(e.Source, "/dev/") {
		return c.nodeOfDevice(e.Source)
	}
	return nil
}

// mountOf returns the mount entry whose target holds p (longest prefix).
func (c *capture) mountOf(p string) *mountEntry {
	var best *mountEntry
	for i := range c.mountinfo {
		m := &c.mountinfo[i]
		if PseudoFSTypes[m.FSType] {
			continue
		}
		if under(p, m.Target) && (best == nil || len(m.Target) >= len(best.Target)) {
			best = m
		}
	}
	return best
}

// under reports whether p is dir or below it.
func under(p, dir string) bool {
	if dir == "/" {
		return strings.HasPrefix(p, "/")
	}
	return p == dir || strings.HasPrefix(p, dir+"/")
}

type notReadable string

func (e notReadable) Error() string { return string(e) + " is not readable" }

func errNotReadable(p string) error { return notReadable(p) }
