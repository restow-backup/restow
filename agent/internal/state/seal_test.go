package state

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// xorSealer stands in for DPAPI in tests.
type xorSealer struct{ fail bool }

func (xorSealer) Scheme() string { return "test-xor" }

func (x xorSealer) Seal(p []byte) ([]byte, error) {
	out := make([]byte, len(p))
	for i, b := range p {
		out[i] = b ^ 0x5a
	}
	return out, nil
}

func (x xorSealer) Open(b []byte) ([]byte, error) {
	if x.fail {
		return nil, errors.New("wrong machine")
	}
	return x.Seal(b)
}

func sampleState() *State {
	return &State{SchemaVersion: 1, ServerURL: "https://r.example", EndpointID: "ep1", Hostname: "pc",
		AgentSecret: "secret-agent-value", RepositoryURL: "rest:https://r.example/agent/restic/ep1/", RepositoryPassword: "repo-pass-value"}
}

func TestSealedStateHidesSecrets(t *testing.T) {
	raw, err := encode(sampleState(), xorSealer{})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"secret-agent-value", "repo-pass-value", `"agentSecret"`, `"repositoryPassword"`} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatalf("%s in %s", secret, raw)
		}
	}
	if !bytes.Contains(raw, []byte(`"scheme": "test-xor"`)) || !bytes.Contains(raw, []byte(`"serverUrl": "https://r.example"`)) {
		t.Fatalf("missing fields: %s", raw)
	}
	s, err := decode(raw, xorSealer{})
	if err != nil {
		t.Fatal(err)
	}
	if s.AgentSecret != "secret-agent-value" || s.RepositoryPassword != "repo-pass-value" || s.Validate() != nil {
		t.Fatalf("%+v", s)
	}
}

func TestSealedStateRefusals(t *testing.T) {
	clear, _ := encode(sampleState(), nil)
	sealed, _ := encode(sampleState(), xorSealer{})
	for name, c := range map[string]struct {
		raw  []byte
		sl   sealer
		want string
	}{
		"clear text on a sealing system": {clear, xorSealer{}, "clear text"},
		"sealed on a system without":     {sealed, nil, "cannot read"},
		"other machine":                  {sealed, xorSealer{fail: true}, "cannot be decrypted"},
		"no protected block":             {[]byte(`{"schemaVersion":1,"serverUrl":"x"}`), xorSealer{}, "missing"},
		"other scheme":                   {bytes.ReplaceAll(sealed, []byte("test-xor"), []byte("other")), xorSealer{}, "expected"},
		"bad base64":                     {[]byte(`{"protected":{"scheme":"test-xor","blob":"%%%"}}`), xorSealer{}, "base64"},
	} {
		_, err := decode(c.raw, c.sl)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", name, err, c.want)
		}
	}
}

func TestClearStateUnchangedOnUnix(t *testing.T) {
	raw, err := encode(sampleState(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"agentSecret": "secret-agent-value"`)) || bytes.Contains(raw, []byte("protected")) {
		t.Fatalf("%s", raw)
	}
}
