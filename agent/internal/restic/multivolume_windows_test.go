//go:build windows && vssci

package restic

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// The multi-volume finding of W1 (docs/BAREMETAL-WINDOWS.md 1.2 and 8.2),
// reproduced on a Windows runner: a backup that spans two volumes with
// --use-fs-snapshot gets one shadow copy set per volume, made at different
// times, so the files of a database with its data on one volume and its log
// on another are not of one moment. restic writes nothing about it when VSS
// succeeds, so the evidence comes from Win32_ShadowCopy, polled while the
// agent's own Runner.Backup runs (C3).
//
// Run by agent/scripts/test-sql-windows.ps1 as Administrator, twice: in
// -Mode multivolume with plain files the test writes on both volumes, and in
// -Mode sql with RESTOW_TEST_SOURCES set to the folders of a SQL Server
// database whose data file is on Q: and whose log is on L:, while a load
// writes to it (8.2 as the design asks for it):
//
//	RESTOW_TEST_VOLUMES=Q:\,L:\ [RESTOW_TEST_SOURCES=Q:\Data,L:\Log] RESTIC_BINARY=...\restic.exe RESTOW_TEST_EVIDENCE=...\evidence.json
//	go test -tags windowsintegration,vssci -run TestMultiVolumeShadowCopySets ./internal/restic/

// shadowCopy is one row of Win32_ShadowCopy.
type shadowCopy struct {
	ID          string `json:"id"`
	SetID       string `json:"setId"`
	InstallDate string `json:"installDate"`
	VolumeName  string `json:"volumeName"`
}

// shadowQuery is fixed text: no input goes into it. It goes to PowerShell
// as -EncodedCommand, not through stdin: with -Command - PowerShell reads
// stdin like the interactive console, and a statement over several lines
// waits for an empty line that never comes, so the query wrote nothing and
// every poll looked like "no shadow copy".
const shadowQuery = `$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance -ClassName Win32_ShadowCopy | ForEach-Object {
  @{ id = [string]$_.ID; setId = [string]$_.SetID; volumeName = [string]$_.VolumeName;
     installDate = $_.InstallDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } })
[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress -Depth 3))`

func listShadowCopies(ctx context.Context) ([]shadowCopy, error) {
	sys, err := winapi.SystemDirectory()
	if err != nil {
		return nil, err
	}
	ps := filepath.Join(sys, "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", hooks.EncodePowerShell(shadowQuery))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr.String()))
	}
	out = bytes.TrimSpace(out)
	if len(out) == 0 {
		// ConvertTo-Json writes [] for no rows: nothing at all means the
		// query did not run.
		return nil, errors.New("the shadow copy query wrote nothing")
	}
	if string(out) == "null" {
		return nil, nil
	}
	if out[0] == '{' { // one row: Windows PowerShell 5.1 writes the element itself
		out = append(append([]byte("["), out...), ']')
	}
	var rows []shadowCopy
	err = json.Unmarshal(out, &rows)
	return rows, err
}

type evidence struct {
	Volumes      map[string]string `json:"volumes"` // drive -> volume GUID path
	Sources      []string          `json:"sources"`
	Seen         []shadowCopy      `json:"shadowCopies"`
	SetsByVolume map[string]string `json:"setByVolume"`
	SnapshotID   string            `json:"snapshotId"`
	Polls        int               `json:"polls"`
	PollErrors   int               `json:"pollErrors"`
	LastPollErr  string            `json:"lastPollError,omitempty"`
	// Snapshot is what restic said about the shadow copies (failed or
	// skipped volumes: it read those live).
	Snapshot SnapshotOutcome `json:"snapshot"`
	Finding  string          `json:"finding"`
}

func TestMultiVolumeShadowCopySets(t *testing.T) {
	vols := strings.Split(os.Getenv("RESTOW_TEST_VOLUMES"), ",")
	bin := os.Getenv("RESTIC_BINARY")
	if len(vols) < 2 || bin == "" {
		t.Skip("set RESTOW_TEST_VOLUMES (two drive roots) and RESTIC_BINARY")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	ev := evidence{Volumes: map[string]string{}, SetsByVolume: map[string]string{}}
	var sources []string
	given := strings.TrimSpace(os.Getenv("RESTOW_TEST_SOURCES"))
	for _, s := range strings.Split(given, ",") {
		if s = strings.TrimSpace(s); s != "" {
			sources = append(sources, s)
		}
	}
	for _, v := range vols {
		v = strings.TrimSpace(v)
		guid, err := winapi.VolumeNameForMountPoint(v)
		if err != nil {
			t.Fatalf("volume of %s: %v", v, err)
		}
		ev.Volumes[v] = guid
		if given != "" {
			continue
		}
		dir := filepath.Join(v, "restow-vss-ci")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		// Enough data that the shadow copies live for a while.
		for i := 0; i < 8; i++ {
			buf := make([]byte, 16<<20)
			_, _ = rand.Read(buf)
			if err := os.WriteFile(filepath.Join(dir, "file"+string(rune('a'+i))+".bin"), buf, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		sources = append(sources, dir)
	}
	ev.Sources = sources
	repo := t.TempDir()
	r := &Runner{Bin: bin, Repo: repo, Password: "restow-ci-only", CacheDir: filepath.Join(repo, "..", "cache"), TmpDir: t.TempDir()}
	if res, err := r.Command(ctx, CommandOptions{Name: "init", Args: []string{"init"}}); err != nil || res.Err() != nil {
		t.Fatalf("init: %v %v", err, res.Err())
	}

	var mu sync.Mutex
	seen := map[string]shadowCopy{}
	// The query has to work before it can show anything.
	before, err := listShadowCopies(ctx)
	if err != nil {
		t.Fatalf("Win32_ShadowCopy: %v", err)
	}
	old := map[string]bool{}
	for _, s := range before {
		old[s.ID] = true
	}
	pctx, pcancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for pctx.Err() == nil {
			rows, err := listShadowCopies(pctx)
			mu.Lock()
			if err == nil {
				ev.Polls++
				for _, s := range rows {
					if !old[s.ID] {
						seen[s.ID] = s
					}
				}
			} else if pctx.Err() == nil {
				ev.PollErrors++
				ev.LastPollErr = err.Error()
			}
			mu.Unlock()
			select {
			case <-pctx.Done():
			case <-time.After(200 * time.Millisecond):
			}
		}
	}()
	res, err := r.Backup(ctx, BackupOptions{Paths: sources, Host: "vss-ci", Tags: []string{"restow-vss-ci"}, UseFSSnapshot: true,
		CaseInsensitive: true, VSSTimeout: 5 * time.Minute})
	pcancel()
	wg.Wait()
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	ev.SnapshotID = res.SnapshotID
	ev.Snapshot = res.Snapshot
	for _, s := range seen {
		ev.Seen = append(ev.Seen, s)
	}
	sort.Slice(ev.Seen, func(i, j int) bool { return ev.Seen[i].InstallDate < ev.Seen[j].InstallDate })
	dates := map[string]string{}
	for drive, guid := range ev.Volumes {
		for _, s := range ev.Seen {
			if strings.EqualFold(strings.TrimSuffix(s.VolumeName, `\`), strings.TrimSuffix(guid, `\`)) {
				ev.SetsByVolume[drive] = s.SetID
				dates[drive] = s.InstallDate
			}
		}
	}
	sets := map[string]bool{}
	times := map[string]bool{}
	for d, set := range ev.SetsByVolume {
		sets[set] = true
		times[dates[d]] = true
	}
	switch {
	case len(ev.SetsByVolume) < len(ev.Volumes):
		ev.Finding = "incomplete: not every volume's shadow copy was seen while restic ran"
	case len(sets) >= 2 && len(times) >= 2:
		ev.Finding = "one shadow copy set per volume, made at different times"
	default:
		ev.Finding = "one shadow copy set for all volumes"
	}
	if p := os.Getenv("RESTOW_TEST_EVIDENCE"); p != "" {
		b, _ := json.MarshalIndent(ev, "", "  ")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("%s (%d polls, %d failed %q, %d new shadow copies): %+v; restic: failed %+v, skipped %v",
		ev.Finding, ev.Polls, ev.PollErrors, ev.LastPollErr, len(ev.Seen), ev.SetsByVolume, ev.Snapshot.FailedVolumes, ev.Snapshot.SkippedVolumes)
	if len(ev.Snapshot.FailedVolumes) > 0 || len(ev.Snapshot.SkippedVolumes) > 0 {
		t.Fatalf("restic did not read every volume from a shadow copy: failed %+v, skipped %v", ev.Snapshot.FailedVolumes, ev.Snapshot.SkippedVolumes)
	}
	if len(ev.SetsByVolume) < len(ev.Volumes) {
		t.Fatalf("the shadow copies of %d of %d volumes were seen; poll more often or write more data", len(ev.SetsByVolume), len(ev.Volumes))
	}
	if len(sets) < 2 || len(times) < 2 {
		t.Fatalf("the finding did not reproduce: %s", ev.Finding)
	}
}
