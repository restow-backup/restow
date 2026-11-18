package api

// Wire types of a oneshot restore (docs/BAREMETAL-ONESHOT.md 6): the command
// on a fresh machine exchanges its code at POST /agent/v1/recovery/oneshot
// with what it measured, reports its checks while the session waits for
// its release, fetches the recovery ISO through the session, and the
// recovery environment reports back after the switch.

// Phases of a oneshot restore before the recovery environment runs.
const (
	RecoveryPhaseRegistered  = "registered"
	RecoveryPhaseDownloading = "downloading"
	RecoveryPhaseKexec       = "kexec"
	RecoveryPhaseBooted      = "booted"
)

// Modes and results of the checks.
const (
	OneshotModeKexec     = "kexec"
	OneshotModeDirect    = "direct"
	OneshotKexecOK       = "ok"
	OneshotKexecFailed   = "failed"
	OneshotKexecNotTried = "not_tried"
)

// Signs that a machine is no fresh one (8.4).
const (
	OneshotInUseAgent    = "agent_enrolled"
	OneshotInUseUptime   = "uptime"
	OneshotInUseUsers    = "users"
	OneshotInUseServices = "services"
	OneshotInUseData     = "data"
)

// OneshotAddress is one address of an interface (prefix length; dynamic:
// DHCP or SLAAC).
type OneshotAddress struct {
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
	Dynamic bool   `json:"dynamic"`
}

// OneshotInterface is one interface of the fresh machine with an address.
type OneshotInterface struct {
	Name      string           `json:"name"`
	MAC       string           `json:"mac"`
	Driver    string           `json:"driver"`
	MTU       int              `json:"mtu"`
	DHCP4     bool             `json:"dhcp4"`
	SLAAC     bool             `json:"slaac"`
	Addresses []OneshotAddress `json:"addresses"`
}

// OneshotRoute is a default route (on-link: the gateway lies outside every
// prefix of the interface, or the route says so).
type OneshotRoute struct {
	Family  string `json:"family"`
	Gateway string `json:"gateway"`
	Dev     string `json:"dev"`
	OnLink  bool   `json:"onlink"`
	Metric  int64  `json:"metric"`
}

// OneshotCloud is what cloud-init knows of the instance.
type OneshotCloud struct {
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	InstanceID string `json:"instanceId"`
	Region     string `json:"region"`
}

// OneshotTarget is the network and the machine the command measured (10.1).
type OneshotTarget struct {
	Hostname      string             `json:"hostname"`
	Interfaces    []OneshotInterface `json:"interfaces"`
	Routes        []OneshotRoute     `json:"routes"`
	DNS           []string           `json:"dns"`
	SearchDomains []string           `json:"searchDomains"`
	Cloud         *OneshotCloud      `json:"cloud"`
	Vendor        string             `json:"vendor"`
	Product       string             `json:"product"`
	Consoles      []string           `json:"consoles"`
	UptimeSeconds int64              `json:"uptimeSeconds"`
	Rescue        bool               `json:"rescue"`
}

// OneshotChecks are the checks of the command (8.2).
type OneshotChecks struct {
	Mode              string   `json:"mode"`
	Kexec             string   `json:"kexec"`
	KexecError        string   `json:"kexecError"`
	KexecLoadDisabled bool     `json:"kexecLoadDisabled"`
	Lockdown          string   `json:"lockdown"`
	SecureBoot        *bool    `json:"secureBoot"`
	MemTotalBytes     int64    `json:"memTotalBytes"`
	MemAvailableBytes int64    `json:"memAvailableBytes"`
	InUse             []string `json:"inUse"`
	Warnings          []string `json:"warnings"`
}

// OneshotSSHKey is a public key of the machine's root, by fingerprint.
type OneshotSSHKey struct {
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment"`
}

// RecoveryOneshotExchangeRequest is the body of POST /agent/v1/recovery/oneshot.
type RecoveryOneshotExchangeRequest struct {
	RecoveryExchangeRequest
	Target  OneshotTarget   `json:"target"`
	Checks  OneshotChecks   `json:"checks"`
	SSHKeys []OneshotSSHKey `json:"sshKeys"`
}

// OneshotISO is the recovery ISO the instance offers to the session.
type OneshotISO struct {
	Version   string `json:"version"`
	FileName  string `json:"fileName"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
}

// OneshotExchangeExtras come with the answer to a oneshot exchange.
type OneshotExchangeExtras struct {
	ISO   *OneshotISO `json:"iso"`
	Needs struct {
		Passphrase bool  `json:"passphrase"`
		RAMBytes   int64 `json:"ramBytes"`
	} `json:"needs"`
}

// OneshotDecided are the admin's answers of the release.
type OneshotDecided struct {
	NetworkMode            string `json:"networkMode"`
	ConfirmShrink          bool   `json:"confirmShrink"`
	SecureBootWarningsOnly bool   `json:"secureBootWarningsOnly"`
	RemoteAccess           bool   `json:"remoteAccess"`
}

// OneshotCurrent is the oneshot part of GET .../current.
type OneshotCurrent struct {
	Decided *OneshotDecided `json:"decided"`
	Booted  bool            `json:"booted"`
}
