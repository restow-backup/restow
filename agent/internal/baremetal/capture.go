package baremetal

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// ErrToolsMissing is returned when lsblk, blkid or sfdisk is not installed:
// without them the machine cannot be captured (and is not bare-metal ready).
var ErrToolsMissing = errors.New("lsblk, blkid and sfdisk (util-linux, fdisk) are required to capture the disk layout")

// ErrUnsupportedPlatform is returned by CaptureLocal outside Linux.
var ErrUnsupportedPlatform = errors.New("capturing the disk layout is supported on Linux only")

// DefaultCaptureTimeout bounds a whole capture (docs/BAREMETAL.md, 5.6).
const DefaultCaptureTimeout = 2 * time.Minute

// Options configure a capture.
type Options struct {
	Runner cmdrun.Runner
	Host   Host
	// Hostname is the name of the machine at enrollment (like --host).
	Hostname     string
	AgentVersion string
	// Hooks is the machine's hook mode (off, scripts, any).
	Hooks string
	// Now replaces the clock (tests).
	Now func() time.Time
	// Timeout of the whole capture; 0 selects DefaultCaptureTimeout.
	Timeout time.Duration
	// Arch is the architecture when /proc/sys/kernel/arch is not readable
	// (empty: runtime.GOARCH).
	Arch string
	// VGBackupDir, when set, is a private folder where vgcfgbackup writes
	// the LVM metadata for raw/<vg>.vg (tests leave it empty).
	VGBackupDir string
}

// RawSet holds the sanitized raw files of raw/ (name → content).
type RawSet map[string][]byte

// collector reads one part of the layout.
type collector struct {
	name string
	fn   func(c *capture) error
}

// collectors run in this order; later ones use what earlier ones found.
var collectors = []collector{
	{"os", captureOS},
	{"blockdev", captureBlockDevices},
	{"drivers", captureDriverChains},
	{"parttable", capturePartitionTables},
	{"bootcode", captureBootCode},
	{"md", captureMD},
	{"lvm", captureLVM},
	{"luks", captureLUKS},
	{"plaincrypt", capturePlainCrypt},
	{"filesystems", captureFilesystems},
	{"mounts", captureMounts},
	{"btrfs", captureBtrfs},
	{"swap", captureSwap},
	{"fstab", captureFstab},
	{"firmware", captureFirmware},
	{"loaders", captureLoaders},
	{"bootloader", captureBootloader},
	{"initramfs", captureInitramfs},
	{"kernels", captureKernels},
	{"dkms", captureDKMS},
	{"network", captureNetwork},
	{"configs", captureConfigs},
	{"devnames", scanDeviceNames},
	{"bootpath", checkBootPath},
}

// capture is the state of one capture.
type capture struct {
	ctx context.Context
	r   cmdrun.Runner
	h   Host
	o   Options
	m   *Manifest
	l   *LinuxLayout
	raw RawSet

	container bool
	cmdline   string // unredacted /proc/cmdline (never stored)

	nodes     []*blkNode
	byKName   map[string]*blkNode
	byPath    map[string]*blkNode
	byMajMin  map[string]*blkNode
	diskOf    map[*blkNode]string
	lvOf      map[*blkNode][2]string
	luksOf    map[*blkNode]string // the node carrying the LUKS header → c<n>
	plainOf   map[*blkNode]string // the plain dm-crypt mapping → p<n>
	mdOf      map[*blkNode]string // the md device → m<n>
	fsByUUID  map[string]*Filesystem
	fsOfNode  map[*blkNode]string
	blkid     map[string]map[string]string // device path → blkid -p export
	crypttab  []crypttabEntry
	mountinfo []mountEntry
	lvmReport *lvmFacts
}

// Capture reads the layout of the machine behind o.Host and o.Runner. It
// runs the collectors in a fixed order; a collector that fails is recorded
// as capture_failed (a warning) and the capture goes on. Only missing
// lsblk, blkid or sfdisk is fatal (ErrToolsMissing). After the collectors,
// the grow defaults are set and the manifest is assessed.
func Capture(ctx context.Context, o Options) (*Manifest, RawSet, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Timeout == 0 {
		o.Timeout = DefaultCaptureTimeout
	}
	if o.Arch == "" {
		o.Arch = runtime.GOARCH
	}
	if o.Hooks == "" {
		o.Hooks = "off"
	}
	cctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	l := &LinuxLayout{Agent: AgentInfo{Hooks: o.Hooks}, Verdict: VerdictSupported}
	m := &Manifest{Header: Header{Format: Format, SchemaVersion: SchemaVersion, Platform: PlatformLinux,
		CapturedAt:   o.Now().UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z"),
		AgentVersion: clean(o.AgentVersion), Hostname: clean(o.Hostname)}, Linux: l}
	c := &capture{ctx: cctx, r: o.Runner, h: o.Host, o: o, m: m, l: l, raw: RawSet{},
		byKName: map[string]*blkNode{}, byPath: map[string]*blkNode{}, byMajMin: map[string]*blkNode{},
		diskOf: map[*blkNode]string{}, lvOf: map[*blkNode][2]string{}, luksOf: map[*blkNode]string{},
		plainOf: map[*blkNode]string{}, mdOf: map[*blkNode]string{}, fsByUUID: map[string]*Filesystem{},
		fsOfNode: map[*blkNode]string{}, blkid: map[string]map[string]string{}}
	l.Firmware.Mode = "bios"
	l.Bootloader.Kind = "none"
	l.OS.Init = "other"
	for _, col := range collectors {
		if cctx.Err() != nil {
			c.failed(col.name, fmt.Errorf("the capture did not finish within %s", o.Timeout))
			break
		}
		if c.container && col.name != "os" && col.name != "mounts" && col.name != "fstab" && col.name != "network" && col.name != "configs" {
			continue
		}
		if err := col.fn(c); err != nil {
			if errors.Is(err, ErrToolsMissing) {
				return nil, nil, err
			}
			c.failed(col.name, err)
		}
	}
	if !c.container {
		setGrowDefaults(l)
	}
	m.normalize()
	for name, b := range c.raw {
		l.Raw = append(l.Raw, RawRef{Name: name, SHA256: sha256Hex(b)})
	}
	sort.Slice(l.Raw, func(i, j int) bool { return l.Raw[i].Name < l.Raw[j].Name })
	l.Verdict, l.Unsupported = Assess(m)
	return m, c.raw, nil
}

// failed records a collector error as a warning.
func (c *capture) failed(name string, err error) {
	c.note(CodeCaptureFailed, name, name+": "+err.Error(), SeverityWarning)
}

// note records a finding only the collectors can make.
func (c *capture) note(code, ref, message, severity string) {
	for _, u := range c.l.Unsupported {
		if u.Code == code && deref(u.Ref) == ref {
			return
		}
	}
	var r *string
	if ref != "" {
		r = strPtr(clean(ref))
	}
	if message == "" {
		message = assessMessages[code]
	}
	c.l.Unsupported = append(c.l.Unsupported, Unsupported{Code: code, Ref: r, Message: cleanString(message, maxStringBytes), Severity: severity})
}

// run runs a tool and turns a missing tool into a clear error.
func (c *capture) run(name string, args ...string) ([]byte, error) {
	out, err := c.r.Run(c.ctx, name, args...)
	if err != nil && cmdrun.IsNotFound(err) {
		return nil, fmt.Errorf("%s is not installed: %w", name, err)
	}
	return out, err
}

// addRaw stores a sanitized raw file.
func (c *capture) addRaw(name string, b []byte) {
	if len(c.raw) < maxRaw && len(b) <= 4<<20 {
		c.raw[name] = b
	}
}

// readHost reads a host file as text.
func (c *capture) readHost(p string) (string, bool) {
	b, err := c.h.ReadFile(p, 0)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// refOf returns the BlockRef of a node, or false when it is not part of
// the manifest (loop devices, unknown device mapper targets).
func (c *capture) refOf(n *blkNode) (BlockRef, bool) {
	if n == nil {
		return BlockRef{}, false
	}
	if id, ok := c.diskOf[n]; ok {
		return DiskRef(id), true
	}
	switch n.typ() {
	case "part":
		parent := c.byKName[n.str("pkname")]
		if id, ok := c.diskOf[parent]; ok && n.partNumber() > 0 {
			return PartRef(id, n.partNumber()), true
		}
	case "crypt":
		if id, ok := c.plainOf[n]; ok {
			return PlainRef(id), true
		}
		if parent := c.byKName[n.str("pkname")]; parent != nil {
			if id, ok := c.luksOf[parent]; ok {
				return LUKSRef(id), true
			}
		}
	case "lvm":
		if v, ok := c.lvOf[n]; ok {
			return LVRef(v[0], v[1]), true
		}
	}
	if id, ok := c.mdOf[n]; ok {
		return MDRef(id), true
	}
	return BlockRef{}, false
}

// nodeOfDevice finds a node by a device path or name (/dev/sda1,
// /dev/mapper/vg0-root, /dev/dm-3, sda1, 8:1).
func (c *capture) nodeOfDevice(dev string) *blkNode {
	if n := c.byPath[dev]; n != nil {
		return n
	}
	if n := c.byMajMin[dev]; n != nil {
		return n
	}
	name := strings.TrimPrefix(dev, "/dev/")
	if n := c.byKName[name]; n != nil {
		return n
	}
	if mapper, ok := strings.CutPrefix(dev, "/dev/mapper/"); ok {
		for _, n := range c.nodes {
			if n.str("name") == mapper {
				return n
			}
		}
	}
	// /dev/<vg>/<lv>
	if parts := strings.Split(strings.TrimPrefix(dev, "/dev/"), "/"); len(parts) == 2 {
		for n, v := range c.lvOf {
			if v[0] == parts[0] && v[1] == parts[1] {
				return n
			}
		}
	}
	return nil
}

// nodeOfSpec resolves an fstab/crypttab source (UUID=, LABEL=, PARTUUID=,
// PARTLABEL=, /dev/disk/by-*/..., a device path).
func (c *capture) nodeOfSpec(spec string) *blkNode {
	spec = strings.Trim(spec, `"`)
	key, val, ok := strings.Cut(spec, "=")
	if ok && !strings.HasPrefix(spec, "/") {
		field := map[string]string{"UUID": "uuid", "LABEL": "label", "PARTUUID": "partuuid", "PARTLABEL": "partlabel"}[strings.ToUpper(key)]
		if field == "" {
			return nil
		}
		for _, n := range c.nodes {
			if strings.EqualFold(n.str(field), val) {
				return n
			}
		}
		return nil
	}
	for _, by := range []struct{ prefix, field string }{
		{"/dev/disk/by-uuid/", "uuid"}, {"/dev/disk/by-label/", "label"},
		{"/dev/disk/by-partuuid/", "partuuid"}, {"/dev/disk/by-partlabel/", "partlabel"},
	} {
		if v, ok := strings.CutPrefix(spec, by.prefix); ok {
			v = unescapeUdev(v)
			for _, n := range c.nodes {
				if strings.EqualFold(n.str(by.field), v) {
					return n
				}
			}
			return nil
		}
	}
	if v, ok := strings.CutPrefix(spec, "/dev/disk/by-id/"); ok {
		for _, n := range c.nodes {
			if id := n.str("wwn"); id != "" && strings.Contains(v, strings.TrimPrefix(id, "0x")) {
				return n
			}
		}
		return nil
	}
	return c.nodeOfDevice(spec)
}

// unescapeUdev decodes \x20 escapes of /dev/disk/by-label names.
func unescapeUdev(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && s[i+1] == 'x' {
			var v byte
			if _, err := fmt.Sscanf(s[i+2:i+4], "%02x", &v); err == nil {
				b.WriteByte(v)
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
