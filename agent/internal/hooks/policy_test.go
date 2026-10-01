//go:build unix

package hooks

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

func TestModes(t *testing.T) {
	for in, want := range map[string]string{"": ModeOff, "off": ModeOff, "garbage": ModeOff, "scripts": ModeScripts, "any": ModeAny} {
		if got := NormalizeMode(in); got != want {
			t.Errorf("NormalizeMode(%q) = %q", in, got)
		}
	}
	for in, want := range map[string]string{"off": ModeOff, "deny": ModeOff, "SCRIPTS": ModeScripts, "any": ModeAny, "allow": ModeAny} {
		if got, err := ParseMode(in); err != nil || got != want {
			t.Errorf("ParseMode(%q) = %q %v", in, got, err)
		}
	}
	if _, err := ParseMode("everything"); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

func TestOffRefusesEveryHook(t *testing.T) {
	_, err := Resolve(ModeOff, "/etc/restow-agent/hooks.d", "pg_dump -U postgres > /srv/dump.sql")
	if !errors.Is(err, ErrNotAllowed) || !strings.Contains(err.Error(), "restow-agent hooks") {
		t.Fatalf("%v", err)
	}
	if _, err := Resolve("", "/x", "true"); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("an unset mode must be off: %v", err)
	}
}

func TestAnyRunsThroughTheShell(t *testing.T) {
	argv, err := Resolve(ModeAny, "/x", " echo hi ")
	if err != nil || strings.Join(argv, "|") != "/bin/sh|-c|echo hi" {
		t.Fatalf("%v %v", argv, err)
	}
}

// hooksDir returns a hooks folder in a chain no other user can change.
func hooksDir(t *testing.T) string {
	t.Helper()
	parent := "/root"
	if os.Geteuid() != 0 {
		wd, _ := os.Getwd()
		if _, err := paths.TrustedDir(wd, false); err != nil {
			t.Skipf("no trusted folder: %v", err)
		}
		parent = wd
	}
	dir, err := os.MkdirTemp(parent, "hooks.d-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	_ = os.Chmod(dir, 0o700)
	return dir
}

func TestScriptsModeRunsOnlyTrustedNamedScripts(t *testing.T) {
	dir := hooksDir(t)
	script := filepath.Join(dir, "db-dump")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"dump for $RESTOW_HOOK\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	argv, err := Resolve(ModeScripts, dir, "db-dump")
	if err != nil || len(argv) != 1 || argv[0] != script {
		t.Fatalf("%v %v", argv, err)
	}
	var c collector
	if _, err := Run(context.Background(), Options{Kind: Pre, Argv: argv, Timeout: 10 * time.Second, Env: []string{"RESTOW_HOOK=pre"}, Output: c.add}); err != nil {
		t.Fatal(err)
	}
	if c.joined() != "dump for pre" {
		t.Fatalf("output: %s", c.joined())
	}

	for _, bad := range []string{"db-dump; rm -rf /", "../db-dump", "/etc/restow-agent/hooks.d/db-dump", "missing", ".", "", "a b"} {
		if _, err := Resolve(ModeScripts, dir, bad); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	// Not executable, or writable by others: refused.
	plain := filepath.Join(dir, "plain")
	_ = os.WriteFile(plain, []byte("#!/bin/sh\n"), 0o600)
	if _, err := Resolve(ModeScripts, dir, "plain"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("not executable: %v", err)
	}
	open := filepath.Join(dir, "open")
	_ = os.WriteFile(open, []byte("#!/bin/sh\n"), 0o777)
	_ = os.Chmod(open, 0o777)
	if _, err := Resolve(ModeScripts, dir, "open"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("world-writable: %v", err)
	}
	// A link to a script elsewhere is refused: the entry itself must be a regular file.
	if err := os.Symlink(script, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(ModeScripts, dir, "link"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("link: %v", err)
	}
	if got := strings.Join(ListScripts(dir), ","); got != "db-dump" {
		t.Fatalf("ListScripts = %s", got)
	}
	if ListScripts(filepath.Join(dir, "nope")) != nil {
		t.Fatal("missing folder lists nothing")
	}
}
