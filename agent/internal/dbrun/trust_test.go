//go:build unix

package dbrun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// fakeTools writes pg_dump, pg_dumpall and pg_restore into dir; running any
// of them (even for --version) leaves a mark.
func fakeTools(t *testing.T, dir string) string {
	t.Helper()
	mark := filepath.Join(dir, "ran")
	script := "#!/bin/sh\ntouch '" + mark + "'\necho 'pg_dump (PostgreSQL) 99.0'\n"
	for _, tool := range []string{"pg_dump", "pg_dumpall", "pg_restore"} {
		if err := os.WriteFile(filepath.Join(dir, tool), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return mark
}

// trustedBase is a folder whose whole chain only root (or this user) can
// change, for tools the check must accept; skipped where there is none.
func trustedBase(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home folder")
	}
	if _, err := paths.TrustedDir(home, false); err != nil {
		t.Skipf("the home folder is not a trusted chain: %v", err)
	}
	dir, err := os.MkdirTemp(home, ".restow-trust-test-")
	if err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// claim: DB-002
func TestToolsOthersCanChangeNeverRun(t *testing.T) {
	// Below the temporary folder (writable by everyone): refused, not even
	// asked for its version.
	tmp := t.TempDir()
	mark := fakeTools(t, tmp)
	_, err := ChooseTools(context.Background(), 16, []string{tmp})
	var te *ToolError
	if !errors.As(err, &te) || te.Code != "db_tool_missing" || !strings.Contains(te.Message, "not safe to run") {
		t.Fatalf("tools below /tmp: %v", err)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("an untrusted pg_dump ran")
	}

	base := trustedBase(t)
	bin := filepath.Join(base, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	mark = fakeTools(t, bin)
	// A folder group or others can write.
	if err := os.Chmod(bin, 0o775); err != nil {
		t.Fatal(err)
	}
	if _, err := ChooseTools(context.Background(), 16, []string{bin}); !errors.As(err, &te) || !strings.Contains(te.Message, "writable by group or others") {
		t.Fatalf("group-writable folder: %v", err)
	}
	// A program others can write.
	if err := os.Chmod(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(bin, "pg_restore"), 0o757); err != nil {
		t.Fatal(err)
	}
	if _, err := ChooseTools(context.Background(), 16, []string{bin}); err == nil {
		t.Fatal("a world-writable pg_restore was accepted")
	}
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("an untrusted pg_dump ran")
	}
	if err := os.Chmod(filepath.Join(bin, "pg_restore"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A program of another user (root only can hand it over).
	if os.Geteuid() == 0 {
		if err := os.Chown(filepath.Join(bin, "pg_dump"), 65534, 65534); err != nil {
			t.Fatal(err)
		}
		if _, err := ChooseTools(context.Background(), 16, []string{bin}); !errors.As(err, &te) || !strings.Contains(te.Message, "uid 65534") {
			t.Fatalf("foreign owner: %v", err)
		}
		if err := os.Chown(filepath.Join(bin, "pg_dump"), 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	// Owned by root and closed: chosen.
	tools, err := ChooseTools(context.Background(), 16, []string{bin})
	if err != nil || tools.Major != 99 || tools.Dir != bin {
		t.Fatalf("trusted tools: %+v %v", tools, err)
	}
}

// claim: DB-008
func TestLiteralsAndNamesHoldUnderEitherStringSetting(t *testing.T) {
	if got := QuoteLiteral(`a\'b`); got != `E'a\\''b'` {
		t.Fatalf("literal %s", got)
	}
	if !ValidName(`a\'b`) || ValidName("a\nb") || ValidName("a\x7fb") || ValidName(" a") {
		t.Fatal("names")
	}
}

// claim: DB-003
func TestStaleRunFoldersAreSwept(t *testing.T) {
	base := t.TempDir()
	old := time.Now().Add(-48 * time.Hour)
	for _, name := range []string{"restow-db-run-a", "restow-pg-relay-b", "restow-db-young", "other"} {
		if err := os.Mkdir(filepath.Join(base, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "restow-db-file"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"restow-db-run-a", "restow-pg-relay-b", "other", "restow-db-file"} {
		if err := os.Chtimes(filepath.Join(base, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	if n := SweepStale(base, 25*time.Hour, time.Now()); n != 2 {
		t.Fatalf("removed %d", n)
	}
	for name, want := range map[string]bool{"restow-db-run-a": false, "restow-pg-relay-b": false, "restow-db-young": true, "other": true, "restow-db-file": true} {
		if _, err := os.Stat(filepath.Join(base, name)); (err == nil) != want {
			t.Fatalf("%s: present %v", name, err == nil)
		}
	}
}
