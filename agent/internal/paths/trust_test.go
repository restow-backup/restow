//go:build unix

package paths

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// trustedBase returns a folder whose whole chain is trusted: /root when the
// tests run as root (a container; a bind-mounted checkout may not keep
// ownership changes), else the package folder of the checkout (owned by the
// user running the tests).
func trustedBase(t *testing.T) string {
	t.Helper()
	parent := "/root"
	if os.Geteuid() != 0 {
		wd, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := TrustedDir(wd, false); err != nil {
			t.Skipf("the checkout is not in a trusted chain here: %v", err)
		}
		parent = wd
	}
	dir, err := os.MkdirTemp(parent, "trust-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func write(t *testing.T, p string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

func isUntrusted(err error) bool {
	var u *UntrustedError
	return errors.As(err, &u)
}

func TestTrustedFileAcceptsAProperInstallation(t *testing.T) {
	base := trustedBase(t)
	bin := filepath.Join(base, "bin", "restic")
	write(t, bin, 0o755)
	got, err := TrustedFile(bin)
	if err != nil || got != bin {
		t.Fatalf("%q %v", got, err)
	}
	// A link to it resolves to the real file, which is what gets executed.
	link := filepath.Join(base, "link")
	if err := os.Symlink(bin, link); err != nil {
		t.Fatal(err)
	}
	if got, err := TrustedFile(link); err != nil || got != bin {
		t.Fatalf("link: %q %v", got, err)
	}
}

func TestTrustedFileRefusesWhatOthersCanChange(t *testing.T) {
	base := trustedBase(t)

	writable := filepath.Join(base, "a", "restic")
	write(t, writable, 0o775)
	if _, err := TrustedFile(writable); !isUntrusted(err) {
		t.Fatalf("group-writable file: %v", err)
	}

	inOpenDir := filepath.Join(base, "open", "restic")
	write(t, inOpenDir, 0o755)
	if err := os.Chmod(filepath.Dir(inOpenDir), 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := TrustedFile(inOpenDir); !isUntrusted(err) {
		t.Fatalf("file in a world-writable folder: %v", err)
	}
	// The sticky bit does not make a folder good enough for binaries.
	if err := os.Chmod(filepath.Dir(inOpenDir), 0o777|os.ModeSticky); err != nil {
		t.Fatal(err)
	}
	if _, err := TrustedFile(inOpenDir); !isUntrusted(err) {
		t.Fatalf("file in /tmp-like folder: %v", err)
	}
	// ... but it is for a restore target's parent.
	if _, err := TrustedDir(filepath.Dir(inOpenDir), true); err != nil {
		t.Fatalf("sticky folder with allowSticky: %v", err)
	}

	// A trusted-looking link into an untrusted place is judged by its target.
	link := filepath.Join(base, "via-link")
	if err := os.Symlink(inOpenDir, link); err != nil {
		t.Fatal(err)
	}
	if _, err := TrustedFile(link); !isUntrusted(err) {
		t.Fatalf("link into an open folder: %v", err)
	}

	if os.Geteuid() == 0 {
		foreign := filepath.Join(base, "foreign", "restic")
		write(t, foreign, 0o755)
		if err := os.Chown(foreign, 65534, 65534); err != nil {
			t.Fatal(err)
		}
		if _, err := TrustedFile(foreign); !isUntrusted(err) {
			t.Fatalf("file owned by nobody: %v", err)
		}
		if err := os.Chown(foreign, 0, 0); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(filepath.Dir(foreign), 65534, 65534); err != nil {
			t.Fatal(err)
		}
		if _, err := TrustedFile(foreign); !isUntrusted(err) {
			t.Fatalf("root file in a folder owned by nobody: %v", err)
		}
	}
	if _, err := TrustedFile("relative/restic"); !isUntrusted(err) {
		t.Fatalf("relative path: %v", err)
	}
}

func TestEnsureRootDirCreatesAndRefusesPreparedFolders(t *testing.T) {
	base := trustedBase(t)
	dir := filepath.Join(base, "opt", "restow-agent", "bin")
	got, err := EnsureRootDir(dir)
	if err != nil || got != dir {
		t.Fatalf("%q %v", got, err)
	}
	for _, d := range []string{filepath.Join(base, "opt"), filepath.Join(base, "opt", "restow-agent"), dir} {
		if st, _ := os.Stat(d); st.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode %v", d, st.Mode())
		}
	}
	// Idempotent.
	if _, err := EnsureRootDir(dir); err != nil {
		t.Fatal(err)
	}
	// An existing folder somebody else could write to is refused, not repaired.
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureRootDir(dir); !isUntrusted(err) {
		t.Fatalf("prepared folder: %v", err)
	}
	if _, err := EnsureRootDir(filepath.Join(dir, "sub")); !isUntrusted(err) {
		t.Fatalf("below a prepared folder: %v", err)
	}
}
