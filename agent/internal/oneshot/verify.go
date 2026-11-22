package oneshot

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/release"
)

// MaxISOBytes bounds the recovery ISO (the instance's limit, BM 26.13).
const MaxISOBytes = 2 << 30

// maxSumsBytes bounds the signed checksum list.
const maxSumsBytes = 1 << 20

// ISOTrust is how the command checks the recovery ISO (docs/BAREMETAL-ONESHOT.md
// 5.1, 5.4): the release key the install script carries, or the SHA-256 of a
// checksum list the admin checked elsewhere (RESTOW_SHA256SUMS_SHA256).
type ISOTrust struct {
	Key               *release.PublicKey
	TrustedSumsSHA256 string
	// AgentVersion is this command's version: the ISO must be of the same
	// release (a rebuild of it counts). A development build takes any.
	AgentVersion string
}

var reISOName = regexp.MustCompile(`^restow-recovery_([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\.([1-9][0-9]{0,2}))?_amd64\.iso$`)

// devBuild: a local build has no signed release to match.
func devBuild(v string) bool { return strings.HasSuffix(v, "-dev") }

// CheckSums verifies the checksum list of the offered ISO and returns the
// SHA-256 it lists for the image. The list must be signed with the release
// key (or be exactly the list the admin checked), name the offered file
// once under recovery/, with the hash the instance announced, and the file
// must be an ISO of this command's release. Nothing of the list is used
// unless all of that holds.
func CheckSums(sums, signature []byte, offered api.OneshotISO, t ISOTrust) (string, error) {
	if len(sums) == 0 || len(sums) > maxSumsBytes {
		return "", errors.New("the checksum list of the recovery ISO is empty or too large")
	}
	switch {
	case t.TrustedSumsSHA256 != "":
		h := sha256.Sum256(sums)
		if !strings.EqualFold(hex.EncodeToString(h[:]), t.TrustedSumsSHA256) {
			return "", fmt.Errorf("the checksum list hashes to %s, not to RESTOW_SHA256SUMS_SHA256", hex.EncodeToString(h[:]))
		}
	case t.Key != nil:
		if err := t.Key.Verify(sums, signature); err != nil {
			return "", fmt.Errorf("the checksum list of the recovery ISO: %w", err)
		}
	default:
		return "", errors.New("no release key to check the recovery ISO with (a development build of the instance); set RESTOW_SHA256SUMS_SHA256")
	}
	m := reISOName.FindStringSubmatch(offered.FileName)
	if m == nil {
		return "", fmt.Errorf("%q is not the name of a recovery ISO", offered.FileName)
	}
	if m[1] != offered.Version {
		return "", fmt.Errorf("%s is no ISO of release %s", offered.FileName, offered.Version)
	}
	if !devBuild(t.AgentVersion) && offered.Version != t.AgentVersion {
		return "", fmt.Errorf("the instance offers the recovery ISO of %s, this command is %s", offered.Version, t.AgentVersion)
	}
	var found string
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		hash, path, ok := strings.Cut(line, " ")
		path = strings.TrimPrefix(strings.TrimLeft(path, " "), "*")
		if !ok || path != "recovery/"+offered.FileName {
			continue
		}
		raw, err := hex.DecodeString(hash)
		if err != nil || len(raw) != 32 {
			return "", fmt.Errorf("the line of %s is malformed", offered.FileName)
		}
		if found != "" {
			return "", fmt.Errorf("the checksum list names %s twice", offered.FileName)
		}
		found = strings.ToLower(hash)
	}
	if found == "" {
		return "", fmt.Errorf("the checksum list does not name %s", offered.FileName)
	}
	if !strings.EqualFold(found, offered.SHA256) {
		return "", fmt.Errorf("the instance announced %s for %s, the signed list says %s", offered.SHA256, offered.FileName, found)
	}
	return found, nil
}
