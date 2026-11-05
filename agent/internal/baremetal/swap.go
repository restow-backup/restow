package baremetal

import (
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// captureSwap records the active swap areas from /proc/swaps: partitions
// and LVs, plain dm-crypt swap, swap files (with the file system they are
// on and the resume offset).
func captureSwap(c *capture) error {
	b, ok := c.readHost("/proc/swaps")
	if !ok {
		return nil
	}
	for _, s := range sysparse.ParseProcSwaps([]byte(b)) {
		if len(c.l.Swap) >= maxSwap {
			break
		}
		sw := Swap{SizeBytes: s.SizeKiB * 1024, Priority: clean(s.Priority)}
		if sw.Priority == "" {
			sw.Priority = "-1"
		}
		switch s.Type {
		case "file":
			sw.Kind = "file"
			sw.Path = strPtr(clean(s.Filename))
			if m := c.mountOf(s.Filename); m != nil && m.fs != "" {
				sw.FS = strPtr(m.fs)
				sw.ResumeOffset = c.resumeOffset(s.Filename, m.FSType)
			}
		default:
			n := c.nodeOfDevice(s.Filename)
			if n == nil {
				// zram and other devices that are not part of the stack.
				if strings.HasPrefix(strings.TrimPrefix(s.Filename, "/dev/"), "zram") {
					continue
				}
				c.note(CodeCaptureFailed, "swap", "swap device "+s.Filename+" is not a known device", SeverityWarning)
				continue
			}
			ref, ok := c.refOf(n)
			if !ok {
				continue
			}
			sw.Kind = "partition"
			if ref.Kind == RefPlain {
				sw.Kind = "plain"
			}
			sw.Device = &ref
			if sw.Kind != "plain" {
				sw.UUID = cleanPtr(n.str("uuid"))
				sw.Label = cleanPtr(n.str("label"))
			}
		}
		c.l.Swap = append(c.l.Swap, sw)
	}
	return nil
}

// resumeOffset is the resume_offset of a swap file: the first physical
// block, from `btrfs inspect-internal map-swapfile -r` or `filefrag -v`.
func (c *capture) resumeOffset(file, fstype string) *int64 {
	if fstype == "btrfs" {
		out, err := c.run("btrfs", "inspect-internal", "map-swapfile", "-r", file)
		if err == nil {
			if n, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); err == nil {
				return &n
			}
		}
		return nil
	}
	out, err := c.run("filefrag", "-v", file)
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(strings.ReplaceAll(line, ":", " "))
		// "   0:        0..       0:      34816..     34816:      1:"
		if len(f) >= 4 && f[0] == "0" {
			v := strings.TrimSuffix(f[3], "..")
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				return &n
			}
		}
	}
	return nil
}
