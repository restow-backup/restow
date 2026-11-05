package sqlserver

import "sort"

// This file is the only source of T-SQL of the agent (C4,
// docs/BAREMETAL-WINDOWS.md 5.1.2). Every text is fixed; names and paths go
// in as parameters (@db, @path, @new, @l<n>, @p<n>). Commands that take no
// variable as a database name (ALTER DATABASE, DBCC CHECKDB, DROP DATABASE,
// a query in another database) are built on the server with QUOTENAME and
// run with sp_executesql; QUOTENAME of a name longer than 128 characters is
// NULL, which every such text refuses before it runs anything. The texts are
// sent to the script in Request.Statements, and the script runs nothing
// else (a test checks every name it uses). testdata/statements.golden.sql
// holds them as reviewed; the T-SQL test (tsql_test.go, build tag sqltsql)
// runs each of them against SQL Server on Linux.

// MovesSlot is where RestoreNewName takes its MOVE clauses. The script fills
// it only with placeholders (MOVE @l0 TO @p0, MOVE @l1 TO @p1, ...), built by
// New-RestowMoveClause from an integer loop; no name ever goes into the text.
const MovesSlot = "{{MOVES}}"

// Instance facts.
const (
	// InventoryInstance: version, edition, failover cluster, availability
	// groups, the backup compression default.
	InventoryInstance = `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
  CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition,
  CAST(ISNULL(SERVERPROPERTY('IsClustered'), 0) AS int) AS [clustered],
  CAST(ISNULL(SERVERPROPERTY('IsHadrEnabled'), 0) AS int) AS hadr,
  CAST(ISNULL((SELECT value_in_use FROM sys.configurations WHERE name = N'backup compression default'), 0) AS int) AS compressionDefault;`

	// InstanceDefaults: the default folders of new database files and the
	// server's offset from UTC (msdb and HEADERONLY keep local times).
	InstanceDefaults = `SELECT CAST(ISNULL(SERVERPROPERTY('InstanceDefaultDataPath'), N'') AS nvarchar(4000)) AS dataPath,
  CAST(ISNULL(SERVERPROPERTY('InstanceDefaultLogPath'), N'') AS nvarchar(4000)) AS logPath,
  DATEPART(TZOFFSET, SYSDATETIMEOFFSET()) AS tzOffsetMinutes;`

	// LoginCheck: who the agent is to SQL Server and what it may do.
	LoginCheck = `SELECT SUSER_SNAME() AS loginName,
  CAST(ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) AS int) AS sysadmin,
  CAST(ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE'), 0) AS int) AS canCreateDatabase;`
)

// Inventory of the databases.
const (
	// InventoryDatabases: one row per database with the identity of its
	// backup chain (family_guid, database_guid) and whether the login may
	// back it up.
	InventoryDatabases = `SELECT d.name AS name, d.database_id AS databaseId,
  CAST(CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END AS int) AS isSystem,
  LOWER(CONVERT(nvarchar(36), drs.family_guid)) AS familyGuid,
  LOWER(CONVERT(nvarchar(36), drs.database_guid)) AS databaseGuid,
  d.state_desc AS state, d.recovery_model_desc AS recoveryModel,
  CAST(d.is_read_only AS int) AS readOnly, CAST(d.is_encrypted AS int) AS encrypted,
  CAST(CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END AS int) AS isSnapshot,
  CAST(ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'BACKUP DATABASE'), 0) AS int) AS canBackup
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id = d.database_id
ORDER BY d.database_id;`

	// InventoryFiles: the files of every database (their size, and the
	// names the file backup leaves out while the native backup is on).
	InventoryFiles = `SELECT mf.database_id AS databaseId, mf.type_desc AS type, mf.physical_name AS physicalName,
  CAST(mf.size AS bigint) * 8192 AS sizeBytes
FROM sys.master_files AS mf
ORDER BY mf.database_id, mf.file_id;`

	// InventoryLogUsage: the used part of each log (needs VIEW SERVER STATE;
	// optional).
	InventoryLogUsage = `SELECT RTRIM(pc.instance_name) AS name, CAST(pc.cntr_value AS bigint) * 1024 AS logUsedBytes
FROM sys.dm_os_performance_counters AS pc
WHERE RTRIM(pc.counter_name) = N'Log File(s) Used Size (KB)' AND pc.object_name LIKE N'%:Databases%';`

	// InventoryReplicaRoles: the role of the local replica of databases in an
	// availability group (needs VIEW SERVER STATE; optional).
	InventoryReplicaRoles = `SELECT d.database_id AS databaseId, rs.role_desc AS role
FROM sys.databases AS d
JOIN sys.dm_hadr_availability_replica_states AS rs ON rs.replica_id = d.replica_id AND rs.is_local = 1;`

	// InventoryBackupHistory: the newest full and log backup of any tool,
	// in UTC, for display only (chain facts never come from msdb; optional).
	InventoryBackupHistory = `SELECT b.database_name AS name, b.type AS type,
  CONVERT(nvarchar(19), MAX(DATEADD(MINUTE, -15 * CASE WHEN b.time_zone BETWEEN -48 AND 56 THEN b.time_zone ELSE 0 END, b.backup_finish_date)), 126) AS lastAt
FROM msdb.dbo.backupset AS b
WHERE b.type IN ('D', 'L')
GROUP BY b.database_name, b.type;`

	// UsedPages: the used pages of one database, for the space planning.
	UsedPages = `DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'SELECT CAST(ISNULL(SUM(CAST(au.used_pages AS bigint)), 0) * 8192 AS bigint) AS usedBytes FROM ' + @q + N'.sys.allocation_units AS au;';
EXEC sp_executesql @sql;`

	// DbExists: whether a database of that name exists.
	DbExists = `SELECT CAST(CASE WHEN DB_ID(@db) IS NULL THEN 0 ELSE 1 END AS int) AS present;`
)

// Backup and the facts of a backup file.
const (
	// BackupFullCopyOnly writes a full that is no part of any backup chain
	// (COPY_ONLY), with checksums, never compressed (the server option
	// "backup compression default" would otherwise compress it and spoil the
	// deduplication), into a new media set.
	BackupFullCopyOnly = `BACKUP DATABASE @db TO DISK = @path WITH COPY_ONLY, CHECKSUM, NO_COMPRESSION, INIT, FORMAT, STATS = 5;`

	// HeaderOnly reads the backup set of the file (LSNs, forks, flags).
	HeaderOnly = `RESTORE HEADERONLY FROM DISK = @path;`

	// FileListOnly lists the database files in the backup (the MOVE sources).
	FileListOnly = `RESTORE FILELISTONLY FROM DISK = @path;`
)

// Restore, check and cleanup.
const (
	// RestoreNewName restores a backup under a new name; MovesSlot takes the
	// placeholder clauses. The name is checked in the same batch (error
	// 50003): a database that appeared since the script looked is never
	// restored over, and the cleanup after a failed RESTORE never touches it.
	RestoreNewName = `IF DB_ID(@new) IS NOT NULL BEGIN; THROW 50003, N'A database of this name exists already.', 1; END;
RESTORE DATABASE @new FROM DISK = @path WITH ` + MovesSlot + `, CHECKSUM, RECOVERY, STATS = 5;`

	// NewBroker cuts a restored copy off the Service Broker of production.
	NewBroker = `DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'ALTER DATABASE ' + @q + N' SET NEW_BROKER WITH ROLLBACK IMMEDIATE;';
EXEC sp_executesql @sql;`

	// CheckDB checks a database logically and physically; the errors come
	// back as rows (TABLERESULTS).
	CheckDB = `DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + @q + N') WITH NO_INFOMSGS, ALL_ERRORMSGS, TABLERESULTS;';
EXEC sp_executesql @sql;`

	// CheckDBPhysicalOnly checks only the physical structure (large
	// databases, or when the job asks for it).
	CheckDBPhysicalOnly = `DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + @q + N') WITH PHYSICAL_ONLY, NO_INFOMSGS, ALL_ERRORMSGS, TABLERESULTS;';
EXEC sp_executesql @sql;`

	// DropRestoring drops a database only while it is in the RESTORING
	// state: what a RESTORE under a new name leaves when it fails halfway or
	// is killed. A database that is ONLINE (or in any other state) is never
	// dropped here, whoever created it; the row says what was found.
	DropRestoring = `DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @state nvarchar(60) = (SELECT state_desc FROM sys.databases WHERE name = @db);
IF @state = N'RESTORING'
BEGIN
  DECLARE @sql nvarchar(max) = N'DROP DATABASE ' + @q + N';';
  EXEC sp_executesql @sql;
END;
SELECT ISNULL(@state, N'') AS state, CAST(CASE WHEN @state = N'RESTORING' AND DB_ID(@db) IS NULL THEN 1 ELSE 0 END AS int) AS dropped;`

	// DropVerifyCopy drops a check copy in any state (an ONLINE one is first
	// set to SINGLE_USER, so open connections do not block it); it refuses
	// any name without the check marker, whatever the agent asks for.
	DropVerifyCopy = `DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL OR CHARINDEX(N'__restow_verify_', @db) = 0 BEGIN; THROW 50002, N'Only check copies are dropped here.', 1; END;
IF DB_ID(@db) IS NOT NULL
BEGIN
  DECLARE @sql nvarchar(max) = N'DROP DATABASE ' + @q + N';';
  IF EXISTS (SELECT 1 FROM sys.databases WHERE name = @db AND state_desc = N'ONLINE')
    SET @sql = N'ALTER DATABASE ' + @q + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ' + @q + N';';
  EXEC sp_executesql @sql;
END;`
)

// Statements returns every text by its name, as the script receives them.
func Statements() map[string]string {
	return map[string]string{
		"InventoryInstance":      InventoryInstance,
		"InstanceDefaults":       InstanceDefaults,
		"LoginCheck":             LoginCheck,
		"InventoryDatabases":     InventoryDatabases,
		"InventoryFiles":         InventoryFiles,
		"InventoryLogUsage":      InventoryLogUsage,
		"InventoryReplicaRoles":  InventoryReplicaRoles,
		"InventoryBackupHistory": InventoryBackupHistory,
		"UsedPages":              UsedPages,
		"DbExists":               DbExists,
		"BackupFullCopyOnly":     BackupFullCopyOnly,
		"HeaderOnly":             HeaderOnly,
		"FileListOnly":           FileListOnly,
		"RestoreNewName":         RestoreNewName,
		"NewBroker":              NewBroker,
		"CheckDB":                CheckDB,
		"CheckDBPhysicalOnly":    CheckDBPhysicalOnly,
		"DropRestoring":          DropRestoring,
		"DropVerifyCopy":         DropVerifyCopy,
	}
}

// StatementNames are the names of Statements, sorted.
func StatementNames() []string {
	m := Statements()
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// StatementParams are the parameters each text declares (the T-SQL test
// declares them, the script binds exactly these). RestoreNewName also takes
// the @l<n>/@p<n> pairs of its MOVE clauses.
var StatementParams = map[string][]string{
	"UsedPages":           {"@db"},
	"DbExists":            {"@db"},
	"BackupFullCopyOnly":  {"@db", "@path"},
	"HeaderOnly":          {"@path"},
	"FileListOnly":        {"@path"},
	"RestoreNewName":      {"@new", "@path"},
	"NewBroker":           {"@db"},
	"CheckDB":             {"@db"},
	"CheckDBPhysicalOnly": {"@db"},
	"DropRestoring":       {"@db"},
	"DropVerifyCopy":      {"@db"},
}
