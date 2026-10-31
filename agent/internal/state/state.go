// Package state persists the secrets the agent received at enrollment: the
// agent secret and the repository password. The file is written atomically
// with mode 0600 in a 0700 directory, owned by the user the agent runs as
// (root). On Windows the folder has a protected DACL (SYSTEM and
// Administrators only) and the two secret fields are additionally encrypted
// with DPAPI for the machine (protect_windows.go, docs/WINDOWS-AGENT.md,
// section 7). Nothing else secret is stored anywhere; status.json (see package
// status) is deliberately free of secrets.
package state

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/atomicfile"
)

// SchemaVersion is bumped when the file format changes incompatibly.
const SchemaVersion = 1

// ErrNotEnrolled is returned by Load when no state file exists.
var ErrNotEnrolled = errors.New("this machine is not enrolled")

// State is the enrollment result.
type State struct {
	SchemaVersion int       `json:"schemaVersion"`
	ServerURL     string    `json:"serverUrl"`
	EndpointID    string    `json:"endpointId"`
	Hostname      string    `json:"hostname"`
	Profile       string    `json:"profile,omitempty"`
	EnrolledAt    time.Time `json:"enrolledAt"`
	// AllowInsecureHTTP records that enrollment used the development flag;
	// the service then accepts plain http:// URLs too.
	AllowInsecureHTTP bool `json:"allowInsecureHttp,omitempty"`
	// Hooks is the local hook policy: "off" (also when empty), "scripts" or
	// "any" (package hooks). Only root on this machine changes it
	// (`restow-agent hooks`, `enroll --hooks`); the server never writes it.
	Hooks string `json:"hooks,omitempty"`

	// AgentSecret authenticates against the Restow instance (HTTP Basic
	// endpointId:agentSecret, also used for the restic REST repository).
	AgentSecret string `json:"agentSecret,omitempty"`
	// RepositoryURL is the restic repository, e.g. rest:https://host/agent/restic/<id>/.
	RepositoryURL string `json:"repositoryUrl"`
	// RepositoryPassword is the restic repository password.
	RepositoryPassword string `json:"repositoryPassword,omitempty"`
}

// Validate checks that all fields needed to run are present.
func (s *State) Validate() error {
	switch {
	case s.ServerURL == "":
		return errors.New("state has no serverUrl")
	case s.EndpointID == "":
		return errors.New("state has no endpointId")
	case s.AgentSecret == "":
		return errors.New("state has no agentSecret")
	case s.RepositoryURL == "":
		return errors.New("state has no repositoryUrl")
	case s.RepositoryPassword == "":
		return errors.New("state has no repositoryPassword")
	}
	return nil
}

// Secrets returns every secret value, for registration with the redactor.
func (s *State) Secrets() []string {
	return []string{s.AgentSecret, s.RepositoryPassword}
}

// Load reads the state file. It returns ErrNotEnrolled when the file does not
// exist. Permissions that are too open are corrected (and reported through the
// returned warnings); a file owned by someone else is refused.
func Load(path string) (*State, []string, error) {
	warnings, err := checkFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, ErrNotEnrolled
		}
		return nil, warnings, err
	}
	raw, err := atomicfile.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, ErrNotEnrolled
		}
		return nil, warnings, err
	}
	s, err := decode(raw, secretSealer)
	if err != nil {
		return nil, warnings, fmt.Errorf("state file %s is unusable (%v); re-enroll with a new token", path, err)
	}
	if s.SchemaVersion > SchemaVersion {
		return nil, warnings, fmt.Errorf("state file %s was written by a newer agent (schema %d); update the agent", path, s.SchemaVersion)
	}
	if err := s.Validate(); err != nil {
		return nil, warnings, fmt.Errorf("state file %s is incomplete: %v; re-enroll with a new token", path, err)
	}
	s.ServerURL = strings.TrimRight(s.ServerURL, "/")
	return s, warnings, nil
}

// Save writes the state atomically with restrictive permissions.
func (s *State) Save(path string) error {
	s.SchemaVersion = SchemaVersion
	raw, err := encode(s, secretSealer)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := ensureDir(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := atomicfile.Rename(tmpName, path); err != nil {
		cleanup()
		return err
	}
	return syncDir(dir)
}

// Remove deletes the state file (used by uninstall).
func Remove(path string) error {
	err := os.Remove(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// sealer encrypts the secret fields of the state file at rest. nil (Unix)
// stores them as they are, protected by the file mode.
type sealer interface {
	Scheme() string
	Seal(plain []byte) ([]byte, error)
	Open(blob []byte) ([]byte, error)
}

// protectedSecrets is the encrypted form of the secret fields.
type protectedSecrets struct {
	Scheme string `json:"scheme"`
	Blob   string `json:"blob"`
}

type secretFields struct {
	AgentSecret        string `json:"agentSecret"`
	RepositoryPassword string `json:"repositoryPassword"`
}

type onDisk struct {
	State
	Protected *protectedSecrets `json:"protected,omitempty"`
}

// encode renders the state file. With a sealer the secrets only appear
// encrypted, in "protected"; every other field stays readable.
func encode(s *State, sl sealer) ([]byte, error) {
	out := onDisk{State: *s}
	if sl != nil {
		plain, err := json.Marshal(secretFields{AgentSecret: s.AgentSecret, RepositoryPassword: s.RepositoryPassword})
		if err != nil {
			return nil, err
		}
		blob, err := sl.Seal(plain)
		if err != nil {
			return nil, fmt.Errorf("cannot protect the secrets: %w", err)
		}
		out.AgentSecret, out.RepositoryPassword = "", ""
		out.Protected = &protectedSecrets{Scheme: sl.Scheme(), Blob: base64.StdEncoding.EncodeToString(blob)}
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

// decode reads a state file. With a sealer the secrets must be protected
// (a file with secrets in clear text is refused); without one, protected
// secrets cannot be read (the file comes from another system).
func decode(raw []byte, sl sealer) (*State, error) {
	var d onDisk
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	s := d.State
	switch {
	case sl == nil && d.Protected != nil:
		return nil, fmt.Errorf("the secrets are encrypted with %q, which this system cannot read", d.Protected.Scheme)
	case sl == nil:
		return &s, nil
	case d.AgentSecret != "" || d.RepositoryPassword != "":
		return nil, errors.New("the secrets are stored in clear text, which this system does not accept")
	case d.Protected == nil:
		return nil, errors.New("the protected secrets are missing")
	case d.Protected.Scheme != sl.Scheme():
		return nil, fmt.Errorf("the secrets are encrypted with %q, expected %q", d.Protected.Scheme, sl.Scheme())
	}
	blob, err := base64.StdEncoding.DecodeString(d.Protected.Blob)
	if err != nil {
		return nil, fmt.Errorf("the protected secrets are not valid base64: %v", err)
	}
	plain, err := sl.Open(blob)
	if err != nil {
		return nil, fmt.Errorf("the protected secrets cannot be decrypted on this machine: %w", err)
	}
	var sec secretFields
	if err := json.Unmarshal(plain, &sec); err != nil {
		return nil, fmt.Errorf("the protected secrets are corrupt: %v", err)
	}
	s.AgentSecret, s.RepositoryPassword = sec.AgentSecret, sec.RepositoryPassword
	return &s, nil
}
