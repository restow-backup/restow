package recovery

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// vectors mirrors testdata/recovery-code-vectors.json, which the server's
// tests (packages/core/src/endpoints/baremetal/recovery-code.test.ts) read
// as well. A null expectation means the input must be refused.
type vectors struct {
	Format    string `json:"format"`
	Alphabet  string `json:"alphabet"`
	Normalize []struct {
		Input      string  `json:"input"`
		Normalized *string `json:"normalized"`
		Display    *string `json:"display"`
	} `json:"normalize"`
	CanonicalOrigin []struct {
		Input     string  `json:"input"`
		AllowHTTP bool    `json:"allowHttp"`
		Origin    *string `json:"origin"`
	} `json:"canonicalOrigin"`
	Proof []struct {
		Origin    string `json:"origin"`
		Code      string `json:"code"`
		CodeProof string `json:"codeProof"`
		CodeHash  string `json:"codeHash"`
	} `json:"proof"`
	MatchCode []struct {
		SessionSecret       string `json:"sessionSecret"`
		SessionSecretSHA256 string `json:"sessionSecretSha256"`
		MatchCode           string `json:"matchCode"`
	} `json:"matchCode"`
	SPKICheck []struct {
		SPKISHA256 string `json:"spkiSha256"`
		SPKICheck  string `json:"spkiCheck"`
	} `json:"spkiCheck"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/recovery-code-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Format != "restow-recovery-code-vectors-v1" {
		t.Fatalf("format %q", v.Format)
	}
	if len(v.Normalize) == 0 || len(v.CanonicalOrigin) == 0 || len(v.Proof) == 0 || len(v.MatchCode) == 0 || len(v.SPKICheck) == 0 {
		t.Fatal("a vector list is empty")
	}
	return v
}

func TestVectorsAlphabet(t *testing.T) {
	v := loadVectors(t)
	if v.Alphabet != Alphabet || len(Alphabet) != 30 {
		t.Fatalf("alphabet %q, vectors %q", Alphabet, v.Alphabet)
	}
	for _, c := range "ILOUYZ" {
		if strings.ContainsRune(Alphabet, c) {
			t.Errorf("alphabet contains %c", c)
		}
	}
}

func TestVectorsNormalize(t *testing.T) {
	for _, c := range loadVectors(t).Normalize {
		got, err := NormalizeCode(c.Input)
		if c.Normalized == nil {
			if err == nil {
				t.Errorf("NormalizeCode(%q) = %q, want refusal", c.Input, got)
			}
			continue
		}
		if err != nil || got != *c.Normalized {
			t.Errorf("NormalizeCode(%q) = %q, %v; want %q", c.Input, got, err, *c.Normalized)
			continue
		}
		if c.Display == nil || FormatCode(got) != *c.Display {
			t.Errorf("FormatCode(%q) = %q, want %v", got, FormatCode(got), c.Display)
		}
		// The displayed form normalizes to itself.
		if again, err := NormalizeCode(FormatCode(got)); err != nil || again != got {
			t.Errorf("round trip of %q: %q %v", got, again, err)
		}
	}
}

func TestNormalizeCodeMore(t *testing.T) {
	ok := map[string]string{
		"RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS\n":  "7K3QXM9P2DH4TNV8WRBCJ6FAS",
		" rc-7k3qx\tm9p2d h4tnv-8wrbc-j6fas ": "7K3QXM9P2DH4TNV8WRBCJ6FAS",
		"RC--7K3QX--M9P2D-H4TNV-8WRBC-J6FAS":  "7K3QXM9P2DH4TNV8WRBCJ6FAS",
	}
	for in, want := range ok {
		if got, err := NormalizeCode(in); err != nil || got != want {
			t.Errorf("NormalizeCode(%q) = %q %v", in, got, err)
		}
	}
	for _, in := range []string{"", "RC-", "RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS-0", "RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAß",
		"XX7K3QXM9P2DH4TNV8WRBCJ6FAS", "RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAZ", "RC-7K3QX_M9P2D-H4TNV-8WRBC-J6FAS"} {
		if got, err := NormalizeCode(in); err == nil {
			t.Errorf("NormalizeCode(%q) = %q, want refusal", in, got)
		}
	}
	if FormatCode("short") != "short" {
		t.Error("FormatCode must leave other input alone")
	}
}

func TestVectorsCanonicalOrigin(t *testing.T) {
	for _, c := range loadVectors(t).CanonicalOrigin {
		got, err := CanonicalOrigin(c.Input, c.AllowHTTP)
		if c.Origin == nil {
			if err == nil {
				t.Errorf("CanonicalOrigin(%q, %v) = %q, want refusal", c.Input, c.AllowHTTP, got)
			}
			continue
		}
		if err != nil || got != *c.Origin {
			t.Errorf("CanonicalOrigin(%q, %v) = %q, %v; want %q", c.Input, c.AllowHTTP, got, err, *c.Origin)
		}
		// A canonical origin is a fixed point.
		if again, err := CanonicalOrigin(got, c.AllowHTTP); err != nil || again != got {
			t.Errorf("CanonicalOrigin(%q) again = %q %v", got, again, err)
		}
	}
}

func TestCanonicalOriginMore(t *testing.T) {
	ok := map[string]string{
		"  HTTPS://restow.firma.de/  ":        "https://restow.firma.de",
		"https://[::ffff:192.0.2.1]":          "https://[::ffff:c000:201]",
		"https://[2001:db8:0:1:0:0:0:1]":      "https://[2001:db8:0:1::1]",
		"https://[2001:0:0:1:0:0:0:1]":        "https://[2001:0:0:1::1]",
		"https://[::]:8443":                   "https://[::]:8443",
		"https://restow.firma.de:08443":       "https://restow.firma.de:8443",
		"https://münchen.de":                  "https://xn--mnchen-3ya.de",
		"https://bücher.example。com":          "https://xn--bcher-kva.example.com",
		"https://restow.firma.de:":            "https://restow.firma.de",
		"https://my_host.internal.example.de": "https://my_host.internal.example.de",
	}
	for in, want := range ok {
		if got, err := CanonicalOrigin(in, false); err != nil || got != want {
			t.Errorf("CanonicalOrigin(%q) = %q %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"", "https://", "https://restow.firma.de#x", "https://restow.firma.de?", "https://restow.firma.de/a/",
		"https://re stow.firma.de", "https://restow..firma.de", "https://[fe80::1%25eth0]", "https://0x7f.1",
		"https://1.2.3", "https://999.1.1.1", "https://restow.firma.de:65536", "https://host\\x", "mailto:x@y",
		"https://[2001:db8::1", "https://a!b.de", "https://restow.firma.de:http",
	} {
		if got, err := CanonicalOrigin(in, false); err == nil {
			t.Errorf("CanonicalOrigin(%q) = %q, want refusal", in, got)
		}
	}
	if _, err := CanonicalOrigin("http://lab.local", false); err == nil {
		t.Error("http without allowHTTP must be refused")
	}
	if got, err := CanonicalOrigin("lab.local:8080", true); err != nil || got != "https://lab.local:8080" {
		t.Errorf("a missing scheme means https even in the lab: %q %v", got, err)
	}
}

func TestVectorsProof(t *testing.T) {
	hexRE := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for _, c := range loadVectors(t).Proof {
		proof := CodeProof(c.Origin, c.Code)
		if proof != c.CodeProof || !hexRE.MatchString(proof) {
			t.Errorf("CodeProof(%q, %q) = %q, want %q", c.Origin, c.Code, proof, c.CodeProof)
		}
		if h := HashCodeProof(proof); h != c.CodeHash {
			t.Errorf("HashCodeProof(%q) = %q, want %q", proof, h, c.CodeHash)
		}
	}
}

func TestVectorsMatchCode(t *testing.T) {
	for _, c := range loadVectors(t).MatchCode {
		if got := SessionSecretSHA256(c.SessionSecret); got != c.SessionSecretSHA256 {
			t.Errorf("SessionSecretSHA256(%q) = %q, want %q", c.SessionSecret, got, c.SessionSecretSHA256)
		}
		if got := MatchCode(c.SessionSecretSHA256); got != c.MatchCode {
			t.Errorf("MatchCode(%q) = %q, want %q", c.SessionSecretSHA256, got, c.MatchCode)
		}
	}
	if got := FormatMatchCode("483914"); got != "483 914" {
		t.Errorf("FormatMatchCode = %q", got)
	}
	if got := FormatMatchCode("12"); got != "12" {
		t.Errorf("FormatMatchCode must leave other input alone: %q", got)
	}
}

func TestNewSessionSecret(t *testing.T) {
	secret, sha, err := NewSessionSecret()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(secret) || sha != SessionSecretSHA256(secret) || sha == secret {
		t.Fatalf("secret %q sha %q", secret, sha)
	}
	other, _, _ := NewSessionSecret()
	if other == secret {
		t.Fatal("two secrets are equal")
	}
	if m := MatchCode(sha); !regexp.MustCompile(`^[0-9]{6}$`).MatchString(m) {
		t.Fatalf("match code %q", m)
	}
}

func TestVectorsSPKICheck(t *testing.T) {
	for _, c := range loadVectors(t).SPKICheck {
		got, err := SPKICheck(c.SPKISHA256)
		if err != nil || got != c.SPKICheck {
			t.Errorf("SPKICheck(%q) = %q %v; want %q", c.SPKISHA256, got, err, c.SPKICheck)
		}
	}
	for _, bad := range []string{"", "abcd", strings.Repeat("g", 64), strings.Repeat("0", 62)} {
		if got, err := SPKICheck(bad); err == nil {
			t.Errorf("SPKICheck(%q) = %q, want refusal", bad, got)
		}
	}
}

func TestSPKIPrefixMatches(t *testing.T) {
	check := "T6DN-BAMI-JR6W-LGRP"
	for typed, want := range map[string]bool{
		"T6DN-BAMI":            true,
		"t6dnbami":             true,
		" t6dn bami ":          true,
		"T6DN-BAMI-JR6W-LGRP":  true,
		"T6DN-BAMI-J":          true,
		"T6DN-BAM":             false, // fewer than eight characters
		"T6DN-BAMX":            false,
		"T6DN-BAMI-JR6W-LGRX":  false,
		"T6DN-BAMI-JR6W-LGRPA": false,
		"":                     false,
	} {
		if got := SPKIPrefixMatches(typed, check); got != want {
			t.Errorf("SPKIPrefixMatches(%q) = %v, want %v", typed, got, want)
		}
	}
	if SPKIPrefixMatches("T6DN-BAMI", "") {
		t.Error("no check value must never match")
	}
}

// RFC 3492, section 7.1, plus German labels.
func TestPunycodeRFC3492Samples(t *testing.T) {
	cases := []struct {
		name  string
		input []rune
		want  string
	}{
		{"A Arabic (Egyptian)", []rune{0x0644, 0x064A, 0x0647, 0x0645, 0x0627, 0x0628, 0x062A, 0x0643, 0x0644, 0x0645, 0x0648, 0x0634, 0x0639, 0x0631, 0x0628, 0x064A, 0x061F}, "egbpdaj6bu4bxfgehfvwxn"},
		{"B Chinese (simplified)", []rune{0x4ED6, 0x4EEC, 0x4E3A, 0x4EC0, 0x4E48, 0x4E0D, 0x8BF4, 0x4E2D, 0x6587}, "ihqwcrb4cv8a8dqg056pqjye"},
		{"C Chinese (traditional)", []rune{0x4ED6, 0x5011, 0x7232, 0x4EC0, 0x9EBD, 0x4E0D, 0x8AAA, 0x4E2D, 0x6587}, "ihqwctvzc91f659drss3x8bo0yb"},
		{"D Czech", []rune{0x0050, 0x0072, 0x006F, 0x010D, 0x0070, 0x0072, 0x006F, 0x0073, 0x0074, 0x011B, 0x006E, 0x0065, 0x006D, 0x006C, 0x0075, 0x0076, 0x00ED, 0x010D, 0x0065, 0x0073, 0x006B, 0x0079}, "Proprostnemluvesky-uyb24dma41a"},
		{"I Russian", []rune{0x043F, 0x043E, 0x0447, 0x0435, 0x043C, 0x0443, 0x0436, 0x0435, 0x043E, 0x043D, 0x0438, 0x043D, 0x0435, 0x0433, 0x043E, 0x0432, 0x043E, 0x0440, 0x044F, 0x0442, 0x043F, 0x043E, 0x0440, 0x0443, 0x0441, 0x0441, 0x043A, 0x0438}, "b1abfaaepdrnnbgefbadotcwatmq2g4l"},
		{"J Spanish", []rune("PorquénopuedensimplementehablarenEspañol"), "PorqunopuedensimplementehablarenEspaol-fmd56a"},
		{"German büro", []rune("büro"), "bro-hoa"},
		{"German straße", []rune("straße"), "strae-oqa"},
		{"German bücher", []rune("bücher"), "bcher-kva"},
		{"German münchen", []rune("münchen"), "mnchen-3ya"},
	}
	for _, c := range cases {
		got, err := punycodeEncode(string(c.input))
		if err != nil || got != c.want {
			t.Errorf("%s: %q %v, want %q", c.name, got, err, c.want)
		}
	}
}
