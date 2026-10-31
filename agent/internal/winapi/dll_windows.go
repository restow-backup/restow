//go:build windows

package winapi

import (
	"errors"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

// kernel32.dll is a KnownDLL: Windows maps it from the system folder whatever
// the search path says, and the Go runtime has loaded it already. Everything
// else is loaded with its absolute path below the system folder.
var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procGetSystemDirectoryW = kernel32.NewProc("GetSystemDirectoryW")
)

var (
	sysDirOnce sync.Once
	sysDir     string
	errSysDir  error
)

// SystemDirectory returns the system folder (C:\Windows\System32), from
// GetSystemDirectoryW, not from the environment.
func SystemDirectory() (string, error) {
	sysDirOnce.Do(func() {
		buf := make([]uint16, 300)
		n, _, err := procGetSystemDirectoryW.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		if n == 0 || int(n) >= len(buf) {
			errSysDir = errors.New("GetSystemDirectoryW failed: " + err.Error())
			return
		}
		sysDir = syscall.UTF16ToString(buf[:n])
	})
	return sysDir, errSysDir
}

// systemDLL returns a lazily loaded DLL from the system folder. Should the
// system folder be unknown (never seen in practice), the name points nowhere
// and every call through it fails with an error instead of loading a DLL from
// the search path.
func systemDLL(name string) *syscall.LazyDLL {
	dir, err := SystemDirectory()
	if err != nil {
		return syscall.NewLazyDLL(`\\?\restow-no-system-directory\` + name)
	}
	return syscall.NewLazyDLL(filepath.Join(dir, name))
}

var (
	advapi32 = systemDLL("advapi32.dll")
	crypt32  = systemDLL("crypt32.dll")
	shell32  = systemDLL("shell32.dll")
	ole32    = systemDLL("ole32.dll")
)

// call invokes a procedure and turns a zero return value into the last error.
// A procedure that cannot be found is an error, not a panic.
//
// Callers pass pointers as uintptr(unsafe.Pointer(&x)) written inside the
// call expression. The uintptrescapes directive (the same one the standard
// library puts on LazyProc.Call) makes the compiler move such values to the
// heap and keep them alive until call returns. Without it they could stay on
// the goroutine stack as plain integers, and a stack copy (p.Find loading the
// DLL, SyscallN) would leave Windows writing into stale memory.
//
//go:uintptrescapes
func call(p *syscall.LazyProc, args ...uintptr) (uintptr, error) {
	if err := p.Find(); err != nil {
		return 0, err
	}
	r, _, err := p.Call(args...)
	if r == 0 {
		return r, lastError(err)
	}
	return r, nil
}

// callStatus invokes a procedure that returns a Win32 error code (0 = success).
// See call for the uintptrescapes directive.
//
//go:uintptrescapes
func callStatus(p *syscall.LazyProc, args ...uintptr) error {
	if err := p.Find(); err != nil {
		return err
	}
	r, _, _ := p.Call(args...)
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

func lastError(err error) error {
	var errno syscall.Errno
	if errors.As(err, &errno) && errno != 0 {
		return errno
	}
	return syscall.EINVAL
}

// IsErrno reports whether err is the Win32 error code code.
func IsErrno(err error, code uintptr) bool {
	var errno syscall.Errno
	return errors.As(err, &errno) && uintptr(errno) == code
}

// UTF16PtrToString reads a NUL-terminated UTF-16 string that Windows wrote.
func UTF16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0; n++ {
		ptr = unsafe.Add(ptr, 2)
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

// utf16Ptr converts s for a call; s must not contain NUL.
func utf16Ptr(s string) (*uint16, error) { return syscall.UTF16PtrFromString(s) }

// MultiSZ encodes strings as a REG_MULTI_SZ style list (each NUL-terminated,
// one more NUL at the end).
func MultiSZ(items []string) ([]uint16, error) {
	var out []uint16
	for _, s := range items {
		u, err := syscall.UTF16FromString(s)
		if err != nil {
			return nil, err
		}
		out = append(out, u...)
	}
	return append(out, 0), nil
}

// ParseMultiSZ decodes a REG_MULTI_SZ style list.
func ParseMultiSZ(p *uint16) []string {
	if p == nil {
		return nil
	}
	var out []string
	ptr := unsafe.Pointer(p)
	for {
		s := UTF16PtrToString((*uint16)(ptr))
		if s == "" {
			return out
		}
		out = append(out, s)
		ptr = unsafe.Add(ptr, 2*(len(syscall.StringToUTF16(s))))
	}
}
