package recovery

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/redact"
)

const testEd25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f admin@laptop"

func oneshotJSON(t *testing.T, edit func(m map[string]any)) []byte {
	t.Helper()
	m := map[string]any{
		"format":       OneshotFormat,
		"instanceUrl":  "https://restow.example.com",
		"lang":         "de",
		"spkiSha256":   strings.Repeat("ab", 32),
		"session":      map[string]any{"id": "7f0c2a4e-0d7b-4c41-9f3e-2b1a5c6d7e8f", "secret": strings.Repeat("0f", 32)},
		"confirmErase": []string{"serial.QM00001"},
		"passphrase":   "correct horse",
		"sshKeys":      []string{testEd25519},
		"consoles":     []string{"tty1", "ttyS0,115200n8"},
		"network":      map[string]any{"interfaces": []any{}},
	}
	if edit != nil {
		edit(m)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestOneshotDataAccepted(t *testing.T) {
	d, err := LoadOneshotData(oneshotJSON(t, nil), false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Session.ID == "" || d.Passphrase != "correct horse" || len(d.SSHKeys) != 1 || len(d.Consoles) != 2 {
		t.Fatalf("%+v", d)
	}
}

// The data is a source of answers with secrets; everything that does not
// fit is refused, and nothing in it may stand for a code.
func TestOneshotDataRefused(t *testing.T) {
	cases := map[string]func(m map[string]any){
		"format":            func(m map[string]any) { m["format"] = "restow-answers-v1" },
		"a code":            func(m map[string]any) { m["code"] = "OS-00000-00000-00000-00000-00000" },
		"unknown field":     func(m map[string]any) { m["probe"] = map[string]any{} },
		"http outside QEMU": func(m map[string]any) { m["instanceUrl"] = "http://10.0.2.2:8080" },
		"path":              func(m map[string]any) { m["instanceUrl"] = "https://restow.example.com/x" },
		"credentials":       func(m map[string]any) { m["instanceUrl"] = "https://u:p@restow.example.com" },
		"ftp":               func(m map[string]any) { m["instanceUrl"] = "ftp://restow.example.com" },
		"lang":              func(m map[string]any) { m["lang"] = "fr" },
		"spki":              func(m map[string]any) { m["spkiSha256"] = "AB" },
		"ca":                func(m map[string]any) { m["caPem"] = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" },
		"session id": func(m map[string]any) {
			m["session"] = map[string]any{"id": "../x", "secret": strings.Repeat("0f", 32)}
		},
		"session secret":   func(m map[string]any) { m["session"] = map[string]any{"id": "a", "secret": "short"} },
		"no confirmation":  func(m map[string]any) { m["confirmErase"] = []string{} },
		"bad identity":     func(m map[string]any) { m["confirmErase"] = []string{"sda"} },
		"identity twice":   func(m map[string]any) { m["confirmErase"] = []string{"serial.A", "serial.A"} },
		"long passphrase":  func(m map[string]any) { m["passphrase"] = strings.Repeat("x", 513) },
		"key with options": func(m map[string]any) { m["sshKeys"] = []string{`command="/bin/sh" ` + testEd25519} },
		"not a key":        func(m map[string]any) { m["sshKeys"] = []string{"ssh-ed25519 notbase64!"} },
		"wrong key type": func(m map[string]any) {
			m["sshKeys"] = []string{strings.Replace(testEd25519, "ssh-ed25519", "ssh-rsa", 1)}
		},
		"too many keys": func(m map[string]any) {
			ks := make([]string, MaxOneshotSSHKeys+1)
			for i := range ks {
				ks[i] = testEd25519
			}
			m["sshKeys"] = ks
		},
		"console":       func(m map[string]any) { m["consoles"] = []string{"ttyS0 init=/bin/sh"} },
		"network":       func(m map[string]any) { m["network"] = "x" },
		"trailing data": nil,
	}
	for name, edit := range cases {
		b := oneshotJSON(t, edit)
		if name == "trailing data" {
			b = append(b, []byte(" {}")...)
		}
		if _, err := LoadOneshotData(b, false); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := LoadOneshotData(make([]byte, MaxOneshotBytes+1), false); err == nil {
		t.Error("too large: accepted")
	}
	// http only in a QEMU machine (the CI cases).
	if _, err := LoadOneshotData(oneshotJSON(t, func(m map[string]any) { m["instanceUrl"] = "http://10.0.2.2:8080" }), true); err != nil {
		t.Errorf("http in QEMU: %v", err)
	}
}

func TestAuthorizedKeyFingerprint(t *testing.T) {
	k, err := ParseAuthorizedKey(testEd25519)
	if err != nil {
		t.Fatal(err)
	}
	if k.Type != "ssh-ed25519" || k.Comment != "admin@laptop" || !strings.HasPrefix(k.Fingerprint(), "SHA256:") || len(k.Fingerprint()) != 50 {
		t.Fatalf("%+v %s", k, k.Fingerprint())
	}
	if k.Line() != strings.TrimSuffix(testEd25519, " admin@laptop") {
		t.Fatalf("line %q", k.Line())
	}
}

func TestCmdlineOneshot(t *testing.T) {
	if !ParseCmdline("boot=live restow.oneshot=1").Oneshot {
		t.Error("restow.oneshot=1 not read")
	}
	for _, c := range []string{"boot=live", "restow.oneshot=0", "restow.oneshot=yes", "restow.oneshot"} {
		if ParseCmdline(c).Oneshot {
			t.Errorf("%q read as oneshot", c)
		}
	}
}

func TestOneshotSecretsAreRedacted(t *testing.T) {
	d, err := LoadOneshotData(oneshotJSON(t, func(m map[string]any) {
		m["session"] = map[string]any{"id": "s1", "secret": strings.Repeat("7a", 32)}
		m["passphrase"] = "oneshot passphrase 4711"
	}), false)
	if err != nil {
		t.Fatal(err)
	}
	d.RegisterSecrets()
	line := redact.Redact("secret " + strings.Repeat("7a", 32) + " pass oneshot passphrase 4711")
	if strings.Contains(line, strings.Repeat("7a", 32)) || strings.Contains(line, "oneshot passphrase 4711") {
		t.Fatalf("not redacted: %q", line)
	}
}
