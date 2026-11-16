package recovery

import (
	"fmt"
	"net"
	"strings"
)

// NetIface is a network interface as the console shows it (10.3).
type NetIface struct {
	Name      string
	MAC       string
	Driver    string
	Link      bool
	SpeedMbps int64
	Modalias  string
	Addresses []string
	Physical  bool
}

// StaticNetworkFile is the systemd-networkd file of a static address
// (/run/systemd/network/10-restow-static.network).
func StaticNetworkFile(n AnswersNetwork) (string, error) {
	if n.Mode != "static" {
		return "", fmt.Errorf("network mode %q is not static", n.Mode)
	}
	if err := (&n).check(); err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# written by restow-agent recover\n[Match]\nName=%s\n\n[Network]\nAddress=%s\n", n.Interface, n.Address)
	if n.Gateway != "" {
		fmt.Fprintf(&b, "Gateway=%s\n", n.Gateway)
	}
	for _, d := range n.DNS {
		fmt.Fprintf(&b, "DNS=%s\n", net.ParseIP(d).String())
	}
	b.WriteString("IPv6AcceptRA=no\nLinkLocalAddressing=no\n")
	return b.String(), nil
}

// NoAddressHint is the advice for an interface with link but no address
// after the wait (LACP or trunk port).
func NoAddressHint(ifs []NetIface) []string {
	var out []string
	for _, i := range ifs {
		if i.Physical && i.Link && len(i.Addresses) == 0 {
			out = append(out, i.Name)
		}
	}
	return out
}

// HasAddress reports whether a physical interface has a global address.
func HasAddress(ifs []NetIface) bool {
	for _, i := range ifs {
		if !i.Physical {
			continue
		}
		for _, a := range i.Addresses {
			ip, _, err := net.ParseCIDR(a)
			if err == nil && ip.IsGlobalUnicast() {
				return true
			}
		}
	}
	return false
}

// ParseLspciNoDriver lists the network devices of `lspci -k` without a
// kernel driver in use.
func ParseLspciNoDriver(out string) []string {
	var res []string
	var cur string
	hasDriver := false
	flush := func() {
		if cur != "" && !hasDriver {
			res = append(res, cur)
		}
	}
	for _, l := range strings.Split(out, "\n") {
		if l == "" {
			continue
		}
		if !strings.HasPrefix(l, "\t") && !strings.HasPrefix(l, " ") {
			flush()
			cur, hasDriver = "", false
			if strings.Contains(l, "Ethernet controller") || strings.Contains(l, "Network controller") {
				cur = strings.TrimSpace(l)
			}
			continue
		}
		if strings.Contains(l, "Kernel driver in use:") {
			hasDriver = true
		}
	}
	flush()
	return res
}
