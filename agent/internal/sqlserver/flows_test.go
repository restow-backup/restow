package sqlserver_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
	"github.com/restow-backup/restow/agent/internal/sqlserver/sqlfake"
)

// updating reports -update (the flag is defined by the package's own tests).
func updating() bool { return flag.Lookup("update").Value.(flag.Getter).Get().(bool) }

// fixture is one machine with one SQL Server instance, as the recorded
// script outputs describe it.
type fixture struct {
	t      *testing.T
	root   string
	fs     *sqlfake.FS
	runner *sqlfake.Runner
	restic *sqlfake.Restic
	log    *sqlfake.Log
	env    *sqlserver.Env
	fact   api.SQLInstanceFact
}

func newFixture(t *testing.T, replies map[string]string) *fixture {
	t.Helper()
	rs, err := sqlfake.Load(filepath.Join("testdata", "runs"), replies)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	f := &fixture{t: t, root: root, fs: sqlfake.NewFS(), restic: sqlfake.NewRestic(), log: &sqlfake.Log{},
		fact: api.SQLInstanceFact{Name: "SQLEXPRESS", ID: "MSSQL16.SQLEXPRESS", ServiceName: "MSSQL$SQLEXPRESS"}}
	f.runner = &sqlfake.Runner{Replies: rs, OnRequest: func(req sqlserver.Request) {
		// SQL Server writes the backup file itself.
		if req.Op != sqlserver.OpBackup {
			return
		}
		var p sqlserver.BackupParams
		_ = json.Unmarshal(req.Params, &p)
		_ = os.MkdirAll(filepath.Dir(p.Path), 0o700)
		_ = os.WriteFile(p.Path, []byte("TAPE backup of "+p.Database), 0o600)
	}}
	var mu sync.Mutex
	clock := time.Date(2026, 11, 5, 2, 0, 11, 0, time.UTC)
	f.env = &sqlserver.Env{
		Runner: f.runner, FS: f.fs, Restic: f.restic, Log: f.log, Host: "sql01",
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			clock = clock.Add(time.Second)
			return clock
		},
		StagingRoot: filepath.Join(root, "staging", "sql"),
		RestoreRoot: filepath.Join(root, "staging", "sql-restore"),
		JournalPath: filepath.Join(root, "sql-verify-journal.json"),
	}
	return f
}

// golden compares v with testdata/golden/<name>.json (the temporary root
// replaced by <root>); -update rewrites it.
func (f *fixture) golden(name string, v any) {
	f.t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		f.t.Fatal(err)
	}
	s := strings.ReplaceAll(string(b), sqlserver.SnapshotPathOf(f.root), "<root>")
	s = replaceEscapedRoot(s, f.root)
	s = strings.ReplaceAll(s, f.root, "<root>")
	path := filepath.Join("testdata", "golden", name+".json")
	if updating() {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			f.t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(s+"\n"), 0o644); err != nil {
			f.t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		f.t.Fatalf("%v (run with -update to create it)", err)
	}
	if strings.TrimSpace(string(want)) != strings.TrimSpace(s) {
		f.t.Fatalf("%s differs from the golden file\n--- got\n%s\n--- want\n%s", name, s, want)
	}
}

// replaceEscapedRoot replaces a native path below root as JSON writes it
// on Windows (C:\\Users\\...\\staging) by <root> and the rest of the path
// with slashes, so the golden files are the same on every system.
func replaceEscapedRoot(s, root string) string {
	enc, err := json.Marshal(root)
	if err != nil {
		return s
	}
	esc := strings.Trim(string(enc), `"`)
	if esc == root {
		return s // no backslash in root: nothing is escaped
	}
	re := regexp.MustCompile(regexp.QuoteMeta(esc) + `(?:\\\\[^\\"\s;,]+)*`)
	return re.ReplaceAllStringFunc(s, func(m string) string {
		return "<root>" + strings.ReplaceAll(strings.TrimPrefix(m, esc), `\\`, "/")
	})
}

func allConfig() *api.SQLConfig {
	return &api.SQLConfig{Enabled: true, Mode: api.SQLModeAlongside,
		Instances: api.SQLInstanceSelection{All: true}, Databases: api.SQLDatabaseSelection{All: true}}
}

// backupView is what the golden files of a sql run hold.
type backupView struct {
	Status     string                    `json:"status"`
	SnapshotID string                    `json:"snapshotId,omitempty"`
	Errors     []api.RunError            `json:"errors"`
	Report     *api.SQLRunReport         `json:"sql"`
	Notices    []api.Notice              `json:"notices"`
	Ops        []string                  `json:"ops"`
	Inventory  *api.SQLInventoryInstance `json:"inventory,omitempty"`
}

func viewOf(f *fixture, o sqlserver.BackupOutcome) backupView {
	v := backupView{Status: o.Status, SnapshotID: o.SnapshotID, Errors: o.Errors, Report: o.Report, Notices: o.Notices, Ops: f.runner.Ops()}
	if o.Inventory != nil {
		w := sqlserver.WireInstance(*o.Inventory)
		v.Inventory = &w
	}
	return v
}

func TestBackupCasesGolden(t *testing.T) {
	ok := map[string]string{"inventory": "inventory-ok.jsonl", "backup:Sales": "backup-Sales.jsonl",
		"backup:master": "backup-master.jsonl", "backup:Scratch": "backup-Scratch.jsonl"}
	with := func(base map[string]string, kv ...string) map[string]string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	cases := []struct {
		name    string
		replies map[string]string
		cfg     func(*api.SQLConfig)
		setup   func(*fixture)
		status  string
		code    string
	}{
		{name: "ok", replies: ok, status: api.StatusSucceeded},
		{name: "exclude", replies: ok, cfg: func(c *api.SQLConfig) {
			c.Exclude = []api.SQLDatabaseRef{{Instance: "SQLEXPRESS", Name: "Scratch"}, {Name: "master"}}
		}, status: api.StatusSucceeded},
		{name: "selected-list", replies: ok, cfg: func(c *api.SQLConfig) {
			c.Databases = api.SQLDatabaseSelection{List: []api.SQLDatabaseRef{{Name: "Sales"}, {Instance: "OTHER", Name: "master"}}}
		}, status: api.StatusSucceeded},
		{name: "login-missing", replies: map[string]string{"inventory": "connect-login-missing.jsonl"}, status: api.StatusFailed, code: api.SQLLoginMissing},
		{name: "strict-encryption", replies: map[string]string{"inventory": "connect-unreachable.jsonl"},
			setup: func(f *fixture) { f.fact.StrictEncryption = true }, status: api.StatusFailed, code: api.SQLStrictEncryption},
		{name: "unreachable", replies: map[string]string{"inventory": "connect-unreachable.jsonl"}, status: api.StatusFailed, code: api.SQLInstanceUnreachable},
		{name: "constrained-language", replies: map[string]string{"inventory": "constrained.jsonl"}, status: api.StatusFailed, code: api.SQLPowerShellConstraint},
		{name: "permission-small", replies: with(ok, "inventory", "inventory-permission-small.jsonl"), status: api.StatusPartial, code: api.SQLPermissionMissing},
		{name: "staging-too-small", replies: with(ok, "inventory", "inventory-staging-small.jsonl"),
			setup: func(f *fixture) { f.fs.Default = 12 * uint64(sqlserver.GiB); f.fs.Root = `E:\` }, status: api.StatusPartial, code: api.SQLStagingTooSmall},
		{name: "compression-default", replies: with(ok, "inventory", "inventory-compression-default.jsonl"), status: api.StatusSucceeded},
		{name: "ag-secondary", replies: with(ok, "inventory", "inventory-ag-secondary.jsonl"), status: api.StatusSucceeded},
		{name: "failover-cluster", replies: with(ok, "inventory", "inventory-fci.jsonl"), status: api.StatusFailed, code: api.SQLFCIUnsupported},
		{name: "failover-cluster-registry", replies: ok, setup: func(f *fixture) { f.fact.Clustered = true }, status: api.StatusFailed, code: api.SQLFCIUnsupported},
		{name: "offline-database", replies: with(ok, "inventory", "inventory-offline.jsonl"), status: api.StatusPartial, code: api.SQLDatabaseUnavailable},
		{name: "crash-halfway", replies: with(ok, "backup:Sales", "backup-crash-halfway.jsonl"), status: api.StatusPartial, code: api.SQLScriptFailed},
		{name: "garbage-output", replies: with(ok, "backup:Sales", "backup-garbage.jsonl"), status: api.StatusPartial, code: api.SQLScriptFailed},
		{name: "backup-failed", replies: with(ok, "backup:Sales", "backup-failed-3201.jsonl"), status: api.StatusPartial, code: api.SQLBackupFailed},
		// Every BACKUP fails, one of them halfway on a full disk: no snapshot,
		// and the partial files do not stay on the staging volume.
		{name: "all-failed", replies: with(ok, "backup:Sales", "backup-disk-full.jsonl", "backup:master", "backup-failed-3201.jsonl",
			"backup:Scratch", "backup-failed-3201.jsonl"), status: api.StatusFailed, code: api.SQLBackupFailed},
		{name: "old-version-tde", replies: with(ok, "inventory", "inventory-old-tde.jsonl"), status: api.StatusSucceeded},
		{name: "mode-unsupported", replies: ok, cfg: func(c *api.SQLConfig) { c.Mode = "own_log_chain" }, status: api.StatusFailed, code: api.SQLModeUnsupported},
		{name: "snapshot-failed", replies: ok, setup: func(f *fixture) { f.restic.BackupErr = errors.New("unable to open repository") },
			status: api.StatusFailed, code: api.SQLSnapshotFailed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, c.replies)
			cfg := allConfig()
			if c.cfg != nil {
				c.cfg(cfg)
			}
			if c.setup != nil {
				c.setup(f)
			}
			out := f.env.BackupInstance(context.Background(), cfg, f.fact)
			if out.Status != c.status {
				t.Fatalf("status %s, want %s; errors %+v\n%s", out.Status, c.status, out.Errors, f.log.Text())
			}
			if c.code != "" && !hasCode(out.Errors, c.code) {
				t.Fatalf("no error %s in %+v", c.code, out.Errors)
			}
			// Whatever happened, nothing stays in the staging folder.
			assertStagingEmpty(t, f)
			f.golden("backup-"+c.name, viewOf(f, out))
		})
	}
}

// assertStagingEmpty fails when a run left backup files in the staging
// folder of the instance.
func assertStagingEmpty(t *testing.T, f *fixture) {
	t.Helper()
	inst := sqlserver.InstanceFolder(f.env.StagingRoot, "SQLEXPRESS")
	var left []string
	_ = filepath.Walk(inst, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			left = append(left, p)
		}
		return nil
	})
	if _, err := os.Stat(inst); err == nil || len(left) > 0 {
		t.Fatalf("the staging folder %s was not cleared: %v", inst, left)
	}
}

func hasCode(errs []api.RunError, code string) bool {
	for _, e := range errs {
		if e.Code == code {
			return true
		}
	}
	return false
}

// The snapshot holds the instance folder only, with the SQL tags, without
// a file system snapshot; the staging files are deleted after it and only
// after it.
func TestBackupSnapshotAndStaging(t *testing.T) {
	f := newFixture(t, map[string]string{"inventory": "inventory-ok.jsonl", "backup:Sales": "backup-Sales.jsonl",
		"backup:master": "backup-master.jsonl", "backup:Scratch": "backup-Scratch.jsonl"})
	inst := sqlserver.InstanceFolder(f.env.StagingRoot, "SQLEXPRESS")
	// A leftover of an earlier run is cleared first.
	if err := os.MkdirAll(inst, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inst, "old.bak"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stagedAtSnapshot []string
	f.restic.BackupErr = nil
	out := f.env.BackupInstance(context.Background(), allConfig(), f.fact)
	if out.Status != api.StatusSucceeded {
		t.Fatalf("%+v\n%s", out, f.log.Text())
	}
	if len(f.restic.Backups) != 1 {
		t.Fatalf("backups %d", len(f.restic.Backups))
	}
	o := f.restic.Backups[0]
	if !reflect.DeepEqual(o.Paths, []string{inst}) || !reflect.DeepEqual(o.Tags, []string{"restow-sql", "restow-sql-instance=SQLEXPRESS"}) ||
		!o.CaseInsensitive || o.UseFSSnapshot || o.Host != "sql01" || len(o.Excludes) != 0 {
		t.Fatalf("backup options %+v", o)
	}
	for p := range f.restic.Snapshots[out.SnapshotID] {
		stagedAtSnapshot = append(stagedAtSnapshot, p)
		if strings.Contains(p, "old.bak") {
			t.Fatal("the leftover of an earlier run went into the snapshot")
		}
	}
	if len(stagedAtSnapshot) != 3 {
		t.Fatalf("snapshot holds %v", stagedAtSnapshot)
	}
	if _, err := os.Stat(inst); !os.IsNotExist(err) {
		t.Fatalf("the staging folder was not cleared after the snapshot: %v", err)
	}
	// The SQL Server service SID may write the instance folder.
	want, _ := sqlserver.ServiceSID("MSSQL$SQLEXPRESS")
	if d := f.fs.DACL(inst); len(d) != 2 || d[1] != want {
		t.Fatalf("DACL of the instance folder %v", d)
	}
	// Every backup in the report is in the snapshot under its path, with its hash.
	for _, db := range out.Report.Databases {
		b := db.Backup
		content, ok := f.restic.Snapshots[out.SnapshotID][b.PathInSnapshot]
		if !ok {
			t.Fatalf("%s not in the snapshot", b.PathInSnapshot)
		}
		sum := sha256.Sum256(content)
		if hex.EncodeToString(sum[:]) != b.SHA256 || int64(len(content)) != b.Bytes {
			t.Fatalf("hash of %s", db.Name)
		}
	}

	// A failed snapshot deletes the files too: the next run writes them
	// anew, and they would only fill the staging volume until then.
	g := newFixture(t, map[string]string{"inventory": "inventory-ok.jsonl", "backup:Sales": "backup-Sales.jsonl",
		"backup:master": "backup-master.jsonl", "backup:Scratch": "backup-Scratch.jsonl"})
	g.restic.BackupErr = errors.New("unable to open repository")
	out = g.env.BackupInstance(context.Background(), allConfig(), g.fact)
	if out.Status != api.StatusFailed || !strings.Contains(out.Errors[0].Message, "were deleted") {
		t.Fatalf("status %s, errors %+v", out.Status, out.Errors)
	}
	assertStagingEmpty(t, g)
}

func TestBackupStopped(t *testing.T) {
	f := newFixture(t, map[string]string{"inventory": "inventory-ok.jsonl", "backup:Sales": "backup-Sales.jsonl",
		"backup:master": "backup-master.jsonl", "backup:Scratch": "backup-Scratch.jsonl"})
	ctx, cancel := context.WithCancel(context.Background())
	f.runner.OnRequest = func(req sqlserver.Request) {
		if req.Op == sqlserver.OpBackup {
			cancel()
		}
	}
	out := f.env.BackupInstance(ctx, allConfig(), f.fact)
	if !out.Stopped || len(f.restic.Backups) != 0 {
		t.Fatalf("%+v", out)
	}
	// The file of the BACKUP that was stopped does not stay.
	assertStagingEmpty(t, f)
}

// A job's own staging folder becomes the agent's or is refused: a folder
// that holds other files (the customer's own backups, say) is neither
// re-permitted nor emptied, an empty one gets the marker, and a folder with
// the marker is used again.
func TestBackupCustomStagingTrust(t *testing.T) {
	ok := map[string]string{"inventory": "inventory-ok.jsonl", "backup:Sales": "backup-Sales.jsonl",
		"backup:master": "backup-master.jsonl", "backup:Scratch": "backup-Scratch.jsonl"}
	// The staging path is a Windows path; on other systems it is a relative
	// name below the test's working folder (the fixtures read their
	// recordings before the change of folder). On Windows it is a folder
	// below the test's temporary folder, as a runner has no drive E:.
	f := newFixture(t, ok)
	runs := []*fixture{newFixture(t, ok), newFixture(t, ok)}
	t.Chdir(t.TempDir())
	dir, volume := `E:\SqlStaging`, `E:\`
	if runtime.GOOS == "windows" {
		dir = filepath.Join(t.TempDir(), "SqlStaging")
		volume = filepath.VolumeName(dir) + `\`
	}
	f.env.CustomStaging, f.env.StagingRoot = true, dir
	f.fs.Facts = &sqlserver.VolumeFacts{Root: volume, Fixed: true, FileSystem: "NTFS"}
	if err := os.MkdirAll(filepath.Join(dir, "SQLEXPRESS"), 0o700); err != nil {
		t.Fatal(err)
	}
	theirs := filepath.Join(dir, "SQLEXPRESS", "their-own.bak")
	if err := os.WriteFile(theirs, []byte("customer backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	out := f.env.BackupInstance(context.Background(), allConfig(), f.fact)
	if out.Status != api.StatusFailed || !hasCode(out.Errors, api.SQLStagingUnusable) || len(f.runner.Calls) != 0 {
		t.Fatalf("%+v", out)
	}
	if _, err := os.Stat(theirs); err != nil || len(f.fs.Removed) != 0 || len(f.fs.DACLs) != 0 {
		t.Fatalf("a folder of someone else was touched: %v, removed %v, DACLs %v", err, f.fs.Removed, f.fs.DACLs)
	}

	// An empty folder is taken over and marked; the next run uses it again.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for run, g := range runs {
		g.env.CustomStaging, g.env.StagingRoot = true, dir
		g.fs.Facts = f.fs.Facts
		out = g.env.BackupInstance(context.Background(), allConfig(), g.fact)
		if out.Status != api.StatusSucceeded {
			t.Fatalf("run %d: %+v\n%s", run, out, g.log.Text())
		}
		if b, err := os.ReadFile(filepath.Join(dir, sqlserver.StagingMarker)); err != nil || string(b) != sqlserver.StagingMarkerText {
			t.Fatalf("run %d: marker %q %v", run, b, err)
		}
		assertStagingEmpty(t, g)
	}
}

func TestBackupCustomStagingChecked(t *testing.T) {
	f := newFixture(t, map[string]string{"inventory": "inventory-ok.jsonl"})
	f.env.CustomStaging = true
	f.env.StagingRoot = `E:\SqlStaging`
	f.fs.Facts = &sqlserver.VolumeFacts{Root: `E:\`, Fixed: false, FileSystem: "NTFS"}
	out := f.env.BackupInstance(context.Background(), allConfig(), f.fact)
	if out.Status != api.StatusFailed || !hasCode(out.Errors, api.SQLStagingUnusable) || len(f.runner.Calls) != 0 {
		t.Fatalf("%+v", out)
	}
}

// ---- checks ---------------------------------------------------------------------

const salesSnapshot = "18eb0f31e91b9c0452a42c9fcf31d37b771774327c9370af2b19bd2d64b4ea1e"
const salesPath = "/C/ProgramData/Restow/data/staging/sql/SQLEXPRESS/Sales~8de4e0ea/full-20261105T020011Z.bak"

var salesContent = []byte("TAPE backup of Sales")

func salesVerifyTask() api.SQLVerifyParams {
	sum := sha256.Sum256(salesContent)
	return api.SQLVerifyParams{Instance: "SQLEXPRESS", MaxGiB: 200, Databases: []api.SQLVerifyDatabase{{
		DatabaseID: "c1d2e3f4-0a1b-4c2d-8e3f-5a6b7c8d9e01", BackupID: "a9e8d7c6-b5a4-4392-8170-6f5e4d3c2b1a", Name: "Sales",
		SnapshotID: salesSnapshot, PathInSnapshot: salesPath, SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(salesContent)),
		UsedBytes: 734003200,
		FileList: []api.SQLFile{{LogicalName: "Sales", Type: "D", FileGroup: "PRIMARY", FileID: 1, SizeBytes: 1 << 30, PhysicalName: `Q:\Data\Sales.mdf`},
			{LogicalName: "Sales_log", Type: "L", FileID: 2, SizeBytes: 256 << 20, PhysicalName: `L:\Log\Sales_log.ldf`}},
	}}}
}

func verifyFixture(t *testing.T, verify string, extra ...string) *fixture {
	replies := map[string]string{"inventory": "inventory-ok.jsonl", "filelist": "filelist-Sales.jsonl", "drop": "drop.jsonl"}
	if verify != "" {
		replies["verify"] = verify
	}
	for i := 0; i+1 < len(extra); i += 2 {
		replies[extra[i]] = extra[i+1]
	}
	f := newFixture(t, replies)
	f.restic.Put(salesSnapshot, salesPath, salesContent)
	return f
}

func TestVerifyCasesGolden(t *testing.T) {
	cases := []struct {
		name   string
		verify string
		extra  []string
		setup  func(*fixture, *api.SQLVerifyParams)
		check  func(*testing.T, *fixture, api.SQLVerifyResult)
		status string
	}{
		{name: "green", verify: "verify-green.jsonl", status: api.StatusSucceeded, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if !r.Fetched || !r.SHA256Match || r.Restore == nil || !r.Restore.OK || r.Checkdb == nil || !r.Checkdb.Ran || !r.Dropped || r.Code != "" {
				t.Fatalf("%+v", r)
			}
		}},
		{name: "checkdb-8928", verify: "verify-checkdb-8928.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if len(r.Checkdb.Errors) != 2 || r.Checkdb.Errors[0].Number != 8928 || r.Checkdb.Errors[0].RepairLevel != "repair_allow_data_loss" {
				t.Fatalf("%+v", r.Checkdb)
			}
		}},
		{name: "restore-3183", verify: "verify-restore-3183.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Restore == nil || r.Restore.OK || r.Restore.Errors[0].Number != 3183 || r.Checkdb != nil || r.Code != api.SQLRestoreFailed {
				t.Fatalf("%+v", r)
			}
		}},
		{name: "media-3241", extra: []string{"filelist", "filelist-media-3241.jsonl"}, status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Restore == nil || r.Restore.OK || r.Restore.Errors[0].Number != 3241 {
				t.Fatalf("%+v", r)
			}
		}},
		{name: "sha-mismatch", verify: "verify-green.jsonl", setup: func(f *fixture, _ *api.SQLVerifyParams) { f.restic.Corrupt = true },
			status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
				if !r.Fetched || r.SHA256Match || r.Restore != nil || r.Code != api.SQLBackupMismatch {
					t.Fatalf("%+v", r)
				}
				for _, op := range f.runner.Ops() {
					if strings.HasPrefix(op, "verify") || strings.HasPrefix(op, "filelist") {
						t.Fatalf("a backup that does not match was restored: %v", f.runner.Ops())
					}
				}
			}},
		{name: "no-space", verify: "verify-green.jsonl", setup: func(f *fixture, _ *api.SQLVerifyParams) { f.fs.Default = 600 << 20; f.fs.Root = `C:\` },
			status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
				if r.Fetched || r.Restore != nil || r.Code != api.SQLVerifyNoSpace || len(f.restic.Restores) != 0 {
					t.Fatalf("%+v", r)
				}
			}},
		{name: "checkdb-timeout", verify: "verify-checkdb-timeout.jsonl", setup: func(f *fixture, p *api.SQLVerifyParams) { p.PhysicalOnly = true },
			status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
				if r.Code != api.SQLVerifyTimeout || r.Checkdb == nil || r.Checkdb.Ran {
					t.Fatalf("%+v", r)
				}
			}},
		{name: "login-missing", extra: []string{"inventory", "connect-login-missing.jsonl"}, status: api.StatusFailed,
			check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
				if r.Code != api.SQLLoginMissing || r.Fetched {
					t.Fatalf("%+v", r)
				}
			}},
		// CHECKDB could not run to its end on this machine: incomplete, never
		// red (docs/BAREMETAL-WINDOWS.md 5.1.7).
		{name: "checkdb-tempdb-full", verify: "verify-checkdb-tempdb-full.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Checkdb == nil || r.Checkdb.Ran || len(r.Checkdb.Errors) != 0 || r.Code != api.SQLVerifyNoSpace || !strings.Contains(r.Message, "(1105)") {
				t.Fatalf("%+v %+v", r, r.Checkdb)
			}
		}},
		{name: "checkdb-8921-row", verify: "verify-checkdb-8921-row.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Checkdb == nil || r.Checkdb.Ran || len(r.Checkdb.Errors) != 0 || r.Code != api.SQLVerifyNoSpace {
				t.Fatalf("%+v %+v", r, r.Checkdb)
			}
		}},
		{name: "checkdb-connection-drop", verify: "verify-checkdb-connection-drop.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Checkdb != nil || r.Code != api.SQLScriptFailed {
				t.Fatalf("%+v", r)
			}
			if ops := f.runner.Ops(); ops[len(ops)-1] != "drop" {
				t.Fatalf("ops %v", ops)
			}
		}},
		{name: "checkdb-connection-drop-result", verify: "verify-checkdb-connection-drop-result.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Checkdb == nil || r.Checkdb.Ran || len(r.Checkdb.Errors) != 0 || r.Code != api.SQLScriptFailed || r.Dropped {
				t.Fatalf("%+v %+v", r, r.Checkdb)
			}
		}},
		// A consistency error raised as a message (no TABLERESULTS row) is
		// evidence all the same.
		{name: "checkdb-raised-2533", verify: "verify-checkdb-raised-2533.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Checkdb == nil || !r.Checkdb.Ran || len(r.Checkdb.Errors) != 1 || r.Checkdb.Errors[0].Number != 2533 || r.Code != "" {
				t.Fatalf("%+v %+v", r, r.Checkdb)
			}
		}},
		// A copy of master under a check name shows catalog errors (8992)
		// only because it is not master (C22, seen in the CI): incomplete
		// with sql_verify_system_db, never red.
		{name: "master-catalog", verify: "verify-checkdb-master-catalog.jsonl", setup: func(f *fixture, p *api.SQLVerifyParams) { p.Databases[0].Name = "master" },
			status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
				if r.Code != api.SQLVerifySystemDB || r.Checkdb == nil || r.Checkdb.Ran || len(r.Checkdb.Errors) != 0 || !r.Dropped {
					t.Fatalf("%+v %+v", r, r.Checkdb)
				}
			}},
		// The same catalog errors in a user database are evidence.
		{name: "user-db-catalog", verify: "verify-checkdb-master-catalog.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Code != "" || r.Checkdb == nil || !r.Checkdb.Ran || len(r.Checkdb.Errors) != 2 || r.Checkdb.Errors[0].Number != 8992 {
				t.Fatalf("%+v %+v", r, r.Checkdb)
			}
		}},
		// Any other CHECKDB error in a copy of master stays evidence.
		{name: "master-damage", verify: "verify-checkdb-8928.jsonl", setup: func(f *fixture, p *api.SQLVerifyParams) { p.Databases[0].Name = "master" },
			status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
				if r.Code != "" || r.Checkdb == nil || !r.Checkdb.Ran || len(r.Checkdb.Errors) != 2 || r.Checkdb.Errors[0].Number != 8928 {
					t.Fatalf("%+v %+v", r, r.Checkdb)
				}
			}},
		// The data and log volumes keep a reserve for the live databases:
		// free space that holds the copy with 1 MiB to spare is refused.
		{name: "no-reserve", verify: "verify-green.jsonl", setup: func(f *fixture, p *api.SQLVerifyParams) {
			n := sqlserver.NeedOf(p.Databases[0].Bytes, p.Databases[0].FileList)
			f.fs.Default = uint64(n.Bak+n.Data+n.Log) + 1<<20
			f.fs.Root = `Q:\`
		}, status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Fetched || r.Code != api.SQLVerifyNoSpace || len(f.restic.Restores) != 0 || !strings.Contains(r.Message, "leaves at least 1.0 GiB free") {
				t.Fatalf("%+v", r)
			}
		}},
		// With a tenth of a large volume as the reserve.
		{name: "reserve-large-volume", verify: "verify-green.jsonl", setup: func(f *fixture, p *api.SQLVerifyParams) {
			n := sqlserver.NeedOf(p.Databases[0].Bytes, p.Databases[0].FileList)
			f.fs.Total = 100 * uint64(sqlserver.GiB)
			f.fs.Default = uint64(n.Bak+n.Data+n.Log) + 5*uint64(sqlserver.GiB)
			f.fs.Root = `Q:\`
		}, status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Code != api.SQLVerifyNoSpace || !strings.Contains(r.Message, "leaves at least 10.0 GiB free") {
				t.Fatalf("%+v", r)
			}
		}},
		{name: "reserve-ok", verify: "verify-green.jsonl", setup: func(f *fixture, p *api.SQLVerifyParams) {
			n := sqlserver.NeedOf(p.Databases[0].Bytes, p.Databases[0].FileList)
			f.fs.Default = uint64(n.Bak+n.Data+n.Log) + uint64(sqlserver.GiB) + 1<<20
			f.fs.Root = `Q:\`
		}, status: api.StatusSucceeded, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Code != "" || !r.Checkdb.Ran {
				t.Fatalf("%+v", r)
			}
		}},
		{name: "crash", verify: "backup-crash-halfway.jsonl", status: api.StatusFailed, check: func(t *testing.T, f *fixture, r api.SQLVerifyResult) {
			if r.Code != api.SQLScriptFailed || r.Restore != nil {
				t.Fatalf("%+v", r)
			}
			// The copy is dropped at once, and stays in the journal only if that fails.
			ops := f.runner.Ops()
			if ops[len(ops)-1] != "drop" {
				t.Fatalf("ops %v", ops)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := verifyFixture(t, c.verify, c.extra...)
			p := salesVerifyTask()
			if c.setup != nil {
				c.setup(f, &p)
			}
			out := f.env.Verify(context.Background(), p, f.fact, "run-1")
			if out.Status != c.status {
				t.Fatalf("status %s, want %s: %+v\n%s", out.Status, c.status, out.Report, f.log.Text())
			}
			c.check(t, f, out.Report.Databases[0])
			// The fetched backup never stays.
			if _, err := os.Stat(filepath.Join(f.env.RestoreRoot, "run-1", "0")); !os.IsNotExist(err) {
				t.Fatalf("the fetched backup was not deleted: %v", err)
			}
			f.golden("verify-"+c.name, map[string]any{"status": out.Status, "errors": out.Errors, "sqlVerify": out.Report, "ops": f.runner.Ops()})
		})
	}
}

// The check copy is restored with the MOVE targets from FILELISTONLY of the
// fetched file, in the instance's default folders, and the SQL Server
// service may read the fetched file.
func TestVerifyRequests(t *testing.T) {
	f := verifyFixture(t, "verify-green.jsonl")
	out := f.env.Verify(context.Background(), salesVerifyTask(), f.fact, "run-1")
	if out.Status != api.StatusSucceeded {
		t.Fatalf("%+v", out)
	}
	var vp sqlserver.VerifyParams
	for _, c := range f.runner.Calls {
		if c.Op == sqlserver.OpVerify {
			_ = json.Unmarshal(c.Params, &vp)
		}
	}
	if !sqlserver.IsVerifyName(vp.VerifyName) || !strings.HasPrefix(vp.VerifyName, "Sales__restow_verify_") || vp.PhysicalOnly {
		t.Fatalf("%+v", vp)
	}
	if len(vp.Moves) != 2 || !strings.HasPrefix(vp.Moves[0].PhysicalName, `Q:\Data\`) || !strings.HasSuffix(vp.Moves[0].PhysicalName, "_1.mdf") ||
		!strings.HasPrefix(vp.Moves[1].PhysicalName, `L:\Log\`) || !strings.HasSuffix(vp.Moves[1].PhysicalName, "_2.ldf") {
		t.Fatalf("moves %+v", vp.Moves)
	}
	if vp.Path != sqlserver.RestoredPath(filepath.Join(f.env.RestoreRoot, "run-1", "0"), salesPath) {
		t.Fatalf("path %s", vp.Path)
	}
	sid, _ := sqlserver.ServiceSID("MSSQL$SQLEXPRESS")
	if d := f.fs.DACL(filepath.Join(f.env.RestoreRoot, "run-1", "0")); len(d) != 2 || d[0] != "read" || d[1] != sid {
		t.Fatalf("DACL %v", d)
	}
	// The journal is empty again after the drop.
	j := sqlserver.Journal{FS: f.fs, Path: f.env.JournalPath}
	if left, _ := j.Leftovers("SQLEXPRESS"); len(left) != 0 {
		t.Fatalf("journal %v", left)
	}
	// Large databases are checked PHYSICAL_ONLY.
	g := verifyFixture(t, "verify-green.jsonl")
	p := salesVerifyTask()
	p.MaxGiB = 0
	p.Databases[0].UsedBytes = 300 * sqlserver.GiB
	p.MaxGiB = 200
	g.env.Verify(context.Background(), p, g.fact, "run-2")
	for _, c := range g.runner.Calls {
		if c.Op == sqlserver.OpVerify {
			_ = json.Unmarshal(c.Params, &vp)
		}
	}
	if !vp.PhysicalOnly {
		t.Fatal("a database above maxGiB was not checked PHYSICAL_ONLY")
	}
}

// Leftovers of an earlier check are dropped before the check, and only
// names that are in the journal and have the check form.
func TestVerifyCleansUpOnlyFromTheJournal(t *testing.T) {
	f := verifyFixture(t, "verify-green.jsonl")
	journal := `{"version":1,"entries":[
	 {"instance":"SQLEXPRESS","name":"Sales__restow_verify_20261101T030000Z","plannedAt":"2026-11-01T03:00:00Z"},
	 {"instance":"SQLEXPRESS","name":"Sales_old","plannedAt":"2026-11-01T03:00:00Z"},
	 {"instance":"OTHER","name":"Sales__restow_verify_20261101T030000Z","plannedAt":"2026-11-01T03:00:00Z"}]}`
	if err := os.WriteFile(f.env.JournalPath, []byte(journal), 0o600); err != nil {
		t.Fatal(err)
	}
	f.env.Verify(context.Background(), salesVerifyTask(), f.fact, "run-1")
	var drops []sqlserver.DropParams
	for _, c := range f.runner.Calls {
		if c.Op == sqlserver.OpDrop {
			var p sqlserver.DropParams
			_ = json.Unmarshal(c.Params, &p)
			drops = append(drops, p)
		}
	}
	if len(drops) != 1 || !reflect.DeepEqual(drops[0].Names, []string{"Sales__restow_verify_20261101T030000Z"}) {
		t.Fatalf("drops %+v", drops)
	}
	if f.runner.Ops()[0] != "drop" {
		t.Fatalf("the cleanup did not come first: %v", f.runner.Ops())
	}
	b, _ := os.ReadFile(f.env.JournalPath)
	if !bytes.Contains(b, []byte("Sales_old")) || !bytes.Contains(b, []byte(`"OTHER"`)) || bytes.Contains(b, []byte(`"SQLEXPRESS","name":"Sales__restow_verify_20261101`)) {
		t.Fatalf("journal after the cleanup: %s", b)
	}
}

// ---- restore under a new name ------------------------------------------------------

func salesRestoreTask() api.SQLRestoreParams {
	v := salesVerifyTask().Databases[0]
	return api.SQLRestoreParams{BackupID: v.BackupID, Instance: "SQLEXPRESS", TargetInstance: "SQLEXPRESS", Database: "Sales",
		NewName: "Sales_restored_20261105", SnapshotID: v.SnapshotID, PathInSnapshot: v.PathInSnapshot, SHA256: v.SHA256,
		Bytes: v.Bytes, FileList: v.FileList, Checkdb: true, MaxGiB: 200}
}

func TestRestoreCasesGolden(t *testing.T) {
	cases := []struct {
		name    string
		extra   []string
		setup   func(*fixture, *api.SQLRestoreParams)
		status  string
		code    string
		fetched bool
		msg     string
	}{
		{name: "ok", status: api.StatusSucceeded, fetched: true},
		{name: "name-exists", setup: func(_ *fixture, p *api.SQLRestoreParams) { p.NewName = "sales" }, status: api.StatusFailed, code: api.SQLRestoreNameTaken},
		{name: "name-taken-at-filelist", extra: []string{"filelist", "filelist-Sales-taken.jsonl"}, status: api.StatusFailed, code: api.SQLRestoreNameTaken, fetched: true},
		{name: "name-with-marker", setup: func(_ *fixture, p *api.SQLRestoreParams) { p.NewName = "x__restow_verify_1" }, status: api.StatusFailed, code: api.SQLScriptFailed},
		{name: "system-name", setup: func(_ *fixture, p *api.SQLRestoreParams) { p.NewName = "MSDB" }, status: api.StatusFailed, code: api.SQLScriptFailed},
		{name: "mismatch", setup: func(f *fixture, _ *api.SQLRestoreParams) { f.restic.Corrupt = true }, status: api.StatusFailed, code: api.SQLBackupMismatch, fetched: true},
		{name: "no-space", setup: func(f *fixture, _ *api.SQLRestoreParams) { f.fs.Default = 100 << 20 }, status: api.StatusFailed, code: api.SQLRestoreNoSpace},
		{name: "no-reserve", setup: func(f *fixture, p *api.SQLRestoreParams) {
			n := sqlserver.NeedOf(p.Bytes, p.FileList)
			f.fs.Default = uint64(n.Bak+n.Data+n.Log) + 1<<20
		}, status: api.StatusFailed, code: api.SQLRestoreNoSpace},
		// The script was ended (its time limit, a crash): the new name is
		// dropped while it is in RESTORING, and only then.
		{name: "killed", extra: []string{"restore", "backup-crash-halfway.jsonl", "droprestoring", "droprestoring-dropped.jsonl"},
			status: api.StatusFailed, code: api.SQLScriptFailed, fetched: true, msg: "dropped again"},
		{name: "timeout", extra: []string{"restore", "restore-timeout.jsonl", "droprestoring", "droprestoring-dropped.jsonl"},
			status: api.StatusFailed, code: api.SQLScriptFailed, fetched: true, msg: "time limit"},
		{name: "killed-cleanup-failed", extra: []string{"restore", "backup-crash-halfway.jsonl", "droprestoring", "droprestoring-failed.jsonl"},
			status: api.StatusFailed, code: api.SQLScriptFailed, fetched: true, msg: `may be left on instance SQLEXPRESS (in an unknown state), with its files Q:\Data\`},
		{name: "killed-online", extra: []string{"restore", "backup-crash-halfway.jsonl", "droprestoring", "droprestoring-online.jsonl"},
			status: api.StatusFailed, code: api.SQLScriptFailed, fetched: true, msg: "(in state ONLINE)"},
		{name: "killed-nothing-left", extra: []string{"restore", "backup-crash-halfway.jsonl", "droprestoring", "droprestoring-none.jsonl"},
			status: api.StatusFailed, code: api.SQLScriptFailed, fetched: true},
		{name: "failed-cleaned", extra: []string{"restore", "restore-failed-cleaned.jsonl"},
			status: api.StatusFailed, code: api.SQLRestoreFailed, fetched: true, msg: "dropped again"},
		{name: "failed-leftover", extra: []string{"restore", "restore-failed-leftover.jsonl"},
			status: api.StatusFailed, code: api.SQLRestoreFailed, fetched: true, msg: "(in state RECOVERY_PENDING)"},
		// The name was taken between the look and the RESTORE: nothing is
		// dropped.
		{name: "name-taken-race", extra: []string{"restore", "restore-name-taken-race.jsonl", "droprestoring", "droprestoring-dropped.jsonl"},
			status: api.StatusFailed, code: api.SQLRestoreNameTaken, fetched: true},
		{name: "checkdb-tempdb-full", extra: []string{"restore", "restore-checkdb-tempdb-full.jsonl"},
			status: api.StatusPartial, fetched: true, msg: "did not run to its end: Could not allocate space"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			replies := map[string]string{"inventory": "inventory-ok.jsonl", "filelist": "filelist-Sales.jsonl", "restore": "restore-ok.jsonl"}
			for i := 0; i+1 < len(c.extra); i += 2 {
				replies[c.extra[i]] = c.extra[i+1]
			}
			f := newFixture(t, replies)
			f.restic.Put(salesSnapshot, salesPath, salesContent)
			p := salesRestoreTask()
			if c.setup != nil {
				c.setup(f, &p)
			}
			out := f.env.Restore(context.Background(), p, f.fact, "run-7")
			if out.Status != c.status || (c.code != "" && out.Report.Code != c.code) || out.Report.Fetched != c.fetched {
				t.Fatalf("%+v %+v\n%s", out, out.Report, f.log.Text())
			}
			if c.msg != "" && (len(out.Errors) == 0 || !strings.Contains(out.Errors[0].Message, c.msg)) {
				t.Fatalf("errors %+v, want %q", out.Errors, c.msg)
			}
			for _, op := range f.runner.Ops() {
				if strings.HasPrefix(op, "droprestoring") && op != "droprestoring:"+p.NewName {
					t.Fatalf("cleanup of another name: %v", f.runner.Ops())
				}
				if op == "droprestoring:"+p.NewName && (c.code == api.SQLRestoreNameTaken || c.status != api.StatusFailed) {
					t.Fatalf("a cleanup ran after %s: %v", c.name, f.runner.Ops())
				}
			}
			for _, op := range f.runner.Ops() {
				if op == "restore:Sales" {
					t.Fatal("the original database was named in a restore")
				}
			}
			if _, err := os.Stat(filepath.Join(f.env.RestoreRoot, "run-7")); !os.IsNotExist(err) {
				t.Fatal("the fetched backup stayed")
			}
			f.golden("restore-"+c.name, map[string]any{"status": out.Status, "errors": out.Errors, "sqlRestore": out.Report, "ops": f.runner.Ops()})
		})
	}
}

// A stop during the RESTORE still cleans up the new name, on a fresh
// context, and says what it found.
func TestRestoreStoppedCleansUp(t *testing.T) {
	f := newFixture(t, map[string]string{"inventory": "inventory-ok.jsonl", "filelist": "filelist-Sales.jsonl",
		"restore": "restore-ok.jsonl", "droprestoring": "droprestoring-failed.jsonl"})
	f.restic.Put(salesSnapshot, salesPath, salesContent)
	ctx, cancel := context.WithCancel(context.Background())
	f.runner.OnRequest = func(req sqlserver.Request) {
		if req.Op == sqlserver.OpRestore {
			cancel()
		}
	}
	p := salesRestoreTask()
	out := f.env.Restore(ctx, p, f.fact, "run-7")
	ops := f.runner.Ops()
	if !out.Stopped || ops[len(ops)-1] != "droprestoring:"+p.NewName {
		t.Fatalf("%+v %v", out, ops)
	}
	if len(out.Errors) != 1 || !strings.Contains(out.Errors[0].Message, "may be left on instance SQLEXPRESS") {
		t.Fatalf("errors %+v", out.Errors)
	}
}

// JudgeCheckdb: red only with evidence of damage, incomplete for everything
// that stopped CHECKDB.
func TestJudgeCheckdb(t *testing.T) {
	row := func(n int) api.SQLCheckdbError {
		return api.SQLCheckdbError{Number: n, Level: 16, State: 1, Message: fmt.Sprint("row ", n)}
	}
	raised := func(n, sev int) api.SQLError {
		return api.SQLError{Number: n, Severity: sev, State: 1, Message: fmt.Sprint("raised ", n)}
	}
	scriptProblem := &sqlserver.Problem{Code: api.SQLScriptFailed, Step: sqlserver.StepCheckDB, Message: "x"}
	cases := []struct {
		name   string
		ran    bool
		rows   []api.SQLCheckdbError
		raised []api.SQLError
		prob   *sqlserver.Problem
		// want: "green", "red" or the code of the incomplete check.
		want   string
		errors int
	}{
		{name: "clean", ran: true, want: "green"},
		{name: "rows", ran: true, rows: []api.SQLCheckdbError{row(8928), row(8939)}, want: "red", errors: 2},
		{name: "rows and summary", ran: true, rows: []api.SQLCheckdbError{row(8928), row(8989)}, raised: []api.SQLError{raised(8989, 16)}, want: "red", errors: 1},
		{name: "tempdb full", raised: []api.SQLError{raised(1105, 17), raised(8921, 16)}, prob: scriptProblem, want: api.SQLVerifyNoSpace},
		{name: "8921 alone", raised: []api.SQLError{raised(8921, 16)}, prob: scriptProblem, want: api.SQLVerifyNoSpace},
		{name: "8921 as row", ran: true, rows: []api.SQLCheckdbError{row(8921)}, want: api.SQLVerifyNoSpace},
		{name: "log full", raised: []api.SQLError{raised(9002, 17)}, prob: scriptProblem, want: api.SQLVerifyNoSpace},
		{name: "snapshot", raised: []api.SQLError{raised(1823, 16), raised(7928, 16)}, prob: scriptProblem, want: api.SQLVerifyNoSpace},
		{name: "out of memory", raised: []api.SQLError{raised(701, 17)}, prob: scriptProblem, want: api.SQLScriptFailed},
		{name: "not found", raised: []api.SQLError{raised(2520, 16)}, prob: scriptProblem, want: api.SQLScriptFailed},
		{name: "invalid name", raised: []api.SQLError{raised(50001, 16)}, prob: scriptProblem, want: api.SQLScriptFailed},
		{name: "lock", raised: []api.SQLError{raised(5030, 16)}, prob: scriptProblem, want: api.SQLScriptFailed},
		{name: "connection", raised: []api.SQLError{raised(233, 20)}, prob: scriptProblem, want: api.SQLScriptFailed},
		{name: "unknown error", raised: []api.SQLError{raised(4060, 11)}, prob: scriptProblem, want: api.SQLScriptFailed},
		{name: "unknown error with no row", ran: true, raised: []api.SQLError{raised(3624, 20)}, want: api.SQLScriptFailed},
		{name: "raised 2533", raised: []api.SQLError{raised(2533, 16)}, prob: scriptProblem, want: "red", errors: 1},
		{name: "raised 824", raised: []api.SQLError{raised(824, 24)}, prob: scriptProblem, want: "red", errors: 1},
		{name: "raised 8909 and tempdb", raised: []api.SQLError{raised(8909, 16), raised(1105, 17)}, prob: scriptProblem, want: "red", errors: 1},
		{name: "time limit", raised: []api.SQLError{raised(-2, 11)}, prob: &sqlserver.Problem{Code: api.SQLVerifyTimeout, Step: sqlserver.StepCheckDB}, want: api.SQLVerifyTimeout},
		{name: "no result", want: api.SQLScriptFailed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, prob := sqlserver.JudgeCheckdb(api.SQLCheckdbResult{Ran: c.ran, Errors: c.rows}, c.raised, c.prob)
			verdict := "green"
			switch {
			case !got.Ran:
				if prob == nil || len(got.Errors) != 0 {
					t.Fatalf("incomplete without a problem: %+v %+v", got, prob)
				}
				verdict = prob.Code
			case len(got.Errors) > 0:
				verdict = "red"
			}
			if verdict != c.want || len(got.Errors) != c.errors || (got.Ran && prob != nil) {
				t.Fatalf("%s with %d errors (%+v, %+v), want %s with %d", verdict, len(got.Errors), got.Errors, prob, c.want, c.errors)
			}
		})
	}
}
