// Package baremetal captures the disk layout of a machine (docs/BAREMETAL.md,
// section 4): the layout manifest restow-layout-v1, its canonical encoding,
// validation, assessment and fingerprint, and the collectors that read it
// from a Linux system. The manifest describes the storage stack (disks,
// partition tables, md, LUKS, LVM, file systems), the boot chain and what a
// whole-machine backup backed up; it never holds secrets (keys, keyslot data,
// digests, salts, token contents, secret kernel parameters).
package baremetal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// Format and SchemaVersion of the manifest (contract C1).
const (
	Format        = "restow-layout-v1"
	SchemaVersion = 1
)

// Platforms of a manifest.
const (
	PlatformLinux  = "linux"
	PlatformDarwin = "darwin"
)

// Verdicts of Assess.
const (
	VerdictSupported             = "supported"
	VerdictSupportedWithWarnings = "supported_with_warnings"
	VerdictUnsupported           = "unsupported"
)

// Severities of an Unsupported entry.
const (
	SeverityUnsupported = "unsupported"
	SeverityWarning     = "warning"
)

// ErrTooLarge is returned by Encode when the canonical encoding exceeds
// MaxLayoutBytes; the bytes are returned with it.
var ErrTooLarge = errors.New("the layout manifest is larger than 512 KiB")

// Header is common to both platforms.
type Header struct {
	Format        string `json:"format"`
	SchemaVersion int64  `json:"schemaVersion"`
	Platform      string `json:"platform"`
	// CapturedAt is RFC 3339 in UTC with whole seconds ("2026-11-04T21:00:03Z").
	CapturedAt   string `json:"capturedAt"`
	AgentVersion string `json:"agentVersion"`
	Hostname     string `json:"hostname"`
}

// Manifest is a layout manifest: the header and exactly one of Linux and
// Darwin. On the wire it is one flat object discriminated by platform.
type Manifest struct {
	Header
	Linux  *LinuxLayout
	Darwin *DarwinLayout
}

// BlockRef points at a block device of the manifest; references never use
// device names (contract C1: exactly one shape per kind).
type BlockRef struct {
	Kind   string `json:"kind"`
	Disk   string `json:"disk,omitempty"`
	Number int64  `json:"number,omitempty"`
	ID     string `json:"id,omitempty"`
	VG     string `json:"vg,omitempty"`
	LV     string `json:"lv,omitempty"`
}

// Kinds of a BlockRef.
const (
	RefDisk      = "disk"
	RefPartition = "partition"
	RefMD        = "md"
	RefLUKS      = "luks"
	RefPlain     = "plain"
	RefLV        = "lv"
)

// DiskRef, PartRef, MDRef, LUKSRef, PlainRef and LVRef build references.
func DiskRef(disk string) BlockRef { return BlockRef{Kind: RefDisk, Disk: disk} }
func PartRef(disk string, n int64) BlockRef {
	return BlockRef{Kind: RefPartition, Disk: disk, Number: n}
}
func MDRef(id string) BlockRef     { return BlockRef{Kind: RefMD, ID: id} }
func LUKSRef(id string) BlockRef   { return BlockRef{Kind: RefLUKS, ID: id} }
func PlainRef(id string) BlockRef  { return BlockRef{Kind: RefPlain, ID: id} }
func LVRef(vg, lv string) BlockRef { return BlockRef{Kind: RefLV, VG: vg, LV: lv} }
func (r BlockRef) key() string {
	return fmt.Sprintf("%s|%s|%d|%s|%s|%s", r.Kind, r.Disk, r.Number, r.ID, r.VG, r.LV)
}
func (r BlockRef) equal(o BlockRef) bool { return r == o }
func refPtr(r BlockRef) *BlockRef        { return &r }
func strPtr(s string) *string            { return &s }
func intPtr(n int64) *int64              { return &n }
func boolPtr(b bool) *bool               { return &b }
func trueIf(b bool) *bool {
	if b {
		t := true
		return &t
	}
	return nil
}

// LinuxLayout holds the Linux part of a manifest.
type LinuxLayout struct {
	OS             OSInfo          `json:"os"`
	Firmware       Firmware        `json:"firmware"`
	Loaders        []Loader        `json:"loaders"`
	Disks          []Disk          `json:"disks"`
	MD             []MDArray       `json:"md"`
	LUKS           []LUKSVolume    `json:"luks"`
	PlainCrypt     []PlainCrypt    `json:"plainCrypt"`
	LVM            LVM             `json:"lvm"`
	Filesystems    []Filesystem    `json:"filesystems"`
	Swap           []Swap          `json:"swap"`
	Mounts         []Mount         `json:"mounts"`
	Fstab          []FstabEntry    `json:"fstab"`
	Bootloader     Bootloader      `json:"bootloader"`
	Initramfs      Initramfs       `json:"initramfs"`
	Kernels        []Kernel        `json:"kernels"`
	DKMS           []DKMSModule    `json:"dkms"`
	MokFiles       []FileHash      `json:"mokFiles"`
	Configs        []FileHash      `json:"configs"`
	Network        []NetInterface  `json:"network"`
	NetConfigs     []NetConfigRef  `json:"netConfigs"`
	DeviceNameRefs []DeviceNameRef `json:"deviceNameRefs"`
	Backup         Backup          `json:"backup"`
	Agent          AgentInfo       `json:"agent"`
	Unsupported    []Unsupported   `json:"unsupported"`
	Verdict        string          `json:"verdict"`
	Raw            []RawRef        `json:"raw"`
}

// DarwinLayout is the provisional macOS part (M1: loosely typed, so the
// discriminated union exists; the server rejects darwin layouts until M6).
type DarwinLayout struct {
	MacOS        map[string]any   `json:"macos"`
	Users        []map[string]any `json:"users"`
	Applications []map[string]any `json:"applications"`
	Backup       Backup           `json:"backup"`
	Agent        AgentInfo        `json:"agent"`
	Unsupported  []Unsupported    `json:"unsupported"`
	Verdict      string           `json:"verdict"`
	Raw          []RawRef         `json:"raw"`
}

// OSInfo describes the installed system.
type OSInfo struct {
	ID         string   `json:"id"`
	IDLike     []string `json:"idLike"`
	VersionID  *string  `json:"versionId"`
	PrettyName *string  `json:"prettyName"`
	Arch       string   `json:"arch"`
	Kernel     string   `json:"kernel"`
	// Cmdline is /proc/cmdline through RedactCmdline.
	Cmdline   string  `json:"cmdline"`
	SELinux   *string `json:"selinux"`
	Init      string  `json:"init"`
	ProxmoxVE bool    `json:"proxmoxVE"`
	// MachineID: /etc/machine-id exists (its value is not recorded).
	MachineID bool `json:"machineId"`
}

// Firmware is the boot firmware and its Secure Boot state.
type Firmware struct {
	Mode        string     `json:"mode"`
	SecureBoot  *bool      `json:"secureBoot"`
	SetupMode   *bool      `json:"setupMode"`
	Entries     []EFIEntry `json:"entries"`
	BootOrder   []int64    `json:"bootOrder"`
	BootCurrent *int64     `json:"bootCurrent"`
	// SbatLevel holds the lines of SbatLevelRT (empty lines dropped).
	SbatLevel []string  `json:"sbatLevel"`
	DB        []CertRef `json:"db"`
	// DBXSha256 is the SHA-256 over the sorted EFI_CERT_SHA256 entries of dbx.
	DBXSha256 *string  `json:"dbxSha256"`
	MOK       []MokRef `json:"mok"`
}

// EFIEntry is one Boot#### variable.
type EFIEntry struct {
	Num        int64   `json:"num"`
	Label      string  `json:"label"`
	PartUUID   *string `json:"partuuid"`
	PartNumber *int64  `json:"partNumber"`
	Loader     *string `json:"loader"`
	Active     bool    `json:"active"`
}

// CertRef is an X.509 certificate in db.
type CertRef struct {
	Subject string `json:"subject"`
	SHA256  string `json:"sha256"`
}

// MokRef is an entry of MokListRT.
type MokRef struct {
	Subject *string `json:"subject"`
	SHA256  string  `json:"sha256"`
}

// Loader is a PE file on an ESP or XBOOTLDR.
type Loader struct {
	Path               string   `json:"path"`
	Bytes              int64    `json:"bytes"`
	AuthenticodeSha256 string   `json:"authenticodeSha256"`
	Signer             *Signer  `json:"signer"`
	Sbat               []string `json:"sbat"`
	UKI                bool     `json:"uki"`
	UKICmdline         *string  `json:"ukiCmdline"`
}

// Signer identifies the certificate that signed a PE file.
type Signer struct {
	Issuer  string `json:"issuer"`
	Subject string `json:"subject"`
	Serial  string `json:"serial"`
}

// Disk is a whole block device.
type Disk struct {
	ID                 string          `json:"id"`
	KName              string          `json:"kname"`
	SizeBytes          int64           `json:"sizeBytes"`
	LogicalSectorSize  int64           `json:"logicalSectorSize"`
	PhysicalSectorSize int64           `json:"physicalSectorSize"`
	Model              *string         `json:"model"`
	Serial             *string         `json:"serial"`
	WWN                *string         `json:"wwn"`
	EUI64              *string         `json:"eui64"`
	NGUID              *string         `json:"nguid"`
	NSID               *int64          `json:"nsid"`
	Transport          *string         `json:"transport"`
	Rotational         bool            `json:"rotational"`
	Removable          bool            `json:"removable"`
	ReadOnly           bool            `json:"readOnly"`
	Zoned              string          `json:"zoned"`
	MajMin             string          `json:"majMin"`
	BootCode           string          `json:"bootCode"`
	PMBRBoot           bool            `json:"pmbrBoot"`
	DriverChain        []string        `json:"driverChain"`
	DriverModaliases   []string        `json:"driverModaliases"`
	Table              *PartitionTable `json:"table"`
}

// PartitionTable is a GPT or DOS partition table.
type PartitionTable struct {
	Type        string      `json:"type"`
	ID          string      `json:"id"`
	SectorSize  int64       `json:"sectorSize"`
	FirstLBA    *int64      `json:"firstLba"`
	LastLBA     *int64      `json:"lastLba"`
	TableLength *int64      `json:"tableLength"`
	Partitions  []Partition `json:"partitions"`
}

// Partition is one entry of a partition table.
type Partition struct {
	Number     int64   `json:"number"`
	StartBytes int64   `json:"startBytes"`
	SizeBytes  int64   `json:"sizeBytes"`
	Type       string  `json:"type"`
	UUID       *string `json:"uuid"`
	Name       *string `json:"name"`
	Attrs      string  `json:"attrs"`
	Bootable   bool    `json:"bootable"`
	Grow       *bool   `json:"grow,omitempty"`
}

// MDArray is a Linux software RAID.
type MDArray struct {
	ID          string     `json:"id"`
	Name        *string    `json:"name"`
	KName       string     `json:"kname"`
	UUID        string     `json:"uuid"`
	Level       string     `json:"level"`
	Metadata    string     `json:"metadata"`
	ChunkBytes  *int64     `json:"chunkBytes"`
	Layout      *string    `json:"layout"`
	RaidDevices int64      `json:"raidDevices"`
	SizeBytes   int64      `json:"sizeBytes"`
	Members     []MDMember `json:"members"`
	Spares      []BlockRef `json:"spares"`
	Bitmap      string     `json:"bitmap"`
	Homehost    *string    `json:"homehost"`
	State       string     `json:"state"`
	Journal     bool       `json:"journal"`
}

// MDMember is an active member of an md array.
type MDMember struct {
	Device      BlockRef `json:"device"`
	Role        *int64   `json:"role"`
	WriteMostly bool     `json:"writeMostly"`
	State       string   `json:"state"`
}

// LUKSVolume is a LUKS container (its sanitized header facts).
type LUKSVolume struct {
	ID           string   `json:"id"`
	Device       BlockRef `json:"device"`
	Version      int64    `json:"version"`
	UUID         string   `json:"uuid"`
	Label        *string  `json:"label"`
	Subsystem    *string  `json:"subsystem"`
	Cipher       string   `json:"cipher"`
	KeyBits      int64    `json:"keyBits"`
	SectorSize   int64    `json:"sectorSize"`
	PBKDF        PBKDF    `json:"pbkdf"`
	Keyslots     int64    `json:"keyslots"`
	TokenTypes   []string `json:"tokenTypes"`
	Flags        []string `json:"flags"`
	Requirements []string `json:"requirements"`
	Integrity    *string  `json:"integrity"`
	KeyFile      *string  `json:"keyFile"`
	MappedName   *string  `json:"mappedName"`
	CrypttabName *string  `json:"crypttabName"`
}

// PBKDF is the key derivation of the first keyslot.
type PBKDF struct {
	Type       string `json:"type"`
	Iterations *int64 `json:"iterations"`
	MemoryKiB  *int64 `json:"memoryKiB"`
	Time       *int64 `json:"time"`
	Parallel   *int64 `json:"parallel"`
}

// PlainCrypt is a dm-crypt mapping without a LUKS header (swap, tmp).
type PlainCrypt struct {
	ID           string   `json:"id"`
	Device       BlockRef `json:"device"`
	PartUUID     *string  `json:"partuuid"`
	MappedName   string   `json:"mappedName"`
	Cipher       string   `json:"cipher"`
	KeyBits      int64    `json:"keyBits"`
	Purpose      string   `json:"purpose"`
	KeySource    string   `json:"keySource"`
	CrypttabName *string  `json:"crypttabName"`
}

// LVM holds physical volumes, volume groups and the device settings.
type LVM struct {
	UseDevicesFile       bool          `json:"useDevicesFile"`
	DevicesFileIDTypes   []string      `json:"devicesFileIdTypes"`
	FilterHasDeviceNames bool          `json:"filterHasDeviceNames"`
	AllowMixedBlockSizes bool          `json:"allowMixedBlockSizes"`
	PVs                  []PV          `json:"pvs"`
	VGs                  []VolumeGroup `json:"vgs"`
}

// PV is an LVM physical volume.
type PV struct {
	Device    BlockRef `json:"device"`
	UUID      string   `json:"uuid"`
	SizeBytes int64    `json:"sizeBytes"`
	VG        *string  `json:"vg"`
}

// VolumeGroup is an LVM volume group. SizeBytes and FreeBytes are volatile
// (not part of the fingerprint); the free space drives the snapshot hint.
type VolumeGroup struct {
	Name        string          `json:"name"`
	UUID        string          `json:"uuid"`
	ExtentBytes int64           `json:"extentBytes"`
	SizeBytes   int64           `json:"sizeBytes"`
	FreeBytes   int64           `json:"freeBytes"`
	SystemID    *string         `json:"systemId"`
	LVs         []LogicalVolume `json:"lvs"`
}

// LogicalVolume is an LVM logical volume.
type LogicalVolume struct {
	Name          string   `json:"name"`
	UUID          string   `json:"uuid"`
	Type          string   `json:"type"`
	SizeBytes     int64    `json:"sizeBytes"`
	Stripes       *int64   `json:"stripes"`
	StripeBytes   *int64   `json:"stripeBytes"`
	Pool          *string  `json:"pool"`
	Origin        *string  `json:"origin"`
	VirtualBytes  *int64   `json:"virtualBytes"`
	ChunkBytes    *int64   `json:"chunkBytes"`
	MetadataBytes *int64   `json:"metadataBytes"`
	Tags          []string `json:"tags"`
	Active        bool     `json:"active"`
	// Raw: neither mounted nor swap nor a PV or LUKS carrier (guest disks).
	Raw  bool  `json:"raw"`
	Grow *bool `json:"grow,omitempty"`
}

// Filesystem is a file system on one device (btrfs: on all its devices).
type Filesystem struct {
	ID         string     `json:"id"`
	Devices    []BlockRef `json:"devices"`
	Type       string     `json:"type"`
	UUID       *string    `json:"uuid"`
	UUIDSub    *string    `json:"uuidSub"`
	Label      *string    `json:"label"`
	SizeBytes  int64      `json:"sizeBytes"`
	UsedBytes  int64      `json:"usedBytes"`
	InodesUsed *int64     `json:"inodesUsed"`
	Ext        *ExtInfo   `json:"ext,omitempty"`
	XFS        *XFSInfo   `json:"xfs,omitempty"`
	Btrfs      *BtrfsInfo `json:"btrfs,omitempty"`
	VFAT       *VFATInfo  `json:"vfat,omitempty"`
}

// ExtInfo are the mkfs parameters of ext2/3/4.
type ExtInfo struct {
	BlockSize       int64    `json:"blockSize"`
	InodeSize       int64    `json:"inodeSize"`
	InodeCount      int64    `json:"inodeCount"`
	Features        []string `json:"features"`
	ReservedPercent int64    `json:"reservedPercent"`
	FlexBgSize      *int64   `json:"flexBgSize"`
	JournalBytes    *int64   `json:"journalBytes"`
}

// XFSInfo are the mkfs parameters of XFS.
type XFSInfo struct {
	BlockSize   int64    `json:"blockSize"`
	SectorSize  int64    `json:"sectorSize"`
	AGCount     int64    `json:"agCount"`
	Features    []string `json:"features"`
	LogBytes    int64    `json:"logBytes"`
	ExternalLog bool     `json:"externalLog"`
	Realtime    bool     `json:"realtime"`
}

// BtrfsInfo describes a btrfs file system and its subvolumes.
type BtrfsInfo struct {
	DataProfile      string      `json:"dataProfile"`
	MetadataProfile  string      `json:"metadataProfile"`
	SystemProfile    string      `json:"systemProfile"`
	NodeSize         int64       `json:"nodeSize"`
	SectorSize       int64       `json:"sectorSize"`
	Features         []string    `json:"features"`
	Quota            bool        `json:"quota"`
	DefaultSubvolume SubvolRef   `json:"defaultSubvolume"`
	Subvolumes       []Subvolume `json:"subvolumes"`
	NoCowDirs        []string    `json:"noCowDirs"`
}

// SubvolRef names a subvolume by id and path.
type SubvolRef struct {
	ID   int64  `json:"id"`
	Path string `json:"path"`
}

// Subvolume is one btrfs subvolume.
type Subvolume struct {
	ID         int64    `json:"id"`
	Path       string   `json:"path"`
	ParentID   int64    `json:"parentId"`
	UUID       string   `json:"uuid"`
	ParentUUID *string  `json:"parentUuid"`
	ReadOnly   bool     `json:"readOnly"`
	Mounted    []string `json:"mounted"`
	Kind       string   `json:"kind"`
}

// Kinds of a subvolume.
const (
	SubvolNormal    = "normal"
	SubvolSnapper   = "snapper"
	SubvolTimeshift = "timeshift"
	SubvolDocker    = "docker"
	SubvolMachines  = "machines"
	SubvolRestow    = "restow"
)

// VFATInfo are the mkfs parameters of FAT.
type VFATInfo struct {
	FatBits           int64  `json:"fatBits"`
	VolumeID          string `json:"volumeId"`
	SectorsPerCluster int64  `json:"sectorsPerCluster"`
	LogicalSectorSize int64  `json:"logicalSectorSize"`
}

// Swap is an active swap area. Priority is decimal text (it may be negative).
type Swap struct {
	Kind         string    `json:"kind"`
	Device       *BlockRef `json:"device"`
	Path         *string   `json:"path"`
	FS           *string   `json:"fs"`
	UUID         *string   `json:"uuid"`
	Label        *string   `json:"label"`
	SizeBytes    int64     `json:"sizeBytes"`
	Priority     string    `json:"priority"`
	ResumeOffset *int64    `json:"resumeOffset"`
}

// Mount is an entry of /proc/self/mountinfo.
type Mount struct {
	Target   string  `json:"target"`
	FS       *string `json:"fs"`
	Source   string  `json:"source"`
	Type     string  `json:"type"`
	Options  string  `json:"options"`
	Subvol   *string `json:"subvol"`
	SubvolID *int64  `json:"subvolId"`
	Autofs   bool    `json:"autofs"`
}

// FstabEntry is a line of /etc/fstab or a systemd mount/swap unit.
type FstabEntry struct {
	Source    string         `json:"source"`
	Target    string         `json:"target"`
	Type      string         `json:"type"`
	Options   string         `json:"options"`
	Origin    string         `json:"origin"`
	Unit      *string        `json:"unit"`
	Noauto    bool           `json:"noauto"`
	Nofail    bool           `json:"nofail"`
	Automount bool           `json:"automount"`
	Resolved  *FstabResolved `json:"resolved"`
}

// FstabResolved is what an fstab source resolved to: a file system id, an
// index into swap, or a block device.
type FstabResolved struct {
	FS    *string   `json:"fs,omitempty"`
	Swap  *int64    `json:"swap,omitempty"`
	Block *BlockRef `json:"block,omitempty"`
}

// Bootloader describes the installed boot loader.
type Bootloader struct {
	Kind            string   `json:"kind"`
	Platform        *string  `json:"platform"`
	BLS             bool     `json:"bls"`
	Shim            bool     `json:"shim"`
	ESPs            []string `json:"esps"`
	XBootLdr        *string  `json:"xbootldr"`
	EFIDirectory    *string  `json:"efiDirectory"`
	BootloaderID    *string  `json:"bootloaderId"`
	GrubCfg         *string  `json:"grubCfg"`
	BIOSDisks       []string `json:"biosDisks"`
	DeviceMap       bool     `json:"deviceMap"`
	ProxmoxBootTool bool     `json:"proxmoxBootTool"`
	FallbackChain   bool     `json:"fallbackChain"`
}

// Initramfs describes the initramfs generator and its keymap.
type Initramfs struct {
	Generator           *string  `json:"generator"`
	Hostonly            *bool    `json:"hostonly"`
	Modules             *string  `json:"modules"`
	UKIPresets          bool     `json:"ukiPresets"`
	KernelInstallLayout *string  `json:"kernelInstallLayout"`
	AddDevices          []string `json:"addDevices"`
	Keymap              Keymap   `json:"keymap"`
}

// Keymap is the effective keyboard layout in the initramfs.
type Keymap struct {
	Layout         *string `json:"layout"`
	Variant        *string `json:"variant"`
	Source         *string `json:"source"`
	InInitramfs    bool    `json:"inInitramfs"`
	GrubCryptodisk bool    `json:"grubCryptodisk"`
}

// Kernel is an installed kernel.
type Kernel struct {
	Version        string  `json:"version"`
	Image          string  `json:"image"`
	Initramfs      *string `json:"initramfs"`
	ImageBytes     int64   `json:"imageBytes"`
	InitramfsBytes *int64  `json:"initramfsBytes"`
	Default        bool    `json:"default"`
	Signer         *string `json:"signer"`
	UKI            bool    `json:"uki"`
}

// DKMSModule is a module built by DKMS.
type DKMSModule struct {
	Module  string  `json:"module"`
	Version string  `json:"version"`
	Kernel  string  `json:"kernel"`
	Signer  *string `json:"signer"`
	Kind    string  `json:"kind"`
}

// FileHash is a path and the SHA-256 of its content.
type FileHash struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// NetInterface is a network interface.
type NetInterface struct {
	Name     string  `json:"name"`
	MAC      *string `json:"mac"`
	Driver   *string `json:"driver"`
	Modalias *string `json:"modalias"`
	PCIPath  *string `json:"pciPath"`
	Physical bool    `json:"physical"`
}

// NetConfigRef is a configuration file that names MAC addresses.
type NetConfigRef struct {
	Path string   `json:"path"`
	MACs []string `json:"macs"`
}

// DeviceNameRef is a kernel device name found in a file below /etc.
type DeviceNameRef struct {
	Path   string `json:"path"`
	Line   int64  `json:"line"`
	Device string `json:"device"`
}

// Backup records what the backup of this snapshot covered: the sources,
// the excludes, the planned snapshot method per source path and why a
// source is read live (contract C1, R5/R6: planned, not the outcome).
type Backup struct {
	Sources     []string          `json:"sources"`
	Excludes    []string          `json:"excludes"`
	FSSnapshots map[string]string `json:"fsSnapshots"`
	LiveReasons map[string]string `json:"liveReasons"`
}

// Values of Backup.FSSnapshots.
const (
	FSSnapLVM   = "lvm"
	FSSnapBtrfs = "btrfs"
	FSSnapLive  = "live"
)

// AgentInfo records agent settings that matter for a restore.
type AgentInfo struct {
	Hooks string `json:"hooks"`
}

// Unsupported is one finding of Assess.
type Unsupported struct {
	Code     string  `json:"code"`
	Ref      *string `json:"ref"`
	Message  string  `json:"message"`
	Severity string  `json:"severity"`
}

// RawRef names a file in raw/ and its SHA-256.
type RawRef struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

// Reserved top-level keys of each platform (contract C1). A manifest of
// one platform must not carry a key reserved only for the other.
var (
	linuxKeys = []string{"os", "firmware", "loaders", "disks", "md", "luks", "plainCrypt", "lvm",
		"filesystems", "swap", "mounts", "fstab", "bootloader", "initramfs", "kernels", "dkms",
		"mokFiles", "configs", "network", "netConfigs", "deviceNameRefs", "backup", "agent",
		"unsupported", "verdict", "raw"}
	darwinKeys = []string{"macos", "users", "applications", "backup", "agent", "unsupported", "verdict", "raw"}
)

func onlyIn(a, b []string) map[string]bool {
	in := map[string]bool{}
	for _, k := range b {
		in[k] = true
	}
	out := map[string]bool{}
	for _, k := range a {
		if !in[k] {
			out[k] = true
		}
	}
	return out
}

var (
	linuxOnlyKeys  = onlyIn(linuxKeys, darwinKeys)
	darwinOnlyKeys = onlyIn(darwinKeys, linuxKeys)
)

// MarshalJSON writes the flat form: header and platform fields in one object.
func (m Manifest) MarshalJSON() ([]byte, error) {
	if (m.Linux == nil) == (m.Darwin == nil) {
		return nil, errors.New("manifest: exactly one of Linux and Darwin must be set")
	}
	out := map[string]json.RawMessage{}
	if err := mergeInto(out, m.Header); err != nil {
		return nil, err
	}
	var body any = m.Linux
	if m.Darwin != nil {
		body = m.Darwin
	}
	if err := mergeInto(out, body); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func mergeInto(out map[string]json.RawMessage, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	var part map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &part); err != nil {
		return err
	}
	for k, v := range part {
		out[k] = v
	}
	return nil
}

// UnmarshalJSON reads the flat form, choosing the platform from "platform".
func (m *Manifest) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	var h Header
	if err := json.Unmarshal(data, &h); err != nil {
		return err
	}
	*m = Manifest{Header: h}
	switch h.Platform {
	case PlatformLinux:
		for k := range keys {
			if darwinOnlyKeys[k] {
				return fmt.Errorf("manifest: a linux manifest must not carry %q", k)
			}
		}
		var l LinuxLayout
		if err := decodeNumbers(data, &l); err != nil {
			return err
		}
		m.Linux = &l
	case PlatformDarwin:
		for k := range keys {
			if linuxOnlyKeys[k] {
				return fmt.Errorf("manifest: a darwin manifest must not carry %q", k)
			}
		}
		var d DarwinLayout
		if err := decodeNumbers(data, &d); err != nil {
			return err
		}
		m.Darwin = &d
	default:
		return fmt.Errorf("manifest: unknown platform %q", h.Platform)
	}
	return nil
}

func decodeNumbers(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return dec.Decode(v)
}

// Encode returns the canonical bytes of the manifest (the content of
// layout.json, the hash input and what the run's finish carries). It
// validates first. Above MaxLayoutBytes it returns the bytes with
// ErrTooLarge.
func (m *Manifest) Encode() ([]byte, error) {
	m.normalize()
	if err := m.Validate(); err != nil {
		return nil, err
	}
	b, err := Canonical(m)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxLayoutBytes {
		return b, ErrTooLarge
	}
	return b, nil
}

// Decode reads and validates a manifest. Every field the schema requires
// must be present (and not null unless nullable); unknown keys are allowed
// (later schema versions only add fields).
func Decode(data []byte) (*Manifest, error) {
	if len(data) > MaxLayoutBytes {
		return nil, ErrTooLarge
	}
	in, err := parseTree(data)
	if err != nil {
		return nil, err
	}
	// The input must itself be encodable canonically: integers only, no
	// forbidden characters.
	if _, err := Canonical(json.RawMessage(data)); err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	m.normalize()
	back, err := toTree(m)
	if err != nil {
		return nil, err
	}
	if err := requirePresent("", in, back); err != nil {
		return nil, err
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// requirePresent checks that every key the typed form writes is in the
// input, and that the input has no null where the typed form has a value.
func requirePresent(path string, in, typed any) error {
	switch t := typed.(type) {
	case map[string]any:
		im, ok := in.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: must be an object", orRoot(path))
		}
		for k, v := range t {
			iv, ok := im[k]
			if !ok {
				return fmt.Errorf("%s: required field missing", join(path, k))
			}
			if err := requirePresent(join(path, k), iv, v); err != nil {
				return err
			}
		}
	case []any:
		ia, ok := in.([]any)
		if !ok {
			return fmt.Errorf("%s: must be a list", orRoot(path))
		}
		if len(ia) != len(t) {
			return fmt.Errorf("%s: list changed in decoding", orRoot(path))
		}
		for i := range t {
			if err := requirePresent(fmt.Sprintf("%s[%d]", path, i), ia[i], t[i]); err != nil {
				return err
			}
		}
	case nil:
		// Nullable: the input may be null or (for maps written as null) anything.
	default:
		if in == nil {
			return fmt.Errorf("%s: must not be null", orRoot(path))
		}
	}
	return nil
}

func join(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

func orRoot(path string) string {
	if path == "" {
		return "manifest"
	}
	return path
}

// normalize turns nil lists and maps into empty ones, so the encoding has
// [] and {} where the schema requires a list or an object.
func (m *Manifest) normalize() {
	if l := m.Linux; l != nil {
		l.OS.IDLike = nonNil(l.OS.IDLike)
		f := &l.Firmware
		f.Entries, f.BootOrder, f.SbatLevel, f.DB, f.MOK = nonNil(f.Entries), nonNil(f.BootOrder), nonNil(f.SbatLevel), nonNil(f.DB), nonNil(f.MOK)
		l.Loaders = nonNil(l.Loaders)
		for i := range l.Loaders {
			l.Loaders[i].Sbat = nonNil(l.Loaders[i].Sbat)
		}
		l.Disks = nonNil(l.Disks)
		for i := range l.Disks {
			d := &l.Disks[i]
			d.DriverChain, d.DriverModaliases = nonNil(d.DriverChain), nonNil(d.DriverModaliases)
			if d.Table != nil {
				d.Table.Partitions = nonNil(d.Table.Partitions)
			}
		}
		l.MD = nonNil(l.MD)
		for i := range l.MD {
			l.MD[i].Members, l.MD[i].Spares = nonNil(l.MD[i].Members), nonNil(l.MD[i].Spares)
		}
		l.LUKS = nonNil(l.LUKS)
		for i := range l.LUKS {
			c := &l.LUKS[i]
			c.TokenTypes, c.Flags, c.Requirements = nonNil(c.TokenTypes), nonNil(c.Flags), nonNil(c.Requirements)
		}
		l.PlainCrypt = nonNil(l.PlainCrypt)
		l.LVM.DevicesFileIDTypes, l.LVM.PVs, l.LVM.VGs = nonNil(l.LVM.DevicesFileIDTypes), nonNil(l.LVM.PVs), nonNil(l.LVM.VGs)
		for i := range l.LVM.VGs {
			vg := &l.LVM.VGs[i]
			vg.LVs = nonNil(vg.LVs)
			for j := range vg.LVs {
				vg.LVs[j].Tags = nonNil(vg.LVs[j].Tags)
			}
		}
		l.Filesystems = nonNil(l.Filesystems)
		for i := range l.Filesystems {
			fs := &l.Filesystems[i]
			fs.Devices = nonNil(fs.Devices)
			if fs.Ext != nil {
				fs.Ext.Features = nonNil(fs.Ext.Features)
			}
			if fs.XFS != nil {
				fs.XFS.Features = nonNil(fs.XFS.Features)
			}
			if b := fs.Btrfs; b != nil {
				b.Features, b.Subvolumes, b.NoCowDirs = nonNil(b.Features), nonNil(b.Subvolumes), nonNil(b.NoCowDirs)
				for j := range b.Subvolumes {
					b.Subvolumes[j].Mounted = nonNil(b.Subvolumes[j].Mounted)
				}
			}
		}
		l.Swap, l.Mounts, l.Fstab = nonNil(l.Swap), nonNil(l.Mounts), nonNil(l.Fstab)
		l.Bootloader.ESPs, l.Bootloader.BIOSDisks = nonNil(l.Bootloader.ESPs), nonNil(l.Bootloader.BIOSDisks)
		l.Initramfs.AddDevices = nonNil(l.Initramfs.AddDevices)
		l.Kernels, l.DKMS, l.MokFiles, l.Configs = nonNil(l.Kernels), nonNil(l.DKMS), nonNil(l.MokFiles), nonNil(l.Configs)
		l.Network, l.NetConfigs, l.DeviceNameRefs = nonNil(l.Network), nonNil(l.NetConfigs), nonNil(l.DeviceNameRefs)
		for i := range l.NetConfigs {
			l.NetConfigs[i].MACs = nonNil(l.NetConfigs[i].MACs)
		}
		normalizeBackup(&l.Backup)
		l.Unsupported, l.Raw = nonNil(l.Unsupported), nonNil(l.Raw)
	}
	if d := m.Darwin; d != nil {
		if d.MacOS == nil {
			d.MacOS = map[string]any{}
		}
		d.Users, d.Applications = nonNil(d.Users), nonNil(d.Applications)
		normalizeBackup(&d.Backup)
		d.Unsupported, d.Raw = nonNil(d.Unsupported), nonNil(d.Raw)
	}
}

func normalizeBackup(b *Backup) {
	b.Sources, b.Excludes = nonNil(b.Sources), nonNil(b.Excludes)
	if b.FSSnapshots == nil {
		b.FSSnapshots = map[string]string{}
	}
	if b.LiveReasons == nil {
		b.LiveReasons = map[string]string{}
	}
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// SHA256Hex is the lowercase hex SHA-256 of canonical bytes.
func SHA256Hex(b []byte) string { return sha256Hex(b) }
