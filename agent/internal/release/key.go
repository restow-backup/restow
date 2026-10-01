// Package release verifies what the agent installs: the SHA256SUMS file of an
// agent release and its signature. A release is signed by the maintainer with
// an Ed25519 key that never leaves the maintainer's machine; the public half is
// compiled into the agent (release-signing.pub at the root of the agent
// module), so neither the Restow instance that serves the files nor anyone who
// can change them on the way can make the agent run something else.
//
// The signature format is the OpenSSH signature format (SSHSIG, as written by
// `ssh-keygen -Y sign`, see PROTOCOL.sshsig in OpenSSH): the stock ssh-keygen of
// every supported macOS and of current Linux distributions creates and checks
// it, so neither the maintainer nor an operator needs extra tools. The
// signature covers the SHA256SUMS file of the release, which lists the SHA-256
// of every binary.
package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	agentmodule "github.com/restow-backup/restow/agent"
)

// Namespace is the SSHSIG namespace of agent release signatures. A signature
// made for another purpose with the same key does not verify.
const Namespace = "restow-agent-release"

const keyTypeEd25519 = "ssh-ed25519"

// ErrNoKey means the build carries the placeholder instead of a release
// signing key: nothing can be verified, so nothing is installed.
var ErrNoKey = errors.New("this agent build has no release signing key (agent/release-signing.pub is the placeholder), " +
	"so it cannot verify updates and installs none")

// PublicKey is an Ed25519 release signing key.
type PublicKey struct {
	key     ed25519.PublicKey
	blob    []byte
	Comment string
}

// ParsePublicKey reads the content of a public key file: one line in OpenSSH
// format (`ssh-ed25519 <base64> [comment]`). Empty lines and lines starting
// with # are ignored. A file without a key line (the placeholder) gives
// ErrNoKey.
func ParsePublicKey(text string) (*PublicKey, error) {
	var found []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		found = append(found, line)
	}
	switch len(found) {
	case 0:
		return nil, ErrNoKey
	case 1:
	default:
		return nil, errors.New("the release signing key file must hold exactly one key line")
	}
	fields := strings.Fields(found[0])
	if len(fields) < 2 || fields[0] != keyTypeEd25519 {
		return nil, fmt.Errorf("the release signing key must be an %s key in OpenSSH format", keyTypeEd25519)
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil {
		return nil, fmt.Errorf("the release signing key is not valid base64: %v", err)
	}
	key, err := parseKeyBlob(blob)
	if err != nil {
		return nil, err
	}
	return &PublicKey{key: key, blob: blob, Comment: strings.Join(fields[2:], " ")}, nil
}

// NewPublicKey wraps a raw Ed25519 public key (tests and test tools).
func NewPublicKey(pub ed25519.PublicKey, comment string) *PublicKey {
	var buf bytes.Buffer
	putString(&buf, []byte(keyTypeEd25519))
	putString(&buf, pub)
	return &PublicKey{key: append(ed25519.PublicKey(nil), pub...), blob: buf.Bytes(), Comment: comment}
}

// parseKeyBlob decodes the SSH wire form of an Ed25519 public key.
func parseKeyBlob(blob []byte) (ed25519.PublicKey, error) {
	r := reader{b: blob}
	typ := r.str()
	key := r.str()
	if r.err != nil || len(r.b) != 0 || string(typ) != keyTypeEd25519 || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("not an Ed25519 public key in SSH wire format")
	}
	return ed25519.PublicKey(key), nil
}

// Fingerprint is the key's SHA-256 fingerprint as `ssh-keygen -l` prints it.
func (k *PublicKey) Fingerprint() string {
	sum := sha256.Sum256(k.blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// AuthorizedKey returns the key as one OpenSSH line (without comment).
func (k *PublicKey) AuthorizedKey() string {
	return keyTypeEd25519 + " " + base64.StdEncoding.EncodeToString(k.blob)
}

// Equal reports whether both are the same key.
func (k *PublicKey) Equal(o *PublicKey) bool {
	return k != nil && o != nil && bytes.Equal(k.blob, o.blob)
}

// TrustedKey returns the key compiled into this binary, or ErrNoKey for a
// build that still carries the placeholder.
func TrustedKey() (*PublicKey, error) {
	return ParsePublicKey(agentmodule.ReleaseSigningKey)
}

// reader decodes SSH wire format strings (uint32 length + bytes).
type reader struct {
	b   []byte
	err error
}

func (r *reader) str() []byte {
	if r.err != nil {
		return nil
	}
	if len(r.b) < 4 {
		r.err = errors.New("truncated")
		return nil
	}
	n := binary.BigEndian.Uint32(r.b)
	if uint64(n) > uint64(len(r.b)-4) {
		r.err = errors.New("truncated")
		return nil
	}
	s := r.b[4 : 4+n]
	r.b = r.b[4+n:]
	return s
}

func (r *reader) u32() uint32 {
	if r.err != nil {
		return 0
	}
	if len(r.b) < 4 {
		r.err = errors.New("truncated")
		return 0
	}
	v := binary.BigEndian.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func putString(buf *bytes.Buffer, s []byte) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(s)))
	buf.Write(n[:])
	buf.Write(s)
}
