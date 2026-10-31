// Package winapi is the one place where the agent talks to the Windows API:
// it loads the system DLLs by absolute path (never from the search path, see
// `go doc syscall LoadDLL`), declares the procedures the agent needs and wraps
// them in small Go functions. Only the standard library is used (no
// golang.org/x/sys/windows, docs/WINDOWS-AGENT.md, section 1.3).
//
// This file holds the constants and is built on every system, so the pure
// logic that uses them (ACL evaluation, service configuration) can be tested
// on Linux too. Everything that calls into Windows lives in *_windows.go.
package winapi

// Win32 error codes the agent tells apart (winerror.h).
const (
	ErrorFileNotFound              = 2
	ErrorAccessDenied              = 5
	ErrorSharingViolation          = 32
	ErrorLockViolation             = 33
	ErrorCallNotImplemented        = 120
	ErrorInsufficientBuffer        = 122
	ErrorAlreadyExists             = 183
	ErrorMoreData                  = 234
	ErrorIOPending                 = 997
	ErrorServiceAlreadyRunning     = 1056
	ErrorServiceDoesNotExist       = 1060
	ErrorServiceNotActive          = 1062
	ErrorFailedServiceControllerCx = 1063
	ErrorServiceSpecificError      = 1066
	ErrorServiceMarkedForDelete    = 1072
	ErrorServiceExists             = 1073
	ErrorServiceNeverStarted       = 1077
)

// Process creation flags missing from package syscall.
const (
	CreateNoWindow = 0x08000000
)

// Console control events (GenerateConsoleCtrlEvent).
const (
	CtrlCEvent     = 0
	CtrlBreakEvent = 1
)

// File access rights and flags (winnt.h). The directory names share the bits
// of the file names (FILE_ADD_FILE = FILE_WRITE_DATA and so on).
const (
	FileReadData        = 0x00000001 // FILE_LIST_DIRECTORY
	FileWriteData       = 0x00000002 // FILE_ADD_FILE
	FileAppendData      = 0x00000004 // FILE_ADD_SUBDIRECTORY
	FileReadEA          = 0x00000008
	FileWriteEA         = 0x00000010
	FileExecute         = 0x00000020 // FILE_TRAVERSE
	FileDeleteChild     = 0x00000040
	FileReadAttributes  = 0x00000080
	FileWriteAttributes = 0x00000100
	Delete              = 0x00010000
	ReadControl         = 0x00020000
	WriteDAC            = 0x00040000
	WriteOwner          = 0x00080000
	Synchronize         = 0x00100000
	AccessSystemSecure  = 0x01000000
	MaximumAllowed      = 0x02000000
	GenericAll          = 0x10000000
	GenericExecute      = 0x20000000
	GenericWrite        = 0x40000000
	GenericRead         = 0x80000000

	FileAllAccess      = 0x001F01FF
	FileGenericRead    = 0x00120089
	FileGenericWrite   = 0x00120116
	FileGenericExecute = 0x001200A0

	FileAttributeReparsePoint = 0x00000400
	FileAttributeDirectory    = 0x00000010
	FilePersistentACLs        = 0x00000008 // GetVolumeInformationW flag
)

// SetFileInformationByHandle with FileRenameInfoEx: a rename that replaces the target with
// POSIX semantics, so a target another process holds open with FILE_SHARE_DELETE is
// replaced instead of failing with "access denied" (Windows 10 1709 and newer, NTFS).
const (
	fileRenameInfoEx              = 22
	fileRenameFlagReplaceIfExists = 0x1
	fileRenameFlagPosixSemantics  = 0x2
	fileAccessDelete              = 0x00010000
	fileAccessSynchronize         = 0x00100000
	fileShareAll                  = 0x1 | 0x2 | 0x4
	openExisting                  = 3
	fileFlagBackupSemantics       = 0x02000000
	fileFlagOpenReparsePoint      = 0x00200000
)

// MoveFileExW flags.
const (
	MoveFileReplaceExisting   = 0x1
	MoveFileDelayUntilReboot  = 0x4
	MoveFileWriteThrough      = 0x8
	MoveFileCopyAllowed       = 0x2
	fileNameNormalized        = 0x0
	VolumeNameDOS             = 0x0
	FinalPathFlags            = fileNameNormalized | VolumeNameDOS
	LockfileFailImmediately   = 0x1
	LockfileExclusiveLock     = 0x2
	DriveRemovable            = 2
	DriveFixed                = 3
	DriveRemote               = 4
	DriveCDROM                = 5
	DriveRAMDisk              = 6
	ProcessSetQuota           = 0x0100
	ProcessTerminate          = 0x0001
	ProcessQueryLimitedInform = 0x1000
)

// Security information flags (GetSecurityInfo, SetFileSecurityW).
const (
	OwnerSecurityInformation         = 0x00000001
	GroupSecurityInformation         = 0x00000002
	DACLSecurityInformation          = 0x00000004
	ProtectedDACLSecurityInformation = 0x80000000
	SEFileObject                     = 1
	SDDLRevision1                    = 1
)

// Job objects.
const (
	JobObjectExtendedLimitInformationClass = 9
	JobObjectLimitKillOnJobClose           = 0x00002000
	JobObjectLimitBreakawayOK              = 0x00000800
)

// Service control manager (winsvc.h).
const (
	SCManagerConnect       = 0x0001
	SCManagerCreateService = 0x0002

	ServiceQueryConfig  = 0x0001
	ServiceChangeConfig = 0x0002
	ServiceQueryStatus  = 0x0004
	ServiceStart        = 0x0010
	ServiceStop         = 0x0020
	ServiceInterrogate  = 0x0080

	ServiceWin32OwnProcess = 0x00000010
	ServiceAutoStart       = 0x00000002
	ServiceDemandStart     = 0x00000003
	ServiceDisabled        = 0x00000004
	ServiceErrorNormal     = 0x00000001
	ServiceNoChange        = 0xFFFFFFFF

	ServiceStopped         = 1
	ServiceStartPending    = 2
	ServiceStopPending     = 3
	ServiceRunning         = 4
	ServiceContinuePending = 5
	ServicePausePending    = 6
	ServicePaused          = 7

	ServiceControlStop        = 0x00000001
	ServiceControlInterrogate = 0x00000004
	ServiceControlShutdown    = 0x00000005
	ServiceControlPreshutdown = 0x0000000F

	ServiceAcceptStop        = 0x00000001
	ServiceAcceptShutdown    = 0x00000004
	ServiceAcceptPreshutdown = 0x00000100

	SCStatusProcessInfo = 0

	ServiceConfigDescription            = 1
	ServiceConfigFailureActions         = 2
	ServiceConfigDelayedAutoStartInfo   = 3
	ServiceConfigFailureActionsFlag     = 4
	ServiceConfigServiceSidInfo         = 5
	ServiceConfigRequiredPrivilegesInfo = 6
	ServiceConfigPreshutdownInfo        = 7

	SCActionNone    = 0
	SCActionRestart = 1

	ServiceSidTypeNone         = 0
	ServiceSidTypeUnrestricted = 1
)

// Event log (ReportEventW).
const (
	EventlogErrorType       = 0x0001
	EventlogWarningType     = 0x0002
	EventlogInformationType = 0x0004
)

// DPAPI flags (CryptProtectData).
const (
	CryptprotectUIForbidden  = 0x1
	CryptprotectLocalMachine = 0x4
)

// Well-known SIDs the agent trusts or names.
const (
	SIDLocalSystem       = "S-1-5-18"
	SIDAdministrators    = "S-1-5-32-544"
	SIDTrustedInstaller  = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	SIDCreatorOwner      = "S-1-3-0"
	SIDBuiltinUsers      = "S-1-5-32-545"
	SIDAuthenticatedUser = "S-1-5-11"
	SIDEveryone          = "S-1-1-0"
)
