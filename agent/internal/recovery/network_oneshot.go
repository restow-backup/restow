package recovery

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
)

// OneshotNetwork is the network the command measured on the fresh machine
// (docs/BAREMETAL-ONESHOT.md 10.1), as it comes in the session data.
type OneshotNetwork struct {
	Interfaces    []api.OneshotInterface `json:"interfaces"`
	Routes        []api.OneshotRoute     `json:"routes"`
	DNS           []string               `json:"dns"`
	SearchDomains []string               `json:"searchDomains"`
	// Cloud is cloud-init's view of the fresh machine (its datasource
	// decides who brings the network up in the restored system, 11.2).
	Cloud *api.OneshotCloud `json:"cloud,omitempty"`
}

// NetworkFile is one systemd-networkd file of the recovery environment.
type NetworkFile struct {
	Name    string
	Content string
}

var (
	reMAC    = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)
	reDomain = regexp.MustCompile(`^(\.|[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.?)$`)
)

// ParseOneshotNetwork reads the network of the session data.
func ParseOneshotNetwork(raw json.RawMessage) (*OneshotNetwork, error) {
	var n OneshotNetwork
	if len(bytes.TrimSpace(raw)) == 0 {
		return &n, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&n); err != nil {
		return nil, fmt.Errorf("oneshot network: %w", err)
	}
	return &n, nil
}

// OneshotNetworkFiles writes one networkd file per interface with an
// address, matched by its MAC (the same hardware; the name may differ
// under the recovery environment's udev, 10.2): DHCP where the machine had
// DHCP, router advertisements where it had SLAAC, its static addresses,
// default routes with GatewayOnLink where the gateway lies outside every
// prefix (a /32 with 172.31.1.1, IPv6 with fe80::1), link-local IPv6
// (without it no fe80:: gateway), its MTU and name servers. Every value
// is checked; nothing of the data reaches a file unchecked.
func OneshotNetworkFiles(n *OneshotNetwork) ([]NetworkFile, error) {
	var dns []string
	for _, d := range n.DNS {
		ip := net.ParseIP(d)
		if ip == nil {
			return nil, fmt.Errorf("oneshot network: name server %q", d)
		}
		dns = append(dns, ip.String())
	}
	var domains []string
	for _, d := range n.SearchDomains {
		if d == "." {
			continue
		}
		if !reDomain.MatchString(d) || len(d) > 253 {
			return nil, fmt.Errorf("oneshot network: search domain %q", d)
		}
		domains = append(domains, d)
	}
	var files []NetworkFile
	for i, ifc := range n.Interfaces {
		mac := strings.ToLower(ifc.MAC)
		if !reMAC.MatchString(mac) || mac == "00:00:00:00:00:00" {
			return nil, fmt.Errorf("oneshot network: %s has no usable MAC (%q)", ifc.Name, ifc.MAC)
		}
		if ifc.MTU < 0 || ifc.MTU > 65535 {
			return nil, fmt.Errorf("oneshot network: MTU %d", ifc.MTU)
		}
		var b strings.Builder
		b.WriteString("# written by restow-agent recover (oneshot restore)\n")
		fmt.Fprintf(&b, "[Match]\nMACAddress=%s\n\n", mac)
		if ifc.MTU >= 576 {
			fmt.Fprintf(&b, "[Link]\nMTUBytes=%d\n\n", ifc.MTU)
		}
		b.WriteString("[Network]\n")
		switch {
		case ifc.DHCP4:
			b.WriteString("DHCP=ipv4\n")
		default:
			b.WriteString("DHCP=no\n")
		}
		if ifc.SLAAC {
			b.WriteString("IPv6AcceptRA=yes\n")
		} else {
			b.WriteString("IPv6AcceptRA=no\n")
		}
		b.WriteString("LinkLocalAddressing=ipv6\n")
		var static4, static6 bool
		for _, a := range ifc.Addresses {
			ip := net.ParseIP(a.Address)
			if ip == nil || a.Prefix < 0 || (ip.To4() != nil && a.Prefix > 32) || a.Prefix > 128 {
				return nil, fmt.Errorf("oneshot network: address %q/%d", a.Address, a.Prefix)
			}
			v4 := ip.To4() != nil
			// What DHCP or SLAAC gave comes again the same way.
			if a.Dynamic && ((v4 && ifc.DHCP4) || (!v4 && ifc.SLAAC)) {
				continue
			}
			fmt.Fprintf(&b, "Address=%s/%d\n", ip.String(), a.Prefix)
			static4 = static4 || v4
			static6 = static6 || !v4
		}
		for _, d := range dns {
			fmt.Fprintf(&b, "DNS=%s\n", d)
		}
		if len(domains) > 0 {
			fmt.Fprintf(&b, "Domains=%s\n", strings.Join(domains, " "))
		}
		for _, r := range n.Routes {
			if r.Dev != ifc.Name {
				continue
			}
			gw := net.ParseIP(r.Gateway)
			if gw == nil || (r.Family == "inet") != (gw.To4() != nil) || (r.Family != "inet" && r.Family != "inet6") {
				return nil, fmt.Errorf("oneshot network: gateway %q", r.Gateway)
			}
			// A route DHCP or router advertisements give is left to them.
			if (r.Family == "inet" && !static4) || (r.Family == "inet6" && !static6 && ifc.SLAAC) {
				continue
			}
			fmt.Fprintf(&b, "\n[Route]\nGateway=%s\n", gw.String())
			if r.OnLink {
				b.WriteString("GatewayOnLink=yes\n")
			}
		}
		files = append(files, NetworkFile{Name: fmt.Sprintf("10-restow-oneshot-%d.network", i), Content: b.String()})
	}
	if len(files) == 0 {
		return nil, errors.New("oneshot network: no interface with an address")
	}
	return files, nil
}
