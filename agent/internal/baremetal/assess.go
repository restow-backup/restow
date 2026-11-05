package baremetal

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

// Codes of Assess (docs/BAREMETAL.md, 4.4; contract C1).
const (
	CodeFSTypeUnsupported       = "fs_type_unsupported"
	CodeLVMTypeUnsupported      = "lvm_type_unsupported"
	CodeMDContainerUnsupported  = "md_container_unsupported"
	CodeMDJournalUnsupported    = "md_journal_unsupported"
	CodeMDReshapeInProgress     = "md_reshape_in_progress"
	CodeMultipathUnsupported    = "multipath_unsupported"
	CodeIntegrityUnsupported    = "integrity_unsupported"
	CodeLUKSDetachedHeader      = "luks_detached_header"
	CodeNetworkRootUnsupported  = "network_root_unsupported"
	CodeXFSExternalLog          = "xfs_external_log"
	CodeBootloaderUnsupported   = "bootloader_unsupported"
	CodeInitramfsUnsupported    = "initramfs_unsupported"
	CodeUKIWithoutGenerator     = "uki_without_generator"
	CodeUnknownDeviceInBootPath = "unknown_device_in_boot_path"
	CodeContainer               = "container"
	CodeFstabUnresolvable       = "fstab_unresolvable"
	CodeLUKSToken               = "luks_token"
	CodeSnapshotSubvolumes      = "snapshot_subvolumes"
	CodeLVMSnapshotLVs          = "lvm_snapshot_lvs"
	CodeRawLVs                  = "raw_lvs"
	CodePVEGuestVolumes         = "pve_guest_volumes"
	CodeDockerBtrfsMany         = "docker_btrfs_many"
	CodeDataFSUnsupported       = "data_fs_unsupported"
	CodeUntestedDistribution    = "untested_distribution"
	CodeNonSystemdInit          = "non_systemd_init"
	CodeSecureBootOwnKeys       = "secure_boot_own_keys"
	CodeDKMSMok                 = "dkms_mok"
	CodeBIOSNeedsCSM            = "bios_needs_csm"
	CodeDualBootWindows         = "dual_boot_windows"
	CodeLVMDeviceIDs            = "lvm_device_ids"
	CodeDeviceNameRefs          = "device_name_refs"
	CodeMDDegraded              = "md_degraded"
	CodeCaptureFailed           = "capture_failed"
)

// UnsupportedCodes and WarningCodes list every code by severity.
var (
	UnsupportedCodes = []string{CodeFSTypeUnsupported, CodeLVMTypeUnsupported, CodeMDContainerUnsupported,
		CodeMDJournalUnsupported, CodeMDReshapeInProgress, CodeMultipathUnsupported, CodeIntegrityUnsupported,
		CodeLUKSDetachedHeader, CodeNetworkRootUnsupported, CodeXFSExternalLog, CodeBootloaderUnsupported,
		CodeInitramfsUnsupported, CodeUKIWithoutGenerator, CodeUnknownDeviceInBootPath, CodeContainer,
		CodeFstabUnresolvable}
	WarningCodes = []string{CodeLUKSToken, CodeSnapshotSubvolumes, CodeLVMSnapshotLVs, CodeRawLVs,
		CodePVEGuestVolumes, CodeDockerBtrfsMany, CodeDataFSUnsupported, CodeUntestedDistribution,
		CodeNonSystemdInit, CodeSecureBootOwnKeys, CodeDKMSMok, CodeBIOSNeedsCSM, CodeDualBootWindows,
		CodeLVMDeviceIDs, CodeDeviceNameRefs, CodeMDDegraded, CodeCaptureFailed}
)

// captureOnlyCodes come from the collectors (what the manifest cannot show
// on its own); Assess keeps them and derives every other code afresh.
var captureOnlyCodes = map[string]bool{
	CodeMultipathUnsupported: true, CodeIntegrityUnsupported: true, CodeLUKSDetachedHeader: true,
	CodeUnknownDeviceInBootPath: true, CodeContainer: true, CodeCaptureFailed: true,
}

// SupportedFSTypes are the file systems a restore can create (2.1).
var SupportedFSTypes = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "vfat": true}

// unsupportedFSTypes are block file systems 0.5.0 cannot recreate (2.2).
var unsupportedFSTypes = map[string]bool{"zfs": true, "bcachefs": true, "f2fs": true, "ntfs": true, "ntfs3": true, "fuseblk": true}

// networkFSTypes are file systems over the network.
var networkFSTypes = map[string]bool{"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "ceph": true, "glusterfs": true, "9p": true, "sshfs": true, "fuse.sshfs": true}

// testedDistributions are the os-release IDs tested in CI and on hardware (2.1).
var testedDistributions = map[string]bool{"debian": true, "ubuntu": true, "almalinux": true, "rhel": true,
	"rocky": true, "ol": true, "centos": true, "fedora": true, "opensuse-leap": true, "arch": true}

// systemPaths are the mount points of the running system (as opposed to data).
var systemPaths = map[string]bool{"/": true, "/boot": true, "/boot/efi": true, "/efi": true, "/usr": true, "/var": true}

// IsSystemPath reports whether target is a system mount point.
func IsSystemPath(target string) bool { return systemPaths[path.Clean(target)] }

var assessMessages = map[string]string{
	CodeFSTypeUnsupported:       "file system type %s on a system path cannot be restored",
	CodeLVMTypeUnsupported:      "LVM volume type %s (cache, writecache, VDO) cannot be restored",
	CodeMDContainerUnsupported:  "md container metadata (IMSM, DDF) cannot be restored",
	CodeMDJournalUnsupported:    "md array with journal or PPL cannot be restored",
	CodeMDReshapeInProgress:     "md array was being reshaped when the layout was captured",
	CodeNetworkRootUnsupported:  "the root file system is on the network",
	CodeXFSExternalLog:          "XFS with an external log or realtime device cannot be restored",
	CodeBootloaderUnsupported:   "boot loader %s is not supported",
	CodeInitramfsUnsupported:    "initramfs generator is not supported",
	CodeUKIWithoutGenerator:     "unified kernel image without a generator in the system",
	CodeFstabUnresolvable:       "fstab entry for %s does not resolve to a device of this machine",
	CodeLUKSToken:               "LUKS volume has %s tokens; they must be enrolled again after a restore",
	CodeSnapshotSubvolumes:      "Snapper or Timeshift subvolumes are recreated empty",
	CodeLVMSnapshotLVs:          "LVM snapshot volumes are not restored",
	CodeRawLVs:                  "logical volumes without a file system are not backed up",
	CodePVEGuestVolumes:         "Proxmox VE guest volumes are not backed up here; use the PVE integration",
	CodeDockerBtrfsMany:         "%d container image subvolumes (btrfs storage driver)",
	CodeDataFSUnsupported:       "data file system %s (%s) is backed up but not recreated",
	CodeUntestedDistribution:    "distribution %s is not tested",
	CodeNonSystemdInit:          "the init system is not systemd",
	CodeSecureBootOwnKeys:       "Secure Boot with a boot chain or kernel signed by own keys",
	CodeDKMSMok:                 "DKMS modules signed with a machine owner key",
	CodeBIOSNeedsCSM:            "BIOS boot: replacement hardware needs CSM or legacy boot",
	CodeDualBootWindows:         "Windows in dual boot is not restored",
	CodeLVMDeviceIDs:            "LVM devices file or filter with device names is adjusted on restore",
	CodeDeviceNameRefs:          "kernel device names in configuration files",
	CodeMDDegraded:              "md array %s was degraded when the layout was captured",
	CodeMultipathUnsupported:    "multipath devices cannot be restored",
	CodeIntegrityUnsupported:    "dm-integrity or LUKS2 with integrity cannot be restored",
	CodeLUKSDetachedHeader:      "LUKS volume with a detached header cannot be restored",
	CodeUnknownDeviceInBootPath: "an unknown device is in the path to /, /boot or the ESP",
	CodeContainer:               "the machine is a container; it has no disks of its own",
	CodeCaptureFailed:           "part of the layout could not be read",
}

func finding(code string, ref *string, severity string, args ...any) Unsupported {
	msg := assessMessages[code]
	if len(args) > 0 {
		msg = fmt.Sprintf(msg, args...)
	}
	return Unsupported{Code: code, Ref: ref, Message: cleanString(msg, maxStringBytes), Severity: severity}
}

// Assess rates a manifest (docs/BAREMETAL.md, 4.4): the list of what cannot
// be restored (severity unsupported) or needs attention (warning), and the
// verdict from it. Entries only the collectors can find (capture_failed,
// container, multipath, ...) are kept from m; the rest is derived again.
// Darwin layouts are supported with no entries in this version.
func Assess(m *Manifest) (string, []Unsupported) {
	if m.Linux == nil {
		return VerdictSupported, []Unsupported{}
	}
	l := m.Linux
	var out []Unsupported
	for _, u := range l.Unsupported {
		if captureOnlyCodes[u.Code] {
			out = append(out, u)
		}
	}
	bad := func(code string, ref *string, args ...any) {
		out = append(out, finding(code, ref, SeverityUnsupported, args...))
	}
	warn := func(code string, ref *string, args ...any) {
		out = append(out, finding(code, ref, SeverityWarning, args...))
	}

	for _, mo := range l.Mounts {
		if mo.Autofs {
			continue
		}
		switch {
		case networkFSTypes[mo.Type] && path.Clean(mo.Target) == "/":
			bad(CodeNetworkRootUnsupported, strPtr(mo.Target))
		case unsupportedFSTypes[mo.Type] && IsSystemPath(mo.Target):
			bad(CodeFSTypeUnsupported, strPtr(mo.Target), mo.Type)
		case !SupportedFSTypes[mo.Type] && !networkFSTypes[mo.Type] && mo.FS != nil:
			warn(CodeDataFSUnsupported, strPtr(mo.Target), mo.Target, mo.Type)
		}
	}
	if strings.Contains(" "+l.OS.Cmdline+" ", " root=/dev/nfs ") || strings.Contains(" "+l.OS.Cmdline, " netroot=") {
		if !hasCode(out, CodeNetworkRootUnsupported) {
			bad(CodeNetworkRootUnsupported, strPtr("/"))
		}
	}
	snapLV := false
	raw := false
	for _, vg := range l.LVM.VGs {
		for _, lv := range vg.LVs {
			ref := strPtr(vg.Name + "/" + lv.Name)
			switch lv.Type {
			case "cache", "cache-pool", "writecache", "vdo", "vdo-pool":
				bad(CodeLVMTypeUnsupported, ref, lv.Type)
			}
			if lv.Origin != nil && !hasTag(lv.Tags, "restow-agent-snapshot") {
				snapLV = true
			}
			if lv.Raw {
				raw = true
			}
		}
	}
	if snapLV {
		warn(CodeLVMSnapshotLVs, nil)
	}
	if raw {
		if l.OS.ProxmoxVE {
			warn(CodePVEGuestVolumes, nil)
		} else {
			warn(CodeRawLVs, nil)
		}
	}
	for _, md := range l.MD {
		ref := strPtr(md.ID)
		meta := strings.ToLower(md.Metadata)
		switch {
		case meta == "imsm" || meta == "ddf" || strings.HasPrefix(meta, "external") || md.Level == "container":
			bad(CodeMDContainerUnsupported, ref)
		}
		if md.Journal {
			bad(CodeMDJournalUnsupported, ref)
		}
		state := strings.ToLower(md.State)
		if strings.Contains(state, "reshap") {
			bad(CodeMDReshapeInProgress, ref)
		}
		if strings.Contains(state, "degraded") {
			warn(CodeMDDegraded, ref, md.KName)
		}
	}
	tokens := false
	for _, c := range l.LUKS {
		if c.Integrity != nil && !hasCode(out, CodeIntegrityUnsupported) {
			bad(CodeIntegrityUnsupported, strPtr(c.ID))
		}
		if len(c.TokenTypes) > 0 && !tokens {
			tokens = true
			warn(CodeLUKSToken, strPtr(c.ID), strings.Join(c.TokenTypes, ", "))
		}
	}
	snapSub := false
	docker := 0
	for _, fs := range l.Filesystems {
		if fs.XFS != nil && (fs.XFS.ExternalLog || fs.XFS.Realtime) {
			bad(CodeXFSExternalLog, strPtr(fs.ID))
		}
		if fs.Btrfs != nil {
			for _, s := range fs.Btrfs.Subvolumes {
				switch s.Kind {
				case SubvolSnapper, SubvolTimeshift:
					snapSub = true
				case SubvolDocker:
					docker++
				}
			}
		}
	}
	if snapSub {
		warn(CodeSnapshotSubvolumes, nil)
	}
	if docker > 200 {
		warn(CodeDockerBtrfsMany, nil, docker)
	}
	switch l.Bootloader.Kind {
	case "grub", "systemd-boot":
	default:
		if !hasCode(out, CodeContainer) {
			bad(CodeBootloaderUnsupported, nil, l.Bootloader.Kind)
		}
	}
	gen := deref(l.Initramfs.Generator)
	if (gen == "" || gen == "other") && !hasCode(out, CodeContainer) {
		bad(CodeInitramfsUnsupported, nil)
	}
	uki := false
	for _, ld := range l.Loaders {
		uki = uki || ld.UKI
	}
	for _, k := range l.Kernels {
		uki = uki || k.UKI
	}
	if uki && !l.Initramfs.UKIPresets && deref(l.Initramfs.KernelInstallLayout) != "uki" {
		bad(CodeUKIWithoutGenerator, nil)
	}
	for _, e := range l.Fstab {
		if e.Resolved == nil && IsSystemPath(e.Target) && localSource(e.Source, e.Type) {
			bad(CodeFstabUnresolvable, strPtr(e.Target), e.Target)
		}
	}
	if !testedDistributions[l.OS.ID] {
		warn(CodeUntestedDistribution, strPtr(l.OS.ID), l.OS.ID)
	}
	if l.OS.Init != "systemd" {
		warn(CodeNonSystemdInit, nil)
	}
	if l.Firmware.SecureBoot != nil && *l.Firmware.SecureBoot && ownKeys(l) {
		warn(CodeSecureBootOwnKeys, nil)
	}
	if len(l.DKMS) > 0 && (len(l.Firmware.MOK) > 0 || len(l.MokFiles) > 0) {
		for _, d := range l.DKMS {
			if d.Signer != nil {
				warn(CodeDKMSMok, nil)
				break
			}
		}
	}
	if l.Firmware.Mode == "bios" && !hasCode(out, CodeContainer) {
		warn(CodeBIOSNeedsCSM, nil)
	}
	if dualBootWindows(l) {
		warn(CodeDualBootWindows, nil)
	}
	if l.LVM.UseDevicesFile || l.LVM.FilterHasDeviceNames {
		warn(CodeLVMDeviceIDs, nil)
	}
	if len(l.DeviceNameRefs) > 0 {
		warn(CodeDeviceNameRefs, nil)
	}

	if len(out) > maxUnsupported {
		out = out[:maxUnsupported]
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Severity != out[j].Severity {
			return out[i].Severity == SeverityUnsupported
		}
		return false
	})
	verdict := VerdictSupported
	for _, u := range out {
		if u.Severity == SeverityUnsupported {
			verdict = VerdictUnsupported
			break
		}
		verdict = VerdictSupportedWithWarnings
	}
	if out == nil {
		out = []Unsupported{}
	}
	return verdict, out
}

func hasCode(list []Unsupported, code string) bool {
	for _, u := range list {
		if u.Code == code {
			return true
		}
	}
	return false
}

func hasTag(tags []string, t string) bool {
	for _, x := range tags {
		if x == t {
			return true
		}
	}
	return false
}

// localSource reports whether an fstab source names a local block device.
func localSource(source, fstype string) bool {
	if networkFSTypes[fstype] || fstype == "tmpfs" || fstype == "none" || fstype == "bind" {
		return false
	}
	for _, p := range []string{"UUID=", "LABEL=", "PARTUUID=", "PARTLABEL=", "/dev/"} {
		if strings.HasPrefix(source, p) {
			return true
		}
	}
	return false
}

// ownKeys: Secure Boot runs a first-stage loader not signed by Microsoft,
// or a kernel signed by a machine owner key.
func ownKeys(l *LinuxLayout) bool {
	for _, ld := range l.Loaders {
		base := strings.ToLower(path.Base(ld.Path))
		firstStage := strings.HasPrefix(base, "shim") || base == "bootx64.efi" || base == "bootaa64.efi" ||
			(!l.Bootloader.Shim && (strings.HasPrefix(base, "grub") || strings.HasPrefix(base, "systemd-boot") || ld.UKI))
		if firstStage && ld.Signer != nil && !strings.Contains(ld.Signer.Issuer, "Microsoft") {
			return true
		}
	}
	for _, k := range l.Kernels {
		if k.Signer == nil {
			continue
		}
		for _, mok := range l.Firmware.MOK {
			if mok.Subject != nil && strings.Contains(*mok.Subject, *k.Signer) {
				return true
			}
		}
	}
	return false
}

// msReservedGUID is the GPT type of the Microsoft reserved partition.
const msReservedGUID = "e3c9e316-0b5c-4db8-817d-f92df00215ae"

func dualBootWindows(l *LinuxLayout) bool {
	for _, ld := range l.Loaders {
		if strings.Contains(strings.ToLower(ld.Path), "/efi/microsoft/boot/bootmgfw.efi") {
			return true
		}
	}
	for _, d := range l.Disks {
		if d.Table == nil {
			continue
		}
		for _, p := range d.Table.Partitions {
			if strings.EqualFold(p.Type, msReservedGUID) {
				return true
			}
		}
	}
	for _, e := range l.Firmware.Entries {
		if strings.Contains(e.Label, "Windows Boot Manager") {
			return true
		}
	}
	return false
}
