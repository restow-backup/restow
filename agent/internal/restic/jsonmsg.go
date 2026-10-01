package restic

import (
	"bytes"
	"encoding/json"
	"time"
)

// message_type values of restic's --json output that the agent understands.
const (
	msgStatus        = "status"
	msgSummary       = "summary"
	msgError         = "error"
	msgVerboseStatus = "verbose_status"
	msgExitError     = "exit_error"
	msgSnapshot      = "snapshot"
	msgNode          = "node"
)

// peekType returns the message_type of a JSON line, or "" if the line is not
// a JSON object with one.
func peekType(line []byte) string {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return ""
	}
	var head struct {
		MessageType string `json:"message_type"`
	}
	if json.Unmarshal(line, &head) != nil {
		return ""
	}
	return head.MessageType
}

type backupStatus struct {
	PercentDone  float64  `json:"percent_done"`
	TotalFiles   uint64   `json:"total_files"`
	FilesDone    uint64   `json:"files_done"`
	TotalBytes   uint64   `json:"total_bytes"`
	BytesDone    uint64   `json:"bytes_done"`
	ErrorCount   uint64   `json:"error_count"`
	CurrentFiles []string `json:"current_files"`
}

type restoreStatus struct {
	PercentDone   float64 `json:"percent_done"`
	TotalFiles    uint64  `json:"total_files"`
	FilesRestored uint64  `json:"files_restored"`
	FilesSkipped  uint64  `json:"files_skipped"`
	TotalBytes    uint64  `json:"total_bytes"`
	BytesRestored uint64  `json:"bytes_restored"`
	BytesSkipped  uint64  `json:"bytes_skipped"`
}

type errorMessage struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
	During string `json:"during"`
	Item   string `json:"item"`
}

type exitErrorMessage struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// BackupSummary is restic's final `summary` message of a backup.
type BackupSummary struct {
	FilesNew            uint64    `json:"files_new"`
	FilesChanged        uint64    `json:"files_changed"`
	FilesUnmodified     uint64    `json:"files_unmodified"`
	DirsNew             uint64    `json:"dirs_new"`
	DirsChanged         uint64    `json:"dirs_changed"`
	DirsUnmodified      uint64    `json:"dirs_unmodified"`
	DataAdded           uint64    `json:"data_added"`
	DataAddedPacked     uint64    `json:"data_added_packed"`
	TotalFilesProcessed uint64    `json:"total_files_processed"`
	TotalBytesProcessed uint64    `json:"total_bytes_processed"`
	TotalDuration       float64   `json:"total_duration"`
	BackupStart         time.Time `json:"backup_start"`
	BackupEnd           time.Time `json:"backup_end"`
	SnapshotID          string    `json:"snapshot_id"`
}

// RestoreSummary is restic's final `summary` message of a restore.
type RestoreSummary struct {
	TotalFiles    uint64 `json:"total_files"`
	FilesRestored uint64 `json:"files_restored"`
	FilesSkipped  uint64 `json:"files_skipped"`
	TotalBytes    uint64 `json:"total_bytes"`
	BytesRestored uint64 `json:"bytes_restored"`
}

// Node is a file system entry of `restic ls --json`.
type Node struct {
	Name    string    `json:"name"`
	Type    string    `json:"type"`
	Path    string    `json:"path"`
	Size    uint64    `json:"size"`
	ModTime time.Time `json:"mtime"`
}
