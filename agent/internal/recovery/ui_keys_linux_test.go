//go:build linux

package recovery

import (
	"context"
	"fmt"
	"os"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// openPTY opens a pseudo terminal: what is written to the master is
// typed at the slave.
func openPTY(t *testing.T) (master, slave *os.File) {
	t.Helper()
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("no pseudo terminals here: %v", err)
	}
	t.Cleanup(func() { m.Close() })
	var unlock, n int32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, m.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); e != 0 {
		t.Skipf("unlock the pseudo terminal: %v", e)
	}
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, m.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); e != 0 {
		t.Skipf("number of the pseudo terminal: %v", e)
	}
	s, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("open the pseudo terminal: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return m, s
}

func termios(t *testing.T, f *os.File) syscall.Termios {
	t.Helper()
	var tio syscall.Termios
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TCGETS, uintptr(unsafe.Pointer(&tio))); e != 0 {
		t.Fatalf("TCGETS: %v", e)
	}
	return tio
}

// TestUIAnyKeyOnTerminal: on a terminal in line mode a key without Enter
// reaches nobody, so the countdown takes the terminal out of line mode
// for its wait: one key ends it, Ctrl+C is such a key, and the settings
// are back afterwards. The reader of the console already waits in line
// mode when the countdown begins (a dialog came before).
func TestUIAnyKeyOnTerminal(t *testing.T) {
	for name, key := range map[string][]byte{"space": {' '}, "ctrl-c": {3}, "escape": {0x1b}} {
		master, slave := openPTY(t)
		before := termios(t, slave)
		if before.Lflag&syscall.ICANON == 0 || before.Lflag&syscall.ISIG == 0 {
			t.Fatalf("fixture: the terminal is not in line mode: %#x", before.Lflag)
		}
		ui := &UI{In: slave, Out: &syncWriter{}, Lang: LangEN}
		// A dialog before the countdown: the reader blocks in a line read.
		go func() { _, _ = master.Write([]byte("code\n")) }()
		if l, err := ui.ReadLine(); err != nil || l != "code" {
			t.Fatalf("%s: line %q %v", name, l, err)
		}
		time.Sleep(50 * time.Millisecond)
		during := make(chan syscall.Termios, 1)
		go func() {
			time.Sleep(150 * time.Millisecond)
			during <- termios(t, slave)
			_, _ = master.Write(key)
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		start := time.Now()
		pressed := ui.AnyKey(ctx)
		cancel()
		if !pressed || time.Since(start) > 10*time.Second {
			t.Errorf("%s: pressed %v after %s", name, pressed, time.Since(start))
		}
		d := <-during
		if d.Lflag&(syscall.ICANON|syscall.ECHO|syscall.ISIG) != 0 || d.Cc[syscall.VMIN] != 1 || d.Cc[syscall.VTIME] != 0 {
			t.Errorf("%s: during the wait the terminal is in line mode: lflag %#x, min %d", name, d.Lflag, d.Cc[syscall.VMIN])
		}
		if after := termios(t, slave); after != before {
			t.Errorf("%s: the settings of the terminal were not restored:\n%+v\n%+v", name, before, after)
		}
		// The next dialog reads a line again; the key is not part of it.
		go func() { _, _ = master.Write([]byte("next\n")) }()
		if l, err := ui.ReadLine(); err != nil || l != "next" {
			t.Errorf("%s: the line after the wait: %q %v", name, l, err)
		}
	}
	// No key: the wait ends with its time, the settings are back.
	_, slave := openPTY(t)
	before := termios(t, slave)
	ui := &UI{In: slave, Out: &syncWriter{}, Lang: LangEN}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if ui.AnyKey(ctx) {
		t.Error("a key press on a silent terminal")
	}
	if after := termios(t, slave); after != before {
		t.Error("the settings were not restored after the time ran out")
	}
}
