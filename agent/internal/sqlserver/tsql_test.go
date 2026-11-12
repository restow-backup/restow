//go:build sqltsql

package sqlserver

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func at() time.Time { return time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC) }

// The T-SQL of statements.go against SQL Server on Linux (the container
// mcr.microsoft.com/mssql/server with MSSQL_PID=Developer, CI job
// tsql-linux; Express has no backup compression, so the NO_COMPRESSION gate
// cannot be shown there):
// every statement runs with its parameters declared as the script binds
// them, names with ] and ' included. This is the [CI] part of C4: variables
// in BACKUP and RESTORE, NO_COMPRESSION against "backup compression
// default", the column sets the script reads, CHECKDB TABLERESULTS,
// NEW_BROKER, and the DROP through QUOTENAME.
//
//	RESTOW_SQL_CONTAINER=<name> SQLCMDPASSWORD=<sa password> go test -tags sqltsql -run TSQL ./internal/sqlserver/
//
// SQLCMDPASSWORD goes into the container's environment for sqlcmd, never on
// a command line.

func container(t *testing.T) string {
	c := os.Getenv("RESTOW_SQL_CONTAINER")
	if c == "" || os.Getenv("SQLCMDPASSWORD") == "" {
		t.Skip("set RESTOW_SQL_CONTAINER and SQLCMDPASSWORD")
	}
	return c
}

// lit is a T-SQL string literal (test side only: the agent never builds one).
func lit(s string) string { return "N'" + strings.ReplaceAll(s, "'", "''") + "'" }

// declare puts the parameters in front of a statement as the script binds
// them (nvarchar(4000)).
func declare(params map[string]string, text string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("SET NOCOUNT ON;\n")
	for _, k := range keys {
		fmt.Fprintf(&b, "DECLARE %s nvarchar(4000) = %s;\n", k, lit(params[k]))
	}
	b.WriteString(text)
	return b.String()
}

// sqlcmd runs a batch and returns the rows (first result set) as maps.
func sqlcmd(t *testing.T, batch string) ([]map[string]string, error) {
	t.Helper()
	cmd := exec.Command("docker", "exec", "-e", "SQLCMDPASSWORD", container(t), "/opt/mssql-tools18/bin/sqlcmd",
		"-C", "-b", "-S", "localhost", "-U", "sa", "-W", "-s", "\x1f", "-I", "-Q", batch)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%v: %s", err, out)
	}
	return parseTable(string(out)), nil
}

func parseTable(out string) []map[string]string {
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	var rows []map[string]string
	var header []string
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if header == nil {
			// The header is the line above the dashes.
			if i+1 < len(lines) && strings.HasPrefix(lines[i+1], "-") && strings.TrimSpace(l) != "" {
				header = strings.Split(l, "\x1f")
				i++
			}
			continue
		}
		if strings.TrimSpace(l) == "" {
			break
		}
		cells := strings.Split(l, "\x1f")
		row := map[string]string{}
		for j, h := range header {
			if j < len(cells) {
				row[h] = cells[j]
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func mustRun(t *testing.T, name string, params map[string]string) []map[string]string {
	t.Helper()
	rows, err := sqlcmd(t, declare(params, Statements()[name]))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return rows
}

func columns(rows []map[string]string) map[string]bool {
	out := map[string]bool{}
	for _, r := range rows {
		for k := range r {
			out[k] = true
		}
	}
	return out
}

func TestTSQLStatements(t *testing.T) {
	odd := "a]b'c Sales"
	path := "/var/opt/mssql/data/restow-ci-1.bak"
	// The compression gate needs an edition that compresses backups.
	ed, err := sqlcmd(t, "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS e, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS n;")
	if err != nil || len(ed) != 1 {
		t.Fatalf("edition: %v %v", ed, err)
	}
	if ed[0]["e"] == "4" {
		t.Fatalf("%s has no backup compression; run the container with MSSQL_PID=Developer", ed[0]["n"])
	}
	setup := fmt.Sprintf(`SET NOCOUNT ON;
EXEC sp_configure 'backup compression default', 1; RECONFIGURE;
DECLARE @c nvarchar(max) = N'DROP DATABASE ' + QUOTENAME(%[1]s);
IF DB_ID(%[1]s) IS NOT NULL EXEC (@c);
SET @c = N'CREATE DATABASE ' + QUOTENAME(%[1]s) + N'; ALTER DATABASE ' + QUOTENAME(%[1]s) + N' SET RECOVERY FULL;';
EXEC (@c);
SET @c = N'USE ' + QUOTENAME(%[1]s) + N'; CREATE TABLE t (id int PRIMARY KEY, v nvarchar(100)); INSERT INTO t VALUES (1, N''one''), (2, N''two'');';
EXEC (@c);`, lit(odd))
	if _, err := sqlcmd(t, setup); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"InventoryInstance", "InstanceDefaults", "LoginCheck", "InventoryDatabases", "InventoryFiles",
		"InventoryLogUsage", "InventoryReplicaRoles", "InventoryBackupHistory"} {
		mustRun(t, n, nil)
	}
	inst := mustRun(t, "InventoryInstance", nil)
	if len(inst) != 1 || inst[0]["compressionDefault"] != "1" {
		t.Fatalf("instance %v", inst)
	}
	if rows := mustRun(t, "UsedPages", map[string]string{"@db": odd}); len(rows) != 1 || rows[0]["usedBytes"] == "0" {
		t.Fatalf("used pages %v", rows)
	}
	if rows := mustRun(t, "DbExists", map[string]string{"@db": odd}); rows[0]["present"] != "1" {
		t.Fatalf("exists %v", rows)
	}
	// A name QUOTENAME cannot quote is refused before anything runs.
	if _, err := sqlcmd(t, declare(map[string]string{"@db": strings.Repeat("x", 129)}, UsedPages)); err == nil || !strings.Contains(err.Error(), "50001") {
		t.Fatalf("long name: %v", err)
	}

	mustRun(t, "BackupFullCopyOnly", map[string]string{"@db": odd, "@path": path})
	head := mustRun(t, "HeaderOnly", map[string]string{"@path": path})
	cols := columns(head)
	for _, c := range []string{"BackupType", "DatabaseName", "FamilyGUID", "Compressed", "IsCopyOnly", "HasBackupChecksums", "FirstLSN", "LastLSN",
		"CheckpointLSN", "DatabaseBackupLSN", "FirstRecoveryForkID", "RecoveryForkID", "BeginsLogChain", "HasBulkLoggedData",
		"BackupStartDate", "BackupFinishDate"} {
		if !cols[c] {
			t.Errorf("HEADERONLY has no column %s", c)
		}
	}
	if h := head[0]; h["Compressed"] != "0" || h["IsCopyOnly"] != "1" || h["HasBackupChecksums"] != "1" || h["DatabaseName"] != odd {
		t.Fatalf("header %v (NO_COMPRESSION must win over the compression default)", h)
	}
	// The customer's chain is untouched: msdb records a copy-only backup.
	hist, err := sqlcmd(t, "SET NOCOUNT ON; SELECT TOP (1) CAST(is_copy_only AS int) AS c FROM msdb.dbo.backupset WHERE database_name = "+lit(odd)+" ORDER BY backup_set_id DESC;")
	if err != nil || len(hist) != 1 || hist[0]["c"] != "1" {
		t.Fatalf("msdb %v %v", hist, err)
	}
	files := mustRun(t, "FileListOnly", map[string]string{"@path": path})
	cols = columns(files)
	// SQL Server spells it FileId; sql.ps1 reads the columns without regard
	// to case.
	for _, c := range []string{"LogicalName", "PhysicalName", "Type", "FileGroupName", "Size", "FileId"} {
		if !cols[c] {
			t.Errorf("FILELISTONLY has no column %s", c)
		}
	}
	if len(files) != 2 {
		t.Fatalf("files %v", files)
	}

	verify := VerifyName(odd, at())
	params := map[string]string{"@new": verify, "@path": path}
	for i, f := range files {
		params[fmt.Sprintf("@l%d", i)] = f["LogicalName"]
		params[fmt.Sprintf("@p%d", i)] = fmt.Sprintf("/var/opt/mssql/data/restow-ci-%d.%s", i, map[string]string{"D": "mdf", "L": "ldf"}[f["Type"]])
	}
	restore := strings.Replace(RestoreNewName, MovesSlot, "MOVE @l0 TO @p0, MOVE @l1 TO @p1", 1)
	// A name that exists is refused in the batch, before RESTORE touches it.
	taken := map[string]string{"@new": odd, "@path": path, "@l0": files[0]["LogicalName"], "@p0": "/var/opt/mssql/data/restow-ci-x0.mdf",
		"@l1": files[1]["LogicalName"], "@p1": "/var/opt/mssql/data/restow-ci-x1.ldf"}
	if _, err := sqlcmd(t, declare(taken, restore)); err == nil || !strings.Contains(err.Error(), "50003") {
		t.Fatalf("restore over an existing name: %v", err)
	}
	if _, err := sqlcmd(t, declare(params, restore)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	mustRun(t, "NewBroker", map[string]string{"@db": verify})
	if rows := mustRun(t, "CheckDB", map[string]string{"@db": verify}); len(rows) != 0 {
		t.Fatalf("CHECKDB of a sound copy: %v", rows)
	}
	mustRun(t, "CheckDBPhysicalOnly", map[string]string{"@db": verify})
	// The columns the script reads from TABLERESULTS (the summary row of a
	// CHECKDB without NO_INFOMSGS shows them).
	all, err := sqlcmd(t, "SET NOCOUNT ON; DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + QUOTENAME("+lit(verify)+") + N') WITH TABLERESULTS'; EXEC sp_executesql @sql;")
	if err != nil {
		t.Fatal(err)
	}
	cols = columns(all)
	for _, c := range []string{"Error", "Level", "State", "MessageText", "RepairLevel", "ObjectId", "IndexId"} {
		if !cols[c] {
			t.Errorf("CHECKDB TABLERESULTS has no column %s", c)
		}
	}
	// DropVerifyCopy refuses the original, drops the copy.
	if _, err := sqlcmd(t, declare(map[string]string{"@db": odd}, DropVerifyCopy)); err == nil || !strings.Contains(err.Error(), "50002") {
		t.Fatalf("DropVerifyCopy of the original: %v", err)
	}
	mustRun(t, "DropVerifyCopy", map[string]string{"@db": verify})
	if rows := mustRun(t, "DbExists", map[string]string{"@db": verify}); rows[0]["present"] != "0" {
		t.Fatal("the check copy is still there")
	}
	if rows := mustRun(t, "DbExists", map[string]string{"@db": odd}); rows[0]["present"] != "1" {
		t.Fatal("the original is gone")
	}
	// CHECKDB of a database that is not there raises 2520: the check did
	// not run, which JudgeCheckdb reports as incomplete, not red.
	_, err = sqlcmd(t, declare(map[string]string{"@db": "restow-ci-missing"}, CheckDB))
	nums := msgNumbers(err)
	if len(nums) == 0 {
		t.Fatalf("CHECKDB of a missing database: %v", err)
	}
	var raised []api.SQLError
	for _, n := range nums {
		raised = append(raised, api.SQLError{Number: n, Severity: 16, State: 1, Message: "from the server"})
	}
	if c, prob := JudgeCheckdb(api.SQLCheckdbResult{}, raised, &Problem{Code: api.SQLScriptFailed}); c.Ran || prob == nil || len(c.Errors) != 0 {
		t.Fatalf("CHECKDB of a missing database (%v) judged %+v %+v", nums, c, prob)
	}

	// DropRestoring leaves an ONLINE database alone and drops one in
	// RESTORING (what a RESTORE that did not end leaves).
	if rows := mustRun(t, "DropRestoring", map[string]string{"@db": odd}); len(rows) != 1 || rows[0]["state"] != "ONLINE" || rows[0]["dropped"] != "0" {
		t.Fatalf("DropRestoring of an ONLINE database: %v", rows)
	}
	if rows := mustRun(t, "DbExists", map[string]string{"@db": odd}); rows[0]["present"] != "1" {
		t.Fatal("DropRestoring dropped an ONLINE database")
	}
	half := "a]b'c restoring"
	norecovery := strings.Replace(strings.Replace(restore, ", RECOVERY,", ", NORECOVERY,", 1), "@new", "@half", -1)
	params["@half"] = half
	if _, err := sqlcmd(t, declare(params, norecovery)); err != nil {
		t.Fatalf("restore WITH NORECOVERY: %v", err)
	}
	if rows := mustRun(t, "DropRestoring", map[string]string{"@db": half}); len(rows) != 1 || rows[0]["state"] != "RESTORING" || rows[0]["dropped"] != "1" {
		t.Fatalf("DropRestoring of a database in RESTORING: %v", rows)
	}
	if rows := mustRun(t, "DropRestoring", map[string]string{"@db": half}); len(rows) != 1 || rows[0]["state"] != "" || rows[0]["dropped"] != "0" {
		t.Fatalf("DropRestoring of a missing database: %v", rows)
	}
	if _, err := sqlcmd(t, fmt.Sprintf("DECLARE @c nvarchar(max) = N'DROP DATABASE ' + QUOTENAME(%[1]s); IF DB_ID(%[1]s) IS NOT NULL EXEC (@c);", lit(odd))); err != nil {
		t.Fatal(err)
	}
}

// msgNumbers are the error numbers in sqlcmd's output ("Msg 2520, Level 16").
func msgNumbers(err error) []int {
	if err == nil {
		return nil
	}
	var out []int
	for _, m := range regexp.MustCompile(`Msg (\d+), Level`).FindAllStringSubmatch(err.Error(), -1) {
		n, _ := strconv.Atoi(m[1])
		out = append(out, n)
	}
	return out
}
