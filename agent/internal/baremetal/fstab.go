package baremetal

import (
	"path"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// captureFstab reads /etc/fstab and the mount, swap and automount units in
// /etc/systemd/system, and resolves each source to a file system, a swap
// area or a block device of the manifest (nil: not resolvable).
func captureFstab(c *capture) error {
	if b, ok := c.readHost("/etc/fstab"); ok {
		for _, e := range sysparse.ParseFstab([]byte(b)) {
			if len(c.l.Fstab) >= maxFstab {
				break
			}
			c.l.Fstab = append(c.l.Fstab, c.fstabEntry(e.Source, e.Target, e.Type, e.Options, "fstab", ""))
		}
	}
	units, _ := c.h.Glob("/etc/systemd/system/*.mount")
	swaps, _ := c.h.Glob("/etc/systemd/system/*.swap")
	autos, _ := c.h.Glob("/etc/systemd/system/*.automount")
	automount := map[string]bool{}
	for _, p := range autos {
		if b, ok := c.readHost(p); ok {
			if u, ok := sysparse.ParseSystemdMountUnit([]byte(b)); ok && u.Where != "" {
				automount[u.Where] = true
			}
		}
	}
	for _, p := range append(units, swaps...) {
		b, ok := c.readHost(p)
		if !ok || len(c.l.Fstab) >= maxFstab {
			continue
		}
		u, ok := sysparse.ParseSystemdMountUnit([]byte(b))
		if !ok {
			continue
		}
		typ, target := u.Type, u.Where
		if u.Section == "Swap" {
			typ, target = "swap", "none"
		}
		if typ == "" {
			typ = "auto"
		}
		opts := u.Options
		if opts == "" {
			opts = "defaults"
		}
		e := c.fstabEntry(u.What, target, typ, opts, "unit", path.Base(p))
		if automount[u.Where] {
			e.Automount = true
		}
		c.l.Fstab = append(c.l.Fstab, e)
	}
	return nil
}

func (c *capture) fstabEntry(source, target, typ, options, origin, unit string) FstabEntry {
	e := FstabEntry{Source: clean(source), Target: clean(target), Type: clean(typ), Options: clean(options), Origin: origin,
		Noauto: sysparse.HasOption(options, "noauto"), Nofail: sysparse.HasOption(options, "nofail"),
		Automount: sysparse.HasOption(options, "x-systemd.automount")}
	if unit != "" {
		e.Unit = strPtr(clean(unit))
	}
	if networkFSTypes[typ] || sysparse.HasOption(options, "bind") || sysparse.HasOption(options, "_netdev") && !strings.HasPrefix(source, "/dev/") {
		return e
	}
	if typ == "swap" {
		for i, s := range c.l.Swap {
			if s.Path != nil && *s.Path == source {
				e.Resolved = &FstabResolved{Swap: intPtr(int64(i))}
				return e
			}
		}
	}
	n := c.nodeOfSpec(source)
	if n == nil {
		// A swap file named by path, or a file system not present.
		return e
	}
	ref, ok := c.refOf(n)
	if typ == "swap" && ok {
		for i, s := range c.l.Swap {
			if s.Device != nil && *s.Device == ref {
				e.Resolved = &FstabResolved{Swap: intPtr(int64(i))}
				return e
			}
		}
	}
	if id := c.fsOfNode[n]; id != "" {
		e.Resolved = &FstabResolved{FS: strPtr(id)}
		return e
	}
	if ok {
		e.Resolved = &FstabResolved{Block: &ref}
	}
	return e
}
