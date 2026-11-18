package dbrun

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// A backup or restore run of PostgreSQL on the agent (5.1, 5.2, 7.1, O1-O3).
// Every connection to the server is pinned (dbprobe.OpenPinned); the
// programs reach it only through a relay; the password goes to them in a
// PGPASSFILE (0600, in memory) and nowhere else. The server judges the
// report (another instance, Restow's own database).

// Deps are what a run needs from the agent.
type Deps struct {
	// Restic is the agent's restic runner (Bin, CacheDir, TmpDir); the run
	// sets the repository and its credentials on a copy.
	Restic restic.Runner
	// Self is the agent's own binary (db-stream).
	Self string
	// ToolDirs are where the PostgreSQL programs may lie (default ToolDirs()).
	ToolDirs []string
	// Dial opens network connections (tests).
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
	Now  func() time.Time
}

const connectTimeout = 30 * time.Second

type runFailure struct {
	code string
	msg  string
}

func (f *runFailure) Error() string { return f.msg }

func failf(code, format string, args ...any) *runFailure {
	return &runFailure{code: code, msg: fmt.Sprintf(format, args...)}
}

func codeOf(err error, fallback string) (string, string) {
	var rf *runFailure
	var pe *dbprobe.PinnedError
	var te *ToolError
	switch {
	case errors.As(err, &rf):
		return rf.code, rf.msg
	case errors.As(err, &pe):
		return pe.Code, pe.Message
	case errors.As(err, &te):
		return te.Code, te.Message
	}
	return fallback, err.Error()
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

type session struct {
	spec   *api.DBRunSpec
	target dbprobe.PinnedTarget
	user   string
	pass   *string
}

func newSession(spec *api.DBRunSpec) (*session, error) {
	c := spec.Connection
	if c.Engine != "postgresql" {
		return nil, failf("db_engine_unsupported", "D3 backs up PostgreSQL only")
	}
	if c.Host == nil || c.Port == nil {
		return nil, failf("db_engine_unsupported", "the connection has no address")
	}
	if c.User == nil || *c.User == "" {
		return nil, failf("db_login_failed", "the connection keeps no user")
	}
	fp := ""
	if c.PinnedFingerprintSHA256 != nil {
		fp = *c.PinnedFingerprintSHA256
	}
	return &session{spec: spec, target: dbprobe.PinnedTarget{Host: *c.Host, Port: *c.Port, AllowUnencrypted: c.AllowUnencrypted, Fingerprint: fp}, user: *c.User, pass: c.Password}, nil
}

func (s *session) admin(ctx context.Context, d Deps, database string) (*dbprobe.PinnedConn, error) {
	p, err := dbprobe.OpenPinned(ctx, s.target, connectTimeout, d.Dial)
	if err != nil {
		return nil, err
	}
	if err := p.SignIn(s.user, s.pass, database); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

func (s *session) relay(ctx context.Context, d Deps, max time.Duration) (*Relay, error) {
	p, err := dbprobe.OpenPinned(ctx, s.target, connectTimeout, d.Dial)
	if err != nil {
		return nil, err
	}
	raw, err := p.Detach()
	if err != nil {
		p.Close()
		return nil, err
	}
	return OpenRelay(ctx, raw, RelayOptions{MaxDuration: max})
}

func (s *session) loginDatabase() string {
	if db := s.spec.Connection.LoginDatabase; db != nil && *db != "" {
		return *db
	}
	return "postgres"
}

type facts struct {
	major         int
	version       string
	systemID      string
	rolePasswords bool
	canCreate     bool
	databases     []struct{ name, oid string }
}

func readFacts(p *dbprobe.PinnedConn) (*facts, error) {
	head, err := p.Query("SELECT current_setting('server_version_num'), current_setting('server_version'), (SELECT system_identifier::text FROM pg_control_system()), has_table_privilege('pg_authid', 'SELECT'), (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user)")
	if err != nil {
		return nil, err
	}
	num, _ := strconv.Atoi(dbprobe.Cell(head, 0, 0))
	f := &facts{major: num / 10000, version: dbprobe.Cell(head, 0, 1), systemID: dbprobe.Cell(head, 0, 2), rolePasswords: dbprobe.Cell(head, 0, 3) == "t", canCreate: dbprobe.Cell(head, 0, 4) == "t"}
	list, err := p.Query("SELECT datname, oid::text FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname")
	if err != nil {
		return nil, err
	}
	for i := range list {
		f.databases = append(f.databases, struct{ name, oid string }{dbprobe.Cell(list, i, 0), dbprobe.Cell(list, i, 1)})
	}
	return f, nil
}

func (d Deps) runner(spec *api.DBRunSpec, tmp string) *restic.Runner {
	r := d.Restic
	r.Repo = spec.Repository.URL
	r.Password = spec.Repository.RepositoryPassword
	r.RESTUser = spec.Repository.Username
	r.RESTPass = spec.Repository.Password
	if r.CacheDir != "" {
		r.CacheDir = filepath.Join(r.CacheDir, "db-"+spec.Connection.ConnectionID)
		_ = os.MkdirAll(r.CacheDir, 0o700)
	}
	r.TmpDir = tmp
	return &r
}

func instanceOf(f *facts) *api.DBRunInstance {
	inst := &api.DBRunInstance{SystemIdentifier: f.systemID, ServerVersion: f.version}
	for _, db := range f.databases {
		inst.Databases = append(inst.Databases, struct {
			Name string `json:"name"`
			OID  string `json:"oid"`
		}{db.name, db.oid})
	}
	return inst
}

func selected(c api.DBRunConnection, name string) bool {
	if c.Selection.Mode == "selected" {
		for _, n := range c.Selection.Names {
			if n == name {
				return true
			}
		}
		return false
	}
	for _, n := range c.Selection.Exclude {
		if n == name {
			return false
		}
	}
	return true
}

func fileNameOf(name string) string {
	return "postgresql/" + strings.NewReplacer("/", "_", `\`, "_").Replace(name) + ".pgdump"
}

func randomName() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Backup runs a backup run and returns its report.
func Backup(ctx context.Context, spec *api.DBRunSpec, d Deps) api.DBRunFinish {
	out := api.DBRunFinish{Status: "failed", Backups: []api.DBRunBackup{}, Notes: []map[string]any{}}
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
	admin, err := s.admin(ctx, d, s.loginDatabase())
	if err != nil {
		return fail(err, "db_unreachable")
	}
	f, err := readFacts(admin)
	admin.Close()
	if err != nil {
		return fail(err, "db_probe_failed")
	}
	out.Instance = instanceOf(f)
	if key := spec.Connection.InstanceKey; key != nil && *key != "" && *key != "postgresql:"+f.systemID {
		return fail(failf("db_instance_changed", "another instance answers under the address"), "")
	}
	dirs := d.ToolDirs
	if dirs == nil {
		dirs = ToolDirs()
	}
	tools, err := ChooseTools(ctx, f.major, dirs)
	if err != nil {
		return fail(err, "db_tool_missing")
	}
	tmp, err := PrivateDir("", "restow-db-run-")
	if err != nil {
		return fail(err, "db_dump_failed")
	}
	defer os.RemoveAll(tmp)
	passFile, err := WritePassFile(tmp, deref(s.pass))
	if err != nil {
		return fail(err, "db_dump_failed")
	}
	max := time.Duration(spec.MaxDurationSeconds) * time.Second
	if max <= 0 || max > 24*time.Hour {
		max = 12 * time.Hour
	}
	r := d.runner(spec, tmp)
	toolVersion := strconv.Itoa(tools.Major)
	tags := []string{"restow-db", "restow-db-engine=postgresql", "restow-db-connection=" + spec.Connection.ConnectionID}
	failed, done, wanted := 0, 0, 0
	for _, db := range f.databases {
		if !selected(spec.Connection, db.name) {
			continue
		}
		if db.name == "postgres" && postgresEmpty(ctx, s, d) {
			out.Notes = append(out.Notes, map[string]any{"database": db.name, "result": "skipped", "code": "db_database_empty"})
			continue
		}
		wanted++
		oid := db.oid
		file := fileNameOf(db.name)
		b, err := dumpOne(ctx, s, d, r, tmp, passFile, max, tools.Path("pg_dump"), DumpArgs(db.name), tools.Path("pg_restore"), file, tags)
		if err != nil {
			failed++
			code, msg := codeOf(err, "db_dump_failed")
			out.Notes = append(out.Notes, map[string]any{"database": db.name, "result": "failed", "code": code, "message": clip(secrets(msg), 500)})
			continue
		}
		b.Kind, b.Name, b.OID, b.ToolVersion = "database", db.name, &oid, &toolVersion
		out.Backups = append(out.Backups, *b)
		out.Notes = append(out.Notes, map[string]any{"database": db.name, "result": "backed_up", "snapshotId": b.SnapshotID})
		done++
	}
	g, err := dumpOne(ctx, s, d, r, tmp, passFile, max, tools.Path("pg_dumpall"), GlobalsArgs(f.rolePasswords), "", "postgresql/globals.sql", append(tags, "restow-db-globals"))
	if err != nil {
		// The instance's roles count like a database: without them the run is not whole.
		failed++
		wanted++
		code, msg := codeOf(err, "db_dump_failed")
		out.Notes = append(out.Notes, map[string]any{"globals": true, "result": "failed", "code": code, "message": clip(secrets(msg), 500)})
	} else {
		done++
		wanted++
		g.Kind, g.Name, g.ToolVersion = "globals", "", &toolVersion
		out.Backups = append(out.Backups, *g)
		out.Notes = append(out.Notes, map[string]any{"globals": true, "result": "backed_up", "rolePasswords": f.rolePasswords})
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

func postgresEmpty(ctx context.Context, s *session, d Deps) bool {
	p, err := s.admin(ctx, d, "postgres")
	if err != nil {
		return false
	}
	defer p.Close()
	rows, err := p.Query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'")
	return err == nil && dbprobe.Cell(rows, 0, 0) == "0"
}

func dumpOne(ctx context.Context, s *session, d Deps, r *restic.Runner, tmp, passFile string, max time.Duration, tool string, args []string, listTool, file string, tags []string) (*api.DBRunBackup, error) {
	started := d.now().UTC()
	rl, err := s.relay(ctx, d, max)
	if err != nil {
		return nil, err
	}
	defer rl.Close()
	statsPath := filepath.Join(tmp, "stats-"+randomName()+".json")
	specPath := filepath.Join(tmp, "spec-"+randomName()+".json")
	defer os.Remove(statsPath)
	defer os.Remove(specPath)
	spec := StreamSpec{Tool: tool, Args: args, Env: ToolEnv(rl.Dir, rl.Port, s.user, passFile), ListTool: listTool, StatsPath: statsPath}
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

// QuoteIdent is an SQL identifier in double quotes.
func QuoteIdent(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

// QuoteLiteral is an SQL string literal.
func QuoteLiteral(v string) string { return "'" + strings.ReplaceAll(v, "'", "''") + "'" }

// ValidName: a new database's name has at most 63 bytes (O3).
func ValidName(name string) bool {
	return name != "" && len(name) <= 63 && !strings.ContainsRune(name, 0) && strings.TrimSpace(name) == name
}

// Restore plays a backup into a new database (O3) and returns its report.
func Restore(ctx context.Context, spec *api.DBRunSpec, d Deps) api.DBRunFinish {
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
	secrets := func(m string) string { return dbprobe.Sanitize(m, s.user, deref(s.pass)) }
	fail := func(err error, fallback string) api.DBRunFinish {
		code, msg := codeOf(err, fallback)
		out.Error = &api.DBProbeError{Code: code, Message: secrets(msg)}
		return out
	}
	name := spec.Restore.TargetName
	if !ValidName(name) {
		return fail(failf("db_restore_failed", "the new database's name is not valid"), "")
	}
	admin, err := s.admin(ctx, d, s.loginDatabase())
	if err != nil {
		return fail(err, "db_unreachable")
	}
	f, err := readFacts(admin)
	if err != nil {
		admin.Close()
		return fail(err, "db_probe_failed")
	}
	out.Instance = instanceOf(f)
	if key := spec.Connection.InstanceKey; key != nil && *key != "" && *key != "postgresql:"+f.systemID {
		admin.Close()
		return fail(failf("db_instance_changed", "another instance answers under the target's address"), "")
	}
	if !f.canCreate {
		admin.Close()
		return fail(failf("db_permission_missing", "the target's user may not create databases (CREATEDB)"), "")
	}
	for _, db := range f.databases {
		if db.name == name {
			admin.Close()
			return fail(failf("db_restore_name_taken", "a database of that name exists"), "")
		}
	}
	if _, err := admin.Query("CREATE DATABASE " + QuoteIdent(name) + " TEMPLATE template0"); err != nil {
		admin.Close()
		code := "db_restore_failed"
		if strings.Contains(err.Error(), "already exists") {
			code = "db_restore_name_taken"
		}
		return fail(failf(code, "%s", err.Error()), "")
	}
	rows, err := admin.Query("SELECT oid::text FROM pg_database WHERE datname = " + QuoteLiteral(name))
	admin.Close()
	oid := dbprobe.Cell(rows, 0, 0)
	if err != nil || oid == "" {
		return fail(failf("db_restore_failed", "the new database was not found"), "")
	}
	out.TargetOID = &oid
	if err := restoreInto(ctx, s, d, spec, f.major, name); err != nil {
		// Only the database this run created: its name and its OID.
		dropOwn(ctx, s, d, name, oid)
		return fail(err, "db_restore_failed")
	}
	out.Status = "succeeded"
	return out
}

func restoreInto(ctx context.Context, s *session, d Deps, spec *api.DBRunSpec, major int, name string) error {
	dirs := d.ToolDirs
	if dirs == nil {
		dirs = ToolDirs()
	}
	tools, err := ChooseTools(ctx, major, dirs)
	if err != nil {
		return err
	}
	tmp, err := PrivateDir("", "restow-db-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	passFile, err := WritePassFile(tmp, deref(s.pass))
	if err != nil {
		return err
	}
	max := time.Duration(spec.MaxDurationSeconds) * time.Second
	if max <= 0 || max > 24*time.Hour {
		max = 12 * time.Hour
	}
	rl, err := s.relay(ctx, d, max)
	if err != nil {
		return err
	}
	defer rl.Close()
	cmd := exec.CommandContext(ctx, tools.Path("pg_restore"), RestoreArgs(name)...) // #nosec G204 -- fixed argument lists
	cmd.Env = ToolEnv(rl.Dir, rl.Port, s.user, passFile)
	errs := &tail{}
	cmd.Stderr = errs
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	hash := sha256.New()
	r := d.runner(spec, tmp)
	dumpErr := r.Dump(ctx, spec.Restore.SnapshotID, "/"+spec.Restore.FileName, io.MultiWriter(hash, ignoreClosed{stdin}), 0, restic.DumpOptions{})
	_ = stdin.Close()
	waitErr := cmd.Wait()
	if dumpErr != nil {
		return failf("db_restore_failed", "the backup could not be read: %v", dumpErr)
	}
	if hex.EncodeToString(hash.Sum(nil)) != spec.Restore.SHA256 {
		return failf("db_backup_mismatch", "the backup's SHA-256 differs from the one recorded")
	}
	if waitErr != nil {
		msg := errs.String()
		if msg == "" {
			msg = waitErr.Error()
		}
		return failf("db_restore_failed", "%s", msg)
	}
	return nil
}

// ignoreClosed keeps the hash going when pg_restore stopped reading.
type ignoreClosed struct{ w io.Writer }

func (i ignoreClosed) Write(p []byte) (int, error) {
	_, _ = i.w.Write(p)
	return len(p), nil
}

func dropOwn(ctx context.Context, s *session, d Deps, name, oid string) {
	p, err := s.admin(ctx, d, s.loginDatabase())
	if err != nil {
		return
	}
	defer p.Close()
	rows, err := p.Query("SELECT oid::text FROM pg_database WHERE datname = " + QuoteLiteral(name))
	if err == nil && dbprobe.Cell(rows, 0, 0) == oid {
		_, _ = p.Query("DROP DATABASE " + QuoteIdent(name))
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
