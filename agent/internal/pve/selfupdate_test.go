//go:build !windows

package pve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// systemdStub answers systemctl like a node: `is-active` per unit, and the other calls recorded
// (and failed for the units in fail).
type systemdStub struct {
	active map[string]bool
	fail   map[string]bool
	calls  []string
}

func (s *systemdStub) Run(_ context.Context, name string, args ...string) (string, error) {
	call := name + " " + strings.Join(args, " ")
	s.calls = append(s.calls, call)
	if name != "systemctl" {
		return "", fmt.Errorf("unexpected command %s", call)
	}
	unit := args[len(args)-1]
	if args[0] == "is-active" {
		if s.active[unit] {
			return "", nil
		}
		return "", errors.New("exit status 3")
	}
	if s.fail[unit] {
		return "", errors.New("exit status 1")
	}
	return "", nil
}

func (s *systemdStub) changes() []string {
	var out []string
	for _, c := range s.calls {
		if !strings.Contains(c, " is-active ") {
			out = append(out, c)
		}
	}
	return out
}

func collectLogs() (*[]string, func(string, ...any)) {
	var lines []string
	return &lines, func(f string, a ...any) { lines = append(lines, fmt.Sprintf(f, a...)) }
}

func TestInstallUpdateRestartsThePVEDaemonsLikeTheInstaller(t *testing.T) {
	stub := &systemdStub{active: map[string]bool{
		"pvedaemon": true, "pveproxy": true, "pvestatd": true, "pvescheduler": true,
	}}
	logs, logf := collectLogs()
	applied := false
	l := pluginLayout(t)
	err := InstallUpdate(context.Background(), l, func(context.Context) error {
		applied = true
		return nil
	}, stub, logf)
	if err != nil || !applied {
		t.Fatalf("InstallUpdate = %v, applied %v", err, applied)
	}
	want := []string{
		"systemctl reload-or-restart pvedaemon",
		"systemctl reload-or-restart pveproxy",
		"systemctl reload-or-restart pvestatd",
		"systemctl reload-or-restart pvescheduler",
	}
	if got := stub.changes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("systemctl calls = %v, want %v", got, want)
	}
	if !strings.Contains(strings.Join(*logs, "\n"), "restarted pvedaemon, it loads the new storage plugin") {
		t.Fatalf("logs = %v", *logs)
	}
	// Remembered: the check after the next start leaves the daemons alone.
	stub.calls = nil
	EnsurePluginLoaded(context.Background(), l, stub, logf)
	if got := stub.changes(); len(got) != 0 {
		t.Fatalf("restarted again: %v", got)
	}
}

func TestInstallUpdateTouchesNothingWhenTheUpdateFails(t *testing.T) {
	stub := &systemdStub{active: map[string]bool{"pvedaemon": true}}
	_, logf := collectLogs()
	refused := errors.New("a backup or restore is running; the update waits")
	err := InstallUpdate(context.Background(), pluginLayout(t), func(context.Context) error { return refused }, stub, logf)
	if !errors.Is(err, refused) {
		t.Fatalf("err = %v", err)
	}
	if len(stub.calls) != 0 {
		t.Fatalf("systemctl was called: %v", stub.calls)
	}
}

func TestReloadPVEDaemonsSkipsStoppedOnesAndKeepsGoingAfterAFailure(t *testing.T) {
	stub := &systemdStub{
		active: map[string]bool{"pvedaemon": true, "pveproxy": true, "pvescheduler": true},
		fail:   map[string]bool{"pveproxy": true},
	}
	logs, logf := collectLogs()
	failed := ReloadPVEDaemons(context.Background(), stub, logf)
	if !reflect.DeepEqual(failed, []string{"pveproxy"}) {
		t.Fatalf("failed = %v", failed)
	}
	want := []string{
		"systemctl reload-or-restart pvedaemon",
		"systemctl reload-or-restart pveproxy",
		"systemctl reload-or-restart pvescheduler",
	}
	if got := stub.changes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("systemctl calls = %v, want %v", got, want)
	}
	joined := strings.Join(*logs, "\n")
	for _, line := range []string{
		"could not restart pveproxy",
		"pvestatd is not running",
	} {
		if !strings.Contains(joined, line) {
			t.Fatalf("logs %q lack %q", joined, line)
		}
	}
}

func TestRestartHelperRestartsTheServiceOnlyWhenItRuns(t *testing.T) {
	_, logf := collectLogs()
	running := &systemdStub{active: map[string]bool{"restow-pve": true}}
	if err := RestartHelper(context.Background(), running, logf); err != nil {
		t.Fatal(err)
	}
	if got := running.changes(); !reflect.DeepEqual(got, []string{"systemctl try-restart restow-pve"}) {
		t.Fatalf("calls = %v", got)
	}
	stopped := &systemdStub{}
	if err := RestartHelper(context.Background(), stopped, logf); err != nil {
		t.Fatal(err)
	}
	if got := stopped.changes(); len(got) != 0 {
		t.Fatalf("calls = %v", got)
	}
	broken := &systemdStub{active: map[string]bool{"restow-pve": true}, fail: map[string]bool{"restow-pve": true}}
	if err := RestartHelper(context.Background(), broken, logf); err == nil {
		t.Fatal("a failed restart was not reported")
	}
}

// PVEDaemons names the same daemons as the installer's restart_pve_daemons.
func TestPVEDaemonsMatchTheInstaller(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "install", "pve.sh"))
	if err != nil {
		t.Skip(err)
	}
	want := "for unit in " + strings.Join(PVEDaemons, " ") + "; do"
	if !strings.Contains(string(data), want) {
		t.Fatalf("install/pve.sh does not restart %v (looked for %q)", PVEDaemons, want)
	}
}

// pluginLayout is a node layout in a temporary folder with the plugin files installed.
func pluginLayout(t *testing.T) Layout {
	t.Helper()
	root := t.TempDir()
	l := Layout{
		DataDir:     filepath.Join(root, "data"),
		RunDir:      filepath.Join(root, "run"),
		PluginDir:   filepath.Join(root, "plugin"),
		ProviderDir: filepath.Join(root, "provider"),
	}
	for _, f := range PluginFiles {
		writePlugin(t, l, f, "package "+f+"; 1;\n")
	}
	return l
}

func writePlugin(t *testing.T, l Layout, file, content string) {
	t.Helper()
	path := PluginPath(l, file)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A node an older restow-pve updated (before 0.4.3) has the PVE daemons on the old plugin: the
// new release restarts them once by itself, and again only for other plugin files.
func TestEnsurePluginLoadedRestartsTheDaemonsOncePerPlugin(t *testing.T) {
	l := pluginLayout(t)
	stub := &systemdStub{active: map[string]bool{"pvedaemon": true, "pveproxy": true}}
	logs, logf := collectLogs()
	ctx := context.Background()

	EnsurePluginLoaded(ctx, l, stub, logf)
	want := []string{"systemctl reload-or-restart pvedaemon", "systemctl reload-or-restart pveproxy"}
	if got := stub.changes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("first check: %v, want %v", got, want)
	}
	if !strings.Contains(strings.Join(*logs, "\n"), "restarting them once") {
		t.Fatalf("logs = %v", *logs)
	}
	stub.calls = nil
	EnsurePluginLoaded(ctx, l, stub, logf)
	if got := stub.changes(); len(got) != 0 {
		t.Fatalf("second check restarted: %v", got)
	}

	// Other plugin files (an update by an older restow-pve): once more.
	writePlugin(t, l, "RestowPlugin.pm", "package RestowPlugin; our $VERSION = 2; 1;\n")
	EnsurePluginLoaded(ctx, l, stub, logf)
	if got := stub.changes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("after a plugin change: %v, want %v", got, want)
	}
}

func TestEnsurePluginLoadedWaitsWhileBusyAndRetriesAfterAFailure(t *testing.T) {
	l := pluginLayout(t)
	ctx := context.Background()
	_, logf := collectLogs()
	// A backup runs here: nothing is restarted, nothing remembered.
	if err := os.MkdirAll(filepath.Join(l.RunDir, "jobs"), 0o755); err != nil {
		t.Fatal(err)
	}
	job := filepath.Join(l.RunDir, "jobs", "101.json")
	if err := os.WriteFile(job, []byte(`{"runId":"r"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stub := &systemdStub{active: map[string]bool{"pvedaemon": true}}
	EnsurePluginLoaded(ctx, l, stub, logf)
	if got := stub.changes(); len(got) != 0 {
		t.Fatalf("restarted while busy: %v", got)
	}
	_ = os.Remove(job)

	// A restart that fails is tried again by the next check.
	broken := &systemdStub{active: map[string]bool{"pvedaemon": true}, fail: map[string]bool{"pvedaemon": true}}
	EnsurePluginLoaded(ctx, l, broken, logf)
	EnsurePluginLoaded(ctx, l, broken, logf)
	if got := broken.changes(); len(got) != 2 {
		t.Fatalf("calls = %v, want two attempts", got)
	}
}
