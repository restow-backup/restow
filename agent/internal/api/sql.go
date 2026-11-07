package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

// The wire types of the native SQL Server backup (W2a,
// docs/BAREMETAL-WINDOWS.md 5.1 and 6.2). The shared fixtures in
// testdata/contract are the contract with the server; the server's tests
// read the same files. Encoding rules: LSNs are decimal strings (numeric(25,0)
// does not fit into a JSON number), GUIDs lower case with dashes, times RFC
// 3339 UTC, optional fields are omitted rather than null unless a field says
// otherwise.

// SQL modes of a job. W2a knows only SQLModeAlongside: COPY_ONLY fulls that
// leave every backup chain of the customer as it is.
const SQLModeAlongside = "alongside"

// Bounds of the SQL reports.
const (
	MaxSQLDatabases      = 1000
	MaxSQLFileList       = 256
	MaxSQLCheckdbErrors  = 100
	MaxSQLRestoreErrors  = 32
	MaxNotices           = 16
	MaxSQLMessageRunes   = 1000
	MaxSQLInventoryBytes = 64 << 10
	MaxSQLNameRunes      = 128
)

// SQL snapshot tags. The host of a SQL snapshot is the agent's hostname.
const (
	SQLSnapshotTag         = "restow-sql"
	SQLSnapshotInstanceTag = "restow-sql-instance=" // + instance name
)

// Outcomes of a database in a sql run.
const (
	SQLBackedUp = "backed_up"
	SQLSkipped  = "skipped"
	SQLFailed   = "failed"
)

// SQLMethodRestoreCheckdb is the only method of a sql_verify that can prove
// a backup good.
const SQLMethodRestoreCheckdb = "restore+checkdb"

// Error codes of the SQL runs (errors[].code and the code of a database).
const (
	SQLInstanceUnreachable  = "sql_instance_unreachable"
	SQLLoginMissing         = "sql_login_missing"
	SQLPermissionMissing    = "sql_permission_missing"
	SQLPowerShellConstraint = "sql_powershell_constrained"
	SQLStrictEncryption     = "sql_strict_encryption"
	SQLFCIUnsupported       = "sql_fci_unsupported"
	SQLModeUnsupported      = "sql_mode_unsupported"
	SQLStagingUnusable      = "sql_staging_unusable"
	SQLStagingTooSmall      = "sql_staging_too_small"
	SQLDatabaseUnavailable  = "sql_database_unavailable"
	SQLBackupFailed         = "sql_backup_failed"
	SQLSnapshotFailed       = "sql_snapshot_failed"
	SQLScriptFailed         = "sql_script_failed"
	SQLRestoreNameTaken     = "sql_restore_name_taken"
	SQLRestoreNoSpace       = "sql_restore_no_space"
	SQLRestoreFailed        = "sql_restore_failed"
	SQLBackupMismatch       = "sql_backup_mismatch"
	SQLVerifyNoSpace        = "sql_verify_no_space"
	SQLVerifyTimeout        = "sql_verify_timeout"
	SQLVerifySystemDB       = "sql_verify_system_db"
)

// Notice codes (notices[].code).
const (
	NoticeAppFilesNotAppBackup = "app_files_not_app_backup"
	NoticeSQLLogGrowing        = "sql_log_growing"
	NoticeSQLTDECertificate    = "sql_tde_certificate"
	NoticeSQLVersionUntested   = "sql_version_untested"
)

// Subjects of the notice app_files_not_app_backup.
const (
	SubjectSQLServer       = "sql_server"
	SubjectExchange        = "exchange"
	SubjectActiveDirectory = "active_directory"
	SubjectHyperV          = "hyper_v"
)

// Notice is a fixed warning of a run: not an error, nothing failed, but the
// administrator has to know it.
type Notice struct {
	Code     string   `json:"code"`
	Subjects []string `json:"subjects,omitempty"`
	Message  string   `json:"message"`
}

// ---- configuration --------------------------------------------------------

// SQLConfig is config.sql: what the native SQL Server backup of this
// machine covers. Verification is planned by the server and arrives as
// sql_verify tasks; it is not part of the agent's configuration.
type SQLConfig struct {
	Enabled bool `json:"enabled"`
	// Mode is SQLModeAlongside; any other value fails the SQL runs with
	// sql_mode_unsupported (the agent never falls back silently).
	Mode      string               `json:"mode"`
	Instances SQLInstanceSelection `json:"instances"`
	Databases SQLDatabaseSelection `json:"databases"`
	Exclude   []SQLDatabaseRef     `json:"exclude"`
	// StagingDir replaces the default staging folder
	// (C:\ProgramData\Restow\data\staging\sql); absent for the default.
	StagingDir string `json:"stagingDir,omitempty"`
}

// SQLDatabaseRef names a database, optionally of one instance only.
type SQLDatabaseRef struct {
	Instance string `json:"instance,omitempty"`
	Name     string `json:"name"`
}

// SQLInstanceSelection is "all" or a list of instance names.
type SQLInstanceSelection struct {
	All   bool
	Names []string
	// Invalid holds a value the agent does not understand (it backs up
	// nothing then and says so).
	Invalid string
}

// MarshalJSON writes "all" or the list.
func (s SQLInstanceSelection) MarshalJSON() ([]byte, error) {
	if s.All {
		return []byte(`"all"`), nil
	}
	if s.Names == nil {
		return []byte(`[]`), nil
	}
	return json.Marshal(s.Names)
}

// UnmarshalJSON reads "all" or a list of names; anything else is kept in
// Invalid instead of failing the whole configuration.
func (s *SQLInstanceSelection) UnmarshalJSON(b []byte) error {
	*s = SQLInstanceSelection{}
	b = bytes.TrimSpace(b)
	if string(b) == `"all"` {
		s.All = true
		return nil
	}
	if len(b) > 0 && b[0] == '[' {
		var names []string
		if err := json.Unmarshal(b, &names); err == nil {
			s.Names = names
			return nil
		}
	}
	s.Invalid = string(b)
	return nil
}

// Includes reports whether the selection covers an instance (names compare
// without case, as SQL Server does).
func (s SQLInstanceSelection) Includes(name string) bool {
	if s.All {
		return true
	}
	for _, n := range s.Names {
		if equalFold(n, name) {
			return true
		}
	}
	return false
}

// SQLDatabaseSelection is "all" or a list of databases.
type SQLDatabaseSelection struct {
	All     bool
	List    []SQLDatabaseRef
	Invalid string
}

// MarshalJSON writes "all" or the list.
func (s SQLDatabaseSelection) MarshalJSON() ([]byte, error) {
	if s.All {
		return []byte(`"all"`), nil
	}
	if s.List == nil {
		return []byte(`[]`), nil
	}
	return json.Marshal(s.List)
}

// UnmarshalJSON reads "all" or a list of references.
func (s *SQLDatabaseSelection) UnmarshalJSON(b []byte) error {
	*s = SQLDatabaseSelection{}
	b = bytes.TrimSpace(b)
	if string(b) == `"all"` {
		s.All = true
		return nil
	}
	if len(b) > 0 && b[0] == '[' {
		var list []SQLDatabaseRef
		if err := json.Unmarshal(b, &list); err == nil {
			s.List = list
			return nil
		}
	}
	s.Invalid = string(b)
	return nil
}

// equalFold compares instance names without case (ASCII: instance names
// are letters, digits, _, $ and #).
func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if 'a' <= x && x <= 'z' {
			x -= 'a' - 'A'
		}
		if 'a' <= y && y <= 'z' {
			y -= 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

// ---- inventory (heartbeat) ------------------------------------------------

// SQLInventory is heartbeat.sqlInventory.
type SQLInventory struct {
	CollectedAt time.Time `json:"collectedAt"`
	// Truncated: databases were dropped from the end to stay within
	// MaxSQLInventoryBytes.
	Truncated bool                   `json:"truncated"`
	Instances []SQLInventoryInstance `json:"instances"`
}

// Instance states of the inventory.
const (
	SQLInstanceOK    = "ok"
	SQLInstanceError = "error"
)

// SQLInventoryInstance is one instance of the inventory. An instance with
// State SQLInstanceError carries only Name, State, Error and an empty list
// of databases on the wire.
type SQLInventoryInstance struct {
	Name                     string                 `json:"name"`
	State                    string                 `json:"state"`
	Version                  string                 `json:"version,omitempty"`
	Edition                  string                 `json:"edition,omitempty"`
	EngineEdition            int                    `json:"engineEdition,omitempty"`
	Clustered                bool                   `json:"clustered"`
	Hadr                     bool                   `json:"hadr"`
	BackupCompressionDefault bool                   `json:"backupCompressionDefault"`
	Login                    *SQLLogin              `json:"login,omitempty"`
	Error                    *SQLProblem            `json:"error,omitempty"`
	Databases                []SQLInventoryDatabase `json:"databases"`
}

// MarshalJSON leaves out the facts of a connected instance when the instance
// could not be read.
func (i SQLInventoryInstance) MarshalJSON() ([]byte, error) {
	dbs := i.Databases
	if dbs == nil {
		dbs = []SQLInventoryDatabase{}
	}
	if i.State != SQLInstanceOK {
		return json.Marshal(struct {
			Name      string                 `json:"name"`
			State     string                 `json:"state"`
			Error     *SQLProblem            `json:"error,omitempty"`
			Databases []SQLInventoryDatabase `json:"databases"`
		}{i.Name, i.State, i.Error, dbs})
	}
	type plain SQLInventoryInstance
	p := plain(i)
	p.Databases = dbs
	return json.Marshal(p)
}

// SQLLogin is the login the agent connects with and what it may do.
type SQLLogin struct {
	Name              string `json:"name"`
	Sysadmin          bool   `json:"sysadmin"`
	CanCreateDatabase bool   `json:"canCreateDatabase"`
}

// SQLProblem says why an instance (or a step) failed: the code from the
// error codes above, the step of the script, the SQL Server error number
// (0 when none) and the message (bounded).
type SQLProblem struct {
	Code    string `json:"code"`
	Step    string `json:"step"`
	Number  int    `json:"number"`
	Message string `json:"message"`
}

// SQLInventoryDatabase is one database of the inventory.
type SQLInventoryDatabase struct {
	Name         string `json:"name"`
	DatabaseID   int    `json:"databaseId"`
	System       bool   `json:"system"`
	FamilyGUID   string `json:"familyGuid"`
	DatabaseGUID string `json:"databaseGuid"`
	// State is sys.databases.state_desc (ONLINE, OFFLINE, RESTORING, ...).
	State         string `json:"state"`
	RecoveryModel string `json:"recoveryModel"`
	ReadOnly      bool   `json:"readOnly"`
	// Encrypted: TDE is on (its certificate is not backed up by Restow).
	Encrypted bool  `json:"encrypted"`
	SizeBytes int64 `json:"sizeBytes"`
	UsedBytes int64 `json:"usedBytes"`
	// CanBackup: the login may back the database up.
	CanBackup bool `json:"canBackup"`
	// LastFullBackupAt is the newest full of any tool in msdb (display only).
	LastFullBackupAt *time.Time `json:"lastFullBackupAt,omitempty"`
}

// ---- sql run --------------------------------------------------------------

// SQLRunReport is finish.sql of a sql run: one instance.
type SQLRunReport struct {
	Instance  string              `json:"instance"`
	Databases []SQLDatabaseResult `json:"databases"`
}

// SQLDatabaseResult is one database of a sql run.
type SQLDatabaseResult struct {
	Name          string `json:"name"`
	FamilyGUID    string `json:"familyGuid"`
	DatabaseGUID  string `json:"databaseGuid"`
	RecoveryModel string `json:"recoveryModel"`
	// Outcome is SQLBackedUp, SQLSkipped or SQLFailed.
	Outcome string          `json:"outcome"`
	Backup  *SQLBackupFacts `json:"backup,omitempty"`
	// Code and Message say why a database was skipped or failed.
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// SQLBackupFacts describe one backup file, from RESTORE HEADERONLY and
// RESTORE FILELISTONLY of the agent's own file (never from msdb).
type SQLBackupFacts struct {
	Kind       string `json:"kind"` // full
	CopyOnly   bool   `json:"copyOnly"`
	Compressed bool   `json:"compressed"`
	Checksum   bool   `json:"checksum"`
	// PathInSnapshot is where restic keeps the file (/C/ProgramData/...).
	PathInSnapshot        string    `json:"pathInSnapshot"`
	SHA256                string    `json:"sha256"`
	Bytes                 int64     `json:"bytes"`
	FirstLSN              string    `json:"firstLsn"`
	LastLSN               string    `json:"lastLsn"`
	DatabaseBackupLSN     string    `json:"databaseBackupLsn"`
	CheckpointLSN         string    `json:"checkpointLsn"`
	FirstRecoveryForkGUID string    `json:"firstRecoveryForkGuid"`
	LastRecoveryForkGUID  string    `json:"lastRecoveryForkGuid"`
	BeginsLogChain        bool      `json:"beginsLogChain"`
	HasBulkLoggedData     bool      `json:"hasBulkLoggedData"`
	BackupStart           time.Time `json:"backupStart"`
	BackupFinish          time.Time `json:"backupFinish"`
	FileList              []SQLFile `json:"fileList"`
}

// SQLFile is one row of RESTORE FILELISTONLY: Type is D (data), L (log),
// F (full-text catalog) or S (FILESTREAM or memory-optimized container).
type SQLFile struct {
	LogicalName  string `json:"logicalName"`
	Type         string `json:"type"`
	FileGroup    string `json:"fileGroup"`
	FileID       int64  `json:"fileId"`
	SizeBytes    int64  `json:"sizeBytes"`
	PhysicalName string `json:"physicalName"`
}

// ---- tasks ----------------------------------------------------------------

// SQLVerifyParams are the parameters of a sql_verify task: databases of one
// instance, each with the backup to check (the newest active full).
type SQLVerifyParams struct {
	Instance string `json:"instance"`
	// MaxGiB: databases with more used space are checked PHYSICAL_ONLY.
	MaxGiB       int                 `json:"maxGiB"`
	PhysicalOnly bool                `json:"physicalOnly"`
	Databases    []SQLVerifyDatabase `json:"databases"`
}

// SQLVerifyDatabase is one database of a sql_verify task.
type SQLVerifyDatabase struct {
	DatabaseID     string    `json:"databaseId"`
	BackupID       string    `json:"backupId"`
	Name           string    `json:"name"`
	SnapshotID     string    `json:"snapshotId"`
	PathInSnapshot string    `json:"pathInSnapshot"`
	SHA256         string    `json:"sha256"`
	Bytes          int64     `json:"bytes"`
	UsedBytes      int64     `json:"usedBytes"`
	FileList       []SQLFile `json:"fileList"`
}

// SQLRestoreParams are the parameters of a sql_restore task: one backup
// restored under a new name on this machine.
type SQLRestoreParams struct {
	BackupID       string    `json:"backupId"`
	Instance       string    `json:"instance"`
	TargetInstance string    `json:"targetInstance"`
	Database       string    `json:"database"`
	NewName        string    `json:"newName"`
	SnapshotID     string    `json:"snapshotId"`
	PathInSnapshot string    `json:"pathInSnapshot"`
	SHA256         string    `json:"sha256"`
	Bytes          int64     `json:"bytes"`
	FileList       []SQLFile `json:"fileList"`
	Checkdb        bool      `json:"checkdb"`
	MaxGiB         int       `json:"maxGiB"`
}

// ---- sql_verify -----------------------------------------------------------

// SQLVerifyReport is finish.sqlVerify: the facts of each check. The server
// decides from them whether a backup is proven good, proven bad or the check
// is incomplete; the agent never says so itself.
type SQLVerifyReport struct {
	Instance  string            `json:"instance"`
	Databases []SQLVerifyResult `json:"databases"`
}

// SQLVerifyResult is one database of a check. Restore and Checkdb are null
// when the step did not run.
type SQLVerifyResult struct {
	DatabaseID string `json:"databaseId"`
	BackupID   string `json:"backupId"`
	Name       string `json:"name"`
	Method     string `json:"method"`
	// VerifyName is the name the copy was restored under; omitted when the
	// check did not get as far as choosing one.
	VerifyName  string            `json:"verifyName,omitempty"`
	Fetched     bool              `json:"fetched"`
	SHA256Match bool              `json:"sha256Match"`
	Restore     *SQLRestoreStep   `json:"restore"`
	Checkdb     *SQLCheckdbResult `json:"checkdb"`
	Dropped     bool              `json:"dropped"`
	BackupLSN   string            `json:"backupLsn"`
	LogsApplied int               `json:"logsApplied"`
	DurationMs  int64             `json:"durationMs"`
	// Code and Message say why the check is incomplete.
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// SQLRestoreStep is how the RESTORE of a check ended.
type SQLRestoreStep struct {
	OK     bool       `json:"ok"`
	Errors []SQLError `json:"errors"`
}

// SQLError is one error SQL Server raised.
type SQLError struct {
	Number   int    `json:"number"`
	Severity int    `json:"severity"`
	State    int    `json:"state"`
	Message  string `json:"message"`
}

// SQLCheckdbResult is how DBCC CHECKDB ended. Ran is false when it could
// not run (then Errors is empty and the check is incomplete).
type SQLCheckdbResult struct {
	Ran          bool              `json:"ran"`
	PhysicalOnly bool              `json:"physicalOnly"`
	Errors       []SQLCheckdbError `json:"errors"`
	DurationMs   int64             `json:"durationMs"`
}

// SQLCheckdbError is one row of DBCC CHECKDB WITH TABLERESULTS.
type SQLCheckdbError struct {
	Number      int    `json:"number"`
	Level       int    `json:"level"`
	State       int    `json:"state"`
	Message     string `json:"message"`
	RepairLevel string `json:"repairLevel,omitempty"`
	ObjectID    int64  `json:"objectId,omitempty"`
	IndexID     int64  `json:"indexId,omitempty"`
}

// ---- sql_restore ----------------------------------------------------------

// SQLRestoreReport is finish.sqlRestore.
type SQLRestoreReport struct {
	BackupID string `json:"backupId"`
	// Instance is the instance the database was restored on.
	Instance    string            `json:"instance"`
	NewName     string            `json:"newName"`
	Fetched     bool              `json:"fetched"`
	SHA256Match bool              `json:"sha256Match"`
	Restored    bool              `json:"restored"`
	Moves       []SQLMove         `json:"moves"`
	Checkdb     *SQLCheckdbResult `json:"checkdb,omitempty"`
	DurationMs  int64             `json:"durationMs"`
	Code        string            `json:"code,omitempty"`
	Message     string            `json:"message,omitempty"`
}

// SQLMove is where a file of the restored database went.
type SQLMove struct {
	LogicalName  string `json:"logicalName"`
	PhysicalName string `json:"physicalName"`
}

// String is for logs.
func (r SQLDatabaseRef) String() string {
	if r.Instance == "" {
		return r.Name
	}
	return fmt.Sprintf(`%s\%s`, r.Instance, r.Name)
}
