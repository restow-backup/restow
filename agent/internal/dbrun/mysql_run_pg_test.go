//go:build !windows

package dbrun

import (
	"context"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// The agent's MySQL and MariaDB runs against real servers with TLS
// (docs/DATABASES.md 16 "D4"): a schema with a view, a procedure, a trigger
// and an event owned by another user is dumped through the relay into restic
// and restored under a new name by a user who may not set definers (the
// DEFINER filter); the events are off afterwards; a name taken, a broken
// backup (only the run's own schema is dropped) and another certificate are
// refused. Runs for each of RESTOW_TEST_MYSQL_URL, RESTOW_TEST_MYSQL80_URL,
// RESTOW_TEST_MARIADB_URL, RESTOW_TEST_MARIADB106_URL that is set (a user with
// all rights, TLS on) when restic and the family's programs are installed.

type myEnv struct {
	engine, host, user, password string
	port                         int
	fingerprint                  string
}

func myTarget(t *testing.T, variable, engine string) myEnv {
	raw := os.Getenv(variable)
	if raw == "" {
		t.Skip(variable + " is not set")
	}
	if _, err := exec.LookPath("restic"); err != nil {
		t.Skip("restic is not installed")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	port := 3306
	if p := u.Port(); p != "" {
		port, _ = strconv.Atoi(p)
	}
	pw, _ := u.User.Password()
	env := myEnv{engine: engine, host: u.Hostname(), user: u.User.Username(), password: pw, port: port}
	ms := env.admin(t)
	ms.Close()
	return env
}

func (e *myEnv) admin(t *testing.T) *dbprobe.MysqlSession {
	t.Helper()
	p, err := dbprobe.OpenPinnedMysql(context.Background(), dbprobe.PinnedTarget{Host: e.host, Port: e.port, Fingerprint: e.fingerprint}, e.engine, 10*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	ms, err := p.SignIn(e.user, &e.password)
	if err != nil {
		p.Close()
		t.Fatal(err)
	}
	if e.fingerprint == "" {
		e.fingerprint = p.Fingerprint
	}
	return ms
}

func (e *myEnv) exec(t *testing.T, statements ...string) [][]*string {
	t.Helper()
	ms := e.admin(t)
	defer ms.Close()
	var rows [][]*string
	for _, sql := range statements {
		var err error
		if rows, err = ms.Query(sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	return rows
}

// claim: DB-007
func TestAgentMysqlRuns(t *testing.T) {
	for _, c := range []struct{ variable, engine string }{
		{"RESTOW_TEST_MYSQL_URL", "mysql"},
		{"RESTOW_TEST_MYSQL80_URL", "mysql"},
		{"RESTOW_TEST_MARIADB_URL", "mariadb"},
		{"RESTOW_TEST_MARIADB106_URL", "mariadb"},
	} {
		t.Run(c.variable, func(t *testing.T) { agentMysqlRoundTrip(t, c.variable, c.engine) })
	}
}

func agentMysqlRoundTrip(t *testing.T, variable, engine string) {
	env := myTarget(t, variable, engine)
	if env.fingerprint == "" {
		t.Fatal("the test server has no TLS")
	}
	s := suffix()
	source, owner, restorer := "restow_d4_ag_src_"+s, "restow_d4_ag_own_"+s, "restow_d4_ag_rst_"+s
	restorerPass := "pw-" + suffix() + suffix()
	q := MysqlQuoteIdent
	env.exec(t,
		"CREATE DATABASE "+q(source)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE USER "+q(owner)+"@'%' IDENTIFIED BY 'x-"+s+"'",
		"GRANT ALL ON "+q(source)+".* TO "+q(owner)+"@'%'",
		"CREATE USER "+q(restorer)+"@'%' IDENTIFIED BY '"+restorerPass+"'",
		"GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, TRIGGER, EVENT ON `restow\\_d4\\_ag\\_%`.* TO "+q(restorer)+"@'%'",
	)
	defer env.exec(t, "DROP DATABASE IF EXISTS "+q(source), "DROP USER IF EXISTS "+q(owner)+"@'%'", "DROP USER IF EXISTS "+q(restorer)+"@'%'")
	definer := q(owner) + "@'%'"
	env.exec(t,
		"USE "+q(source),
		"CREATE TABLE orders (id INT PRIMARY KEY, item VARCHAR(40), raw VARBINARY(8)) ENGINE=InnoDB",
		"CREATE TABLE audit (n INT) ENGINE=MyISAM",
		"INSERT INTO orders VALUES (1, 'tea', 0x00ff), (2, 'CREATE DEFINER=`x`@`y` PROCEDURE p()', NULL)",
		"CREATE DEFINER="+definer+" SQL SECURITY DEFINER VIEW cheap AS SELECT id, item FROM orders WHERE id < 10",
		"CREATE DEFINER="+definer+" PROCEDURE add_order(IN n INT) BEGIN INSERT INTO orders (id, item) VALUES (n, 'x'); INSERT INTO audit VALUES (n); END",
		"CREATE DEFINER="+definer+" TRIGGER orders_ai AFTER INSERT ON orders FOR EACH ROW INSERT INTO audit VALUES (NEW.id)",
		"CREATE DEFINER="+definer+" EVENT tidy ON SCHEDULE EVERY 1 DAY ENABLE DO DELETE FROM audit",
	)

	repo := t.TempDir()
	self, _ := os.Executable()
	runner := restic.Runner{Bin: "restic", CacheDir: t.TempDir(), TmpDir: t.TempDir()}
	init := runner
	init.Repo, init.Password = repo, "repo-pass"
	if res, err := init.Command(context.Background(), restic.CommandOptions{Name: "init", Args: []string{"init"}}); err != nil || res.Err() != nil {
		t.Fatalf("restic init: %v %v", err, res.Err())
	}
	host, port, user, pass, fp := env.host, env.port, env.user, env.password, env.fingerprint
	spec := &api.DBRunSpec{RunID: "0b6a5c9e-1111-4222-8333-944455556666", Kind: "backup", MaxDurationSeconds: 600, Repository: &api.DBRunRepository{URL: repo, RepositoryPassword: "repo-pass"}}
	spec.Connection = api.DBRunConnection{ConnectionID: "c1", Engine: engine, Host: &host, Port: &port, AuthMethod: "password", User: &user, Password: &pass, PinnedFingerprintSHA256: &fp}
	spec.Connection.Selection.Mode = "selected"
	spec.Connection.Selection.Names = []string{source}
	deps := Deps{Restic: runner, Self: self}
	report := Backup(context.Background(), spec, deps)
	if report.Status != "succeeded" || report.Error != nil || len(report.Backups) != 2 || report.Instance == nil {
		t.Fatalf("backup: %+v %+v", report, report.Error)
	}
	if engine == "mysql" && report.Instance.ServerUUID == "" || engine == "mariadb" && report.Instance.ServerID == "" {
		t.Fatalf("instance %+v", report.Instance)
	}
	dump, users := report.Backups[0], report.Backups[1]
	if dump.Name != source || dump.FileName != engine+"/"+source+".sql" || dump.OID != nil || len(dump.SHA256) != 64 {
		t.Fatalf("dump %+v", dump)
	}
	for kind, n := range map[string]int{"TABLE": 2, "VIEW": 1, "PROCEDURE": 1, "TRIGGER": 1, "EVENT": 1} {
		if dump.Objects[kind] != n {
			t.Fatalf("objects %v", dump.Objects)
		}
	}
	if dump.EngineOptions == nil || dump.EngineOptions.CharacterSet != "utf8mb4" || dump.EngineOptions.Collation != "utf8mb4_unicode_ci" {
		t.Fatalf("engine options %+v", dump.EngineOptions)
	}
	if users.Kind != "globals" || users.FileName != engine+"/users.sql" {
		t.Fatalf("users %+v", users)
	}
	nontx := false
	for _, n := range report.Notes {
		if n["code"] == "db_nontransactional_tables" && n["database"] == source {
			nontx = true
		}
	}
	if !nontx {
		t.Fatalf("no notice of the MyISAM table: %v", report.Notes)
	}
	dumper := runner
	dumper.Repo, dumper.Password = repo, "repo-pass"
	readOf := func(b api.DBRunBackup) func(ctx context.Context, w io.Writer) error {
		return func(ctx context.Context, w io.Writer) error {
			return dumper.Dump(ctx, b.SnapshotID, "/"+b.FileName, w, 0, restic.DumpOptions{})
		}
	}
	var usersText strings.Builder
	if err := readOf(users)(context.Background(), &usersText); err != nil || !strings.Contains(usersText.String(), owner) {
		t.Fatalf("users dump lacks the owner (%v)", err)
	}
	if strings.Contains(usersText.String(), restorerPass) {
		t.Fatal("a readable password in the users dump")
	}
	if !utf8.ValidString(usersText.String()) || engine == "mysql" && !strings.Contains(usersText.String(), " AS 0x") {
		t.Fatal("the users dump holds a hash that is not text")
	}
	deps.ReadDump = readOf(dump)

	// Restore under a new name as a user who may not set definers.
	target := "restow_d4_ag_dst_" + s
	defer env.exec(t, "DROP DATABASE IF EXISTS "+q(target))
	restore := *spec
	restore.Kind, restore.Repository = "restore", nil
	restore.Connection.User, restore.Connection.Password = &restorer, &restorerPass
	restore.Restore = &api.DBRunRestore{FileName: dump.FileName, SHA256: dump.SHA256, TargetName: target, EngineOptions: *dump.EngineOptions}
	// With the binary log on, a user without SUPER may create triggers and
	// routines only while log_bin_trust_function_creators is on: refused as a
	// missing right first, and only the run's own schema is dropped.
	flags := env.exec(t, "SELECT @@log_bin, @@log_bin_trust_function_creators")
	if *flags[0][0] == "1" && *flags[0][1] == "0" {
		if r := Restore(context.Background(), &restore, deps); r.Error == nil || r.Error.Code != "db_permission_missing" {
			t.Fatalf("binary log: %+v", r.Error)
		}
		if rows := env.exec(t, "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '"+target+"'"); len(rows) != 0 {
			t.Fatal("the refused run's schema was not dropped")
		}
		env.exec(t, "SET GLOBAL log_bin_trust_function_creators = 1")
		defer env.exec(t, "SET GLOBAL log_bin_trust_function_creators = 0")
	}
	done := Restore(context.Background(), &restore, deps)
	if done.Status != "succeeded" || done.Error != nil {
		t.Fatalf("restore: %+v %+v", done, done.Error)
	}
	if n := done.Notes[len(done.Notes)-1]; n["definersRemoved"] != 4 || n["eventsDisabled"] != 1 {
		t.Fatalf("notes %v", done.Notes)
	}
	rows := env.exec(t, "SELECT item, HEX(raw) FROM "+q(target)+".orders ORDER BY id")
	if len(rows) != 2 || *rows[0][0] != "tea" || *rows[0][1] != "00FF" || *rows[1][0] != "CREATE DEFINER=`x`@`y` PROCEDURE p()" {
		t.Fatalf("restored rows %v", rows)
	}
	if rows := env.exec(t, "SELECT STATUS, DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA = '"+target+"'"); len(rows) != 1 || *rows[0][0] != "DISABLED" || !strings.HasPrefix(*rows[0][1], restorer+"@") {
		t.Fatalf("events %v", rows)
	}
	if rows := env.exec(t, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '"+target+"' AND TABLE_NAME LIKE '\\_\\_restow\\_run\\_%'"); *rows[0][0] != "0" {
		t.Fatal("the marker table is left")
	}
	if rows := env.exec(t, "SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '"+target+"'"); *rows[0][0] != "utf8mb4_unicode_ci" {
		t.Fatalf("collation %v", *rows[0][0])
	}

	taken := restore
	taken.Restore = &api.DBRunRestore{FileName: dump.FileName, SHA256: dump.SHA256, TargetName: target}
	if r := Restore(context.Background(), &taken, deps); r.Error == nil || r.Error.Code != "db_restore_name_taken" {
		t.Fatalf("name taken: %+v", r.Error)
	}
	// A broken backup: only the run's own schema (with its marker) is dropped.
	broken := "restow_d4_ag_b`k_" + s
	defer env.exec(t, "DROP DATABASE IF EXISTS "+q(broken))
	mismatch := restore
	mismatch.Restore = &api.DBRunRestore{FileName: dump.FileName, SHA256: dump.SHA256[:63] + "0", TargetName: broken}
	if r := Restore(context.Background(), &mismatch, deps); r.Error == nil || r.Error.Code != "db_backup_mismatch" {
		t.Fatalf("mismatch: %+v", r.Error)
	}
	if rows := env.exec(t, "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'restow_d4_ag_b`k_"+s+"'"); len(rows) != 0 {
		t.Fatal("the run's own schema was not dropped")
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
}
