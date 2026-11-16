// Package sqlserver is the native SQL Server backup of the Windows agent
// (W2a, docs/BAREMETAL-WINDOWS.md 5.1): COPY_ONLY fulls that leave every
// backup chain of the customer as it is, a restore under a new name, and the
// check of a backup from the repository with DBCC CHECKDB.
//
// # Flow
//
// A sql run backs up one instance: the agent clears the instance's staging
// folder, asks the script for the inventory (connection, language mode,
// login and permissions, failover cluster), selects the databases (no
// tempdb, no database snapshot, only ONLINE databases, without the excluded
// ones), plans the space cumulatively, lets SQL Server write one BACKUP
// DATABASE ... COPY_ONLY file per database, reads RESTORE HEADERONLY and
// RESTORE FILELISTONLY of that file, hashes it, backs the instance folder up
// with restic (tags restow-sql and restow-sql-instance=<name>) and deletes
// the staging files only after the snapshot exists. A sql_verify task
// fetches the newest full of each database from the repository (never from
// the staging folder), checks its SHA-256, restores it under a check name,
// cuts it off the Service Broker (NEW_BROKER), runs DBCC CHECKDB and drops
// it again. A sql_restore task fetches a backup and restores it under a new
// name. The server judges every check; the agent reports facts only.
//
// # Accounts
//
// The agent runs as LocalSystem with the service SID NT SERVICE\RestowAgent.
// SQL Server gives neither SYSTEM nor the Administrators sysadmin; the DBA
// creates a login for the service SID (the server shows the T-SQL). The
// script connects over Shared Memory (lpc:.\<instance>) with integrated
// authentication; no SQL credential is stored anywhere. SQL Server writes and
// reads the .bak files under its own service account, so its service SID
// (NT SERVICE\MSSQL$<name> or NT SERVICE\MSSQLSERVER) gets Modify on the
// instance's staging folder and Read on the restore staging folder; nobody
// else but SYSTEM and the Administrators has access.
//
// # Decisions (docs/BAREMETAL-WINDOWS.md, "Stand der Umsetzung", C4 to C7)
//
// C4: every T-SQL text is fixed (statements.go, the only source of T-SQL).
// BACKUP and RESTORE take names and paths as SqlParameter. DBCC CHECKDB,
// ALTER DATABASE ... SET NEW_BROKER and DROP DATABASE do not take a variable
// as database name, so a fixed text builds the command on the server with
// QUOTENAME(@db) and runs it with sp_executesql. The only text assembled in
// the client is the list of MOVE clauses, and it consists of placeholders
// only (MOVE @l0 TO @p0, ...), built by one function of the script.
//
// C5: the driver's CommandTimeout is the step limit the agent sends; at the
// limit the driver sends an attention to the server, which aborts the
// statement. As a backstop the agent terminates the script's Job object at
// the limit plus five minutes; a stop in the Restow UI terminates it at once
// (SQL Server then aborts the statement, and the next check cleans up what
// was left).
//
// C6: the script runs in its own runner (runner_windows.go), not as a hook:
// it needs stdin for its request and stdout without stderr for its answer.
// It reuses the hook runner's PowerShell, process environment and Job
// object, and needs no local hook permission: its content comes from the
// signed agent (go:embed) and its file is checked against that before each
// start.
//
// C7: a check copy is named <first 80 runes of db>__restow_verify_<UTC time>.
// Before each RESTORE the agent writes the planned name to a local journal;
// the cleanup before the next check drops only names that are in the journal
// and match the pattern, never a database that merely looks like one.
package sqlserver
