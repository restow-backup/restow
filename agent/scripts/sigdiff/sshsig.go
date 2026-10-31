package main

// SSHSIG fixtures for the signature check of the Windows installer: one good
// signature and malformed or wrong ones over the same message, each in its
// own file (agent/install/testdata/sshsig). The Windows job checks that the
// installer accepts good.sig and refuses every bad-*.sig; the Go test checks
// that the agent's own check (internal/release) agrees, except for the one
// case where the installer is stricter (SHA-256 instead of SHA-512).

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"math/big"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/release"
)

// fixtureMessage stands in for a release's SHA256SUMS.
const fixtureMessage = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  windows-amd64/restow-agent.exe\n" +
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210  windows-amd64/restic.exe\n"

func sshString(b []byte) []byte {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(b)))
	return append(n[:], b...)
}

type sigParts struct {
	version   uint32
	pub       []byte // key blob
	namespace string
	hashAlg   string
	sigType   string
	raw       []byte
	trailing  []byte
}

func (p sigParts) blob() []byte {
	var b bytes.Buffer
	b.WriteString("SSHSIG")
	var v [4]byte
	binary.BigEndian.PutUint32(v[:], p.version)
	b.Write(v[:])
	b.Write(sshString(p.pub))
	b.Write(sshString([]byte(p.namespace)))
	b.Write(sshString(nil))
	b.Write(sshString([]byte(p.hashAlg)))
	b.Write(sshString(append(sshString([]byte(p.sigType)), sshString(p.raw)...)))
	b.Write(p.trailing)
	return b.Bytes()
}

func armor(blob []byte) string {
	enc := base64.StdEncoding.EncodeToString(blob)
	var out strings.Builder
	out.WriteString("-----BEGIN SSH SIGNATURE-----\n")
	for len(enc) > 70 {
		out.WriteString(enc[:70] + "\n")
		enc = enc[70:]
	}
	out.WriteString(enc + "\n-----END SSH SIGNATURE-----\n")
	return out.String()
}

func keyBlob(pub ed25519.PublicKey) []byte {
	return append(sshString([]byte("ssh-ed25519")), sshString(pub)...)
}

// signParts signs msg the way ssh-keygen -Y sign does, with namespace and hash.
func signParts(priv ed25519.PrivateKey, msg []byte, ns, hashAlg string) sigParts {
	var digest []byte
	if hashAlg == "sha256" {
		s := sha256.Sum256(msg)
		digest = s[:]
	} else {
		s := sha512.Sum512(msg)
		digest = s[:]
	}
	var signed bytes.Buffer
	signed.WriteString("SSHSIG")
	signed.Write(sshString([]byte(ns)))
	signed.Write(sshString(nil))
	signed.Write(sshString([]byte(hashAlg)))
	signed.Write(sshString(digest))
	raw := ed25519.Sign(priv, signed.Bytes())
	return sigParts{version: 1, pub: keyBlob(priv.Public().(ed25519.PublicKey)), namespace: ns, hashAlg: hashAlg, sigType: "ssh-ed25519", raw: raw}
}

// SSHSigFixtures returns the key line and the fixture files by name.
func SSHSigFixtures() (keyLine string, files map[string]string) {
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, 32))
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x24}, 32))
	pub := priv.Public().(ed25519.PublicKey)
	keyLine = "ssh-ed25519 " + base64.StdEncoding.EncodeToString(keyBlob(pub)) + " restow-installer-test-fixture"
	msg := []byte(fixtureMessage)
	good := signParts(priv, msg, release.Namespace, "sha512")
	files = map[string]string{"message.txt": fixtureMessage, "key.pub": keyLine + "\n", "good.sig": armor(good.blob())}
	mod := func(name string, f func(p *sigParts)) {
		p := good
		p.raw = append([]byte(nil), good.raw...)
		f(&p)
		files[name] = armor(p.blob())
	}
	files["bad-other-message.sig"] = armor(signParts(priv, append([]byte("x"), msg...), release.Namespace, "sha512").blob())
	files["bad-namespace.sig"] = armor(signParts(priv, msg, "file", "sha512").blob())
	files["bad-sha256-installer-only.sig"] = armor(signParts(priv, msg, release.Namespace, "sha256").blob())
	files["bad-other-key.sig"] = armor(signParts(other, msg, release.Namespace, "sha512").blob())
	mod("bad-version.sig", func(p *sigParts) { p.version = 2 })
	mod("bad-sigtype.sig", func(p *sigParts) { p.sigType = "ssh-rsa" })
	mod("bad-siglen-63.sig", func(p *sigParts) { p.raw = p.raw[:63] })
	mod("bad-siglen-65.sig", func(p *sigParts) { p.raw = append(p.raw, 0) })
	mod("bad-trailing.sig", func(p *sigParts) { p.trailing = []byte{0} })
	mod("bad-flipped-r.sig", func(p *sigParts) { p.raw[3] ^= 0x10 })
	mod("bad-flipped-s.sig", func(p *sigParts) { p.raw[40] ^= 0x01 })
	mod("bad-s-plus-l.sig", func(p *sigParts) { p.raw = withS(p.raw, func(s *big.Int) { s.Add(s, edL) }) })
	mod("bad-noncanonical-r.sig", func(p *sigParts) { p.raw = nonCanonicalR(p.raw) })
	mod("bad-random.sig", func(p *sigParts) {
		for i := range p.raw {
			p.raw[i] = byte(i*37 + 11)
		}
	})
	mod("bad-pubkey-in-blob.sig", func(p *sigParts) { p.pub = keyBlob(other.Public().(ed25519.PublicKey)) })
	g := files["good.sig"]
	files["bad-truncated.sig"] = g[:len(g)-60] + "\n-----END SSH SIGNATURE-----\n"
	files["bad-armor.sig"] = strings.Replace(g, "BEGIN SSH SIGNATURE", "BEGIN PGP SIGNATURE", 1)
	files["bad-base64.sig"] = strings.Replace(g, "U1NIU0lH", "U1NIU0l!", 1)
	files["bad-empty.sig"] = ""
	return keyLine, files
}

// writeFixtures writes the fixture files into dir.
func writeFixtures(dir string) error {
	_, files := SSHSigFixtures()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// signWithFixtureKey signs a file like sign-agent.sh does, with the fixture
// key (never a release key), for the full installer run in the Windows job.
func signWithFixtureKey(path string) error {
	msg, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	keyLine, _ := SSHSigFixtures()
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, 32))
	sig := armor(signParts(priv, msg, release.Namespace, "sha512").blob())
	if err := os.WriteFile(path+".sig", []byte(sig), 0o644); err != nil {
		return err
	}
	_, err = os.Stdout.WriteString(keyLine + "\n")
	return err
}
