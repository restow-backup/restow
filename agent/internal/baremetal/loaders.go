package baremetal

import (
	"fmt"
	"path"
	"strings"
)

// GPT partition types of the boot partitions.
const (
	espGUID      = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
	xbootldrGUID = "bc13c2ff-59e6-4262-a352-b275fd6f7172"
	biosBootGUID = "21686148-6449-6e6f-744e-656564454649"
)

// bootPartitions returns the file systems on an ESP and on an XBOOTLDR
// partition (by partition type).
func (c *capture) bootPartitions() (esps []string, xbootldr string) {
	for _, fs := range c.l.Filesystems {
		if fs.Type != "vfat" && fs.Type != "ext4" && fs.Type != "ext2" && fs.Type != "ext3" && fs.Type != "xfs" && fs.Type != "btrfs" {
			continue
		}
		for _, d := range fs.Devices {
			if d.Kind != RefPartition {
				continue
			}
			t := strings.ToLower(c.partitionType(d))
			switch {
			case (t == espGUID || t == "ef") && fs.Type == "vfat":
				esps = append(esps, fs.ID)
			case t == xbootldrGUID && xbootldr == "":
				xbootldr = fs.ID
			}
		}
	}
	return esps, xbootldr
}

func (c *capture) partitionType(r BlockRef) string {
	for _, d := range c.l.Disks {
		if d.ID != r.Disk || d.Table == nil {
			continue
		}
		for _, p := range d.Table.Partitions {
			if p.Number == r.Number {
				return p.Type
			}
		}
	}
	return ""
}

// mountTargetOf returns the first mount point of a file system, or "".
func (c *capture) mountTargetOf(fsID string) string {
	for _, m := range c.mountinfo {
		if m.fs == fsID && m.Root == "/" {
			return m.Target
		}
	}
	return ""
}

// captureLoaders inspects every PE file on the ESPs and XBOOTLDR
// (EFI/**/*.efi, EFI/Linux/*.efi).
func captureLoaders(c *capture) error {
	esps, xb := c.bootPartitions()
	if xb != "" {
		esps = append(esps, xb)
	}
	var errs []string
	for _, id := range esps {
		mnt := c.mountTargetOf(id)
		if mnt == "" {
			continue
		}
		for _, f := range c.findEFIFiles(mnt) {
			if len(c.l.Loaders) >= maxLoaders {
				break
			}
			r, size, err := c.h.Open(f)
			if err != nil {
				continue
			}
			info, err := InspectLoader(r, size)
			r.Close()
			if err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", f, err))
				continue
			}
			ld := Loader{Path: clean(f), Bytes: info.Bytes, AuthenticodeSha256: info.AuthenticodeSha256, Signer: info.Signer,
				Sbat: info.Sbat, UKI: info.UKI}
			if info.UKI && info.UKICmdline != "" && len(info.UKICmdline) <= maxStringBytes {
				ld.UKICmdline = strPtr(cleanString(info.UKICmdline, maxStringBytes))
			}
			c.l.Loaders = append(c.l.Loaders, ld)
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// findEFIFiles lists *.efi below <mnt>/EFI (any case), at most four levels.
func (c *capture) findEFIFiles(mnt string) []string {
	var out []string
	ents, err := c.h.ReadDir(mnt)
	if err != nil {
		return nil
	}
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > 4 || len(out) >= maxLoaders {
			return
		}
		list, err := c.h.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range list {
			p := path.Join(dir, e.Name())
			switch {
			case e.IsDir():
				walk(p, depth+1)
			case strings.HasSuffix(strings.ToLower(e.Name()), ".efi") && e.Type().IsRegular():
				out = append(out, p)
			}
		}
	}
	for _, e := range ents {
		if e.IsDir() && strings.EqualFold(e.Name(), "EFI") {
			walk(path.Join(mnt, e.Name()), 1)
		}
	}
	return out
}
