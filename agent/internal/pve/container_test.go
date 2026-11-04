//go:build !windows

package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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
	body := "#!/bin/sh\necho \"$@\" > " + filepath.Join(base, "args") + "\npwd > " + filepath.Join(base, "pwd") + "\ncat <<'OUT'\n" + stdout + "\nOUT\ncat >&2 <<'ERR'\n" + stderr + "\nERR\nexit " + string(rune('0'+code)) + "\n"
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
	// The snapshot mount of these tests (containerBackupRoot).
	old := vzsnapDir
	vzsnapDir = root
	t.Cleanup(func() { vzsnapDir = old })
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

// In suspend and stop mode PVE passes "." only, with every backup=1 mount point copied or
// mounted below it: their lost+found (host root, 0700) must be left out as well, or every backup
// of an unprivileged container with an ext4 mount point ends incomplete.
func TestContainerBackupLeavesOutLostAndFoundOfMountPointsInSuspendMode(t *testing.T) {
	p, req, _, _ := fakeContainerBackup(t, ctSummary, "", 0)
	req.Info.Sources = []string{"."}
	req.GuestConfig = "arch: amd64\nrootfs: local-lvm:vm-105-disk-0,size=8G\n" +
		"mp0: local-lvm:vm-105-disk-1,mp=/srv/data,backup=1,size=32G\n" +
		"mp1: /mnt/host/media,mp=/srv/media\n" +
		"mp2: local-lvm:vm-105-disk-2,mp=/srv/scratch,size=4G\n" +
		"mp3: volume=local:105/vm-105-disk-3.raw,mp=/var/lib/db/,backup=1\n" +
		"[snap1]\nmp4: local-lvm:vm-105-disk-4,mp=/old,backup=1\n"
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(req.Info.Directory), "args"))
	dir := req.Info.Directory
	for _, want := range []string{
		"--exclude " + filepath.Join(dir, "lost+found"),
		"--exclude " + filepath.Join(dir, "srv/data/lost+found"),
		"--exclude " + filepath.Join(dir, "var/lib/db/lost+found"),
	} {
		if !strings.Contains(string(args), want) {
			t.Errorf("restic arguments %q lack %q", args, want)
		}
	}
	// A bind mount and a volume without backup=1 are not in the backup, nor is a snapshot's.
	for _, not := range []string{"srv/media", "srv/scratch", "/old/"} {
		if strings.Contains(string(args), not) {
			t.Errorf("restic arguments %q name %q", args, not)
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(string(args)), "-- .") {
		t.Errorf("restic arguments %q: the sources must stay \".\"", args)
	}
}

func TestBackupMountPointsMirrorsTheServer(t *testing.T) {
	conf := "rootfs: local-zfs:subvol-300-disk-0,size=8G\n" +
		"mp1: local-zfs:subvol-300-disk-2,mp=/srv/media,backup=1\n" +
		"mp0: local-zfs:subvol-300-disk-1,mp=/mnt/data,backup=1\n" +
		"mp2: /dev/sdb1,mp=/mnt/dev,backup=1\n" +
		"mp3: local-zfs:subvol-300-disk-3,mp=/mnt/data,backup=1\n"
	got := backupMountPoints(conf)
	if strings.Join(got, " ") != "/mnt/data /srv/media" {
		t.Fatalf("backupMountPoints = %q", got)
	}
	if got := backupMountPoints(""); len(got) != 0 {
		t.Fatalf("no configuration: %q", got)
	}
	// Snapshot mode: the per-source rule and the mount point name the same folder once.
	args := strings.Join(containerBackupArgs("/mnt/vzsnap0", []string{".", "./mnt/data"}, []string{"/mnt/data"},
		nil, 300, "r", "/c", 0, false), " ")
	if strings.Count(args, "/mnt/vzsnap0/mnt/data/lost+found") != 1 {
		t.Fatalf("args %q", args)
	}
}

func TestContainerBackupWaitsForTheServersLock(t *testing.T) {
	p, req, _, _ := fakeContainerBackup(t, ctSummary, "", 0)
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(req.Info.Directory), "args"))
	fields := strings.Fields(string(args))
	at := -1
	for i, f := range fields {
		if f == "--retry-lock" {
			at = i
		}
		if f == "--" {
			break
		}
	}
	if at < 0 || at+1 >= len(fields) || fields[at+1] != "15m" {
		t.Fatalf("restic arguments %q lack --retry-lock 15m before the sources", args)
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

func TestContainerBackupRootIsStableForCopies(t *testing.T) {
	l := Layout{RunDir: "/run/restow-pve"}
	if root, copied := containerBackupRoot(l, "/mnt/vzsnap0/", 105); copied || root != "/mnt/vzsnap0/" {
		t.Fatalf("snapshot mount: %q %v", root, copied)
	}
	for _, dir := range []string{"/var/tmp/vzdumptmp1234_105", "/var/tmp/vzdumptmp98765_105", "/srv/tmp/vzdumptmp5_105"} {
		if root, copied := containerBackupRoot(l, dir, 105); !copied || root != "/run/restow-pve/ctroot-105" {
			t.Fatalf("%s: %q %v", dir, root, copied)
		}
	}
	snap := strings.Join(containerBackupArgs("/mnt/vzsnap0", []string{"."}, nil, nil, 105, "r", "/c", 0, false), " ")
	if strings.Contains(snap, "--ignore-inode") || strings.Contains(snap, "--ignore-ctime") {
		t.Fatalf("snapshot mode compares inodes and ctimes: %q", snap)
	}
	cp := containerBackupArgs("/run/restow-pve/ctroot-105", []string{"."}, nil, nil, 105, "r", "/c", 0, true)
	at := map[string]int{}
	for i, a := range cp {
		at[a] = i
	}
	if _, ok := at["--ignore-inode"]; !ok || at["--ignore-ctime"] == 0 || at["--ignore-ctime"] > at["--"] {
		t.Fatalf("a copy is compared by size and mtime: %q", cp)
	}
}

// Two suspend-mode backups get their copy in different folders; restic runs in the same
// folder both times, so it finds the first as the parent of the second.
func TestContainerBackupOfACopyRunsInTheSameFolderEveryTime(t *testing.T) {
	var bound []string
	old := bindStableRoot
	bindStableRoot = func(dir, target string) error {
		bound = append(bound, dir+" -> "+target)
		return nil
	}
	t.Cleanup(func() { bindStableRoot = old })
	var pwds []string
	for _, run := range []string{"vzdumptmp1111_200", "vzdumptmp2222_200"} {
		p, req, _, runDir := fakeContainerBackup(t, ctSummary, "", 0)
		base := filepath.Dir(runDir)
		req.Info.Directory = filepath.Join(base, run)
		req.Info.Sources = []string{"."}
		req.ExcludePatterns = []string{"/tmp/*"}
		if err := os.MkdirAll(req.Info.Directory, 0o700); err != nil {
			t.Fatal(err)
		}
		// What backup_container_prepare creates (the tests' RunDir differs per run).
		stable := p.Layout.ctStableRoot(200)
		if err := os.MkdirAll(stable, 0o711); err != nil {
			t.Fatal(err)
		}
		if _, err := p.backupContainer(context.Background(), req); err != nil {
			t.Fatal(err)
		}
		pwd, _ := os.ReadFile(filepath.Join(base, "pwd"))
		if strings.TrimSpace(string(pwd)) != stable {
			t.Fatalf("restic ran in %q, not in the stable folder %q", pwd, stable)
		}
		pwds = append(pwds, strings.TrimPrefix(strings.TrimSpace(string(pwd)), base))
		args, _ := os.ReadFile(filepath.Join(base, "args"))
		for _, want := range []string{"--ignore-inode", "--ignore-ctime", "--exclude " + filepath.Join(stable, "tmp/*"),
			"--exclude " + filepath.Join(stable, "lost+found")} {
			if !strings.Contains(string(args), want) {
				t.Errorf("restic arguments %q lack %q", args, want)
			}
		}
		var res ctResult
		if err := readJSON(filepath.Join(runDir, "result.json"), &res); err != nil {
			t.Fatal(err)
		}
		if res.Root != stable {
			t.Fatalf("the restore point records root %q, restic's path is %q", res.Root, stable)
		}
	}
	if pwds[0] != pwds[1] || len(bound) != 2 || !strings.Contains(bound[0], "vzdumptmp1111_200 -> ") {
		t.Fatalf("paths %q, bind mounts %q", pwds, bound)
	}
}

func TestContainerBackupOfACopyFallsBackWithoutAMountNamespace(t *testing.T) {
	old := bindStableRoot
	bindStableRoot = func(dir, target string) error { return errors.New("operation not permitted") }
	t.Cleanup(func() { bindStableRoot = old })
	p, req, log, runDir := fakeContainerBackup(t, ctSummary, "", 0)
	base := filepath.Dir(runDir)
	req.Info.Directory = filepath.Join(base, "vzdumptmp3_200")
	if err := os.MkdirAll(req.Info.Directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	pwd, _ := os.ReadFile(filepath.Join(base, "pwd"))
	if strings.TrimSpace(string(pwd)) != req.Info.Directory {
		t.Fatalf("restic ran in %q", pwd)
	}
	if !strings.Contains(log.String(), "info: backing up "+req.Info.Directory+" directly (operation not permitted)") {
		t.Fatalf("log %q", log.String())
	}
}

// The real mount namespace, where this test may make one (root, or a user namespace).
func TestBindPrivateShowsTheCopyToResticOnly(t *testing.T) {
	src, target := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "marker"), []byte("copy"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := &Provider{Log: &bytes.Buffer{}}
	var out bytes.Buffer
	root, err := p.startContainerRestic(src, target, true, func(root string) error {
		cmd := exec.Command("cat", "marker")
		cmd.Dir = root
		cmd.Stdout = &out
		return cmd.Run()
	})
	if root != target {
		t.Skipf("no mount namespace here: %s", p.Log.(*bytes.Buffer).String())
	}
	if err != nil || out.String() != "copy" {
		t.Fatalf("restic saw %q in the stable folder: %v", out.String(), err)
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("the mount leaked into the process's own namespace: %v", entries)
	}
}
