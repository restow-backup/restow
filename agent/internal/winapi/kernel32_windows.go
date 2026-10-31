//go:build windows

package winapi

import (
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var (
	procLockFileEx                 = kernel32.NewProc("LockFileEx")
	procUnlockFileEx               = kernel32.NewProc("UnlockFileEx")
	procGetSystemPowerStatus       = kernel32.NewProc("GetSystemPowerStatus")
	procCreateJobObjectW           = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject    = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject   = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject         = kernel32.NewProc("TerminateJobObject")
	procGenerateConsoleCtrlEvent   = kernel32.NewProc("GenerateConsoleCtrlEvent")
	procAllocConsole               = kernel32.NewProc("AllocConsole")
	procGetConsoleProcessList      = kernel32.NewProc("GetConsoleProcessList")
	procMoveFileExW                = kernel32.NewProc("MoveFileExW")
	procSetFileInformationByHandle = kernel32.NewProc("SetFileInformationByHandle")
	procGetFinalPathNameByHandleW  = kernel32.NewProc("GetFinalPathNameByHandleW")
	procGetVolumePathNameW         = kernel32.NewProc("GetVolumePathNameW")
	procGetDriveTypeW              = kernel32.NewProc("GetDriveTypeW")
	procGetVolumeInformationW      = kernel32.NewProc("GetVolumeInformationW")
	procLocalFree                  = kernel32.NewProc("LocalFree")
)

// LockFileEx locks a byte range of an open file
// (https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-lockfileex).
func LockFileEx(h syscall.Handle, flags, lowLen, highLen uint32, ol *syscall.Overlapped) error {
	_, err := call(procLockFileEx, uintptr(h), uintptr(flags), 0, uintptr(lowLen), uintptr(highLen), uintptr(unsafe.Pointer(ol)))
	return err
}

// UnlockFileEx releases a range locked with LockFileEx
// (https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-unlockfileex).
func UnlockFileEx(h syscall.Handle, lowLen, highLen uint32, ol *syscall.Overlapped) error {
	_, err := call(procUnlockFileEx, uintptr(h), 0, uintptr(lowLen), uintptr(highLen), uintptr(unsafe.Pointer(ol)))
	return err
}

// SystemPowerStatus is SYSTEM_POWER_STATUS
// (https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-system_power_status).
type SystemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

// GetSystemPowerStatus fills s
// (https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-getsystempowerstatus).
func GetSystemPowerStatus(s *SystemPowerStatus) error {
	_, err := call(procGetSystemPowerStatus, uintptr(unsafe.Pointer(s)))
	return err
}

// JobObjectBasicLimitInformation is JOBOBJECT_BASIC_LIMIT_INFORMATION.
type JobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

// IOCounters is IO_COUNTERS.
type IOCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

// JobObjectExtendedLimitInformation is JOBOBJECT_EXTENDED_LIMIT_INFORMATION
// (https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).
type JobObjectExtendedLimitInformation struct {
	BasicLimitInformation JobObjectBasicLimitInformation
	IoInfo                IOCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// CreateJobObject creates an unnamed job object
// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw).
func CreateJobObject() (syscall.Handle, error) {
	r, err := call(procCreateJobObjectW, 0, 0)
	return syscall.Handle(r), err
}

// SetJobLimits sets the extended limit information of a job
// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject).
func SetJobLimits(job syscall.Handle, info *JobObjectExtendedLimitInformation) error {
	_, err := call(procSetInformationJobObject, uintptr(job), JobObjectExtendedLimitInformationClass,
		uintptr(unsafe.Pointer(info)), unsafe.Sizeof(*info))
	return err
}

// AssignProcessToJobObject puts a process into a job
// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).
func AssignProcessToJobObject(job, process syscall.Handle) error {
	_, err := call(procAssignProcessToJobObject, uintptr(job), uintptr(process))
	return err
}

// TerminateJobObject ends every process in a job
// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject).
func TerminateJobObject(job syscall.Handle, exitCode uint32) error {
	_, err := call(procTerminateJobObject, uintptr(job), uintptr(exitCode))
	return err
}

// GenerateConsoleCtrlEvent sends CTRL_C or CTRL_BREAK to a process group of
// the caller's console
// (https://learn.microsoft.com/windows/console/generateconsolectrlevent).
func GenerateConsoleCtrlEvent(event, processGroupID uint32) error {
	_, err := call(procGenerateConsoleCtrlEvent, uintptr(event), uintptr(processGroupID))
	return err
}

// AllocConsole gives the process a console (https://learn.microsoft.com/windows/console/allocconsole).
func AllocConsole() error {
	_, err := call(procAllocConsole)
	return err
}

// ConsoleProcessCount returns how many processes share the caller's console
// (https://learn.microsoft.com/windows/console/getconsoleprocesslist); 0
// means there is no console.
func ConsoleProcessCount() (uint32, error) {
	var ids [16]uint32
	r, err := call(procGetConsoleProcessList, uintptr(unsafe.Pointer(&ids[0])), uintptr(len(ids)))
	return uint32(r), err
}

// MoveFileEx renames or deletes (to == "" with MoveFileDelayUntilReboot) a file
// (https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw).
func MoveFileEx(from, to string, flags uint32) error {
	f, err := utf16Ptr(from)
	if err != nil {
		return err
	}
	var t *uint16
	if to != "" {
		if t, err = utf16Ptr(to); err != nil {
			return err
		}
	}
	_, err = call(procMoveFileExW, uintptr(unsafe.Pointer(f)), uintptr(unsafe.Pointer(t)), uintptr(flags))
	return err
}

// RenameReplacing moves from over to with POSIX semantics
// (SetFileInformationByHandle, FileRenameInfoEx, FILE_RENAME_FLAG_REPLACE_IF_EXISTS |
// FILE_RENAME_FLAG_POSIX_SEMANTICS): the target is replaced even while another process
// has it open with FILE_SHARE_DELETE, which MoveFileExW refuses with "access denied".
// Older Windows and file systems without it answer ERROR_INVALID_PARAMETER or
// ERROR_NOT_SUPPORTED; the caller then falls back to MoveFileEx
// (https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info).
func RenameReplacing(from, to string) error {
	src, err := utf16Ptr(from)
	if err != nil {
		return err
	}
	target, err := verbatimPath(to)
	if err != nil {
		return err
	}
	name, err := syscall.UTF16FromString(target)
	if err != nil {
		return err
	}
	// The link itself, not what it points to, like MoveFileExW.
	h, err := syscall.CreateFile(src, fileAccessDelete|fileAccessSynchronize, fileShareAll, nil,
		openExisting, fileFlagBackupSemantics|fileFlagOpenReparsePoint, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)

	// FILE_RENAME_INFO on 64-bit Windows: Flags (4 bytes, padded to 8), RootDirectory
	// (8), FileNameLength (4, bytes without the NUL), FileName from offset 20. Backed by
	// uint64s so the structure is 8-byte aligned.
	const nameOffset = 20
	nameBytes := (len(name) - 1) * 2
	size := nameOffset + len(name)*2
	words := make([]uint64, (size+7)/8)
	info := unsafe.Pointer(&words[0])
	*(*uint32)(info) = fileRenameFlagReplaceIfExists | fileRenameFlagPosixSemantics
	*(*uint32)(unsafe.Add(info, 16)) = uint32(nameBytes)
	copy(unsafe.Slice((*uint16)(unsafe.Add(info, nameOffset)), len(name)), name)
	_, err = call(procSetFileInformationByHandle, uintptr(h), fileRenameInfoEx, uintptr(info), uintptr(len(words)*8))
	runtime.KeepAlive(words)
	return err
}

// verbatimPath turns a path into the absolute \\?\ form the rename information takes.
func verbatimPath(p string) (string, error) {
	if strings.HasPrefix(p, `\\?\`) {
		return p, nil
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(abs, `\\`) {
		return `\\?\UNC\` + abs[2:], nil
	}
	return `\\?\` + abs, nil
}

// FinalPathName resolves an open handle to its final DOS path
// (https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew).
func FinalPathName(h syscall.Handle) (string, error) {
	buf := make([]uint16, 512)
	for {
		r, err := call(procGetFinalPathNameByHandleW, uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), FinalPathFlags)
		if err != nil {
			return "", err
		}
		if int(r) < len(buf) {
			return syscall.UTF16ToString(buf[:r]), nil
		}
		buf = make([]uint16, r+1)
	}
}

// VolumePathName returns the mount point of the volume a path is on
// (https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getvolumepathnamew).
func VolumePathName(path string) (string, error) {
	p, err := utf16Ptr(path)
	if err != nil {
		return "", err
	}
	buf := make([]uint16, 512)
	if _, err := call(procGetVolumePathNameW, uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))); err != nil {
		return "", err
	}
	return syscall.UTF16ToString(buf), nil
}

// DriveType returns the type of the drive with the given root (C:\)
// (https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getdrivetypew).
func DriveType(root string) uint32 {
	p, err := utf16Ptr(root)
	if err != nil || procGetDriveTypeW.Find() != nil {
		return 0
	}
	r, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(p)))
	return uint32(r)
}

// VolumeInformation returns the file system name and flags of a volume root
// (https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationw).
func VolumeInformation(root string) (fsName string, flags uint32, err error) {
	p, err := utf16Ptr(root)
	if err != nil {
		return "", 0, err
	}
	name := make([]uint16, 64)
	_, err = call(procGetVolumeInformationW, uintptr(unsafe.Pointer(p)), 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&flags)), uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
	if err != nil {
		return "", 0, err
	}
	return syscall.UTF16ToString(name), flags, nil
}

// localFree releases memory Windows allocated with LocalAlloc.
func localFree(p unsafe.Pointer) {
	if p != nil {
		_, _, _ = procLocalFree.Call(uintptr(p))
	}
}

// OpenNoFollow opens path for reading its attributes and security
// information without following a final reparse point (symbolic link,
// junction, mount point). Folders open too (backup semantics).
func OpenNoFollow(path string) (syscall.Handle, error) {
	p, err := utf16Ptr(path)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	return syscall.CreateFile(p, ReadControl|FileReadAttributes,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// CreateDirectorySDDL creates a folder whose security descriptor is set in
// the same call (no window in which it has another one).
func CreateDirectorySDDL(path, sddl string) error {
	p, err := utf16Ptr(path)
	if err != nil {
		return err
	}
	sd, err := SecurityDescriptorFromSDDL(sddl)
	if err != nil {
		return err
	}
	defer localFree(sd)
	sa := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: uintptr(sd)}
	return syscall.CreateDirectory(p, &sa)
}

// CreateFileSDDL creates a new file (CREATE_NEW) with the given security
// descriptor and returns it opened for writing.
func CreateFileSDDL(path, sddl string) (syscall.Handle, error) {
	p, err := utf16Ptr(path)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	sd, err := SecurityDescriptorFromSDDL(sddl)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	defer localFree(sd)
	sa := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: uintptr(sd)}
	return syscall.CreateFile(p, syscall.GENERIC_WRITE|syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_DELETE, &sa, syscall.CREATE_NEW, syscall.FILE_ATTRIBUTE_NORMAL, 0)
}
