package oneshot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/oneshot/payload"
	"github.com/restow-backup/restow/agent/internal/recovery"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// Exit codes of restow-agent oneshot. Every code but ExitOK means the
// machine was not changed.
const (
	ExitOK    = 0
	ExitError = 1
	ExitUsage = 2
	// ExitRefused: a check refused this machine (memory, network, kexec,
	// an enrolled agent, the ISO).
	ExitRefused = 3
	// ExitEnded: the session ended in Restow (rejected, expired, cancelled)
	// or the operator did not confirm.
	ExitEnded = 4
)

// Paths the command reads on the fresh machine.
const (
	authorizedKeys   = "/root/.ssh/authorized_keys"
	instanceDataPath = "/run/cloud-init/instance-data.json"
	minRAMBytes      = 2 << 30
	warnRAMBytes     = 4 << 30
	maxSigBytes      = 64 << 10
	// maxWaitFailures bounds the polls in a row without an answer.
	maxWaitFailures = 12
)

// StateFiles are the state of an enrolled Restow agent (the agent's own,
// agent/internal/paths, and the Proxmox VE node helper's, internal/pve):
// either one says that this is no fresh machine.
var StateFiles = []string{"/etc/restow-agent/state.json", "/etc/restow-pve/state.json"}

// Env is the machine: files, programs, the disks and kexec.
type Env interface {
	ReadFile(path string) ([]byte, error)
	// ReadDir lists the names in a directory.
	ReadDir(path string) ([]string, error)
	Exists(path string) bool
	// Output runs a program (argv, no shell) and returns its standard
	// output, also when it exits with a status other than 0.
	Output(ctx context.Context, argv ...string) ([]byte, error)
	// Hardware reads the disks and network cards like the recovery ISO.
	Hardware(ctx context.Context) (recovery.HardwareInput, error)
	// UsedBytes is what is stored outside /usr and /var/cache.
	UsedBytes() int64
	// ISOFile is a new, empty file for the recovery ISO (below
	// /var/tmp/restow-oneshot).
	ISOFile() (ISOFile, error)
	// Memfd copies what fill writes into a new file in memory (memfd,
	// close-on-exec): the kernel and the initrd never touch a disk.
	Memfd(name string, fill func(io.Writer) error) (Blob, error)
	// KexecFileLoad loads a kernel and an initrd from memfds with a command
	// line (kexec_file_load); KexecUnload unloads it again.
	KexecFileLoad(kernel, initrd Blob, cmdline string) error
	KexecUnload() error
	// KexecLoaded reads /sys/kernel/kexec_loaded.
	KexecLoaded() bool
	// Kexec shuts the machine down and starts the loaded kernel. It is the
	// point of no return (docs/BAREMETAL-ONESHOT.md 5.3): it returns
	// ErrCancelled only when ctx ended before anything was started.
	Kexec(ctx context.Context) error
	// Cleanup removes the work files (the ISO).
	Cleanup()
	// HasTool reports whether a program is in the root-owned tool folders.
	HasTool(name string) bool
	// DeviceOf is the device number (major:minor) a path lives on, or of
	// the device itself for a block device (a swap partition).
	DeviceOf(path string) (string, error)
	// WriteSessionData writes the session data for recover in the direct
	// mode (root, /run/restow-oneshot 0700, the file 0600) and returns its
	// path; RemoveSessionData removes it again.
	WriteSessionData(data []byte) (string, error)
	RemoveSessionData(path string)
	// RunRecover runs recover on this console with the session data and
	// returns its exit code.
	RunRecover(ctx context.Context, dataPath, resticBin string) int
}

// Blob is a file in memory made by Env.Memfd.
type Blob interface {
	Close() error
}

// ErrCancelled: the switch was cancelled (Ctrl+C, the session's end of the
// terminal) before the point of no return; the machine is unchanged.
var ErrCancelled = errors.New("cancelled before the switch")

// ISOFile is the file the recovery ISO is downloaded to.
type ISOFile interface {
	io.Writer
	io.ReaderAt
	Close() error
}

// Options are the inputs of the command.
type Options struct {
	Instance string
	Code     string
	Answers  *Answers
	Trust    ISOTrust
	// HTTP is the client for the instance; SPKI returns the SHA-256 of the
	// public key of the certificate the last verified connection showed.
	HTTP      *http.Client
	SPKI      func() string
	CAPEM     []byte
	AllowHTTP bool
	Lang      string
	Keymap    string
	Version   string
	// Direct: run recover in the provider's rescue system itself instead of
	// switching with kexec (--direct, docs/BAREMETAL-ONESHOT.md 17.1);
	// ResticBin is the checked restic for it.
	Direct    bool
	ResticBin string
	// Poll is the interval of the wait for the release (default 5 s).
	Poll time.Duration
}

// Command is one run of restow-agent oneshot.
type Command struct {
	UI   *recovery.UI
	Env  Env
	Opts Options
	// Log takes a line for the protocol (never a secret: lines go through
	// the redactor).
	Log func(string)

	session *recovery.Session
	m       *machine
}

// machine is what the command measured before the exchange.
type machine struct {
	target   api.OneshotTarget
	checks   api.OneshotChecks
	hw       api.RecoveryHardware
	disks    []baremetal.TargetDisk
	keys     []string
	keyInfo  []api.OneshotSSHKey
	fatal    []string
	warnings []string
	signs    []string
}

func (c *Command) logf(format string, a ...any) {
	if c.Log != nil {
		c.Log(redact.Redact(fmt.Sprintf(format, a...)))
	}
}

// Run runs the command; it returns only when the machine did not switch
// (or, in tests, when the fake switch returned).
func (c *Command) Run(ctx context.Context) int {
	defer c.Env.Cleanup()
	u := c.UI
	norm, err := recovery.NormalizeOneshotCode(c.Opts.Code)
	if err != nil {
		u.Say("oneshot.code_invalid")
		return ExitUsage
	}
	redact.Add(norm, recovery.FormatOneshotCode(norm), strings.TrimSpace(c.Opts.Code))
	u.Say("oneshot.title", "version", c.Opts.Version)
	m, err := c.measure(ctx)
	if err != nil {
		u.Raw(err.Error())
		return ExitError
	}
	c.m = m
	c.showMachine()
	if len(m.fatal) > 0 {
		for _, f := range m.fatal {
			u.Line(f)
		}
		u.Say("oneshot.unchanged")
		return ExitRefused
	}
	for _, w := range m.warnings {
		u.Line(w)
	}
	// The code is spent from here on.
	out, code := c.exchange(ctx, norm)
	if code != ExitOK {
		return code
	}
	extras := out.Oneshot
	if extras.Needs.RAMBytes > 0 && m.checks.MemTotalBytes < extras.Needs.RAMBytes {
		m.checks.Warnings = appendUnique(m.checks.Warnings, "ram_below_need")
		u.Say("oneshot.warn.ram_need", "need", recovery.FormatBytes(extras.Needs.RAMBytes), "ram", recovery.FormatBytes(m.checks.MemTotalBytes))
	}
	var iso *download
	if !c.Opts.Direct {
		// The direct mode needs neither the ISO nor kexec: recover runs here.
		if iso, code = c.fetchISO(ctx, extras.ISO); code != ExitOK {
			return code
		}
		defer iso.f.Close()
		if code := c.testLoad(ctx, iso.lf); code != ExitOK {
			return code
		}
	}
	confirmed, passphrase, code := c.confirm(extras)
	if code != ExitOK {
		return code
	}
	defer zero(passphrase)
	if code := c.waitRelease(ctx); code != ExitOK {
		return code
	}
	if c.Opts.Direct {
		return c.runDirect(ctx, confirmed, passphrase)
	}
	return c.switchOver(ctx, iso, confirmed, passphrase)
}

// runDirect runs recover in the rescue system itself (docs/BAREMETAL-ONESHOT.md
// 17.1): the session data goes to /run/restow-oneshot (0700/0600) for it and
// is removed when it returns.
func (c *Command) runDirect(ctx context.Context, confirmed []string, passphrase []byte) int {
	data, err := c.SessionData(confirmed, passphrase)
	if err != nil {
		c.UI.Say("oneshot.load_failed", "reason", redact.Redact(err.Error()))
		return ExitError
	}
	path, err := c.Env.WriteSessionData(data)
	zero(data)
	if err != nil {
		c.UI.Say("oneshot.load_failed", "reason", redact.Redact(err.Error()))
		return ExitError
	}
	defer c.Env.RemoveSessionData(path)
	if ctx.Err() != nil {
		c.UI.Say("oneshot.aborted")
		return ExitEnded
	}
	c.UI.Say("oneshot.direct_start")
	return c.Env.RunRecover(ctx, path, c.Opts.ResticBin)
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func appendUnique(list []string, s string) []string {
	if hasString(list, s) {
		return list
	}
	return append(list, s)
}

func (c *Command) read(path string) []byte {
	b, _ := c.Env.ReadFile(path)
	return b
}

func trimRead(c *Command, path string) string { return strings.TrimSpace(string(c.read(path))) }

// measure checks and measures the machine (docs/BAREMETAL-ONESHOT.md 8.2,
// 8.3, 10.1). Everything here only reads.
func (c *Command) measure(ctx context.Context) (*machine, error) {
	u := c.UI
	m := &machine{}
	m.checks = api.OneshotChecks{Mode: api.OneshotModeKexec, Kexec: api.OneshotKexecNotTried, InUse: []string{}, Warnings: []string{}}
	if c.Opts.Direct {
		m.checks.Mode = api.OneshotModeDirect
		m.target.Rescue = true
	}
	total, avail := ParseMeminfo(c.read("/proc/meminfo"))
	m.checks.MemTotalBytes, m.checks.MemAvailableBytes = total, avail
	switch {
	case total < minRAMBytes:
		m.fatal = append(m.fatal, u.Text("oneshot.fatal.ram", "ram", recovery.FormatBytes(total)))
	case total < warnRAMBytes:
		m.checks.Warnings = append(m.checks.Warnings, "ram_low")
		m.warnings = append(m.warnings, u.Text("oneshot.warn.ram_low", "ram", recovery.FormatBytes(total)))
	}
	m.checks.KexecLoadDisabled = trimRead(c, "/proc/sys/kernel/kexec_load_disabled") == "1"
	if m.checks.KexecLoadDisabled && !c.Opts.Direct {
		m.fatal = append(m.fatal, u.Text("oneshot.fatal.kexec_disabled"))
	}
	m.checks.Lockdown = ParseLockdown(c.read("/sys/kernel/security/lockdown"))
	if m.checks.Lockdown != "" && m.checks.Lockdown != "none" {
		m.warnings = append(m.warnings, u.Text("oneshot.warn.lockdown", "mode", m.checks.Lockdown))
	}
	switch hv, guest := trimRead(c, "/sys/hypervisor/type"), trimRead(c, "/sys/hypervisor/guest_type"); {
	case hv == "xen" && strings.EqualFold(guest, "PV"):
		m.fatal = append(m.fatal, u.Text("oneshot.fatal.xen_pv"))
	case hv == "xen":
		m.checks.Warnings = append(m.checks.Warnings, "xen_hvm")
		m.warnings = append(m.warnings, u.Text("oneshot.warn.xen_hvm"))
	}
	for _, tool := range [][]string{{"ip", "-V"}, {"lsblk", "--version"}, {"blkid", "-V"}} {
		if _, err := c.Env.Output(ctx, tool...); err != nil {
			m.fatal = append(m.fatal, u.Text("oneshot.fatal.tool", "tool", tool[0]))
		}
	}
	hwIn, err := c.Env.Hardware(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the disks: %w", err)
	}
	tgt, _ := recovery.BuildTarget(hwIn)
	m.hw = recovery.ExchangeHardware(tgt)
	m.checks.SecureBoot = tgt.Firmware.SecureBoot
	if sb := tgt.Firmware.SecureBoot; sb != nil && *sb {
		m.warnings = append(m.warnings, u.Text("oneshot.warn.secureboot"))
	}
	for _, d := range tgt.Disks {
		if d.Identity == nil || *d.Identity == "" || d.ReadOnly || d.SizeBytes == 0 {
			continue
		}
		m.disks = append(m.disks, d)
	}
	if len(m.disks) == 0 {
		m.fatal = append(m.fatal, u.Text("oneshot.fatal.no_disk"))
	}
	if c.Opts.Direct {
		m.fatal = append(m.fatal, c.directProblems(m.disks)...)
	}
	if err := c.measureNetwork(ctx, m); err != nil {
		return nil, err
	}
	t := &m.target
	t.Hostname = trimRead(c, "/proc/sys/kernel/hostname")
	t.Cloud = ParseInstanceData(c.read(instanceDataPath))
	t.Vendor = trimRead(c, "/sys/class/dmi/id/sys_vendor")
	t.Product = trimRead(c, "/sys/class/dmi/id/product_name")
	t.Consoles = payload.Consoles(string(c.read("/proc/cmdline")))
	if t.Consoles == nil {
		t.Consoles = []string{}
	}
	t.UptimeSeconds = ParseUptime(c.read("/proc/uptime"))
	// The signs of a machine in use (8.4).
	usage := Usage{UptimeSeconds: t.UptimeSeconds, UsedBytes: c.Env.UsedBytes()}
	for _, f := range StateFiles {
		usage.AgentEnrolled = usage.AgentEnrolled || c.Env.Exists(f)
	}
	if homes, err := c.Env.ReadDir("/home"); err == nil {
		usage.HomeUsers = len(homes)
	}
	if out, err := c.Env.Output(ctx, append([]string{"systemctl", "is-active"}, ServicesOfConcern...)...); err == nil || len(out) > 0 {
		for i, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if strings.TrimSpace(line) == "active" && i < len(ServicesOfConcern) {
				usage.Services = append(usage.Services, ServicesOfConcern[i])
			}
		}
	}
	m.signs = InUse(usage)
	m.checks.InUse = append(m.checks.InUse, m.signs...)
	// An enrolled agent stops the command (the instance would refuse the
	// release as well); the other signs are warnings (22.15).
	if usage.AgentEnrolled {
		m.fatal = append(m.fatal, u.Text("oneshot.fatal.agent"))
	}
	if others := withoutString(m.signs, api.OneshotInUseAgent); len(others) > 0 {
		names := make([]string, 0, len(m.signs))
		for _, s := range m.signs {
			names = append(names, u.Text("oneshot.sign."+s))
		}
		m.warnings = append(m.warnings, u.Text("oneshot.warn.in_use", "signs", strings.Join(names, "; ")))
	}
	c.readKeys(m)
	return m, nil
}

// directProblems are the conditions of the direct mode (17.1): every
// program recover calls is here, restic was checked, and no disk of the
// machine is in use (mounted, swap, or held by device mapper, md or LUKS).
func (c *Command) directProblems(disks []baremetal.TargetDisk) []string {
	u := c.UI
	var out []string
	var missing []string
	for _, t := range recovery.Tools {
		if !c.Env.HasTool(t.Program) {
			missing = append(missing, t.Program)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		out = append(out, u.Text("oneshot.fatal.direct_tools", "tools", strings.Join(missing, ", ")))
	}
	if c.Opts.ResticBin == "" {
		out = append(out, u.Text("oneshot.fatal.direct_restic"))
	}
	used := c.disksInUse(disks)
	if len(used) > 0 {
		sort.Strings(used)
		out = append(out, u.Text("oneshot.fatal.direct_in_use", "devices", strings.Join(slicesCompact(used), ", ")))
	}
	return out
}

func slicesCompact(s []string) []string {
	var out []string
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}

// disksInUse names what holds a disk of the machine in the direct mode
// (17.1). It compares by device number, which a root mounted as /dev/root
// or a name in another form cannot hide: the major:minor of every mount
// (/proc/self/mountinfo), of every swap area, of "/", of this program and
// of restic, against those of the disks and their partitions
// (/sys/block/<disk>[/<part>]/dev); by name as well (btrfs mounts carry an
// anonymous number); and a disk or partition with holders (LVM, md, LUKS).
func (c *Command) disksInUse(disks []baremetal.TargetDisk) []string {
	var used []string
	devs := map[string]string{} // major:minor -> /dev/<name>
	for _, d := range disks {
		k := strings.TrimPrefix(d.Path, "/dev/")
		if strings.ContainsAny(k, "/.") || k == "" {
			continue
		}
		if n := trimRead(c, "/sys/block/"+k+"/dev"); n != "" {
			devs[n] = d.Path
		}
		if h, _ := c.Env.ReadDir("/sys/block/" + k + "/holders"); len(h) > 0 {
			used = append(used, d.Path)
		}
		parts, _ := c.Env.ReadDir("/sys/block/" + k)
		for _, p := range parts {
			if !strings.HasPrefix(p, k) || strings.ContainsAny(p, "/.") {
				continue
			}
			if n := trimRead(c, "/sys/block/"+k+"/"+p+"/dev"); n != "" {
				devs[n] = "/dev/" + p
			}
			if h, _ := c.Env.ReadDir("/sys/block/" + k + "/" + p + "/holders"); len(h) > 0 {
				used = append(used, "/dev/"+p)
			}
		}
	}
	mark := func(n, what string) {
		if dev, ok := devs[n]; ok {
			used = append(used, dev+" ("+what+")")
		}
	}
	// mountinfo: ID parent major:minor root mountpoint ... - fstype source options
	for _, l := range strings.Split(string(c.read("/proc/self/mountinfo")), "\n") {
		f := strings.Fields(l)
		if len(f) < 5 {
			continue
		}
		mark(f[2], f[4])
		if i := indexOf(f, "-"); i >= 0 && i+2 < len(f) {
			for _, d := range disks {
				if onDisk(f[i+2], d.Path) {
					used = append(used, f[i+2]+" ("+f[4]+")")
				}
			}
		}
	}
	for _, l := range strings.Split(string(c.read("/proc/swaps")), "\n")[1:] {
		f := strings.Fields(l)
		if len(f) == 0 || !strings.HasPrefix(f[0], "/") {
			continue
		}
		if n, err := c.Env.DeviceOf(f[0]); err == nil {
			mark(n, "swap")
		}
		for _, d := range disks {
			if onDisk(f[0], d.Path) {
				used = append(used, f[0]+" (swap)")
			}
		}
	}
	for _, p := range []string{"/", "/proc/self/exe", c.Opts.ResticBin} {
		if p == "" {
			continue
		}
		if n, err := c.Env.DeviceOf(p); err == nil {
			mark(n, p)
		}
	}
	return used
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

// onDisk reports whether a device is the disk or one of its partitions
// (sda1, nvme0n1p2).
func onDisk(dev, disk string) bool {
	if dev == disk {
		return true
	}
	rest, ok := strings.CutPrefix(dev, disk)
	if !ok || rest == "" {
		return false
	}
	rest = strings.TrimPrefix(rest, "p")
	for _, r := range rest {
		if r < '0' || r > '9' {
			return false
		}
	}
	return rest != ""
}

func withoutString(list []string, s string) []string {
	var out []string
	for _, v := range list {
		if v != s {
			out = append(out, v)
		}
	}
	return out
}

// measureNetwork reads the network (10.1): addresses, default routes, name
// servers, and refuses what the restore does not take over.
func (c *Command) measureNetwork(ctx context.Context, m *machine) error {
	addrs, err := c.Env.Output(ctx, "ip", "-j", "-d", "addr", "show")
	if err != nil && len(addrs) == 0 {
		return fmt.Errorf("ip addr: %w", err)
	}
	r4, _ := c.Env.Output(ctx, "ip", "-j", "-4", "route", "show", "default")
	r6, _ := c.Env.Output(ctx, "ip", "-j", "-6", "route", "show", "default")
	ifs, routes, problems, err := ParseNetwork(addrs, r4, r6)
	if err != nil {
		return err
	}
	rules4, _ := c.Env.Output(ctx, "ip", "-j", "-4", "rule", "show")
	rules6, _ := c.Env.Output(ctx, "ip", "-j", "-6", "rule", "show")
	problems = append(problems, ParseRules(rules4, rules6)...)
	if len(ifs) == 0 {
		problems = append(problems, NetworkProblem{Code: "no_address", Detail: "no interface has a global address"})
	}
	for _, p := range problems {
		m.fatal = append(m.fatal, c.UI.Text("oneshot.fatal.network", "detail", p.Detail))
	}
	for i := range ifs {
		ifs[i].Driver = driverOf(c, ifs[i].Name)
	}
	m.target.Interfaces, m.target.Routes = ifs, routes
	dns, search := ParseResolv(c.read("/etc/resolv.conf"))
	if len(dns) == 0 {
		// systemd-resolved: the stub in /etc/resolv.conf, the servers here.
		dns, search = ParseResolv(c.read("/run/systemd/resolve/resolv.conf"))
	}
	if dns == nil {
		dns = []string{}
	}
	if search == nil {
		search = []string{}
	}
	m.target.DNS, m.target.SearchDomains = dns, search
	return nil
}

func driverOf(c *Command, ifname string) string {
	if strings.ContainsAny(ifname, "/.") {
		return ""
	}
	b := c.read("/sys/class/net/" + ifname + "/device/uevent")
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "DRIVER="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// readKeys reads root's public SSH keys (8.4): at most 16, lines with
// options are left out.
func (c *Command) readKeys(m *machine) {
	m.keyInfo = []api.OneshotSSHKey{}
	for _, line := range strings.Split(string(c.read(authorizedKeys)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || len(m.keys) >= recovery.MaxOneshotSSHKeys {
			continue
		}
		k, err := recovery.ParseAuthorizedKey(line)
		if err != nil {
			continue
		}
		comment := k.Comment
		if len(comment) > 200 {
			comment = comment[:200]
		}
		m.keys = append(m.keys, k.Line())
		m.keyInfo = append(m.keyInfo, api.OneshotSSHKey{Type: k.Type, Fingerprint: k.Fingerprint(), Comment: comment})
	}
}

// showMachine shows what the command found (8.4).
func (c *Command) showMachine() {
	u, m := c.UI, c.m
	var addrs, gws []string
	for _, i := range m.target.Interfaces {
		for _, a := range i.Addresses {
			addrs = append(addrs, fmt.Sprintf("%s/%d (%s)", a.Address, a.Prefix, i.Name))
		}
	}
	for _, r := range m.target.Routes {
		g := r.Gateway
		if r.OnLink {
			g += " (on-link)"
		}
		gws = append(gws, g)
	}
	u.Say("oneshot.sum.machine", "hostname", m.target.Hostname, "vendor", strings.TrimSpace(m.target.Vendor+" "+m.target.Product))
	u.Say("oneshot.sum.network", "addresses", strings.Join(addrs, ", "))
	if len(gws) > 0 {
		u.Say("oneshot.sum.gateway", "gateways", strings.Join(gws, ", "))
	}
	u.Say("oneshot.sum.firmware", "firmware", strings.ToUpper(m.hw.Firmware), "ram", recovery.FormatBytes(m.checks.MemTotalBytes))
	for _, d := range m.disks {
		u.Say("oneshot.sum.disk", "path", d.Path, "size", recovery.FormatBytes(d.SizeBytes), "model", deref(d.Model), "identity", deref(d.Identity))
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// exchange redeems the code with what the command measured.
func (c *Command) exchange(ctx context.Context, norm string) (*api.RecoveryExchangeResponse, int) {
	u := c.UI
	s, err := recovery.NewSession(c.Opts.Instance, c.Opts.AllowHTTP, c.Opts.HTTP)
	if err != nil {
		u.Raw(err.Error())
		return nil, ExitUsage
	}
	c.session = s
	u.Say("oneshot.exchanging", "instance", s.BaseURL)
	out, err := s.ExchangeOneshot(ctx, api.RecoveryOneshotExchangeRequest{
		RecoveryExchangeRequest: api.RecoveryExchangeRequest{CodeProof: recovery.OneshotCodeProof(s.BaseURL, norm), RecoveryVersion: c.Opts.Version, Hardware: c.m.hw},
		Target:                  c.m.target, Checks: c.m.checks, SSHKeys: c.m.keyInfo,
	})
	if err != nil {
		switch recovery.ProblemName(err) {
		case recovery.ProblemCodeInvalid:
			u.Say("code.invalid")
		case recovery.ProblemCodeExpired:
			u.Say("code.expired")
		case recovery.ProblemCodeRevoked:
			u.Say("code.revoked")
		case recovery.ProblemCodeUsed:
			u.Say("code.used")
		default:
			u.Raw(redact.Redact(err.Error()))
			return nil, ExitError
		}
		return nil, ExitEnded
	}
	u.Say("approval.machine", "name", out.Endpoint.DisplayName, "hostname", out.Endpoint.Hostname)
	u.Say("approval.match", "match", recovery.FormatMatchCode(out.MatchCode))
	c.logf("session %s exchanged", out.SessionID)
	c.progress(ctx, api.RecoveryPhaseRegistered)
	return out, ExitOK
}

func (c *Command) progress(ctx context.Context, phase string) {
	if err := c.session.Progress(ctx, api.RecoveryProgress{Phase: phase}); err != nil {
		c.logf("progress %s: %v", phase, err)
	}
}

// fetchISO fetches the recovery ISO through the session and checks it
// (5.4): the signed checksum list first, then the image against it, then
// the three live files against the image's own list.
func (c *Command) fetchISO(ctx context.Context, offered *api.OneshotISO) (*download, int) {
	u := c.UI
	if offered == nil {
		u.Say("oneshot.no_iso")
		return nil, ExitRefused
	}
	c.progress(ctx, api.RecoveryPhaseDownloading)
	var sums, sig bytes.Buffer
	if _, err := c.session.FetchOneshotISO(ctx, recovery.OneshotISOSums, &sums, maxSumsBytes); err != nil {
		u.Say("oneshot.iso_bad", "reason", redact.Redact(err.Error()))
		return nil, ExitRefused
	}
	if c.Opts.Trust.TrustedSumsSHA256 == "" {
		if _, err := c.session.FetchOneshotISO(ctx, recovery.OneshotISOSignature, &sig, maxSigBytes); err != nil {
			u.Say("oneshot.iso_bad", "reason", redact.Redact(err.Error()))
			return nil, ExitRefused
		}
	}
	want, err := CheckSums(sums.Bytes(), sig.Bytes(), *offered, c.Opts.Trust)
	if err != nil {
		u.Say("oneshot.iso_bad", "reason", err.Error())
		return nil, ExitRefused
	}
	if offered.SizeBytes <= 0 || offered.SizeBytes > MaxISOBytes {
		u.Say("oneshot.iso_bad", "reason", fmt.Sprintf("announced size %d", offered.SizeBytes))
		return nil, ExitRefused
	}
	f, err := c.Env.ISOFile()
	if err != nil {
		u.Raw(err.Error())
		return nil, ExitError
	}
	u.Say("oneshot.iso_fetch", "file", offered.FileName, "size", recovery.FormatBytes(offered.SizeBytes))
	h := sha256.New()
	n, err := c.session.FetchOneshotISO(ctx, recovery.OneshotISOImage, io.MultiWriter(f, h), offered.SizeBytes)
	if err != nil {
		f.Close()
		u.Say("oneshot.iso_bad", "reason", redact.Redact(err.Error()))
		return nil, ExitRefused
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		f.Close()
		u.Say("oneshot.iso_bad", "reason", fmt.Sprintf("the image has SHA-256 %s, the signed list says %s", got, want))
		return nil, ExitRefused
	}
	iso, err := payload.OpenISO(f, n)
	var lf *payload.LiveFiles
	if err == nil {
		lf, err = iso.LiveFiles()
	}
	if err != nil {
		f.Close()
		u.Say("oneshot.iso_bad", "reason", err.Error())
		return nil, ExitRefused
	}
	u.Say("oneshot.iso_ok", "version", offered.Version)
	return &download{f: f, size: n, lf: lf}, ExitOK
}

func sectionReader(sr *io.SectionReader) io.Reader { return io.NewSectionReader(sr, 0, sr.Size()) }

// testLoad loads the recovery kernel with the ISO's initrd alone and
// unloads it right away (8.2): the only reliable answer whether this
// kernel accepts it. The result goes to the instance either way.
func (c *Command) testLoad(ctx context.Context, lf *payload.LiveFiles) int {
	u, m := c.UI, c.m
	cmdline, err := payload.Cmdline(m.target.Consoles, c.keymap())
	if err == nil {
		err = c.load(ctx, lf, cmdline, func(w io.Writer, h *hashes) error {
			_, err := io.Copy(w, h.reader(lf, payload.InitrdPath))
			return err
		}, []string{payload.KernelPath, payload.InitrdPath})
	}
	if err == nil {
		if uerr := c.Env.KexecUnload(); uerr != nil {
			c.logf("kexec unload: %v", uerr)
		}
	}
	if ctx.Err() != nil {
		u.Say("oneshot.aborted")
		return ExitEnded
	}
	if err == nil {
		m.checks.Kexec = api.OneshotKexecOK
	} else {
		m.checks.Kexec = api.OneshotKexecFailed
		m.checks.KexecError = err.Error()
	}
	if rerr := c.session.OneshotChecks(ctx, m.checks); rerr != nil {
		u.Raw(redact.Redact(rerr.Error()))
		return ExitError
	}
	if err != nil {
		u.Say("oneshot.kexec_failed", "reason", err.Error())
		return ExitRefused
	}
	u.Say("oneshot.kexec_ok")
	return ExitOK
}

// hashes hashes the live files while they are copied into memory, so what
// kexec_file_load gets is checked after it left the disk (the image lies
// on the disk, where it could change after the check).
type hashes struct {
	h map[string]hash.Hash
}

// reader is the file at path of the ISO, hashed as it is read.
func (h *hashes) reader(lf *payload.LiveFiles, path string) io.Reader {
	var sr *io.SectionReader
	switch path {
	case payload.KernelPath:
		sr = lf.Kernel
	case payload.InitrdPath:
		sr = lf.Initrd
	default:
		sr = lf.Squashfs
	}
	d := sha256.New()
	h.h[path] = d
	return io.TeeReader(sectionReader(sr), d)
}

// check compares the hashes of the files read with the hashes of the check.
func (h *hashes) check(lf *payload.LiveFiles, paths []string) error {
	for _, p := range paths {
		d, ok := h.h[p]
		if !ok {
			return fmt.Errorf("%s was not read", p)
		}
		if got := hex.EncodeToString(d.Sum(nil)); got != lf.SHA256[p] {
			return fmt.Errorf("%s changed on the disk since the check (SHA-256 %s, checked %s)", p, got, lf.SHA256[p])
		}
	}
	return nil
}

// ctxWriter stops a long copy into memory once ctx ends.
type ctxWriter struct {
	ctx context.Context
	w   io.Writer
}

func (c ctxWriter) Write(p []byte) (int, error) {
	if c.ctx.Err() != nil {
		return 0, ErrCancelled
	}
	return c.w.Write(p)
}

// load copies the kernel and the initrd fill writes into memfds, hashing
// the live files on the way, compares the hashes with the check and only
// then calls kexec_file_load. ctx ending stops it before the load.
func (c *Command) load(ctx context.Context, lf *payload.LiveFiles, cmdline string, fill func(io.Writer, *hashes) error, paths []string) error {
	h := &hashes{h: map[string]hash.Hash{}}
	kernel, err := c.Env.Memfd("restow-kernel", func(w io.Writer) error {
		_, err := io.Copy(ctxWriter{ctx, w}, h.reader(lf, payload.KernelPath))
		return err
	})
	if err != nil {
		return err
	}
	defer kernel.Close()
	initrd, err := c.Env.Memfd("restow-initrd", func(w io.Writer) error { return fill(ctxWriter{ctx, w}, h) })
	if err != nil {
		return err
	}
	defer initrd.Close()
	if err := h.check(lf, paths); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ErrCancelled
	}
	return c.Env.KexecFileLoad(kernel, initrd, cmdline)
}

func (c *Command) keymap() string {
	if c.Opts.Keymap != "" {
		return c.Opts.Keymap
	}
	return "us"
}

// confirm asks the console to confirm every disk and, for a backup with
// LUKS volumes, the new passphrase (8.4). Unattended, the answers file
// carries both. Nothing of it goes to the instance.
func (c *Command) confirm(extras *api.OneshotExchangeExtras) ([]string, []byte, int) {
	u, m := c.UI, c.m
	u.Say("oneshot.confirm_intro")
	var confirmed []string
	if a := c.Opts.Answers; a != nil {
		have := map[string]bool{}
		for _, d := range m.disks {
			have[*d.Identity] = true
		}
		for _, id := range a.ConfirmErase {
			if !have[id] {
				u.Say("oneshot.answers_mismatch", "identity", id)
				return nil, nil, ExitRefused
			}
		}
		confirmed = append(confirmed, a.ConfirmErase...)
	} else {
		var lines []string
		for _, d := range m.disks {
			ok, err := u.TypeToConfirm(d.Path, deref(d.Model), recovery.FormatBytes(d.SizeBytes), *d.Identity)
			if err != nil || !ok {
				u.Say("oneshot.confirm_abort")
				return nil, nil, ExitEnded
			}
			lines = append(lines, fmt.Sprintf("%s  %s  %s  %s", d.Path, recovery.FormatBytes(d.SizeBytes), deref(d.Model), *d.Identity))
			confirmed = append(confirmed, *d.Identity)
		}
		ok, err := u.ConfirmErase(lines)
		if err != nil || !ok {
			u.Say("oneshot.confirm_abort")
			return nil, nil, ExitEnded
		}
	}
	if len(confirmed) == 0 {
		u.Say("oneshot.confirm_abort")
		return nil, nil, ExitEnded
	}
	var pass []byte
	if extras.Needs.Passphrase {
		u.Say("oneshot.passphrase_intro")
		if a := c.Opts.Answers; a != nil {
			if a.Passphrase == "" {
				u.Say("oneshot.passphrase_missing")
				return nil, nil, ExitRefused
			}
			pass = []byte(a.Passphrase)
		} else {
			p, err := u.SecretTwice(u.Text("oneshot.passphrase_prompt"))
			if err != nil {
				u.Say("oneshot.confirm_abort")
				return nil, nil, ExitEnded
			}
			pass = p
		}
		redact.Add(string(pass))
	}
	return confirmed, pass, ExitOK
}

// waitRelease waits for the release in Restow (8.5).
func (c *Command) waitRelease(ctx context.Context) int {
	u := c.UI
	u.Say("approval.waiting")
	c.progress(ctx, api.RecoveryPhaseWaitingApproval)
	poll := c.Opts.Poll
	if poll == 0 {
		poll = 5 * time.Second
	}
	failures := 0
	for {
		st, err := c.session.Current(ctx)
		switch {
		case err == nil:
			failures = 0
		case recovery.ProblemName(err) == recovery.ProblemSessionEnded:
			u.Say("oneshot.ended", "status", "ended")
			return ExitEnded
		case ctx.Err() != nil:
			u.Say("oneshot.aborted")
			return ExitEnded
		case recovery.ProblemName(err) == "" && failures < maxWaitFailures:
			// The wait may last hours: a short break of the network (no
			// answer of the instance) is waited out, about a minute.
			failures++
			c.logf("waiting for the release: %v", err)
			st = &api.RecoverySessionState{Status: api.RecoveryPendingApproval}
		default:
			u.Raw(redact.Redact(err.Error()))
			return ExitError
		}
		switch {
		case st.CancelRequested:
			u.Say("oneshot.ended", "status", "cancelled")
			return ExitEnded
		case st.Status == api.RecoveryActive:
			if st.Oneshot == nil || st.Oneshot.Decided == nil {
				u.Raw("the instance released the session without the decisions of a oneshot restore")
				return ExitError
			}
			u.Say("approval.granted")
			return ExitOK
		case st.Status != api.RecoveryPendingApproval:
			u.Say("oneshot.ended", "status", st.Status)
			return ExitEnded
		}
		select {
		case <-ctx.Done():
			u.Say("oneshot.aborted")
			return ExitEnded
		case <-time.After(poll):
		}
	}
}

// SessionData builds the data recover reads in the recovery environment
// (9.2) and checks it the way recover will.
func (c *Command) SessionData(confirmed []string, passphrase []byte) ([]byte, error) {
	m := c.m
	d := recovery.OneshotData{Format: recovery.OneshotFormat, InstanceURL: c.session.BaseURL, Language: c.Opts.Lang,
		ConfirmErase: confirmed, Passphrase: string(passphrase), SSHKeys: m.keys, Consoles: m.target.Consoles}
	if c.Opts.SPKI != nil {
		d.SPKISHA256 = c.Opts.SPKI()
	}
	d.CAPEM = string(c.Opts.CAPEM)
	d.Session.ID, d.Session.Secret = c.session.ID, c.session.Secret
	network, err := json.Marshal(recovery.OneshotNetwork{Interfaces: m.target.Interfaces, Routes: m.target.Routes,
		DNS: m.target.DNS, SearchDomains: m.target.SearchDomains, Cloud: m.target.Cloud})
	if err != nil {
		return nil, err
	}
	d.Network = network
	b, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	if _, err := recovery.LoadOneshotData(b, c.Opts.AllowHTTP); err != nil {
		zero(b)
		return nil, err
	}
	if len(b) > payload.MaxDataBytes {
		zero(b)
		return nil, errors.New("the session data is too large")
	}
	return b, nil
}

// switchOver loads the recovery environment and switches into it (8.6).
// Up to the call of Env.Kexec a cancel (Ctrl+C, a hangup, SIGTERM) unloads
// what was loaded and ends with the machine unchanged; Env.Kexec is the
// point of no return (5.3).
func (c *Command) switchOver(ctx context.Context, iso *download, confirmed []string, passphrase []byte) int {
	u, m := c.UI, c.m
	aborted := func() int {
		_ = c.Env.KexecUnload()
		u.Say("oneshot.aborted")
		return ExitEnded
	}
	fail := func(err error) int {
		if ctx.Err() != nil || errors.Is(err, ErrCancelled) {
			return aborted()
		}
		u.Say("oneshot.load_failed", "reason", redact.Redact(err.Error()))
		return ExitError
	}
	data, err := c.SessionData(confirmed, passphrase)
	if err != nil {
		return fail(err)
	}
	defer zero(data)
	cmdline, err := payload.Cmdline(m.target.Consoles, c.keymap())
	if err != nil {
		return fail(err)
	}
	if ctx.Err() != nil {
		return aborted()
	}
	c.progress(ctx, api.RecoveryPhaseKexec)
	lf := iso.lf
	err = c.load(ctx, lf, cmdline, func(w io.Writer, h *hashes) error {
		_, err := payload.Assemble(w, h.reader(lf, payload.InitrdPath), h.reader(lf, payload.SquashfsPath), lf.Squashfs.Size(), data)
		return err
	}, []string{payload.KernelPath, payload.InitrdPath, payload.SquashfsPath})
	if err != nil {
		return fail(err)
	}
	if !c.Env.KexecLoaded() {
		_ = c.Env.KexecUnload()
		return fail(errors.New("the kernel reports no loaded kexec image"))
	}
	if ctx.Err() != nil {
		return aborted()
	}
	// The point of no return: from here the machine shuts down.
	u.Say("oneshot.switching")
	if err := c.Env.Kexec(ctx); err != nil {
		if errors.Is(err, ErrCancelled) {
			return aborted()
		}
		_ = c.Env.KexecUnload()
		u.Say("oneshot.kexec_exec_failed", "reason", redact.Redact(err.Error()))
		return ExitError
	}
	return ExitOK
}

// download is the checked recovery ISO on the disk.
type download struct {
	f    ISOFile
	size int64
	lf   *payload.LiveFiles
}
