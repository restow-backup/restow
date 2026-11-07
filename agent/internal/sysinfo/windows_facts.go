package sysinfo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The facts of a Windows machine (W1, docs/BAREMETAL-WINDOWS.md 6.1): what
// it is (edition, product type, build), whether it is in a domain, which
// server roles it runs whose data a file backup does not bring back as a
// working application, its SQL Server instances and a BitLocker summary.
// This file has no build tag: the same functions read recorded facts of real
// machines (testdata/windows) on every system and the live registry on
// Windows (sysinfo_windows.go).

// Registry reads HKEY_LOCAL_MACHINE. A value or key that does not exist (or
// cannot be read) reports ok = false or nothing.
type Registry interface {
	String(path, name string) (string, bool)
	Integer(path, name string) (uint64, bool)
	SubKeys(path string) []string
	ValueNames(path string) []string
}

// Services reads the service configuration: the account a service runs as,
// ok = false when there is no such service.
type Services interface {
	Account(name string) (string, bool)
}

// Registry paths the facts come from.
const (
	regCurrentVersion = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
	regProductOptions = `SYSTEM\CurrentControlSet\Control\ProductOptions`
	regTcpip          = `SYSTEM\CurrentControlSet\Services\Tcpip\Parameters`
	regBIOS           = `HARDWARE\DESCRIPTION\System\BIOS`
	regSQLRoot        = `SOFTWARE\Microsoft\Microsoft SQL Server`
	regSQLInstances   = regSQLRoot + `\Instance Names\SQL`
)

// Services whose presence marks a role.
const (
	serviceExchange = "MSExchangeIS"
	serviceHyperV   = "vmms"
	serviceNTDS     = "NTDS"
	serviceDFSR     = "DFSR"
)

// maxSQLInstances bounds the instances reported (a machine has a handful).
const maxSQLInstances = 50

// windowsQuery is what the fixed WMI query (sysinfo_windows.go) answers.
type windowsQuery struct {
	Computer *struct {
		PartOfDomain bool   `json:"partOfDomain"`
		Domain       string `json:"domain"`
	} `json:"computer"`
	BitLocker *struct {
		Available bool            `json:"available"`
		Error     string          `json:"error"`
		Volumes   json.RawMessage `json:"volumes"`
	} `json:"bitlocker"`
}

type encryptableVolume struct {
	DriveLetter      string `json:"driveLetter"`
	ProtectionStatus int    `json:"protectionStatus"`
	ConversionStatus int    `json:"conversionStatus"`
}

// DetectWindows reads the facts of a Windows machine. wmi runs the fixed
// WMI query and returns its JSON; nil leaves domain membership to the
// registry and BitLocker out. It never fails: what cannot be read stays empty.
func DetectWindows(reg Registry, svc Services, wmi func() ([]byte, error)) *api.WindowsFacts {
	f := &api.WindowsFacts{}
	f.ProductName = clean(str(reg, regCurrentVersion, "ProductName"), 128)
	f.EditionID = clean(str(reg, regCurrentVersion, "EditionID"), 64)
	f.Build, _ = strconv.Atoi(str(reg, regCurrentVersion, "CurrentBuildNumber"))
	if ubr, ok := reg.Integer(regCurrentVersion, "UBR"); ok && ubr < 1<<31 {
		f.UBR = int(ubr)
	}
	f.DisplayVersion = clean(str(reg, regCurrentVersion, "DisplayVersion"), 16)
	if f.DisplayVersion == "" {
		f.DisplayVersion = clean(str(reg, regCurrentVersion, "ReleaseId"), 16)
	}
	switch str(reg, regProductOptions, "ProductType") {
	case "WinNT":
		f.ProductType = "workstation"
	case "ServerNT":
		f.ProductType = "server"
	case "LanmanNT":
		f.ProductType = "domain_controller"
	}
	switch strings.ToLower(str(reg, regCurrentVersion, "InstallationType")) {
	case "client":
		f.InstallationType = "client"
	case "server":
		f.InstallationType = "server"
	case "server core":
		f.InstallationType = "server_core"
	case "nano server":
		f.InstallationType = "nano"
	}
	// Windows 11 still calls itself Windows 10 in ProductName.
	if f.InstallationType == "client" && f.Build >= 22000 && strings.HasPrefix(f.ProductName, "Windows 10") {
		f.ProductName = "Windows 11" + strings.TrimPrefix(f.ProductName, "Windows 10")
	}
	f.Domain = clean(strings.TrimSuffix(str(reg, regTcpip, "Domain"), "."), 255)
	f.DomainMember = f.Domain != ""

	_, exchange := svc.Account(serviceExchange)
	_, hyperV := svc.Account(serviceHyperV)
	_, ntds := svc.Account(serviceNTDS)
	_, dfsr := svc.Account(serviceDFSR)
	f.Roles = api.WindowsRoles{
		DomainController: f.ProductType == "domain_controller" || ntds,
		DFSR:             dfsr,
		Exchange:         exchange,
		HyperV:           hyperV,
	}
	f.SQLInstances = sqlInstances(reg, svc)
	f.Roles.SQLServer = len(f.SQLInstances) > 0

	if wmi != nil {
		applyWMI(f, wmi)
	}
	return f
}

func applyWMI(f *api.WindowsFacts, wmi func() ([]byte, error)) {
	raw, err := wmi()
	var q windowsQuery
	if err != nil || json.Unmarshal(bytes.TrimSpace(raw), &q) != nil {
		f.BitLocker = &api.BitLockerFacts{State: api.BitLockerError, Volumes: []api.BitLockerVolume{}}
		return
	}
	if c := q.Computer; c != nil {
		f.DomainMember = c.PartOfDomain
		if !c.PartOfDomain {
			f.Domain = ""
		} else if f.Domain == "" {
			f.Domain = clean(c.Domain, 255)
		}
	}
	b := q.BitLocker
	switch {
	case b == nil || b.Error != "":
		f.BitLocker = &api.BitLockerFacts{State: api.BitLockerError, Volumes: []api.BitLockerVolume{}}
	case !b.Available:
		f.BitLocker = &api.BitLockerFacts{State: api.BitLockerNotInstalled, Volumes: []api.BitLockerVolume{}}
	default:
		f.BitLocker = &api.BitLockerFacts{State: api.BitLockerOK, Volumes: bitLockerVolumes(b.Volumes)}
	}
}

// bitLockerVolumes reads the volumes of Win32_EncryptableVolume; Windows
// PowerShell 5.1 writes a list of one element as the element itself.
func bitLockerVolumes(raw json.RawMessage) []api.BitLockerVolume {
	var list []encryptableVolume
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '{' {
		var one encryptableVolume
		if json.Unmarshal(raw, &one) == nil {
			list = []encryptableVolume{one}
		}
	} else {
		_ = json.Unmarshal(raw, &list)
	}
	out := []api.BitLockerVolume{}
	for _, v := range list {
		mount := strings.ToUpper(strings.TrimSpace(v.DriveLetter))
		if len(mount) != 2 || mount[1] != ':' || mount[0] < 'A' || mount[0] > 'Z' {
			continue // no drive letter (a recovery or EFI partition)
		}
		protection := "unknown"
		switch v.ProtectionStatus {
		case 0:
			protection = "off"
		case 1:
			protection = "on"
		}
		conversion := "unknown"
		if v.ConversionStatus >= 0 && v.ConversionStatus < len(conversionStates) {
			conversion = conversionStates[v.ConversionStatus]
		}
		out = append(out, api.BitLockerVolume{Mount: mount, Protection: protection, Conversion: conversion})
		if len(out) == api.MaxBitLockerVolumes {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mount < out[j].Mount })
	return out
}

// conversionStates are the values of Win32_EncryptableVolume.ConversionStatus.
var conversionStates = []string{
	"fully_decrypted", "fully_encrypted", "encryption_in_progress",
	"decryption_in_progress", "encryption_paused", "decryption_paused",
}

// sqlInstances lists the SQL Server instances from the registry: the names
// and ids under Instance Names\SQL, release and edition from <id>\Setup, the
// cluster key, the strict encryption setting, and the service account.
func sqlInstances(reg Registry, svc Services) []api.SQLInstanceFact {
	names := reg.ValueNames(regSQLInstances)
	sort.Strings(names)
	var out []api.SQLInstanceFact
	for _, name := range names {
		if !ValidSQLInstanceName(name) {
			continue
		}
		id := str(reg, regSQLInstances, name)
		if id == "" || strings.ContainsAny(id, `\/`) || len(id) > 64 {
			continue
		}
		base := regSQLRoot + `\` + id
		service := "MSSQL$" + name
		if strings.EqualFold(name, "MSSQLSERVER") {
			service = "MSSQLSERVER"
		}
		account, _ := svc.Account(service)
		strict, _ := reg.Integer(base+`\MSSQLServer\SuperSocketNetLib`, "ForceStrictEncryption")
		_, clustered := reg.String(base+`\Cluster`, "ClusterName")
		out = append(out, api.SQLInstanceFact{
			Name:             name,
			ID:               id,
			Version:          clean(str(reg, base+`\Setup`, "Version"), 32),
			Edition:          clean(str(reg, base+`\Setup`, "Edition"), 64),
			ServiceName:      service,
			ServiceAccount:   clean(account, 256),
			Clustered:        clustered,
			StrictEncryption: strict == 1,
		})
		if len(out) == maxSQLInstances {
			break
		}
	}
	return out
}

// ValidSQLInstanceName reports whether name can be a SQL Server instance
// name: 1 to 16 characters, a letter or _ first, then letters, digits, _,
// $ and # (MSSQLSERVER for the default instance).
func ValidSQLInstanceName(name string) bool {
	if len(name) == 0 || len(name) > 16 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c == '_':
		case i > 0 && (c >= '0' && c <= '9' || c == '$' || c == '#'):
		default:
			return false
		}
	}
	return true
}

// windowsVirtualization tells a virtual machine from the BIOS strings the
// registry keeps (the same vendor list as on Linux).
func windowsVirtualization(reg Registry) (kind, technology string) {
	vendor := strings.ToLower(str(reg, regBIOS, "SystemManufacturer"))
	product := strings.ToLower(str(reg, regBIOS, "SystemProductName"))
	board := strings.ToLower(str(reg, regBIOS, "BaseBoardManufacturer"))
	if strings.Contains(vendor, "microsoft") && strings.Contains(product, "virtual machine") {
		return VirtVM, "microsoft"
	}
	for _, v := range vmVendors {
		if strings.Contains(vendor, v.match) || strings.Contains(product, v.match) || strings.Contains(board, v.match) {
			return VirtVM, v.tech
		}
	}
	return VirtNone, ""
}

// MachineFromWindows completes the machine facts of a Windows machine.
func MachineFromWindows(reg Registry, svc Services, wmi func() ([]byte, error)) Machine {
	kind, tech := windowsVirtualization(reg)
	w := DetectWindows(reg, svc, wmi)
	return Machine{Virtualization: kind, Technology: tech, Desktop: w.InstallationType == "client", Windows: w}
}

// OSVersionText is the version line of a Windows machine, for example
// "Windows Server 2022 Standard 21H2 (build 20348.2340)".
func OSVersionText(f *api.WindowsFacts) string {
	name := f.ProductName
	if name == "" {
		name = "Windows"
	}
	if f.DisplayVersion != "" {
		name += " " + f.DisplayVersion
	}
	if f.Build > 0 {
		name += fmt.Sprintf(" (build %d.%d)", f.Build, f.UBR)
	}
	return name
}

func str(reg Registry, path, name string) string {
	v, _ := reg.String(path, name)
	return strings.TrimSpace(v)
}

// clean keeps a registry string printable and bounded.
func clean(s string, maxRunes int) string {
	s = strings.ToValidUTF8(s, "")
	var b strings.Builder
	n := 0
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		if n == maxRunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}
