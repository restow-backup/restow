package oneshot

import (
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

func TestParseNetworkOfACloudMachine(t *testing.T) {
	ifs, routes, problems, err := ParseNetwork([]byte(addrJSON), []byte(route4JSON), []byte(route6JSON))
	if err != nil || len(problems) != 0 {
		t.Fatalf("err %v, problems %v", err, problems)
	}
	if len(ifs) != 1 || ifs[0].Name != "eth0" || ifs[0].MAC != "96:00:01:02:03:04" || ifs[0].MTU != 1500 || !ifs[0].DHCP4 || ifs[0].SLAAC {
		t.Fatalf("interfaces %+v", ifs)
	}
	if len(ifs[0].Addresses) != 2 || ifs[0].Addresses[0].Address != "203.0.113.7" || ifs[0].Addresses[0].Prefix != 32 {
		t.Errorf("addresses %+v (loopback and link-local are left out)", ifs[0].Addresses)
	}
	// 172.31.1.1 lies outside 203.0.113.7/32: on-link. fe80::1 is link-local: not on-link in that sense.
	if len(routes) != 2 || !routes[0].OnLink || routes[0].Gateway != "172.31.1.1" || routes[1].Family != "inet6" || routes[1].OnLink {
		t.Errorf("routes %+v", routes)
	}
	// A gateway inside the prefix is not on-link; the flag is taken as it is.
	_, routes, _, _ = ParseNetwork([]byte(strings.Replace(addrJSON, `"prefixlen":32`, `"prefixlen":24`, 1)),
		[]byte(`[{"dst":"default","gateway":"203.0.113.1","dev":"eth0"},{"dst":"10.0.0.0/8","gateway":"10.0.0.1","dev":"eth0"}]`), nil)
	if len(routes) != 1 || routes[0].OnLink {
		t.Errorf("routes %+v", routes)
	}
	_, routes, _, _ = ParseNetwork([]byte(addrJSON), []byte(`[{"dst":"default","gateway":"203.0.113.1","dev":"eth0","flags":["onlink"]}]`), nil)
	if len(routes) != 1 || !routes[0].OnLink {
		t.Errorf("routes %+v", routes)
	}
}

func TestParseNetworkProblems(t *testing.T) {
	bond := strings.Replace(addrJSON, `"link_type":"ether",`, `"link_type":"ether","linkinfo":{"info_slave_kind":"bond"},`, 1)
	_, _, problems, _ := ParseNetwork([]byte(bond), nil, nil)
	if len(problems) != 1 || problems[0].Code != "virtual_interface" || !strings.Contains(problems[0].Detail, "bond") {
		t.Errorf("problems %+v", problems)
	}
	two := `[{"dst":"default","gateway":"172.31.1.1","dev":"eth0"},{"dst":"default","gateway":"172.31.1.2","dev":"eth0","metric":200}]`
	_, _, problems, _ = ParseNetwork([]byte(addrJSON), []byte(two), nil)
	if len(problems) != 1 || problems[0].Code != "several_default_routes" {
		t.Errorf("problems %+v", problems)
	}
	if _, _, _, err := ParseNetwork([]byte("not json"), nil, nil); err == nil {
		t.Error("broken ip output accepted")
	}
	if _, _, _, err := ParseNetwork([]byte(addrJSON), []byte("{"), nil); err == nil {
		t.Error("broken route output accepted")
	}
	// An interface without a global address is no problem, and not reported.
	down := `[{"ifname":"eth1","link_type":"ether","linkinfo":{"info_kind":"vlan"},"addr_info":[{"family":"inet6","local":"fe80::1","prefixlen":64,"scope":"link"}]}]`
	ifs, _, problems, _ := ParseNetwork([]byte(down), nil, nil)
	if len(ifs) != 0 || len(problems) != 0 {
		t.Errorf("interfaces %+v, problems %+v", ifs, problems)
	}
}

func TestParseRules(t *testing.T) {
	if p := ParseRules([]byte(rulesJSON), []byte(rulesJSON), nil, []byte("garbage")); len(p) != 0 {
		t.Errorf("problems %+v", p)
	}
	if p := ParseRules([]byte(`[{"priority":5,"table":"wg"}]`)); len(p) != 1 || p[0].Code != "policy_routing" {
		t.Errorf("problems %+v", p)
	}
}

func TestParseResolvAndInstanceData(t *testing.T) {
	dns, search := ParseResolv([]byte("# x\nnameserver 127.0.0.53\nnameserver 1.1.1.1\nnameserver ::1\nnameserver 2606:4700:4700::1111\nsearch a.example b.example a.example\ndomain c.example\nnameserver junk\n"))
	if strings.Join(dns, ",") != "1.1.1.1,2606:4700:4700::1111" || strings.Join(search, ",") != "a.example,b.example,c.example" {
		t.Errorf("dns %v, search %v", dns, search)
	}
	if c := ParseInstanceData([]byte(`{"v1":{"cloud_name":"aws","platform":"ec2","instance_id":"i-1","region":"eu-central-1"}}`)); c == nil || c.Name != "aws" || c.InstanceID != "i-1" {
		t.Errorf("cloud %+v", c)
	}
	for _, b := range []string{"", "{}", "null", "[1]"} {
		if c := ParseInstanceData([]byte(b)); c != nil {
			t.Errorf("%q: cloud %+v", b, c)
		}
	}
}

func TestParseProcFiles(t *testing.T) {
	total, avail := ParseMeminfo([]byte("MemTotal:  2048 kB\nMemFree: 1 kB\nMemAvailable: 1024 kB\nHugePages_Total: 0\n"))
	if total != 2048*1024 || avail != 1024*1024 {
		t.Errorf("meminfo %d %d", total, avail)
	}
	for in, want := range map[string]string{"none [integrity] confidentiality\n": "integrity", "[none] integrity confidentiality": "none", "": "", "x]y[": ""} {
		if got := ParseLockdown([]byte(in)); got != want {
			t.Errorf("lockdown %q = %q", in, got)
		}
	}
	if ParseUptime([]byte("90061.33 1.0\n")) != 90061 || ParseUptime(nil) != 0 {
		t.Error("uptime")
	}
}

func TestInUse(t *testing.T) {
	if got := InUse(Usage{UptimeSeconds: 3600, HomeUsers: 1, UsedBytes: 2e9}); len(got) != 0 {
		t.Errorf("a fresh machine looks in use: %v", got)
	}
	got := InUse(Usage{AgentEnrolled: true, UptimeSeconds: 2 * 86400, HomeUsers: 3, Services: []string{"nginx"}, UsedBytes: 6e9})
	want := []string{api.OneshotInUseAgent, api.OneshotInUseData, api.OneshotInUseServices, api.OneshotInUseUptime, api.OneshotInUseUsers}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("signs %v", got)
	}
}

func TestParseAnswers(t *testing.T) {
	good := `{"format":"restow-oneshot-answers-v1","confirmErase":["serial.QM00001"],"passphrase":"x","language":"de","keymap":"de"}`
	if a, err := ParseAnswers([]byte(good)); err != nil || a.ConfirmErase[0] != "serial.QM00001" || a.Language != "de" {
		t.Fatalf("%+v %v", a, err)
	}
	for name, b := range map[string]string{
		"code":          `{"format":"restow-oneshot-answers-v1","confirmErase":["serial.QM00001"],"code":"OS-x"}`,
		"unknown field": `{"format":"restow-oneshot-answers-v1","confirmErase":["serial.QM00001"],"snapshotId":"x"}`,
		"format":        `{"format":"restow-answers-v1","confirmErase":["serial.QM00001"]}`,
		"no disk":       `{"format":"restow-oneshot-answers-v1","confirmErase":[]}`,
		"twice":         `{"format":"restow-oneshot-answers-v1","confirmErase":["serial.A","serial.A"]}`,
		"not identity":  `{"format":"restow-oneshot-answers-v1","confirmErase":["/dev/sda"]}`,
		"language":      `{"format":"restow-oneshot-answers-v1","confirmErase":["serial.A"],"language":"fr"}`,
		"not json":      `confirmErase: all`,
	} {
		if _, err := ParseAnswers([]byte(b)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := ParseAnswers([]byte(`{"format":"restow-oneshot-answers-v1","confirmErase":["serial.A"],"code":"OS-x"}`)); err == nil || !strings.Contains(err.Error(), "stdin") {
		t.Errorf("code: %v", err)
	}
}
