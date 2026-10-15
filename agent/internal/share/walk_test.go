package share

import (
	"bytes"
	"context"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if strings.HasSuffix(rel, "/") {
			mustNoErr(t, os.MkdirAll(p, 0o755))
			continue
		}
		mustNoErr(t, os.MkdirAll(filepath.Dir(p), 0o755))
		mustNoErr(t, os.WriteFile(p, []byte(content), 0o644))
	}
}

type itemSink struct {
	mu    sync.Mutex
	items []Item
}

func (s *itemSink) add(it Item) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append(s.items, it)
}

func (s *itemSink) codes() map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]int{}
	for _, it := range s.items {
		out[it.Code]++
	}
	return out
}

func readAllSidecar(t *testing.T, data []byte) ([]SidecarEntry, []SidecarError, SidecarResult) {
	t.Helper()
	var entries []SidecarEntry
	var errs []SidecarError
	res, err := ReadSidecar(bytes.NewReader(data), func(r SidecarRecord) error {
		if r.Entry != nil {
			entries = append(entries, *r.Entry)
		} else {
			errs = append(errs, *r.Error)
		}
		return nil
	})
	mustNoErr(t, err)
	return entries, errs, res
}

func TestWalkCapturesTopDownWithExcludesAndErrors(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"Finance/2026/Q3.xlsx": "q3",
		"Finance/~$Q3.xlsx":    "lock",
		"HR/locked/secret":     "s",
		"Thumbs.db":            "t",
		"$RECYCLE.BIN/x":       "x",
		"big.iso":              "0123456789",
		"Tiered/offline.pst":   "pst",
	})
	sys := newFakeSys(MagicCIFS)
	for _, rel := range []string{"", "Finance", "Finance/2026", "Finance/2026/Q3.xlsx", "HR", "HR/locked/secret", "big.iso", "Tiered", "Tiered/offline.pst"} {
		sys.put(filepath.Join(root, rel), XattrNTSD, []byte("sd-"+strings.Split(rel, "/")[0]))
	}
	sys.getErr[filepath.Join(root, "HR/locked")+"|"+XattrNTSD] = eacces
	sys.put(filepath.Join(root, "Tiered/offline.pst"), XattrDOSAttrib, []byte{0x20, 0x10, 0, 0})

	var buf bytes.Buffer
	sc, err := NewSidecarWriter(&buf, SidecarHeader{Protocol: ProtocolSMB, Xattr: XattrNTSD})
	mustNoErr(t, err)
	sink := &itemSink{}
	res, err := Walk(context.Background(), WalkOptions{
		Root: root, Excludes: NewMatcher(SystemFilesPreset, true),
		Capture: &Capturer{X: sys, Protocol: ProtocolSMB, Xattr: XattrNTSD}, Sidecar: sc,
		SkipOffline: true, Readers: 4, SampleBefore: time.Now().Add(time.Hour), SamplePool: 10,
		Rand: rand.New(rand.NewPCG(1, 2)), OnItem: sink.add,
	})
	mustNoErr(t, err)
	mustNoErr(t, sc.Close())

	// Q3.xlsx, secret, big.iso; offline.pst skipped; Thumbs.db, ~$*, $RECYCLE.BIN excluded.
	if res.Files != 3 || res.Bytes != 2+1+10 || res.OfflineCount != 1 || res.Offline[0] != "Tiered/offline.pst" {
		t.Fatalf("result %+v", res)
	}
	if res.ACLErrors != 1 || sink.codes()[ItemACLUnreadable] != 1 {
		t.Fatalf("acl errors %d %v", res.ACLErrors, sink.codes())
	}
	if len(res.Candidates) != 3 {
		t.Fatalf("candidates %+v", res.Candidates)
	}
	entries, errs, result := readAllSidecar(t, buf.Bytes())
	if result.Trailer == nil || len(errs) != 1 || errs[0].Path != "HR/locked" || errs[0].Errno != "EACCES" {
		t.Fatalf("errors %+v", errs)
	}
	index := map[string]int{}
	for i, e := range entries {
		index[e.Path] = i
		if strings.Contains(e.Path, "Thumbs") || strings.Contains(e.Path, "RECYCLE") || strings.Contains(e.Path, "~$") {
			t.Fatalf("excluded path in the sidecar: %s", e.Path)
		}
	}
	// Top-down: every folder before what is below it.
	for p, i := range index {
		if p == "" {
			continue
		}
		parent := filepath.ToSlash(filepath.Dir(p))
		if parent == "." {
			parent = ""
		}
		if j, ok := index[parent]; !ok || j > i {
			t.Fatalf("%s (%d) before its parent %s (%d, %v)", p, i, parent, j, ok)
		}
	}
	if string(entries[index["Finance/2026/Q3.xlsx"]].Descriptor.Raw) != "sd-Finance" {
		t.Fatal("descriptor of Q3.xlsx")
	}
}

func TestWalkIncludesWriteAncestors(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"A/B/c.txt": "c", "A/other.txt": "o", "Z/z.txt": "z"})
	sys := newFakeSys(MagicNFS)
	var buf bytes.Buffer
	sc, _ := NewSidecarWriter(&buf, SidecarHeader{Protocol: ProtocolNFS, Xattr: XattrNFS4ACL})
	res, err := Walk(context.Background(), WalkOptions{Root: root, Includes: []string{"A/B"},
		Capture: &Capturer{X: sys, Protocol: ProtocolNFS, Xattr: ACLModeNone}, Sidecar: sc})
	mustNoErr(t, err)
	mustNoErr(t, sc.Close())
	if res.Files != 1 {
		t.Fatalf("files %d", res.Files)
	}
	entries, _, _ := readAllSidecar(t, buf.Bytes())
	var paths []string
	for _, e := range entries {
		paths = append(paths, e.Path)
	}
	if strings.Join(paths, ",") != ",A,A/B,A/B/c.txt" {
		t.Fatalf("paths %v", paths)
	}
}

func TestWalkReusesUnchangedDescriptors(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"a.txt": "a", "b.txt": "bb"})
	sys := newFakeSys(MagicCIFS)
	sys.put(filepath.Join(root, "a.txt"), XattrNTSD, []byte("new-a"))
	sys.put(filepath.Join(root, "b.txt"), XattrNTSD, []byte("new-b"))
	fa, _ := os.Lstat(filepath.Join(root, "a.txt"))
	previous := map[string]PreviousEntry{
		"a.txt": {CTime: ctimeOf(fa), Size: 1, Descriptor: &Descriptor{Raw: []byte("old-a")}},
		"b.txt": {CTime: 1, Size: 2, Descriptor: &Descriptor{Raw: []byte("old-b")}},
	}
	var buf bytes.Buffer
	sc, _ := NewSidecarWriter(&buf, SidecarHeader{Protocol: ProtocolSMB, Xattr: XattrNTSD})
	res, err := Walk(context.Background(), WalkOptions{Root: root, Previous: previous,
		Capture: &Capturer{X: sys, Protocol: ProtocolSMB, Xattr: XattrNTSD}, Sidecar: sc})
	mustNoErr(t, err)
	mustNoErr(t, sc.Close())
	if res.Reused != 1 {
		t.Fatalf("reused %d", res.Reused)
	}
	entries, _, _ := readAllSidecar(t, buf.Bytes())
	got := map[string]string{}
	for _, e := range entries {
		if e.Descriptor != nil {
			got[e.Path] = string(e.Descriptor.Raw)
		}
	}
	// a.txt unchanged (ctime and size): the old descriptor without asking the server;
	// b.txt changed: read again.
	if got["a.txt"] != "old-a" || got["b.txt"] != "new-b" {
		t.Fatalf("descriptors %v", got)
	}
	// The reuse map loads from a sidecar.
	prev, err := LoadPrevious(func(fn func(SidecarRecord) error) (SidecarResult, error) {
		return ReadSidecar(bytes.NewReader(buf.Bytes()), fn)
	})
	mustNoErr(t, err)
	if prev["b.txt"].Size != 2 || prev["b.txt"].CTime == 0 || string(prev["b.txt"].Descriptor.Raw) != "new-b" {
		t.Fatalf("previous %+v", prev["b.txt"])
	}
}

func TestWalkPermissionsOffStillFindsOfflineFiles(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"x/off": "o", "x/on": "n"})
	sys := newFakeSys(MagicCIFS)
	sys.put(filepath.Join(root, "x/off"), XattrDOSAttrib, []byte{0, 0, 0x40, 0})
	res, err := Walk(context.Background(), WalkOptions{Root: root, SkipOffline: true,
		Capture: &Capturer{X: sys, Protocol: ProtocolSMB, Xattr: ACLModeNone}})
	mustNoErr(t, err)
	if res.Files != 1 || res.OfflineCount != 1 {
		t.Fatalf("result %+v", res)
	}
	// Without skipping, offline files are backed up (and recalled).
	res, err = Walk(context.Background(), WalkOptions{Root: root,
		Capture: &Capturer{X: sys, Protocol: ProtocolSMB, Xattr: ACLModeNone}})
	mustNoErr(t, err)
	if res.Files != 2 || res.OfflineCount != 0 {
		t.Fatalf("result %+v", res)
	}
}

func TestWalkUnreadableFolderIsAnItem(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads every folder")
	}
	root := t.TempDir()
	writeTree(t, root, map[string]string{"open/a": "a", "closed/b": "b"})
	mustNoErr(t, os.Chmod(filepath.Join(root, "closed"), 0))
	defer os.Chmod(filepath.Join(root, "closed"), 0o755)
	sink := &itemSink{}
	res, err := Walk(context.Background(), WalkOptions{Root: root, OnItem: sink.add})
	mustNoErr(t, err)
	if res.Files != 1 || res.ReadErrors != 1 || sink.codes()[ItemReadError] != 1 {
		t.Fatalf("result %+v %v", res, sink.codes())
	}
}

func TestWalkSampleCandidatesRespectCutoff(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{}
	for i := 0; i < 50; i++ {
		files[filepath.Join("d", string(rune('a'+i%26))+strings.Repeat("x", i/26+1))] = "content"
	}
	writeTree(t, root, files)
	old := time.Now().Add(-48 * time.Hour)
	var names []string
	for rel := range files {
		names = append(names, rel)
	}
	sort.Strings(names)
	for _, rel := range names[:30] {
		mustNoErr(t, os.Chtimes(filepath.Join(root, rel), old, old))
	}
	res, err := Walk(context.Background(), WalkOptions{Root: root, SampleBefore: time.Now().Add(-time.Hour), SamplePool: 10,
		Rand: rand.New(rand.NewPCG(3, 4))})
	mustNoErr(t, err)
	if len(res.Candidates) != 10 {
		t.Fatalf("candidates %d", len(res.Candidates))
	}
	for _, c := range res.Candidates {
		if !c.MTime.Before(time.Now().Add(-time.Hour)) {
			t.Fatalf("a fresh file is a candidate: %+v", c)
		}
	}
	samples := PickSamples(root, res.Candidates, 4)
	if len(samples) != 4 || samples[0].SHA256 != "ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73" ||
		!strings.HasPrefix(samples[0].Path, root+"/d/") {
		t.Fatalf("samples %+v", samples)
	}
	// A file that changed since the walk is not a sample.
	c := res.Candidates[0]
	mustNoErr(t, os.WriteFile(filepath.Join(root, c.Rel), []byte("changed!"), 0o644))
	for _, s := range PickSamples(root, res.Candidates[:1], 1) {
		t.Fatalf("changed file sampled: %+v", s)
	}
}
