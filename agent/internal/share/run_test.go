package share

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "tok_abcdefghijklmnopqrstuvwxyz0123456789ABCD" // 43 characters

// fakeAPI plays the runner routes of the api (5.2).
type fakeAPI struct {
	t        *testing.T
	mu       sync.Mutex
	session  any
	cancel   atomic.Bool
	progress []ProgressReport
	items    []Item
	samples  []SampleFile
	finish   *Finish
	sessions int
}

func (f *fakeAPI) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != testRunID || pass != testToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		switch r.Method + " " + strings.TrimPrefix(r.URL.Path, APIPath) {
		case "GET /session":
			f.sessions++
			if f.session == nil {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(f.session)
		case "POST /progress":
			var p ProgressReport
			_ = json.Unmarshal(body, &p)
			f.progress = append(f.progress, p)
			_ = json.NewEncoder(w).Encode(map[string]bool{"cancel": f.cancel.Load()})
		case "POST /items":
			var b struct{ Items []Item }
			_ = json.Unmarshal(body, &b)
			if len(b.Items) > MaxItemsPerRequest {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				return
			}
			f.items = append(f.items, b.Items...)
		case "POST /samples":
			var b struct{ Files []SampleFile }
			_ = json.Unmarshal(body, &b)
			f.samples = append(f.samples, b.Files...)
		case "POST /finish":
			var fin Finish
			_ = json.Unmarshal(body, &fin)
			f.finish = &fin
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func (f *fakeAPI) itemCodes() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]int{}
	for _, it := range f.items {
		out[it.Code]++
	}
	return out
}

func startAPI(t *testing.T, session any) (*fakeAPI, *Client) {
	t.Helper()
	f := &fakeAPI{t: t, session: session}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return f, &Client{BaseURL: srv.URL, RunID: testRunID, Token: testToken}
}

type testEnv struct {
	dir, root, meta string
	sys             *fakeSys
	cfg             Config
	stderr          *bytes.Buffer
}

func newTestEnv(t *testing.T, resticBin string, magic int64, fstype string) *testEnv {
	t.Helper()
	dir := t.TempDir()
	e := &testEnv{dir: dir, root: filepath.Join(dir, "share"), meta: filepath.Join(dir, "meta"), stderr: &bytes.Buffer{}}
	mustNoErr(t, os.MkdirAll(e.root, 0o755))
	e.sys = newFakeSys(magic).mount(e.root, fstype, true)
	e.cfg = Config{Root: e.root, MetaDir: e.meta, TmpDir: filepath.Join(dir, "cache", "tmp"),
		CacheDir: filepath.Join(dir, "cache", "restic"), ResticBin: resticBin, Sys: e.sys,
		Stderr: e.stderr, ProgressInterval: time.Millisecond, Readers: 3}
	return e
}

func backupSession(repo string, b BackupParams, protocol string) map[string]any {
	return map[string]any{
		"run":        map[string]any{"id": testRunID, "kind": "backup", "shareId": "share-a", "deadline": time.Now().Add(time.Hour)},
		"expect":     map[string]any{"protocol": protocol, "readOnly": true},
		"repository": map[string]any{"url": repo, "repositoryPassword": "repo-password-SECRET-1"},
		"backup":     b,
	}
}

func restoreSession(repo string, r RestoreParams, protocol string) map[string]any {
	return map[string]any{
		"run":        map[string]any{"id": testRunID, "kind": "restore", "shareId": "share-a", "deadline": time.Now().Add(time.Hour)},
		"expect":     map[string]any{"protocol": protocol, "readOnly": false},
		"repository": map[string]any{"url": repo, "repositoryPassword": "repo-password-SECRET-1"},
		"restore":    r,
	}
}

func TestRunRefusesABadSession(t *testing.T) {
	env := newTestEnv(t, "restic", MagicCIFS, "cifs")
	_, client := startAPI(t, nil)
	if code := Run(context.Background(), env.cfg, client); code != ExitUsage {
		t.Fatalf("exit %d", code)
	}
	if strings.Contains(env.stderr.String(), testToken) {
		t.Fatal("the token reached the log")
	}
	// A session of another run.
	other := backupSession("/repo", BackupParams{}, ProtocolSMB)
	other["run"].(map[string]any)["id"] = "11111111-2222-4333-8444-555555555555"
	_, client = startAPI(t, other)
	if code := Run(context.Background(), env.cfg, client); code != ExitUsage {
		t.Fatalf("exit %d", code)
	}
}

func TestRunGuardFailureIsReported(t *testing.T) {
	env := newTestEnv(t, "restic", MagicNFS, "nfs") // an NFS mount where SMB is expected
	api, client := startAPI(t, backupSession("/repo", BackupParams{}, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitGuard {
		t.Fatalf("exit %d", code)
	}
	if api.finish == nil || api.finish.Status != StatusFailed || api.finish.Code != CodeWrongFilesystem {
		t.Fatalf("finish %+v", api.finish)
	}
}

func TestRunEmptyRootGuard(t *testing.T) {
	env := newTestEnv(t, "restic", MagicCIFS, "cifs")
	b := BackupParams{Previous: &struct {
		SnapshotID string `json:"snapshotId"`
		FileCount  int64  `json:"fileCount"`
	}{SnapshotID: "s1", FileCount: 1200}}
	api, client := startAPI(t, backupSession("/repo", b, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitGuard {
		t.Fatalf("exit %d", code)
	}
	if api.finish.Code != CodeEmptySource || !strings.Contains(api.finish.Message, "1200") {
		t.Fatalf("finish %+v", api.finish)
	}
}

// fakeResticScript stands in for restic: it reports progress until it is
// interrupted (SIGINT), like restic does.
func fakeResticScript(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "restic")
	script := `#!/bin/sh
trap 'echo interrupted >&2; exit 130' INT
i=0
while [ $i -lt 300 ]; do
  echo '{"message_type":"status","percent_done":0.1,"files_done":1,"bytes_done":10,"current_files":["/x"]}'
  sleep 0.1 &
  wait $!
  i=$((i + 1))
done
`
	mustNoErr(t, os.WriteFile(p, []byte(script), 0o755))
	return p
}

func TestRunCancelFromTheAPI(t *testing.T) {
	env := newTestEnv(t, fakeResticScript(t), MagicCIFS, "cifs")
	writeTree(t, env.root, map[string]string{"a.txt": "a"})
	api, client := startAPI(t, backupSession(filepath.Join(env.dir, "repo"), BackupParams{Samples: 20}, ProtocolSMB))
	go func() {
		time.Sleep(300 * time.Millisecond)
		api.cancel.Store(true)
	}()
	start := time.Now()
	code := Run(context.Background(), env.cfg, client)
	if code != ExitFailed || api.finish == nil || api.finish.Status != StatusCancelled {
		t.Fatalf("exit %d finish %+v", code, api.finish)
	}
	if time.Since(start) > 20*time.Second {
		t.Fatal("the cancel took too long")
	}
	if len(api.progress) == 0 || api.progress[len(api.progress)-1].Phase != PhaseFinalize {
		t.Fatalf("progress %+v", api.progress)
	}
}

// resticBin is the real restic for the end-to-end tests (RESTIC_BINARY).
func resticBin(t *testing.T) string {
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("RESTIC_BINARY is not set")
	}
	return bin
}

func resticCmd(t *testing.T, bin, repo string, args ...string) string {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Env = append(os.Environ(), "RESTIC_REPOSITORY="+repo, "RESTIC_PASSWORD=repo-password-SECRET-1",
		"RESTIC_CACHE_DIR="+filepath.Join(filepath.Dir(repo), "rcache"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("restic %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// TestEndToEndWithRestic backs a share up and restores it with the real
// restic: the designed flags, the sidecar inside the snapshot, permissions
// round trip through the fake xattr layer, keep both, a mirror copy.
func TestEndToEndWithRestic(t *testing.T) {
	bin := resticBin(t)
	env := newTestEnv(t, bin, MagicCIFS, "cifs")
	repo := filepath.Join(env.dir, "repo")
	resticCmd(t, bin, repo, "init")
	old := time.Now().Add(-48 * time.Hour)
	writeTree(t, env.root, map[string]string{
		"Finance/2026/Q3.xlsx": "quarter three",
		"Finance/Budget.docx":  "budget",
		"HR/people.csv":        "alice,bob",
		"#recycle/deleted.txt": "trash",
		"Thumbs.db":            "thumbs",
		"report[1].pdf":        "brackets",
	})
	for _, rel := range []string{"Finance/2026/Q3.xlsx", "Finance/Budget.docx", "HR/people.csv", "report[1].pdf"} {
		mustNoErr(t, os.Chtimes(filepath.Join(env.root, rel), old, old))
	}
	sd := func(rel string) string { return "SD:" + rel }
	for _, rel := range []string{"", "Finance", "Finance/2026", "Finance/2026/Q3.xlsx", "Finance/Budget.docx", "HR", "HR/people.csv", "report[1].pdf"} {
		env.sys.put(filepath.Join(env.root, filepath.FromSlash(rel)), XattrNTSDFull, []byte(sd(rel)))
	}

	// 1. The first backup.
	b := BackupParams{Excludes: SystemFilesPreset, CaseInsensitive: true, ReadConcurrency: 2, Permissions: "auto", SkipOffline: true, Samples: 20}
	api, client := startAPI(t, backupSession(repo, b, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitOK {
		t.Fatalf("backup exit %d: %+v\n%s", code, api.finish, env.stderr)
	}
	first := api.finish
	if first.Status != StatusSucceeded || first.SnapshotID == "" {
		t.Fatalf("finish %+v", first)
	}
	if first.Stats["files"].(float64) != 4 {
		t.Fatalf("files %v (the presets exclude #recycle and Thumbs.db)", first.Stats["files"])
	}
	if len(api.samples) != 4 {
		t.Fatalf("samples %+v", api.samples)
	}
	if strings.Contains(first.LogTail, "repo-password-SECRET-1") || strings.Contains(first.LogTail, testToken) {
		t.Fatal("a secret reached the log tail")
	}
	ls := resticCmd(t, bin, repo, "ls", first.SnapshotID)
	for _, want := range []string{env.root + "/Finance/2026/Q3.xlsx", env.meta + "/" + SidecarFile, env.meta + "/" + ManifestFile} {
		if !strings.Contains(ls, want) {
			t.Fatalf("the snapshot lacks %s:\n%s", want, ls)
		}
	}
	if strings.Contains(ls, "#recycle") || strings.Contains(ls, "Thumbs.db") {
		t.Fatalf("restic did not apply the presets:\n%s", ls)
	}
	tags := resticCmd(t, bin, repo, "snapshots", "--json")
	if !strings.Contains(tags, `"share=share-a"`) || !strings.Contains(tags, `"run=`+testRunID+`"`) || !strings.Contains(tags, `"hostname":"restow-share"`) {
		t.Fatalf("tags and host: %s", tags)
	}

	// 2. An incremental backup with the parent: unchanged descriptors are reused.
	b.ParentSnapshotID = first.SnapshotID
	b.Previous = &struct {
		SnapshotID string `json:"snapshotId"`
		FileCount  int64  `json:"fileCount"`
	}{first.SnapshotID, 4}
	api, client = startAPI(t, backupSession(repo, b, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitOK {
		t.Fatalf("second backup exit %d: %+v\n%s", code, api.finish, env.stderr)
	}
	perm := api.finish.Stats["permissions"].(map[string]any)
	if perm["reused"].(float64) < 4 {
		t.Fatalf("permissions %+v", perm)
	}
	second := api.finish.SnapshotID

	// 3. Restore everything into a new folder, with permissions.
	env.sys.mount(env.root, "cifs", false)
	api, client = startAPI(t, restoreSession(repo, RestoreParams{SnapshotID: second, Destination: DestNewFolder,
		RestorePermissions: true, TargetShareID: "share-a"}, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitOK {
		t.Fatalf("restore exit %d: %+v\n%s\nitems %+v", code, api.finish, env.stderr, api.items)
	}
	folder := api.finish.Restore.Folder
	if !strings.HasPrefix(folder, "Restow-Restore-") {
		t.Fatalf("folder %q", folder)
	}
	got, err := os.ReadFile(filepath.Join(env.root, folder, "Finance", "2026", "Q3.xlsx"))
	mustNoErr(t, err)
	if string(got) != "quarter three" {
		t.Fatal("content")
	}
	if _, err := os.Stat(filepath.Join(env.root, folder, ".restow")); err == nil {
		t.Fatal("the scratch folder was restored into the share")
	}
	restored := filepath.Join(env.root, folder, "Finance", "2026", "Q3.xlsx")
	if v := env.sys.value(restored, XattrNTSDFull); string(v) != sd("Finance/2026/Q3.xlsx") {
		t.Fatalf("permissions of the restored file: %q (sets %v)", v, env.sys.sets)
	}
	if api.finish.Restore.PermissionsApplied[XattrNTSDFull] < 4 {
		t.Fatalf("permissions applied %+v", api.finish.Restore)
	}

	// 4. Keep both into the original location: a local edit stays, the backup sits next to it.
	mustNoErr(t, os.WriteFile(filepath.Join(env.root, "HR", "people.csv"), []byte("alice,bob,carol"), 0o644))
	api, client = startAPI(t, restoreSession(repo, RestoreParams{SnapshotID: second, Destination: DestOriginal,
		Conflict: ConflictKeepBoth, Paths: []string{"HR"}, TargetShareID: "share-a"}, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitOK {
		t.Fatalf("keep both exit %d: %+v\n%s", code, api.finish, env.stderr)
	}
	if api.finish.Restore.Renamed != 1 {
		t.Fatalf("restore %+v", api.finish.Restore)
	}
	entries, _ := os.ReadDir(filepath.Join(env.root, "HR"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 || !strings.HasPrefix(names[0], "people (restored ") || names[1] != "people.csv" {
		t.Fatalf("HR: %v", names)
	}
	if staged, _ := filepath.Glob(filepath.Join(env.root, StagingPrefix+"*")); len(staged) != 0 {
		t.Fatalf("staging left: %v", staged)
	}

	// 5. A mirror copy into a folder: what the restore point lacks is deleted there only.
	replica := filepath.Join(env.root, "Replica")
	writeTree(t, replica, map[string]string{"stray.txt": "not in the source"})
	copyParams := RestoreParams{SnapshotID: second, Destination: DestFolder, Folder: "Replica", TargetShareID: "share-b",
		Copy: &CopyParams{JobID: "job-1", SourceShareID: "share-a", Mode: CopyMirror}}
	api, client = startAPI(t, restoreSession(repo, copyParams, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitGuard || api.finish.Code != CodeCopyUnsafeTarget {
		t.Fatalf("an unconfirmed foreign folder must be refused: %d %+v", code, api.finish)
	}
	copyParams.Copy.MirrorConfirmed = true
	api, client = startAPI(t, restoreSession(repo, copyParams, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitOK {
		t.Fatalf("mirror exit %d: %+v\n%s", code, api.finish, env.stderr)
	}
	if _, err := os.Stat(filepath.Join(replica, "stray.txt")); err == nil {
		t.Fatal("the mirror kept a file the restore point does not have")
	}
	if _, err := os.Stat(filepath.Join(replica, CopyMarkerFile)); err != nil {
		t.Fatal("no marker after the mirror")
	}
	if _, err := os.Stat(filepath.Join(env.root, "HR", "people.csv")); err != nil {
		t.Fatal("the mirror touched something outside its folder")
	}
	// The next run needs no confirmation: the marker is its own and survives --delete.
	copyParams.Copy.MirrorConfirmed = false
	api, client = startAPI(t, restoreSession(repo, copyParams, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitOK {
		t.Fatalf("second mirror exit %d: %+v", code, api.finish)
	}
	// Rule 6: a restore point with less than half the files of the last copy.
	copyParams.Copy.LastCopiedFileCount = 100
	api, client = startAPI(t, restoreSession(repo, copyParams, ProtocolSMB))
	if code := Run(context.Background(), env.cfg, client); code != ExitGuard || api.finish.Code != CodeCopyEmptySource {
		t.Fatalf("halved restore point: %d %+v", code, api.finish)
	}

	// 6. Permissions of an SMB backup are not written to an NFS share.
	nfs := newFakeSys(MagicNFS).mount(env.root, "nfs4", false)
	env.cfg.Sys = nfs
	api, client = startAPI(t, restoreSession(repo, RestoreParams{SnapshotID: second, Destination: DestNewFolder,
		RestorePermissions: true}, ProtocolNFS))
	time.Sleep(1100 * time.Millisecond) // a new folder name
	if code := Run(context.Background(), env.cfg, client); code != ExitWarnings {
		t.Fatalf("protocol mismatch exit %d: %+v", code, api.finish)
	}
	if api.itemCodes()[ItemACLNotRestored] != 1 || len(nfs.sets) != 0 {
		t.Fatalf("items %v sets %v", api.itemCodes(), nfs.sets)
	}
}
