package baremetal

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Target is the hardware a plan is made for (C-M2-3): written by recover
// from the real machine (M4), or built by SyntheticTarget for stage 1.
type Target struct {
	Format   string         `json:"format"`
	Kind     string         `json:"kind"`
	Firmware TargetFirmware `json:"firmware"`
	Disks    []TargetDisk   `json:"disks"`
	// Others are devices that are neither a target nor adopted; they are
	// checked for identity conflicts.
	Others   []TargetDisk `json:"others"`
	NICs     []TargetNIC  `json:"nics"`
	RAMBytes int64        `json:"ramBytes"`
}

// TargetFirmware is the boot firmware of the target and its Secure Boot
// databases.
type TargetFirmware struct {
	Mode       string     `json:"mode"`
	SecureBoot *bool      `json:"secureBoot"`
	SetupMode  *bool      `json:"setupMode"`
	DB         []CertRef  `json:"db"`
	DBX        *TargetDBX `json:"dbx"`
	SbatLevel  []string   `json:"sbatLevel"`
	MokList    []MokRef   `json:"mokList"`
}

// TargetDBX is the revocation list: Authenticode hashes and the SHA-256 of
// revoked certificates. A nil DBX means it is not known.
type TargetDBX struct {
	Hashes []string `json:"hashes"`
	Certs  []string `json:"certs"`
}

// TargetDisk is a disk of the target.
type TargetDisk struct {
	ID                 string            `json:"id"`
	Path               string            `json:"path"`
	SizeBytes          int64             `json:"sizeBytes"`
	LogicalSectorSize  int64             `json:"logicalSectorSize"`
	PhysicalSectorSize int64             `json:"physicalSectorSize"`
	Model              *string           `json:"model"`
	Serial             *string           `json:"serial"`
	WWN                *string           `json:"wwn"`
	EUI64              *string           `json:"eui64"`
	NGUID              *string           `json:"nguid"`
	NSID               *int64            `json:"nsid"`
	Transport          *string           `json:"transport"`
	Removable          bool              `json:"removable"`
	ReadOnly           bool              `json:"readOnly"`
	Zoned              string            `json:"zoned"`
	IOError            bool              `json:"ioError"`
	Identity           *string           `json:"identity"`
	DriverChain        []string          `json:"driverChain"`
	DriverModaliases   []string          `json:"driverModaliases"`
	Signatures         []TargetSignature `json:"signatures"`
}

// TargetSignature is an identity found on a target device (blkid -p,
// mdadm --examine, pvs): kind is disk_guid, part_uuid, fs, md, pv or luks.
// Signatures of an assembled array or an opened volume are reported on the
// disk of its first member.
type TargetSignature struct {
	Kind       string  `json:"kind"`
	UUID       string  `json:"uuid"`
	Type       *string `json:"type,omitempty"`
	PartNumber *int64  `json:"partNumber,omitempty"`
}

// TargetNIC is a physical network card of the target.
type TargetNIC struct {
	Name     string  `json:"name"`
	MAC      *string `json:"mac"`
	Driver   *string `json:"driver"`
	Modalias *string `json:"modalias"`
}

// Choices are the operator's decisions (C-M2-4).
type Choices struct {
	DiskMapping   map[string]string `json:"diskMapping,omitempty"`
	Adopt         []string          `json:"adopt,omitempty"`
	Shrink        string            `json:"shrink,omitempty"`
	RawLVs        string            `json:"rawLvs,omitempty"`
	SecureBootOff bool              `json:"secureBootOff,omitempty"`
	AllowDevices  []string          `json:"allowDevices,omitempty"`
}

// Values of the target keywords.
const (
	TargetSame            = "same"
	TargetMinimal         = "minimal"
	TargetOtherController = "other-controller"
)

var (
	reTargetID   = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	reDevicePath = regexp.MustCompile(`^/dev/[A-Za-z0-9/_.:+-]{1,250}$`)
)

// checkTreeStrings runs checkString on every string and key of a decoded
// JSON value.
func checkTreeStrings(what string, node any) error {
	switch t := node.(type) {
	case string:
		if len(t) > maxStringBytes {
			return fmt.Errorf("%s: string of %d bytes", what, len(t))
		}
		if err := checkString(t); err != nil {
			return fmt.Errorf("%s: %v", what, err)
		}
	case []any:
		for i, e := range t {
			if err := checkTreeStrings(fmt.Sprintf("%s[%d]", what, i), e); err != nil {
				return err
			}
		}
	case map[string]any:
		for k, e := range t {
			if err := checkString(k); err != nil {
				return fmt.Errorf("%s: key: %v", what, err)
			}
			if err := checkTreeStrings(what+"."+k, e); err != nil {
				return err
			}
		}
	}
	return nil
}

// ParseTarget reads and checks a target document (C-M2-3).
func ParseTarget(b []byte) (*Target, error) {
	if len(b) > MaxTargetBytes {
		return nil, ErrInputTooLarge
	}
	tree, err := parseTree(b)
	if err != nil {
		return nil, fmt.Errorf("target: %v", err)
	}
	if err := checkTreeStrings("target", tree); err != nil {
		return nil, err
	}
	if err := requireKeys(b, "target", "format", "kind", "firmware", "disks", "others", "nics", "ramBytes"); err != nil {
		return nil, err
	}
	var t Target
	if err := json.Unmarshal(b, &t); err != nil {
		return nil, fmt.Errorf("target: %v", err)
	}
	if t.Format != TargetFormat {
		return nil, fmt.Errorf("target.format: %q, want %q", t.Format, TargetFormat)
	}
	if t.Firmware.Mode != "uefi" && t.Firmware.Mode != "bios" {
		return nil, fmt.Errorf("target.firmware.mode: %q", t.Firmware.Mode)
	}
	if len(t.Disks) > maxDisks || len(t.Others) > 256 || len(t.NICs) > maxNetwork || len(t.Firmware.DB) > maxDB ||
		len(t.Firmware.SbatLevel) > maxSbatLines || len(t.Firmware.MokList) > maxMOK {
		return nil, errors.New("target: too many entries")
	}
	if t.Firmware.DBX != nil && (len(t.Firmware.DBX.Hashes) > 4096 || len(t.Firmware.DBX.Certs) > 256) {
		return nil, errors.New("target.firmware.dbx: too many entries")
	}
	if t.RAMBytes < 0 {
		return nil, errors.New("target.ramBytes: out of range")
	}
	ids := map[string]bool{}
	for _, list := range [][]TargetDisk{t.Disks, t.Others} {
		for i, d := range list {
			p := fmt.Sprintf("target.disks[%d]", i)
			if !reTargetID.MatchString(d.ID) || ids[d.ID] {
				return nil, fmt.Errorf("%s.id: %q is invalid or not unique", p, d.ID)
			}
			ids[d.ID] = true
			if !reDevicePath.MatchString(d.Path) || strings.Contains(d.Path, "..") {
				return nil, fmt.Errorf("%s.path: %q is not a device path", p, d.Path)
			}
			if d.SizeBytes < 0 || d.SizeBytes > maxSafeInteger {
				return nil, fmt.Errorf("%s.sizeBytes: out of range", p)
			}
			for _, s := range []int64{d.LogicalSectorSize, d.PhysicalSectorSize} {
				if s < 512 || s > 65536 || s&(s-1) != 0 {
					return nil, fmt.Errorf("%s: sector size %d", p, s)
				}
			}
			if len(d.DriverChain) > 64 || len(d.DriverModaliases) > 64 || len(d.Signatures) > 1024 {
				return nil, fmt.Errorf("%s: too many entries", p)
			}
			for j, s := range d.Signatures {
				if !oneOf(s.Kind, "disk_guid", "part_uuid", "fs", "md", "pv", "luks") {
					return nil, fmt.Errorf("%s.signatures[%d].kind: %q", p, j, s.Kind)
				}
			}
		}
	}
	for i, c := range t.Firmware.DB {
		if !reHex64.MatchString(c.SHA256) {
			return nil, fmt.Errorf("target.firmware.db[%d].sha256: not a lowercase hex SHA-256", i)
		}
	}
	return &t, nil
}

// ParseChoices reads the operator's choices (C-M2-4).
func ParseChoices(b []byte) (Choices, error) {
	var c Choices
	if len(b) > MaxChoicesBytes {
		return c, ErrInputTooLarge
	}
	tree, err := parseTree(b)
	if err != nil {
		return c, fmt.Errorf("choices: %v", err)
	}
	if err := checkTreeStrings("choices", tree); err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("choices: %v", err)
	}
	if c.Shrink != "" && c.Shrink != "none" && c.Shrink != "auto" {
		return c, fmt.Errorf("choices.shrink: %q", c.Shrink)
	}
	if c.RawLVs != "" && c.RawLVs != "skip" && c.RawLVs != "create" {
		return c, fmt.Errorf("choices.rawLvs: %q", c.RawLVs)
	}
	if len(c.DiskMapping) > maxDisks || len(c.Adopt) > 1024 || len(c.AllowDevices) > 64 {
		return c, errors.New("choices: too many entries")
	}
	return c, nil
}

// Modaliases of the synthetic controllers (C-M2-3).
const (
	modaliasAHCI = "pci:v00008086d00002922sv00008086sd00000000bc01sc06i01"
	modaliasNVMe = "pci:v0000144Dd0000A808sv0000144Dsd0000A801bc01sc08i02"
)

// diskIdentity is the identity of a disk as recover reports it (10.6):
// WWN, EUI-64 or NGUID, else serial and namespace, else nil.
func diskIdentity(wwn, eui, nguid, serial *string, nsid *int64) *string {
	switch {
	case deref(wwn) != "":
		return strPtr("wwn." + strings.ToLower(strings.TrimPrefix(*wwn, "0x")))
	case deref(eui) != "":
		return strPtr("eui." + strings.ToLower(*eui))
	case deref(nguid) != "":
		return strPtr("nguid." + strings.ToLower(*nguid))
	case deref(serial) != "":
		s := "serial." + *serial
		if nsid != nil {
			s += "-" + strconv.FormatInt(*nsid, 10)
		}
		return strPtr(s)
	}
	return nil
}

// SyntheticTarget builds the target of a keyword (C-M2-3): "same" is the
// source hardware without signatures, "minimal" the same with every disk
// at its minimum size (and choices shrink auto), "other-controller" the
// same with NVMe and AHCI controllers swapped. The firmware is the
// source's with an unknown dbx.
func SyntheticTarget(m *Manifest, kind string, f *Facts) (*Target, Choices, error) {
	if m == nil || m.Linux == nil {
		return nil, Choices{}, errors.New("synthetic target: only Linux layouts")
	}
	l := m.Linux
	var choices Choices
	var mins map[string]int64
	switch kind {
	case TargetSame, TargetOtherController:
	case TargetMinimal:
		choices.Shrink = "auto"
		ms, _ := MinimumDiskSizes(m, f)
		mins = map[string]int64{}
		for _, d := range ms.Disks {
			mins[d.Disk] = alignUp(d.MinBytes, mib)
		}
	default:
		return nil, choices, fmt.Errorf("unknown target %q", kind)
	}
	fw := l.Firmware
	t := &Target{Format: TargetFormat, Kind: kind,
		Firmware: TargetFirmware{Mode: fw.Mode, SecureBoot: fw.SecureBoot, SetupMode: fw.SetupMode,
			DB: append([]CertRef{}, fw.DB...), SbatLevel: append([]string{}, fw.SbatLevel...), MokList: append([]MokRef{}, fw.MOK...)},
		Disks: []TargetDisk{}, Others: []TargetDisk{}, NICs: []TargetNIC{}}
	nvme, sata := 0, 0
	for i, d := range l.Disks {
		td := TargetDisk{ID: "t" + strconv.Itoa(i), Path: "/dev/" + d.KName, SizeBytes: d.SizeBytes,
			LogicalSectorSize: d.LogicalSectorSize, PhysicalSectorSize: d.PhysicalSectorSize,
			Model: d.Model, Serial: d.Serial, WWN: d.WWN, EUI64: d.EUI64, NGUID: d.NGUID, NSID: d.NSID,
			Transport: d.Transport, Removable: d.Removable, ReadOnly: d.ReadOnly, Zoned: d.Zoned,
			Identity:    diskIdentity(d.WWN, d.EUI64, d.NGUID, d.Serial, d.NSID),
			DriverChain: append([]string{}, d.DriverChain...), DriverModaliases: append([]string{}, d.DriverModaliases...),
			Signatures: []TargetSignature{}}
		if td.LogicalSectorSize == 0 {
			td.LogicalSectorSize = 512
		}
		if td.PhysicalSectorSize < td.LogicalSectorSize {
			td.PhysicalSectorSize = td.LogicalSectorSize
		}
		if !reDevicePath.MatchString(td.Path) {
			td.Path = "/dev/restow-disk" + strconv.Itoa(i)
		}
		if mins != nil {
			td.SizeBytes = mins[d.ID]
		}
		if kind == TargetOtherController {
			isNVMe := deref(d.Transport) == "nvme" || hasModule(d.DriverChain, "nvme")
			td.Model, td.Serial, td.WWN, td.EUI64, td.NGUID, td.NSID = strPtr("Synthetic disk"), strPtr("SYNTH"+strconv.Itoa(i)), nil, nil, nil, nil
			if isNVMe {
				td.Path = "/dev/sd" + string(rune('a'+sata%26))
				sata++
				td.Transport = strPtr("sata")
				td.DriverChain = []string{"ahci"}
				td.DriverModaliases = []string{modaliasAHCI}
			} else {
				td.Path = "/dev/nvme" + strconv.Itoa(nvme) + "n1"
				nvme++
				td.Transport = strPtr("nvme")
				td.NSID = intPtr(1)
				td.DriverChain = []string{"nvme"}
				td.DriverModaliases = []string{modaliasNVMe}
			}
			td.Identity = diskIdentity(nil, nil, nil, td.Serial, td.NSID)
		}
		t.Disks = append(t.Disks, td)
	}
	for _, n := range l.Network {
		if n.Physical {
			t.NICs = append(t.NICs, TargetNIC{Name: n.Name, MAC: n.MAC, Driver: n.Driver, Modalias: n.Modalias})
		}
	}
	return t, choices, nil
}

func hasModule(chain []string, mod string) bool {
	for _, c := range chain {
		if moduleName(c) == moduleName(mod) {
			return true
		}
	}
	return false
}
