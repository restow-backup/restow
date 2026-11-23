// Package oneshot is `restow-agent oneshot`, the command an admin pastes on
// a fresh machine for a bare metal restore without ISO
// (docs/BAREMETAL-ONESHOT.md 8): it checks the machine, measures its network,
// exchanges the one-time code, fetches and checks the recovery ISO, loads
// its kernel on trial, asks the console to confirm the disks, waits for the
// release in Restow and switches into the recovery environment with kexec.
// Nothing changes on the machine before the release; until then the command
// writes only below /run and /var/tmp.
//
// The parsing and the decisions here have no build tag and are tested on
// every system; the machine (files, programs, kexec) is behind Env.
package oneshot

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
)

// ipAddrJSON is one interface of `ip -j -d addr show`.
type ipAddrJSON struct {
	IfName   string   `json:"ifname"`
	Address  string   `json:"address"`
	MTU      int      `json:"mtu"`
	LinkType string   `json:"link_type"`
	Flags    []string `json:"flags"`
	LinkInfo *struct {
		InfoKind      string `json:"info_kind"`
		InfoSlaveKind string `json:"info_slave_kind"`
	} `json:"linkinfo"`
	AddrInfo []struct {
		Family    string `json:"family"`
		Local     string `json:"local"`
		PrefixLen int    `json:"prefixlen"`
		Scope     string `json:"scope"`
		Dynamic   bool   `json:"dynamic"`
		MngTmp    bool   `json:"mngtmpaddr"`
		Temporary bool   `json:"temporary"`
	} `json:"addr_info"`
}

// ipRouteJSON is one route of `ip -j route show default`.
type ipRouteJSON struct {
	Dst      string   `json:"dst"`
	Gateway  string   `json:"gateway"`
	Dev      string   `json:"dev"`
	Metric   int64    `json:"metric"`
	Flags    []string `json:"flags"`
	Protocol string   `json:"protocol"`
}

// NetworkProblem is a network the command does not take over (10.1).
type NetworkProblem struct {
	Code   string
	Detail string
}

// ParseNetwork builds the interfaces and default routes from the JSON of
// `ip -j -d addr show`, `ip -j -4 route show default` and `ip -j -6 route
// show default`. Only interfaces with a global address count; loopback and
// link-local addresses are left out. An address on a VLAN, bond, bridge or
// other virtual interface, or more than one default route per family, is
// a problem: the restore does not take such a network over.
func ParseNetwork(addrJSON, route4JSON, route6JSON []byte) ([]api.OneshotInterface, []api.OneshotRoute, []NetworkProblem, error) {
	var links []ipAddrJSON
	if err := json.Unmarshal(addrJSON, &links); err != nil {
		return nil, nil, nil, fmt.Errorf("ip addr: %w", err)
	}
	var problems []NetworkProblem
	var ifs []api.OneshotInterface
	prefixes := map[string][]*net.IPNet{}
	for _, l := range links {
		if l.IfName == "lo" || l.LinkType == "loopback" {
			continue
		}
		oi := api.OneshotInterface{Name: l.IfName, MAC: strings.ToLower(l.Address), MTU: l.MTU, Addresses: []api.OneshotAddress{}}
		for _, a := range l.AddrInfo {
			ip := net.ParseIP(a.Local)
			if ip == nil || a.Scope != "global" || a.Temporary {
				continue
			}
			oi.Addresses = append(oi.Addresses, api.OneshotAddress{Address: ip.String(), Prefix: a.PrefixLen, Dynamic: a.Dynamic})
			if a.Family == "inet" && a.Dynamic {
				oi.DHCP4 = true
			}
			if a.Family == "inet6" && (a.Dynamic || a.MngTmp) {
				oi.SLAAC = true
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			prefixes[l.IfName] = append(prefixes[l.IfName], &net.IPNet{IP: ip.Mask(net.CIDRMask(a.PrefixLen, bits)), Mask: net.CIDRMask(a.PrefixLen, bits)})
		}
		if len(oi.Addresses) == 0 {
			continue
		}
		if l.LinkInfo != nil && l.LinkInfo.InfoKind != "" {
			problems = append(problems, NetworkProblem{Code: "virtual_interface",
				Detail: fmt.Sprintf("%s is a %s interface with an address", l.IfName, l.LinkInfo.InfoKind)})
		}
		if l.LinkInfo != nil && l.LinkInfo.InfoSlaveKind != "" {
			problems = append(problems, NetworkProblem{Code: "virtual_interface",
				Detail: fmt.Sprintf("%s is part of a %s and has an address", l.IfName, l.LinkInfo.InfoSlaveKind)})
		}
		ifs = append(ifs, oi)
	}
	var routes []api.OneshotRoute
	for _, fam := range []struct {
		name string
		data []byte
	}{{"inet", route4JSON}, {"inet6", route6JSON}} {
		var rs []ipRouteJSON
		if len(bytes.TrimSpace(fam.data)) > 0 {
			if err := json.Unmarshal(fam.data, &rs); err != nil {
				return nil, nil, nil, fmt.Errorf("ip route (%s): %w", fam.name, err)
			}
		}
		n := 0
		for _, r := range rs {
			if r.Dst != "default" || r.Gateway == "" {
				continue
			}
			gw := net.ParseIP(r.Gateway)
			if gw == nil {
				continue
			}
			onlink := hasString(r.Flags, "onlink")
			if !onlink && !gw.IsLinkLocalUnicast() {
				inside := false
				for _, p := range prefixes[r.Dev] {
					inside = inside || p.Contains(gw)
				}
				onlink = !inside
			}
			routes = append(routes, api.OneshotRoute{Family: fam.name, Gateway: gw.String(), Dev: r.Dev, OnLink: onlink, Metric: r.Metric})
			n++
		}
		if n > 1 {
			problems = append(problems, NetworkProblem{Code: "several_default_routes",
				Detail: fmt.Sprintf("%d default routes for %s", n, fam.name)})
		}
	}
	if ifs == nil {
		ifs = []api.OneshotInterface{}
	}
	if routes == nil {
		routes = []api.OneshotRoute{}
	}
	return ifs, routes, problems, nil
}

func hasString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ParseResolv reads the name servers and search domains of a resolv.conf;
// the local stub of systemd-resolved (127.0.0.53, 127.0.0.54) is left out.
func ParseResolv(b []byte) (dns, search []string) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 || strings.HasPrefix(f[0], "#") {
			continue
		}
		switch f[0] {
		case "nameserver":
			ip := net.ParseIP(f[1])
			if ip != nil && !ip.IsLoopback() && len(dns) < 8 {
				dns = append(dns, ip.String())
			}
		case "search", "domain":
			for _, d := range f[1:] {
				if len(search) < 8 && !hasString(search, d) {
					search = append(search, d)
				}
			}
		}
	}
	return dns, search
}

// ParseInstanceData reads cloud-init's /run/cloud-init/instance-data.json.
func ParseInstanceData(b []byte) *api.OneshotCloud {
	var v struct {
		V1 struct {
			CloudName  string `json:"cloud_name"`
			Platform   string `json:"platform"`
			InstanceID string `json:"instance_id"`
			Region     string `json:"region"`
		} `json:"v1"`
	}
	if json.Unmarshal(b, &v) != nil || (v.V1.CloudName == "" && v.V1.InstanceID == "") {
		return nil
	}
	return &api.OneshotCloud{Name: v.V1.CloudName, Platform: v.V1.Platform, InstanceID: v.V1.InstanceID, Region: v.V1.Region}
}

// ParseMeminfo returns MemTotal and MemAvailable in bytes.
func ParseMeminfo(b []byte) (total, available int64) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		v, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 2 && f[2] == "kB" {
			v *= 1024
		}
		switch f[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			available = v
		}
	}
	return total, available
}

// ParseLockdown returns the active mode of /sys/kernel/security/lockdown
// ("none [integrity] confidentiality" -> "integrity"), or "" when unknown.
func ParseLockdown(b []byte) string {
	s := string(b)
	i, j := strings.IndexByte(s, '['), strings.IndexByte(s, ']')
	if i < 0 || j < i {
		return ""
	}
	return s[i+1 : j]
}

// ParseUptime returns the seconds of /proc/uptime.
func ParseUptime(b []byte) int64 {
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

// Usage are the facts behind the signs of a machine in use (8.4).
type Usage struct {
	AgentEnrolled bool
	UptimeSeconds int64
	HomeUsers     int
	Services      []string
	UsedBytes     int64
}

// InUse names the signs that the machine is no fresh one: an enrolled
// Restow agent (the command stops), more than a day of uptime, more than
// one user with a home, database or web services, more than 5 GB of data
// outside the system.
func InUse(u Usage) []string {
	var out []string
	if u.AgentEnrolled {
		out = append(out, api.OneshotInUseAgent)
	}
	if u.UptimeSeconds > 24*3600 {
		out = append(out, api.OneshotInUseUptime)
	}
	if u.HomeUsers > 1 {
		out = append(out, api.OneshotInUseUsers)
	}
	if len(u.Services) > 0 {
		out = append(out, api.OneshotInUseServices)
	}
	if u.UsedBytes > 5_000_000_000 {
		out = append(out, api.OneshotInUseData)
	}
	sort.Strings(out)
	return out
}

// ServicesOfConcern are units whose activity says a machine is in use.
var ServicesOfConcern = []string{"mysql", "mariadb", "postgresql", "nginx", "apache2", "httpd", "docker", "containerd", "mongod", "redis-server", "slapd", "postfix", "dovecot"}

// ipRuleJSON is one rule of `ip -j rule show`.
type ipRuleJSON struct {
	Priority int64  `json:"priority"`
	Table    string `json:"table"`
}

// ParseRules returns a problem when the routing uses other tables than
// local, main and default (policy routing, 8.2): the restore does not take
// such a network over.
func ParseRules(rules ...[]byte) []NetworkProblem {
	var problems []NetworkProblem
	for _, b := range rules {
		if len(bytes.TrimSpace(b)) == 0 {
			continue
		}
		var rs []ipRuleJSON
		if json.Unmarshal(b, &rs) != nil {
			continue
		}
		for _, r := range rs {
			switch r.Table {
			case "local", "main", "default", "":
				continue
			}
			problems = append(problems, NetworkProblem{Code: "policy_routing",
				Detail: fmt.Sprintf("routing rule %d uses table %s", r.Priority, r.Table)})
			return problems
		}
	}
	return problems
}
