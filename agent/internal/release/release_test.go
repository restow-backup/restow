package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"

	agentmodule "github.com/restow-backup/restow/agent"
)

func read(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func fixtureKey(t *testing.T) *PublicKey {
	t.Helper()
	k, err := ParsePublicKey(string(read(t, "test-key.pub")))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// The fixtures were made with the stock OpenSSH ssh-keygen (-Y sign), so these
// tests prove the agent reads what the maintainer's tool writes.
func TestVerifiesSignaturesMadeBySSHKeygen(t *testing.T) {
	k := fixtureKey(t)
	if err := k.Verify(read(t, "SHA256SUMS"), read(t, "SHA256SUMS.sig")); err != nil {
		t.Fatalf("sha512 signature: %v", err)
	}
	if err := k.Verify(read(t, "sha256.txt"), read(t, "sha256.txt.sig")); err != nil {
		t.Fatalf("sha256 signature: %v", err)
	}
	if k.Comment != "restow-signing-test-fixture" || !strings.HasPrefix(k.Fingerprint(), "SHA256:") {
		t.Fatalf("key: %q %s", k.Comment, k.Fingerprint())
	}
}

func TestRejectsChangedFileWrongNamespaceAndOtherKey(t *testing.T) {
	k := fixtureKey(t)
	sums := read(t, "SHA256SUMS")
	sig := read(t, "SHA256SUMS.sig")

	changed := append([]byte(nil), sums...)
	changed[0] ^= 1
	if err := k.Verify(changed, sig); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("changed file: %v", err)
	}
	if err := k.Verify(read(t, "other-ns.txt"), read(t, "other-ns.txt.sig")); err == nil || !strings.Contains(err.Error(), "not for agent releases") {
		t.Fatalf("signature for another namespace: %v", err)
	}
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	other, err := ParsePublicKey(authorizedKey(pub))
	if err != nil {
		t.Fatal(err)
	}
	if err := other.Verify(sums, sig); err == nil || !strings.Contains(err.Error(), "another key") {
		t.Fatalf("another key: %v", err)
	}
	for _, bad := range [][]byte{nil, []byte("garbage"), []byte(armorBegin + "\n!!!\n" + armorEnd), []byte(armorBegin + "\nAAAA\n" + armorEnd)} {
		if err := k.Verify(sums, bad); err == nil {
			t.Fatalf("malformed signature %q accepted", bad)
		}
	}
}

func TestSignatureMadeInGoRoundTrips(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k, err := ParsePublicKey(authorizedKey(pub) + " comment")
	if err != nil {
		t.Fatal(err)
	}
	if !k.Equal(NewPublicKey(pub, "")) || k.AuthorizedKey() != authorizedKey(pub) {
		t.Fatal("NewPublicKey and ParsePublicKey disagree")
	}
	msg := []byte("abc  linux-amd64/restow-agent\n")
	if err := k.Verify(msg, Sign(priv, msg)); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	sum := sha512.Sum512(msg)
	sig := ed25519.Sign(priv, SignedData(sum[:], "sha512", nil))
	if err := k.Verify(msg, Armor(pub, "sha512", sig)); err != nil {
		t.Fatal(err)
	}
	sig[3] ^= 0x40
	if err := k.Verify(msg, Armor(pub, "sha512", sig)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("flipped bit: %v", err)
	}
}

func TestPlaceholderAndMalformedKeys(t *testing.T) {
	if _, err := ParsePublicKey("# PLACEHOLDER\n\n# nothing here\n"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("placeholder: %v", err)
	}
	for _, bad := range []string{
		"ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== x",
		"ssh-ed25519 not-base64!",
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==",
		string(read(t, "test-key.pub")) + string(read(t, "test-key.pub")),
	} {
		if _, err := ParsePublicKey(bad); err == nil || errors.Is(err, ErrNoKey) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
}

// The key compiled into this build is either the placeholder or a usable key;
// anything else would make every update fail in the field.
func TestCompiledKeyIsPlaceholderOrValid(t *testing.T) {
	k, err := TrustedKey()
	switch {
	case errors.Is(err, ErrNoKey):
		if !strings.Contains(agentmodule.ReleaseSigningKey, "PLACEHOLDER") {
			t.Fatal("release-signing.pub has no key line and is not marked as the placeholder")
		}
	case err != nil:
		t.Fatalf("release-signing.pub is unusable: %v", err)
	default:
		t.Logf("release signing key %s", k.Fingerprint())
	}
}

func TestParseSums(t *testing.T) {
	h := strings.Repeat("ab", 32)
	s, err := ParseSums([]byte(h + "  linux-amd64/restow-agent\n" + strings.ToUpper(h) + " *linux-amd64/restic\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Lookup("linux-amd64", "restic"); got != h {
		t.Fatalf("restic: %q", got)
	}
	if _, err := s.Lookup("darwin-arm64", "restow-agent"); err == nil {
		t.Fatal("missing target must be an error")
	}
	for _, bad := range []string{"", "xyz  a/b\n", h + "\n", h + "  a/b\n" + h + "  a/b\n", h + "  a b\n"} {
		if _, err := ParseSums([]byte(bad)); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestVerifiedSumsUsesNothingUnsigned(t *testing.T) {
	k := fixtureKey(t)
	if _, err := VerifiedSums(k, append(read(t, "SHA256SUMS"), '\n'), read(t, "SHA256SUMS.sig")); err == nil {
		t.Fatal("an appended line must break the signature")
	}
	s, err := VerifiedSums(k, read(t, "SHA256SUMS"), read(t, "SHA256SUMS.sig"))
	if err != nil || len(s) != 2 {
		t.Fatalf("%v %v", s, err)
	}
}

func authorizedKey(pub ed25519.PublicKey) string {
	var blob []byte
	blob = append(blob, 0, 0, 0, 11)
	blob = append(blob, keyTypeEd25519...)
	blob = append(blob, 0, 0, 0, 32)
	blob = append(blob, pub...)
	return keyTypeEd25519 + " " + base64.StdEncoding.EncodeToString(blob)
}
