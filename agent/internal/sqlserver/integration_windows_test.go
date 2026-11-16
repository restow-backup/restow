//go:build windows && sqlintegration

package sqlserver_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

// The flows with the real script runner, the real file system and restic
// against a SQL Server instance of the Windows runner (CI job windows-sql,
// agent/scripts/test-sql-windows.ps1 -Mode sql). The process needs a login
// on the instance (the orchestrator creates one for the runner account; the
// service SID login is tested by the probe service, sqlci).
//
//	RESTOW_TEST_SQL_INSTANCE=SQLEXPRESS RESTIC_BINARY=...\restic.exe
//	go test -tags windowsintegration,sqlintegration -run TestIntegration ./internal/sqlserver/

func integrationEnv(t *testing.T) (*sqlserver.Env, api.SQLInstanceFact, *restic.Runner) {
	inst := os.Getenv("RESTOW_TEST_SQL_INSTANCE")
	bin := os.Getenv("RESTIC_BINARY")
	if inst == "" || bin == "" {
		t.Skip("set RESTOW_TEST_SQL_INSTANCE and RESTIC_BINARY")
	}
	var fact api.SQLInstanceFact
	if w := sysinfo.DetectMachine().Windows; w != nil {
		for _, f := range w.SQLInstances {
			if strings.EqualFold(f.Name, inst) {
				fact = f
			}
		}
	}
	if fact.Name == "" {
		t.Fatalf("instance %s is not in the registry", inst)
	}
	// A short root: the check fetches the backup to RestoreRoot\<run>\<n>
	// followed by the whole path the file had in the snapshot, so the
	// staging path appears twice in the name RESTORE opens, and SQL Server
	// refuses a device name over 259 characters (3057). Below the user's
	// TEMP (C:\Users\RUNNER~1\AppData\Local\Temp\TestIntegration...\001)
	// that is over the limit; the agent's own folders (C:\ProgramData\
	// Restow\data) are not.
	root := shortTempDir(t)
	runner, err := sqlserver.NewScriptRunner(filepath.Join(root, "tmp"), func(s string) { t.Logf("script stderr: %s", s) })
	if err != nil {
		t.Fatal(err)
	}
	fs, err := sqlserver.NewFS()
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "repo")
	r := &restic.Runner{Bin: bin, Repo: repo, Password: "restow-ci-only", CacheDir: filepath.Join(root, "cache"), TmpDir: filepath.Join(root, "restic-tmp")}
	_ = os.MkdirAll(r.TmpDir, 0o700)
	if res, err := r.Command(context.Background(), restic.CommandOptions{Name: "init", Args: []string{"init"}}); err != nil || res.Err() != nil {
		t.Fatalf("init: %v %v", err, res.Err())
	}
	env := &sqlserver.Env{Runner: runner, FS: fs, Restic: r, Log: &testLog{t}, Host: "sql-ci",
		StagingRoot: filepath.Join(root, "staging", "sql"), RestoreRoot: filepath.Join(root, "staging", "sql-restore"),
		JournalPath: filepath.Join(root, "sql-verify-journal.json")}
	return env, fact, r
}

// shortTempDir is a new folder below RUNNER_TEMP (D:\a\_temp on a hosted
// runner), else below the system's TEMP, removed after the test.
func shortTempDir(t *testing.T) string {
	base := os.Getenv("RUNNER_TEMP")
	if base == "" {
		return t.TempDir()
	}
	dir, err := os.MkdirTemp(base, "sqli")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

type testLog struct{ t *testing.T }

func (l *testLog) Infof(f string, a ...any)  { l.t.Logf("INFO "+f, a...) }
func (l *testLog) Warnf(f string, a ...any)  { l.t.Logf("WARN "+f, a...) }
func (l *testLog) Errorf(f string, a ...any) { l.t.Logf("ERROR "+f, a...) }

func TestIntegrationBackupVerifyRestore(t *testing.T) {
	env, fact, _ := integrationEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cfg := &api.SQLConfig{Enabled: true, Mode: api.SQLModeAlongside, Instances: api.SQLInstanceSelection{All: true},
		Databases: api.SQLDatabaseSelection{List: []api.SQLDatabaseRef{{Name: "RestowCi"}}}}
	out := env.BackupInstance(ctx, cfg, fact)
	if out.Status != api.StatusSucceeded || len(out.Report.Databases) != 1 {
		t.Fatalf("backup %+v %+v", out, out.Errors)
	}
	b := out.Report.Databases[0].Backup
	if b == nil || !b.CopyOnly || b.Compressed || !b.Checksum {
		t.Fatalf("backup facts %+v", b)
	}
	db := out.Inventory.Result.Databases
	var used int64
	for _, d := range db {
		if d.Name == "RestowCi" {
			used = d.UsedBytes
		}
	}
	v := env.Verify(ctx, api.SQLVerifyParams{Instance: fact.Name, MaxGiB: 200, Databases: []api.SQLVerifyDatabase{{
		DatabaseID: "ci", BackupID: "ci", Name: "RestowCi", SnapshotID: out.SnapshotID, PathInSnapshot: b.PathInSnapshot,
		SHA256: b.SHA256, Bytes: b.Bytes, UsedBytes: used, FileList: b.FileList}}}, fact, "ci-verify")
	r := v.Report.Databases[0]
	if v.Status != api.StatusSucceeded || !r.SHA256Match || r.Restore == nil || !r.Restore.OK || r.Checkdb == nil || !r.Checkdb.Ran || !r.Dropped {
		t.Fatalf("verify %+v %+v", v, r)
	}
	newName := "RestowCi_restored_" + time.Now().UTC().Format("20060102150405")
	rs := env.Restore(ctx, api.SQLRestoreParams{BackupID: "ci", Instance: fact.Name, TargetInstance: fact.Name, Database: "RestowCi",
		NewName: newName, SnapshotID: out.SnapshotID, PathInSnapshot: b.PathInSnapshot, SHA256: b.SHA256, Bytes: b.Bytes,
		FileList: b.FileList, Checkdb: true, MaxGiB: 200}, fact, "ci-restore")
	if rs.Status != api.StatusSucceeded || !rs.Report.Restored || rs.Report.Checkdb == nil || !rs.Report.Checkdb.Ran {
		t.Fatalf("restore %+v %+v", rs, rs.Report)
	}
}
