package restic

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestCommandCollectsItemsAndMapsExitCodes(t *testing.T) {
	r, argsFile, envFile := fakeRestic(t)
	mode(r, "backup-partial")
	var lines []string
	res, err := r.Command(context.Background(), CommandOptions{Name: "backup", Args: []string{"backup", "--json", "/share"},
		OnStdoutLine: func(l []byte) { lines = append(lines, string(l)) }})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != ExitIncomplete || res.Err() != nil || res.ItemCount != 1 || res.Items[0].Path != "/data/secret" {
		t.Fatalf("result %+v", res)
	}
	if len(lines) != 1 {
		t.Fatalf("stdout lines %q", lines)
	}
	if s, ok := ParseBackupSummary([]byte(lines[0])); !ok || s.SnapshotID == "" {
		t.Fatal("summary")
	}
	if got := readFile(t, argsFile); got != "backup\n--json\n/share\n" {
		t.Fatalf("args %q", got)
	}
	env := readFile(t, envFile)
	if !strings.Contains(env, "RESTIC_PASSWORD=repo-password-SECRET-0001") {
		t.Fatal("the password travels in the environment")
	}

	mode(r, "locked")
	res, err = r.Command(context.Background(), CommandOptions{Name: "backup", Args: []string{"backup"}})
	if err != nil {
		t.Fatal(err)
	}
	if e := res.Err(); e == nil || e.ExitCode != ExitRepoLocked || e.Command != "backup" {
		t.Fatalf("locked: %+v", e)
	}
	if _, err := r.Command(context.Background(), CommandOptions{}); err == nil {
		t.Fatal("no arguments accepted")
	}
}

func TestCommandRawStdout(t *testing.T) {
	r, _, _ := fakeRestic(t)
	mode(r, "version")
	var buf bytes.Buffer
	res, err := r.Command(context.Background(), CommandOptions{Name: "dump", Args: []string{"dump"}, Stdout: &buf})
	if err != nil || res.ExitCode != 0 {
		t.Fatal(err)
	}
	if !strings.HasPrefix(buf.String(), "restic 0.19.1") {
		t.Fatalf("raw stdout %q", buf.String())
	}
}

func TestParsers(t *testing.T) {
	p, ok := ParseBackupStatus([]byte(`{"message_type":"status","files_done":3,"bytes_done":9,"current_files":["/a"]}`))
	if !ok || p.FilesDone != 3 || p.CurrentPath != "/a" {
		t.Fatal("backup status")
	}
	rp, ok := ParseRestoreStatus([]byte(`{"message_type":"status","files_restored":2,"total_files":4}`))
	if !ok || rp.FilesDone != 2 || rp.TotalFiles != 4 {
		t.Fatal("restore status")
	}
	if _, ok := ParseRestoreSummary([]byte(`{"message_type":"summary","files_restored":1}`)); !ok {
		t.Fatal("restore summary")
	}
	if _, ok := ParseBackupStatus([]byte(`{"message_type":"summary"}`)); ok {
		t.Fatal("a summary is no status")
	}
	if MessageType([]byte(`noise`)) != "" {
		t.Fatal("noise")
	}
	if l, ok := ExcludeFileLine(" a$b "); !ok || l != "a$$b" {
		t.Fatal("exclude line")
	}
}
