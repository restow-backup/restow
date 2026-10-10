package share

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBackupArgsPerProtocol(t *testing.T) {
	smb := BackupArgs{ShareID: "S", RunID: "R", Protocol: ProtocolSMB, Parent: "p1", ExcludeFile: "/c/tmp/excludes",
		IExcludeFile: "/c/tmp/iexcludes", ExcludeLargerThanBytes: 1 << 30, LimitUploadKiB: 512,
		Paths: []string{"/share/A", "/share/B C", "/.restow"}}.Args()
	want := []string{"backup", "--json", "--host", "restow-share", "--tag", "restow-share", "--tag", "share=S", "--tag", "run=R",
		"--parent", "p1", "--no-scan", "--read-concurrency", "4", "--retry-lock", "1h",
		"--exclude-file", "/c/tmp/excludes", "--iexclude-file", "/c/tmp/iexcludes",
		"--exclude-larger-than", "1073741824", "--limit-upload", "512", "--ignore-inode", "--ignore-ctime",
		"/share/A", "/share/B C", "/.restow"}
	if !reflect.DeepEqual(smb, want) {
		t.Fatalf("smb args %q", smb)
	}
	nfs := BackupArgs{ShareID: "S", RunID: "R", Protocol: ProtocolNFS, ReadConcurrency: 8,
		ExcludeFile: "/x", Paths: []string{"/share", "/.restow"}}.Args()
	joined := strings.Join(nfs, " ")
	for _, never := range []string{"--ignore-inode", "--ignore-ctime", "--iexclude-file", "--parent", "--skip-if-unchanged", "--limit-upload"} {
		if strings.Contains(joined, never) {
			t.Fatalf("nfs args contain %s: %q", never, nfs)
		}
	}
	if !strings.Contains(joined, "--read-concurrency 8") || !strings.HasSuffix(joined, "/share /.restow") {
		t.Fatalf("nfs args %q", nfs)
	}
}

func TestClassifyResticItem(t *testing.T) {
	if classifyResticItem("open /share/x.xlsx: device or resource busy") != ItemLockedFile {
		t.Fatal("EBUSY is a locked file")
	}
	if classifyResticItem("open /share/x: permission denied") != ItemReadError {
		t.Fatal("other errors are read errors")
	}
	if relOf("/share", "/share/a/b") != "a/b" || relOf("/share", "/share") != "" || relOf("/share", "/.restow/x") != ".restow/x" {
		t.Fatal("relOf")
	}
}

func TestReporterThrottlesAndCapsItems(t *testing.T) {
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	api, client := startAPI(t, nil)
	var out strings.Builder
	cfg := Config{Now: func() time.Time { return now }, ProgressInterval: 5 * time.Second, Stdout: &out}
	cfg.defaults()
	log := &runLog{w: &out, red: nil, now: cfg.Now}
	log.red = newTestRedactor()
	rep := newReporter(client, &cfg, log, func() {})
	ctx := context.Background()
	rep.Phase(ctx, PhaseScan)
	for i := 0; i < 10; i++ {
		rep.Update(ctx, func(p *ProgressReport) { p.FilesDone = uint64(i) })
	}
	if len(api.progress) != 1 {
		t.Fatalf("progress within the interval: %d", len(api.progress))
	}
	now = now.Add(6 * time.Second)
	rep.Update(ctx, func(p *ProgressReport) { p.FilesDone = 99 })
	if len(api.progress) != 2 || api.progress[1].FilesDone != 99 || api.progress[1].Phase != PhaseScan {
		t.Fatalf("progress %+v", api.progress)
	}
	for i := 0; i < maxItemsSent+50; i++ {
		rep.Item(Item{Path: "p", Code: ItemReadError, Message: strings.Repeat("x", 600)})
	}
	rep.Phase(ctx, PhaseFinalize)
	if len(api.items) != maxItemsSent || len(api.items[0].Message) != 500 || rep.Count(ItemReadError) != maxItemsSent+50 {
		t.Fatalf("items sent %d, counted %d", len(api.items), rep.Count(ItemReadError))
	}
	// Progress also goes to stdout as JSON lines.
	first := strings.SplitN(out.String(), "\n", 2)[0]
	var line map[string]ProgressReport
	if err := json.Unmarshal([]byte(first), &line); err != nil || line["progress"].Phase != PhaseScan {
		t.Fatalf("stdout line %q", first)
	}
}
