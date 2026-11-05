package recovery

import "errors"

// Codes recover reports (contract C-M4-6). The server reads
// testdata/recover-codes.json; TestRecoverCodesFile keeps it equal to these
// lists. A warning sent with finish is a member of the planner's codes
// (baremetal.PlanProblemCodes, PlanWarningCodes) or of these.
const (
	ProblemAccessExpired             = "access_expired"
	ProblemArchUnsupported           = "arch_unsupported"
	ProblemClockWrong                = "clock_wrong"
	ProblemHoldersBusy               = "holders_busy"
	ProblemLVMFilterMultiline        = "lvm_filter_multiline"
	ProblemManifestFormatUnknown     = "manifest_format_unknown"
	ProblemManifestInvalid           = "manifest_invalid"
	ProblemManifestMismatch          = "manifest_mismatch"
	ProblemMkfsReadbackMismatch      = "mkfs_readback_mismatch"
	ProblemNoDisksFound              = "no_disks_found"
	ProblemPartitionReadbackMismatch = "partition_readback_mismatch"
	ProblemRecoveryTooOld            = "recovery_too_old"
	ProblemRestoreFailed             = "restore_failed"
	ProblemSPKIMismatch              = "spki_mismatch"
	ProblemStepFailed                = "step_failed"
	ProblemSystemFilesIncomplete     = "system_files_incomplete"
	ProblemTLSUntrusted              = "tls_untrusted"
	ProblemVerifyFailed              = "verify_failed"

	WarnBootSpaceLow        = "boot_space_low"
	WarnCancelRequested     = "cancel_requested"
	WarnDeviceNameRefsFound = "device_name_refs_found"
	WarnInitramfsNotRebuilt = "initramfs_not_rebuilt"
	WarnLowMemory           = "low_memory"
	WarnMokEnrollPending    = "mok_enroll_pending"
	WarnNICRenameSkipped    = "nic_rename_skipped"
	WarnOldDiskPresent      = "old_disk_present"
	WarnQuotaRescanFailed   = "quota_rescan_failed"
	WarnRestoreFileErrors   = "restore_file_errors"
	WarnSELinuxAutorelabel  = "selinux_autorelabel"
)

// Ids of the ten checks of 10.17.
const (
	CheckResticVerify      = "restic_verify"
	CheckStorageStack      = "storage_stack"
	CheckFstab             = "fstab"
	CheckCrypttab          = "crypttab"
	CheckInitramfs         = "initramfs"
	CheckBootEntries       = "boot_entries"
	CheckBootConfig        = "boot_config"
	CheckIdentityConflicts = "identity_conflicts"
	CheckMountPoints       = "mount_points"
	CheckSecureBoot        = "secure_boot"
)

// Hints for after the start (verification.hints).
const (
	HintBIOSBootDisk        = "bios_boot_disk"
	HintDeviceNameRefs      = "device_name_refs"
	HintInitramfsNotAdapted = "initramfs_not_adapted"
	HintKeymapAtBoot        = "keymap_at_boot"
	HintLUKSReenrollToken   = "luks_reenroll_token"
	HintMDAddDisk           = "md_add_disk"
	HintMDDegradedFirstBoot = "md_degraded_first_boot"
	HintMokEnroll           = "mok_enroll"
	HintNICMapped           = "nic_mapped"
	HintOldDiskPresent      = "old_disk_present"
	HintSecureBootDisabled  = "secure_boot_disabled"
	HintSELinuxAutorelabel  = "selinux_autorelabel"
)

// RecoverProblemCodes, RecoverWarningCodes, CheckIDs and HintCodes are the
// lists of testdata/recover-codes.json (in its order).
var (
	RecoverProblemCodes = []string{ProblemAccessExpired, ProblemArchUnsupported, ProblemClockWrong, ProblemHoldersBusy,
		ProblemLVMFilterMultiline, ProblemManifestFormatUnknown, ProblemManifestInvalid, ProblemManifestMismatch,
		ProblemMkfsReadbackMismatch, ProblemNoDisksFound, ProblemPartitionReadbackMismatch, ProblemRecoveryTooOld,
		ProblemRestoreFailed, ProblemSPKIMismatch, ProblemStepFailed, ProblemSystemFilesIncomplete, ProblemTLSUntrusted,
		ProblemVerifyFailed}
	RecoverWarningCodes = []string{WarnBootSpaceLow, WarnCancelRequested, WarnDeviceNameRefsFound, WarnInitramfsNotRebuilt,
		WarnLowMemory, WarnMokEnrollPending, WarnNICRenameSkipped, WarnOldDiskPresent, WarnQuotaRescanFailed,
		WarnRestoreFileErrors, WarnSELinuxAutorelabel}
	CheckIDs = []string{CheckResticVerify, CheckStorageStack, CheckFstab, CheckCrypttab, CheckInitramfs, CheckBootEntries,
		CheckBootConfig, CheckIdentityConflicts, CheckMountPoints, CheckSecureBoot}
	HintCodes = []string{HintBIOSBootDisk, HintDeviceNameRefs, HintInitramfsNotAdapted, HintKeymapAtBoot,
		HintLUKSReenrollToken, HintMDAddDisk, HintMDDegradedFirstBoot, HintMokEnroll, HintNICMapped, HintOldDiskPresent,
		HintSecureBootDisabled, HintSELinuxAutorelabel}
	// HintParams are the parameter names of each hint; the web's texts
	// recovery.hints.<code> use exactly these placeholders.
	HintParams = map[string][]string{
		HintBIOSBootDisk:        {"model", "identity"},
		HintDeviceNameRefs:      {"path", "line"},
		HintInitramfsNotAdapted: {"kernel"},
		HintKeymapAtBoot:        {"layout"},
		HintLUKSReenrollToken:   {"volume", "tokenTypes"},
		HintMDAddDisk:           {"array"},
		HintMDDegradedFirstBoot: {"array"},
		HintMokEnroll:           {},
		HintNICMapped:           {"oldName", "oldMac", "newMac"},
		HintOldDiskPresent:      {"model", "identity"},
		HintSecureBootDisabled:  {},
		HintSELinuxAutorelabel:  {},
	}
)

// ProblemCode is the recover code of an error (step_failed when it has
// none).
func ProblemCode(err error) string {
	var pe *problemError
	if errors.As(err, &pe) {
		return pe.code
	}
	return ""
}
