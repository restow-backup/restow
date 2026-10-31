//go:build windows

package winapi

import (
	"syscall"
	"unsafe"
)

var (
	procConvertStringSDToSD = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procConvertSDToStringSD = advapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	procGetSecurityInfo     = advapi32.NewProc("GetSecurityInfo")
	procSetFileSecurityW    = advapi32.NewProc("SetFileSecurityW")

	procOpenSCManagerW               = advapi32.NewProc("OpenSCManagerW")
	procCreateServiceW               = advapi32.NewProc("CreateServiceW")
	procOpenServiceW                 = advapi32.NewProc("OpenServiceW")
	procStartServiceW                = advapi32.NewProc("StartServiceW")
	procControlService               = advapi32.NewProc("ControlService")
	procQueryServiceStatusEx         = advapi32.NewProc("QueryServiceStatusEx")
	procQueryServiceConfigW          = advapi32.NewProc("QueryServiceConfigW")
	procQueryServiceConfig2W         = advapi32.NewProc("QueryServiceConfig2W")
	procChangeServiceConfigW         = advapi32.NewProc("ChangeServiceConfigW")
	procChangeServiceConfig2W        = advapi32.NewProc("ChangeServiceConfig2W")
	procDeleteService                = advapi32.NewProc("DeleteService")
	procCloseServiceHandle           = advapi32.NewProc("CloseServiceHandle")
	procStartServiceCtrlDispatcherW  = advapi32.NewProc("StartServiceCtrlDispatcherW")
	procRegisterServiceCtrlHandlerEx = advapi32.NewProc("RegisterServiceCtrlHandlerExW")
	procSetServiceStatus             = advapi32.NewProc("SetServiceStatus")

	procRegisterEventSourceW  = advapi32.NewProc("RegisterEventSourceW")
	procReportEventW          = advapi32.NewProc("ReportEventW")
	procDeregisterEventSource = advapi32.NewProc("DeregisterEventSource")
)

// SecurityDescriptorFromSDDL converts SDDL text to a self-relative security
// descriptor; free it with localFree
// (https://learn.microsoft.com/windows/win32/api/sddl/nf-sddl-convertstringsecuritydescriptortosecuritydescriptorw).
func SecurityDescriptorFromSDDL(sddl string) (unsafe.Pointer, error) {
	s, err := utf16Ptr(sddl)
	if err != nil {
		return nil, err
	}
	var sd unsafe.Pointer
	if _, err := call(procConvertStringSDToSD, uintptr(unsafe.Pointer(s)), SDDLRevision1, uintptr(unsafe.Pointer(&sd)), 0); err != nil {
		return nil, err
	}
	return sd, nil
}

// HandleSDDL returns owner and DACL of an open file or folder as SDDL text
// (GetSecurityInfo, https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).
// The handle needs READ_CONTROL.
func HandleSDDL(h syscall.Handle) (string, error) {
	var sd unsafe.Pointer
	info := uint32(OwnerSecurityInformation | DACLSecurityInformation)
	err := callStatus(procGetSecurityInfo, uintptr(h), SEFileObject, uintptr(info), 0, 0, 0, 0, uintptr(unsafe.Pointer(&sd)))
	if err != nil {
		return "", err
	}
	defer localFree(sd)
	var str *uint16
	if _, err := call(procConvertSDToStringSD, uintptr(sd), SDDLRevision1, uintptr(info), uintptr(unsafe.Pointer(&str)), 0); err != nil {
		return "", err
	}
	defer localFree(unsafe.Pointer(str))
	return UTF16PtrToString(str), nil
}

// SetFileDACL replaces the DACL of a file or folder with the one in sddl
// (protected: nothing inherited from above)
// (https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-setfilesecurityw).
func SetFileDACL(path, sddl string) error {
	p, err := utf16Ptr(path)
	if err != nil {
		return err
	}
	sd, err := SecurityDescriptorFromSDDL(sddl)
	if err != nil {
		return err
	}
	defer localFree(sd)
	_, err = call(procSetFileSecurityW, uintptr(unsafe.Pointer(p)), DACLSecurityInformation|ProtectedDACLSecurityInformation, uintptr(sd))
	return err
}

// ---- service control manager ------------------------------------------------

// ServiceStatus is SERVICE_STATUS.
type ServiceStatus struct {
	ServiceType             uint32
	CurrentState            uint32
	ControlsAccepted        uint32
	Win32ExitCode           uint32
	ServiceSpecificExitCode uint32
	CheckPoint              uint32
	WaitHint                uint32
}

// ServiceStatusProcess is SERVICE_STATUS_PROCESS.
type ServiceStatusProcess struct {
	ServiceStatus
	ProcessID    uint32
	ServiceFlags uint32
}

// QueryServiceConfigData is QUERY_SERVICE_CONFIGW.
type QueryServiceConfigData struct {
	ServiceType      uint32
	StartType        uint32
	ErrorControl     uint32
	BinaryPathName   *uint16
	LoadOrderGroup   *uint16
	TagID            uint32
	Dependencies     *uint16
	ServiceStartName *uint16
	DisplayName      *uint16
}

// ServiceDescription is SERVICE_DESCRIPTIONW.
type ServiceDescription struct{ Description *uint16 }

// SCAction is SC_ACTION.
type SCAction struct {
	Type  uint32
	Delay uint32
}

// ServiceFailureActions is SERVICE_FAILURE_ACTIONSW.
type ServiceFailureActions struct {
	ResetPeriod  uint32
	RebootMsg    *uint16
	Command      *uint16
	ActionsCount uint32
	Actions      *SCAction
}

// ServiceFailureActionsFlag is SERVICE_FAILURE_ACTIONS_FLAG.
type ServiceFailureActionsFlag struct{ FailureActionsOnNonCrashFailures int32 }

// ServiceDelayedAutoStartInfo is SERVICE_DELAYED_AUTO_START_INFO.
type ServiceDelayedAutoStartInfo struct{ DelayedAutostart int32 }

// ServicePreshutdownInfo is SERVICE_PRESHUTDOWN_INFO.
type ServicePreshutdownInfo struct{ PreshutdownTimeout uint32 }

// ServiceRequiredPrivilegesInfo is SERVICE_REQUIRED_PRIVILEGES_INFOW.
type ServiceRequiredPrivilegesInfo struct{ RequiredPrivileges *uint16 }

// ServiceSidInfo is SERVICE_SID_INFO.
type ServiceSidInfo struct{ ServiceSidType uint32 }

// OpenSCManager connects to the service control manager
// (https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-openscmanagerw).
func OpenSCManager(access uint32) (syscall.Handle, error) {
	r, err := call(procOpenSCManagerW, 0, 0, uintptr(access))
	return syscall.Handle(r), err
}

// CreateService registers a service running as LocalSystem
// (https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-createservicew).
func CreateService(scm syscall.Handle, name, display, binaryPath string, startType uint32) (syscall.Handle, error) {
	n, err := utf16Ptr(name)
	if err != nil {
		return 0, err
	}
	d, err := utf16Ptr(display)
	if err != nil {
		return 0, err
	}
	b, err := utf16Ptr(binaryPath)
	if err != nil {
		return 0, err
	}
	r, err := call(procCreateServiceW, uintptr(scm), uintptr(unsafe.Pointer(n)), uintptr(unsafe.Pointer(d)),
		0xF01FF, ServiceWin32OwnProcess, uintptr(startType), ServiceErrorNormal,
		uintptr(unsafe.Pointer(b)), 0, 0, 0, 0, 0)
	return syscall.Handle(r), err
}

// OpenService opens a service (https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-openservicew).
func OpenService(scm syscall.Handle, name string, access uint32) (syscall.Handle, error) {
	n, err := utf16Ptr(name)
	if err != nil {
		return 0, err
	}
	r, err := call(procOpenServiceW, uintptr(scm), uintptr(unsafe.Pointer(n)), uintptr(access))
	return syscall.Handle(r), err
}

// CloseServiceHandle closes a handle of the service control manager.
func CloseServiceHandle(h syscall.Handle) {
	if h != 0 {
		_, _ = call(procCloseServiceHandle, uintptr(h))
	}
}

// StartService starts a service without arguments.
func StartService(svc syscall.Handle) error {
	_, err := call(procStartServiceW, uintptr(svc), 0, 0)
	return err
}

// ControlService sends a control code to a service.
func ControlService(svc syscall.Handle, control uint32) (ServiceStatus, error) {
	var st ServiceStatus
	_, err := call(procControlService, uintptr(svc), uintptr(control), uintptr(unsafe.Pointer(&st)))
	return st, err
}

// QueryServiceStatus returns state, process id and exit codes of a service.
func QueryServiceStatus(svc syscall.Handle) (ServiceStatusProcess, error) {
	var st ServiceStatusProcess
	var needed uint32
	_, err := call(procQueryServiceStatusEx, uintptr(svc), SCStatusProcessInfo, uintptr(unsafe.Pointer(&st)),
		unsafe.Sizeof(st), uintptr(unsafe.Pointer(&needed)))
	return st, err
}

// QueryServiceConfig returns the basic configuration of a service. The
// strings point into the returned buffer, which must stay alive while they
// are read.
func QueryServiceConfig(svc syscall.Handle) (*QueryServiceConfigData, []byte, error) {
	var needed uint32
	_, err := call(procQueryServiceConfigW, uintptr(svc), 0, 0, uintptr(unsafe.Pointer(&needed)))
	if err == nil || !IsErrno(err, ErrorInsufficientBuffer) {
		if err == nil {
			err = syscall.EINVAL
		}
		return nil, nil, err
	}
	buf := make([]byte, needed)
	if _, err := call(procQueryServiceConfigW, uintptr(svc), uintptr(unsafe.Pointer(&buf[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed))); err != nil {
		return nil, nil, err
	}
	return (*QueryServiceConfigData)(unsafe.Pointer(&buf[0])), buf, nil
}

// QueryServiceConfig2 returns one optional configuration item as raw bytes;
// the caller casts the start of the buffer to the matching struct.
func QueryServiceConfig2(svc syscall.Handle, level uint32) ([]byte, error) {
	var needed uint32
	_, err := call(procQueryServiceConfig2W, uintptr(svc), uintptr(level), 0, 0, uintptr(unsafe.Pointer(&needed)))
	if err == nil || !IsErrno(err, ErrorInsufficientBuffer) {
		if err == nil {
			err = syscall.EINVAL
		}
		return nil, err
	}
	// Room for the largest fixed struct, so the cast never reads past the end.
	if needed < 64 {
		needed = 64
	}
	buf := make([]byte, needed)
	if _, err := call(procQueryServiceConfig2W, uintptr(svc), uintptr(level), uintptr(unsafe.Pointer(&buf[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed))); err != nil {
		return nil, err
	}
	return buf, nil
}

// ChangeServiceConfig sets start type and program of a service (everything
// else unchanged).
func ChangeServiceConfig(svc syscall.Handle, startType uint32, binaryPath, display string) error {
	b, err := utf16Ptr(binaryPath)
	if err != nil {
		return err
	}
	d, err := utf16Ptr(display)
	if err != nil {
		return err
	}
	_, err = call(procChangeServiceConfigW, uintptr(svc), ServiceWin32OwnProcess, uintptr(startType), ServiceErrorNormal,
		uintptr(unsafe.Pointer(b)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(d)))
	return err
}

// ChangeServiceConfig2 sets one optional configuration item; info points to
// the struct of that level.
func ChangeServiceConfig2(svc syscall.Handle, level uint32, info unsafe.Pointer) error {
	_, err := call(procChangeServiceConfig2W, uintptr(svc), uintptr(level), uintptr(info))
	return err
}

// DeleteService marks a service for deletion; the entry goes once every
// handle is closed and the process has ended.
func DeleteService(svc syscall.Handle) error {
	_, err := call(procDeleteService, uintptr(svc))
	return err
}

// ServiceTableEntry is SERVICE_TABLE_ENTRYW.
type ServiceTableEntry struct {
	ServiceName *uint16
	ServiceProc uintptr
}

// StartServiceCtrlDispatcher connects the calling thread to the service
// control manager and returns when every service of the process has stopped.
func StartServiceCtrlDispatcher(table *ServiceTableEntry) error {
	_, err := call(procStartServiceCtrlDispatcherW, uintptr(unsafe.Pointer(table)))
	return err
}

// RegisterServiceCtrlHandlerEx registers the control handler (a callback
// from syscall.NewCallback) and returns the status handle.
func RegisterServiceCtrlHandlerEx(name *uint16, handler uintptr) (uintptr, error) {
	return call(procRegisterServiceCtrlHandlerEx, uintptr(unsafe.Pointer(name)), handler, 0)
}

// SetServiceStatus reports the state of the service to the manager.
func SetServiceStatus(statusHandle uintptr, st *ServiceStatus) error {
	_, err := call(procSetServiceStatus, statusHandle, uintptr(unsafe.Pointer(st)))
	return err
}

// ---- event log -----------------------------------------------------------------

// ReportEvent writes one event with one string to the Application log under
// the given source (RegisterEventSourceW, ReportEventW, DeregisterEventSource).
func ReportEvent(source string, eventType uint16, id uint32, message string) error {
	s, err := utf16Ptr(source)
	if err != nil {
		return err
	}
	h, err := call(procRegisterEventSourceW, 0, uintptr(unsafe.Pointer(s)))
	if err != nil {
		return err
	}
	defer func() { _, _ = call(procDeregisterEventSource, h) }()
	m, err := utf16Ptr(message)
	if err != nil {
		return err
	}
	strs := [1]*uint16{m}
	_, err = call(procReportEventW, h, uintptr(eventType), 0, uintptr(id), 0, 1, 0, uintptr(unsafe.Pointer(&strs[0])), 0)
	return err
}

// ---- tokens ------------------------------------------------------------------

// TokenElevated reports whether the current process token is elevated (UAC).
func TokenElevated() (bool, error) {
	tok, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return false, err
	}
	defer tok.Close()
	var elevated uint32
	var n uint32
	if err := syscall.GetTokenInformation(tok, syscall.TokenElevation, (*byte)(unsafe.Pointer(&elevated)), uint32(unsafe.Sizeof(elevated)), &n); err != nil {
		return false, err
	}
	return elevated != 0, nil
}

// CurrentUserSID returns the SID of the user the process runs as.
func CurrentUserSID() (string, error) {
	tok, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String()
}
