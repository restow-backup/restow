package api

import (
	"encoding/json"
	"time"
)

// Wire types of the recovery API (server 0.5.0, docs/BAREMETAL.md 9 and 10):
// POST /agent/v1/recovery/sessions exchanges a recovery code proof for a
// session, every other route lives below /agent/v1/recovery/sessions/current
// and is authenticated with HTTP Basic sessionId:sessionSecret. The client is
// internal/recovery.Session.

// Recovery session statuses as the session routes report them.
const (
	RecoveryPendingApproval = "pending_approval"
	RecoveryActive          = "active"
	RecoveryFinishing       = "finishing"
	RecoverySucceeded       = "succeeded"
	RecoveryFailed          = "failed"
	RecoveryCancelled       = "cancelled"
	RecoveryExpired         = "expired"
)

// Phases of POST .../current/progress.
const (
	RecoveryPhaseConnected       = "connected"
	RecoveryPhaseWaitingApproval = "waiting_approval"
	RecoveryPhasePlanning        = "planning"
	RecoveryPhaseConfirmed       = "confirmed"
	RecoveryPhasePartitioning    = "partitioning"
	RecoveryPhaseRestoring       = "restoring"
	RecoveryPhaseConfiguring     = "configuring"
	RecoveryPhaseVerifying       = "verifying"
	RecoveryPhaseDone            = "done"
)

// Kinds of POST .../current/event.
const (
	RecoveryEventRemoteAccessEnabled = "remote_access_enabled"
	RecoveryEventKeyfileRegenerated  = "keyfile_regenerated"
)

// Firmware kinds of RecoveryHardware.
const (
	FirmwareUEFI = "uefi"
	FirmwareBIOS = "bios"
)

// Bounds the server enforces on recovery bodies. The body limits are the
// request size limits of apps/api/src/middleware/body-limit.ts, which the
// instance checks (413) before it reads the body.
const (
	RecoveryMaxDisks          = 64
	RecoveryMaxNICs           = 64
	RecoveryMaxString         = 200
	RecoveryMaxTransport      = 32
	RecoveryMaxMessage        = 500
	RecoveryMaxLogLines       = 200
	RecoveryMaxLogLine        = 4096
	RecoveryMaxLogBody        = 1 << 20
	RecoveryMaxEventDetail    = 4 << 10
	RecoveryMaxVerification   = 64 << 10
	RecoveryMaxFinishWarning  = 200
	RecoveryMaxWarningCode    = 64
	RecoveryMaxWarningMessage = 1000
	RecoveryMaxFinishBody     = 320 << 10
)

// RecoveryExchangeRequest is the body of POST /agent/v1/recovery/sessions.
// The code itself never travels: CodeProof binds it to the origin recover
// connects to, and only the SHA-256 of the session secret is sent.
type RecoveryExchangeRequest struct {
	CodeProof           string           `json:"codeProof"`
	SessionSecretSHA256 string           `json:"sessionSecretSha256"`
	RecoveryVersion     string           `json:"recoveryVersion"`
	Hardware            RecoveryHardware `json:"hardware"`
}

// RecoveryHardware is what recover found on the replacement machine.
type RecoveryHardware struct {
	// Firmware is uefi or bios.
	Firmware string `json:"firmware"`
	// SecureBoot is nil when it cannot be told.
	SecureBoot *bool          `json:"secureBoot"`
	RAMBytes   int64          `json:"ramBytes"`
	Disks      []RecoveryDisk `json:"disks"`
	NICs       []RecoveryNIC  `json:"nics"`
}

// RecoveryDisk is one disk of the replacement machine. Model, Serial and WWN
// may be empty; Transport is free text (nvme, sata, usb, virtio, ...).
type RecoveryDisk struct {
	SizeBytes         int64  `json:"sizeBytes"`
	LogicalSectorSize int    `json:"logicalSectorSize"`
	Model             string `json:"model"`
	Serial            string `json:"serial"`
	WWN               string `json:"wwn"`
	Transport         string `json:"transport"`
}

// RecoveryNIC is one network interface of the replacement machine.
type RecoveryNIC struct {
	MAC    string `json:"mac"`
	Driver string `json:"driver"`
	Link   bool   `json:"link"`
}

// RecoveryEndpoint names the machine a code belongs to.
type RecoveryEndpoint struct {
	ID          string `json:"id"`
	Hostname    string `json:"hostname"`
	DisplayName string `json:"displayName"`
	OS          string `json:"os"`
}

// RecoveryExchangeResponse is the 202 answer of the exchange. It carries no
// secret.
type RecoveryExchangeResponse struct {
	SessionID string `json:"sessionId"`
	// Status is pending_approval, or active when the code was issued
	// without approval.
	Status             string           `json:"status"`
	MatchCode          string           `json:"matchCode"`
	ExpiresAt          time.Time        `json:"expiresAt"`
	Endpoint           RecoveryEndpoint `json:"endpoint"`
	MinRecoveryVersion string           `json:"minRecoveryVersion"`
}

// RecoverySessionState is the answer of GET .../current.
type RecoverySessionState struct {
	SessionID       string    `json:"sessionId"`
	Status          string    `json:"status"`
	ExpiresAt       time.Time `json:"expiresAt"`
	CancelRequested bool      `json:"cancelRequested"`
	Approved        bool      `json:"approved"`
}

// RecoveryRestoreSize is the restore size of one mount point (the M2
// RestoreSize of internal/baremetal, with the same JSON form; the api
// package does not import baremetal).
type RecoveryRestoreSize struct {
	Bytes  int64 `json:"bytes"`
	Files  int64 `json:"files"`
	Inodes int64 `json:"inodes"`
}

// RecoverySnapshot is one whole-machine snapshot the session may read.
type RecoverySnapshot struct {
	ID           string    `json:"id"`
	Time         time.Time `json:"time"`
	LayoutSHA256 string    `json:"layoutSha256"`
	// Check is the stage-1 result: passed, failed, incomplete or none.
	Check string `json:"check"`
}

// RecoveryCredentials is the answer of GET .../current/credentials (only in
// status active, at most once plus one repeat within five minutes). The
// repository is read-only and accepts the session's Basic credentials.
type RecoveryCredentials struct {
	Repository   Repository         `json:"repository"`
	SnapshotID   string             `json:"snapshotId"`
	LayoutSHA256 string             `json:"layoutSha256"`
	Snapshots    []RecoverySnapshot `json:"snapshots"`
	IndexBytes   int64              `json:"indexBytes"`
	// RestoreSizes per mount point; nil when the snapshot has no report.
	RestoreSizes       map[string]RecoveryRestoreSize `json:"restoreSizes"`
	MinRecoveryVersion string                         `json:"minRecoveryVersion"`
}

// RecoverySSHKeys is the answer of GET .../current/ssh-keys: the public keys
// an administrator allowed for remote access to the recovery system.
type RecoverySSHKeys struct {
	Keys []string `json:"keys"`
}

// RecoverySSHHostKey is a host key of the recovery system, so the
// administrator can check the fingerprint before connecting.
type RecoverySSHHostKey struct {
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
}

// RecoveryProgress is the body of POST .../current/progress.
type RecoveryProgress struct {
	Phase       string               `json:"phase"`
	Step        int                  `json:"step"`
	StepsTotal  int                  `json:"stepsTotal"`
	BytesDone   int64                `json:"bytesDone"`
	TotalBytes  int64                `json:"totalBytes"`
	FilesDone   int64                `json:"filesDone"`
	TotalFiles  int64                `json:"totalFiles"`
	Message     string               `json:"message"`
	SSHHostKeys []RecoverySSHHostKey `json:"sshHostKeys,omitempty"`
}

// RecoveryLog is the body of POST .../current/log.
type RecoveryLog struct {
	Lines []string `json:"lines"`
}

// RecoveryLogResult is the 202 answer of POST .../current/log. Lines beyond
// the session's cap (2 MiB) are dropped.
type RecoveryLogResult struct {
	Accepted int `json:"accepted"`
	Dropped  int `json:"dropped"`
}

// RecoveryEvent is the body of POST .../current/event.
type RecoveryEvent struct {
	Kind   string            `json:"kind"`
	Detail map[string]string `json:"detail"`
}

// RecoveryWarning is one warning of the finished recovery.
type RecoveryWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// RecoveryFinish is the body of POST .../current/finish.
type RecoveryFinish struct {
	// Status is succeeded, failed or cancelled.
	Status string `json:"status"`
	// Verification is the result of the checks after the restore (an
	// object, at most 64 KiB).
	Verification    json.RawMessage   `json:"verification"`
	Warnings        []RecoveryWarning `json:"warnings"`
	DurationSeconds int64             `json:"durationSeconds"`
}

// RecoveryStatus is the answer of release and finish.
type RecoveryStatus struct {
	Status string `json:"status"`
}

// RecoveryRebindRequest is the body of POST .../current/rebind: a reconnect
// token of the same machine, redeemed after a successful finish. The answer
// is an EnrollResponse with Rebound set.
type RecoveryRebindRequest struct {
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	AgentVersion string `json:"agentVersion"`
	OSVersion    string `json:"osVersion"`
	Hooks        string `json:"hooks"`
}
