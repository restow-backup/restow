//go:build linux

package recovery

import (
	"io"
	"os"
	"syscall"
	"unsafe"
)

// echoOff turns the echo of a terminal off and returns the function that
// turns it back on; for input that is no terminal it does nothing.
func echoOff(in io.Reader) func() {
	f, ok := in.(*os.File)
	if !ok {
		return func() {}
	}
	fd := f.Fd()
	var old syscall.Termios
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCGETS, uintptr(unsafe.Pointer(&old))); e != 0 {
		return func() {}
	}
	t := old
	t.Lflag &^= syscall.ECHO
	t.Lflag |= syscall.ICANON | syscall.ECHONL
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCSETS, uintptr(unsafe.Pointer(&t))); e != 0 {
		return func() {}
	}
	return func() {
		_, _, _ = syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCSETS, uintptr(unsafe.Pointer(&old)))
	}
}
