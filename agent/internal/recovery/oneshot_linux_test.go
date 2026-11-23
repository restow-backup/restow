//go:build linux

package recovery

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadOneshotFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "restow-oneshot")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "oneshot.json")
	if err := os.WriteFile(p, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := ReadOneshotFile(p)
	if os.Geteuid() == 0 {
		if err != nil {
			t.Fatalf("as root: %v", err)
		}
	} else if err == nil || !strings.Contains(err.Error(), "not owned by root") {
		t.Fatalf("not root: %v", err)
	}
	if os.Geteuid() != 0 {
		t.Skip("the remaining cases need root (the owner check comes first)")
	}
	refuse := func(name string) {
		t.Helper()
		if _, err := ReadOneshotFile(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	os.Chmod(p, 0o644)
	refuse("mode 0644")
	os.Chmod(p, 0o600)
	os.Chmod(dir, 0o755)
	refuse("folder 0755")
	os.Chmod(dir, 0o700)
	os.Rename(p, p+".real")
	os.Symlink(p+".real", p)
	refuse("symlink")
	os.Remove(p)
	os.WriteFile(p, make([]byte, MaxOneshotBytes+1), 0o600)
	refuse("too large")
	os.Remove(p)
	os.Mkdir(p, 0o600)
	refuse("a folder")
}

// Started without a medium, /run/live/medium is a folder of the initramfs:
// no disk is the start medium.
func TestLiveMediumOfAOneshotStart(t *testing.T) {
	for src, want := range map[string]string{
		"rootfs[/restow/medium]\n": "",
		"none\n":                   "",
		"":                         "",
	} {
		fx := newFakeExec()
		fx.output = func(argv []string) (string, bool) {
			return src, argv[0] == "findmnt"
		}
		h := &HardwareCollector{Exec: fx, SysRoot: t.TempDir()}
		if got := h.liveMedium(context.Background()); got != want {
			t.Errorf("%q: %q, want %q", src, got, want)
		}
	}
	fx := newFakeExec()
	fx.output = func(argv []string) (string, bool) { return "/dev/sr0\n", argv[0] == "findmnt" }
	h := &HardwareCollector{Exec: fx, SysRoot: t.TempDir()}
	if got := h.liveMedium(context.Background()); got != "sr0" {
		t.Errorf("an ISO start: %q", got)
	}
}

func TestWritingMarkBesideTheSessionData(t *testing.T) {
	dir := t.TempDir()
	e := &LinuxEnv{OneshotFile: filepath.Join(dir, "oneshot.json")}
	if e.WritingStarted() {
		t.Fatal("marked before")
	}
	if err := e.MarkWriting(); err != nil {
		t.Fatal(err)
	}
	st, err := os.Lstat(filepath.Join(dir, "writing"))
	if err != nil || st.Mode().Perm() != 0o600 || !e.WritingStarted() {
		t.Fatalf("%v %v", st, err)
	}
	// Marking again (a restart) is no error.
	if err := e.MarkWriting(); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(e.OneshotFile, []byte("{}"), 0o600)
	if err := e.ForgetOneshot(); err != nil || e.WritingStarted() {
		t.Fatalf("forget: %v", err)
	}
	// A link in its place is refused, and does not count.
	_ = os.Symlink("/etc/passwd", filepath.Join(dir, "writing"))
	if e.WritingStarted() || e.MarkWriting() == nil {
		t.Error("a link counts as the mark")
	}
	if (&LinuxEnv{}).MarkWriting() == nil {
		t.Error("a mark without session data")
	}
}
