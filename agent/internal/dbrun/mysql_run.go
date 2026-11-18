package dbrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// Backups and restores of MySQL and MariaDB on the agent (5.3, 7.1,
// 16 "D4"), like apps/worker databases/mysql-runs.ts: a snapshot per schema
// plus the instance's users and grants, the programs through the MySQL
// relay; a restore into a new schema with a marker table, the DEFINER filter
// and the events switched off.

func isMysqlEngine(engine string) bool { return engine == "mysql" || engine == "mariadb" }

var (
	mysqlSystemSchemas  = map[string]bool{"mysql": true, "sys": true, "performance_schema": true, "information_schema": true}
	mysqlSystemAccounts = map[string]bool{"mysql.sys": true, "mysql.session": true, "mysql.infoschema": true, "mariadb.sys": true}
	mysqlTransactional  = map[string]bool{"innodb": true, "xtradb": true, "ndbcluster": true, "ndb": true, "rocksdb": true, "tokudb": true}
	mysqlWord           = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
)

type mysqlSchema struct{ name, charset, collation string }

type mysqlFacts struct {
	version      string
	major, minor int
	instance     *api.DBRunInstance
	instanceKey  string
	lowerCase    bool
	schemas      []mysqlSchema
}

func cellOr(rows [][]*string, r, c int) string {
	if r < len(rows) && c < len(rows[r]) && rows[r][c] != nil {
		return *rows[r][c]
	}
	return ""
}

func (s *session) mysqlAdmin(ctx context.Context, d Deps) (*dbprobe.MysqlSession, error) {
	p, err := dbprobe.OpenPinnedMysql(ctx, s.target, s.spec.Connection.Engine, connectTimeout, d.Dial)
	if err != nil {
		return nil, err
	}
	ms, err := p.SignIn(s.user, s.pass)
	if err != nil {
		p.Close()
		return nil, err
	}
	if s.target.Address == "" {
		s.target.Address = p.RemoteAddress
	}
	return ms, nil
}

func (s *session) mysqlRelay(ctx context.Context, d Deps, max time.Duration) (*Relay, error) {
	p, err := dbprobe.OpenPinnedMysql(ctx, s.target, s.spec.Connection.Engine, connectTimeout, d.Dial)
	if err != nil {
		return nil, err
	}
	return OpenMysqlRelay(ctx, p, RelayOptions{MaxDuration: max})
}

func readMysqlFacts(ms *dbprobe.MysqlSession, engine string) (*mysqlFacts, error) {
	head, err := ms.Query("SELECT VERSION(), @@server_id, @@datadir, @@lower_case_table_names")
	if err != nil {
		return nil, err
	}
	f := &mysqlFacts{version: cellOr(head, 0, 0), lowerCase: cellOr(head, 0, 3) != "0"}
	f.major, f.minor = MysqlServerVersion(f.version)
	f.instance = &api.DBRunInstance{ServerVersion: f.version}
	if engine == "mysql" {
		uuid, err := ms.Query("SELECT @@server_uuid")
		if err != nil {
			return nil, err
		}
		f.instance.ServerUUID = cellOr(uuid, 0, 0)
		f.instanceKey = "mysql:" + strings.ToLower(f.instance.ServerUUID)
	} else {
		f.instance.ServerID, f.instance.Datadir = cellOr(head, 0, 1), cellOr(head, 0, 2)
		f.instanceKey = "mariadb:" + f.instance.ServerID + ":" + f.instance.Datadir
	}
	rows, err := ms.Query("SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
	if err != nil {
		return nil, err
	}
	for i := range rows {
		name := cellOr(rows, i, 0)
		if name == "" || mysqlSystemSchemas[strings.ToLower(name)] {
			continue
		}
		f.schemas = append(f.schemas, mysqlSchema{name, cellOr(rows, i, 1), cellOr(rows, i, 2)})
		f.instance.Databases = append(f.instance.Databases, struct {
			Name string  `json:"name"`
			OID  *string `json:"oid"`
		}{Name: name})
	}
	return f, nil
}

func nontransactionalOf(ms *dbprobe.MysqlSession) map[string][]string {
	rows, err := ms.Query("SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE'")
	out := map[string][]string{}
	if err != nil {
		return out
	}
	for i := range rows {
		schema, table, engine := cellOr(rows, i, 0), cellOr(rows, i, 1), cellOr(rows, i, 2)
		if schema == "" || table == "" || engine == "" || mysqlTransactional[strings.ToLower(engine)] {
			continue
		}
		out[schema] = append(out[schema], table)
	}
	return out
}

func mysqlUsersSQL(ms *dbprobe.MysqlSession) (string, bool) {
	accounts, err := ms.Query("SELECT User, Host FROM mysql.user ORDER BY User, Host")
	if err != nil {
		return "", false
	}
	var b strings.Builder
	b.WriteString("-- Users and grants of the instance, written by Restow (docs/DATABASES.md 16 \"D4\").\n-- Review before running: it creates accounts with their password hashes.\n\n")
	for i := range accounts {
		user, host := cellOr(accounts, i, 0), cellOr(accounts, i, 1)
		if accounts[i][0] == nil || accounts[i][1] == nil || mysqlSystemAccounts[user] {
			continue
		}
		account := MysqlQuoteIdent(user) + "@" + MysqlQuoteIdent(host)
		if create, err := ms.Query("SHOW CREATE USER " + account); err == nil && cellOr(create, 0, 0) != "" {
			b.WriteString(strings.Replace(cellOr(create, 0, 0), "CREATE USER ", "CREATE USER IF NOT EXISTS ", 1) + ";\n")
		}
		if grants, err := ms.Query("SHOW GRANTS FOR " + account); err == nil {
			for j := range grants {
				if g := cellOr(grants, j, 0); g != "" {
					b.WriteString(g + ";\n")
				}
			}
		}
		b.WriteString("\n")
	}
	return b.String(), true
}

func backupMysql(ctx context.Context, spec *api.DBRunSpec, d Deps) api.DBRunFinish {
	out := api.DBRunFinish{Status: "failed", Backups: []api.DBRunBackup{}, Notes: []map[string]any{}}
	engine := spec.Connection.Engine
	s, err := newSession(spec)
	if err != nil {
		code, msg := codeOf(err, "db_dump_failed")
		out.Error = &api.DBProbeError{Code: code, Message: msg}
		return out
	}
	secrets := func(m string) string { return dbprobe.Sanitize(m, s.user, deref(s.pass)) }
	fail := func(err error, fallback string) api.DBRunFinish {
		code, msg := codeOf(err, fallback)
		out.Error = &api.DBProbeError{Code: code, Message: secrets(msg)}
		return out
	}
	if spec.Repository == nil {
		return fail(failf("db_snapshot_failed", "the run has no repository"), "")
	}
	ms, err := s.mysqlAdmin(ctx, d)
	if err != nil {
		return fail(err, "db_unreachable")
	}
	f, err := readMysqlFacts(ms, engine)
	if err != nil {
		ms.Close()
		return fail(err, "db_probe_failed")
	}
	nontx := nontransactionalOf(ms)
	usersSQL, usersOK := "", false
	if engine == "mysql" {
		usersSQL, usersOK = mysqlUsersSQL(ms)
	}
	ms.Close()
	out.Instance = f.instance
	if key := spec.Connection.InstanceKey; key != nil && *key != "" && *key != f.instanceKey {
		return fail(failf("db_instance_changed", "another instance answers under the address"), "")
	}
	dirs := d.ToolDirs
	if dirs == nil {
		dirs = MysqlToolDirs()
	}
	tools, err := ChooseMysqlTools(ctx, engine, f.major, f.minor, dirs, d.Trusted)
	if err != nil {
		return fail(err, "db_tool_missing")
	}
	tmp, err := PrivateDir("", "restow-db-run-")
	if err != nil {
		return fail(err, "db_dump_failed")
	}
	defer os.RemoveAll(tmp)
	max := time.Duration(spec.MaxDurationSeconds) * time.Second
	if max <= 0 || max > 24*time.Hour {
		max = 12 * time.Hour
	}
	r := d.runner(spec, tmp)
	toolVersion := fmt.Sprintf("%d.%d", tools.Major, tools.Minor)
	tags := []string{"restow-db", "restow-db-engine=" + engine, "restow-db-connection=" + spec.Connection.ConnectionID, "restow-db-run=" + spec.RunID}
	failed, done, wanted := 0, 0, 0
	for _, schema := range f.schemas {
		if !selected(spec.Connection, schema.name) {
			continue
		}
		wanted++
		if tables := nontx[schema.name]; len(tables) > 0 {
			more := 0
			if len(tables) > 20 {
				more, tables = len(tables)-20, tables[:20]
			}
			out.Notes = append(out.Notes, map[string]any{"database": schema.name, "code": "db_nontransactional_tables", "tables": tables, "more": more})
		}
		file := DumpFileName(engine, "database", schema.name)
		b, err := s.mysqlDumpOne(ctx, d, r, tmp, max, tools.Dump, func(opt string) []string { return MysqlDumpArgs(opt, engine, schema.name) }, true, file, tags)
		if err != nil {
			failed++
			code, msg := codeOf(err, "db_dump_failed")
			out.Notes = append(out.Notes, map[string]any{"database": schema.name, "result": "failed", "code": code, "message": clip(secrets(msg), 500)})
			continue
		}
		b.Kind, b.Name, b.OID, b.ToolVersion = "database", schema.name, nil, &toolVersion
		opts := &api.DBEngineOptions{}
		if mysqlWord.MatchString(schema.charset) {
			opts.CharacterSet = schema.charset
		}
		if mysqlWord.MatchString(schema.collation) {
			opts.Collation = schema.collation
		}
		b.EngineOptions = opts
		out.Backups = append(out.Backups, *b)
		out.Notes = append(out.Notes, map[string]any{"database": schema.name, "result": "backed_up", "snapshotId": b.SnapshotID})
		done++
	}
	// The users and grants once per instance.
	file := DumpFileName(engine, "globals", "")
	gtags := append(append([]string{}, tags...), "restow-db-globals")
	var g *api.DBRunBackup
	switch {
	case engine == "mariadb":
		g, err = s.mysqlDumpOne(ctx, d, r, tmp, max, tools.Dump, MariadbUsersArgs, false, file, gtags)
	case usersOK:
		input := filepath.Join(tmp, "users.sql")
		if err = os.WriteFile(input, []byte(usersSQL), 0o600); err == nil {
			g, err = dumpStream(ctx, d, r, tmp, StreamSpec{InputFile: input}, file, gtags)
			_ = os.Remove(input)
		}
	default:
		out.Notes = append(out.Notes, map[string]any{"globals": true, "result": "skipped", "code": "db_permission_missing"})
	}
	if g != nil && err == nil {
		g.Kind, g.Name, g.ToolVersion = "globals", "", &toolVersion
		out.Backups = append(out.Backups, *g)
		out.Notes = append(out.Notes, map[string]any{"globals": true, "result": "backed_up"})
		done++
		wanted++
	} else if err != nil {
		failed++
		wanted++
		code, msg := codeOf(err, "db_dump_failed")
		out.Notes = append(out.Notes, map[string]any{"globals": true, "result": "failed", "code": code, "message": clip(secrets(msg), 500)})
	}
	switch {
	case failed == 0:
		out.Status = "succeeded"
	case done > 0:
		out.Status = "partial"
		out.Error = &api.DBProbeError{Code: "db_dump_failed", Message: fmt.Sprintf("%d of %d dumps failed", failed, wanted)}
	default:
		out.Error = &api.DBProbeError{Code: "db_dump_failed", Message: fmt.Sprintf("%d of %d dumps failed", failed, wanted)}
	}
	return out
}

// mysqlDumpOne runs one dump through a relay of its own with an option file
// for that relay's socket.
func (s *session) mysqlDumpOne(ctx context.Context, d Deps, r *restic.Runner, tmp string, max time.Duration, tool string, argsOf func(string) []string, count bool, file string, tags []string) (*api.DBRunBackup, error) {
	if err := recheck(d.Trusted, tool); err != nil {
		return nil, err
	}
	rl, err := s.mysqlRelay(ctx, d, max)
	if err != nil {
		return nil, err
	}
	defer rl.Close()
	opt, err := WriteMysqlOptionFile(tmp, s.user, deref(s.pass), rl.Path)
	if err != nil {
		return nil, err
	}
	defer os.Remove(opt)
	b, err := dumpStream(ctx, d, r, tmp, StreamSpec{Tool: tool, Args: argsOf(opt), Env: MysqlToolEnv(tmp), CountMysql: count}, file, tags)
	if err != nil {
		if ferr := rl.Failure(); ferr != nil {
			return nil, ferr
		}
	}
	return b, err
}

// dumpStream is one restic backup --stdin-from-command of db-stream.
func dumpStream(ctx context.Context, d Deps, r *restic.Runner, tmp string, spec StreamSpec, file string, tags []string) (*api.DBRunBackup, error) {
	started := d.now().UTC()
	statsPath := filepath.Join(tmp, "stats-"+randomName()+".json")
	specPath := filepath.Join(tmp, "spec-"+randomName()+".json")
	defer os.Remove(statsPath)
	defer os.Remove(specPath)
	spec.StatsPath = statsPath
	b, _ := json.Marshal(spec)
	if err := os.WriteFile(specPath, b, 0o600); err != nil {
		return nil, err
	}
	argv := []string{"backup", "--json", "--host", "restow-db", "--stdin-from-command", "--stdin-filename", file}
	for _, tag := range tags {
		argv = append(argv, "--tag", tag)
	}
	argv = append(argv, "--", d.Self, "db-stream", "--spec", specPath)
	snapshot := ""
	res, err := r.Command(ctx, restic.CommandOptions{Name: "backup", Args: argv, OnStdoutLine: func(line []byte) {
		if sum, ok := restic.ParseBackupSummary(line); ok {
			snapshot = sum.SnapshotID
		}
	}})
	var stats StreamStats
	raw, rerr := os.ReadFile(statsPath)
	if rerr != nil || json.Unmarshal(raw, &stats) != nil || !stats.OK {
		msg := stats.Stderr
		if msg == "" {
			msg = "the dump program failed"
		}
		return nil, failf("db_dump_failed", "%s", msg)
	}
	if err != nil || res.Err() != nil || snapshot == "" {
		return nil, failf("db_snapshot_failed", "restic kept no snapshot of the dump")
	}
	return &api.DBRunBackup{SnapshotID: snapshot, FileName: file, SHA256: stats.SHA256, Bytes: stats.Bytes, Objects: stats.Objects, StartedAt: started, FinishedAt: d.now().UTC()}, nil
}

func restoreMysql(ctx context.Context, spec *api.DBRunSpec, d Deps) api.DBRunFinish {
	out := api.DBRunFinish{Status: "failed", Backups: []api.DBRunBackup{}, Notes: []map[string]any{}}
	s, err := newSession(spec)
	if err != nil || spec.Restore == nil {
		if err == nil {
			err = failf("db_restore_failed", "the run has no backup to restore")
		}
		code, msg := codeOf(err, "db_restore_failed")
		out.Error = &api.DBProbeError{Code: code, Message: msg}
		return out
	}
	engine := spec.Connection.Engine
	secrets := func(m string) string { return dbprobe.Sanitize(m, s.user, deref(s.pass)) }
	fail := func(err error, fallback string) api.DBRunFinish {
		code, msg := codeOf(err, fallback)
		out.Error = &api.DBProbeError{Code: code, Message: secrets(msg)}
		return out
	}
	name := spec.Restore.TargetName
	if !ValidMysqlName(name) {
		return fail(failf("db_restore_failed", "the new schema's name is not valid"), "")
	}
	marker := "__restow_run_" + strings.ReplaceAll(spec.RunID, "-", "")
	if len(marker) > len("__restow_run_")+12 {
		marker = marker[:len("__restow_run_")+12]
	}
	ms, err := s.mysqlAdmin(ctx, d)
	if err != nil {
		return fail(err, "db_unreachable")
	}
	f, err := readMysqlFacts(ms, engine)
	if err != nil {
		ms.Close()
		return fail(err, "db_probe_failed")
	}
	out.Instance = f.instance
	if key := spec.Connection.InstanceKey; key != nil && *key != "" && *key != f.instanceKey {
		ms.Close()
		return fail(failf("db_instance_changed", "another instance answers under the target's address"), "")
	}
	all, err := ms.Query("SHOW DATABASES")
	if err != nil {
		ms.Close()
		return fail(err, "db_restore_failed")
	}
	for i := range all {
		existing := cellOr(all, i, 0)
		if existing == name || (f.lowerCase && strings.EqualFold(existing, name)) {
			ms.Close()
			return fail(failf("db_restore_name_taken", "a schema of that name exists"), "")
		}
	}
	create := "CREATE DATABASE " + MysqlQuoteIdent(name)
	if o := spec.Restore.EngineOptions; mysqlWord.MatchString(o.CharacterSet) {
		create += " CHARACTER SET " + o.CharacterSet
	}
	if o := spec.Restore.EngineOptions; mysqlWord.MatchString(o.Collation) {
		create += " COLLATE " + o.Collation
	}
	if _, err := ms.Query(create); err != nil {
		ms.Close()
		code := "db_restore_failed"
		msg := err.Error()
		switch {
		case strings.Contains(msg, "exists"):
			code = "db_restore_name_taken"
		case strings.Contains(msg, "denied"):
			code = "db_permission_missing"
		}
		return fail(failf(code, "%s", msg), "")
	}
	if _, err := ms.Query("CREATE TABLE " + MysqlQuoteIdent(name) + "." + MysqlQuoteIdent(marker) + " (run_id CHAR(36) NOT NULL)"); err != nil {
		dropOwnSchema(ms, name, marker)
		ms.Close()
		return fail(err, "db_restore_failed")
	}
	ms.Close()
	removed, err := restoreMysqlInto(ctx, s, d, spec, f, name)
	if err != nil {
		if cleanup, cerr := s.mysqlAdmin(ctx, d); cerr == nil {
			dropOwnSchema(cleanup, name, marker)
			cleanup.Close()
		}
		return fail(err, "db_restore_failed")
	}
	after, err := s.mysqlAdmin(ctx, d)
	if err != nil {
		return fail(err, "db_restore_failed")
	}
	defer after.Close()
	disabled := 0
	if events, err := after.Query("SHOW EVENTS FROM " + MysqlQuoteIdent(name)); err == nil {
		for i := range events {
			if ev := cellOr(events, i, 1); ev != "" {
				if _, err := after.Query("ALTER EVENT " + MysqlQuoteIdent(name) + "." + MysqlQuoteIdent(ev) + " DISABLE"); err == nil {
					disabled++
				}
			}
		}
	}
	_, _ = after.Query("DROP TABLE " + MysqlQuoteIdent(name) + "." + MysqlQuoteIdent(marker))
	out.Notes = append(out.Notes, map[string]any{"result": "restored", "definersRemoved": removed, "eventsDisabled": disabled})
	out.Status = "succeeded"
	return out
}

// dropOwnSchema drops name only while it holds the run's marker table.
func dropOwnSchema(ms *dbprobe.MysqlSession, name, marker string) {
	if _, err := ms.Query("SELECT 1 FROM " + MysqlQuoteIdent(name) + "." + MysqlQuoteIdent(marker) + " LIMIT 1"); err != nil {
		return
	}
	_, _ = ms.Query("DROP DATABASE " + MysqlQuoteIdent(name))
}

func restoreMysqlInto(ctx context.Context, s *session, d Deps, spec *api.DBRunSpec, f *mysqlFacts, name string) (int, error) {
	dirs := d.ToolDirs
	if dirs == nil {
		dirs = MysqlToolDirs()
	}
	tools, err := ChooseMysqlTools(ctx, spec.Connection.Engine, f.major, f.minor, dirs, d.Trusted)
	if err != nil {
		return 0, err
	}
	if d.ReadDump == nil {
		return 0, failf("db_restore_failed", "the agent cannot read the dump from the server")
	}
	tmp, err := PrivateDir("", "restow-db-restore-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(tmp)
	max := time.Duration(spec.MaxDurationSeconds) * time.Second
	if max <= 0 || max > 24*time.Hour {
		max = 12 * time.Hour
	}
	rl, err := s.mysqlRelay(ctx, d, max)
	if err != nil {
		return 0, err
	}
	defer rl.Close()
	opt, err := WriteMysqlOptionFile(tmp, s.user, deref(s.pass), rl.Path)
	if err != nil {
		return 0, err
	}
	if err := recheck(d.Trusted, tools.Client); err != nil {
		return 0, err
	}
	cmd := exec.CommandContext(ctx, tools.Client, MysqlRestoreArgs(opt, name)...) // #nosec G204 -- fixed argument lists
	cmd.Env = MysqlToolEnv(tmp)
	cmd.Dir = tmp
	errs := &tail{}
	cmd.Stderr = errs
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	hash := sha256.New()
	filter := &definerFilter{w: ignoreClosed{stdin}, s: NewMysqlDumpScanner(true)}
	dumpErr := d.ReadDump(ctx, io.MultiWriter(hash, filter))
	_ = filter.Close()
	_ = stdin.Close()
	waitErr := cmd.Wait()
	if dumpErr != nil {
		return 0, failf("db_restore_failed", "the backup could not be read: %v", dumpErr)
	}
	if hex.EncodeToString(hash.Sum(nil)) != spec.Restore.SHA256 {
		return 0, failf("db_backup_mismatch", "the backup's SHA-256 differs from the one recorded")
	}
	if waitErr != nil {
		if ferr := rl.Failure(); ferr != nil {
			return 0, ferr
		}
		msg := errs.String()
		if msg == "" {
			msg = waitErr.Error()
		}
		return 0, failf("db_restore_failed", "%s", msg)
	}
	return filter.s.DefinersRemoved, nil
}
