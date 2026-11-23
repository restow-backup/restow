package baremetal

import (
	"errors"
	"io/fs"
	"path"
	"sort"
	"strings"
	"testing"
)

// mapFS is a restored system for the takeover: files and symbolic links.
type mapFS struct {
	files map[string]string
	links map[string]bool
}

func (m mapFS) ReadFile(p string) ([]byte, error) {
	if s, ok := m.files[p]; ok {
		return []byte(s), nil
	}
	return nil, fs.ErrNotExist
}

func (m mapFS) ReadDir(p string) ([]string, error) {
	seen := map[string]bool{}
	for f := range m.files {
		if path.Dir(f) == p {
			seen[path.Base(f)] = true
		} else if strings.HasPrefix(f, p+"/") {
			seen[strings.SplitN(strings.TrimPrefix(f, p+"/"), "/", 2)[0]] = true
		}
	}
	if len(seen) == 0 {
		return nil, fs.ErrNotExist
	}
	var out []string
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out, nil
}

func (m mapFS) IsSymlink(p string) bool { return m.links[p] }

const hdr = "# written by Restow\n"

// hetzner is the network of a Hetzner cloud server: DHCP for IPv4, static
// IPv6 with fe80::1.
func hetzner() *TakeoverNet {
	return &TakeoverNet{Interfaces: []TakeoverIface{{Name: "eth0", MAC: "96:00:01:02:03:04", MTU: 1500, DHCP4: true,
		Static: []string{"2001:db8:1::7/64"}, Gateway6: "fe80::1"}}, DNS: []string{"185.12.64.1"}, Cloud: "hetzner"}
}

// static32 is a /32 with an on-link gateway, no DHCP.
func static32() *TakeoverNet {
	return &TakeoverNet{Interfaces: []TakeoverIface{{Name: "ens3", MAC: "52:54:00:aa:bb:cc", Static: []string{"203.0.113.7/32"},
		Gateway4: "172.31.1.1", OnLink4: true}}, DNS: []string{"1.1.1.1"}, Search: []string{"corp.example"}}
}

func changeOf(p *NetPlan, path string) *NetChange {
	for i := range p.Changes {
		if p.Changes[i].Path == path {
			return &p.Changes[i]
		}
	}
	return nil
}

func TestTakeoverUbuntuWithCloudInitOfTheNewProvider(t *testing.T) {
	fsys := mapFS{files: map[string]string{
		"/etc/netplan/50-cloud-init.yaml": "network:\n  ethernets:\n    eth0:\n      dhcp4: true\n      match:\n        macaddress: 52:54:00:11:22:33\n",
		"/etc/cloud/cloud.cfg":            "datasource_list: [ NoCloud, Hetzner, None ]\n",
	}}
	p, err := PlanTakeover(fsys, hetzner(), []string{"52:54:00:11:22:33"}, []string{"eth0"}, true, hdr)
	if err != nil {
		t.Fatal(err)
	}
	if p.Stack != StackNetplan || !p.CloudInitNetwork {
		t.Fatalf("stack %s, cloud-init %v", p.Stack, p.CloudInitNetwork)
	}
	if c := changeOf(p, "/etc/netplan/50-cloud-init.yaml"); c == nil || !c.Remove {
		t.Error("the old netplan file stays")
	}
	if changeOf(p, "/etc/netplan/60-restow.yaml") != nil {
		t.Error("an own file although cloud-init brings the network up")
	}
	ci := changeOf(p, CloudInitRestowCfg)
	if ci == nil || strings.Contains(string(ci.Content), "network:") || !strings.Contains(string(ci.Content), "ssh_deletekeys: false") {
		t.Errorf("cloud-init drop-in %+v", ci)
	}
	if probs := CheckTakeover(p, hetzner()); len(probs) != 0 {
		t.Error(probs)
	}
}

func TestTakeoverNetplanForAnotherProvider(t *testing.T) {
	fsys := mapFS{files: map[string]string{
		"/etc/netplan/50-cloud-init.yaml": "network:\n  ethernets:\n    ens3:\n      addresses: [192.0.2.10/24]\n",
		"/etc/netplan/01-renderer.yaml":   "network:\n  renderer: networkd\n",
		"/etc/cloud/cloud.cfg":            "datasource_list: [ Ec2, None ]\n",
	}}
	p, err := PlanTakeover(fsys, hetzner(), nil, []string{"ens3"}, true, hdr)
	if err != nil {
		t.Fatal(err)
	}
	np := changeOf(p, "/etc/netplan/60-restow.yaml")
	if p.CloudInitNetwork || np == nil || np.Mode != 0o600 {
		t.Fatalf("cloud-init %v, file %+v", p.CloudInitNetwork, np)
	}
	for _, want := range []string{`name: "en*"`, "dhcp4: true", `- "2001:db8:1::7/64"`, `to: "::/0"`, `via: "fe80::1"`, `addresses: ["185.12.64.1"]`} {
		if !strings.Contains(string(np.Content), want) {
			t.Errorf("netplan lacks %q:\n%s", want, np.Content)
		}
	}
	if changeOf(p, "/etc/netplan/01-renderer.yaml") != nil {
		t.Error("a netplan file without interfaces was put aside")
	}
	if ci := changeOf(p, CloudInitRestowCfg); ci == nil || !strings.Contains(string(ci.Content), "network: {config: disabled}") {
		t.Errorf("cloud-init drop-in %+v", ci)
	}
	if probs := CheckTakeover(p, hetzner()); len(probs) != 0 {
		t.Error(probs)
	}
}

func TestTakeoverNetworkdWithTwoInterfaces(t *testing.T) {
	n := static32()
	n.Interfaces = append(n.Interfaces, TakeoverIface{Name: "ens4", MAC: "52:54:00:aa:bb:cd", DHCP4: true})
	fsys := mapFS{files: map[string]string{
		"/etc/systemd/system/multi-user.target.wants/systemd-networkd.service": "",
		"/etc/systemd/network/20-wired.network":                                "[Match]\nName=enp1s0\n[Network]\nAddress=192.0.2.5/24\nGateway=192.0.2.1\n",
		"/etc/systemd/network/10-wan.link":                                     "[Match]\nMACAddress=52:54:00:11:22:33\n[Link]\nName=wan\n",
	}}
	p, err := PlanTakeover(fsys, n, []string{"52:54:00:11:22:33"}, []string{"wan"}, true, hdr)
	if err != nil {
		t.Fatal(err)
	}
	if p.Stack != StackNetworkd {
		t.Fatal(p.Stack)
	}
	f0, f1 := changeOf(p, "/etc/systemd/network/10-restow-0.network"), changeOf(p, "/etc/systemd/network/10-restow-1.network")
	if f0 == nil || f1 == nil || !strings.Contains(string(f0.Content), "MACAddress=52:54:00:aa:bb:cc") || !strings.Contains(string(f0.Content), "GatewayOnLink=yes") ||
		!strings.Contains(string(f1.Content), "DHCP=ipv4") {
		t.Fatalf("%+v", p.Changes)
	}
	if c := changeOf(p, "/etc/systemd/network/20-wired.network"); c == nil || !c.Remove {
		t.Error("the old network file stays")
	}
	if c := changeOf(p, "/etc/systemd/network/10-wan.link"); c == nil || !c.Remove || c.Rule != "network_binding" {
		t.Error("the link file of the old MAC stays")
	}
	if changeOf(p, CloudInitRestowCfg) != nil {
		t.Error("a cloud-init file without cloud-init")
	}
	if probs := CheckTakeover(p, n); len(probs) != 0 {
		t.Error(probs)
	}
}

func TestTakeoverNetworkManagerOfRHEL(t *testing.T) {
	fsys := mapFS{files: map[string]string{
		"/etc/systemd/system/multi-user.target.wants/NetworkManager.service": "",
		"/etc/sysconfig/network-scripts/ifcfg-eth0":                          "DEVICE=eth0\nHWADDR=52:54:00:11:22:33\nBOOTPROTO=dhcp\n",
		"/etc/sysconfig/network-scripts/ifcfg-lo":                            "DEVICE=lo\n",
		"/etc/NetworkManager/system-connections/wifi.nmconnection":           "[connection]\ntype=wifi\n",
		"/etc/resolv.conf": "nameserver 10.0.0.1\n",
	}}
	p, err := PlanTakeover(fsys, static32(), []string{"52:54:00:11:22:33"}, []string{"eth0"}, true, hdr)
	if err != nil {
		t.Fatal(err)
	}
	k := changeOf(p, "/etc/NetworkManager/system-connections/restow-0.nmconnection")
	if p.Stack != StackNetworkManager || k == nil || k.Mode != 0o600 {
		t.Fatalf("%s %+v", p.Stack, k)
	}
	for _, want := range []string{"method=manual", "address1=203.0.113.7/32", "route1=0.0.0.0/0,172.31.1.1", "route1_options=onlink=true", "dns=1.1.1.1;", "dns-search=corp.example;"} {
		if !strings.Contains(string(k.Content), want) {
			t.Errorf("keyfile lacks %q:\n%s", want, k.Content)
		}
	}
	if strings.Contains(string(k.Content), "mac-address") {
		t.Error("one interface is bound to a MAC")
	}
	if c := changeOf(p, "/etc/sysconfig/network-scripts/ifcfg-eth0"); c == nil || !c.Remove {
		t.Error("ifcfg-eth0 stays")
	}
	if changeOf(p, "/etc/sysconfig/network-scripts/ifcfg-lo") != nil || changeOf(p, "/etc/NetworkManager/system-connections/wifi.nmconnection") != nil {
		t.Error("lo or a wifi connection was put aside")
	}
	if rc := changeOf(p, "/etc/resolv.conf"); rc == nil || !strings.Contains(string(rc.Content), "nameserver 1.1.1.1") {
		t.Errorf("resolv.conf %+v", rc)
	}
}

func TestTakeoverIfupdownOfDebian(t *testing.T) {
	fsys := mapFS{files: map[string]string{
		"/etc/systemd/system/network-online.target.wants/networking.service": "",
		"/etc/network/interfaces":                   "auto lo\niface lo inet loopback\nallow-hotplug eth0\niface eth0 inet static\n  address 192.0.2.10/24\n  gateway 192.0.2.1\n",
		"/etc/udev/rules.d/70-persistent-net.rules": "SUBSYSTEM==\"net\", ATTR{address}==\"52:54:00:11:22:33\", NAME=\"eth0\"\n",
	}, links: map[string]bool{"/etc/resolv.conf": true}}
	p, err := PlanTakeover(fsys, static32(), []string{"52:54:00:11:22:33"}, []string{"eth0"}, true, hdr)
	if err != nil {
		t.Fatal(err)
	}
	if p.Stack != StackIfupdown {
		t.Fatal(p.Stack)
	}
	d := changeOf(p, "/etc/network/interfaces.d/restow")
	if d == nil || !strings.Contains(string(d.Content), "iface ens3 inet static") || !strings.Contains(string(d.Content), "post-up ip route add default via 172.31.1.1 dev $IFACE onlink") ||
		strings.Contains(string(d.Content), "gateway 172.31.1.1") {
		t.Fatalf("%+v", d)
	}
	if l := changeOf(p, "/etc/systemd/network/10-restow-0.link"); l == nil || !strings.Contains(string(l.Content), "Name=ens3") {
		t.Errorf("link %+v", l)
	}
	var iface []NetChange
	for _, c := range p.Changes {
		if c.Path == "/etc/network/interfaces" {
			iface = append(iface, c)
		}
	}
	if len(iface) != 2 || !iface[0].Remove || !strings.Contains(string(iface[1].Content), "source /etc/network/interfaces.d/*") {
		t.Errorf("interfaces %+v", iface)
	}
	if c := changeOf(p, "/etc/udev/rules.d/70-persistent-net.rules"); c == nil || !c.Remove {
		t.Error("the udev rule of the old MAC stays")
	}
	if changeOf(p, "/etc/resolv.conf") != nil {
		t.Error("a link resolv.conf was rewritten")
	}
	if probs := CheckTakeover(p, static32()); len(probs) != 0 {
		t.Error(probs)
	}
}

func TestTakeoverRefusals(t *testing.T) {
	both := mapFS{files: map[string]string{
		"/etc/systemd/system/multi-user.target.wants/NetworkManager.service":   "",
		"/etc/systemd/system/multi-user.target.wants/systemd-networkd.service": "",
		"/etc/systemd/network/20-wired.network":                                "[Network]\nDHCP=yes\n",
		"/etc/NetworkManager/system-connections/eth.nmconnection":              "[connection]\ntype=ethernet\n",
	}}
	if _, err := PlanTakeover(both, static32(), nil, nil, true, hdr); !errors.Is(err, ErrNetStackUnclear) {
		t.Errorf("two stacks: %v", err)
	}
	if _, err := PlanTakeover(mapFS{files: map[string]string{}}, static32(), nil, nil, true, hdr); err == nil {
		t.Error("no stack accepted")
	}
	for name, edit := range map[string]func(n *TakeoverNet){
		"mac":      func(n *TakeoverNet) { n.Interfaces[0].MAC = "52:54:00:aa:bb:cc\n[Match]" },
		"name":     func(n *TakeoverNet) { n.Interfaces[0].Name = "eth0;reboot" },
		"address":  func(n *TakeoverNet) { n.Interfaces[0].Static = []string{"203.0.113.7"} },
		"gateway":  func(n *TakeoverNet) { n.Interfaces[0].Gateway4 = "fe80::1" },
		"dns":      func(n *TakeoverNet) { n.DNS = []string{"1.1.1.1\nnameserver 6.6.6.6"} },
		"search":   func(n *TakeoverNet) { n.Search = []string{"a.example\n"} },
		"mtu":      func(n *TakeoverNet) { n.Interfaces[0].MTU = 70000 },
		"no iface": func(n *TakeoverNet) { n.Interfaces = nil },
	} {
		n := static32()
		edit(n)
		if _, err := PlanTakeover(both, n, nil, nil, true, hdr); err == nil || errors.Is(err, ErrNetStackUnclear) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestKeepTheOldNetwork(t *testing.T) {
	fsys := mapFS{files: map[string]string{
		"/etc/netplan/50-cloud-init.yaml":           "network:\n  ethernets:\n    eth0:\n      dhcp4: true\n",
		"/etc/cloud/cloud.cfg":                      "users: [default]\n",
		"/etc/udev/rules.d/70-persistent-net.rules": "SUBSYSTEM==\"net\", ATTR{address}==\"52:54:00:11:22:33\", NAME=\"eth0\"\n",
	}}
	p, err := PlanTakeover(fsys, hetzner(), []string{"52:54:00:11:22:33"}, []string{"eth0"}, false, hdr)
	if err != nil {
		t.Fatal(err)
	}
	if changeOf(p, "/etc/netplan/50-cloud-init.yaml") != nil || changeOf(p, "/etc/netplan/60-restow.yaml") != nil {
		t.Error("the configuration changed although it is kept")
	}
	if c := changeOf(p, "/etc/udev/rules.d/70-persistent-net.rules"); c == nil || !c.Remove {
		t.Error("the binding to the old MAC stays")
	}
	if ci := changeOf(p, CloudInitRestowCfg); ci == nil || !strings.Contains(string(ci.Content), "config: disabled") {
		t.Errorf("cloud-init %+v", ci)
	}
}

func TestReadCloudInit(t *testing.T) {
	for name, tc := range map[string]struct {
		files map[string]string
		cloud string
		want  bool
	}{
		"no list":          {map[string]string{"/etc/cloud/cloud.cfg": "x: 1\n"}, "hetzner", true},
		"block list":       {map[string]string{"/etc/cloud/cloud.cfg": "datasource_list:\n  - Hetzner\n  - None\n"}, "hetzner", true},
		"other list":       {map[string]string{"/etc/cloud/cloud.cfg": "datasource_list: [Ec2]\n"}, "hetzner", false},
		"drop-in wins":     {map[string]string{"/etc/cloud/cloud.cfg": "datasource_list: [Ec2]\n", "/etc/cloud/cloud.cfg.d/90-ds.cfg": "datasource_list: [ Hetzner ]\n"}, "hetzner", true},
		"network disabled": {map[string]string{"/etc/cloud/cloud.cfg": "x: 1\n", "/etc/cloud/cloud.cfg.d/99-net.cfg": "network: {config: disabled}\n"}, "hetzner", false},
		"cloud-init off":   {map[string]string{"/etc/cloud/cloud.cfg": "x: 1\n", "/etc/cloud/cloud-init.disabled": ""}, "hetzner", false},
		"unknown cloud":    {map[string]string{"/etc/cloud/cloud.cfg": "x: 1\n"}, "somecloud", false},
		"no cloud-init":    {map[string]string{}, "hetzner", false},
	} {
		ci := ReadCloudInit(mapFS{files: tc.files})
		if got := ci.Present && !ci.NetworkDisabled && ci.HasDatasourceFor(tc.cloud); got != tc.want {
			t.Errorf("%s: %v (%+v)", name, got, ci)
		}
	}
}

func TestCheckTakeoverFindsMistakes(t *testing.T) {
	n := static32()
	p := &NetPlan{Changes: []NetChange{
		{Path: "/etc/systemd/network/10-restow-0.network", Content: []byte("[Match]\nType=ether\nnot an ini line\n"), Rule: "network_config"},
	}}
	probs := CheckTakeover(p, n)
	if len(probs) != 2 {
		t.Fatalf("%v", probs)
	}
	p.Changes = append(p.Changes, NetChange{Path: "/etc/network/interfaces.d/restow", Content: []byte("address 203.0.113.7/32\n"), Rule: "network_config"},
		NetChange{Path: "/etc/netplan/60-restow.yaml", Content: []byte("- 203.0.113.7/32\n"), Rule: "network_config"})
	if probs := CheckTakeover(p, n); len(probs) != 2 || !strings.Contains(probs[1], "2 written files") {
		t.Fatalf("%v", probs)
	}
	// Parsed, not a substring: /320 or another prefix is not the address.
	p.Changes = []NetChange{{Path: "/etc/network/interfaces.d/restow", Content: []byte("address 203.0.113.7/320\naddress 203.0.113.7/24\n"), Rule: "network_config"}}
	if probs := CheckTakeover(p, n); len(probs) != 1 || !strings.Contains(probs[0], "0 written files") {
		t.Fatalf("%v", probs)
	}
	// The same address in another spelling counts.
	v6 := &TakeoverNet{Interfaces: []TakeoverIface{{Name: "eth0", MAC: "52:54:00:aa:bb:cc", Static: []string{"2001:db8:0::7/64"}}}}
	p.Changes = []NetChange{{Path: "/etc/netplan/60-restow.yaml", Content: []byte(`- "2001:db8::7/64"`), Rule: "network_config"}}
	if probs := CheckTakeover(p, v6); len(probs) != 0 {
		t.Fatalf("%v", probs)
	}
}
