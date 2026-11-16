// Package recovery holds the agent side of a bare-metal recovery session
// (docs/BAREMETAL.md, 9 and 10): the recovery code and its binding to the
// instance origin, and the client of the recovery API
// (/agent/v1/recovery/sessions). The functions here must give the same
// results as packages/core/src/endpoints/baremetal/recovery-code.ts; both
// are tested against testdata/recovery-code-vectors.json.
package recovery

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Alphabet of a recovery code: digits and the letters A to X without I, L,
// O and U (30 symbols). Y and Z are left out because a German keyboard swaps
// them.
const Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWX"

// CodeLength is the number of symbols of a normalized code (122.7 bits).
const CodeLength = 25

const (
	codePrefix  = "RC"
	proofPrefix = "restow-recovery-code:"
	matchPrefix = "restow-recovery-match:"
	// SessionSecretBytes is the size of the session secret recover makes.
	SessionSecretBytes = 32
	// SPKICheckBytes is how much of the SPKI SHA-256 the check value shows (80 bits).
	// The operator types all of it: a prefix would be short enough to grind a
	// key for offline (40 bits for eight characters).
	SPKICheckBytes = 10
)

var (
	// ErrInvalidCode is returned for input that is not a recovery code.
	ErrInvalidCode = errors.New("not a recovery code: it has 25 characters from 0-9 and A-X (without I, L, O, U), like RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS")
	// ErrInvalidOrigin is returned for an instance address that is not a plain origin.
	ErrInvalidOrigin = errors.New("not an instance address: enter the host name of the Restow instance (for example restow.example.com), without a path")
)

// NormalizeCode turns operator input into the 25 symbols of a code: case,
// whitespace and dashes do not matter, O counts as 0, I and L count as 1, and
// a leading RC is dropped.
func NormalizeCode(input string) (string, error) {
	var b strings.Builder
	for _, r := range input {
		switch {
		case unicode.IsSpace(r) || r == '-':
			continue
		case r > unicode.MaxASCII:
			return "", ErrInvalidCode
		}
		r = unicode.ToUpper(r)
		switch r {
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		}
		b.WriteRune(r)
	}
	s := b.String()
	if len(s) == CodeLength+len(codePrefix) && strings.HasPrefix(s, codePrefix) {
		s = s[len(codePrefix):]
	}
	if len(s) != CodeLength {
		return "", ErrInvalidCode
	}
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(Alphabet, s[i]) < 0 {
			return "", ErrInvalidCode
		}
	}
	return s, nil
}

// FormatCode shows a normalized code as RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.
// Input that is not normalized is returned unchanged.
func FormatCode(norm string) string {
	if len(norm) != CodeLength {
		return norm
	}
	parts := []string{codePrefix}
	for i := 0; i < CodeLength; i += 5 {
		parts = append(parts, norm[i:i+5])
	}
	return strings.Join(parts, "-")
}

var schemeRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://`)

// CanonicalOrigin is the origin the code proof is bound to: https (http only
// with allowHTTP), host in lower case and as Punycode, no trailing dot, no
// default port, IPv6 in brackets in its shortest form. Input without a
// scheme gets https://. A path other than "/", credentials, a query or a
// fragment are refused.
//
// Unlike the WHATWG URL parser of the server, the host is not mapped with
// UTS 46 (no NFC, no width folding): an address typed in a form that needs
// mapping gives another origin, and the instance refuses the code like any
// wrong address. The code dialog shows the ASCII form to type.
func CanonicalOrigin(raw string, allowHTTP bool) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.ContainsAny(s, "?#\\") {
		return "", ErrInvalidOrigin
	}
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", ErrInvalidOrigin
		}
	}
	if !schemeRE.MatchString(s) {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", ErrInvalidOrigin
	}
	if u.Path != "" && u.Path != "/" {
		return "", ErrInvalidOrigin
	}
	scheme := strings.ToLower(u.Scheme)
	defaultPort := ""
	switch {
	case scheme == "https":
		defaultPort = "443"
	case scheme == "http" && allowHTTP:
		defaultPort = "80"
	default:
		return "", ErrInvalidOrigin
	}
	host, err := canonicalHost(u.Host)
	if err != nil {
		return "", err
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 0 || n > 65535 {
			return "", ErrInvalidOrigin
		}
		port = strconv.Itoa(n)
		if port == defaultPort {
			port = ""
		}
	}
	if port != "" {
		return scheme + "://" + host + ":" + port, nil
	}
	return scheme + "://" + host, nil
}

// canonicalHost handles the host part of url.URL.Host (with an optional port).
func canonicalHost(hostport string) (string, error) {
	host := hostport
	if strings.HasPrefix(host, "[") {
		end := strings.IndexByte(host, ']')
		if end < 0 {
			return "", ErrInvalidOrigin
		}
		addr, err := netip.ParseAddr(host[1:end])
		if err != nil || !addr.Is6() || addr.Zone() != "" {
			return "", ErrInvalidOrigin
		}
		return "[" + formatIPv6(addr.As16()) + "]", nil
	}
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return "", ErrInvalidOrigin
	}
	// Full-width and ideographic full stops separate labels like ".".
	host = strings.NewReplacer("。", ".", "．", ".", "｡", ".").Replace(host)
	labels := strings.Split(host, ".")
	last := labels[len(labels)-1]
	if looksNumeric(last) {
		// The WHATWG parser reads such a host as an IPv4 address (also in
		// hexadecimal or octal forms); only the plain dotted form is accepted.
		addr, err := netip.ParseAddr(host)
		if err != nil || !addr.Is4() {
			return "", ErrInvalidOrigin
		}
		return addr.String(), nil
	}
	for i, label := range labels {
		ascii, err := labelToASCII(strings.ToLower(label))
		if err != nil {
			return "", err
		}
		labels[i] = ascii
	}
	return strings.Join(labels, "."), nil
}

// looksNumeric reports a label the WHATWG host parser treats as a number.
func looksNumeric(label string) bool {
	if label == "" {
		return false
	}
	l := strings.ToLower(label)
	if strings.HasPrefix(l, "0x") {
		l = l[2:]
		for i := 0; i < len(l); i++ {
			if !strings.ContainsRune("0123456789abcdef", rune(l[i])) {
				return false
			}
		}
		return true
	}
	for i := 0; i < len(l); i++ {
		if l[i] < '0' || l[i] > '9' {
			return false
		}
	}
	return true
}

// labelToASCII checks one lower-case label and encodes it as Punycode when
// it is not ASCII.
func labelToASCII(label string) (string, error) {
	if label == "" || len(label) > 253 {
		return "", ErrInvalidOrigin
	}
	ascii := true
	for _, r := range label {
		switch {
		case r > unicode.MaxASCII:
			ascii = false
			if !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.IsMark(r) {
				return "", ErrInvalidOrigin
			}
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return "", ErrInvalidOrigin
		}
	}
	if ascii {
		return label, nil
	}
	enc, err := punycodeEncode(label)
	if err != nil {
		return "", ErrInvalidOrigin
	}
	return "xn--" + enc, nil
}

// formatIPv6 writes an IPv6 address like the WHATWG URL serializer and RFC
// 5952: lower-case hexadecimal groups without leading zeros, the first
// longest run of two or more zero groups as "::", never a dotted quad.
func formatIPv6(a [16]byte) string {
	var groups [8]uint16
	for i := range groups {
		groups[i] = binary.BigEndian.Uint16(a[2*i:])
	}
	bestStart, bestLen := -1, 0
	for i := 0; i < 8; {
		if groups[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && groups[j] == 0 {
			j++
		}
		if j-i > bestLen && j-i >= 2 {
			bestStart, bestLen = i, j-i
		}
		i = j
	}
	var b strings.Builder
	for i := 0; i < 8; i++ {
		if i == bestStart {
			b.WriteString("::")
			i += bestLen - 1
			continue
		}
		if b.Len() > 0 && !strings.HasSuffix(b.String(), ":") {
			b.WriteByte(':')
		}
		b.WriteString(strconv.FormatUint(uint64(groups[i]), 16))
	}
	return b.String()
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// CodeProof is what recover sends instead of the code:
// hex(SHA-256("restow-recovery-code:" + origin + ":" + code)). origin must be
// the canonical origin recover actually connects to, so a code typed into a
// look-alike instance opens nothing at the real one.
func CodeProof(origin, norm string) string {
	return sha256Hex(proofPrefix + origin + ":" + norm)
}

// HashCodeProof is the value the instance stores: hex(SHA-256(codeProof)).
func HashCodeProof(proof string) string { return sha256Hex(proof) }

// NewSessionSecret makes the session secret (32 random bytes, lower-case
// hexadecimal) and its SHA-256, which is the only form that leaves the
// machine apart from the Basic authorization header.
func NewSessionSecret() (secret, sha string, err error) {
	buf := make([]byte, SessionSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("cannot make a session secret: %w", err)
	}
	secret = hex.EncodeToString(buf)
	return secret, SessionSecretSHA256(secret), nil
}

// SessionSecretSHA256 is hex(SHA-256) of the secret's ASCII form.
func SessionSecretSHA256(secret string) string { return sha256Hex(secret) }

// MatchCode is the six-digit number both recover and the Restow UI show
// before the session is approved: the first four bytes of
// SHA-256("restow-recovery-match:" + secretSHA) as a big-endian number,
// modulo 10^6, with leading zeros.
func MatchCode(secretSHA string) string {
	sum := sha256.Sum256([]byte(matchPrefix + secretSHA))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(sum[:4])%1000000)
}

// FormatMatchCode shows a match code in two groups ("483 914").
func FormatMatchCode(code string) string {
	if len(code) != 6 {
		return code
	}
	return code[:3] + " " + code[3:]
}

// SPKICheck is the check value of the instance certificate: RFC 4648 Base32
// (upper case) of the first 80 bits of the SHA-256 of its
// SubjectPublicKeyInfo, in groups of four (XXXX-XXXX-XXXX-XXXX).
func SPKICheck(spkiSHA256Hex string) (string, error) {
	raw, err := hex.DecodeString(spkiSHA256Hex)
	if err != nil || len(raw) != sha256.Size {
		return "", errors.New("the SPKI hash must be 64 hexadecimal characters")
	}
	enc := base32.StdEncoding.EncodeToString(raw[:SPKICheckBytes])
	groups := make([]string, 0, len(enc)/4)
	for i := 0; i < len(enc); i += 4 {
		groups = append(groups, enc[i:i+4])
	}
	return strings.Join(groups, "-"), nil
}

// SPKICheckMatches reports whether the operator typed the whole check value
// (16 characters, 80 bits), ignoring dashes, spaces and case. A prefix is
// refused: the SPKI of the instance is public, and a key whose SPKI hash
// shares a short prefix can be searched for offline.
func SPKICheckMatches(typed, check string) bool {
	t := compactCheck(typed)
	c := compactCheck(check)
	if len(c) != base32.StdEncoding.EncodedLen(SPKICheckBytes) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(t), []byte(c)) == 1
}

func compactCheck(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '-' || unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(unicode.ToUpper(r))
	}
	return b.String()
}
