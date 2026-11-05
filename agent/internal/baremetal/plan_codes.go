package baremetal

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Codes of the planner's findings (docs/BAREMETAL.md 10.4 to 10.11,
// contract C-M2-6). A problem blocks the plan (ok is false), a warning is
// shown with it. testdata/plan-codes.json holds both lists for the server
// (PLAN_PROBLEM_CODES and PLAN_WARNING_CODES, and the i18n keys
// baremetal.plan.codes.<code>); TestPlanCodesFile keeps it current.
const (
	ProblemLayoutUnsupported       = "layout_unsupported"
	ProblemFirmwareModeMismatch    = "firmware_mode_mismatch"
	ProblemBIOS4Kn                 = "bios_4kn"
	ProblemTargetMissing           = "target_missing"
	ProblemTargetTooSmall          = "target_too_small"
	ProblemTargetUnusable          = "target_unusable"
	ProblemSEDLocked               = "sed_locked"
	ProblemMultipathDetected       = "multipath_detected"
	ProblemIdentityConflict        = "identity_conflict"
	ProblemStorageDriverMissing    = "storage_driver_missing"
	ProblemSecureBootCAMissing     = "secure_boot_ca_missing"
	ProblemSecureBootRevoked       = "secure_boot_revoked"
	ProblemSecureBootSbatRevoked   = "secure_boot_sbat_revoked"
	ProblemMokKeyMissing           = "mok_key_missing"
	ProblemMkfsUnsupportedType     = "mkfs_unsupported_type"
	ProblemMkfsFeatureUnknown      = "mkfs_feature_unknown"
	ProblemSectorSizeIncompatible  = "sector_size_incompatible"
	ProblemMDTooFewMembers         = "md_too_few_members"
	ProblemLVMRaidMissingPV        = "lvm_raid_missing_pv"
	ProblemBtrfsRaidMissingDevice  = "btrfs_raid_missing_device"
	ProblemShrinkNeedsConfirmation = "shrink_needs_confirmation"
	ProblemAdoptIncomplete         = "adopt_incomplete"
	ProblemMappingInvalid          = "mapping_invalid"

	WarnNICDriverMissing              = "nic_driver_missing"
	WarnFallbackKernelDriverMissing   = "fallback_kernel_driver_missing"
	WarnOtherControllerDriverMissing  = "other_controller_driver_missing"
	WarnDriverFactsMissing            = "driver_facts_missing"
	WarnSecureBootDBXUnknown          = "secure_boot_dbx_unknown"
	WarnSecureBootUnsignedChain       = "secure_boot_unsigned_chain"
	WarnSecureBootDisabledByChoice    = "secure_boot_disabled_by_choice"
	WarnMokEnrollRequired             = "mok_enroll_required"
	WarnMDDegradedFirstBoot           = "md_degraded_first_boot"
	WarnRedundantBootPartitionDropped = "redundant_boot_partition_dropped"
	WarnRawLVsSkipped                 = "raw_lvs_skipped"
	WarnRawLVsCreatedEmpty            = "raw_lvs_created_empty"
	WarnDualBootWindowsNotRestored    = "dual_boot_windows_not_restored"
	WarnMBR2TiBLimit                  = "mbr_2tib_limit"
	WarnPartitionRealigned            = "partition_realigned"
	WarnESPGrown4Kn                   = "esp_grown_4kn"
	WarnExtBlockSizeRaised            = "ext_block_size_raised"
	WarnVFATSectorSizeChanged         = "vfat_sector_size_changed"
	WarnLUKSSectorSizeChanged         = "luks_sector_size_changed"
	WarnLVMMixedBlockSizesAllowed     = "lvm_mixed_block_sizes_allowed"
	WarnBtrfsCsumAssumed              = "btrfs_csum_assumed"
	WarnRestoreSizeEstimated          = "restore_size_estimated"
	WarnLVShrunk                      = "lv_shrunk"
	WarnPartitionShrunk               = "partition_shrunk"
	WarnGrowNotLast                   = "grow_not_last"
	WarnFSNotRecreated                = "fs_not_recreated"
	WarnBIOSBootDisk                  = "bios_boot_disk"
	WarnLUKSTokensNotRestored         = "luks_tokens_not_restored"
	WarnKeyfileRegenerated            = "keyfile_regenerated"
	WarnUntestedDistribution          = CodeUntestedDistribution
	WarnNonSystemdInit                = CodeNonSystemdInit
)

// Severities of a Finding.
const (
	FindingProblem = "problem"
	FindingWarning = "warning"
)

// planMessages are the English message templates; {name} is replaced by
// the parameter of that name. The UI translates by code and params, the
// message is for logs and the command line.
var planMessages = map[string]string{
	ProblemLayoutUnsupported:       "The layout of this snapshot cannot be restored to bare metal ({reason}).",
	ProblemFirmwareModeMismatch:    "The system was backed up in {source} mode, the target starts in {target} mode. Start the target in {source} mode (firmware setup: CSM or legacy boot for BIOS).",
	ProblemBIOS4Kn:                 "BIOS cannot start from disk {target}: it has 4096-byte logical sectors. Reformat it to 512-byte sectors or use a 512e disk.",
	ProblemTargetMissing:           "No target disk for {disk} ({kname}, at least {minBytes} bytes).",
	ProblemTargetTooSmall:          "Target disk {target} has {haveBytes} bytes, {disk} needs at least {needBytes} bytes.",
	ProblemTargetUnusable:          "Target disk {target} cannot be written ({reason}).",
	ProblemSEDLocked:               "Disk {target} returns I/O errors; it may be a locked self-encrypting drive (TCG Opal). Unlock it or reset it with its PSID.",
	ProblemMultipathDetected:       "Disks {targets} have the same WWN: multipath detected. Connect only one path or turn multipath off in the storage system.",
	ProblemIdentityConflict:        "Device {device} carries {kind} {uuid} of this system. Disconnect it or wipe it, or two copies of the same identity will be visible.",
	ProblemStorageDriverMissing:    "The backed-up kernel {kernel} has no driver for {modalias} of disk {target}; the restored system would not start.",
	ProblemSecureBootCAMissing:     "The target firmware does not trust {loader} (signed by {issuer}). Turn Secure Boot off or allow the third-party UEFI CA in the firmware setup.",
	ProblemSecureBootRevoked:       "The target firmware has revoked {loader} (dbx).",
	ProblemSecureBootSbatRevoked:   "The target firmware has revoked {component} generation {generation} of {loader} (SBAT level {level}).",
	ProblemMokKeyMissing:           "{object} is signed with the machine owner key {subject}, which is not in the backup and not enrolled on the target.",
	ProblemMkfsUnsupportedType:     "File system {fs} ({type}) cannot be created by the planner: {reason}.",
	ProblemMkfsFeatureUnknown:      "File system {fs} ({type}) uses the feature {feature}, which the recovery tools cannot create.",
	ProblemSectorSizeIncompatible:  "{object} combines {sizes}-byte sectors that {fs} cannot use.",
	ProblemMDTooFewMembers:         "The md array {md} would have {have} of {need} members; it cannot run.",
	ProblemLVMRaidMissingPV:        "The RAID LV {vg}/{lv} needs all its physical volumes; {disk} is missing.",
	ProblemBtrfsRaidMissingDevice:  "The btrfs file system {fs} needs all its devices; {disk} is missing.",
	ProblemShrinkNeedsConfirmation: "Disk {disk} does not fit on {target} without shrinking more than the grow volume; confirm the proposal.",
	ProblemAdoptIncomplete:         "{unit} cannot be adopted: {reason}.",
	ProblemMappingInvalid:          "The disk mapping is not valid: {reason}.",

	WarnNICDriverMissing:              "The backed-up kernel {kernel} has no driver for network card {nic} ({modalias}); the system starts without network on it.",
	WarnFallbackKernelDriverMissing:   "The fallback kernel {kernel} has no driver for {modalias} of disk {target}.",
	WarnOtherControllerDriverMissing:  "On another controller the backed-up kernel {kernel} would have no driver for {modalias} ({module}).",
	WarnDriverFactsMissing:            "The kernel module lists of {kernel} are not known; drivers were not checked.",
	WarnSecureBootDBXUnknown:          "The revocation list (dbx) of the target is not known; revoked loaders were not checked.",
	WarnSecureBootUnsignedChain:       "{loader} is not signed: the restored system starts only with Secure Boot off or with own keys.",
	WarnSecureBootDisabledByChoice:    "Secure Boot is to be turned off on the target; the boot chain checks are warnings only ({codes}).",
	WarnMokEnrollRequired:             "The machine owner key {subject} must be enrolled at the first start (MokManager).",
	WarnMDDegradedFirstBoot:           "The md array {md} is created degraded ({have} of {need} members); the first start may be delayed or ask.",
	WarnRedundantBootPartitionDropped: "Partition {partition} of the missing disk {disk} is a redundant boot partition and is not recreated.",
	WarnRawLVsSkipped:                 "{count} LVs without a file system were not backed up and are not created ({lvs}).",
	WarnRawLVsCreatedEmpty:            "{count} LVs without a file system are created empty ({lvs}).",
	WarnDualBootWindowsNotRestored:    "Windows is not restored; its boot entries are not created.",
	WarnMBR2TiBLimit:                  "Disk {target} is larger than an MBR partition table can address; {freeBytes} bytes stay unused.",
	WarnPartitionRealigned:            "Partition {partition} is moved to a 1 MiB boundary (it started at byte {fromBytes}); its PARTUUID stays.",
	WarnESPGrown4Kn:                   "The ESP {partition} grows to {sizeBytes} bytes for FAT32 with 4096-byte sectors.",
	WarnExtBlockSizeRaised:            "File system {fs} is created with {blockSize}-byte blocks instead of {sourceBlockSize}.",
	WarnVFATSectorSizeChanged:         "File system {fs} is created with {sectorSize}-byte sectors instead of {sourceSectorSize}.",
	WarnLUKSSectorSizeChanged:         "LUKS volume {luks} is created with {sectorSize}-byte sectors instead of {sourceSectorSize}.",
	WarnLVMMixedBlockSizesAllowed:     "{object} spans disks with different sector sizes; LVM is told to allow mixed block sizes.",
	WarnBtrfsCsumAssumed:              "The checksum type of btrfs {fs} is not recorded; crc32c is assumed.",
	WarnRestoreSizeEstimated:          "The restore size of {object} is estimated from the space in use; compressed or shared data may need more.",
	WarnLVShrunk:                      "LV {vg}/{lv} shrinks from {fromBytes} to {toBytes} bytes.",
	WarnPartitionShrunk:               "Partition {partition} shrinks from {fromBytes} to {toBytes} bytes.",
	WarnGrowNotLast:                   "Partition {partition} is marked to grow but is not the last one on {disk}; it keeps its size.",
	WarnFSNotRecreated:                "File system {fs} ({type}) is not recreated; its partition stays empty.",
	WarnBIOSBootDisk:                  "Select {target} as the boot disk in the BIOS (or as the boot volume of the controller).",
	WarnLUKSTokensNotRestored:         "The tokens of LUKS volume {luks} ({tokens}) are bound to the old hardware and are not restored; set them up again after the start.",
	WarnKeyfileRegenerated:            "The key file {path} of LUKS volume {luks} is created new; the old one from the backup does not open the new volume.",
	WarnUntestedDistribution:          "{os} is not among the tested distributions; the restore may need manual work after the start.",
	WarnNonSystemdInit:                "{os} starts with {init}, not systemd; the restore may need manual work after the start.",
}

// PlanProblemCodes and PlanWarningCodes are the sorted code lists.
var (
	PlanProblemCodes = sortedCodes("problem")
	PlanWarningCodes = sortedCodes("warning")
)

func sortedCodes(kind string) []string {
	var out []string
	for code := range planMessages {
		if codeIsProblem(code) == (kind == "problem") {
			out = append(out, code)
		}
	}
	sort.Strings(out)
	return out
}

var problemCodes = map[string]bool{
	ProblemLayoutUnsupported: true, ProblemFirmwareModeMismatch: true, ProblemBIOS4Kn: true,
	ProblemTargetMissing: true, ProblemTargetTooSmall: true, ProblemTargetUnusable: true,
	ProblemSEDLocked: true, ProblemMultipathDetected: true, ProblemIdentityConflict: true,
	ProblemStorageDriverMissing: true, ProblemSecureBootCAMissing: true, ProblemSecureBootRevoked: true,
	ProblemSecureBootSbatRevoked: true, ProblemMokKeyMissing: true, ProblemMkfsUnsupportedType: true,
	ProblemMkfsFeatureUnknown: true, ProblemSectorSizeIncompatible: true, ProblemMDTooFewMembers: true,
	ProblemLVMRaidMissingPV: true, ProblemBtrfsRaidMissingDevice: true, ProblemShrinkNeedsConfirmation: true,
	ProblemAdoptIncomplete: true, ProblemMappingInvalid: true,
}

func codeIsProblem(code string) bool { return problemCodes[code] }

// Finding is a problem or a warning of the planner.
type Finding struct {
	Code     string         `json:"code"`
	Severity string         `json:"severity"`
	Ref      *string        `json:"ref"`
	Message  string         `json:"message"`
	Params   map[string]any `json:"params"`
}

// newFinding builds a finding of code with params given as name, value
// pairs; the severity follows from the code.
func newFinding(code string, ref string, kv ...any) Finding {
	params := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		params[kv[i].(string)] = kv[i+1]
	}
	sev := FindingWarning
	if codeIsProblem(code) {
		sev = FindingProblem
	}
	f := Finding{Code: code, Severity: sev, Message: renderMessage(code, params), Params: params}
	if ref != "" {
		f.Ref = &ref
	}
	return f
}

// renderMessage fills the template of code with params.
func renderMessage(code string, params map[string]any) string {
	tmpl, ok := planMessages[code]
	if !ok {
		return code
	}
	var b strings.Builder
	for {
		i := strings.IndexByte(tmpl, '{')
		if i < 0 {
			b.WriteString(tmpl)
			break
		}
		j := strings.IndexByte(tmpl[i:], '}')
		if j < 0 {
			b.WriteString(tmpl)
			break
		}
		b.WriteString(tmpl[:i])
		name := tmpl[i+1 : i+j]
		b.WriteString(paramText(params[name]))
		tmpl = tmpl[i+j+1:]
	}
	return cleanString(b.String(), 8000)
}

func paramText(v any) string {
	switch t := v.(type) {
	case nil:
		return "?"
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case bool:
		return strconv.FormatBool(t)
	case []string:
		return strings.Join(t, ", ")
	}
	return fmt.Sprint(v)
}

// osName names the system for messages: PRETTY_NAME, else ID and version.
func osName(o *OSInfo) string {
	if o.PrettyName != nil && *o.PrettyName != "" {
		return *o.PrettyName
	}
	if o.VersionID != nil && *o.VersionID != "" {
		return o.ID + " " + *o.VersionID
	}
	return o.ID
}
