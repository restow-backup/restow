//go:build linux

package dbprobe

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

func TestSQLiteRefusesALinkedDirectoryInThePath(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 4096)
	copy(header, sqliteMagic)
	binary.BigEndian.PutUint16(header[16:18], 4096)
	if err := os.WriteFile(filepath.Join(target, "app.db"), header, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "link")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	direct := filepath.Join(target, "app.db")
	if r := Run(context.Background(), api.DBProbeSpec{Path: &direct, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast); r.Error != nil || r.SQLite == nil {
		t.Fatalf("direct path: %+v", r.Error)
	}
	linked := filepath.Join(dir, "link", "app.db")
	r := Run(context.Background(), api.DBProbeSpec{Path: &linked, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast)
	if code(r) != CodeNotADatabase || r.SQLite != nil {
		t.Fatalf("linked directory: %+v %+v", r.Error, r.SQLite)
	}
	// The check without openat2 says the same.
	if _, err := openWithoutLinks(linked); !errors.Is(err, errNotRegular) {
		t.Fatalf("fallback: %v", err)
	}
	f, err := openWithoutLinks(direct)
	if err != nil {
		t.Fatalf("fallback, direct path: %v", err)
	}
	_ = f.Close()
}
