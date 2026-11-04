package core

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

type fakeInfo struct {
	name string
	mode fs.FileMode
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return nil }

// fakeSources is a file system of configured sources: a folder, an error,
// or a reparse point (irregular, as Go reports a junction or mount point).
type fakeSources struct {
	entries map[string]any // fs.FileMode, error or reparsePoint
	evalErr map[string]error
}

func (f fakeSources) fs() sourceFS {
	return sourceFS{
		lstat: func(p string) (fs.FileInfo, error) {
			switch e := f.entries[p].(type) {
			case nil:
				return nil, &fs.PathError{Op: "lstat", Path: p, Err: fs.ErrNotExist}
			case error:
				return nil, &fs.PathError{Op: "lstat", Path: p, Err: e}
			case reparsePoint:
				return fakeInfo{name: filepath.Base(p), mode: fs.ModeIrregular}, nil
			default:
				return fakeInfo{name: filepath.Base(p), mode: e.(fs.FileMode)}, nil
			}
		},
		evalSymlinks: func(p string) (string, error) {
			if err := f.evalErr[p]; err != nil {
				return "", &fs.PathError{Op: "lstat", Path: p, Err: err}
			}
			return p, nil
		},
		reparse: func(p string, _ fs.FileInfo) (reparsePoint, error) {
			rp, _ := f.entries[p].(reparsePoint)
			return rp, nil
		},
	}
}

func TestSplitSourcesTellsUnreadableFromMissing(t *testing.T) {
	root := t.TempDir()
	at := func(n string) string { return filepath.Join(root, n) }
	notReady := errors.New("The device is not ready.")
	locked := errors.New("This drive is locked by BitLocker Drive Encryption. You must unlock this drive from Control Panel.")
	f := fakeSources{entries: map[string]any{
		at("data"):       fs.ModeDir,
		at("offline"):    notReady,
		at("bitlocker"):  locked,
		at("denied"):     fs.ErrPermission,
		at("evalfails"):  fs.ModeDir,
		at("evalgone"):   fs.ModeDir,
		at("plain.file"): fs.FileMode(0),
	}, evalErr: map[string]error{at("evalfails"): fs.ErrPermission, at("evalgone"): fs.ErrNotExist}}
	sp := splitSourcesWith(f.fs(), []string{at("data"), at("gone"), at("offline"), at("bitlocker"), at("denied"), at("evalfails"), at("evalgone"), at("plain.file")})
	if strings.Join(sp.existing, "|") != at("data")+"|"+at("plain.file") {
		t.Fatalf("existing %q", sp.existing)
	}
	if strings.Join(sp.missing, "|") != at("gone")+"|"+at("evalgone") {
		t.Fatalf("only what does not exist is missing: %q", sp.missing)
	}
	want := map[string]string{at("offline"): "not ready", at("bitlocker"): "BitLocker", at("denied"): "permission denied", at("evalfails"): "permission denied"}
	if len(sp.problems) != len(want) {
		t.Fatalf("problems %+v", sp.problems)
	}
	for _, e := range sp.problems {
		if e.Code != "source_unreadable" || !strings.Contains(e.Message, want[e.Path]) || !strings.Contains(e.Message, "was not backed up") {
			t.Errorf("%+v", e)
		}
		if strings.Contains(e.Message, "lstat ") {
			t.Errorf("the path is named twice: %s", e.Message)
		}
	}
}

func TestSplitSourcesFollowsJunctionsAndMountedVolumes(t *testing.T) {
	root := t.TempDir()
	at := func(n string) string { return filepath.Join(root, n) }
	f := fakeSources{entries: map[string]any{
		at("Documents"): reparsePoint{kind: reparseJunction, target: at("real-docs")},
		at("real-docs"): fs.ModeDir,
		at("twice"):     reparsePoint{kind: reparseJunction, target: at("Documents")},
		at("SQLData"):   reparsePoint{kind: reparseVolume, target: at("E")},
		at("E"):         fs.ModeDir,
		at("NoLetter"):  reparsePoint{kind: reparseVolume},
		at("AppLink"):   reparsePoint{kind: reparseOther, tag: 0xA000001D},
		at("Dangling"):  reparsePoint{kind: reparseJunction, target: at("nowhere")},
		at("Loop"):      reparsePoint{kind: reparseJunction, target: at("Loop")},
	}}
	sp := splitSourcesWith(f.fs(), []string{at("Documents"), at("twice"), at("SQLData"), at("NoLetter"), at("AppLink"), at("Dangling"), at("Loop")})
	if strings.Join(sp.existing, "|") != at("real-docs")+"|"+at("E") {
		t.Fatalf("existing %q (the same folder twice is backed up once)", sp.existing)
	}
	notes := map[string]sourceNote{}
	for _, n := range sp.resolved {
		notes[n.Configured] = n
	}
	if n := notes[at("Documents")]; n.Kind != "junction" || n.Resolved != at("real-docs") {
		t.Errorf("junction: %+v", n)
	}
	if n := notes[at("twice")]; n.Kind != "junction" || n.Resolved != at("real-docs") {
		t.Errorf("junction to a junction: %+v", n)
	}
	if n := notes[at("SQLData")]; n.Kind != "mounted volume" || n.Resolved != at("E") {
		t.Errorf("mounted volume: %+v", n)
	}
	if strings.Join(sp.missing, "|") != at("Dangling") {
		t.Errorf("missing %q", sp.missing)
	}
	got := map[string]string{}
	for _, e := range sp.problems {
		got[e.Path] = e.Code
	}
	if got[at("NoLetter")] != "source_is_mount_point" || got[at("AppLink")] != "source_unreadable" || got[at("Loop")] != "source_unreadable" || len(got) != 3 {
		t.Fatalf("problems %+v", sp.problems)
	}
	for _, e := range sp.problems {
		if e.Path == at("NoLetter") && !strings.Contains(e.Message, "drive letter") {
			t.Errorf("%s", e.Message)
		}
	}
}

func TestClassifyReparse(t *testing.T) {
	vols := func(v string) ([]string, error) {
		switch v {
		case `\\?\Volume{e1}\`:
			return []string{`C:\SQLData\`, `e:\`}, nil
		case `\\?\Volume{f2}\`:
			return []string{`C:\Mounted\`}, nil
		}
		return nil, errors.New("not found")
	}
	cases := []struct {
		tag  uint32
		sub  string
		want reparsePoint
		err  bool
	}{
		{winapi.ReparseTagMountPoint, `\??\D:\Daten\Dokumente`, reparsePoint{kind: reparseJunction, target: `D:\Daten\Dokumente`}, false},
		{winapi.ReparseTagMountPoint, `\??\d:\Daten\`, reparsePoint{kind: reparseJunction, target: `D:\Daten`}, false},
		{winapi.ReparseTagMountPoint, `\??\D:\`, reparsePoint{kind: reparseJunction, target: `D:\`}, false},
		{winapi.ReparseTagMountPoint, `\??\Volume{e1}\`, reparsePoint{kind: reparseVolume, target: `E:\`}, false},
		{winapi.ReparseTagMountPoint, `\??\Volume{f2}\`, reparsePoint{kind: reparseVolume}, false},
		{winapi.ReparseTagMountPoint, `\??\Volume{00}\`, reparsePoint{}, true},
		{winapi.ReparseTagMountPoint, `\??\UNC\nas\share`, reparsePoint{kind: reparseOther, tag: winapi.ReparseTagMountPoint}, false},
		{0x8000001B, "", reparsePoint{kind: reparseNone}, false},                   // IO_REPARSE_TAG_APPEXECLINK, no name surrogate
		{0xA000001D, "", reparsePoint{kind: reparseOther, tag: 0xA000001D}, false}, // IO_REPARSE_TAG_LX_SYMLINK
		{0x80000013, "", reparsePoint{kind: reparseNone}, false},                   // deduplication
		{0x9000001A, "", reparsePoint{kind: reparseNone}, false},                   // cloud files (OneDrive)
	}
	for _, tc := range cases {
		got, err := classifyReparse(tc.tag, tc.sub, vols)
		if (err != nil) != tc.err || got != tc.want {
			t.Errorf("%#x %q: %+v %v, want %+v", tc.tag, tc.sub, got, err, tc.want)
		}
	}
}

func TestSourcesWithFiles(t *testing.T) {
	root := t.TempDir()
	withFile := filepath.Join(root, "with")
	onlyDirs := filepath.Join(root, "dirs")
	_ = os.MkdirAll(filepath.Join(onlyDirs, "sub"), 0o755)
	_ = os.MkdirAll(withFile, 0o755)
	_ = os.WriteFile(filepath.Join(withFile, "a.txt"), []byte("x"), 0o644)
	single := filepath.Join(root, "single.txt")
	_ = os.WriteFile(single, []byte("x"), 0o644)
	errs := sourcesWithFiles([]string{withFile, onlyDirs, single, filepath.Join(root, "gone")})
	if len(errs) != 2 || errs[0].Path != withFile || errs[1].Path != single || errs[0].Code != "source_unreadable" {
		t.Fatalf("%+v", errs)
	}
}
