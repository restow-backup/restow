//go:build unix

package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
	"github.com/restow-backup/restow/agent/internal/sqlserver/sqlfake"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

// The native SQL Server backup in the engine, with the recorded script
// outputs of internal/sqlserver and the fake restic of the harness.

func sqlRuns(t *testing.T) string { return filepath.Join("..", "sqlserver", "testdata", "runs") }

func windowsWithSQL() *api.WindowsFacts {
	return &api.WindowsFacts{ProductName: "Windows Server 2022 Standard", ProductType: "server", InstallationType: "server", Build: 20348,
		Roles: api.WindowsRoles{SQLServer: true, DomainController: true},
		SQLInstances: []api.SQLInstanceFact{
			{Name: "SQLEXPRESS", ID: "MSSQL16.SQLEXPRESS", ServiceName: "MSSQL$SQLEXPRESS"},
			{Name: "RESTOWB", ID: "MSSQL16.RESTOWB", ServiceName: "MSSQL$RESTOWB"},
		}}
}

// sqlHarness is a harness on a Windows machine with two instances:
// SQLEXPRESS answers as recorded, RESTOWB has no login for the agent.
func sqlHarness(t *testing.T) (*harness, *sqlfake.Runner) {
	t.Helper()
	h := newHarness(t)
	h.machine = func() sysinfo.Machine {
		return sysinfo.Machine{Virtualization: sysinfo.VirtVM, Windows: windowsWithSQL()}
	}
	replies, err := sqlfake.Load(sqlRuns(t), map[string]string{
		"backup:Sales": "backup-Sales.jsonl", "backup:master": "backup-master.jsonl", "backup:Scratch": "backup-Scratch.jsonl",
		"filelist": "filelist-Sales.jsonl", "verify": "verify-green.jsonl", "drop": "drop.jsonl",
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, _ := os.ReadFile(filepath.Join(sqlRuns(t), "inventory-ok.jsonl"))
	missing, _ := os.ReadFile(filepath.Join(sqlRuns(t), "connect-login-missing.jsonl"))
	runner := &sqlfake.Runner{Replies: replies,
		Handler: func(req sqlserver.Request) (sqlfake.Reply, bool) {
			if req.Op != sqlserver.OpInventory {
				return sqlfake.Reply{}, false
			}
			if req.Instance == "RESTOWB" {
				return sqlfake.ParseRecording(string(missing)), true
			}
			return sqlfake.ParseRecording(string(ok)), true
		},
		OnRequest: func(req sqlserver.Request) {
			if req.Op == sqlserver.OpBackup {
				var p sqlserver.BackupParams
				_ = json.Unmarshal(req.Params, &p)
				_ = os.MkdirAll(filepath.Dir(p.Path), 0o700)
				_ = os.WriteFile(p.Path, []byte("TAPE backup of "+p.Database), 0o600)
			}
		}}
	fs := sqlfake.NewFS()
	h.sql = func() (*SQLSupport, error) { return &SQLSupport{Runner: runner, FS: fs}, nil }
	h.srv.Config.SQL = &api.SQLConfig{Enabled: true, Mode: api.SQLModeAlongside,
		Instances: api.SQLInstanceSelection{All: true}, Databases: api.SQLDatabaseSelection{All: true}}
	return h, runner
}

func countOps(r *sqlfake.Runner, op string) int {
	n := 0
	for _, o := range r.Ops() {
		if o == op || strings.HasPrefix(o, op+":") {
			n++
		}
	}
	return n
}

// One sql run per instance follows the file run of the slot; it carries no
// task, and an instance that fails does not touch the other.
func TestSQLRunsFollowTheFileRun(t *testing.T) {
	h, runner := sqlHarness(t)
	h.srv.QueueTask(api.Task{ID: "task-1", Kind: api.TaskBackupNow})
	h.start()
	third := h.waitRun(3)
	runs := h.srv.AllRuns()
	var kinds, tasks []string
	for _, r := range runs {
		kinds = append(kinds, r.Start.Kind)
		tasks = append(tasks, r.Start.TaskID.String())
	}
	if !reflect.DeepEqual(kinds, []string{api.RunBackup, api.RunSQL, api.RunSQL}) || !reflect.DeepEqual(tasks, []string{"task-1", "", ""}) {
		t.Fatalf("runs %v tasks %v", kinds, tasks)
	}
	h.srv.Lock()
	file, first := runs[0].Finish, runs[1].Finish
	h.srv.Unlock()
	if first.Status != api.StatusSucceeded || first.SQL == nil || first.SQL.Instance != "SQLEXPRESS" || len(first.SQL.Databases) != 3 ||
		first.SnapshotID == "" || first.SQL.Databases[0].Backup == nil {
		t.Fatalf("first sql run %+v %+v", first, first.SQL)
	}
	if third.Finish.Status != api.StatusFailed || third.Finish.SQL.Instance != "RESTOWB" || third.Finish.Errors[0].Code != api.SQLLoginMissing {
		t.Fatalf("second sql run %+v", third.Finish)
	}
	// The notice of the file run: the native backup covers every database,
	// so only Active Directory is left.
	if len(file.Notices) != 1 || !reflect.DeepEqual(file.Notices[0].Subjects, []string{api.SubjectActiveDirectory}) {
		t.Fatalf("notices %+v", file.Notices)
	}
	if !strings.Contains(first.LogTail, "SQL Server instance SQLEXPRESS") {
		t.Fatalf("log %s", first.LogTail)
	}
	// The file run left the database files out; the SQL snapshot has its tags.
	ex, _ := os.ReadFile(filepath.Join(h.dir, "excludes.txt"))
	if !strings.Contains(string(ex), `Q:\Data\Sales.mdf`) || !strings.Contains(string(ex), `L:\Log\Sales_log.ldf`) {
		t.Fatalf("excludes of the file run:\n%s", ex)
	}
	args, _ := os.ReadFile(filepath.Join(h.dir, "backup-args.txt"))
	if !strings.Contains(string(args), "--tag\nrestow-sql\n--tag\nrestow-sql-instance=SQLEXPRESS") || strings.Contains(string(args), "--use-fs-snapshot") {
		t.Fatalf("sql backup args:\n%s", args)
	}
	if countOps(runner, sqlserver.OpBackup) != 3 {
		t.Fatalf("ops %v", runner.Ops())
	}
	// Capabilities and the inventory go out with the heartbeat.
	if !fakeserver.WaitFor(10*time.Second, func() bool {
		h.srv.Lock()
		defer h.srv.Unlock()
		for _, hb := range h.srv.Heartbeats {
			if hb.SQLInventory != nil && len(hb.SQLInventory.Instances) == 2 {
				return reflect.DeepEqual(hb.Capabilities, []string{api.CapabilitySQLNative}) && hb.Machine.Windows != nil
			}
		}
		return false
	}) {
		t.Fatal("no heartbeat with capabilities, Windows facts and inventory")
	}
}

// Without paths only the SQL runs start, and they count for the schedule.
func TestSQLOnlyWithoutPaths(t *testing.T) {
	h, _ := sqlHarness(t)
	h.srv.Config.Paths = nil
	h.srv.Config.SQL.Instances = api.SQLInstanceSelection{Names: []string{"sqlexpress"}}
	h.build()
	before := h.status.Snapshot().LastAttemptAt
	h.srv.QueueTask(api.Task{ID: "task-1", Kind: api.TaskBackupNow})
	h.start()
	r := h.waitRun(1)
	if r.Start.Kind != api.RunSQL || r.Finish.Status != api.StatusSucceeded {
		t.Fatalf("%+v %+v", r.Start, r.Finish)
	}
	time.Sleep(300 * time.Millisecond)
	if n := len(h.srv.AllRuns()); n != 1 {
		t.Fatalf("%d runs", n)
	}
	if !fakeserver.WaitFor(5*time.Second, func() bool {
		st := h.status.Snapshot()
		return st.LastAttemptAt.After(before) && !st.LastSuccessAt.IsZero()
	}) {
		t.Fatalf("status %+v", h.status.Snapshot())
	}
}

// The inventory connects only while the native backup is on, or when the
// server asks for it (the "Check sign-in" button).
func TestSQLInventoryOnlyWhenOnOrAsked(t *testing.T) {
	h, runner := sqlHarness(t)
	h.srv.Config.SQL = nil
	h.start()
	if !fakeserver.WaitFor(5*time.Second, func() bool { return h.srv.HeartbeatCount() >= 4 }) {
		t.Fatal("no heartbeats")
	}
	if n := countOps(runner, sqlserver.OpInventory); n != 0 {
		t.Fatalf("the inventory connected %d times while the native backup is off", n)
	}
	h.srv.QueueTask(api.Task{ID: "inv-1", Kind: api.TaskSQLInventory})
	if !fakeserver.WaitFor(10*time.Second, func() bool {
		h.srv.Lock()
		defer h.srv.Unlock()
		for _, hb := range h.srv.Heartbeats {
			if hb.SQLInventory != nil {
				return len(hb.SQLInventory.Instances) == 2 && hb.SQLInventory.Instances[1].State == api.SQLInstanceError
			}
		}
		return false
	}) {
		t.Fatal("the inventory asked for never arrived")
	}
	if n := countOps(runner, sqlserver.OpInventory); n != 2 {
		t.Fatalf("inventory ops %d", n)
	}
	// Sent once: later heartbeats carry none.
	n := h.srv.HeartbeatCount()
	fakeserver.WaitFor(5*time.Second, func() bool { return h.srv.HeartbeatCount() >= n+3 })
	h.srv.Lock()
	with := 0
	for _, hb := range h.srv.Heartbeats {
		if hb.SQLInventory != nil {
			with++
		}
	}
	h.srv.Unlock()
	if with != 1 {
		t.Fatalf("%d heartbeats carried the inventory", with)
	}
}

func verifyTaskParams(content []byte) api.SQLVerifyParams {
	sum := sha256.Sum256(content)
	return api.SQLVerifyParams{Instance: "SQLEXPRESS", MaxGiB: 200, Databases: []api.SQLVerifyDatabase{{
		DatabaseID: "c1d2", BackupID: "a9e8", Name: "Sales",
		SnapshotID:     "18eb0f31e91b9c0452a42c9fcf31d37b771774327c9370af2b19bd2d64b4ea1e",
		PathInSnapshot: "/C/ProgramData/Restow/data/staging/sql/SQLEXPRESS/Sales~8de4e0ea/full-20261105T020011Z.bak",
		SHA256:         hex.EncodeToString(sum[:]), Bytes: int64(len(content)), UsedBytes: 734003200,
		FileList: []api.SQLFile{{LogicalName: "Sales", Type: "D", FileID: 1, SizeBytes: 1 << 30}, {LogicalName: "Sales_log", Type: "L", FileID: 2, SizeBytes: 1 << 28}},
	}}}
}

// claim: RESTORE-016
func TestSQLVerifyTask(t *testing.T) {
	h, runner := sqlHarness(t)
	content := []byte("TAPE backup of Sales")
	p := verifyTaskParams(content)
	src := filepath.Join(h.dir, "repo")
	dst := filepath.Join(src, filepath.FromSlash(p.Databases[0].PathInSnapshot))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, content, 0o644); err != nil {
		t.Fatal(err)
	}
	h.env("FAKE_RESTORE_SRC=" + src)
	h.srv.QueueTask(task("verify-1", api.TaskSQLVerify, p))
	h.start()
	r := h.waitRun(1)
	if r.Start.Kind != api.RunSQLVerify || r.Start.TaskID.String() != "verify-1" {
		t.Fatalf("%+v", r.Start)
	}
	v := r.Finish.SQLVerify
	if r.Finish.Status != api.StatusSucceeded || v == nil || len(v.Databases) != 1 || !v.Databases[0].SHA256Match || !v.Databases[0].Checkdb.Ran {
		t.Fatalf("%+v %+v\n%s", r.Finish, v, r.Finish.LogTail)
	}
	if countOps(runner, sqlserver.OpVerify) != 1 {
		t.Fatalf("ops %v", runner.Ops())
	}
	// The fetched backup is gone.
	if entries, _ := os.ReadDir(h.layout.SQLRestoreStagingDir()); len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("restore staging left: %v", names)
	}
}

// A stop in the Restow UI ends the running sql run; the next instance is
// not started.
func TestSQLRunCancelled(t *testing.T) {
	h, runner := sqlHarness(t)
	var once atomic.Bool
	runner.OnRequest = func(req sqlserver.Request) {
		if req.Op != sqlserver.OpBackup || !once.CompareAndSwap(false, true) {
			return
		}
		for _, r := range h.srv.AllRuns() {
			if r.Start.Kind == api.RunSQL {
				h.srv.Lock()
				h.srv.Cancel = &api.CancelOrders{Runs: []api.Flex{api.Flex(r.ID)}}
				h.srv.Unlock()
			}
		}
		time.Sleep(1500 * time.Millisecond)
	}
	h.srv.QueueTask(api.Task{ID: "task-1", Kind: api.TaskBackupNow})
	h.start()
	r := h.waitRun(2)
	if r.Start.Kind != api.RunSQL || r.Finish.Errors[len(r.Finish.Errors)-1].Code != "cancelled" {
		t.Fatalf("%+v", r.Finish)
	}
	time.Sleep(500 * time.Millisecond)
	if n := len(h.srv.AllRuns()); n != 2 {
		t.Fatalf("%d runs after the stop", n)
	}
}

// Outside Windows the setting is ignored and a SQL task fails cleanly.
func TestSQLUnsupportedSystem(t *testing.T) {
	h := newHarness(t)
	h.srv.Config.SQL = &api.SQLConfig{Enabled: true, Mode: api.SQLModeAlongside,
		Instances: api.SQLInstanceSelection{All: true}, Databases: api.SQLDatabaseSelection{All: true}}
	h.srv.QueueTask(api.Task{ID: "task-1", Kind: api.TaskBackupNow})
	h.srv.QueueTask(task("verify-1", api.TaskSQLVerify, verifyTaskParams([]byte("x"))))
	h.start()
	second := h.waitRun(2)
	runs := h.srv.AllRuns()
	if runs[0].Start.Kind != api.RunBackup || second.Start.Kind != api.RunSQLVerify ||
		second.Finish.Status != api.StatusFailed || second.Finish.Errors[0].Code != api.SQLScriptFailed {
		t.Fatalf("%+v %+v", runs[0].Start, second.Finish)
	}
	h.srv.Lock()
	hb := h.srv.Heartbeats[0]
	h.srv.Unlock()
	if len(hb.Capabilities) != 0 || hb.SQLInventory != nil {
		t.Fatalf("%+v", hb)
	}
}

func TestAppFileNotices(t *testing.T) {
	w := &api.WindowsFacts{Roles: api.WindowsRoles{SQLServer: true, DomainController: true, Exchange: true, HyperV: true}}
	ns := AppFileNotices(w, nil, false)
	if len(ns) != 1 || len(ns[0].Subjects) != 4 ||
		ns[0].Message != "Files of open databases are not a restorable SQL Server, Exchange, Active Directory or Hyper-V backup." {
		t.Fatalf("%+v", ns)
	}
	all := &api.SQLConfig{Enabled: true, Mode: api.SQLModeAlongside, Instances: api.SQLInstanceSelection{All: true}, Databases: api.SQLDatabaseSelection{All: true}}
	only := &api.WindowsFacts{Roles: api.WindowsRoles{SQLServer: true}}
	if ns := AppFileNotices(only, all, true); ns != nil {
		t.Fatalf("SQL covered: %+v", ns)
	}
	if ns := AppFileNotices(only, all, false); len(ns) != 1 {
		t.Fatal("not covered on a system without the native backup")
	}
	part := *all
	part.Exclude = []api.SQLDatabaseRef{{Name: "Scratch"}}
	if ns := AppFileNotices(only, &part, true); len(ns) != 1 || ns[0].Message != "Files of open databases are not a restorable SQL Server backup." {
		t.Fatalf("%+v", ns)
	}
	if AppFileNotices(nil, nil, false) != nil || AppFileNotices(&api.WindowsFacts{}, nil, false) != nil {
		t.Fatal("notice without a role")
	}
	many := make([]api.Notice, 20)
	if len(capNotices(many)) != api.MaxNotices {
		t.Fatal("cap")
	}
}
