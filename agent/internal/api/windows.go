package api

// WindowsFacts are what a Windows agent reports about its machine in
// machine.windows (agent 0.5.0, docs/BAREMETAL-WINDOWS.md 6.2): edition,
// product type, build, domain, server roles, SQL Server instances and a
// BitLocker summary. The agent reads them from the registry, the service
// configuration and one fixed WMI query; every field it cannot read is left
// at its zero value (or omitted where marked).
type WindowsFacts struct {
	// ProductName as Windows names itself, corrected to "Windows 11" on a
	// client with build 22000 or later (the registry keeps "Windows 10").
	ProductName string `json:"productName"`
	// EditionID such as Professional, ServerStandard, ServerDatacenter.
	EditionID string `json:"editionId"`
	// ProductType is workstation, server or domain_controller
	// (ProductOptions\ProductType WinNT, ServerNT, LanmanNT); "" unknown.
	ProductType string `json:"productType"`
	// InstallationType is client, server, server_core or nano; "" unknown.
	InstallationType string `json:"installationType"`
	Build            int    `json:"build"`
	UBR              int    `json:"ubr"`
	// DisplayVersion such as 21H2 or 24H2 (ReleaseId on older systems).
	DisplayVersion string `json:"displayVersion,omitempty"`
	DomainMember   bool   `json:"domainMember"`
	// Domain is the DNS name of the domain; omitted outside a domain.
	Domain string       `json:"domain,omitempty"`
	Roles  WindowsRoles `json:"roles"`
	// SQLInstances are the SQL Server instances of the machine (registry).
	SQLInstances []SQLInstanceFact `json:"sqlInstances,omitempty"`
	// BitLocker is nil when it was not looked at.
	BitLocker *BitLockerFacts `json:"bitlocker,omitempty"`
}

// WindowsRoles are the server roles whose data a file backup does not bring
// back as a working application (the fixed W1 warnings).
type WindowsRoles struct {
	DomainController bool `json:"domainController"`
	DFSR             bool `json:"dfsr"`
	Exchange         bool `json:"exchange"`
	HyperV           bool `json:"hyperV"`
	SQLServer        bool `json:"sqlServer"`
}

// SQLInstanceFact is one SQL Server instance as the registry and the service
// configuration describe it.
type SQLInstanceFact struct {
	// Name is the instance name (MSSQLSERVER for the default instance).
	Name string `json:"name"`
	// ID is the instance id, such as MSSQL16.SQLEXPRESS.
	ID string `json:"id"`
	// Version is Setup\Version (the release, not the patch level).
	Version string `json:"version"`
	Edition string `json:"edition"`
	// ServiceName is MSSQLSERVER or MSSQL$<name>.
	ServiceName string `json:"serviceName"`
	// ServiceAccount is the account the service runs as.
	ServiceAccount string `json:"serviceAccount"`
	// Clustered: a failover cluster instance (not supported in W2a).
	Clustered bool `json:"clustered"`
	// StrictEncryption: ForceStrictEncryption (TDS 8) is set; the
	// System.Data.SqlClient driver of the agent cannot connect then.
	StrictEncryption bool `json:"strictEncryption"`
}

// BitLocker summary states.
const (
	BitLockerOK           = "ok"            // the query ran
	BitLockerNotInstalled = "not_installed" // no BitLocker on this system
	BitLockerError        = "error"         // the query failed
)

// BitLockerFacts are the BitLocker states of the volumes with a drive letter
// (Win32_EncryptableVolume, numeric states that do not depend on the
// language of Windows).
type BitLockerFacts struct {
	State   string            `json:"state"`
	Volumes []BitLockerVolume `json:"volumes"`
}

// BitLockerVolume is one volume. Protection is on, off or unknown (locked);
// Conversion is fully_decrypted, fully_encrypted, encryption_in_progress,
// decryption_in_progress, encryption_paused, decryption_paused or unknown.
type BitLockerVolume struct {
	Mount      string `json:"mount"`
	Protection string `json:"protection"`
	Conversion string `json:"conversion"`
}

// MaxBitLockerVolumes bounds BitLockerFacts.Volumes.
const MaxBitLockerVolumes = 32
