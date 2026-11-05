//go:build windows

package svc

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// A file in use is renamed and the new name is deleted at the restart; the
// fixed name is never registered, or Windows would delete an agent installed
// again before the restart.
func TestUninstallNeverSchedulesTheFixedPath(t *testing.T) {
	root := t.TempDir()
	layout := paths.Layout{StateDir: filepath.Join(root, "data", "state"), DataDir: filepath.Join(root, "data", "data"), LogDir: filepath.Join(root, "data", "logs")}
	bin := filepath.Join(root, "Restow", "bin")
	agent := filepath.Join(bin, "restow-agent.exe")
	restic := filepath.Join(bin, "restic.exe")
	notices := filepath.Join(bin, "THIRD_PARTY_NOTICES.txt")
	for _, d := range []string{layout.StateDir, layout.DataDir, layout.LogDir, bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{agent, restic, notices} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var scheduled []string
	oldMove, oldRemove := moveFileEx, removeFile
	t.Cleanup(func() { moveFileEx, removeFile = oldMove, oldRemove })
	moveFileEx = func(from, to string, flags uint32) error {
		if to != "" || flags != winapi.MoveFileDelayUntilReboot {
			t.Errorf("MoveFileEx(%q, %q, %#x)", from, to, flags)
		}
		scheduled = append(scheduled, from)
		return nil
	}
	// restic.exe and the agent still run: Windows refuses to delete them.
	removeFile = func(p string) error {
		if p == restic || p == agent {
			return &os.PathError{Op: "remove", Path: p, Err: syscall.Errno(winapi.ErrorAccessDenied)}
		}
		return os.Remove(p)
	}
	var out strings.Builder
	err := Uninstall(UninstallOptions{Layout: layout, Files: []string{restic, notices, agent},
		Dirs: []string{bin, filepath.Dir(bin)}, Out: &out, SkipService: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(scheduled) != 4 {
		t.Fatalf("scheduled %q\n%s", scheduled, out.String())
	}
	for i, want := range []string{restic, agent} {
		if !strings.HasPrefix(scheduled[i], want+".old-") || len(scheduled[i]) != len(want)+len(".old-")+16 {
			t.Errorf("scheduled %q, want %s.old-<16 hex>", scheduled[i], want)
		}
		if _, err := os.Stat(scheduled[i]); err != nil {
			t.Errorf("the renamed file is missing: %v", err)
		}
		if _, err := os.Lstat(want); !os.IsNotExist(err) {
			t.Errorf("%s is still there under its fixed name", want)
		}
	}
	// The folders after the files: a folder that is not empty then stays.
	if scheduled[2] != bin || scheduled[3] != filepath.Dir(bin) {
		t.Errorf("folders %q", scheduled[2:])
	}
	if _, err := os.Lstat(notices); !os.IsNotExist(err) {
		t.Error("a file that can be deleted must be deleted now")
	}
	// A new installation at the same place is in no list.
	for _, s := range scheduled {
		if strings.EqualFold(s, restic) || strings.EqualFold(s, agent) {
			t.Fatalf("the fixed path %s was scheduled for deletion", s)
		}
	}
}

func TestUninstallReportsAFileItCannotMoveAside(t *testing.T) {
	root := t.TempDir()
	layout := paths.Layout{StateDir: filepath.Join(root, "s"), DataDir: filepath.Join(root, "d"), LogDir: filepath.Join(root, "l")}
	f := filepath.Join(root, "restic.exe")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldMove, oldRemove, oldRename := moveFileEx, removeFile, renameFile
	t.Cleanup(func() { moveFileEx, removeFile, renameFile = oldMove, oldRemove, oldRename })
	moveFileEx = func(from, _ string, _ uint32) error {
		t.Errorf("scheduled %s", from)
		return nil
	}
	removeFile = func(p string) error {
		return &os.PathError{Op: "remove", Path: p, Err: syscall.Errno(winapi.ErrorAccessDenied)}
	}
	renameFile = func(string, string) error { return syscall.Errno(winapi.ErrorSharingViolation) }
	err := Uninstall(UninstallOptions{Layout: layout, Files: []string{f}, Dirs: []string{}, SkipService: true})
	if err == nil || !strings.Contains(err.Error(), "delete it after the next restart") {
		t.Fatalf("%v", err)
	}
}

// stuckManager is a service control manager whose service does not stop in
// time (a backup or a post hook still ending).
type stuckManager struct{ deleted bool }

func (f *stuckManager) Name() string         { return "Windows service control manager" }
func (f *stuckManager) Install(string) error { return nil }
func (f *stuckManager) Start() error         { return nil }
func (f *stuckManager) Stop() error          { return ErrStillRunning }
func (f *stuckManager) Restart() error       { return ErrStillRunning }
func (f *stuckManager) Status() Info         { return Info{State: Running, PID: 4242, Detail: "stopping"} }
func (f *stuckManager) Uninstall() error {
	return stopAndConfirm(func() error { return nil }, func() (bool, uint32, error) { return false, 4242, nil }, 20*time.Millisecond, time.Millisecond)
}
func (f *stuckManager) UninstallFromInside() error      { f.deleted = true; return nil }
func (f *stuckManager) Refresh(string) (bool, error)    { return false, nil }
func (f *stuckManager) ReloadFromInside() (bool, error) { return false, nil }
func (f *stuckManager) Program() (string, error)        { return "", nil }

// A service that does not stop in time removes nothing: not the service, not
// the state with the credentials, not the data, logs or binaries (K118).
func TestUninstallRemovesNothingWhileTheAgentRuns(t *testing.T) {
	root := t.TempDir()
	layout := paths.Layout{StateDir: filepath.Join(root, "s"), DataDir: filepath.Join(root, "d"), LogDir: filepath.Join(root, "l")}
	bin := filepath.Join(root, "bin")
	agent := filepath.Join(bin, "restow-agent.exe")
	for _, d := range []string{layout.StateDir, layout.DataDir, layout.LogDir, bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	state := filepath.Join(layout.StateDir, "state.json")
	for _, f := range []string{state, agent} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := &stuckManager{}
	var out strings.Builder
	err := Uninstall(UninstallOptions{Layout: layout, Files: []string{agent}, Dirs: []string{bin}, Out: &out, Manager: m})
	if !errors.Is(err, ErrStillRunning) || !strings.Contains(err.Error(), "nothing was removed") || !strings.Contains(err.Error(), "4242") {
		t.Fatalf("err %v", err)
	}
	for _, p := range []string{state, layout.DataDir, layout.LogDir, agent} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s was removed while the agent still runs", p)
		}
	}
	if m.deleted || strings.Contains(out.String(), "removed") {
		t.Fatalf("something was removed:\n%s", out.String())
	}
}
