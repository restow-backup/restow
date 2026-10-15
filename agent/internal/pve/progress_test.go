package pve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func shortProgress(t *testing.T) {
	t.Helper()
	old := progressUnit
	progressUnit = 5 * time.Millisecond
	t.Cleanup(func() { progressUnit = old })
}

func TestProgressReporterSendsTheNewestOnlyAndStopsWhenRefused(t *testing.T) {
	shortProgress(t)
	var mu sync.Mutex
	var sent []Progress
	status := 0
	send := func(_ context.Context, p Progress) error {
		mu.Lock()
		defer mu.Unlock()
		sent = append(sent, p)
		if status != 0 {
			return &ServerError{Status: status}
		}
		return nil
	}
	if StartProgress(context.Background(), 0, send) != nil {
		t.Fatal("no interval (an older server) must give no reporter")
	}
	var none *ProgressReporter
	none.Set(Progress{BytesDone: 1}) // a nil reporter does nothing
	none.Stop()

	sentCount := func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(sent)
	}
	// Waits on the reporter's goroutine instead of a fixed sleep, which a loaded machine may
	// not give it in time.
	waitSent := func(n int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for sentCount() < n {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for report %d: %+v", n, sent)
			}
			time.Sleep(time.Millisecond)
		}
	}

	r := StartProgress(context.Background(), intervalSeconds(1), send)
	r.Set(Progress{BytesDone: 1})
	r.Set(Progress{BytesDone: 2})
	waitSent(1)
	time.Sleep(4 * progressUnit) // a second report would come within these intervals
	mu.Lock()
	if len(sent) != 1 || sent[0].BytesDone != 2 {
		t.Fatalf("only the newest figure, once: %+v", sent)
	}
	status = 404 // the server takes no reports for this run
	mu.Unlock()
	r.Set(Progress{BytesDone: 3})
	waitSent(2)
	r.Set(Progress{BytesDone: 4})
	time.Sleep(8 * progressUnit)
	r.Stop()
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 2 || sent[1].BytesDone != 3 {
		t.Fatalf("a 404 must end the reports: %+v", sent)
	}
}

func TestProgressReporterSendsTheLastFigureWhenStopped(t *testing.T) {
	var got []Progress
	r := StartProgress(context.Background(), time.Hour, func(_ context.Context, p Progress) error {
		got = append(got, p)
		return nil
	})
	r.Set(Progress{BytesDone: 9, BytesTotal: uint64Ptr(9)})
	r.Stop()
	r.Stop()
	if len(got) != 1 || got[0].BytesDone != 9 {
		t.Fatalf("stop must send the last figure once: %+v", got)
	}
}

func TestReadResticBackupOutputTurnsStatusIntoProgress(t *testing.T) {
	shortProgress(t)
	var got []Progress
	r := StartProgress(context.Background(), time.Hour, func(_ context.Context, p Progress) error {
		got = append(got, p)
		return nil
	})
	out := strings.Join([]string{
		`{"message_type":"status","percent_done":0,"total_files":0,"bytes_done":10}`,
		`{"message_type":"error","error":{"message":"denied"},"item":"/x"}`,
		`{"message_type":"status","percent_done":0.5,"total_bytes":4000,"bytes_done":2000}`,
		`not json`,
		ctSummary,
	}, "\n")
	var res ctResult
	others := readResticBackupOutput(strings.NewReader(out), &res, r)
	r.Stop()
	if res.SnapshotID == "" || res.TotalBytes != 4194304 || res.BytesAdded != 2097152 {
		t.Fatalf("summary: %+v", res)
	}
	if len(got) != 1 || got[0].BytesDone != 2000 || got[0].BytesTotal == nil || *got[0].BytesTotal != 4000 {
		t.Fatalf("progress: %+v", got)
	}
	if !strings.Contains(string(others), `"item":"/x"`) || !strings.Contains(string(others), "not json") ||
		strings.Contains(string(others), "status") || strings.Contains(string(others), "summary") {
		t.Fatalf("other lines: %q", others)
	}
	if items := unreadableItems(nil, others); len(items) != 1 || items[0] != "/x" {
		t.Fatalf("unreadable items from stdout: %v", items)
	}
}

func TestBackupDiskReportsWhatItReadOfWhatItReads(t *testing.T) {
	size := 3*4*mib + 5
	src := &memSource{data: disk(size)}
	var last [3]uint64
	calls := 0
	plan := DiskPlan{Device: "d", Size: uint64(size), BitmapMode: "new", Progress: func(read, toRead, uploaded uint64) {
		last = [3]uint64{read, toRead, uploaded}
		calls++
	}}
	res, err := BackupDisk(context.Background(), src, &memSink{blocks: map[uint32]FrameBlock{}}, "run", plan, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if calls < 4 || last[0] != uint64(size) || last[1] != uint64(size) || last[2] > res.UploadedBytes {
		t.Fatalf("progress %v after %d calls, result %+v", last, calls, res)
	}
	// Reusing the bitmap reads only the dirty blocks: that is the total.
	src.dirty = [][2]uint64{{4 * mib, 8 * mib}}
	plan.BitmapMode, plan.BitmapName, plan.Base = "reuse", "snapshot-access:restow", res.Hashes
	if _, err := BackupDisk(context.Background(), src, &memSink{blocks: map[uint32]FrameBlock{}}, "run", plan, nil, nil); err != nil {
		t.Fatal(err)
	}
	if last[0] != 4*mib || last[1] != 4*mib {
		t.Fatalf("incremental progress %v", last)
	}
}

func TestProviderReportsVMProgressWhenAsked(t *testing.T) {
	shortProgress(t)
	size := uint64(8 * mib)
	f := &fakeRestow{commits: map[string]string{}, mode: "new", progressInterval: 5}
	p := testProvider(t, f, &memSource{data: disk(int(size))})
	if _, err := runVMBackup(t, p, size, ""); err != nil {
		t.Fatal(err)
	}
	if len(f.progress) == 0 {
		t.Fatal("no progress reported")
	}
	final := f.progress[len(f.progress)-1]
	if final.BytesDone != size || final.BytesTotal == nil || *final.BytesTotal != size ||
		final.BytesUploaded == nil || *final.BytesUploaded == 0 {
		t.Fatalf("final progress %+v", final)
	}
}

func TestProviderSendsNoProgressToAnOlderServer(t *testing.T) {
	shortProgress(t)
	size := uint64(4 * mib)
	f := &fakeRestow{commits: map[string]string{}, mode: "new"}
	p := testProvider(t, f, &memSource{data: disk(int(size))})
	if _, err := runVMBackup(t, p, size, ""); err != nil {
		t.Fatal(err)
	}
	if len(f.progress) != 0 {
		t.Fatalf("progress to a server that did not ask: %+v", f.progress)
	}
}

func TestContainerBackupReportsProgressWithTheRunCredential(t *testing.T) {
	shortProgress(t)
	var mu sync.Mutex
	var got []Progress
	var users []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, _ := r.BasicAuth()
		var in Progress
		_ = json.NewDecoder(r.Body).Decode(&in)
		mu.Lock()
		got = append(got, in)
		users = append(users, user+":"+pass)
		mu.Unlock()
		w.WriteHeader(204)
	}))
	defer ts.Close()
	status := `{"message_type":"status","percent_done":0.25,"total_bytes":4194304,"bytes_done":1048576}`
	p, req, _, runDir := fakeContainerBackup(t, status+"\n"+ctSummary, "", 0)
	var creds ctCredentials
	if err := readJSON(filepath.Join(runDir, "credentials.json"), &creds); err != nil {
		t.Fatal(err)
	}
	creds.Username, creds.Password = "run-1", "token-1"
	creds.ProgressURL, creds.ProgressIntervalSeconds = ts.URL+"/agent/pve/v1/runs/run-1/progress", 5
	data, _ := json.Marshal(creds)
	if err := os.WriteFile(filepath.Join(runDir, "credentials.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(got) != 1 || got[0].BytesDone != 1048576 || users[0] != "run-1:token-1" {
		t.Fatalf("progress %+v by %v", got, users)
	}
	mu.Unlock()
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(req.Info.Directory), "args"))
	if strings.Contains(string(args), "--no-scan") {
		t.Fatalf("restic needs its scan for the total: %s", args)
	}
}
