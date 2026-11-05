package baremetal

import (
	"fmt"
	iofs "io/fs"
	"path"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// noCowDepth and noCowMaxDirs bound the lsattr scan below a btrfs mount.
const (
	noCowDepth   = 4
	noCowMaxDirs = 512
	lsattrBatch  = 128
)

// captureBtrfs reads, for each mounted btrfs file system, the profiles
// (`btrfs filesystem usage --raw`), every subvolume (`btrfs subvolume list
// -a -p -u -q` and `-r` for the read-only ones), the default subvolume,
// whether quota is on and the folders with No_COW (`lsattr -d`).
func captureBtrfs(c *capture) error {
	var errs []string
	for i := range c.l.Filesystems {
		fs := &c.l.Filesystems[i]
		if fs.Btrfs == nil {
			continue
		}
		mnt := ""
		var targets []mountEntry
		for _, m := range c.mountinfo {
			if m.fs == fs.ID {
				targets = append(targets, m)
				if mnt == "" {
					mnt = m.Target
				}
			}
		}
		if mnt == "" {
			continue
		}
		b := fs.Btrfs
		if out, err := c.run("btrfs", "filesystem", "usage", "--raw", mnt); err == nil {
			if u, err := sysparse.ParseBtrfsUsageRaw(out); err == nil {
				b.DataProfile, b.MetadataProfile, b.SystemProfile = u.DataProfile, u.MetadataProfile, u.SystemProfile
				if fs.UsedBytes == 0 {
					fs.UsedBytes = u.Used
				}
			}
		} else {
			errs = append(errs, fmt.Sprintf("btrfs filesystem usage %s: %v", mnt, err))
		}
		out, err := c.run("btrfs", "subvolume", "list", "-a", "-p", "-u", "-q", mnt)
		if err != nil {
			errs = append(errs, fmt.Sprintf("btrfs subvolume list %s: %v", mnt, err))
			continue
		}
		c.addRaw("btrfs-subvolumes-"+deref(fs.UUID)+".txt", out)
		list, err := sysparse.ParseBtrfsSubvolumeList(out)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		ro := map[int64]bool{}
		if out, err := c.run("btrfs", "subvolume", "list", "-a", "-r", mnt); err == nil {
			if l, err := sysparse.ParseBtrfsSubvolumeList(out); err == nil {
				for _, s := range l {
					ro[s.ID] = true
				}
			}
		}
		for _, s := range list {
			if len(b.Subvolumes) >= maxSubvolumes {
				c.note(CodeCaptureFailed, "btrfs", fmt.Sprintf("more than %d subvolumes; the rest is not recorded", maxSubvolumes), SeverityWarning)
				break
			}
			sv := Subvolume{ID: s.ID, Path: clean(s.Path), ParentID: s.Parent, UUID: clean(s.UUID), ParentUUID: cleanPtr(s.ParentUUID),
				ReadOnly: ro[s.ID], Mounted: []string{}, Kind: subvolKind(s.Path)}
			for _, m := range targets {
				if v, ok := m.Option("subvolid"); ok && v == strconv.FormatInt(s.ID, 10) {
					sv.Mounted = append(sv.Mounted, clean(m.Target))
				}
			}
			b.Subvolumes = append(b.Subvolumes, sv)
		}
		if out, err := c.run("btrfs", "subvolume", "get-default", mnt); err == nil {
			b.DefaultSubvolume = parseGetDefault(string(out))
		}
		if _, err := c.run("btrfs", "qgroup", "show", mnt); err == nil {
			b.Quota = true
		}
		b.NoCowDirs = c.noCowDirs(targets)
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// SubvolKind classifies a subvolume by its path below the top level
// (SubvolNormal, SubvolSnapper, ...).
func SubvolKind(p string) string { return subvolKind(p) }

// subvolKind classifies a subvolume by its path below the top level.
func subvolKind(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		switch {
		case part == ".restow-snapshots":
			return SubvolRestow
		case part == ".snapshots" || part == "@snapshots" || part == "@.snapshots":
			return SubvolSnapper
		case i == 0 && (part == "timeshift-btrfs" || part == "@timeshift"):
			return SubvolTimeshift
		}
	}
	if strings.Contains(p, "var/lib/docker/btrfs/subvolumes/") || strings.Contains(p, "var/lib/containers/storage/btrfs/subvolumes/") {
		return SubvolDocker
	}
	if strings.HasSuffix(p, "var/lib/machines") || strings.HasSuffix(p, "var/lib/portables") ||
		strings.Contains(p, "var/lib/machines/") || strings.Contains(p, "var/lib/portables/") {
		return SubvolMachines
	}
	return SubvolNormal
}

// parseGetDefault reads `btrfs subvolume get-default`: "ID 5 (FS_TREE)" or
// "ID 256 gen 10 top level 5 path @".
func parseGetDefault(out string) SubvolRef {
	ref := SubvolRef{ID: 5, Path: ""}
	t := strings.TrimSpace(out)
	f := strings.Fields(t)
	if len(f) >= 2 && f[0] == "ID" {
		if id, err := strconv.ParseInt(f[1], 10, 64); err == nil {
			ref.ID = id
		}
	}
	if i := strings.Index(t, " path "); i >= 0 {
		ref.Path = clean(strings.TrimPrefix(t[i+len(" path "):], "<FS_TREE>/"))
	}
	return ref
}

// noCowCandidates lists the folders up to noCowDepth below each mount of a
// btrfs file system, without entering other mounts, sorted.
func noCowCandidates(h Host, roots []string, otherMounts map[string]bool) []string {
	var out []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if len(out) >= noCowMaxDirs || depth > noCowDepth {
			return
		}
		ents, err := h.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range ents {
			if !e.IsDir() || e.Type()&iofs.ModeSymlink != 0 {
				continue
			}
			p := path.Join(dir, e.Name())
			if otherMounts[p] {
				continue
			}
			if len(out) >= noCowMaxDirs {
				return
			}
			out = append(out, p)
			walk(p, depth+1)
		}
	}
	for _, r := range roots {
		walk(r, 1)
	}
	return out
}

// noCowDirs runs `lsattr -d` over the candidate folders and keeps those
// with the No_COW attribute (C).
func (c *capture) noCowDirs(targets []mountEntry) []string {
	mine := map[string]bool{}
	var roots []string
	for _, m := range targets {
		mine[m.Target] = true
		roots = append(roots, m.Target)
	}
	other := map[string]bool{}
	for _, m := range c.mountinfo {
		if !mine[m.Target] {
			other[m.Target] = true
		}
	}
	cands := noCowCandidates(c.h, roots, other)
	out := []string{}
	for i := 0; i < len(cands); i += lsattrBatch {
		end := i + lsattrBatch
		if end > len(cands) {
			end = len(cands)
		}
		args := append([]string{"-d"}, cands[i:end]...)
		res, err := c.r.Run(c.ctx, "lsattr", args...)
		if err != nil && len(res) == 0 {
			continue
		}
		for _, line := range strings.Split(string(res), "\n") {
			flags, p, ok := strings.Cut(strings.TrimSpace(line), " ")
			if ok && strings.Contains(flags, "C") {
				out = append(out, clean(strings.TrimSpace(p)))
			}
		}
	}
	return out
}
