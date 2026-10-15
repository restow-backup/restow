package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/share"
)

type stubSys struct{ magic int64 }

func (s stubSys) Statfs(string) (int64, error) { return s.magic, nil }
func (s stubSys) MountInfo() ([]byte, error) {
	return []byte("22 1 0:21 / /share-test ro,relatime - cifs //srv/x ro\n"), nil
}
func (stubSys) GetXattr(string, string) ([]byte, error) { return nil, share.ErrUnsupported }
func (stubSys) SetXattr(string, string, []byte) error   { return share.ErrUnsupported }

func env(values map[string]string) func(string) string {
	return func(k string) string { return values[k] }
}

func TestUsageAndVersion(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run(nil, env(nil), &out, &errOut); code != share.ExitUsage || !strings.Contains(errOut.String(), "Usage") {
		t.Fatalf("no command: %d", code)
	}
	out.Reset()
	if code := run([]string{"version", "--short"}, env(nil), &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != "0.0.0-dev" {
		t.Fatalf("version: %d %q", code, out.String())
	}
	if code := run([]string{"bogus"}, env(nil), &out, &errOut); code != share.ExitUsage {
		t.Fatal("unknown command")
	}
}

func TestRunNeedsItsEnvironmentAndNeverPrintsTheToken(t *testing.T) {
	var out, errOut bytes.Buffer
	bad := "short-token-SECRET"
	code := run([]string{"run"}, env(map[string]string{
		"RESTOW_SHARE_API_URL":   "http://api:3000",
		"RESTOW_SHARE_RUN_ID":    "0f1e2d3c-4b5a-4968-8776-655443322110",
		"RESTOW_SHARE_RUN_TOKEN": bad,
	}), &out, &errOut)
	if code != share.ExitUsage || strings.Contains(errOut.String()+out.String(), bad) {
		t.Fatalf("exit %d, output %q", code, errOut.String())
	}
}

func TestProbeAndListThroughTheCommandLine(t *testing.T) {
	root := filepath.Join(t.TempDir(), "share-test")
	if err := os.MkdirAll(filepath.Join(root, "Folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := share.DefaultConfig()
	cfg.Root, cfg.Sys, cfg.Now = root, stubSys{magic: share.MagicCIFS}, time.Now
	d := deps{cfg: cfg}
	// The stub's mount table names /share-test; point it at the temp root.
	d.cfg.Sys = mountAt{stubSys{magic: share.MagicCIFS}, root}

	var out, errOut bytes.Buffer
	if code := runWith(d, []string{"probe"}, env(nil), &out, &errOut); code != share.ExitUsage {
		t.Fatal("probe without --expect")
	}
	if code := runWith(d, []string{"probe", "--expect", "smb"}, env(nil), &out, &errOut); code != 0 {
		t.Fatalf("probe: %d %s %s", code, out.String(), errOut.String())
	}
	var res share.ProbeResult
	if err := json.Unmarshal(out.Bytes(), &res); err != nil || !res.OK || len(res.Entries) != 1 || res.Permissions.Readable {
		t.Fatalf("probe output %q", out.String())
	}
	out.Reset()
	code := runWith(d, []string{"list", "--path", "Folder", "--limit", "5"}, env(map[string]string{"RESTOW_SHARE_EXPECT": "smb"}), &out, &errOut)
	if code != 0 || !strings.Contains(out.String(), `"ok":true`) {
		t.Fatalf("list: %d %q", code, out.String())
	}
	out.Reset()
	if code := runWith(d, []string{"probe", "--expect", "nfs"}, env(nil), &out, &errOut); code != share.ExitGuard ||
		!strings.Contains(out.String(), "wrong_filesystem") {
		t.Fatalf("wrong protocol: %d %q", code, out.String())
	}
}

type mountAt struct {
	stubSys
	root string
}

func (m mountAt) MountInfo() ([]byte, error) {
	return []byte("22 1 0:21 / " + m.root + " ro,relatime - cifs //srv/x ro\n"), nil
}
