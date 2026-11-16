//go:build windows

package winapi

import (
	"errors"
	"syscall"
	"unsafe"
)

var (
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")

	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
)

// dataBlob is DATA_BLOB.
type dataBlob struct {
	Size uint32
	Data *byte
}

func blobOf(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func (d dataBlob) bytes() []byte {
	if d.Data == nil || d.Size == 0 {
		return nil
	}
	return append([]byte(nil), unsafe.Slice(d.Data, d.Size)...)
}

// ProtectMachine encrypts data with DPAPI for this machine
// (CRYPTPROTECT_LOCAL_MACHINE: any process on this computer can decrypt it;
// the protection is the folder's DACL, docs/WINDOWS-AGENT.md, section 7)
// (https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).
func ProtectMachine(data []byte, description string) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("nothing to protect")
	}
	desc, err := utf16Ptr(description)
	if err != nil {
		return nil, err
	}
	in := blobOf(data)
	var out dataBlob
	if _, err := call(procCryptProtectData, uintptr(unsafe.Pointer(&in)), uintptr(unsafe.Pointer(desc)), 0, 0, 0,
		CryptprotectLocalMachine|CryptprotectUIForbidden, uintptr(unsafe.Pointer(&out))); err != nil {
		return nil, err
	}
	defer localFree(unsafe.Pointer(out.Data))
	return out.bytes(), nil
}

// UnprotectMachine decrypts a DPAPI blob
// (https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata).
func UnprotectMachine(blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, errors.New("empty DPAPI blob")
	}
	in := blobOf(blob)
	var out dataBlob
	if _, err := call(procCryptUnprotectData, uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		CryptprotectUIForbidden, uintptr(unsafe.Pointer(&out))); err != nil {
		return nil, err
	}
	defer localFree(unsafe.Pointer(out.Data))
	return out.bytes(), nil
}

// Known folders (KnownFolders.h).
var (
	FolderIDProgramFiles = syscall.GUID{Data1: 0x905e63b6, Data2: 0xc1bf, Data3: 0x494e, Data4: [8]byte{0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a}}
	FolderIDProgramData  = syscall.GUID{Data1: 0x62ab5d82, Data2: 0xfdc1, Data3: 0x4dc3, Data4: [8]byte{0xa9, 0xdd, 0x07, 0x0d, 0x1d, 0x49, 0x5d, 0x97}}
	FolderIDWindows      = syscall.GUID{Data1: 0xf38bf404, Data2: 0x1d43, Data3: 0x42f2, Data4: [8]byte{0x93, 0x05, 0x67, 0xde, 0x0b, 0x28, 0xfc, 0x23}}
	// FolderIDProgramFilesX86 is FOLDERID_ProgramFilesX86.
	FolderIDProgramFilesX86 = syscall.GUID{Data1: 0x7c5a40ef, Data2: 0xa0fb, Data3: 0x4bfc, Data4: [8]byte{0x87, 0x4a, 0xc0, 0xf2, 0xe0, 0xb9, 0xfa, 0x8e}}
)

// KnownFolderPath returns the path of a known folder for the machine
// (https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath).
func KnownFolderPath(id *syscall.GUID) (string, error) {
	if err := procSHGetKnownFolderPath.Find(); err != nil {
		return "", err
	}
	var p *uint16
	r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(id)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if p != nil {
		defer func() {
			if procCoTaskMemFree.Find() == nil {
				_, _, _ = procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
			}
		}()
	}
	if r != 0 {
		return "", syscall.Errno(r & 0xFFFF)
	}
	return UTF16PtrToString(p), nil
}
