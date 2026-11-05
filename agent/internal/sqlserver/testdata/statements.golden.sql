-- The fixed T-SQL of the Restow agent (internal/sqlserver/statements.go).
-- Reviewed text; go test ./internal/sqlserver -run TestStatementsGolden -update rewrites it.

-- BackupFullCopyOnly (@db, @path)
BACKUP DATABASE @db TO DISK = @path WITH COPY_ONLY, CHECKSUM, NO_COMPRESSION, INIT, FORMAT, STATS = 5;

-- CheckDB (@db)
DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + @q + N') WITH NO_INFOMSGS, ALL_ERRORMSGS, TABLERESULTS;';
EXEC sp_executesql @sql;

-- CheckDBPhysicalOnly (@db)
DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + @q + N') WITH PHYSICAL_ONLY, NO_INFOMSGS, ALL_ERRORMSGS, TABLERESULTS;';
EXEC sp_executesql @sql;

-- DbExists (@db)
SELECT CAST(CASE WHEN DB_ID(@db) IS NULL THEN 0 ELSE 1 END AS int) AS present;

-- DropRestoring (@db)
DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @state nvarchar(60) = (SELECT state_desc FROM sys.databases WHERE name = @db);
IF @state = N'RESTORING'
BEGIN
  DECLARE @sql nvarchar(max) = N'DROP DATABASE ' + @q + N';';
  EXEC sp_executesql @sql;
END;
SELECT ISNULL(@state, N'') AS state, CAST(CASE WHEN @state = N'RESTORING' AND DB_ID(@db) IS NULL THEN 1 ELSE 0 END AS int) AS dropped;

-- DropVerifyCopy (@db)
DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL OR CHARINDEX(N'__restow_verify_', @db) = 0 BEGIN; THROW 50002, N'Only check copies are dropped here.', 1; END;
IF DB_ID(@db) IS NOT NULL
BEGIN
  DECLARE @sql nvarchar(max) = N'DROP DATABASE ' + @q + N';';
  IF EXISTS (SELECT 1 FROM sys.databases WHERE name = @db AND state_desc = N'ONLINE')
    SET @sql = N'ALTER DATABASE ' + @q + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ' + @q + N';';
  EXEC sp_executesql @sql;
END;

-- FileListOnly (@path)
RESTORE FILELISTONLY FROM DISK = @path;

-- HeaderOnly (@path)
RESTORE HEADERONLY FROM DISK = @path;

-- InstanceDefaults
SELECT CAST(ISNULL(SERVERPROPERTY('InstanceDefaultDataPath'), N'') AS nvarchar(4000)) AS dataPath,
  CAST(ISNULL(SERVERPROPERTY('InstanceDefaultLogPath'), N'') AS nvarchar(4000)) AS logPath,
  DATEPART(TZOFFSET, SYSDATETIMEOFFSET()) AS tzOffsetMinutes;

-- InventoryBackupHistory
SELECT b.database_name AS name, b.type AS type,
  CONVERT(nvarchar(19), MAX(DATEADD(MINUTE, -15 * CASE WHEN b.time_zone BETWEEN -48 AND 56 THEN b.time_zone ELSE 0 END, b.backup_finish_date)), 126) AS lastAt
FROM msdb.dbo.backupset AS b
WHERE b.type IN ('D', 'L')
GROUP BY b.database_name, b.type;

-- InventoryDatabases
SELECT d.name AS name, d.database_id AS databaseId,
  CAST(CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END AS int) AS isSystem,
  LOWER(CONVERT(nvarchar(36), drs.family_guid)) AS familyGuid,
  LOWER(CONVERT(nvarchar(36), drs.database_guid)) AS databaseGuid,
  d.state_desc AS state, d.recovery_model_desc AS recoveryModel,
  CAST(d.is_read_only AS int) AS readOnly, CAST(d.is_encrypted AS int) AS encrypted,
  CAST(CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END AS int) AS isSnapshot,
  CAST(ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'BACKUP DATABASE'), 0) AS int) AS canBackup
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id = d.database_id
ORDER BY d.database_id;

-- InventoryFiles
SELECT mf.database_id AS databaseId, mf.type_desc AS type, mf.physical_name AS physicalName,
  CAST(mf.size AS bigint) * 8192 AS sizeBytes
FROM sys.master_files AS mf
ORDER BY mf.database_id, mf.file_id;

-- InventoryInstance
SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
  CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition,
  CAST(ISNULL(SERVERPROPERTY('IsClustered'), 0) AS int) AS [clustered],
  CAST(ISNULL(SERVERPROPERTY('IsHadrEnabled'), 0) AS int) AS hadr,
  CAST(ISNULL((SELECT value_in_use FROM sys.configurations WHERE name = N'backup compression default'), 0) AS int) AS compressionDefault;

-- InventoryLogUsage
SELECT RTRIM(pc.instance_name) AS name, CAST(pc.cntr_value AS bigint) * 1024 AS logUsedBytes
FROM sys.dm_os_performance_counters AS pc
WHERE RTRIM(pc.counter_name) = N'Log File(s) Used Size (KB)' AND pc.object_name LIKE N'%:Databases%';

-- InventoryReplicaRoles
SELECT d.database_id AS databaseId, rs.role_desc AS role
FROM sys.databases AS d
JOIN sys.dm_hadr_availability_replica_states AS rs ON rs.replica_id = d.replica_id AND rs.is_local = 1;

-- LoginCheck
SELECT SUSER_SNAME() AS loginName,
  CAST(ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) AS int) AS sysadmin,
  CAST(ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE'), 0) AS int) AS canCreateDatabase;

-- NewBroker (@db)
DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'ALTER DATABASE ' + @q + N' SET NEW_BROKER WITH ROLLBACK IMMEDIATE;';
EXEC sp_executesql @sql;

-- RestoreNewName (@new, @path)
IF DB_ID(@new) IS NOT NULL BEGIN; THROW 50003, N'A database of this name exists already.', 1; END;
RESTORE DATABASE @new FROM DISK = @path WITH {{MOVES}}, CHECKSUM, RECOVERY, STATS = 5;

-- UsedPages (@db)
DECLARE @q nvarchar(258) = QUOTENAME(@db);
IF @q IS NULL BEGIN; THROW 50001, N'The database name is not valid.', 1; END;
DECLARE @sql nvarchar(max) = N'SELECT CAST(ISNULL(SUM(CAST(au.used_pages AS bigint)), 0) * 8192 AS bigint) AS usedBytes FROM ' + @q + N'.sys.allocation_units AS au;';
EXEC sp_executesql @sql;

