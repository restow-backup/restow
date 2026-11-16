package sqlserver

import (
	"encoding/json"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The protocol between the agent and sql.ps1. The agent writes one Request
// as JSON to the script's stdin; the script answers with JSON lines on stdout
// (Line) and ends with exit code 0 (a result line was written), 2 (an error
// line was written) or anything else (it crashed). The error codes of the
// problems are those of the wire contract (api.SQL*).

// Protocol is the version of the request; the script refuses another one.
const Protocol = 1

// Operations of the script.
const (
	OpInventory = "inventory"
	OpBackup    = "backup"
	OpFileList  = "filelist"
	OpRestore   = "restore"
	OpVerify    = "verify"
	OpDrop      = "drop"
	// OpDropRestoring drops one database only while it is in RESTORING:
	// the cleanup after a restore under a new name that did not end.
	OpDropRestoring = "droprestoring"
)

// Exit codes of the script.
const (
	ExitOK      = 0
	ExitHandled = 2
)

// Steps a problem can name (Problem.Step).
const (
	StepRequest      = "request"
	StepLanguageMode = "language_mode"
	StepConnect      = "connect"
	StepLogin        = "login"
	StepInventory    = "inventory"
	StepBackup       = "backup"
	StepHeaderOnly   = "headeronly"
	StepFileListOnly = "filelistonly"
	StepExists       = "exists"
	StepRestore      = "restore"
	StepNewBroker    = "new_broker"
	StepCheckDB      = "checkdb"
	StepDrop         = "drop"
	StepScript       = "script"
	StepStaging      = "staging"
	StepSnapshot     = "snapshot"
	StepFetch        = "fetch"
	StepSpace        = "space"
)

// Request is what the agent sends to the script.
type Request struct {
	Protocol int    `json:"protocol"`
	Op       string `json:"op"`
	Instance string `json:"instance"`
	// DataSource is lpc:.\<instance> (lpc:. for the default instance).
	DataSource string `json:"dataSource"`
	// StepTimeoutSeconds is the CommandTimeout of every statement.
	StepTimeoutSeconds int `json:"stepTimeoutSeconds"`
	// Statements are the fixed T-SQL texts (statements.go); the script runs
	// nothing else.
	Statements map[string]string `json:"statements"`
	Params     json.RawMessage   `json:"params,omitempty"`
}

// Line types of the script's output.
const (
	LineProgress   = "progress"
	LineSQLMessage = "sqlmessage"
	LineResult     = "result"
	LineError      = "error"
)

// Line is one JSON line of the script.
type Line struct {
	Type string `json:"type"`
	// progress: Step and Percent; sqlmessage: Number, Class, State, Message.
	Step    string `json:"step,omitempty"`
	Percent int    `json:"percent,omitempty"`
	Number  int    `json:"number,omitempty"`
	Class   int    `json:"class,omitempty"`
	State   int    `json:"state,omitempty"`
	Message string `json:"message,omitempty"`
	// result: Data; error: Problem.
	Data    json.RawMessage `json:"data,omitempty"`
	Problem *Problem        `json:"problem,omitempty"`
}

// Problem says why an operation failed: an error code of the contract, the
// step, the SQL Server error number (0 when none) and the message.
type Problem = api.SQLProblem

// ---- parameters and results per operation ---------------------------------

// InventoryResult is the result of OpInventory.
type InventoryResult struct {
	LanguageMode             string `json:"languageMode"`
	Version                  string `json:"version"`
	Edition                  string `json:"edition"`
	EngineEdition            int    `json:"engineEdition"`
	Clustered                bool   `json:"clustered"`
	Hadr                     bool   `json:"hadr"`
	BackupCompressionDefault bool   `json:"backupCompressionDefault"`
	DefaultDataPath          string `json:"defaultDataPath"`
	DefaultLogPath           string `json:"defaultLogPath"`
	// TZOffsetMinutes is the server's offset from UTC (DATEPART(TZOFFSET)).
	TZOffsetMinutes int           `json:"tzOffsetMinutes"`
	Login           api.SQLLogin  `json:"login"`
	Databases       []InventoryDB `json:"databases"`
	// Warnings are optional queries that failed (missing VIEW SERVER STATE,
	// no access to msdb); the inventory is still usable.
	Warnings []Problem `json:"warnings,omitempty"`
}

// InventoryDB is one database of the inventory.
type InventoryDB struct {
	Name          string `json:"name"`
	DatabaseID    int    `json:"databaseId"`
	System        bool   `json:"system"`
	FamilyGUID    string `json:"familyGuid"`
	DatabaseGUID  string `json:"databaseGuid"`
	State         string `json:"state"`
	RecoveryModel string `json:"recoveryModel"`
	ReadOnly      bool   `json:"readOnly"`
	Encrypted     bool   `json:"encrypted"`
	// Snapshot: a database snapshot (source_database_id is set).
	Snapshot  bool  `json:"snapshot"`
	SizeBytes int64 `json:"sizeBytes"`
	// UsedBytes are the used pages (sys.allocation_units); -1 when they could
	// not be read (no access to the database).
	UsedBytes int64 `json:"usedBytes"`
	// LogUsedBytes is the used part of the log; -1 when unknown.
	LogUsedBytes int64 `json:"logUsedBytes"`
	CanBackup    bool  `json:"canBackup"`
	// ReplicaRole is PRIMARY or SECONDARY in an availability group, else "".
	ReplicaRole string `json:"replicaRole"`
	// LastFullBackup and LastLogBackup are UTC times from msdb
	// (yyyy-mm-ddThh:mi:ss, display only); "" when none.
	LastFullBackup string   `json:"lastFullBackup"`
	LastLogBackup  string   `json:"lastLogBackup"`
	Files          []DBFile `json:"files"`
}

// DBFile is one file of a database (sys.master_files): Type is ROWS, LOG,
// FILESTREAM or FULLTEXT.
type DBFile struct {
	Type         string `json:"type"`
	PhysicalName string `json:"physicalName"`
}

// BackupParams are the parameters of OpBackup.
type BackupParams struct {
	Database string `json:"database"`
	Path     string `json:"path"`
}

// BackupResult is the result of OpBackup: RESTORE HEADERONLY and RESTORE
// FILELISTONLY of the file just written.
type BackupResult struct {
	Header   Header        `json:"header"`
	FileList []api.SQLFile `json:"fileList"`
}

// Header is the row of RESTORE HEADERONLY. LSNs are decimal strings, GUIDs
// lower case; the times are the server's local time (yyyy-MM-ddTHH:mm:ss),
// TZOffsetMinutes turns them into UTC.
type Header struct {
	BackupType            int    `json:"backupType"`
	DatabaseName          string `json:"databaseName"`
	FamilyGUID            string `json:"familyGuid"`
	Compressed            bool   `json:"compressed"`
	CopyOnly              bool   `json:"copyOnly"`
	HasChecksums          bool   `json:"hasChecksums"`
	FirstLSN              string `json:"firstLsn"`
	LastLSN               string `json:"lastLsn"`
	CheckpointLSN         string `json:"checkpointLsn"`
	DatabaseBackupLSN     string `json:"databaseBackupLsn"`
	FirstRecoveryForkGUID string `json:"firstRecoveryForkGuid"`
	LastRecoveryForkGUID  string `json:"lastRecoveryForkGuid"`
	BeginsLogChain        bool   `json:"beginsLogChain"`
	HasBulkLoggedData     bool   `json:"hasBulkLoggedData"`
	BackupStart           string `json:"backupStart"`
	BackupFinish          string `json:"backupFinish"`
	TZOffsetMinutes       int    `json:"tzOffsetMinutes"`
}

// FileListParams are the parameters of OpFileList. CheckName, when set, is
// a database name whose existence the script reports (NameTaken).
type FileListParams struct {
	Path      string `json:"path"`
	CheckName string `json:"checkName,omitempty"`
}

// FileListResult is the result of OpFileList.
type FileListResult struct {
	FileList []api.SQLFile `json:"fileList"`
	// LastLSN is the last LSN of the backup (RESTORE HEADERONLY).
	LastLSN         string `json:"lastLsn"`
	DefaultDataPath string `json:"defaultDataPath"`
	DefaultLogPath  string `json:"defaultLogPath"`
	NameTaken       bool   `json:"nameTaken"`
}

// RestoreParams are the parameters of OpRestore (restore under a new name).
type RestoreParams struct {
	NewName      string        `json:"newName"`
	Path         string        `json:"path"`
	Moves        []api.SQLMove `json:"moves"`
	Checkdb      bool          `json:"checkdb"`
	PhysicalOnly bool          `json:"physicalOnly"`
}

// RestoreResult is the result of OpRestore.
type RestoreResult struct {
	Restore api.SQLRestoreStep `json:"restore"`
	// Checkdb is nil when it was not asked for or the restore failed.
	Checkdb *api.SQLCheckdbResult `json:"checkdb"`
	// CheckdbRaised are the errors SQL Server raised while CHECKDB ran, and
	// CheckdbProblem why it did not run to its end; JudgeCheckdb reads them.
	CheckdbRaised  []api.SQLError `json:"checkdbRaised,omitempty"`
	CheckdbProblem *Problem       `json:"checkdbProblem,omitempty"`
	// CleanedUp: a restore that failed left a database in RESTORING behind,
	// and the script dropped it (DropRestoring).
	CleanedUp bool `json:"cleanedUp"`
	// Leftover is the state of a database of the new name that a failed
	// restore left and the script did not drop ("" when there is none).
	Leftover string `json:"leftover,omitempty"`
}

// VerifyParams are the parameters of OpVerify (restore as the check name,
// NEW_BROKER, CHECKDB, DROP).
type VerifyParams struct {
	VerifyName   string        `json:"verifyName"`
	Path         string        `json:"path"`
	Moves        []api.SQLMove `json:"moves"`
	PhysicalOnly bool          `json:"physicalOnly"`
}

// VerifyResult is the result of OpVerify.
type VerifyResult struct {
	Restore api.SQLRestoreStep `json:"restore"`
	// Checkdb is nil when the restore failed (CHECKDB did not run).
	Checkdb *api.SQLCheckdbResult `json:"checkdb"`
	// CheckdbProblem says why CHECKDB did not run to its end (time limit,
	// it could not start); nil when it ran.
	CheckdbProblem *Problem `json:"checkdbProblem,omitempty"`
	// CheckdbRaised are the errors SQL Server raised while CHECKDB ran (not
	// the TABLERESULTS rows); JudgeCheckdb decides what they prove.
	CheckdbRaised []api.SQLError `json:"checkdbRaised,omitempty"`
	// NewBroker: ALTER DATABASE ... SET NEW_BROKER succeeded; without it
	// CHECKDB does not run and NewBrokerProblem says why.
	NewBroker        bool     `json:"newBroker"`
	NewBrokerProblem *Problem `json:"newBrokerProblem,omitempty"`
	Dropped          bool     `json:"dropped"`
	// DropError says why the copy could not be dropped (it stays in the
	// journal for the next check).
	DropError *Problem `json:"dropError,omitempty"`
}

// DropParams are the parameters of OpDrop.
type DropParams struct {
	Names []string `json:"names"`
}

// DropResult is the result of OpDrop.
type DropResult struct {
	Dropped []string      `json:"dropped"`
	Failed  []DropFailure `json:"failed"`
}

// DropRestoringParams are the parameters of OpDropRestoring.
type DropRestoringParams struct {
	Name string `json:"name"`
}

// DropRestoringResult is the result of OpDropRestoring: the state the
// database had ("" when there is none) and whether it was dropped.
type DropRestoringResult struct {
	State   string `json:"state"`
	Dropped bool   `json:"dropped"`
}

// DropFailure is a database the script could not drop.
type DropFailure struct {
	Name    string  `json:"name"`
	Problem Problem `json:"problem"`
}
