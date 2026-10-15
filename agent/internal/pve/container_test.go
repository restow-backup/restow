package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeContainerBackup prepares what backup_container_prepare leaves behind and
// a fake restic that prints the given stdout and stderr and exits with code.
func fakeContainerBackup(t *testing.T, stdout, stderr string, code int) (*Provider, ProviderRequest, *bytes.Buffer, string) {
	t.Helper()
	base := t.TempDir()
	runDir := filepath.Join(base, "run-1")
	if err := os.MkdirAll(filepath.Join(runDir, "cache"), 0o700); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(base, "restic")
	body := "#!/bin/sh\necho \"$@\" > " + filepath.Join(base, "args") + "\ncat <<'OUT'\n" + stdout + "\nOUT\ncat >&2 <<'ERR'\n" + stderr + "\nERR\nexit " + string(rune('0'+code)) + "\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	creds, _ := json.Marshal(ctCredentials{RunID: "run-1", VMID: 200, Restic: script})
	if err := os.WriteFile(filepath.Join(runDir, "credentials.json"), creds, 0o600); err != nil {
		t.Fatal(err)
	}
	p := &Provider{Layout: Layout{RunDir: base}}
	pointer, _ := json.Marshal(map[string]string{"runDir": runDir})
	if err := os.WriteFile(p.ctPointer("restow", 200), pointer, 0o600); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	p.Log = &log
	root := filepath.Join(base, "vzsnap0")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	req := ProviderRequest{StoreID: "restow", VMID: 200, Info: ProviderInfo{Directory: root, Sources: []string{".", "./mnt/data"}}}
	return p, req, &log, runDir
}

const ctSummary = `{"message_type":"summary","snapshot_id":"` + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `","data_added":2097152,"data_added_packed":1048576,"total_bytes_processed":4194304,"files_new":3,"files_changed":2,"total_files_processed":40}`

func TestContainerBackupLeavesOutLostAndFoundOfEveryFileSystem(t *testing.T) {
	p, req, _, _ := fakeContainerBackup(t, ctSummary, "", 0)
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(req.Info.Directory), "args"))
	for _, want := range []string{
		"--exclude " + filepath.Join(req.Info.Directory, "lost+found"),
		"--exclude " + filepath.Join(req.Info.Directory, "mnt/data", "lost+found"),
	} {
		if !strings.Contains(string(args), want) {
			t.Errorf("restic arguments %q lack %q", args, want)
		}
	}
}

func TestContainerBackupKeepsAnIncompleteSnapshotAndSaysWhatIsMissing(t *testing.T) {
	stderr := `{"message_type":"error","error":{"message":"openfile for readdirnames failed: open secret: permission denied"},"during":"archival","item":"secret"}
{"message_type":"exit_error","code":3,"message":"Warning: at least one source file could not be read"}`
	p, req, log, runDir := fakeContainerBackup(t, ctSummary, stderr, 3)
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatalf("exit 3 with a snapshot must not fail the backup: %v", err)
	}
	var res ctResult
	if err := readJSON(filepath.Join(runDir, "result.json"), &res); err != nil {
		t.Fatal(err)
	}
	if res.SnapshotID == "" || res.Unreadable != 1 || !strings.Contains(res.Remark, "secret") {
		t.Fatalf("result %+v", res)
	}
	if !strings.Contains(log.String(), "warn: could not read secret") {
		t.Fatalf("task log %q does not name the unreadable item", log.String())
	}
}

func TestContainerBackupFailsOnOtherErrorsAndOnExit3WithoutSnapshot(t *testing.T) {
	p, req, _, _ := fakeContainerBackup(t, "", `{"message_type":"exit_error","code":1,"message":"Fatal: repository locked"}`, 1)
	if _, err := p.backupContainer(context.Background(), req); err == nil || !strings.Contains(err.Error(), "restic backup failed") {
		t.Fatalf("exit 1: %v", err)
	}
	p, req, _, _ = fakeContainerBackup(t, "", `{"message_type":"exit_error","code":3,"message":"Warning"}`, 3)
	if _, err := p.backupContainer(context.Background(), req); err == nil {
		t.Fatal("exit 3 without a snapshot must fail")
	}
}
