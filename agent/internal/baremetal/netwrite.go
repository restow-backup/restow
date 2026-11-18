package baremetal

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"path"
	"regexp"
	"sort"
	"strings"
)

// Taking over the network of a fresh machine in the restored system
// (docs/BAREMETAL-ONESHOT.md 10.4, 11): the restored system keeps its own
// network stack, the configuration of that stack is written anew for the
// network the command measured on the fresh machine, everything it
// replaces or binds to the old hardware is put aside (never deleted), and
// cloud-init is limited to the network. Pure text transformations; recover
// reads and writes the files (rootfs).

// NetStack is the network stack of the restored system.
type NetStack string

const (
	StackNetplan        NetStack = "netplan"
	StackNetworkd       NetStack = "networkd"
	StackNetworkManager NetStack = "networkmanager"
	StackIfupdown       NetStack = "ifupdown"
)

// ErrNetStackUnclear: more than one stack would bring the network up and
// none is clearly the one (no guessing, 10.4 point 1).
var ErrNetStackUnclear = errors.New("the restored system has more than one active network stack and none is clearly in charge")

// NetFS reads the restored system (paths are absolute within it).
type NetFS interface {
	ReadFile(p string) ([]byte, error)
	ReadDir(p string) ([]string, error)
	// IsSymlink reports a symbolic link (resolv.conf of systemd-resolved).
	IsSymlink(p string) bool
}

// TakeoverIface is one interface of the fresh machine with its addresses.
type TakeoverIface struct {
	Name  string
	MAC   string
	MTU   int
	DHCP4 bool
	SLAAC bool
	// Static are the addresses that are not DHCP's or SLAAC's (CIDR).
	Static []string
	// Gateway4 and Gateway6 are the default gateways of static addresses,
	// with OnLink when the gateway lies outside every prefix.
	Gateway4, Gateway6 string
	OnLink4, OnLink6   bool
}

// TakeoverNet is the network of the fresh machine.
type TakeoverNet struct {
	Interfaces []TakeoverIface
	DNS        []string
	Search     []string
	// Cloud is cloud-init's cloud_name on the fresh machine ("" unknown).
	Cloud string
}

// NetChange is one file the takeover writes or puts aside.
type NetChange struct {
	Path    string
	Content []byte
	Mode    fs.FileMode
	// Remove: the file is put aside (backed up, then removed).
	Remove bool
	// Rule names why: network_config, network_old_config, network_binding,
	// resolv_conf, cloud_init.
	Rule string
}

// NetPlan is what the takeover does.
type NetPlan struct {
	Stack   NetStack
	Changes []NetChange
	// CloudInitNetwork: cloud-init of the restored system brings up the
	// network of the new instance itself; no own file is written.
	CloudInitNetwork bool
	Notes            []string
}

var (
	reTakeoverMAC = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)
	reIfName      = regexp.MustCompile(`^[a-z][a-z0-9]{0,14}$`)
	reSearch      = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.?$`)
)

// Check validates every value that goes into a file.
func (n *TakeoverNet) Check() error {
	if len(n.Interfaces) == 0 {
		return errors.New("no interface")
	}
	for _, i := range n.Interfaces {
		if !reTakeoverMAC.MatchString(i.MAC) {
			return fmt.Errorf("MAC %q", i.MAC)
		}
		if !reIfName.MatchString(i.Name) {
			return fmt.Errorf("interface name %q", i.Name)
		}
		if i.MTU != 0 && (i.MTU < 576 || i.MTU > 65535) {
			return fmt.Errorf("MTU %d", i.MTU)
		}
		for _, a := range i.Static {
			if _, _, err := net.ParseCIDR(a); err != nil {
				return fmt.Errorf("address %q", a)
			}
		}
		for _, g := range []struct {
			gw string
			v4 bool
		}{{i.Gateway4, true}, {i.Gateway6, false}} {
			if g.gw == "" {
				continue
			}
			ip := net.ParseIP(g.gw)
			if ip == nil || (ip.To4() != nil) != g.v4 {
				return fmt.Errorf("gateway %q", g.gw)
			}
		}
	}
	for _, d := range n.DNS {
		if net.ParseIP(d) == nil {
			return fmt.Errorf("name server %q", d)
		}
	}
	for _, s := range n.Search {
		if !reSearch.MatchString(s) {
			return fmt.Errorf("search domain %q", s)
		}
	}
	return nil
}

// enabledUnits lists the units enabled in /etc/systemd/system/*.wants.
func enabledUnits(fsys NetFS) map[string]bool {
	out := map[string]bool{}
	dirs, _ := fsys.ReadDir("/etc/systemd/system")
	for _, d := range dirs {
		if !strings.HasSuffix(d, ".wants") {
			continue
		}
		units, _ := fsys.ReadDir("/etc/systemd/system/" + d)
		for _, u := range units {
			out[u] = true
		}
	}
	return out
}

func filesIn(fsys NetFS, dir string, suffixes ...string) []string {
	names, _ := fsys.ReadDir(dir)
	var out []string
	for _, n := range names {
		for _, s := range suffixes {
			if strings.HasSuffix(n, s) {
				out = append(out, path.Join(dir, n))
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// DetectNetStack finds the stack that brings the network of the restored
// system up: netplan (whatever it renders for), else the one enabled unit
// of NetworkManager, systemd-networkd or ifupdown (networking.service).
// Several without a clear one: ErrNetStackUnclear.
func DetectNetStack(fsys NetFS) (NetStack, error) {
	if len(filesIn(fsys, "/etc/netplan", ".yaml", ".yml")) > 0 {
		return StackNetplan, nil
	}
	units := enabledUnits(fsys)
	var stacks []NetStack
	if units["NetworkManager.service"] {
		stacks = append(stacks, StackNetworkManager)
	}
	if units["systemd-networkd.service"] {
		stacks = append(stacks, StackNetworkd)
	}
	if units["networking.service"] || units["ifup@.service"] {
		stacks = append(stacks, StackIfupdown)
	}
	if len(stacks) == 1 {
		return stacks[0], nil
	}
	if len(stacks) > 1 {
		// The one with a configuration of an Ethernet interface.
		var withConfig []NetStack
		for _, s := range stacks {
			if hasConfig(fsys, s) {
				withConfig = append(withConfig, s)
			}
		}
		if len(withConfig) == 1 {
			return withConfig[0], nil
		}
		return "", ErrNetStackUnclear
	}
	// No unit enabled under /etc: a system that brings its network up by
	// presets; the configuration names it.
	for _, s := range []NetStack{StackNetworkManager, StackNetworkd, StackIfupdown} {
		if hasConfig(fsys, s) {
			return s, nil
		}
	}
	return "", errors.New("no network stack found in the restored system")
}

func hasConfig(fsys NetFS, s NetStack) bool {
	switch s {
	case StackNetworkManager:
		return len(nmEthernetFiles(fsys)) > 0 || len(ifcfgFiles(fsys)) > 0
	case StackNetworkd:
		return len(networkdAddressFiles(fsys)) > 0
	case StackIfupdown:
		b, _ := fsys.ReadFile("/etc/network/interfaces")
		return reIfaceStanza.Match(b) || len(ifupdownDFiles(fsys)) > 0
	}
	return false
}

var reIfaceStanza = regexp.MustCompile(`(?m)^\s*iface\s+(\S+)\s+inet6?\s+(\S+)`)

func nmEthernetFiles(fsys NetFS) []string {
	var out []string
	for _, p := range filesIn(fsys, "/etc/NetworkManager/system-connections", ".nmconnection") {
		b, _ := fsys.ReadFile(p)
		if regexp.MustCompile(`(?m)^\s*type\s*=\s*(ethernet|802-3-ethernet)\s*$`).Match(b) {
			out = append(out, p)
		}
	}
	return out
}

func ifcfgFiles(fsys NetFS) []string {
	var out []string
	for _, p := range filesIn(fsys, "/etc/sysconfig/network-scripts", "") {
		base := path.Base(p)
		if strings.HasPrefix(base, "ifcfg-") && base != "ifcfg-lo" {
			out = append(out, p)
		}
	}
	return out
}

func networkdAddressFiles(fsys NetFS) []string {
	var out []string
	for _, p := range filesIn(fsys, "/etc/systemd/network", ".network") {
		b, _ := fsys.ReadFile(p)
		if regexp.MustCompile(`(?m)^\s*(Address|DHCP|Gateway)\s*=`).Match(b) && !strings.Contains(path.Base(p), "restow") {
			out = append(out, p)
		}
	}
	return out
}

func ifupdownDFiles(fsys NetFS) []string {
	var out []string
	for _, p := range filesIn(fsys, "/etc/network/interfaces.d", "") {
		b, _ := fsys.ReadFile(p)
		for _, m := range reIfaceStanza.FindAllSubmatch(b, -1) {
			if string(m[1]) != "lo" {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

// namePattern is the match of a single interface: the naming scheme of
// the restored system (eth* when its interfaces had kernel names).
func namePattern(oldNames []string) string {
	for _, n := range oldNames {
		if strings.HasPrefix(n, "eth") {
			return "eth*"
		}
	}
	return "en*"
}

// PlanTakeover is the takeover of the network for a restored system:
// stack, old configuration and hardware bindings put aside, the new
// configuration in the stack's format, resolv.conf where it is a plain
// file, and cloud-init (11.2). oldMACs and oldNames are the interfaces of
// the backup (the manifest). cloudInitNetwork is decided by the caller with
// CloudInitHandlesNetwork.
func PlanTakeover(fsys NetFS, n *TakeoverNet, oldMACs, oldNames []string, takeover bool, header string) (*NetPlan, error) {
	p := &NetPlan{}
	ci := ReadCloudInit(fsys)
	if takeover {
		if err := n.Check(); err != nil {
			return nil, fmt.Errorf("network of the fresh machine: %w", err)
		}
		stack, err := DetectNetStack(fsys)
		if err != nil {
			return nil, err
		}
		p.Stack = stack
		p.CloudInitNetwork = ci.Present && !ci.NetworkDisabled && ci.HasDatasourceFor(n.Cloud)
		for _, f := range oldConfigFiles(fsys, stack) {
			p.Changes = append(p.Changes, NetChange{Path: f, Remove: true, Rule: "network_old_config"})
		}
		if p.CloudInitNetwork {
			// cloud-init writes its file anew for the new instance.
			for _, f := range filesIn(fsys, "/etc/netplan", "50-cloud-init.yaml") {
				if !hasChange(p.Changes, f) {
					p.Changes = append(p.Changes, NetChange{Path: f, Remove: true, Rule: "network_old_config"})
				}
			}
			p.Notes = append(p.Notes, "cloud-init brings up the network of this instance from its metadata")
		} else {
			files, err := renderStack(stack, n, oldNames, header)
			if err != nil {
				return nil, err
			}
			p.Changes = append(p.Changes, files...)
			if rc := resolvConf(fsys, n, header); rc != nil {
				p.Changes = append(p.Changes, *rc)
			}
		}
	}
	p.Changes = append(p.Changes, bindingChanges(fsys, oldMACs, p.Changes)...)
	if ci.Present {
		p.Changes = append(p.Changes, NetChange{Path: CloudInitRestowCfg, Content: []byte(CloudInitRestoredConfig(header, !p.CloudInitNetwork)),
			Mode: 0o644, Rule: "cloud_init"})
	}
	return p, nil
}

func hasChange(cs []NetChange, p string) bool {
	for _, c := range cs {
		if c.Path == p {
			return true
		}
	}
	return false
}

// oldConfigFiles are the files of the stack that configure Ethernet
// interfaces; they are put aside.
func oldConfigFiles(fsys NetFS, s NetStack) []string {
	switch s {
	case StackNetplan:
		var out []string
		for _, f := range filesIn(fsys, "/etc/netplan", ".yaml", ".yml") {
			b, _ := fsys.ReadFile(f)
			if regexp.MustCompile(`(?m)^\s*(ethernets|addresses|match)\s*:`).Match(b) && path.Base(f) != "60-restow.yaml" {
				out = append(out, f)
			}
		}
		return out
	case StackNetworkd:
		return networkdAddressFiles(fsys)
	case StackNetworkManager:
		return append(nmEthernetFiles(fsys), ifcfgFiles(fsys)...)
	case StackIfupdown:
		out := ifupdownDFiles(fsys)
		if b, _ := fsys.ReadFile("/etc/network/interfaces"); len(b) > 0 {
			out = append(out, "/etc/network/interfaces")
		}
		return out
	}
	return nil
}

// bindingChanges put aside what binds names to the old hardware (10.4
// point 4): udev rules and .link files that name an old MAC.
func bindingChanges(fsys NetFS, oldMACs []string, done []NetChange) []NetChange {
	old := map[string]bool{}
	for _, m := range oldMACs {
		old[strings.ToLower(m)] = true
	}
	var out []NetChange
	names := append(filesIn(fsys, "/etc/udev/rules.d", "-persistent-net.rules"), filesIn(fsys, "/etc/systemd/network", ".link")...)
	for _, f := range names {
		if hasChange(done, f) || strings.Contains(path.Base(f), "restow") {
			continue
		}
		b, _ := fsys.ReadFile(f)
		for _, mac := range reMACText.FindAllString(string(b), -1) {
			if old[strings.ToLower(mac)] {
				out = append(out, NetChange{Path: f, Remove: true, Rule: "network_binding"})
				break
			}
		}
	}
	return out
}

func resolvConf(fsys NetFS, n *TakeoverNet, header string) *NetChange {
	if len(n.DNS) == 0 || fsys.IsSymlink("/etc/resolv.conf") {
		return nil
	}
	var b strings.Builder
	b.WriteString(header)
	for _, d := range n.DNS {
		fmt.Fprintf(&b, "nameserver %s\n", net.ParseIP(d).String())
	}
	if len(n.Search) > 0 {
		fmt.Fprintf(&b, "search %s\n", strings.Join(n.Search, " "))
	}
	return &NetChange{Path: "/etc/resolv.conf", Content: []byte(b.String()), Mode: 0o644, Rule: "resolv_conf"}
}

func renderStack(s NetStack, n *TakeoverNet, oldNames []string, header string) ([]NetChange, error) {
	switch s {
	case StackNetplan:
		return []NetChange{{Path: "/etc/netplan/60-restow.yaml", Content: []byte(RenderNetplan(n, oldNames, header)), Mode: 0o600, Rule: "network_config"}}, nil
	case StackNetworkd:
		var out []NetChange
		for i, ifc := range n.Interfaces {
			match := "Type=ether\nKind=!*"
			if len(n.Interfaces) > 1 {
				match = "MACAddress=" + ifc.MAC
			}
			out = append(out, NetChange{Path: fmt.Sprintf("/etc/systemd/network/10-restow-%d.network", i),
				Content: []byte(header + RenderNetworkd(ifc, n.DNS, n.Search, match)), Mode: 0o644, Rule: "network_config"})
		}
		return out, nil
	case StackNetworkManager:
		var out []NetChange
		for i, ifc := range n.Interfaces {
			out = append(out, NetChange{Path: fmt.Sprintf("/etc/NetworkManager/system-connections/restow-%d.nmconnection", i),
				Content: []byte(header + RenderNMKeyfile(i, ifc, n, len(n.Interfaces) > 1)), Mode: 0o600, Rule: "network_config"})
		}
		return out, nil
	case StackIfupdown:
		var b strings.Builder
		b.WriteString(header)
		var out []NetChange
		for i, ifc := range n.Interfaces {
			b.WriteString(RenderIfupdown(ifc, n.DNS, n.Search))
			// The name is fixed by a .link file on the MAC of the fresh machine.
			out = append(out, NetChange{Path: fmt.Sprintf("/etc/systemd/network/10-restow-%d.link", i),
				Content: []byte(fmt.Sprintf("%s[Match]\nMACAddress=%s\n\n[Link]\nName=%s\n", header, ifc.MAC, ifc.Name)), Mode: 0o644, Rule: "network_config"})
		}
		out = append(out,
			NetChange{Path: "/etc/network/interfaces", Content: []byte(header + "auto lo\niface lo inet loopback\n\nsource /etc/network/interfaces.d/*\n"), Mode: 0o644, Rule: "network_config"},
			NetChange{Path: "/etc/network/interfaces.d/restow", Content: []byte(b.String()), Mode: 0o644, Rule: "network_config"})
		return out, nil
	}
	return nil, fmt.Errorf("network stack %q", s)
}

func q(s string) string { return `"` + s + `"` }

// RenderNetplan writes the netplan file of the fresh machine's network.
func RenderNetplan(n *TakeoverNet, oldNames []string, header string) string {
	var b strings.Builder
	b.WriteString(header)
	b.WriteString("network:\n  version: 2\n  ethernets:\n")
	for i, ifc := range n.Interfaces {
		fmt.Fprintf(&b, "    restow%d:\n      match:\n", i)
		if len(n.Interfaces) == 1 {
			fmt.Fprintf(&b, "        name: %s\n", q(namePattern(oldNames)))
		} else {
			fmt.Fprintf(&b, "        macaddress: %s\n", q(ifc.MAC))
		}
		fmt.Fprintf(&b, "      dhcp4: %v\n      dhcp6: false\n      accept-ra: %v\n", ifc.DHCP4, ifc.SLAAC)
		if ifc.MTU > 0 {
			fmt.Fprintf(&b, "      mtu: %d\n", ifc.MTU)
		}
		if len(ifc.Static) > 0 {
			b.WriteString("      addresses:\n")
			for _, a := range ifc.Static {
				fmt.Fprintf(&b, "        - %s\n", q(a))
			}
		}
		var routes []string
		for _, g := range []struct {
			gw, to string
			onlink bool
		}{{ifc.Gateway4, "0.0.0.0/0", ifc.OnLink4}, {ifc.Gateway6, "::/0", ifc.OnLink6}} {
			if g.gw == "" {
				continue
			}
			r := fmt.Sprintf("        - to: %s\n          via: %s\n", q(g.to), q(g.gw))
			if g.onlink {
				r += "          on-link: true\n"
			}
			routes = append(routes, r)
		}
		if len(routes) > 0 {
			b.WriteString("      routes:\n" + strings.Join(routes, ""))
		}
		if len(n.DNS) > 0 || len(n.Search) > 0 {
			b.WriteString("      nameservers:\n")
			if len(n.DNS) > 0 {
				b.WriteString("        addresses: [" + joinQuoted(n.DNS) + "]\n")
			}
			if len(n.Search) > 0 {
				b.WriteString("        search: [" + joinQuoted(n.Search) + "]\n")
			}
		}
	}
	return b.String()
}

func joinQuoted(list []string) string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = q(s)
	}
	return strings.Join(out, ", ")
}

// RenderNetworkd writes a systemd-networkd file for one interface with the
// given [Match] lines.
func RenderNetworkd(ifc TakeoverIface, dns, search []string, match string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[Match]\n%s\n\n", match)
	if ifc.MTU > 0 {
		fmt.Fprintf(&b, "[Link]\nMTUBytes=%d\n\n", ifc.MTU)
	}
	b.WriteString("[Network]\n")
	if ifc.DHCP4 {
		b.WriteString("DHCP=ipv4\n")
	} else {
		b.WriteString("DHCP=no\n")
	}
	fmt.Fprintf(&b, "IPv6AcceptRA=%s\nLinkLocalAddressing=ipv6\n", yesNo(ifc.SLAAC))
	for _, a := range ifc.Static {
		fmt.Fprintf(&b, "Address=%s\n", a)
	}
	for _, d := range dns {
		fmt.Fprintf(&b, "DNS=%s\n", d)
	}
	if len(search) > 0 {
		fmt.Fprintf(&b, "Domains=%s\n", strings.Join(search, " "))
	}
	for _, g := range []struct {
		gw     string
		onlink bool
	}{{ifc.Gateway4, ifc.OnLink4}, {ifc.Gateway6, ifc.OnLink6}} {
		if g.gw == "" {
			continue
		}
		fmt.Fprintf(&b, "\n[Route]\nGateway=%s\n", g.gw)
		if g.onlink {
			b.WriteString("GatewayOnLink=yes\n")
		}
	}
	return b.String()
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

// nmUUID is a fixed UUID for the connection of a MAC (the same input, the
// same file).
func nmUUID(mac string, i int) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("restow-nm:%s:%d", mac, i)))
	h[6] = h[6]&0x0f | 0x50
	h[8] = h[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

// RenderNMKeyfile writes a NetworkManager keyfile for one interface: bound
// to the MAC of the fresh machine only when it has several interfaces.
func RenderNMKeyfile(i int, ifc TakeoverIface, n *TakeoverNet, byMAC bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[connection]\nid=restow-%d\nuuid=%s\ntype=ethernet\nautoconnect=true\nautoconnect-priority=100\n\n[ethernet]\n", i, nmUUID(ifc.MAC, i))
	if byMAC {
		fmt.Fprintf(&b, "mac-address=%s\n", strings.ToUpper(ifc.MAC))
	}
	if ifc.MTU > 0 {
		fmt.Fprintf(&b, "mtu=%d\n", ifc.MTU)
	}
	var v4, v6 []string
	for _, a := range ifc.Static {
		ip, _, _ := net.ParseCIDR(a)
		if ip.To4() != nil {
			v4 = append(v4, a)
		} else {
			v6 = append(v6, a)
		}
	}
	section := func(name string, dhcp bool, addrs []string, gw string, onlink bool, def string) {
		fmt.Fprintf(&b, "\n[%s]\n", name)
		switch {
		case len(addrs) > 0:
			b.WriteString("method=manual\n")
			for k, a := range addrs {
				fmt.Fprintf(&b, "address%d=%s\n", k+1, a)
			}
		case dhcp:
			b.WriteString("method=auto\n")
		case name == "ipv6":
			b.WriteString("method=link-local\n")
		default:
			b.WriteString("method=disabled\n")
		}
		var dns []string
		for _, d := range n.DNS {
			if (net.ParseIP(d).To4() != nil) == (name == "ipv4") {
				dns = append(dns, d)
			}
		}
		if len(dns) > 0 {
			fmt.Fprintf(&b, "dns=%s;\n", strings.Join(dns, ";"))
		}
		if len(n.Search) > 0 && name == "ipv4" {
			fmt.Fprintf(&b, "dns-search=%s;\n", strings.Join(n.Search, ";"))
		}
		if gw != "" {
			fmt.Fprintf(&b, "route1=%s,%s\n", def, gw)
			if onlink {
				b.WriteString("route1_options=onlink=true\n")
			}
		}
	}
	section("ipv4", ifc.DHCP4, v4, ifc.Gateway4, ifc.OnLink4, "0.0.0.0/0")
	section("ipv6", ifc.SLAAC, v6, ifc.Gateway6, ifc.OnLink6, "::/0")
	return b.String()
}

// RenderIfupdown writes the stanzas of one interface for ifupdown. An
// on-link gateway is a route of its own (ifupdown's gateway line would
// fail on a /32).
func RenderIfupdown(ifc TakeoverIface, dns, search []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "allow-hotplug %s\n", ifc.Name)
	var v4, v6 []string
	for _, a := range ifc.Static {
		ip, _, _ := net.ParseCIDR(a)
		if ip.To4() != nil {
			v4 = append(v4, a)
		} else {
			v6 = append(v6, a)
		}
	}
	stanza := func(family string, dhcp bool, addrs []string, gw string, onlink bool) {
		switch {
		case len(addrs) > 0:
			fmt.Fprintf(&b, "iface %s %s static\n", ifc.Name, family)
			for _, a := range addrs {
				fmt.Fprintf(&b, "    address %s\n", a)
			}
			if gw != "" && !onlink {
				fmt.Fprintf(&b, "    gateway %s\n", gw)
			}
			if gw != "" && onlink {
				flag := ""
				if family == "inet6" {
					flag = "-6 "
				}
				fmt.Fprintf(&b, "    post-up ip %sroute add default via %s dev $IFACE onlink\n", flag, gw)
			}
			if ifc.MTU > 0 {
				fmt.Fprintf(&b, "    mtu %d\n", ifc.MTU)
			}
		case dhcp && family == "inet":
			fmt.Fprintf(&b, "iface %s inet dhcp\n", ifc.Name)
		case dhcp:
			fmt.Fprintf(&b, "iface %s inet6 auto\n", ifc.Name)
		default:
			return
		}
		if family == "inet" {
			if len(dns) > 0 {
				fmt.Fprintf(&b, "    dns-nameservers %s\n", strings.Join(dns, " "))
			}
			if len(search) > 0 {
				fmt.Fprintf(&b, "    dns-search %s\n", strings.Join(search, " "))
			}
		}
	}
	stanza("inet", ifc.DHCP4, v4, ifc.Gateway4, ifc.OnLink4)
	stanza("inet6", ifc.SLAAC, v6, ifc.Gateway6, ifc.OnLink6)
	return b.String() + "\n"
}

// CloudInitRestowCfg is the drop-in that limits cloud-init (11.2).
const CloudInitRestowCfg = "/etc/cloud/cloud.cfg.d/99-restow-restored.cfg"

// CloudInit is what the restored system's cloud-init does.
type CloudInit struct {
	Present         bool
	NetworkDisabled bool
	// Datasources is datasource_list (nil: not restricted).
	Datasources []string
}

var (
	reNetDisabled  = regexp.MustCompile(`(?m)^network:\s*\{\s*config:\s*disabled\s*\}|^network:\s*\n\s+config:\s*disabled`)
	reDSList       = regexp.MustCompile(`(?m)^datasource_list:\s*\[([^\]]*)\]`)
	reDSListBlock  = regexp.MustCompile(`(?m)^datasource_list:\s*\n((?:\s+-\s*\S+\s*\n?)+)`)
	reDSBlockEntry = regexp.MustCompile(`-\s*['"]?([A-Za-z0-9]+)`)
)

// ReadCloudInit reads cloud.cfg and cloud.cfg.d of the restored system.
func ReadCloudInit(fsys NetFS) CloudInit {
	var ci CloudInit
	main, err := fsys.ReadFile("/etc/cloud/cloud.cfg")
	if err != nil {
		return ci
	}
	if _, err := fsys.ReadFile("/etc/cloud/cloud-init.disabled"); err == nil {
		return ci
	}
	ci.Present = true
	files := [][]byte{main}
	for _, f := range filesIn(fsys, "/etc/cloud/cloud.cfg.d", ".cfg") {
		if f == CloudInitRestowCfg {
			continue
		}
		b, _ := fsys.ReadFile(f)
		files = append(files, b)
	}
	// Later files win (cloud.cfg.d in name order).
	for _, b := range files {
		if reNetDisabled.Match(b) {
			ci.NetworkDisabled = true
		}
		if m := reDSList.FindSubmatch(b); m != nil {
			ci.Datasources = nil
			for _, v := range strings.Split(string(m[1]), ",") {
				if v = strings.Trim(strings.TrimSpace(v), `'"`); v != "" {
					ci.Datasources = append(ci.Datasources, v)
				}
			}
		} else if m := reDSListBlock.FindSubmatch(b); m != nil {
			ci.Datasources = nil
			for _, e := range reDSBlockEntry.FindAllSubmatch(m[1], -1) {
				ci.Datasources = append(ci.Datasources, string(e[1]))
			}
		}
	}
	return ci
}

// cloudDatasources maps cloud-init's cloud_name to its datasources.
var cloudDatasources = map[string][]string{
	"hetzner": {"Hetzner"}, "aws": {"Ec2"}, "gce": {"GCE"}, "azure": {"Azure"}, "digitalocean": {"DigitalOcean"},
	"openstack": {"OpenStack", "ConfigDrive"}, "nocloud": {"NoCloud"}, "oracle": {"Oracle"}, "vultr": {"Vultr"},
	"scaleway": {"Scaleway"}, "exoscale": {"Exoscale"}, "upcloud": {"UpCloud"}, "ionos": {"IONOS", "ConfigDrive"},
	"configdrive": {"ConfigDrive"}, "akamai": {"Akamai"}, "linode": {"Akamai"},
}

// HasDatasourceFor reports whether cloud-init of the restored system would
// use the datasource of the fresh machine's cloud.
func (ci CloudInit) HasDatasourceFor(cloud string) bool {
	if !ci.Present || cloud == "" {
		return false
	}
	want, ok := cloudDatasources[strings.ToLower(cloud)]
	if !ok {
		return false
	}
	if ci.Datasources == nil {
		return true
	}
	for _, d := range ci.Datasources {
		for _, w := range want {
			if strings.EqualFold(d, w) {
				return true
			}
		}
	}
	return false
}

// CloudInitRestoredConfig is the drop-in of 11.2; disableNetwork adds
// network: {config: disabled} (the network comes from Restow's own file,
// or stays as restored).
func CloudInitRestoredConfig(header string, disableNetwork bool) string {
	var b strings.Builder
	b.WriteString(header)
	b.WriteString("# This system was restored onto a new instance. cloud-init may set up the\n" +
		"# network of this instance; everything else stays as restored.\n" +
		"# Delete this file to give cloud-init its usual role back.\n" +
		"cloud_init_modules: []\ncloud_config_modules: []\ncloud_final_modules: []\n" +
		"ssh_deletekeys: false\nssh_genkeytypes: []\npreserve_hostname: true\n")
	if disableNetwork {
		b.WriteString("network: {config: disabled}\n")
	}
	return b.String()
}

// CheckTakeover checks the written files (10.5): every networkd and
// NetworkManager file parses as INI, every static address of the fresh
// machine stands in exactly one written file (none when cloud-init brings
// the network up). It returns the problems found.
func CheckTakeover(p *NetPlan, n *TakeoverNet) []string {
	var problems []string
	var written []NetChange
	for _, c := range p.Changes {
		if c.Remove || c.Rule != "network_config" {
			continue
		}
		written = append(written, c)
		if strings.HasSuffix(c.Path, ".network") || strings.HasSuffix(c.Path, ".nmconnection") || strings.HasSuffix(c.Path, ".link") {
			if err := checkINI(string(c.Content)); err != nil {
				problems = append(problems, fmt.Sprintf("%s: %v", c.Path, err))
			}
		}
	}
	if p.CloudInitNetwork {
		return problems
	}
	for _, ifc := range n.Interfaces {
		for _, a := range ifc.Static {
			want, wantNet, err := net.ParseCIDR(a)
			if err != nil {
				problems = append(problems, fmt.Sprintf("address %q", a))
				continue
			}
			wantOnes, _ := wantNet.Mask.Size()
			count := 0
			for _, c := range written {
				// The addresses in the file, parsed: 10.0.2.15/32 is not
				// 10.0.2.15/320, and 2001:db8::7/64 is 2001:db8:0::7/64.
				for _, tok := range reCIDRToken.FindAllString(string(c.Content), -1) {
					ip, n, err := net.ParseCIDR(tok)
					if err != nil {
						continue
					}
					if ones, _ := n.Mask.Size(); ip.Equal(want) && ones == wantOnes {
						count++
						break
					}
				}
			}
			if count != 1 {
				problems = append(problems, fmt.Sprintf("the address %s stands in %d written files, not in one", a, count))
			}
		}
	}
	return problems
}

var reCIDRToken = regexp.MustCompile(`[0-9A-Fa-f.:]+/[0-9]{1,3}\b`)

func checkINI(s string) error {
	section := false
	for i, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(l)
		switch {
		case l == "" || strings.HasPrefix(l, "#") || strings.HasPrefix(l, ";"):
		case strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]") && len(l) > 2:
			section = true
		case strings.Contains(l, "=") && section && !strings.HasPrefix(l, "="):
		default:
			return fmt.Errorf("line %d is no INI line", i+1)
		}
	}
	return nil
}
