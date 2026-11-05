package recovery

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// HardwareInput is what hardware_linux.go collected from sysfs, lsblk,
// blkid and efivarfs; BuildTarget turns it into the planner's target.
type HardwareInput struct {
	Firmware baremetal.TargetFirmware `json:"firmware"`
	RAMBytes int64                    `json:"ramBytes"`
	Blocks   []BlockInfo              `json:"blocks"`
	// LiveMedium is the kernel name of the disk the ISO started from.
	LiveMedium string                `json:"liveMedium"`
	NICs       []baremetal.TargetNIC `json:"nics"`
}

// BlockInfo is one entry of /sys/block.
type BlockInfo struct {
	KName     string `json:"kname"`
	SizeBytes int64  `json:"sizeBytes"`
	Logical   int64  `json:"logicalSectorSize"`
	Physical  int64  `json:"physicalSectorSize"`
	ReadOnly  bool   `json:"readOnly"`
	Removable bool   `json:"removable"`
	Zoned     string `json:"zoned"`
	Model     string `json:"model"`
	Serial    string `json:"serial"`
	WWN       string `json:"wwn"`
	EUI64     string `json:"eui64"`
	NGUID     string `json:"nguid"`
	NSID      int64  `json:"nsid"`
	Transport string `json:"transport"`
	ByPath    string `json:"byPath"`
	IOError   bool   `json:"ioError"`
	// DriverChain and Modaliases go from the disk up to the PCI root.
	DriverChain []string                    `json:"driverChain"`
	Modaliases  []string                    `json:"modaliases"`
	Signatures  []baremetal.TargetSignature `json:"signatures"`
}

// TargetNote says why a device is not a target.
type TargetNote struct {
	Device string `json:"device"`
	Reason string `json:"reason"`
}

// Reasons of TargetNote.
const (
	NoteLiveMedium   = "live_medium"
	NoteHiddenNVMe   = "hidden_nvme_path"
	NoteMMCBoot      = "mmc_boot_or_rpmb"
	NoteZoned        = "zoned"
	NoteReadOnly     = "read_only"
	NoteZeroSize     = "zero_size"
	NoteVirtual      = "virtual"
	NoteInvalidName  = "invalid_name"
	NoteTooManyDisks = "too_many_disks"
)

var (
	reHiddenNVMe = regexp.MustCompile(`^nvme[0-9]+c[0-9]+n[0-9]+$`)
	reMMCBoot    = regexp.MustCompile(`^mmcblk[0-9]+boot[0-9]+$|rpmb$`)
	reVirtual    = regexp.MustCompile(`^(loop|ram|zram|sr|fd|dm-|md|nbd|drbd|zd)[0-9]`)
	reKName      = regexp.MustCompile(`^[A-Za-z0-9_.:+-]{1,64}$`)
)

// Identity is the identity of a disk (10.6): WWN, EUI-64 or NGUID, else
// serial plus NVMe namespace, else its /dev/disk/by-path name; "" when
// there is none.
func Identity(b BlockInfo) string {
	// lsblk's WWN of an NVMe namespace is its wwid (eui.<hex>, nvme.<...>),
	// no WWN (baremetal.SplitWWN).
	wwn, eui, nguid := baremetal.SplitWWN(b.WWN)
	if b.EUI64 != "" {
		eui = b.EUI64
	}
	if b.NGUID != "" {
		nguid = b.NGUID
	}
	switch {
	case wwn != "":
		return "wwn." + wwn
	case eui != "":
		return "eui." + strings.ToLower(eui)
	case nguid != "":
		return "nguid." + strings.ToLower(nguid)
	case b.Serial != "":
		s := "serial." + b.Serial
		if b.NSID > 0 {
			s += "-" + strconv.FormatInt(b.NSID, 10)
		}
		return s
	case b.ByPath != "":
		return "path." + b.ByPath
	}
	return ""
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// BuildTarget builds the planner's target from the collected hardware.
// Excluded devices (the ISO medium, hidden NVMe paths, mmc boot areas,
// zoned, read-only and empty devices) are noted; those with signatures
// become Others, so identity conflicts are still found. Removable disks
// and SAN LUNs stay candidates: the planner maps them only on an explicit
// choice (Choices.AllowDevices).
func BuildTarget(in HardwareInput) (*baremetal.Target, []TargetNote) {
	t := &baremetal.Target{Format: baremetal.TargetFormat, Kind: "hardware", Firmware: in.Firmware,
		Disks: []baremetal.TargetDisk{}, Others: []baremetal.TargetDisk{}, NICs: []baremetal.TargetNIC{}, RAMBytes: in.RAMBytes}
	if t.Firmware.Mode == "" {
		t.Firmware.Mode = "bios"
	}
	if t.Firmware.DB == nil {
		t.Firmware.DB = []baremetal.CertRef{}
	}
	if t.Firmware.SbatLevel == nil {
		t.Firmware.SbatLevel = []string{}
	}
	if t.Firmware.MokList == nil {
		t.Firmware.MokList = []baremetal.MokRef{}
	}
	blocks := append([]BlockInfo(nil), in.Blocks...)
	sort.Slice(blocks, func(i, j int) bool { return naturalLess(blocks[i].KName, blocks[j].KName) })
	var notes []TargetNote
	n, o := 0, 0
	for _, b := range blocks {
		reason := ""
		switch {
		case !reKName.MatchString(b.KName) || strings.Contains(b.KName, ".."):
			reason = NoteInvalidName
		case reVirtual.MatchString(b.KName):
			reason = NoteVirtual
		case reHiddenNVMe.MatchString(b.KName):
			reason = NoteHiddenNVMe
		case reMMCBoot.MatchString(b.KName):
			reason = NoteMMCBoot
		case b.KName == in.LiveMedium && in.LiveMedium != "":
			reason = NoteLiveMedium
		case b.SizeBytes <= 0:
			reason = NoteZeroSize
		case b.Zoned != "" && b.Zoned != "none":
			reason = NoteZoned
		case b.ReadOnly:
			reason = NoteReadOnly
		}
		if reason == NoteVirtual {
			continue
		}
		td := targetDisk(b)
		if reason != "" {
			if reason != NoteInvalidName {
				notes = append(notes, TargetNote{Device: "/dev/" + b.KName, Reason: reason})
			}
			if len(b.Signatures) > 0 && reason != NoteInvalidName && reason != NoteLiveMedium && o < 256 {
				td.ID = "o" + strconv.Itoa(o)
				o++
				t.Others = append(t.Others, td)
			}
			continue
		}
		if n >= 64 {
			notes = append(notes, TargetNote{Device: "/dev/" + b.KName, Reason: NoteTooManyDisks})
			continue
		}
		td.ID = "t" + strconv.Itoa(n)
		n++
		t.Disks = append(t.Disks, td)
	}
	for _, nic := range in.NICs {
		t.NICs = append(t.NICs, nic)
	}
	return t, notes
}

func targetDisk(b BlockInfo) baremetal.TargetDisk {
	ls, ps := b.Logical, b.Physical
	if ls < 512 || ls&(ls-1) != 0 {
		ls = 512
	}
	if ps < ls || ps&(ps-1) != 0 {
		ps = ls
	}
	td := baremetal.TargetDisk{Path: "/dev/" + b.KName, SizeBytes: b.SizeBytes, LogicalSectorSize: ls, PhysicalSectorSize: ps,
		Model: strp(b.Model), Serial: strp(b.Serial), WWN: strp(b.WWN), EUI64: strp(b.EUI64), NGUID: strp(b.NGUID),
		Transport: strp(b.Transport), Removable: b.Removable, ReadOnly: b.ReadOnly, Zoned: b.Zoned, IOError: b.IOError,
		Identity: strp(Identity(b)), DriverChain: append([]string{}, b.DriverChain...), DriverModaliases: append([]string{}, b.Modaliases...),
		Signatures: append([]baremetal.TargetSignature{}, b.Signatures...)}
	if td.Zoned == "" {
		td.Zoned = "none"
	}
	if b.NSID > 0 {
		v := b.NSID
		td.NSID = &v
	}
	return td
}

// naturalLess sorts sda < sdb < sdaa and nvme2n1 < nvme10n1.
func naturalLess(a, b string) bool {
	if len(a) != len(b) && strings.TrimRight(a, "0123456789") == strings.TrimRight(b, "0123456789") {
		return len(a) < len(b)
	}
	return a < b
}

// ExchangeHardware is the hardware summary sent at the exchange (9.3).
func ExchangeHardware(t *baremetal.Target) api.RecoveryHardware {
	h := api.RecoveryHardware{Firmware: t.Firmware.Mode, SecureBoot: t.Firmware.SecureBoot, RAMBytes: t.RAMBytes,
		Disks: []api.RecoveryDisk{}, NICs: []api.RecoveryNIC{}}
	if h.Firmware != api.FirmwareUEFI {
		h.Firmware = api.FirmwareBIOS
	}
	for i, d := range t.Disks {
		if i >= api.RecoveryMaxDisks {
			break
		}
		h.Disks = append(h.Disks, api.RecoveryDisk{SizeBytes: d.SizeBytes, LogicalSectorSize: int(d.LogicalSectorSize),
			Model: deref(d.Model), Serial: deref(d.Serial), WWN: deref(d.WWN), Transport: deref(d.Transport)})
	}
	for i, n := range t.NICs {
		if i >= api.RecoveryMaxNICs {
			break
		}
		h.NICs = append(h.NICs, api.RecoveryNIC{MAC: deref(n.MAC), Driver: deref(n.Driver)})
	}
	return h
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// FormatBytes is a size for the console (GiB with one decimal, or bytes).
func FormatBytes(n int64) string {
	const gib = 1 << 30
	switch {
	case n >= gib:
		return fmt.Sprintf("%.1f GiB", float64(n)/gib)
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	}
	return strconv.FormatInt(n, 10) + " B"
}
