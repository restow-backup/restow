package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/restow-backup/restow/agent/internal/logging"
)

func TestRemoveLegacyAndCommandLink(t *testing.T) {
	root := t.TempDir()
	old := legacyFiles{
		agent:  filepath.Join(root, "usr/local/bin/restow-agent"),
		restic: filepath.Join(root, "usr/local/lib/restow-agent/restic"),
		libDir: filepath.Join(root, "usr/local/lib/restow-agent"),
		link:   filepath.Join(root, "usr/local/bin/restow-agent"),
	}
	for _, f := range []string{old.agent, old.agent + ".prev", old.restic, filepath.Join(filepath.Dir(old.agent), ".restow-agent.new")} {
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		_ = os.WriteFile(f, []byte("x"), 0o755)
	}
	logger := logging.Discard()
	removeLegacy(logger, old)
	for _, p := range []string{old.agent, old.agent + ".prev", old.restic, old.libDir} {
		if _, err := os.Lstat(p); err == nil {
			t.Errorf("%s survived", p)
		}
	}
	// The convenience link is created only in a folder that is root's alone
	// (here a folder above it is world-writable)...
	installed := filepath.Join(root, "opt/restow-agent/bin/restow-agent")
	open := filepath.Join(root, "usr/local")
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	ensureCommandLink(logger, installed, old.link)
	if _, err := os.Lstat(old.link); err == nil {
		t.Fatal("a link was created in a folder below a world-writable one")
	}
	_ = os.Chmod(open, 0o755)
	// ... and a link (what the move leaves at the pre-release agent path) is never removed as a legacy file.
	_ = os.Symlink(installed, old.link)
	removeLegacy(logger, old)
	if fi, err := os.Lstat(old.link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the command link was removed")
	}
}
