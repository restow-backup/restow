//go:build windows

package winapi

import (
	"errors"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// Read-only access to HKEY_LOCAL_MACHINE (docs/BAREMETAL-WINDOWS.md 6.1):
// the functions of package syscall (RegOpenKeyEx, RegQueryValueEx,
// RegEnumKeyEx, RegQueryInfoKey, RegCloseKey) plus RegEnumValueW. There is
// deliberately no function here that writes to the registry.

var procRegEnumValueW = advapi32.NewProc("RegEnumValueW")

// keyWow64_64Key reads the 64-bit view whatever the agent is built for.
const keyWow64_64Key = 0x0100

// ErrRegistryType is returned when a value has another type than asked for.
var ErrRegistryType = errors.New("registry value has an unexpected type")

// RegKey is an open, read-only registry key.
type RegKey struct{ h syscall.Handle }

// OpenLocalMachineKey opens HKLM\path for reading.
func OpenLocalMachineKey(path string) (*RegKey, error) {
	p, err := utf16Ptr(path)
	if err != nil {
		return nil, err
	}
	var h syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, p, 0, syscall.KEY_READ|keyWow64_64Key, &h); err != nil {
		return nil, err
	}
	return &RegKey{h: h}, nil
}

// Close releases the key.
func (k *RegKey) Close() {
	if k != nil && k.h != 0 {
		_ = syscall.RegCloseKey(k.h)
		k.h = 0
	}
}

// maxRegValueBytes bounds what is read of one value (the agent reads short
// strings and numbers only).
const maxRegValueBytes = 64 << 10

func (k *RegKey) raw(name string) (uint32, []byte, error) {
	n, err := utf16Ptr(name)
	if err != nil {
		return 0, nil, err
	}
	var typ, size uint32
	if err := syscall.RegQueryValueEx(k.h, n, nil, &typ, nil, &size); err != nil {
		return 0, nil, err
	}
	if size > maxRegValueBytes {
		return 0, nil, syscall.ERROR_MORE_DATA
	}
	buf := make([]byte, size+2)
	size = uint32(len(buf))
	if err := syscall.RegQueryValueEx(k.h, n, nil, &typ, &buf[0], &size); err != nil {
		return 0, nil, err
	}
	return typ, buf[:size], nil
}

// String reads a REG_SZ or REG_EXPAND_SZ value (not expanded).
func (k *RegKey) String(name string) (string, error) {
	typ, b, err := k.raw(name)
	if err != nil {
		return "", err
	}
	if typ != syscall.REG_SZ && typ != syscall.REG_EXPAND_SZ {
		return "", ErrRegistryType
	}
	return utf16BytesToString(b), nil
}

// Integer reads a REG_DWORD or REG_QWORD value.
func (k *RegKey) Integer(name string) (uint64, error) {
	typ, b, err := k.raw(name)
	if err != nil {
		return 0, err
	}
	switch {
	case typ == syscall.REG_DWORD && len(b) >= 4:
		return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24, nil
	case typ == syscall.REG_QWORD && len(b) >= 8:
		var v uint64
		for i := 7; i >= 0; i-- {
			v = v<<8 | uint64(b[i])
		}
		return v, nil
	}
	return 0, ErrRegistryType
}

// maxRegEntries bounds the number of subkeys or values read from one key.
const maxRegEntries = 4096

// SubKeyNames lists the names of the subkeys.
func (k *RegKey) SubKeyNames() ([]string, error) {
	var count, maxLen uint32
	if err := syscall.RegQueryInfoKey(k.h, nil, nil, nil, &count, &maxLen, nil, nil, nil, nil, nil, nil); err != nil {
		return nil, err
	}
	count = min(count, maxRegEntries)
	names := make([]string, 0, count)
	buf := make([]uint16, maxLen+1)
	for i := uint32(0); i < count; i++ {
		n := uint32(len(buf))
		err := syscall.RegEnumKeyEx(k.h, i, &buf[0], &n, nil, nil, nil, nil)
		if errors.Is(err, syscall.Errno(ErrorNoMoreItems)) {
			break
		}
		if err != nil {
			return names, err
		}
		names = append(names, syscall.UTF16ToString(buf[:n]))
	}
	return names, nil
}

// ValueNames lists the names of the values (RegEnumValueW).
func (k *RegKey) ValueNames() ([]string, error) {
	var count, maxLen uint32
	if err := syscall.RegQueryInfoKey(k.h, nil, nil, nil, nil, nil, nil, &count, &maxLen, nil, nil, nil); err != nil {
		return nil, err
	}
	if err := procRegEnumValueW.Find(); err != nil {
		return nil, err
	}
	count = min(count, maxRegEntries)
	names := make([]string, 0, count)
	buf := make([]uint16, maxLen+1)
	for i := uint32(0); i < count; i++ {
		n := uint32(len(buf))
		r, _, _ := procRegEnumValueW.Call(uintptr(k.h), uintptr(i), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)), 0, 0, 0, 0)
		if r == ErrorNoMoreItems {
			break
		}
		if r != 0 {
			return names, syscall.Errno(r)
		}
		names = append(names, syscall.UTF16ToString(buf[:n]))
	}
	return names, nil
}

// utf16BytesToString decodes a little-endian UTF-16 value up to its first NUL.
func utf16BytesToString(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		c := uint16(b[i]) | uint16(b[i+1])<<8
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}
