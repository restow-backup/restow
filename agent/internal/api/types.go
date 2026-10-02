// Package api is the client for the Restow agent API (/agent/v1, JSON over
// HTTPS, HTTP Basic auth with endpointId:agentSecret). The wire types follow
// the shared endpoint-backup specification.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Roles of an endpoint.
const (
	ProfileServer = "server"
	ProfileClient = "client"
)

// Schedule kinds.
const (
	ScheduleInterval  = "interval"
	ScheduleDaily     = "daily"
	ScheduleOnConnect = "on_connect"
)

// Task kinds.
const (
	TaskBackupNow    = "backup_now"
	TaskRestore      = "restore"
	TaskVerifySample = "verify_sample"
	TaskUpdateConfig = "update_config"
	TaskUninstall    = "uninstall"
)

// Run kinds.
const (
	RunBackup       = "backup"
	RunRestore      = "restore"
	RunVerifySample = "verify_sample"
)

// Run statuses.
const (
	StatusSucceeded = "succeeded"
	StatusPartial   = "partial"
	StatusFailed    = "failed"
)

// Flex is an identifier or counter that the server may send as a JSON string
// or a JSON number. It always marshals as the form it was read in (string for
// values that are not plain integers).
type Flex string

// UnmarshalJSON accepts "abc", 12 and null.
func (f *Flex) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if string(b) == "null" {
		*f = ""
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = Flex(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return fmt.Errorf("expected string or number, got %s", string(b))
	}
	*f = Flex(n.String())
	return nil
}

// MarshalJSON writes plain integers as numbers and everything else as strings.
func (f Flex) MarshalJSON() ([]byte, error) {
	if _, err := strconv.ParseInt(string(f), 10, 64); err == nil && f != "" {
		return []byte(f), nil
	}
	return json.Marshal(string(f))
}

// String returns the raw value.
func (f Flex) String() string { return string(f) }

// EnrollRequest is the body of POST /agent/v1/enroll.
type EnrollRequest struct {
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	AgentVersion string `json:"agentVersion"`
	OSVersion    string `json:"osVersion"`
	// Hooks is the machine's hook policy (off, scripts, any).
	Hooks string `json:"hooks"`
}

// Repository is the restic repository the endpoint writes to.
type Repository struct {
	URL      string `json:"url"`
	Password string `json:"password"`
}

// EnrollResponse is the answer to a successful enrollment.
type EnrollResponse struct {
	EndpointID  Flex       `json:"endpointId"`
	AgentSecret string     `json:"agentSecret"`
	Repository  Repository `json:"repository"`
	Config      *Config    `json:"config,omitempty"`
}

// Schedule describes when backups run.
type Schedule struct {
	Kind            string `json:"kind"`
	IntervalMinutes int    `json:"intervalMinutes,omitempty"`
	TimeOfDay       string `json:"timeOfDay,omitempty"`
	TimeZone        string `json:"timeZone,omitempty"`
}

// Hooks are shell commands run around a backup.
type Hooks struct {
	Pre  string `json:"pre,omitempty"`
	Post string `json:"post,omitempty"`
}

// Config is the endpoint configuration served by GET /agent/v1/config.
type Config struct {
	Profile  string   `json:"profile"`
	Schedule Schedule `json:"schedule"`
	Paths    []string `json:"paths"`
	Excludes []string `json:"excludes"`
	Hooks    Hooks    `json:"hooks"`
	// BandwidthKbps is the upload limit that applies now, in kbit/s; nil or 0
	// means unlimited. The server works out which time window of the job is
	// active when the agent asks, so the agent reads the configuration again
	// when a backup starts and uses this value as it finds it.
	BandwidthKbps *int64 `json:"bandwidthKbps"`
	OnlyOnACPower bool   `json:"onlyOnAcPower"`
	UseVSS        bool   `json:"useVss"`
	// ExcludeLargerThanBytes skips files larger than this many bytes (restic
	// --exclude-larger-than). Absent, null or 0 mean no limit; the server sends
	// the field only when a backup job sets one.
	ExcludeLargerThanBytes int64 `json:"excludeLargerThanBytes,omitempty"`
	ConfigVersion          Flex  `json:"configVersion"`
}

// HeartbeatRequest is the body of POST /agent/v1/heartbeat.
type HeartbeatRequest struct {
	AgentVersion  string     `json:"agentVersion"`
	OSVersion     string     `json:"osVersion"`
	State         string     `json:"state"` // idle | running
	NextRunAt     *time.Time `json:"nextRunAt"`
	ConfigVersion Flex       `json:"configVersion"`
	// Hooks is the machine's hook policy (off, scripts, any); HookScripts
	// names the scripts in /etc/restow-agent/hooks.d for the scripts mode.
	Hooks       string   `json:"hooks"`
	HookScripts []string `json:"hookScripts,omitempty"`
}

// Task is a command from the server, delivered in the heartbeat answer.
type Task struct {
	ID     Flex            `json:"id"`
	Kind   string          `json:"kind"`
	Params json.RawMessage `json:"params,omitempty"`
}

// HeartbeatResponse carries the pending tasks.
type HeartbeatResponse struct {
	Tasks []Task `json:"tasks"`
}

// RestoreParams are the parameters of a restore task.
type RestoreParams struct {
	SnapshotID string   `json:"snapshotId"`
	Paths      []string `json:"paths"`
	TargetDir  string   `json:"targetDir,omitempty"`
}

// SampleFile is a file name and hash pair used for verify_sample.
type SampleFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

// VerifySampleParams are the parameters of a verify_sample task.
type VerifySampleParams struct {
	SnapshotID string       `json:"snapshotId"`
	Files      []SampleFile `json:"files"`
}

// StartRunRequest is the body of POST /agent/v1/runs.
type StartRunRequest struct {
	Kind      string    `json:"kind"`
	TaskID    Flex      `json:"taskId,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

// StartRunResponse is the answer to StartRunRequest.
type StartRunResponse struct {
	RunID Flex `json:"runId"`
}

// Progress is the body of POST /agent/v1/runs/:runId/progress.
type Progress struct {
	FilesDone   uint64  `json:"filesDone"`
	BytesDone   uint64  `json:"bytesDone"`
	TotalFiles  *uint64 `json:"totalFiles,omitempty"`
	TotalBytes  *uint64 `json:"totalBytes,omitempty"`
	CurrentPath string  `json:"currentPath,omitempty"`
}

// Stats are the counters of a finished backup.
type Stats struct {
	FilesNew            uint64 `json:"filesNew"`
	FilesChanged        uint64 `json:"filesChanged"`
	FilesUnmodified     uint64 `json:"filesUnmodified"`
	DataAdded           uint64 `json:"dataAdded"`
	TotalFilesProcessed uint64 `json:"totalFilesProcessed"`
	TotalBytesProcessed uint64 `json:"totalBytesProcessed"`
}

// RunError describes one problem of a run.
type RunError struct {
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

// FinishRequest is the body of POST /agent/v1/runs/:runId/finish.
type FinishRequest struct {
	Status     string       `json:"status"`
	FinishedAt time.Time    `json:"finishedAt"`
	SnapshotID string       `json:"snapshotId,omitempty"`
	Stats      *Stats       `json:"stats,omitempty"`
	Sample     []SampleFile `json:"sample,omitempty"`
	Errors     []RunError   `json:"errors"`
	LogTail    string       `json:"logTail"`
	// RestoreTest is what a verify_sample run found, once restic restore ran.
	RestoreTest *RestoreTest `json:"restoreTest,omitempty"`
}

// RestoreTest is the result of a restore test (verify_sample) as the agent
// observed it, without a verdict: the server decides from it whether the
// backup is proven wrong, proven good, or the test could not complete. A
// failed verify_sample run without it (an older agent, or a test that did
// not get as far as restic restore) rates nothing.
type RestoreTest struct {
	// Files are the task's files as found in the restored copy, in task order.
	Files []RestoreTestFile `json:"files"`
	// Restic is set when restic restore itself failed. Files then says what
	// it restored anyway.
	Restic *ResticFailure `json:"restic,omitempty"`
}

// RestoreTestFile is one file of a restore test. Exactly one of SHA256,
// Missing and Error is set.
type RestoreTestFile struct {
	Path string `json:"path"`
	// SHA256 of the restored file (lower-case hex).
	SHA256 string `json:"sha256,omitempty"`
	// Missing: there is nothing at this path in the restored copy.
	Missing bool `json:"missing,omitempty"`
	// Error says why the restored file could not be checked on this machine
	// (not a regular file, unreadable).
	Error string `json:"error,omitempty"`
}

// ResticFailure is how restic restore ended when it failed.
type ResticFailure struct {
	ExitCode int `json:"exitCode"`
	// Fatal is the error restic ended with, as restic wrote it ("Fatal: ..."),
	// or empty when restic wrote none (crash, killed).
	Fatal string `json:"fatal"`
	// Errors are the errors restic reported for single items before it ended,
	// in its order, at most MaxResticItemErrors; each message is bounded.
	Errors []ResticItemError `json:"errors,omitempty"`
}

// MaxResticItemErrors bounds ResticFailure.Errors.
const MaxResticItemErrors = 100

// ResticItemError is one error restic reported for an item ("/" for the
// snapshot's tree).
type ResticItemError struct {
	Item    string `json:"item"`
	Message string `json:"message"`
}

// UpdateInfo is the answer of GET /agent/v1/update when a newer agent exists.
type UpdateInfo struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}
