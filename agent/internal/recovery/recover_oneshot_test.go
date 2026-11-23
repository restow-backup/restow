package recovery

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"math/big"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func TestOneshotNetworkFiles(t *testing.T) {
	for _, tc := range []struct {
		name string
		net  string
		want []string
		not  []string
	}{
		{"a /32 with an on-link gateway and static IPv6 (Hetzner)", `{"interfaces":[{"name":"eth0","mac":"96:00:01:02:03:04","mtu":1500,"dhcp4":true,"slaac":false,
		  "addresses":[{"address":"203.0.113.7","prefix":32,"dynamic":true},{"address":"2001:db8:1::7","prefix":64,"dynamic":false}]}],
		  "routes":[{"family":"inet","gateway":"172.31.1.1","dev":"eth0","onlink":true},{"family":"inet6","gateway":"fe80::1","dev":"eth0","onlink":false}],
		  "dns":["185.12.64.1","2a01:4ff:ff00::add:1"],"searchDomains":["."]}`,
			[]string{"MACAddress=96:00:01:02:03:04", "MTUBytes=1500", "DHCP=ipv4", "IPv6AcceptRA=no", "LinkLocalAddressing=ipv6",
				"Address=2001:db8:1::7/64", "Gateway=fe80::1", "DNS=185.12.64.1", "DNS=2a01:4ff:ff00::add:1"},
			// The DHCP address and its route come from DHCP again.
			[]string{"Address=203.0.113.7", "Gateway=172.31.1.1", "Domains="}},
		{"static IPv4 /32 with on-link gateway", `{"interfaces":[{"name":"ens3","mac":"52:54:00:aa:bb:cc","mtu":0,"dhcp4":false,"slaac":false,
		  "addresses":[{"address":"10.0.2.15","prefix":32,"dynamic":false}]}],
		  "routes":[{"family":"inet","gateway":"10.0.2.2","dev":"ens3","onlink":true}],"dns":[],"searchDomains":["corp.example"]}`,
			[]string{"DHCP=no", "Address=10.0.2.15/32", "[Route]\nGateway=10.0.2.2\nGatewayOnLink=yes", "Domains=corp.example"},
			[]string{"MTUBytes"}},
		{"DHCP with SLAAC (AWS)", `{"interfaces":[{"name":"ens5","mac":"02:aa:bb:cc:dd:ee","mtu":9001,"dhcp4":true,"slaac":true,
		  "addresses":[{"address":"172.31.5.6","prefix":20,"dynamic":true},{"address":"2600:1f18::5","prefix":128,"dynamic":true}]}],
		  "routes":[{"family":"inet","gateway":"172.31.0.1","dev":"ens5","onlink":false},{"family":"inet6","gateway":"fe80::1","dev":"ens5","onlink":false}],"dns":[],"searchDomains":[]}`,
			[]string{"DHCP=ipv4", "IPv6AcceptRA=yes", "MTUBytes=9001"},
			[]string{"\nAddress=", "Gateway="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, err := ParseOneshotNetwork(json.RawMessage(tc.net))
			if err != nil {
				t.Fatal(err)
			}
			files, err := OneshotNetworkFiles(n)
			if err != nil || len(files) != 1 || files[0].Name != "10-restow-oneshot-0.network" {
				t.Fatalf("%+v %v", files, err)
			}
			for _, w := range tc.want {
				if !strings.Contains(files[0].Content, w) {
					t.Errorf("lacks %q:\n%s", w, files[0].Content)
				}
			}
			for _, w := range tc.not {
				if strings.Contains(files[0].Content, w) {
					t.Errorf("has %q:\n%s", w, files[0].Content)
				}
			}
		})
	}
}

func TestOneshotNetworkFilesRefuseWhatDoesNotBelong(t *testing.T) {
	base := func(edit func(m map[string]any)) json.RawMessage {
		m := map[string]any{"interfaces": []map[string]any{{"name": "eth0", "mac": "52:54:00:aa:bb:cc", "mtu": 1500, "dhcp4": false, "slaac": false,
			"addresses": []map[string]any{{"address": "10.0.2.15", "prefix": 24, "dynamic": false}}}},
			"routes": []map[string]any{{"family": "inet", "gateway": "10.0.2.2", "dev": "eth0", "onlink": false}},
			"dns":    []string{"10.0.2.3"}, "searchDomains": []string{}}
		edit(m)
		b, _ := json.Marshal(m)
		return b
	}
	iface := func(m map[string]any) map[string]any { return m["interfaces"].([]map[string]any)[0] }
	for name, edit := range map[string]func(m map[string]any){
		"newline in a domain": func(m map[string]any) { m["searchDomains"] = []string{"a.example\n[Network]\nDHCP=yes"} },
		"not an address":      func(m map[string]any) { m["dns"] = []string{"1.1.1.1\nDNS=6.6.6.6"} },
		"bad MAC":             func(m map[string]any) { iface(m)["mac"] = "52:54:00:aa:bb:cc\n[Match]" },
		"no MAC":              func(m map[string]any) { iface(m)["mac"] = "00:00:00:00:00:00" },
		"prefix": func(m map[string]any) {
			iface(m)["addresses"] = []map[string]any{{"address": "10.0.2.15", "prefix": 33}}
		},
		"gateway of the other family": func(m map[string]any) {
			m["routes"] = []map[string]any{{"family": "inet", "gateway": "fe80::1", "dev": "eth0"}}
		},
		"no interface": func(m map[string]any) { m["interfaces"] = []map[string]any{} },
	} {
		n, err := ParseOneshotNetwork(base(edit))
		if err == nil {
			_, err = OneshotNetworkFiles(n)
		}
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := ParseOneshotNetwork(json.RawMessage(`{"interfaces":[],"extra":1}`)); err == nil {
		t.Error("an unknown field accepted")
	}
}

func TestOneshotApprovedKeys(t *testing.T) {
	a, _ := ParseAuthorizedKey(testKeyLine(1))
	b, _ := ParseAuthorizedKey(testKeyLine(2))
	d := &OneshotData{SSHKeys: []string{a.Line(), b.Line()}}
	if keys, err := d.ApprovedKeys([]string{b.Fingerprint(), a.Fingerprint()}); err != nil || len(keys) != 2 {
		t.Fatalf("%v %v", keys, err)
	}
	for name, approved := range map[string][]string{
		"one shown":   {a.Fingerprint()},
		"other shown": {a.Fingerprint(), "SHA256:" + strings.Repeat("A", 43)},
		"none shown":  nil,
	} {
		if _, err := d.ApprovedKeys(approved); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := (&OneshotData{}).ApprovedKeys([]string{a.Fingerprint()}); err == nil {
		t.Error("no keys accepted")
	}
}

func otherCert(t *testing.T) *x509.Certificate {
	t.Helper()
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func testKeyLine(b byte) string {
	k, _ := ParseAuthorizedKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA x")
	k.Blob[len(k.Blob)-1] = b
	return k.Line()
}

func TestOneshotAnswersAndDecisions(t *testing.T) {
	d := &OneshotData{InstanceURL: "https://restow.example", Language: LangDE, ConfirmErase: []string{"serial.A"}, Passphrase: "p",
		SPKISHA256: strings.Repeat("ab", 32), CAPEM: "pem"}
	a := d.Answers()
	if a.Source != SourceOneshot || a.Keymap != "us" || a.Language != LangDE || !a.DiskMapping.Auto || a.AfterSuccess != "reboot" ||
		a.Shrink != "none" || a.SPKICheck != d.SPKISHA256 || string(a.CAPEM) != "pem" || a.Code != "" {
		t.Fatalf("%+v", a)
	}
	a.ApplyDecided(&api.OneshotDecided{ConfirmShrink: true, SecureBootWarningsOnly: true})
	if a.Shrink != "auto" || !a.SecureBootOff {
		t.Errorf("%+v", a)
	}
	a.ApplyDecided(&api.OneshotDecided{})
	if a.Shrink != "none" || a.SecureBootOff {
		t.Errorf("%+v", a)
	}
}

// The instance is taken by the whole SHA-256 of the key the command saw,
// never by another one.
func TestOneshotTrustByTheKeyTheCommandSaw(t *testing.T) {
	srv := httptest.NewTLSServer(nil)
	defer srv.Close()
	leaf := srv.Certificate()
	r := &Recover{Answers: &Answers{Source: SourceOneshot, SPKICheck: SPKISHA256(leaf)}}
	if err := r.trustFallback(&TLSProbe{Leaf: leaf}); err != nil || r.trust.Mode != TrustPinned {
		t.Fatalf("%v %v", err, r.trust.Mode)
	}
	r = &Recover{Answers: &Answers{Source: SourceOneshot, SPKICheck: SPKISHA256(leaf)}}
	if err := r.trustFallback(&TLSProbe{Leaf: otherCert(t)}); err == nil || ProblemCode(err) != ProblemSPKIMismatch {
		t.Fatalf("another key: %v", err)
	}
	// A typed 16-character check value is no SHA-256: refused.
	check, _ := SPKICheck(SPKISHA256(leaf))
	r = &Recover{Answers: &Answers{Source: SourceOneshot, SPKICheck: check}}
	if err := r.trustFallback(&TLSProbe{Leaf: leaf}); err == nil {
		t.Fatal("a check value accepted in place of the hash")
	}
	if err := (&Recover{Answers: &Answers{Source: SourceOneshot, SPKICheck: SPKISHA256(leaf)}}).trustFallback(&TLSProbe{Leaf: (*x509.Certificate)(nil)}); err == nil {
		t.Fatal("no certificate accepted")
	}
}
