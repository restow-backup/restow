//go:build windows

package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

const untrustedHint = "The agent runs as SYSTEM and only uses files and folders that only SYSTEM, Administrators " +
	"and TrustedInstaller can change; fix the owner and permissions or re-run the install script"

// devUserSID is the user of a development run (RESTOW_AGENT_DIR), trusted like
// the agent's own uid on Unix: a run without privileges gains nothing from
// its own files.
var devUserSID = sync.OnceValue(func() string {
	if !DevLayout() {
		return ""
	}
	sid, _ := winapi.CurrentUserSID()
	return sid
})

func trustedSet() map[string]bool { return TrustedSIDs(devUserSID()) }

// TrustedFile resolves path and checks that the file and every folder above
// it can only be changed by trusted principals (docs/WINDOWS-AGENT.md,
// section 6): the file and its folder by the strict rules, the folders above
// by the ancestor rules, no link, junction or mount point anywhere. It
// returns the final path (8.3 names resolved), which is what the caller must
// open or execute.
func TrustedFile(path string) (string, error) {
	return checkChain(path, true, RuleStrict, RuleStrict)
}

// TrustedDir checks a folder like TrustedFile checks a file. With
// allowSticky the folder is the parent of a restore target: untrusted users
// may add files and folders to it (C:\), the folders above follow the
// ancestor rules.
func TrustedDir(dir string, allowSticky bool) (string, error) {
	if allowSticky {
		return checkChain(dir, false, RuleRestoreParent, RuleAncestor)
	}
	return checkChain(dir, false, RuleStrict, RuleStrict)
}

// CheckTarget checks path (a file or folder) with explicit rules for the
// object and its direct parent; the folders above follow the ancestor rules.
func CheckTarget(path string, object, parent ACLRule) (string, error) {
	return checkChain(path, false, object, parent)
}

func untrusted(path, reason string) error { return &UntrustedError{Path: path, Reason: reason} }

func checkChain(path string, wantFile bool, objectRule, parentRule ACLRule) (string, error) {
	drive, parts, err := SplitDrivePath(path)
	if err != nil {
		var we *WinPathError
		if errors.As(err, &we) {
			return "", untrusted(path, we.Reason)
		}
		return "", err
	}
	trusted := trustedSet()
	n := len(parts)
	final := ""
	for i := -1; i < n; i++ {
		cur := drive + `\`
		if i >= 0 {
			cur = JoinDrivePath(drive, parts[:i+1]...)
		}
		rule := RuleAncestor
		switch i {
		case n - 1:
			rule = objectRule
		case n - 2:
			rule = parentRule
		}
		last := i == n-1
		resolved, err := checkOne(cur, rule, trusted, last, wantFile && last)
		if err != nil {
			return "", err
		}
		if last {
			final = resolved
		}
	}
	return final, nil
}

func checkOne(path string, rule ACLRule, trusted map[string]bool, resolve, wantFile bool) (string, error) {
	h, err := winapi.OpenNoFollow(path)
	if err != nil {
		return "", &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer syscall.CloseHandle(h)
	var fi syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &fi); err != nil {
		return "", &os.PathError{Op: "stat", Path: path, Err: err}
	}
	if fi.FileAttributes&winapi.FileAttributeReparsePoint != 0 {
		return "", untrusted(path, "is a symbolic link, junction or mount point")
	}
	isDir := fi.FileAttributes&winapi.FileAttributeDirectory != 0
	switch {
	case wantFile && isDir:
		return "", untrusted(path, "is not a regular file")
	case !wantFile && !isDir:
		return "", untrusted(path, "is not a folder")
	}
	sddl, err := winapi.HandleSDDL(h)
	if err != nil {
		return "", fmt.Errorf("cannot read the permissions of %s: %w", path, err)
	}
	info, err := ParseSDDL(sddl)
	if err != nil {
		return "", fmt.Errorf("cannot read the permissions of %s: %w", path, err)
	}
	if reason := EvaluateACL(info, rule, trusted); reason != "" {
		return "", untrusted(path, reason)
	}
	if !resolve {
		return path, nil
	}
	fp, err := winapi.FinalPathName(h)
	if err != nil {
		return "", fmt.Errorf("cannot resolve %s: %w", path, err)
	}
	fp = CleanFinalPath(fp)
	if _, _, err := SplitDrivePath(fp); err != nil && len(fp) > 3 {
		return "", untrusted(path, "does not resolve to a plain drive path ("+fp+")")
	}
	return fp, nil
}

// EnsureBinDir creates the install prefix and its bin folder below Program
// Files (they inherit its permissions) and checks the chain.
func EnsureBinDir() (string, error) { return EnsureRootDir(BinDir()) }

// EnsureRootDir creates dir and any missing parents below a trusted existing
// folder (inheriting its permissions), then checks the chain with the strict
// rules. A folder that exists and is not trusted is refused, not repaired.
func EnsureRootDir(dir string) (string, error) {
	dir = filepath.Clean(dir)
	var missing []string
	existing := dir
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		} else if !os.IsNotExist(err) {
			return "", err
		}
		missing = append(missing, existing)
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		existing = parent
	}
	if _, err := checkChain(existing, false, RuleAncestor, RuleAncestor); err != nil {
		return "", err
	}
	for i := len(missing) - 1; i >= 0; i-- {
		if err := MkdirTrusted(missing[i], 0o755); err != nil && !os.IsExist(err) {
			return "", err
		}
	}
	return TrustedDir(dir, false)
}

// MkdirTrusted creates one folder owned by BUILTIN\Administrators that
// inherits the permissions of its parent (an owner and no DACL in the
// security descriptor). Without the owner the folder would belong to the
// creating account wherever administrators own what they create (UAC off,
// the built-in Administrator, the policy "Default owner for objects created
// by members of the Administrators group: Object creator"), and the trust
// check would refuse the agent's own folder. A development layout run
// without elevation cannot set that owner and gets a plain folder; perm is
// for Unix.
func MkdirTrusted(dir string, _ os.FileMode) error {
	err := winapi.CreateDirectorySDDL(dir, OwnerAdministrators)
	switch {
	case err == nil:
		return nil
	case DevLayout() && winapi.IsErrno(err, winapi.ErrorInvalidOwner):
		return os.Mkdir(dir, 0o755)
	}
	return &os.PathError{Op: "mkdir", Path: dir, Err: err}
}

// CreateTrusted creates a new file (it must not exist) owned by
// BUILTIN\Administrators with the permissions it inherits from its folder,
// opened for writing; see MkdirTrusted.
func CreateTrusted(name string) (*os.File, error) {
	h, err := winapi.CreateFileSDDL(name, OwnerAdministrators)
	switch {
	case err == nil:
		return os.NewFile(uintptr(h), name), nil
	case DevLayout() && winapi.IsErrno(err, winapi.ErrorInvalidOwner):
		return os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	}
	return nil, &os.PathError{Op: "create", Path: name, Err: err}
}

// EnsureProtectedDir creates dir (its parent must exist) with the given DACL
// set in the same call, or, when it exists, checks that it is a real folder
// owned by a trusted principal and resets its DACL to sddl (like chmod on
// Unix). A folder owned by someone else is refused: they may have prepared it.
// An empty one is replaced by a protected folder instead (a user could create
// C:\ProgramData\Restow\state before the agent protected the folder above
// it, as earlier 0.5.0 versions left it when the service started before the
// enrollment); nothing of it is used.
func EnsureProtectedDir(dir, sddl string) error {
	err := winapi.CreateDirectorySDDL(dir, OwnerAdministrators+sddl)
	if err == nil {
		return nil
	}
	if !winapi.IsErrno(err, winapi.ErrorAlreadyExists) {
		return &os.PathError{Op: "mkdir", Path: dir, Err: err}
	}
	if foreign, err := checkOwnedFolder(dir); err != nil {
		if foreign && replaceEmptyFolder(dir, sddl) {
			return nil
		}
		return err
	}
	if err := winapi.SetFileDACL(dir, sddl); err != nil {
		return &os.PathError{Op: "set permissions", Path: dir, Err: err}
	}
	return nil
}

// replaceEmptyFolder removes dir when it holds nothing and creates it again
// owned by Administrators with sddl. A folder that is not empty, or one that
// someone created again in between, stays and is refused by the caller.
func replaceEmptyFolder(dir, sddl string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) > 0 {
		return false
	}
	if err := os.Remove(dir); err != nil {
		return false
	}
	return winapi.CreateDirectorySDDL(dir, OwnerAdministrators+sddl) == nil
}

// checkOwnedFolder checks that dir is a real folder owned by a trusted
// principal; foreign reports that it is a real folder owned by someone else.
func checkOwnedFolder(dir string) (foreign bool, err error) {
	h, err := winapi.OpenNoFollow(dir)
	if err != nil {
		return false, &os.PathError{Op: "open", Path: dir, Err: err}
	}
	defer syscall.CloseHandle(h)
	var fi syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &fi); err != nil {
		return false, &os.PathError{Op: "stat", Path: dir, Err: err}
	}
	if fi.FileAttributes&winapi.FileAttributeReparsePoint != 0 {
		return false, untrusted(dir, "is a symbolic link, junction or mount point")
	}
	if fi.FileAttributes&winapi.FileAttributeDirectory == 0 {
		return false, untrusted(dir, "is not a folder")
	}
	sddl, err := winapi.HandleSDDL(h)
	if err != nil {
		return false, err
	}
	info, err := ParseSDDL(sddl)
	if err != nil {
		return false, err
	}
	if !trustedSet()[info.Owner] {
		return true, untrusted(dir, fmt.Sprintf("is owned by %s; someone else may have prepared it. "+
			"If you did not create it, delete it as an administrator and run the command again", describeSID(info.Owner)))
	}
	return false, nil
}

// ProtectFile resets the DACL of a file the agent writes and that must stay
// private (agent.log and its rotated copies) to SYSTEM and Administrators,
// replacing what it inherited or had from before. A development layout
// keeps the permissions it has.
func ProtectFile(path string) error {
	if DevLayout() {
		return nil
	}
	if err := winapi.SetFileDACL(path, PrivateFileSDDL); err != nil {
		return &os.PathError{Op: "set permissions", Path: path, Err: err}
	}
	return nil
}

// OwnerTrusted reports whether a file or folder (not a link) is owned by a
// trusted principal, and returns its parsed security information.
func OwnerTrusted(path string) (SecurityInfo, error) {
	h, err := winapi.OpenNoFollow(path)
	if err != nil {
		return SecurityInfo{}, &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer syscall.CloseHandle(h)
	var fi syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &fi); err != nil {
		return SecurityInfo{}, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	if fi.FileAttributes&winapi.FileAttributeReparsePoint != 0 {
		return SecurityInfo{}, untrusted(path, "is a symbolic link, junction or mount point")
	}
	sddl, err := winapi.HandleSDDL(h)
	if err != nil {
		return SecurityInfo{}, err
	}
	info, err := ParseSDDL(sddl)
	if err != nil {
		return SecurityInfo{}, err
	}
	if !trustedSet()[info.Owner] {
		return info, untrusted(path, fmt.Sprintf("is owned by %s", describeSID(info.Owner)))
	}
	return info, nil
}

// Trusted reports whether sid belongs to the trusted principals.
func Trusted(sid string) bool { return trustedSet()[sid] }
