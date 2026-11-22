package oneshot

import (
	"crypto/ed25519"
	"fmt"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/release"
)

func TestCheckSums(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	key := release.NewPublicKey(pub, "t")
	sha := strings.Repeat("ab", 32)
	offer := api.OneshotISO{Version: "0.5.1", FileName: "restow-recovery_0.5.1_amd64.iso", SHA256: sha}
	trust := ISOTrust{Key: key, AgentVersion: "0.5.1"}
	check := func(sums string, o api.OneshotISO, tr ISOTrust) (string, error) {
		return CheckSums([]byte(sums), release.Sign(priv, []byte(sums)), o, tr)
	}
	line := fmt.Sprintf("%s  recovery/restow-recovery_0.5.1_amd64.iso\n", sha)
	if got, err := check("0000  other\n"+line, offer, trust); err != nil || got != sha {
		t.Fatalf("%q %v", got, err)
	}
	// A rebuild of the same release, a CRLF list, a binary-mode star.
	rebuild := api.OneshotISO{Version: "0.5.1", FileName: "restow-recovery_0.5.1.2_amd64.iso", SHA256: strings.ToUpper(sha)}
	if _, err := check(sha+" *recovery/restow-recovery_0.5.1.2_amd64.iso\r\n", rebuild, trust); err != nil {
		t.Errorf("rebuild: %v", err)
	}
	// A development build takes the ISO of any release.
	if _, err := check(line, offer, ISOTrust{Key: key, AgentVersion: "0.6.0-dev"}); err != nil {
		t.Errorf("dev build: %v", err)
	}
	for name, tc := range map[string]struct {
		sums  string
		offer api.OneshotISO
		trust ISOTrust
		want  string
	}{
		"empty":           {"", offer, trust, "empty"},
		"named twice":     {line + line, offer, trust, "twice"},
		"malformed":       {"abc  recovery/restow-recovery_0.5.1_amd64.iso\n", offer, trust, "malformed"},
		"not named":       {sha + "  restow-recovery_0.5.1_amd64.iso\n", offer, trust, "does not name"},
		"other hash":      {strings.Repeat("cd", 32) + "  recovery/restow-recovery_0.5.1_amd64.iso\n", offer, trust, "the signed list says"},
		"other release":   {line, offer, ISOTrust{Key: key, AgentVersion: "0.5.2"}, "this command is 0.5.2"},
		"version vs name": {line, api.OneshotISO{Version: "0.5.2", FileName: offer.FileName, SHA256: sha}, ISOTrust{Key: key, AgentVersion: "0.5.2"}, "no ISO of release"},
		"path in name":    {line, api.OneshotISO{Version: "0.5.1", FileName: "../restow-recovery_0.5.1_amd64.iso", SHA256: sha}, trust, "not the name"},
		"no trust":        {line, offer, ISOTrust{AgentVersion: "0.5.1"}, "no release key"},
	} {
		if _, err := check(tc.sums, tc.offer, tc.trust); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", name, err, tc.want)
		}
	}
	// Another key, or a signature over other bytes.
	pub2, _, _ := ed25519.GenerateKey(nil)
	if _, err := check(line, offer, ISOTrust{Key: release.NewPublicKey(pub2, "o"), AgentVersion: "0.5.1"}); err == nil {
		t.Error("another key accepted")
	}
	if _, err := CheckSums([]byte(line), release.Sign(priv, []byte(line+"\n")), offer, trust); err == nil {
		t.Error("a signature over other bytes accepted")
	}
	// The list the admin checked: exactly those bytes, signature or not.
	pinned := ISOTrust{TrustedSumsSHA256: sumHex([]byte(line)), AgentVersion: "0.5.1"}
	if _, err := CheckSums([]byte(line), nil, offer, pinned); err != nil {
		t.Errorf("pinned list: %v", err)
	}
	if _, err := CheckSums([]byte(line+" "), nil, offer, pinned); err == nil {
		t.Error("another list accepted with the pinned hash")
	}
}
