//go:build !windows

package pve

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// trappingRestic is a restic that runs until it gets SIGINT, writes down that it did (it would
// remove its lock now) and ends; started tells when it runs.
func trappingRestic(t *testing.T, path string) (sigFile, started string) {
	t.Helper()
	dir := filepath.Dir(path)
	sigFile, started = filepath.Join(dir, "sigint"), filepath.Join(dir, "started")
	body := "#!/bin/sh\ntrap 'echo int > " + sigFile + "; exit 130' INT\ntouch " + started + "\nwhile :; do sleep 0.05; done\n"
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return sigFile, started
}

func cancelWhenStarted(t *testing.T, started string, cancel context.CancelFunc) {
	t.Helper()
	go func() {
		for i := 0; i < 200; i++ {
			if _, err := os.Stat(started); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
	}()
}

func TestStoppingAContainerBackupLetsResticRemoveItsLock(t *testing.T) {
	p, req, _, runDir := fakeContainerBackup(t, "", "", 0)
	sigFile, started := trappingRestic(t, filepath.Join(filepath.Dir(runDir), "restic"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelWhenStarted(t, started, cancel)
	begin := time.Now()
	if _, err := p.backupContainer(ctx, req); err == nil {
		t.Fatal("a stopped backup must fail")
	}
	if data, err := os.ReadFile(sigFile); err != nil || strings.TrimSpace(string(data)) != "int" {
		t.Fatalf("restic got no SIGINT (it was killed): %v", err)
	}
	if time.Since(begin) > 10*time.Second {
		t.Fatalf("the stop took %v", time.Since(begin))
	}
}

func TestStoppingAContainerRestoreLetsResticRemoveItsLock(t *testing.T) {
	p := ctRestoreProvider(t, 0, 0)
	sigFile, started := trappingRestic(t, os.Getenv("RESTOW_PVE_RESTIC"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelWhenStarted(t, started, cancel)
	if _, err := p.restoreContainerInit(ctx, ProviderRequest{Volname: "backup/ct/200/2026-10-03T22:00:00Z"}); err == nil {
		t.Fatal("a stopped restore must fail")
	}
	if _, err := os.Stat(sigFile); err != nil {
		t.Fatalf("restic got no SIGINT (it was killed): %v", err)
	}
}

func TestResticThatIgnoresSIGINTIsKilledAfterTheGrace(t *testing.T) {
	old := resticStopGrace
	resticStopGrace = 200 * time.Millisecond
	t.Cleanup(func() { resticStopGrace = old })
	p, req, _, runDir := fakeContainerBackup(t, "", "", 0)
	script := filepath.Join(filepath.Dir(runDir), "restic")
	started := filepath.Join(filepath.Dir(runDir), "started")
	if err := os.WriteFile(script, []byte("#!/bin/sh\ntrap '' INT\ntouch "+started+"\nexec sleep 60\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelWhenStarted(t, started, cancel)
	begin := time.Now()
	if _, err := p.backupContainer(ctx, req); err == nil {
		t.Fatal("a stopped backup must fail")
	}
	if d := time.Since(begin); d > 10*time.Second {
		t.Fatalf("restic was not killed after the grace: %v", d)
	}
}

// After an ID map change every file can be unreadable: a million error lines are counted in
// bounded memory, with the first items named and restic's last lines kept.
func TestResticErrorsOfAMillionItemsInBoundedMemory(t *testing.T) {
	errs := &resticErrors{}
	w := errs.stderr()
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	const n = 1_000_000
	var batch strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&batch, `{"message_type":"error","error":{"message":"open: permission denied"},"during":"archival","item":"/srv/data/file-%07d"}`+"\n", i)
		if batch.Len() > 50_000 || i == n-1 {
			s := batch.String()
			// Writes that end in the middle of a line.
			cut := len(s) / 3
			_, _ = w.Write([]byte(s[:cut]))
			_, _ = w.Write([]byte(s[cut:]))
			batch.Reset()
		}
	}
	_, _ = w.Write([]byte(`{"message_type":"exit_error","code":3,"message":"Warning: at least one source file could not be read"}`))
	w.Flush()
	runtime.GC()
	runtime.ReadMemStats(&after)
	count, items := errs.result()
	if count != n || len(items) != maxReportedUnreadable || items[0] != "/srv/data/file-0000000" {
		t.Fatalf("count %d, items %d (%q)", count, len(items), items[:min(len(items), 1)])
	}
	if grown := int64(after.HeapAlloc) - int64(before.HeapAlloc); grown > 8<<20 {
		t.Fatalf("the heap grew by %d MiB for %d error lines", grown>>20, n)
	}
	last := errs.lastLines(10)
	if strings.Count(last, " | ") != 9 || !strings.HasSuffix(last, `could not be read"}`) || !strings.Contains(last, "file-0999999") {
		t.Fatalf("last lines %q", last)
	}
	if got := unreadableRemark(count, items); !strings.Contains(got, "1000000 items (first: /srv/data/file-0000000)") {
		t.Fatalf("remark %q", got)
	}
}

// A line longer than a MiB neither stops the reading nor loses the summary after it.
func TestResticOutputWithAnOverlongLine(t *testing.T) {
	long := `{"message_type":"error","error":{"message":"` + strings.Repeat("x", 3<<20) + `"},"item":"/big"}`
	errs := &resticErrors{}
	w := errs.stderr()
	_, _ = w.Write([]byte(long + "\n" + `{"message_type":"error","error":{"message":"denied"},"item":"/next"}` + "\n"))
	w.Flush()
	if count, items := errs.result(); count != 2 || len(items) != 1 || items[0] != "/next" {
		t.Fatalf("count %d items %q", count, items)
	}
	var res ctResult
	r := StartProgress(context.Background(), time.Hour, nil)
	readResticBackupOutput(strings.NewReader(`{"message_type":"verbose_status","item":"`+strings.Repeat("y", 2<<20)+`"}`+"\n"+ctSummary+"\n"), &res, r, &resticErrors{})
	r.Stop()
	if res.SnapshotID == "" {
		t.Fatal("the summary after an over-long line was lost")
	}
}

// What the task log names of a backup with more unreadable items than it lists.
func TestContainerBackupNamesTheFirstUnreadableItemsAndCountsAll(t *testing.T) {
	var stderr strings.Builder
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&stderr, `{"message_type":"error","error":{"message":"denied"},"item":"f%02d"}`+"\n", i)
	}
	stderr.WriteString(`{"message_type":"exit_error","code":3,"message":"Warning"}`)
	p, req, log, runDir := fakeContainerBackup(t, ctSummary, stderr.String(), 3)
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var res ctResult
	if err := readJSON(filepath.Join(runDir, "result.json"), &res); err != nil {
		t.Fatal(err)
	}
	if res.Unreadable != 30 || len(res.UnreadablePaths) != maxReportedUnreadable || !strings.Contains(res.Remark, "30 items (first: f00)") {
		t.Fatalf("result %+v", res)
	}
	if !strings.Contains(log.String(), "warn: could not read f19") || strings.Contains(log.String(), "could not read f20") ||
		!strings.Contains(log.String(), "warn: ... and 10 more") {
		t.Fatalf("task log %q", log.String())
	}
}
