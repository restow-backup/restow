// Package share is the inside of restow-share, the runner of file share
// backups (docs/FILESHARES.md section 4). The mounter starts it in a
// short-lived container with the share mounted at /share (read-only for a
// backup, read-write for a restore), a scratch volume at /.restow and the
// share's restic cache at /cache. It talks to the api on the internal
// `runners` network only, with the run's own credential.
//
// The package uses the standard library and agent/internal/{restic,redact,
// buildinfo} only. Everything that touches the kernel (statfs, mountinfo,
// xattrs) sits behind small interfaces so the tests run on any temp folder.
package share

import "time"

// Exit codes of restow-share (docs/FILESHARES.md 4.8).
const (
	ExitOK       = 0
	ExitFailed   = 1
	ExitUsage    = 2
	ExitWarnings = 3
	ExitGuard    = 10
)

// Finish statuses.
const (
	StatusSucceeded = "succeeded"
	StatusWarning   = "warning"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
)

// Run-level failure codes the runner reports in its finish (and probe/list
// answers). The worker maps them to share.* causes (section 11).
const (
	CodeWrongFilesystem  = "wrong_filesystem"
	CodeEmptySource      = "empty_source"
	CodeIncludeMissing   = "include_missing"
	CodePermissionDenied = "permission_denied"
	CodeUnreachable      = "unreachable"
	CodeNotFound         = "not_found"
	CodeRepositoryLocked = "repository_locked"
	CodeRepository       = "repository_damaged"
	CodeQuotaExceeded    = "quota_exceeded"
	CodeRestoreTarget    = "restore_target"
	CodeCopyUnsafeTarget = "copy_unsafe_target"
	CodeCopyEmptySource  = "copy_empty_source"
	CodeResticFailed     = "restic_failed"
	CodeInternal         = "internal"
	CodeCancelled        = "cancelled"
)

// Item codes (per-file problems, 4.8).
const (
	ItemLockedFile      = "locked_file"
	ItemReadError       = "read_error"
	ItemACLUnreadable   = "acl_unreadable"
	ItemACLNotRestored  = "acl_not_restored"
	ItemOwnerNotRestore = "owner_not_restored"
	ItemOfflineSkipped  = "offline_skipped"
	ItemNameInvalid     = "name_invalid"
	ItemFilesDropped    = "files_dropped"
	ItemACLFormatNewer  = "acl_format_newer"
	ItemWriteError      = "write_error"
)

// Progress phases.
const (
	PhasePrepare  = "prepare"
	PhaseScan     = "scan"
	PhaseBackup   = "backup"
	PhaseRestore  = "restore"
	PhaseFinalize = "finalize"
)

// Protocols.
const (
	ProtocolSMB = "smb"
	ProtocolNFS = "nfs"
)

// Session is the answer of GET /internal/file-shares/v1/session (5.2).
type Session struct {
	Run struct {
		ID       string    `json:"id"`
		Kind     string    `json:"kind"` // backup | restore
		ShareID  string    `json:"shareId"`
		Deadline time.Time `json:"deadline"`
	} `json:"run"`
	Expect struct {
		Protocol string `json:"protocol"`
		ReadOnly bool   `json:"readOnly"`
	} `json:"expect"`
	Repository struct {
		URL      string `json:"url"`
		Password string `json:"repositoryPassword"`
	} `json:"repository"`
	Backup  *BackupParams  `json:"backup,omitempty"`
	Restore *RestoreParams `json:"restore,omitempty"`
}

// BackupParams are the backup half of a session.
type BackupParams struct {
	// Includes are folders relative to the share root; empty = everything.
	Includes               []string `json:"includes"`
	Excludes               []string `json:"excludes"`
	CaseInsensitive        bool     `json:"caseInsensitive"`
	ExcludeLargerThanBytes int64    `json:"excludeLargerThanBytes"`
	LimitUploadKiB         int      `json:"limitUploadKiB"`
	ReadConcurrency        int      `json:"readConcurrency"`
	ParentSnapshotID       string   `json:"parentSnapshotId"`
	Previous               *struct {
		SnapshotID string `json:"snapshotId"`
		FileCount  int64  `json:"fileCount"`
	} `json:"previous"`
	AllowEmptyOnce    bool   `json:"allowEmptyOnce"`
	Permissions       string `json:"permissions"` // auto | off
	RereadPermissions bool   `json:"rereadPermissions"`
	SkipOffline       bool   `json:"skipOffline"`
	Samples           int    `json:"samples"`
}

// RestoreParams are the restore half of a session (4.7, 4.10).
type RestoreParams struct {
	SnapshotID string `json:"snapshotId"`
	// Paths are relative to the share root; empty = all.
	Paths []string `json:"paths"`
	// Destination: original | new_folder | folder.
	Destination string `json:"destination"`
	// Folder is the relative folder on the target share (destination folder).
	Folder string `json:"folder"`
	// Conflict: overwrite | keep_both | skip (destination original only).
	Conflict           string `json:"conflict"`
	RestorePermissions bool   `json:"restorePermissions"`
	Verify             bool   `json:"verify"`
	// TargetShareID is the share written into (the run's share for original
	// and new_folder).
	TargetShareID string      `json:"targetShareId"`
	Copy          *CopyParams `json:"copy,omitempty"`
}

// CopyParams mark a restore run of a scheduled copy job (4.10).
type CopyParams struct {
	JobID         string `json:"jobId"`
	SourceShareID string `json:"sourceShareId"`
	Mode          string `json:"mode"` // overwrite | mirror
	// MirrorConfirmed: the admin confirmed a non-empty folder without marker.
	MirrorConfirmed bool `json:"mirrorConfirmed"`
	// LastCopiedFileCount is the file count of the restore point copied last
	// (rule 6); 0 when none.
	LastCopiedFileCount int64 `json:"lastCopiedFileCount"`
	// Force is "Copy anyway" (lifts rule 6).
	Force bool `json:"force"`
}

// ProgressReport is the body of POST /progress.
type ProgressReport struct {
	Phase         string    `json:"phase"`
	FilesDone     uint64    `json:"filesDone"`
	BytesDone     uint64    `json:"bytesDone"`
	TotalFiles    uint64    `json:"totalFiles"`
	TotalBytes    uint64    `json:"totalBytes"`
	CurrentPath   string    `json:"currentPath"`
	BytesUploaded uint64    `json:"bytesUploaded"`
	At            time.Time `json:"at"`
}

// Item is one per-file problem (POST /items).
type Item struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Phase   string `json:"phase"`
}

// SampleFile is one entry of POST /samples.
type SampleFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Finish is the body of POST /finish.
type Finish struct {
	Status     string         `json:"status"`
	Code       string         `json:"code,omitempty"`
	Message    string         `json:"message,omitempty"`
	SnapshotID string         `json:"snapshotId,omitempty"`
	Stats      map[string]any `json:"stats"`
	Restore    *RestoreStats  `json:"restore,omitempty"`
	LogTail    string         `json:"logTail"`
}

// RestoreStats are the counts of a restore (4.7 Finish).
type RestoreStats struct {
	Restored           uint64         `json:"restored"`
	Skipped            uint64         `json:"skipped"`
	Renamed            uint64         `json:"renamed"`
	Identical          uint64         `json:"identical"`
	Failed             uint64         `json:"failed"`
	Deleted            uint64         `json:"deleted"`
	PermissionsApplied map[string]int `json:"permissionsApplied"`
	PermissionsFailed  int            `json:"permissionsFailed"`
	Folder             string         `json:"folder"`
	UpToDate           bool           `json:"upToDate,omitempty"`
}
