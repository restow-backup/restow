//go:build windows

package state

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// stateFileSDDL is the DACL a state file gets when its permissions are repaired.
const stateFileSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"

// ensureDir creates the state folder (and C:\ProgramData\Restow above it) with
// the protected DACL set when the folder is created, or checks and resets an
// existing one. Development layouts use plain folders.
func ensureDir(dir string) error {
	if paths.DevLayout() {
		return os.MkdirAll(dir, 0o700)
	}
	parent := filepath.Dir(dir)
	if _, err := os.Lstat(parent); os.IsNotExist(err) {
		if err := paths.EnsureProtectedDir(parent, paths.ProtectedSDDL); err != nil {
			return err
		}
	}
	return paths.EnsureProtectedDir(dir, paths.ProtectedSDDL)
}

func syncDir(string) error { return nil }

// createTemp creates the temporary file a new state is written to, owned by
// Administrators and with the state file's DACL from the start (the rename keeps
// both), so checkFile accepts it whoever wrote it: the service as SYSTEM or the
// administrator who runs the installer. A development layout run without elevation
// cannot set that owner and gets a plain temporary file.
func createTemp(dir string) (*os.File, error) {
	for range 16 {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		name := filepath.Join(dir, ".state-"+hex.EncodeToString(b[:])+".tmp")
		h, err := winapi.CreateFileSDDL(name, paths.OwnerAdministrators+stateFileSDDL)
		if err == nil {
			return os.NewFile(uintptr(h), name), nil
		}
		if winapi.IsErrno(err, winapi.ErrorFileExists) || winapi.IsErrno(err, winapi.ErrorAlreadyExists) {
			continue
		}
		if paths.DevLayout() && winapi.IsErrno(err, winapi.ErrorInvalidOwner) {
			return os.CreateTemp(dir, ".state-*.tmp")
		}
		return nil, &os.PathError{Op: "create", Path: name, Err: err}
	}
	return nil, fmt.Errorf("cannot find a free name for a temporary state file in %s", dir)
}

// checkFile enforces the protection of the state file: a regular file (no
// link), owned by SYSTEM or Administrators, no access at all for anyone else.
// Too open permissions are reset to SYSTEM and Administrators (and reported);
// a file owned by someone else is refused.
func checkFile(path string) ([]string, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("state file %s is not a regular file", path)
	}
	info, err := paths.OwnerTrusted(path)
	if err != nil {
		return nil, fmt.Errorf("state file %s is refused: %w", path, err)
	}
	if reason := paths.EvaluateACL(info, paths.RulePrivate, paths.TrustedSIDs()); reason != "" && !paths.DevLayout() {
		if err := winapi.SetFileDACL(path, stateFileSDDL); err != nil {
			return nil, fmt.Errorf("state file %s %s and its permissions cannot be reset: %w", path, reason, err)
		}
		return []string{fmt.Sprintf("state file %s %s; its permissions were reset to SYSTEM and Administrators", path, reason)}, nil
	}
	return nil, nil
}

// dpapiSealer encrypts the secrets with DPAPI for this machine.
type dpapiSealer struct{}

func (dpapiSealer) Scheme() string { return "dpapi-machine" }

func (dpapiSealer) Seal(plain []byte) ([]byte, error) {
	return winapi.ProtectMachine(plain, "Restow agent state")
}

func (dpapiSealer) Open(blob []byte) ([]byte, error) { return winapi.UnprotectMachine(blob) }

var secretSealer sealer = dpapiSealer{}
