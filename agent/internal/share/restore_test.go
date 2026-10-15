package share

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testRunID = "0f1e2d3c-4b5a-4968-8776-655443322110"

func TestPlanRestore(t *testing.T) {
	now := time.Date(2026, 10, 10, 22, 0, 3, 0, time.UTC)
	cases := []struct {
		name string
		p    RestoreParams
		want RestorePlan
		code string
	}{
		{"original overwrite", RestoreParams{SnapshotID: "s", Destination: DestOriginal, Conflict: ConflictOverwrite},
			RestorePlan{Overwrite: "if-changed"}, ""},
		{"original skip", RestoreParams{SnapshotID: "s", Destination: DestOriginal, Conflict: ConflictSkip},
			RestorePlan{Overwrite: "never"}, ""},
		{"original keep both", RestoreParams{SnapshotID: "s", Destination: DestOriginal, Conflict: ConflictKeepBoth},
			RestorePlan{Overwrite: "never", Staging: ".restow-restore-0f1e2d3c"}, ""},
		{"original without policy", RestoreParams{SnapshotID: "s", Destination: DestOriginal}, RestorePlan{}, CodeRestoreTarget},
		{"new folder", RestoreParams{SnapshotID: "s", Destination: DestNewFolder},
			RestorePlan{Folder: "Restow-Restore-20261010-220003", MustNotExist: true, Overwrite: "never"}, ""},
		{"folder default", RestoreParams{SnapshotID: "s", Destination: DestFolder},
			RestorePlan{Folder: "Restow-Restore-20261010-220003", Overwrite: "never"}, ""},
		{"folder given", RestoreParams{SnapshotID: "s", Destination: DestFolder, Folder: "/Restores/A/"},
			RestorePlan{Folder: "Restores/A", Overwrite: "never"}, ""},
		{"folder traversal", RestoreParams{SnapshotID: "s", Destination: DestFolder, Folder: "../x"}, RestorePlan{}, CodeRestoreTarget},
		{"folder reserved", RestoreParams{SnapshotID: "s", Destination: DestFolder, Folder: ".restow-restore-x"}, RestorePlan{}, CodeRestoreTarget},
		{"bad selection", RestoreParams{SnapshotID: "s", Destination: DestNewFolder, Paths: []string{"../etc"}}, RestorePlan{}, CodeRestoreTarget},
		{"no snapshot", RestoreParams{Destination: DestNewFolder}, RestorePlan{}, CodeRestoreTarget},
		{"unknown destination", RestoreParams{SnapshotID: "s", Destination: "elsewhere"}, RestorePlan{}, CodeRestoreTarget},
		{"copy overwrite into a root", RestoreParams{SnapshotID: "s", Destination: DestFolder, TargetShareID: "B",
			Copy: &CopyParams{Mode: CopyOverwrite, SourceShareID: "A"}}, RestorePlan{Overwrite: "if-changed"}, ""},
		{"copy mirror", RestoreParams{SnapshotID: "s", Destination: DestFolder, Folder: "Replica", TargetShareID: "B",
			Copy: &CopyParams{Mode: CopyMirror, SourceShareID: "A"}},
			RestorePlan{Folder: "Replica", Overwrite: "if-changed", Delete: true, Mirror: true}, ""},
		{"mirror into a root", RestoreParams{SnapshotID: "s", Destination: DestFolder, TargetShareID: "B",
			Copy: &CopyParams{Mode: CopyMirror, SourceShareID: "A"}}, RestorePlan{}, CodeCopyUnsafeTarget},
		{"copy into its source", RestoreParams{SnapshotID: "s", Destination: DestFolder, Folder: "x", TargetShareID: "A",
			Copy: &CopyParams{Mode: CopyOverwrite, SourceShareID: "A"}}, RestorePlan{}, CodeCopyUnsafeTarget},
		{"unknown copy mode", RestoreParams{SnapshotID: "s", Destination: DestFolder, Folder: "x", TargetShareID: "B",
			Copy: &CopyParams{Mode: "sync", SourceShareID: "A"}}, RestorePlan{}, CodeRestoreTarget},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := PlanRestore(c.p, testRunID, "A", now)
			if c.code != "" {
				var ge *GuardError
				if !errors.As(err, &ge) || ge.Code != c.code {
					t.Fatalf("want %s, got %v", c.code, err)
				}
				return
			}
			mustNoErr(t, err)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %+v want %+v", got, c.want)
			}
		})
	}
}

func TestRestoreArgs(t *testing.T) {
	got := RestoreArgs{Snapshot: "abc", SnapshotRoot: "/share", Target: "/share/Restow-Restore-1",
		Includes: []string{"Finance/Q[3].xlsx", "/HR/"}, Overwrite: "never", Verify: true}.Args()
	want := []string{"restore", "abc:/share", "--target", "/share/Restow-Restore-1",
		"--include", `/Finance/Q\[3].xlsx`, "--include", "/HR",
		"--no-lock", "--overwrite", "never", "--exclude-xattr", "system.*", "--exclude-xattr", "security.*",
		"--verify", "--json", "-vv"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args %q", got)
	}
	mirror := RestoreArgs{Snapshot: "abc", SnapshotRoot: "/share", Target: "/share/Replica", Overwrite: "if-changed",
		Delete: true, Excludes: []string{"/" + CopyMarkerFile}}.Args()
	joined := strings.Join(mirror, " ")
	if !strings.Contains(joined, "--delete --exclude /.restow-copy.json") || strings.Contains(joined, "--verify") {
		t.Fatalf("mirror args %q", mirror)
	}
}

func TestReconcileKeepBoth(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "share")
	staging := filepath.Join(dest, ".restow-restore-0f1e2d3c")
	writeTree(t, dest, map[string]string{
		"same.txt":         "same",
		"changed.txt":      "local edit",
		"Docs/keep.docx":   "local",
		"Docs/changed.pdf": "local",
		"conflict":         "a file where the backup has a folder",
	})
	writeTree(t, staging, map[string]string{
		"same.txt":         "same",
		"changed.txt":      "backup",
		"new.txt":          "new",
		"Docs/changed.pdf": "backup!",
		"Docs/new/inner":   "deep",
		"Gone/x.txt":       "x",
		"conflict/in":      "folder content",
	})
	mtime := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	mustNoErr(t, os.Chtimes(filepath.Join(dest, "same.txt"), mtime, mtime))
	mustNoErr(t, os.Chtimes(filepath.Join(staging, "same.txt"), mtime, mtime))
	// A previous restored copy exists already: the next name gets " 2".
	writeTree(t, dest, map[string]string{"changed (restored 2026-10-10 2200).txt": "older restore"})

	var failures []string
	placed, st := Reconcile(staging, dest, "2026-10-10 2200", func(rel string, err error) {
		failures = append(failures, rel+": "+err.Error())
	})
	if len(failures) != 0 {
		t.Fatalf("failures %v", failures)
	}
	if st.Identical != 1 || st.Renamed != 3 || st.Placed != 3 {
		t.Fatalf("stats %+v", st)
	}
	read := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(rel)))
		mustNoErr(t, err)
		return string(b)
	}
	if read("changed.txt") != "local edit" || read("changed (restored 2026-10-10 2200 2).txt") != "backup" {
		t.Fatal("changed.txt: the original must stay, the backup must sit next to it")
	}
	if read("Docs/changed (restored 2026-10-10 2200).pdf") != "backup!" || read("Docs/keep.docx") != "local" {
		t.Fatal("Docs")
	}
	if read("new.txt") != "new" || read("Docs/new/inner") != "deep" || read("Gone/x.txt") != "x" {
		t.Fatal("missing files were not placed")
	}
	if read("conflict") != "a file where the backup has a folder" || read("conflict (restored 2026-10-10 2200)/in") != "folder content" {
		t.Fatal("type conflict")
	}
	if _, err := os.Stat(staging); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the staging folder was not removed")
	}
	if placed["changed.txt"] != "changed (restored 2026-10-10 2200 2).txt" || placed["Docs/new"] != "Docs/new" {
		t.Fatalf("placed %v", placed)
	}
	if got, ok := placedTarget(placed, "Docs/new/inner"); !ok || got != "Docs/new/inner" {
		t.Fatal("a file below a placed folder")
	}
	if _, ok := placedTarget(placed, "same.txt"); ok {
		t.Fatal("an identical file is not placed")
	}
}

func TestRemoveStaleStaging(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{".restow-restore-aaaa1111/x": "x", ".restow-restore-own/y": "y", "keep/z": "z"})
	removed := RemoveStaleStaging(root, ".restow-restore-own")
	if !reflect.DeepEqual(removed, []string{".restow-restore-aaaa1111"}) {
		t.Fatalf("removed %v", removed)
	}
	if _, err := os.Stat(filepath.Join(root, ".restow-restore-own/y")); err != nil {
		t.Fatal("the own staging folder was removed")
	}
}

func TestMirrorRules(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Replica")
	var ge *GuardError
	// Missing or empty: fine.
	mustNoErr(t, CheckMirrorTarget(dir, "job-1", false))
	mustNoErr(t, os.MkdirAll(dir, 0o755))
	mustNoErr(t, CheckMirrorTarget(dir, "job-1", false))
	// Not empty, no marker: refused unless confirmed.
	writeTree(t, dir, map[string]string{"foreign.txt": "x"})
	if err := CheckMirrorTarget(dir, "job-1", false); !errors.As(err, &ge) || ge.Code != CodeCopyUnsafeTarget {
		t.Fatalf("foreign folder: %v", err)
	}
	mustNoErr(t, CheckMirrorTarget(dir, "job-1", true))
	// The own marker: fine; another job's: refused unless confirmed.
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	mustNoErr(t, WriteCopyMarker(dir, CopyMarker{JobID: "job-1", SourceShareID: "A"}, now))
	mustNoErr(t, CheckMirrorTarget(dir, "job-1", false))
	if err := CheckMirrorTarget(dir, "job-2", false); !errors.As(err, &ge) || ge.Code != CodeCopyUnsafeTarget {
		t.Fatalf("other job: %v", err)
	}
	mustNoErr(t, CheckMirrorTarget(dir, "job-2", true))
	// A rewrite keeps the creation time.
	mustNoErr(t, WriteCopyMarker(dir, CopyMarker{JobID: "job-1", SourceShareID: "A"}, now.Add(time.Hour)))
	var m CopyMarker
	b, _ := os.ReadFile(filepath.Join(dir, CopyMarkerFile))
	mustNoErr(t, json.Unmarshal(b, &m))
	if m.Format != CopyMarkerFormat || m.V != 1 || m.CreatedAt != "2026-10-10T00:00:00Z" {
		t.Fatalf("marker %+v", m)
	}

	// Rules 5 and 6.
	if err := CheckMirrorCount(0, 0, true); !errors.As(err, &ge) || ge.Code != CodeCopyEmptySource {
		t.Fatal("an empty restore point must never be mirrored, not even forced")
	}
	if err := CheckMirrorCount(40, 100, false); !errors.As(err, &ge) || ge.Code != CodeCopyEmptySource {
		t.Fatal("a halved restore point")
	}
	mustNoErr(t, CheckMirrorCount(40, 100, true))
	mustNoErr(t, CheckMirrorCount(60, 100, false))
	mustNoErr(t, CheckMirrorCount(1, 0, false))
}

func TestClassifyRestoreItem(t *testing.T) {
	if classifyRestoreItem(ProtocolSMB, "lchown /share/x: operation not permitted") != "" {
		t.Fatal("chown on SMB is expected and dropped")
	}
	if classifyRestoreItem(ProtocolNFS, "lchown /share/x: operation not permitted") != ItemOwnerNotRestore {
		t.Fatal("chown on NFS is owner_not_restored")
	}
	if classifyRestoreItem(ProtocolSMB, "open /share/a:b: invalid argument") != ItemNameInvalid {
		t.Fatal("invalid name")
	}
	if classifyRestoreItem(ProtocolSMB, "write: no space left on device") != ItemWriteError {
		t.Fatal("write error")
	}
	if !selected(nil, "x") || !selected([]string{"A/"}, "A/b") || selected([]string{"A"}, "AB") {
		t.Fatal("selected")
	}
}
