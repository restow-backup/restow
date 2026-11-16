package main

import (
	"bytes"
	"crypto/ed25519"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/release"
)

func TestRFC8032VectorsAreValid(t *testing.T) {
	for i, v := range rfc8032 {
		if !ed25519.Verify(mustHex(v[0]), mustHex(v[1]), mustHex(v[2])) {
			t.Fatalf("RFC 8032 vector %d does not verify", i+1)
		}
	}
}

// The reference twin of the PowerShell check must agree with crypto/ed25519
// on every vector, including all mutation kinds.
func TestReferenceAgreesWithCryptoEd25519(t *testing.T) {
	n := 600
	if testing.Short() {
		n = 150
	}
	cases := Generate(n, 7)
	valid, invalid := 0, 0
	for i, c := range cases {
		got := refVerify(c.Pub, c.Msg, c.Sig)
		if got != c.Valid {
			t.Fatalf("vector %d: reference says %v, crypto/ed25519 says %v (pub %x sig %x)", i, got, c.Valid, c.Pub, c.Sig)
		}
		if c.Valid {
			valid++
		} else {
			invalid++
		}
	}
	if valid < n/10 || invalid < n/2 {
		t.Fatalf("unbalanced corpus: %d valid, %d invalid", valid, invalid)
	}
}

func TestEdgeCases(t *testing.T) {
	pub := mustHex(rfc8032[1][0])
	msg := mustHex(rfc8032[1][1])
	sig := mustHex(rfc8032[1][2])
	for name, s := range map[string][]byte{
		"S+L":           withS(sig, func(v *big.Int) { v.Add(v, edL) }),
		"non-canonical": nonCanonicalR(sig),
		"high bit":      append(append([]byte(nil), sig[:63]...), sig[63]|0x80),
		"short":         sig[:63],
	} {
		if ed25519.Verify(pub, msg, s) || refVerify(pub, msg, s) {
			t.Errorf("%s verifies", name)
		}
	}
}

func TestOutputFormat(t *testing.T) {
	var buf bytes.Buffer
	if err := write(&buf, Generate(20, 3)); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 23 {
		t.Fatalf("%d lines", len(lines))
	}
	for _, l := range lines {
		if f := strings.Fields(l); len(f) != 4 || (f[3] != "0" && f[3] != "1") {
			t.Fatalf("bad line %q", l)
		}
	}
	if !strings.HasPrefix(lines[0], rfc8032[0][0]+" - ") {
		t.Fatalf("empty message must be written as -: %q", lines[0])
	}
}

// The agent's own check (internal/release, the one every update uses) must
// judge the fixtures as the installer is expected to: good.sig valid, every
// bad-*.sig invalid. The only difference: the agent accepts SHA-256, the
// installer only SHA-512 (what ssh-keygen and sign-agent.sh produce).
func TestSSHSigFixturesAgainstTheAgent(t *testing.T) {
	keyLine, files := SSHSigFixtures()
	key, err := release.ParsePublicKey(keyLine)
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte(files["message.txt"])
	bad := 0
	for name, content := range files {
		if !strings.HasSuffix(name, ".sig") {
			continue
		}
		err := key.Verify(msg, []byte(content))
		switch {
		case name == "good.sig":
			if err != nil {
				t.Fatalf("good.sig: %v", err)
			}
		case name == "bad-sha256-installer-only.sig":
			if err != nil {
				t.Fatalf("the agent accepts SHA-256 signatures: %v", err)
			}
		default:
			bad++
			if err == nil {
				t.Errorf("%s verifies with the agent's check", name)
			}
		}
	}
	if bad < 15 {
		t.Fatalf("only %d negative fixtures", bad)
	}
}

func TestCommittedFixturesAreCurrent(t *testing.T) {
	_, files := SSHSigFixtures()
	for name, content := range files {
		have, err := os.ReadFile(filepath.Join("..", "..", "install", "testdata", "sshsig", name))
		if err != nil || string(have) != content {
			t.Fatalf("install/testdata/sshsig/%s is missing or outdated; run: go run ./scripts/sigdiff -sshsig install/testdata/sshsig", name)
		}
	}
}
