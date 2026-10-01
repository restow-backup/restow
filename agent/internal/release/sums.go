package release

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"strings"
)

// Sums is a parsed SHA256SUMS file of a release: path (`<os>-<arch>/<file>`)
// to lower-case hex SHA-256.
type Sums map[string]string

// ParseSums reads `<sha256>  <path>` lines (also `<sha256> *<path>`). Any other
// line makes the file invalid: a signed file is taken as a whole or not at all.
func ParseSums(text []byte) (Sums, error) {
	sums := Sums{}
	sc := bufio.NewScanner(strings.NewReader(string(text)))
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		hash, path, ok := strings.Cut(line, " ")
		path = strings.TrimPrefix(strings.TrimLeft(path, " "), "*")
		raw, err := hex.DecodeString(hash)
		if !ok || err != nil || len(raw) != 32 || path == "" || strings.ContainsAny(path, " \t") {
			return nil, fmt.Errorf("SHA256SUMS line %d is malformed", n)
		}
		if _, dup := sums[path]; dup {
			return nil, fmt.Errorf("SHA256SUMS lists %s twice", path)
		}
		sums[path] = strings.ToLower(hash)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(sums) == 0 {
		return nil, fmt.Errorf("SHA256SUMS is empty")
	}
	return sums, nil
}

// Lookup returns the hash of file for target (`linux-amd64`).
func (s Sums) Lookup(target, file string) (string, error) {
	if h, ok := s[target+"/"+file]; ok {
		return h, nil
	}
	return "", fmt.Errorf("the signed SHA256SUMS has no entry for %s/%s", target, file)
}

// VerifiedSums checks the signature of a SHA256SUMS file with the key and
// parses it. Nothing of the file is used unless the signature is good.
func VerifiedSums(key *PublicKey, sums, signature []byte) (Sums, error) {
	if err := key.Verify(sums, signature); err != nil {
		return nil, err
	}
	return ParseSums(sums)
}
