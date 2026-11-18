//go:build !windows

package dbrun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// The agent's backup and restore runs against a real PostgreSQL with TLS
// (docs/DATABASES.md 16 "D3"): a dump through the relay into a restic
// repository, a restore into a new database, the refusals. Runs when
// RESTOW_TEST_DATABASE_TLS_URL points at a PostgreSQL with ssl = on and
// restic and the client programs are installed; skipped otherwise (the job
// agent sets neither, the API and worker suites prove the same against CI's
// TLS server).

// TestMain lets restic start this test binary as db-stream.
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "db-stream" {
		var spec StreamSpec
		raw, err := os.ReadFile(os.Args[3])
		if err != nil || json.Unmarshal(raw, &spec) != nil {
			os.Exit(1)
		}
		os.Exit(Stream(context.Background(), spec, os.Stdout))
	}
	os.Exit(m.Run())
}

type pgEnv struct {
	host, user, password string
	port                 int
	fingerprint          string
}

func pgTarget(t *testing.T) pgEnv {
	raw := os.Getenv("RESTOW_TEST_DATABASE_TLS_URL")
	if raw == "" {
		t.Skip("RESTOW_TEST_DATABASE_TLS_URL is not set")
	}
	if _, err := exec.LookPath("restic"); err != nil {
		t.Skip("restic is not installed")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	port := 5432
	if p := u.Port(); p != "" {
		port, _ = strconv.Atoi(p)
	}
	pw, _ := u.User.Password()
	env := pgEnv{host: u.Hostname(), user: u.User.Username(), password: pw, port: port}
	p, err := dbprobe.OpenPinned(context.Background(), dbprobe.PinnedTarget{Host: env.host, Port: env.port}, 10*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	env.fingerprint = p.Fingerprint
	p.Close()
	return env
}

func (e pgEnv) admin(t *testing.T, database string) *dbprobe.PinnedConn {
	t.Helper()
	p, err := dbprobe.OpenPinned(context.Background(), dbprobe.PinnedTarget{Host: e.host, Port: e.port, Fingerprint: e.fingerprint}, 10*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.SignIn(e.user, &e.password, database); err != nil {
		t.Fatal(err)
	}
	return p
}

func (e pgEnv) exec(t *testing.T, database, sql string) [][]*string {
	t.Helper()
	p := e.admin(t, database)
	defer p.Close()
	rows, err := p.Query(sql)
	if err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return rows
}

func suffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// claim: DB-007
func TestAgentBacksUpAndRestoresIntoANewDatabase(t *testing.T) {
	env := pgTarget(t)
	s := suffix()
	source := "restow_d3_agent_src_" + s
	env.exec(t, "postgres", "CREATE DATABASE "+QuoteIdent(source))
	defer env.exec(t, "postgres", "DROP DATABASE IF EXISTS "+QuoteIdent(source)+" WITH (FORCE)")
	env.exec(t, source, "CREATE TABLE orders (id int PRIMARY KEY, item text); INSERT INTO orders VALUES (1, 'tea'), (2, 'cake')")

	repo := t.TempDir()
	self, _ := os.Executable()
	runner := restic.Runner{Bin: "restic", CacheDir: t.TempDir(), TmpDir: t.TempDir()}
	init := runner
	init.Repo, init.Password = repo, "repo-pass"
	if res, err := init.Command(context.Background(), restic.CommandOptions{Name: "init", Args: []string{"init"}}); err != nil || res.Err() != nil {
		t.Fatalf("restic init: %v %v", err, res.Err())
	}
	host, port, user, pass, fp := env.host, env.port, env.user, env.password, env.fingerprint
	spec := &api.DBRunSpec{RunID: "r1", Kind: "backup", MaxDurationSeconds: 600, Repository: &api.DBRunRepository{URL: repo, RepositoryPassword: "repo-pass"}}
	spec.Connection = api.DBRunConnection{ConnectionID: "c1", Engine: "postgresql", Host: &host, Port: &port, AuthMethod: "password", User: &user, Password: &pass, PinnedFingerprintSHA256: &fp}
	spec.Connection.Selection.Mode = "selected"
	spec.Connection.Selection.Names = []string{source}
	deps := Deps{Restic: runner, Self: self}
	report := Backup(context.Background(), spec, deps)
	// The restore reads its one dump the way the server streams it (here: restic dump).
	dumper := runner
	dumper.Repo, dumper.Password = repo, "repo-pass"
	if report.Status != "succeeded" || report.Error != nil {
		t.Fatalf("backup: %+v %+v", report, report.Error)
	}
	if len(report.Backups) != 2 || report.Instance == nil || report.Instance.SystemIdentifier == "" {
		t.Fatalf("report %+v", report)
	}
	dump := report.Backups[0]
	if dump.Kind != "database" || dump.Name != source || len(dump.SHA256) != 64 || dump.Objects["TABLE"] != 1 || dump.Objects["TABLE DATA"] != 1 {
		t.Fatalf("dump %+v", dump)
	}
	if len(dump.SnapshotID) != 64 {
		t.Fatalf("snapshot id %q is not the full one", dump.SnapshotID)
	}
	deps.ReadDump = func(ctx context.Context, w io.Writer) error {
		return dumper.Dump(ctx, dump.SnapshotID, "/"+dump.FileName, w, 0, restic.DumpOptions{})
	}
	// Every snapshot names its run (the server checks the report against it).
	var snapshots []struct {
		ID   string   `json:"id"`
		Tags []string `json:"tags"`
		Host string   `json:"hostname"`
	}
	if res, err := dumper.Command(context.Background(), restic.CommandOptions{Name: "snapshots", Args: []string{"snapshots", "--json"}, OnStdoutLine: func(line []byte) {
		_ = json.Unmarshal(line, &snapshots)
	}}); err != nil || res.Err() != nil || len(snapshots) != 2 {
		t.Fatalf("snapshots %v", snapshots)
	}
	for _, snap := range snapshots {
		if snap.Host != "restow-db" || !slices.Contains(snap.Tags, "restow-db-run=r1") {
			t.Fatalf("snapshot %+v", snap)
		}
	}

	// Restore under a new name; the name taken and a wrong certificate are refused.
	target := "restow_d3_agent_dst_" + s
	defer env.exec(t, "postgres", "DROP DATABASE IF EXISTS "+QuoteIdent(target)+" WITH (FORCE)")
	restore := *spec
	restore.Kind = "restore"
	restore.Repository = nil
	restore.Restore = &api.DBRunRestore{FileName: dump.FileName, SHA256: dump.SHA256, TargetName: target}
	done := Restore(context.Background(), &restore, deps)
	if done.Status != "succeeded" || done.TargetOID == nil {
		t.Fatalf("restore: %+v %+v", done, done.Error)
	}
	rows := env.exec(t, target, "SELECT item FROM orders ORDER BY id")
	if len(rows) != 2 || *rows[0][0] != "tea" {
		t.Fatalf("restored rows %v", rows)
	}
	taken := restore
	taken.Restore = &api.DBRunRestore{FileName: dump.FileName, SHA256: dump.SHA256, TargetName: source}
	if r := Restore(context.Background(), &taken, deps); r.Error == nil || r.Error.Code != "db_restore_name_taken" {
		t.Fatalf("name taken: %+v", r.Error)
	}
	// The run's own database is dropped by name and OID, even with \' in the
	// name and a role whose sessions read backslashes as escapes.
	oldStrings := "restow_d3_agent_old_" + s
	oldPass := "pw-" + s
	env.exec(t, "postgres", "CREATE ROLE "+QuoteIdent(oldStrings)+" LOGIN CREATEDB PASSWORD "+QuoteLiteral(oldPass))
	defer env.exec(t, "postgres", "DROP ROLE IF EXISTS "+QuoteIdent(oldStrings))
	env.exec(t, "postgres", "ALTER ROLE "+QuoteIdent(oldStrings)+" SET standard_conforming_strings = off")
	mismatch := restore
	mismatch.Connection.User, mismatch.Connection.Password = &oldStrings, &oldPass
	broken := `restow_d3_agent_b\'d_` + s
	defer env.exec(t, "postgres", "DROP DATABASE IF EXISTS "+QuoteIdent(broken)+" WITH (FORCE)")
	mismatch.Restore = &api.DBRunRestore{FileName: dump.FileName, SHA256: dump.SHA256[:63] + "0", TargetName: broken}
	if r := Restore(context.Background(), &mismatch, deps); r.Error == nil || r.Error.Code != "db_backup_mismatch" || r.TargetOID == nil {
		t.Fatalf("mismatch: %+v", r.Error)
	}
	if rows := env.exec(t, "postgres", "SELECT 1 FROM pg_database WHERE datname = "+QuoteLiteral(broken)); len(rows) != 0 {
		t.Fatal("the run's own database was not dropped")
	}
	other := "0F"
	for i := 0; i < 31; i++ {
		other += ":0F"
	}
	pinned := *spec
	pinned.Connection.PinnedFingerprintSHA256 = &other
	if r := Backup(context.Background(), &pinned, deps); r.Error == nil || r.Error.Code != "db_tls_changed" {
		t.Fatalf("pinned: %+v", r.Error)
	}
	_ = filepath.Join
}

// claim: DB-006
func TestAgentKeepsNoSnapshotOfAFailedDump(t *testing.T) {
	env := pgTarget(t)
	repo := t.TempDir()
	self, _ := os.Executable()
	runner := restic.Runner{Bin: "restic", CacheDir: t.TempDir(), TmpDir: t.TempDir()}
	init := runner
	init.Repo, init.Password = repo, "repo-pass"
	if res, err := init.Command(context.Background(), restic.CommandOptions{Name: "init", Args: []string{"init"}}); err != nil || res.Err() != nil {
		t.Fatalf("restic init: %v", err)
	}
	// Programs that write part of an archive and fail.
	dir := t.TempDir()
	for _, tool := range []string{"pg_dump", "pg_dumpall", "pg_restore"} {
		script := "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'pg_dump (PostgreSQL) 99.0'; exit 0; fi\nprintf 'PGDMP partial'\nexit 1\n"
		if err := os.WriteFile(filepath.Join(dir, tool), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	source := "restow_d3_agent_fail_" + suffix()
	env.exec(t, "postgres", "CREATE DATABASE "+QuoteIdent(source))
	defer env.exec(t, "postgres", "DROP DATABASE IF EXISTS "+QuoteIdent(source)+" WITH (FORCE)")
	host, port, user, pass, fp := env.host, env.port, env.user, env.password, env.fingerprint
	spec := &api.DBRunSpec{RunID: "r2", Kind: "backup", MaxDurationSeconds: 600, Repository: &api.DBRunRepository{URL: repo, RepositoryPassword: "repo-pass"}}
	spec.Connection = api.DBRunConnection{ConnectionID: "c2", Engine: "postgresql", Host: &host, Port: &port, AuthMethod: "password", User: &user, Password: &pass, PinnedFingerprintSHA256: &fp}
	spec.Connection.Selection.Mode = "selected"
	spec.Connection.Selection.Names = []string{source}
	// The fake programs lie below the temporary folder: let them run here.
	report := Backup(context.Background(), spec, Deps{Restic: runner, Self: self, ToolDirs: []string{dir}, Trusted: func(path string) (string, error) { return path, nil }})
	if report.Status != "failed" || report.Error == nil || report.Error.Code != "db_dump_failed" {
		t.Fatalf("status %q", report.Status)
	}
	if len(report.Backups) != 0 {
		t.Fatalf("a failed dump became a backup: %+v", report.Backups)
	}
	list := runner
	list.Repo, list.Password = repo, "repo-pass"
	var snapshots []json.RawMessage
	res, err := list.Command(context.Background(), restic.CommandOptions{Name: "snapshots", Args: []string{"snapshots", "--json"}, OnStdoutLine: func(line []byte) {
		_ = json.Unmarshal(line, &snapshots)
	}})
	if err != nil || res.Err() != nil || len(snapshots) != 0 {
		t.Fatalf("snapshots %d (%v)", len(snapshots), err)
	}
}
