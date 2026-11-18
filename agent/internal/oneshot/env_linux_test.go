//go:build linux

package oneshot

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/recovery"
)

func TestMemfdHoldsWhatWasWritten(t *testing.T) {
	if !kexecSupported {
		t.Skip("amd64 only")
	}
	data := bytes.Repeat([]byte("restow"), 100000)
	f, err := memfd("restow-test", func(w io.Writer) error { _, err := w.Write(data); return err })
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	// What kexec_file_load reads: the file from its start, through the fd.
	link, _ := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
	if !strings.HasPrefix(link, "/memfd:restow-test") {
		t.Errorf("the fd is %q, no memfd", link)
	}
	got, err := os.ReadFile(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("read back %d bytes, %v", len(got), err)
	}
	// Close-on-exec: no program the command starts inherits the initrd with the secrets.
	flags, err := fcntlGetfd(f.Fd())
	if err != nil || flags&1 == 0 {
		t.Errorf("FD_CLOEXEC not set (%d, %v)", flags, err)
	}
	// A failing fill closes the memfd and reports the error.
	if _, err := memfd("restow-test", func(io.Writer) error { return io.ErrUnexpectedEOF }); err != io.ErrUnexpectedEOF {
		t.Errorf("fill error: %v", err)
	}
}

func TestKexecFileLoadRefusesBadDescriptors(t *testing.T) {
	if !kexecSupported {
		t.Skip("amd64 only")
	}
	// No kernel is loaded with these: the call fails before it reads
	// anything (EBADF, or EPERM without CAP_SYS_BOOT).
	if err := KexecFileLoad(-1, -1, "console=ttyS0"); err == nil || !strings.Contains(err.Error(), "kexec_file_load") {
		t.Fatalf("err %v", err)
	}
}

func TestKexecFileLoadRefusesAnOversizedKernelAndOtherBlobs(t *testing.T) {
	if !kexecSupported {
		t.Skip("amd64 only")
	}
	defer func(n int64) { maxKernelBytes = n }(maxKernelBytes)
	maxKernelBytes = 10
	e := &LinuxEnv{}
	k, err := e.Memfd("k", func(w io.Writer) error { _, err := io.CopyN(w, zeroReader{}, 11); return err })
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	i, _ := e.Memfd("i", func(io.Writer) error { return nil })
	defer i.Close()
	if err := e.KexecFileLoad(k, i, "x"); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("err %v", err)
	}
	if err := e.KexecFileLoad(nopBlob{}, i, "x"); err == nil || !strings.Contains(err.Error(), "not a memfd") {
		t.Fatalf("err %v", err)
	}
}

type nopBlob struct{}

func (nopBlob) Close() error { return nil }

func TestKexecIsCancelledBeforeItStarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Nothing runs: neither systemctl nor the reboot call.
	e := &LinuxEnv{Runner: cmdrun.ExecRunner{Dirs: []string{t.TempDir()}}}
	if err := e.Kexec(ctx); err != ErrCancelled {
		t.Fatalf("err %v", err)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestISOFileWantsAPrivateFolder(t *testing.T) {
	base := t.TempDir()
	e := &LinuxEnv{Dir: filepath.Join(base, "work")}
	f, err := e.ISOFile()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("iso")); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 3)
	if _, err := f.ReadAt(b, 0); err != nil || string(b) != "iso" {
		t.Fatalf("%q %v", b, err)
	}
	f.Close()
	if fi, _ := os.Stat(e.Dir); fi.Mode().Perm() != 0o700 {
		t.Errorf("mode %o", fi.Mode().Perm())
	}
	e.Cleanup()
	if _, err := os.Stat(e.Dir); !os.IsNotExist(err) {
		t.Error("the folder is still there")
	}
	// A folder others can write to, or a link, is refused.
	open := filepath.Join(base, "open")
	if err := os.Mkdir(open, 0o777); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(open, 0o777)
	if _, err := (&LinuxEnv{Dir: open}).ISOFile(); err == nil {
		t.Error("a folder of mode 0777 accepted")
	}
	link := filepath.Join(base, "link")
	_ = os.Symlink(t.TempDir(), link)
	if _, err := (&LinuxEnv{Dir: link}).ISOFile(); err == nil {
		t.Error("a link accepted")
	}
}

func TestOutputKeepsStdoutOfAFailingProgram(t *testing.T) {
	e := &LinuxEnv{Runner: cmdrun.ExecRunner{Dirs: []string{"/usr/bin", "/bin"}}}
	out, err := e.Output(context.Background(), "sh", "-c", "echo active; echo inactive; echo oops >&2; exit 3")
	if err == nil || string(out) != "active\ninactive\n" {
		t.Errorf("%q %v", out, err)
	}
	if _, err := e.Output(context.Background(), "no-such-tool-here"); err == nil {
		t.Error("a missing tool ran")
	}
	if _, err := e.Output(context.Background(), "/bin/sh", "-c", "true"); err == nil {
		t.Error("a path ran")
	}
}

// fcntlGetfd reads the descriptor flags .
func fcntlGetfd(fd uintptr) (int, error) {
	r, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(r), nil
}

func TestWriteSessionDataForTheDirectMode(t *testing.T) {
	base := t.TempDir()
	e := &LinuxEnv{DataDir: filepath.Join(base, "restow-oneshot")}
	p, err := e.WriteSessionData([]byte(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	di, _ := os.Stat(e.DataDir)
	if fi.Mode().Perm() != 0o600 || di.Mode().Perm() != 0o700 {
		t.Errorf("modes %o %o", fi.Mode().Perm(), di.Mode().Perm())
	}
	if os.Geteuid() == 0 {
		// recover reads it with its own checks.
		if b, err := recovery.ReadOneshotFile(p); err != nil || string(b) != `{"x":1}` {
			t.Errorf("recover reads %q, %v", b, err)
		}
	}
	// Written again: a fresh file in place of the old one.
	if _, err := e.WriteSessionData([]byte(`{"x":2}`)); err != nil {
		t.Fatal(err)
	}
	e.RemoveSessionData(p)
	if _, err := os.Stat(e.DataDir); !os.IsNotExist(err) {
		t.Error("the folder is still there")
	}
	// A folder others can read is refused.
	open := filepath.Join(base, "open")
	_ = os.Mkdir(open, 0o755)
	_ = os.Chmod(open, 0o755)
	if _, err := (&LinuxEnv{DataDir: open}).WriteSessionData([]byte("{}")); err == nil {
		t.Error("a folder of mode 0755 accepted")
	}
}
