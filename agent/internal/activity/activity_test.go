package activity

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/restic"
)

func change(p, m string) restic.DiffChange { return restic.DiffChange{Path: p, Modifier: m} }

func TestCollectorCountsAndRenames(t *testing.T) {
	c := NewCollector(rand.New(rand.NewPCG(1, 2)))
	c.Within = func(p string) bool { return strings.HasPrefix(p, "/srv/") }
	for _, ch := range []restic.DiffChange{
		change("/srv/docs/", "+"),
		change("/srv/docs/a.docx", "-"),
		change("/srv/docs/a.docx.locked", "+"),
		change("/srv/docs/b.xlsx", "-"),
		change("/srv/docs/b.crypt", "+"),
		change("/srv/docs/HOW_TO_DECRYPT.txt", "+"),
		change("/srv/pics/HOW_TO_DECRYPT.txt", "+"),
		change("/srv/docs/c.txt", "M"),
		change("/srv/docs/d.txt", "U"),
		change("/srv/docs/old.pdf", "-"),
		change("/old-folder/gone.txt", "-"),
	} {
		c.Add(ch)
	}
	r := c.Report(nil)
	if r.V != 1 || r.Added != 4 || r.Modified != 1 || r.Removed != 3 || r.Renamed != 2 {
		t.Fatalf("report %+v", r)
	}
	if r.Names[0] != (Count{Value: "HOW_TO_DECRYPT.txt", Count: 2}) {
		t.Fatalf("names %+v", r.Names)
	}
	if r.Extensions[0] != (Count{Value: "txt", Count: 3}) {
		t.Fatalf("extensions %+v", r.Extensions)
	}
	if r.Entropy == nil || r.Truncated {
		t.Fatalf("entropy %v truncated %v", r.Entropy, r.Truncated)
	}
	// The protocol's field names (packages/core ransomware/activity.ts).
	raw, _ := json.Marshal(r)
	for _, key := range []string{`"v":1`, `"added":4`, `"removed":3`, `"renamed":2`, `"extensions":[`, `"names":[`, `"entropy":[]`} {
		if !bytes.Contains(raw, []byte(key)) {
			t.Fatalf("%s lacks %s", raw, key)
		}
	}
}

func TestCandidatesSkipCompressedFormats(t *testing.T) {
	c := NewCollector(rand.New(rand.NewPCG(3, 4)))
	c.Skip = func(p string) bool { return strings.HasPrefix(p, "/.restow/") }
	c.Add(change("/a.jpg", "+"))
	c.Add(change("/b.zip", "M"))
	c.Add(change("/c.txt", "+"))
	c.Add(change("/.restow/sidecar.txt", "+"))
	for i := 0; i < 100; i++ {
		c.Add(change("/many/f"+string(rune('a'+i%26))+".csv", "+"))
	}
	got := c.Candidates()
	if len(got) != candidatePool {
		t.Fatalf("pool %d", len(got))
	}
	for _, p := range got {
		if strings.HasSuffix(p, ".jpg") || strings.HasSuffix(p, ".zip") || strings.HasPrefix(p, "/.restow/") {
			t.Fatalf("candidate %s", p)
		}
	}
}

func TestEntropyAndMeasure(t *testing.T) {
	if Entropy(nil) != 0 || Entropy(bytes.Repeat([]byte{7}, 100)) != 0 {
		t.Fatal("entropy of nothing or one byte")
	}
	dir := t.TempDir()
	text := filepath.Join(dir, "a.txt")
	os.WriteFile(text, bytes.Repeat([]byte("plain words and more words "), 10_000), 0o600)
	random := make([]byte, 3*SampleBytes)
	crand.Read(random)
	enc := filepath.Join(dir, "b.csv")
	os.WriteFile(enc, random, 0o600)
	small := filepath.Join(dir, "c.txt")
	os.WriteFile(small, []byte("tiny"), 0o600)

	s, err := Measure(text, "/srv/a.txt")
	if err != nil || s.Head > 5 || s.Tail == nil || *s.Tail > 5 || s.Ext != "txt" || s.Path != "/srv/a.txt" {
		t.Fatalf("text %+v %v", s, err)
	}
	s, err = Measure(enc, "/srv/b.csv")
	if err != nil || s.Head < 7.99 || s.Tail == nil || *s.Tail < 7.99 || s.Size != int64(len(random)) {
		t.Fatalf("random %+v %v", s, err)
	}
	s, err = Measure(small, "/srv/c.txt")
	if err != nil || s.Tail != nil {
		t.Fatalf("small %+v %v", s, err)
	}
	if _, err := Measure(dir, "/srv"); err == nil {
		t.Fatal("a folder is not measured")
	}
	all := MeasureAll([]string{"/missing", text, enc}, func(p string) string { return p }, nil)
	if len(all) != 2 {
		t.Fatalf("measured %+v", all)
	}
}

// TestWithResticDiff runs the real restic: a folder is "encrypted" between two
// snapshots and the report says so.
func TestWithResticDiff(t *testing.T) {
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("RESTIC_BINARY is not set")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	repo := filepath.Join(dir, "repo")
	os.MkdirAll(filepath.Join(src, "docs"), 0o700)
	for i := 0; i < 20; i++ {
		os.WriteFile(filepath.Join(src, "docs", "report"+string(rune('a'+i))+".txt"), bytes.Repeat([]byte("quarterly figures "), 5000), 0o600)
	}
	env := append(os.Environ(), "RESTIC_REPOSITORY="+repo, "RESTIC_PASSWORD=pw", "RESTIC_CACHE_DIR="+filepath.Join(dir, "cache"))
	run := func(args ...string) string {
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("restic %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	snapshot := func() string {
		out := run("backup", "--json", src)
		lines := strings.Split(strings.TrimSpace(out), "\n")
		s, ok := restic.ParseBackupSummary([]byte(lines[len(lines)-1]))
		if !ok {
			t.Fatalf("no summary: %s", out)
		}
		return s.SnapshotID
	}
	run("init")
	before := snapshot()
	// The attack: every file replaced by random bytes under a new name, a note beside them.
	entries, _ := os.ReadDir(filepath.Join(src, "docs"))
	for _, e := range entries {
		p := filepath.Join(src, "docs", e.Name())
		noise := make([]byte, 100_000)
		crand.Read(noise)
		os.WriteFile(p+".locked", noise, 0o600)
		os.Remove(p)
	}
	os.WriteFile(filepath.Join(src, "docs", "HOW_TO_DECRYPT.txt"), []byte("pay"), 0o600)
	after := snapshot()

	runner := &restic.Runner{Bin: bin, Repo: repo, Password: "pw", CacheDir: filepath.Join(dir, "cache"), TmpDir: filepath.Join(dir, "tmp")}
	os.MkdirAll(runner.TmpDir, 0o700)
	c := NewCollector(nil)
	if err := runner.Diff(context.Background(), before, after, c.Add); err != nil {
		t.Fatal(err)
	}
	samples := MeasureAll(c.Candidates(), func(p string) string { return p }, nil)
	r := c.Report(samples)
	if r.Added != 21 || r.Removed != 20 || r.Renamed != 20 {
		t.Fatalf("report %+v", r)
	}
	if r.Extensions[0] != (Count{Value: "locked", Count: 20}) || r.Names[0].Value != "HOW_TO_DECRYPT.txt" {
		t.Fatalf("names %+v %+v", r.Extensions, r.Names)
	}
	high := 0
	for _, s := range samples {
		if s.Head > 7.9 {
			high++
		}
	}
	if len(samples) != EntropySamples || high < EntropySamples-1 {
		t.Fatalf("samples %+v", samples)
	}
}
