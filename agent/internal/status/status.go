// Package status keeps the runtime status of the agent in a JSON file that
// contains no secrets. It serves two purposes: `restow-agent status` can show
// it without root, and the scheduler survives restarts (when the last backup
// ran, whether a run was interrupted, how many attempts failed).
package status

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SchemaVersion of the file.
const SchemaVersion = 1

// maxProcessedTasks bounds the remembered task ids.
const maxProcessedTasks = 100

// Heartbeat describes the last contact with the server.
type Heartbeat struct {
	At    time.Time `json:"at,omitzero"`
	OK    bool      `json:"ok"`
	Error string    `json:"error,omitempty"`
}

// RunInfo describes a run that is in progress.
type RunInfo struct {
	Kind      string    `json:"kind"`
	RunID     string    `json:"runId,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

// RunSummary is the outcome of the last finished run of a kind.
type RunSummary struct {
	Kind       string    `json:"kind"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	SnapshotID string    `json:"snapshotId,omitempty"`
	Message    string    `json:"message,omitempty"`
}

// Status is the content of status.json.
type Status struct {
	SchemaVersion int       `json:"schemaVersion"`
	UpdatedAt     time.Time `json:"updatedAt"`
	PID           int       `json:"pid,omitempty"`
	AgentVersion  string    `json:"agentVersion,omitempty"`
	ServerURL     string    `json:"serverUrl,omitempty"`
	EndpointID    string    `json:"endpointId,omitempty"`
	Profile       string    `json:"profile,omitempty"`
	Hostname      string    `json:"hostname,omitempty"`
	EnrolledAt    time.Time `json:"enrolledAt,omitzero"`

	// Service is "starting", "idle", "running" or "stopped".
	Service       string    `json:"service,omitempty"`
	Heartbeat     Heartbeat `json:"heartbeat"`
	ConfigVersion string    `json:"configVersion,omitempty"`
	Schedule      string    `json:"schedule,omitempty"`
	NextRunAt     time.Time `json:"nextRunAt,omitzero"`
	LastError     string    `json:"lastError,omitempty"`

	// Scheduling history.
	LastAttemptAt       time.Time `json:"lastAttemptAt,omitzero"`
	LastSuccessAt       time.Time `json:"lastSuccessAt,omitzero"`
	Interrupted         bool      `json:"interrupted,omitempty"`
	ConsecutiveFailures int       `json:"consecutiveFailures,omitempty"`

	// Current is set while a run is in progress (and survives a crash, which is
	// how an interrupted run is detected on the next start).
	Current *RunInfo `json:"current,omitempty"`

	LastBackup *RunSummary `json:"lastBackup,omitempty"`
	LastRun    *RunSummary `json:"lastRun,omitempty"`

	ProcessedTasks []string `json:"processedTasks,omitempty"`
}

// Load reads the file. A missing file yields an empty Status; a corrupt file
// yields an empty Status and the parse error, so callers can log it and carry on.
func Load(path string) (*Status, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &Status{SchemaVersion: SchemaVersion}, nil
		}
		return &Status{SchemaVersion: SchemaVersion}, err
	}
	var s Status
	if err := json.Unmarshal(raw, &s); err != nil {
		return &Status{SchemaVersion: SchemaVersion}, err
	}
	return &s, nil
}

// Store serialises access to the file within one process and writes it
// atomically with mode 0644.
type Store struct {
	path string
	mu   sync.Mutex
	st   *Status
	now  func() time.Time
}

// Open loads the status file. A corrupt file is reported through the error but
// the returned store is usable.
func Open(path string) (*Store, error) {
	st, err := Load(path)
	return &Store{path: path, st: st, now: time.Now}, err
}

// Snapshot returns a copy of the current status.
func (s *Store) Snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.copyLocked()
}

func (s *Store) copyLocked() Status {
	c := *s.st
	if s.st.Current != nil {
		cur := *s.st.Current
		c.Current = &cur
	}
	if s.st.LastBackup != nil {
		lb := *s.st.LastBackup
		c.LastBackup = &lb
	}
	if s.st.LastRun != nil {
		lr := *s.st.LastRun
		c.LastRun = &lr
	}
	c.ProcessedTasks = append([]string(nil), s.st.ProcessedTasks...)
	return c
}

// Update applies fn under the lock and saves. Errors from saving are returned
// but the in-memory status is updated regardless.
func (s *Store) Update(fn func(*Status)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.st)
	s.st.SchemaVersion = SchemaVersion
	s.st.UpdatedAt = s.now().UTC()
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	raw, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".status-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, s.path); err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

// RememberTask records a processed task id; it reports false if the id was
// already known (the server delivered it twice).
func RememberTask(st *Status, id string) bool {
	for _, known := range st.ProcessedTasks {
		if known == id {
			return false
		}
	}
	st.ProcessedTasks = append(st.ProcessedTasks, id)
	if len(st.ProcessedTasks) > maxProcessedTasks {
		st.ProcessedTasks = st.ProcessedTasks[len(st.ProcessedTasks)-maxProcessedTasks:]
	}
	return true
}
