package sqlserver

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func TestNamesAndPaths(t *testing.T) {
	if got := SafeFolder("Sales"); got != "Sales~8de4e0ea" {
		t.Fatalf("SafeFolder = %s", got)
	}
	// Names that look alike after SafeName still get folders of their own.
	if a, b := SafeFolder("a b"), SafeFolder("a_b"); a == b || !strings.HasPrefix(a, "a_b~") {
		t.Fatalf("%s %s", a, b)
	}
	for in, want := range map[string]string{"": "db", "...": "db", ".hidden": "_hidden", "Verkäufe 2026": "Verk_ufe_2026", `a\..\b`: "a_.._b", "CON": "CON"} {
		if got := SafeName(in, 48); got != want {
			t.Errorf("SafeName(%q) = %q, want %q", in, got, want)
		}
	}
	if got := SafeName(strings.Repeat("x", 100), 48); len(got) != 48 {
		t.Fatalf("len %d", len(got))
	}
	at := time.Date(2026, 11, 5, 2, 0, 11, 0, time.UTC)
	p := `C:\ProgramData\Restow\data\staging\sql\SQLEXPRESS\Sales~8de4e0ea\full-20261105T020011Z.bak`
	if got := SnapshotPathOf(p); got != "/C/ProgramData/Restow/data/staging/sql/SQLEXPRESS/Sales~8de4e0ea/full-20261105T020011Z.bak" {
		t.Fatalf("snapshot path %s", got)
	}
	if got := SnapshotPathOf(`e:\SqlStaging\X\a.bak`); got != "/E/SqlStaging/X/a.bak" {
		t.Fatalf("snapshot path %s", got)
	}
	if got := BackupPath("/stage", "sqlexpress", "Sales", at); got != "/stage/SQLEXPRESS/Sales~8de4e0ea/full-20261105T020011Z.bak" {
		t.Fatalf("backup path %s", got)
	}
	if got := RestoredPath("/r/1", "/C/ProgramData/x.bak"); got != "/r/1/C/ProgramData/x.bak" {
		t.Fatalf("restored path %s", got)
	}
	if DataSourceFor("MSSQLSERVER") != `lpc:.` || DataSourceFor("SQLEXPRESS") != `lpc:.\SQLEXPRESS` {
		t.Fatal("data source")
	}
	if ServiceNameFor("mssqlserver") != "MSSQLSERVER" || ServiceNameFor("SQLEXPRESS") != "MSSQL$SQLEXPRESS" {
		t.Fatal("service name")
	}
}

// The service SIDs Windows itself shows for these services.
func TestServiceSID(t *testing.T) {
	for name, want := range map[string]string{
		"MSSQLSERVER":      "S-1-5-80-3880718306-3832830129-1677859214-2598158968-1052248003",
		"TrustedInstaller": "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
		"trustedinstaller": "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
	} {
		got, err := ServiceSID(name)
		if err != nil || got != want {
			t.Errorf("ServiceSID(%s) = %s, %v; want %s", name, got, err, want)
		}
	}
	if _, err := ServiceSID(`a\b`); err == nil {
		t.Fatal("a name with a backslash was accepted")
	}
	sddl, err := ModifySDDL([]string{"S-1-5-80-1-2-3-4-5"})
	if err != nil || sddl != "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;S-1-5-80-1-2-3-4-5)" {
		t.Fatalf("%s %v", sddl, err)
	}
	if _, err := ReadSDDL([]string{"S-1-5-80-1)(A;;FA;;;WD"}); err == nil {
		t.Fatal("an SDDL injection was accepted")
	}
}

func TestVerifyNames(t *testing.T) {
	at := time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC)
	n := VerifyName("Sales", at)
	if n != "Sales__restow_verify_20261108T030000Z" || !IsVerifyName(n) {
		t.Fatalf("%s", n)
	}
	long := VerifyName(strings.Repeat("ä", 200), at)
	if r := []rune(long); len(r) != 80+len(VerifyMarker)+16 || !IsVerifyName(long) {
		t.Fatalf("long name %d runes", len(r))
	}
	for _, s := range []string{"Sales", "__restow_verify_20261108T030000Z", "Sales__restow_verify_20261108T030000", "Sales__restow_verify_20261108T030000Zx",
		"Sales_restow_verify_20261108T030000Z", strings.Repeat("a", 81) + "__restow_verify_20261108T030000Z", "x__restow_verify_2026110xT030000Z"} {
		if IsVerifyName(s) {
			t.Errorf("%q counted as a check name", s)
		}
	}
	for _, ok := range []string{"Sales_restored_20261105", "a", strings.Repeat("ß", 128), "Sales copy"} {
		if err := ValidNewName(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", strings.Repeat("a", 129), "a\x01b", "Master", "tempdb", "x__restow_verify_y", "a\nb"} {
		if err := ValidNewName(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestMoveTargets(t *testing.T) {
	files := []api.SQLFile{
		{LogicalName: "Sales", Type: "D", FileID: 1}, {LogicalName: "Sales_log", Type: "L", FileID: 2},
		{LogicalName: "Sales2", Type: "D", FileID: 3}, {LogicalName: "Docs", Type: "S", FileID: 65537},
		{LogicalName: "ft", Type: "F", FileID: 4},
	}
	moves, err := MoveTargets("Sales restored", "3f9a1c2e", files, `C:\SQL\DATA\`, `L:\Log`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`C:\SQL\DATA\Sales_restored_3f9a1c2e_1.mdf`, `L:\Log\Sales_restored_3f9a1c2e_2.ldf`, `C:\SQL\DATA\Sales_restored_3f9a1c2e_3.ndf`,
		`C:\SQL\DATA\Sales_restored_3f9a1c2e_65537_fs`, `C:\SQL\DATA\Sales_restored_3f9a1c2e_4_ft`}
	for i, m := range moves {
		if m.PhysicalName != want[i] || m.LogicalName != files[i].LogicalName {
			t.Errorf("move %d = %+v, want %s", i, m, want[i])
		}
	}
	if _, err := MoveTargets("x", "1", []api.SQLFile{{LogicalName: "a", Type: "X", FileID: 1}}, `C:\D`, ""); err == nil {
		t.Fatal("unknown type accepted")
	}
	if _, err := MoveTargets("x", "1", []api.SQLFile{{LogicalName: "a", Type: "D", FileID: 1}, {LogicalName: "b", Type: "L", FileID: 1}}, `C:\D`, ""); err == nil {
		t.Fatal("duplicate file id accepted")
	}
	if _, err := MoveTargets("x", "1", nil, `C:\D`, ""); err == nil {
		t.Fatal("empty list accepted")
	}
	if MoveSuffix("a", "r1") == MoveSuffix("a", "r2") || len(MoveSuffix("a", "r1")) != 8 {
		t.Fatal("suffix")
	}
}

func TestStepTimeout(t *testing.T) {
	for used, want := range map[int64]time.Duration{-1: time.Hour, 0: time.Hour, 1: 2 * time.Hour, 50 * GiB: 2 * time.Hour,
		50*GiB + 1: 3 * time.Hour, 200 * GiB: 5 * time.Hour, 10000 * GiB: 48 * time.Hour} {
		if got := StepTimeout(used); got != want {
			t.Errorf("StepTimeout(%d) = %s, want %s", used, got, want)
		}
	}
	req, _ := NewRequest(OpVerify, "X", 2*time.Hour, nil)
	if KillAfter(req) != 8*time.Hour+5*time.Minute {
		t.Fatalf("kill after %s", KillAfter(req))
	}
}

func TestSelectAndPlan(t *testing.T) {
	dbs := []InventoryDB{
		{Name: "master", State: "ONLINE", CanBackup: true, UsedBytes: 4 << 20},
		{Name: "tempdb", State: "ONLINE", CanBackup: true},
		{Name: "Snap", State: "ONLINE", CanBackup: true, Snapshot: true},
		{Name: "Sales", State: "ONLINE", CanBackup: true, UsedBytes: 10 * GiB, LogUsedBytes: GiB},
		{Name: "Big", State: "ONLINE", CanBackup: true, UsedBytes: 30 * GiB},
		{Name: "Small", State: "ONLINE", CanBackup: true, UsedBytes: -1, SizeBytes: GiB},
		{Name: "Off", State: "OFFLINE", CanBackup: true},
		{Name: "NoRight", State: "ONLINE"},
		{Name: "Scratch", State: "ONLINE", CanBackup: true},
		{Name: "Sec", State: "ONLINE", CanBackup: true, ReplicaRole: "SECONDARY"},
	}
	cfg := &api.SQLConfig{Mode: api.SQLModeAlongside, Databases: api.SQLDatabaseSelection{All: true},
		Exclude: []api.SQLDatabaseRef{{Instance: "sqlexpress", Name: "Scratch"}, {Instance: "OTHER", Name: "Sales"}}}
	sel := SelectDatabases(cfg, "SQLEXPRESS", dbs)
	var names []string
	for _, d := range sel.Backup {
		names = append(names, d.Name)
	}
	if strings.Join(names, ",") != "master,Sales,Big,Small,Sec" || len(sel.Skipped) != 2 ||
		sel.Skipped[0].Code != api.SQLDatabaseUnavailable || sel.Skipped[1].Code != api.SQLPermissionMissing ||
		len(sel.CopyOnlySecondary) != 1 {
		t.Fatalf("%v %+v", names, sel)
	}
	// 20 GiB free: Sales (12.1 GiB with log) fits, Big (33 GiB) does not,
	// Small (1.1 GiB) still fits after it.
	plan := PlanSpace(uint64(20*GiB), `E:\`, sel.Backup)
	names = nil
	for _, d := range plan.Fit {
		names = append(names, d.Name)
	}
	if strings.Join(names, ",") != "master,Sales,Small,Sec" || len(plan.TooSmall) != 1 || plan.TooSmall[0].Name != "Big" ||
		!strings.Contains(plan.TooSmall[0].Message, `E:\`) {
		t.Fatalf("%v %+v", names, plan.TooSmall)
	}
	if EstimateBackupBytes(InventoryDB{UsedBytes: 100, LogUsedBytes: 10}) != 121 {
		t.Fatal("estimate")
	}
	list := &api.SQLConfig{Databases: api.SQLDatabaseSelection{List: []api.SQLDatabaseRef{{Name: "Sales"}, {Instance: "OTHER", Name: "master"}}}}
	if sel := SelectDatabases(list, "SQLEXPRESS", dbs); len(sel.Backup) != 1 || sel.Backup[0].Name != "Sales" {
		t.Fatalf("%+v", sel)
	}
}

func TestValidateStagingDir(t *testing.T) {
	good := VolumeFacts{Root: `E:\`, Fixed: true, FileSystem: "NTFS"}
	blocked := []string{`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`}
	if err := ValidateStagingDir(`E:\SqlStaging`, good, blocked); err != nil {
		t.Fatal(err)
	}
	for dir, vol := range map[string]VolumeFacts{
		`SqlStaging`:          good,
		`\\server\share\x`:    good,
		`E:\`:                 good,
		`E:\a\..\b`:           good,
		`C:\Windows\Temp\sql`: good,
		`c:\program files\x`:  good,
		`E:\x`:                {Root: `E:\`, Fixed: false, FileSystem: "NTFS"},
		`E:\y`:                {Root: `E:\`, Fixed: true, FileSystem: "ReFS"},
		`E:\z`:                {Root: `E:\`, Fixed: true, FileSystem: "NTFS", ReparseAt: `E:\z`},
		"E:\\bad\x01":         good,
	} {
		if err := ValidateStagingDir(dir, vol, blocked); err == nil {
			t.Errorf("%q accepted", dir)
		}
	}
}

func TestEncodeRequestIsASCII(t *testing.T) {
	req, err := NewRequest(OpBackup, "SQLEXPRESS", time.Hour, BackupParams{Database: "Verkäufe 😀", Path: `C:\x`})
	if err != nil {
		t.Fatal(err)
	}
	b, err := EncodeRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range b {
		if c >= 0x80 {
			t.Fatalf("non-ASCII byte in %s", b)
		}
	}
	var back Request
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	var p BackupParams
	_ = json.Unmarshal(back.Params, &p)
	if p.Database != "Verkäufe 😀" || back.StepTimeoutSeconds != 3600 || back.Protocol != Protocol || len(back.Statements) != len(Statements()) {
		t.Fatalf("%+v %+v", back, p)
	}
}

func TestBackupFactsRefusesWrongFiles(t *testing.T) {
	db := InventoryDB{Name: "Sales", FamilyGUID: "6f1e8a52-3c1d-4a8e-9b0e-2b7d9f1c0a11"}
	h := Header{BackupType: 1, DatabaseName: "Sales", FamilyGUID: db.FamilyGUID, CopyOnly: true, HasChecksums: true,
		FirstLSN: "1", LastLSN: "2", CheckpointLSN: "1", DatabaseBackupLSN: "", BackupStart: "2026-11-05T03:00:00", BackupFinish: "2026-11-05T03:01:00", TZOffsetMinutes: 60}
	files := []api.SQLFile{{LogicalName: "Sales", Type: "D", FileID: 1}}
	f, err := BackupFacts(BackupResult{Header: h, FileList: files}, db, "/C/x.bak", strings.Repeat("a", 64), 10)
	if err != nil || f.DatabaseBackupLSN != "0" || !f.BackupStart.Equal(time.Date(2026, 11, 5, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("%+v %v", f, err)
	}
	for i, mut := range []func(*Header){
		func(h *Header) { h.CopyOnly = false },
		func(h *Header) { h.BackupType = 5 },
		func(h *Header) { h.DatabaseName = "Other" },
		func(h *Header) { h.FamilyGUID = "00000000-0000-0000-0000-000000000000" },
		func(h *Header) { h.LastLSN = "1e5" },
		func(h *Header) { h.BackupStart = "" },
		func(h *Header) { h.FirstRecoveryForkGUID = "ABC" },
	} {
		x := h
		mut(&x)
		if _, err := BackupFacts(BackupResult{Header: x, FileList: files}, db, "/C/x.bak", "", 1); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestInventoryWireBounded(t *testing.T) {
	inv := &Inventory{CollectedAt: time.Date(2026, 11, 5, 2, 0, 3, 0, time.UTC)}
	var dbs []InventoryDB
	for i := 0; i < 1500; i++ {
		dbs = append(dbs, InventoryDB{Name: fmt.Sprintf("database_with_a_long_name_%04d", i), DatabaseID: i + 5, State: "ONLINE",
			FamilyGUID: "6f1e8a52-3c1d-4a8e-9b0e-2b7d9f1c0a11", DatabaseGUID: "0d9c2e7a-5b44-4f61-8a2e-7c3b1d9e4f22", RecoveryModel: "FULL",
			UsedBytes: -1, SizeBytes: 100, LastFullBackup: "2026-11-04T22:10:00"})
	}
	inv.Instances = []InstanceInventory{
		{Fact: api.SQLInstanceFact{Name: "SQLEXPRESS"}, Result: &InventoryResult{Version: "16.0.4135.4", Databases: dbs}},
		{Fact: api.SQLInstanceFact{Name: "RESTOWB"}, Problem: &Problem{Code: api.SQLLoginMissing, Step: StepConnect, Number: 18456, Message: "Login failed."}},
	}
	w := inv.Wire()
	b, _ := json.Marshal(w)
	if len(b) > api.MaxSQLInventoryBytes || !w.Truncated || len(w.Instances) != 2 || w.Instances[1].State != api.SQLInstanceError {
		t.Fatalf("%d bytes, truncated %v", len(b), w.Truncated)
	}
	first := w.Instances[0].Databases[0]
	if first.Name != "database_with_a_long_name_0000" || first.UsedBytes != 100 || first.LastFullBackupAt == nil {
		t.Fatalf("%+v", first)
	}
	// An instance that failed carries only its name, state and error.
	raw, _ := json.Marshal(w.Instances[1])
	if string(raw) != `{"name":"RESTOWB","state":"error","error":{"code":"sql_login_missing","step":"connect","number":18456,"message":"Login failed."},"databases":[]}` {
		t.Fatalf("%s", raw)
	}
	// Small inventories are not touched.
	inv.Instances[0].Result.Databases = dbs[:3]
	if w := inv.Wire(); w.Truncated || len(w.Instances[0].Databases) != 3 {
		t.Fatalf("%+v", w)
	}
	all := &api.SQLConfig{Enabled: true, Instances: api.SQLInstanceSelection{All: true}, Databases: api.SQLDatabaseSelection{All: true},
		Exclude: []api.SQLDatabaseRef{{Name: "Keep"}}}
	ex := &Inventory{Instances: []InstanceInventory{{Fact: api.SQLInstanceFact{Name: "SQLEXPRESS"}, Result: &InventoryResult{Databases: []InventoryDB{
		{Name: "Sales", Files: []DBFile{{Type: "ROWS", PhysicalName: `Q:\Data\Sales.mdf`}, {Type: "LOG", PhysicalName: `L:\Log\Sales_log.ldf`}}},
		{Name: "Sales2", Files: []DBFile{{Type: "ROWS", PhysicalName: `q:\data\sales.mdf`}}},
		{Name: "tempdb", Files: []DBFile{{Type: "ROWS", PhysicalName: `C:\T\tempdb.mdf`}}},
		{Name: "Keep", Files: []DBFile{{Type: "ROWS", PhysicalName: `Q:\Data\Keep.mdf`}}},
	}}}, {Fact: api.SQLInstanceFact{Name: "BROKEN"}, Problem: &Problem{Code: api.SQLLoginMissing}}}}
	if got := FileBackupExcludes(ex, all); strings.Join(got, ",") != `C:\T\tempdb.mdf,L:\Log\Sales_log.ldf,Q:\Data\Sales.mdf` {
		t.Fatalf("excludes %v", got)
	}
	off := *all
	off.Enabled = false
	if got := FileBackupExcludes(ex, &off); got != nil {
		t.Fatalf("excludes while off %v", got)
	}
	other := *all
	other.Instances = api.SQLInstanceSelection{Names: []string{"OTHER"}}
	if got := FileBackupExcludes(ex, &other); got != nil {
		t.Fatalf("excludes of an instance not selected %v", got)
	}
}

func TestJournal(t *testing.T) {
	fs := &memFS{files: map[string][]byte{}}
	j := Journal{FS: fs, Path: "j.json"}
	if left, err := j.Leftovers("X"); err != nil || len(left) != 0 {
		t.Fatal(left, err)
	}
	at := time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC)
	if err := j.Add("X", "Sales", at); err == nil {
		t.Fatal("a name without the check form went into the journal")
	}
	n := VerifyName("Sales", at)
	if err := j.Add("X", n, at); err != nil {
		t.Fatal(err)
	}
	if err := j.Add("Y", n, at); err != nil {
		t.Fatal(err)
	}
	if left, _ := j.Leftovers("x"); len(left) != 1 || left[0] != n {
		t.Fatalf("%v", left)
	}
	if err := j.Remove("X", n); err != nil {
		t.Fatal(err)
	}
	if left, _ := j.Leftovers("X"); len(left) != 0 {
		t.Fatalf("%v", left)
	}
	if left, _ := j.Leftovers("Y"); len(left) != 1 {
		t.Fatalf("%v", left)
	}
	fs.files["j.json"] = []byte("{")
	if _, err := j.Leftovers("Y"); err == nil {
		t.Fatal("a damaged journal was read")
	}
}

func TestInstanceNotices(t *testing.T) {
	now := time.Date(2026, 11, 5, 3, 0, 0, 0, time.UTC)
	inv := &InventoryResult{Version: "16.0.4135.4", Databases: []InventoryDB{
		{Name: "Sales", State: "ONLINE", RecoveryModel: "FULL", LastLogBackup: "2026-11-05T02:30:00"},
		{Name: "Old", State: "ONLINE", RecoveryModel: "FULL", LastLogBackup: "2026-11-03T02:30:00"},
		{Name: "Never", State: "ONLINE", RecoveryModel: "BULK_LOGGED"},
		{Name: "RO", State: "ONLINE", RecoveryModel: "FULL", ReadOnly: true},
		{Name: "Simple", State: "ONLINE", RecoveryModel: "SIMPLE", Encrypted: true},
	}}
	ns := InstanceNotices(api.SQLInstanceFact{Name: "X"}, inv, now)
	if len(ns) != 2 || ns[0].Code != api.NoticeSQLLogGrowing || strings.Join(ns[0].Subjects, ",") != "Never,Old" ||
		ns[1].Code != api.NoticeSQLTDECertificate || ns[1].Subjects[0] != "Simple" {
		t.Fatalf("%+v", ns)
	}
	inv.Version = "12.0.6024.0"
	if ns := InstanceNotices(api.SQLInstanceFact{Name: "X"}, inv, now); ns[len(ns)-1].Code != api.NoticeSQLVersionUntested {
		t.Fatalf("%+v", ns)
	}
}
