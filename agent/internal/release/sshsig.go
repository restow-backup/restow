package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const (
	sigMagic   = "SSHSIG"
	sigVersion = 1
	armorBegin = "-----BEGIN SSH SIGNATURE-----"
	armorEnd   = "-----END SSH SIGNATURE-----"
	// maxSignatureBytes bounds what is read as a signature file.
	maxSignatureBytes = 16 << 10
)

// ErrBadSignature means the signature does not match the file and the key.
var ErrBadSignature = errors.New("the release signature does not match (the file was changed or not signed with the release key)")

// Verify checks an armored SSHSIG signature (`ssh-keygen -Y sign -n
// restow-agent-release`) over message against the key. The signature must
// name this key, the release namespace and SHA-256 or SHA-512.
func (k *PublicKey) Verify(message, armored []byte) error {
	if k == nil {
		return ErrNoKey
	}
	blob, err := dearmor(armored)
	if err != nil {
		return err
	}
	r := reader{b: blob}
	if len(r.b) < len(sigMagic) || string(r.b[:len(sigMagic)]) != sigMagic {
		return errors.New("the release signature is not an SSH signature")
	}
	r.b = r.b[len(sigMagic):]
	version := r.u32()
	pub := r.str()
	ns := r.str()
	reserved := r.str()
	hashAlg := r.str()
	sigBlob := r.str()
	if r.err != nil || len(r.b) != 0 {
		return errors.New("the release signature is malformed")
	}
	if version != sigVersion {
		return fmt.Errorf("unsupported SSH signature version %d", version)
	}
	if !bytes.Equal(pub, k.blob) {
		return fmt.Errorf("%w: it was made with another key than the release key %s", ErrBadSignature, k.Fingerprint())
	}
	if string(ns) != Namespace {
		return fmt.Errorf("%w: it was made for %q, not for agent releases", ErrBadSignature, string(ns))
	}
	var digest []byte
	switch string(hashAlg) {
	case "sha512":
		sum := sha512.Sum512(message)
		digest = sum[:]
	case "sha256":
		sum := sha256.Sum256(message)
		digest = sum[:]
	default:
		return fmt.Errorf("unsupported signature hash %q", string(hashAlg))
	}
	sr := reader{b: sigBlob}
	sigType := sr.str()
	raw := sr.str()
	if sr.err != nil || len(sr.b) != 0 || string(sigType) != keyTypeEd25519 || len(raw) != ed25519.SignatureSize {
		return errors.New("the release signature is not an Ed25519 signature")
	}
	signed := SignedData(digest, string(hashAlg), reserved)
	if !ed25519.Verify(k.key, signed, raw) {
		return ErrBadSignature
	}
	return nil
}

// SignedData is the byte string an SSHSIG signature covers (PROTOCOL.sshsig).
func SignedData(digest []byte, hashAlg string, reserved []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString(sigMagic)
	putString(&buf, []byte(Namespace))
	putString(&buf, reserved)
	putString(&buf, []byte(hashAlg))
	putString(&buf, digest)
	return buf.Bytes()
}

// Armor encodes an SSHSIG blob the way ssh-keygen writes it (tests and tools).
func Armor(pub ed25519.PublicKey, hashAlg string, sig []byte) []byte {
	var keyBlob, sigBlob, blob bytes.Buffer
	putString(&keyBlob, []byte(keyTypeEd25519))
	putString(&keyBlob, pub)
	putString(&sigBlob, []byte(keyTypeEd25519))
	putString(&sigBlob, sig)
	blob.WriteString(sigMagic)
	blob.Write([]byte{0, 0, 0, sigVersion})
	putString(&blob, keyBlob.Bytes())
	putString(&blob, []byte(Namespace))
	putString(&blob, nil)
	putString(&blob, []byte(hashAlg))
	putString(&blob, sigBlob.Bytes())
	enc := base64.StdEncoding.EncodeToString(blob.Bytes())
	var out strings.Builder
	out.WriteString(armorBegin + "\n")
	for len(enc) > 70 {
		out.WriteString(enc[:70] + "\n")
		enc = enc[70:]
	}
	out.WriteString(enc + "\n" + armorEnd + "\n")
	return []byte(out.String())
}

// Sign makes an armored SSHSIG signature (SHA-512) over message, as
// `ssh-keygen -Y sign -n restow-agent-release` does. The agent never signs
// anything; this exists for tests and test tools.
func Sign(priv ed25519.PrivateKey, message []byte) []byte {
	sum := sha512.Sum512(message)
	sig := ed25519.Sign(priv, SignedData(sum[:], "sha512", nil))
	return Armor(priv.Public().(ed25519.PublicKey), "sha512", sig)
}

func dearmor(armored []byte) ([]byte, error) {
	if len(armored) > maxSignatureBytes {
		return nil, errors.New("the release signature file is too large")
	}
	text := strings.TrimSpace(strings.ReplaceAll(string(armored), "\r", ""))
	if !strings.HasPrefix(text, armorBegin) || !strings.HasSuffix(text, armorEnd) {
		return nil, errors.New("the release signature is not an armored SSH signature (-----BEGIN SSH SIGNATURE-----)")
	}
	body := strings.TrimSuffix(strings.TrimPrefix(text, armorBegin), armorEnd)
	body = strings.Join(strings.Fields(body), "")
	blob, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return nil, fmt.Errorf("the release signature is not valid base64: %v", err)
	}
	return blob, nil
}
