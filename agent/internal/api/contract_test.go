package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The fixtures in testdata/contract are the contract between agent and server
// for the native SQL Server backup and the Windows facts (W1, W2a). The
// server's tests read the same files; these tests make sure the agent's
// types read every field of them (strictly: an unknown field fails) and write
// them back unchanged.

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "contract", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decodeStrict(t *testing.T, name string, raw []byte, into any) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func generic(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// sameJSON compares the fixture with what the agent writes. partial: only
// the top-level keys of the fixture count (the fixture shows the additions
// to a larger body).
func sameJSON(t *testing.T, name string, fixture []byte, v any, partial bool) {
	t.Helper()
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	want, got := generic(t, fixture), generic(t, out)
	if partial {
		for k := range got {
			if _, ok := want[k]; !ok {
				delete(got, k)
			}
		}
	}
	if !reflect.DeepEqual(want, got) {
		wb, _ := json.MarshalIndent(want, "", " ")
		gb, _ := json.MarshalIndent(got, "", " ")
		t.Fatalf("%s: round trip differs\nwant %s\ngot  %s", name, wb, gb)
	}
}

func TestContractFixturesRoundTrip(t *testing.T) {
	cases := []struct {
		file    string
		into    func() any
		partial bool
	}{
		{"config-sql.json", func() any { return &Config{} }, true},
		{"heartbeat-windows-sql.json", func() any { return &HeartbeatRequest{} }, true},
		{"finish-sql.json", func() any { return &FinishRequest{} }, false},
		{"finish-sql-restore.json", func() any { return &FinishRequest{} }, false},
		{"finish-sql-verify-green.json", func() any { return &FinishRequest{} }, false},
		{"finish-sql-verify-red.json", func() any { return &FinishRequest{} }, false},
		{"finish-sql-verify-incomplete.json", func() any { return &FinishRequest{} }, false},
		{"finish-backup-notices.json", func() any { return &FinishRequest{} }, true},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			raw := readFixture(t, c.file)
			v := c.into()
			decodeStrict(t, c.file, raw, v)
			sameJSON(t, c.file, raw, v, c.partial)
		})
	}
}

func TestContractTasks(t *testing.T) {
	for _, c := range []struct {
		file, kind string
		params     func() any
	}{
		{"task-sql-verify.json", TaskSQLVerify, func() any { return &SQLVerifyParams{} }},
		{"task-sql-restore.json", TaskSQLRestore, func() any { return &SQLRestoreParams{} }},
	} {
		t.Run(c.file, func(t *testing.T) {
			raw := readFixture(t, c.file)
			var task Task
			decodeStrict(t, c.file, raw, &task)
			if task.Kind != c.kind || task.ID == "" {
				t.Fatalf("task %+v", task)
			}
			p := c.params()
			decodeStrict(t, c.file+" params", task.Params, p)
			sameJSON(t, c.file+" params", task.Params, p, false)
		})
	}
}

func TestContractSemantics(t *testing.T) {
	var cfg Config
	decodeStrict(t, "config", readFixture(t, "config-sql.json"), &cfg)
	s := cfg.SQL
	if s == nil || !s.Enabled || s.Mode != SQLModeAlongside || !s.Instances.All || !s.Databases.All ||
		len(s.Exclude) != 1 || s.Exclude[0].Instance != "SQLEXPRESS" || s.StagingDir != `E:\SqlStaging` {
		t.Fatalf("config.sql = %+v", s)
	}

	var hb HeartbeatRequest
	decodeStrict(t, "heartbeat", readFixture(t, "heartbeat-windows-sql.json"), &hb)
	if len(hb.Capabilities) != 1 || hb.Capabilities[0] != CapabilitySQLNative {
		t.Fatalf("capabilities %v", hb.Capabilities)
	}
	w := hb.Machine.Windows
	if w == nil || w.Build != 20348 || !w.Roles.SQLServer || len(w.SQLInstances) != 2 || w.BitLocker.State != BitLockerOK {
		t.Fatalf("windows facts %+v", w)
	}
	inv := hb.SQLInventory
	if inv == nil || len(inv.Instances) != 2 || inv.Instances[1].State != SQLInstanceError ||
		inv.Instances[1].Error.Code != SQLLoginMissing || inv.Instances[1].Error.Number != 18456 {
		t.Fatalf("inventory %+v", inv)
	}
	if db := inv.Instances[0].Databases[1]; db.LastFullBackupAt == nil || db.UsedBytes != 734003200 {
		t.Fatalf("database %+v", db)
	}

	var fin FinishRequest
	decodeStrict(t, "finish-sql", readFixture(t, "finish-sql.json"), &fin)
	b := fin.SQL.Databases[0].Backup
	if b == nil || !b.CopyOnly || b.Compressed || !b.Checksum || b.LastLSN != "37000000014400001" || len(b.FileList) != 2 {
		t.Fatalf("backup facts %+v", b)
	}
	if !strings.HasPrefix(b.PathInSnapshot, "/C/ProgramData/Restow/data/staging/sql/SQLEXPRESS/") {
		t.Fatalf("path %q", b.PathInSnapshot)
	}

	var inc FinishRequest
	decodeStrict(t, "incomplete", readFixture(t, "finish-sql-verify-incomplete.json"), &inc)
	if r := inc.SQLVerify.Databases[0]; r.Restore != nil || r.Checkdb != nil || r.Code != SQLVerifyNoSpace || !r.Fetched {
		t.Fatalf("incomplete %+v", r)
	}
	// restore and checkdb are written as null, not left out.
	out, _ := json.Marshal(inc.SQLVerify.Databases[0])
	if !bytes.Contains(out, []byte(`"restore":null`)) || !bytes.Contains(out, []byte(`"checkdb":null`)) {
		t.Fatalf("null steps missing: %s", out)
	}
}

func TestSelectionsReadAndWrite(t *testing.T) {
	var c SQLConfig
	if err := json.Unmarshal([]byte(`{"enabled":true,"mode":"alongside","instances":["SQLEXPRESS"],"databases":[{"name":"Sales"}],"exclude":[]}`), &c); err != nil {
		t.Fatal(err)
	}
	if c.Instances.All || !c.Instances.Includes("sqlexpress") || c.Instances.Includes("OTHER") || len(c.Databases.List) != 1 {
		t.Fatalf("%+v", c)
	}
	out, _ := json.Marshal(c)
	if !bytes.Contains(out, []byte(`"instances":["SQLEXPRESS"]`)) || !bytes.Contains(out, []byte(`"databases":[{"name":"Sales"}]`)) {
		t.Fatalf("%s", out)
	}
	// A value the agent does not understand does not break the configuration.
	var odd SQLConfig
	if err := json.Unmarshal([]byte(`{"enabled":true,"instances":"some","databases":7}`), &odd); err != nil {
		t.Fatal(err)
	}
	if odd.Instances.Invalid == "" || odd.Databases.Invalid == "" || odd.Instances.All {
		t.Fatalf("%+v", odd)
	}
}
