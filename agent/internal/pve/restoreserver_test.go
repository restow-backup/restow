//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as a stand-in for `restow-pve serve-restore` when
// RESTOW_TEST_SERVE_RESTORE is set: "serve" listens on --socket until SIGTERM, "exit" ends at
// once with an error, "hang" never opens the socket.
func TestMain(m *testing.M) {
	if mode := os.Getenv("RESTOW_TEST_SERVE_RESTORE"); mode != "" && len(os.Args) > 1 && os.Args[1] == "serve-restore" {
		os.Exit(fakeServeRestore(mode, os.Args[2:]))
	}
	os.Exit(m.Run())
}

func fakeServeRestore(mode string, args []string) int {
	socket := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--socket" {
			socket = args[i+1]
		}
	}
	switch mode {
	case "exit":
		fmt.Fprintln(os.Stderr, "restore point s1 has no disk drive-scsi0")
		return 3
	case "hang":
		time.Sleep(time.Hour)
		return 0
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM)
	select {
	case <-sig:
	case <-time.After(2 * time.Minute):
	}
	_ = l.Close()
	return 0
}

// restoreProvider is a provider whose restore server is the test binary under the name
// restow-pve (so its command line reads like the real one).
func restoreProvider(t *testing.T, mode string) *Provider {
	t.Helper()
	t.Setenv("RESTOW_TEST_SERVE_RESTORE", mode)
	root := t.TempDir()
	exe := filepath.Join(root, "bin", "restow-pve")
	if err := os.MkdirAll(filepath.Dir(exe), 0o700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(self, exe); err != nil {
		t.Fatal(err)
	}
	// A short directory: the socket path must fit into sun_path.
	run, err := os.MkdirTemp("", "rp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(run) })
	oldProc, oldSignal := procRoot, signalProcess
	procRoot = "/proc"
	signalProcess = func(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
	t.Cleanup(func() { procRoot, signalProcess = oldProc, oldSignal })
	return &Provider{Layout: Layout{RunDir: run, DataDir: filepath.Join(root, "data")}, Exe: exe, state: &State{}, server: &Server{}}
}

func restoreReq() ProviderRequest {
	return ProviderRequest{Volname: "backup/vm/101/2030-01-01T00:00:00Z", Device: "drive-scsi0"}
}

func restoreFiles(t *testing.T, p *Provider) []string {
	t.Helper()
	entries, _ := os.ReadDir(p.restoreDir())
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// waitGone waits until the process has ended (a zombie counts as ended: its cmdline is empty).
func waitGone(t *testing.T, pid int) {
	t.Helper()
	for i := 0; i < 100; i++ {
		data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
		if err != nil || len(data) == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("process %d still runs", pid)
}

// A VM restore served its disk and was cleaned up: nothing runs any more, so the node is not
// busy, a boot test is not skipped and a self-update may install. Before, the restore server's
// log stayed in /run/restow-pve/restore and the node counted as busy until it rebooted.
func TestNodeIsIdleAgainAfterAVMRestore(t *testing.T) {
	p := restoreProvider(t, "serve")
	l := p.Layout
	res, err := p.restoreVolumeInit(context.Background(), restoreReq())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := res.(map[string]any)["qemuImgPath"]; !ok {
		t.Fatalf("result %v", res)
	}
	key := restoreKey(restoreReq().Volname, restoreReq().Device)
	pid := readPID(filepath.Join(p.restoreDir(), key+".pid"))
	if !busy(l) {
		t.Fatal("a running restore server does not make the node busy")
	}
	if _, err := p.Handle(context.Background(), "restore-vm-cleanup", restoreReq()); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pid)
	if files := restoreFiles(t, p); len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
	if busy(l) {
		t.Fatal("busy after the restore was cleaned up")
	}
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	b := newTester(t, f)
	b.Layout = l
	b.BackupRunning = nil
	if reason, msg := b.backupBusy(context.Background()); reason != "" {
		t.Fatalf("boot test held back: %s %s", reason, msg)
	}
}

// Files a restore left behind without a live server (a log, a socket, a pid file of a process
// that ended, or one whose pid belongs to another process now) do not make the node busy, and
// the cleanup never signals such a process.
func TestStaleRestoreFilesDoNotMakeTheNodeBusy(t *testing.T) {
	run := t.TempDir()
	l := Layout{RunDir: run}
	dir := filepath.Join(run, "restore")
	_ = os.MkdirAll(dir, 0o700)
	key := restoreKey(restoreReq().Volname, restoreReq().Device)
	for name, data := range map[string]string{key + ".log": "served", key + ".sock": "", "other.log": "x"} {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(data), 0o600)
	}
	if busy(l) {
		t.Fatal("a log and a socket make the node busy")
	}
	proc := t.TempDir()
	oldProc, oldSignal := procRoot, signalProcess
	procRoot = proc
	signalProcess = func(pid int) error { t.Fatalf("signalled %d", pid); return nil }
	defer func() { procRoot, signalProcess = oldProc, oldSignal }()
	// The pid now belongs to a kvm process.
	_ = os.MkdirAll(filepath.Join(proc, "4242"), 0o700)
	_ = os.WriteFile(filepath.Join(proc, "4242", "cmdline"), []byte("/usr/bin/kvm\x00-id\x00105"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, key+".pid"), []byte("4242"), 0o600)
	// And a pid file of a process that ended.
	_ = os.WriteFile(filepath.Join(dir, "0123456789ab-drive-scsi1.pid"), []byte("4243"), 0o600)
	if busy(l) {
		t.Fatal("a stale pid file makes the node busy")
	}
	// A live restore server of that disk does.
	_ = os.WriteFile(filepath.Join(proc, "4242", "cmdline"),
		[]byte("/opt/restow-pve/bin/restow-pve\x00serve-restore\x00--socket\x00"+filepath.Join(dir, key+".sock")), 0o600)
	if !busy(l) {
		t.Fatal("a live restore server does not make the node busy")
	}
	_ = os.WriteFile(filepath.Join(proc, "4242", "cmdline"), []byte("/usr/bin/kvm\x00-id\x00105"), 0o600)
	p := &Provider{Layout: l}
	p.stopRestoreServers(restoreReq().Volname, "")
	if _, err := os.Stat(filepath.Join(dir, key+".log")); !os.IsNotExist(err) {
		t.Fatal("the log of the stopped server stays")
	}
}

// Open backups: a fresh job file, or an old one whose guest has a live provider.
func TestOpenBackupsMakeTheNodeBusy(t *testing.T) {
	run := t.TempDir()
	l := Layout{RunDir: run}
	dir := filepath.Join(run, "jobs")
	_ = os.MkdirAll(dir, 0o700)
	data, _ := json.Marshal(jobState{RunID: "r1", VMID: 101})
	path := filepath.Join(dir, "restow-101.json")
	_ = os.WriteFile(path, data, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "restow-102.log"), []byte("INFO: x"), 0o600)
	if !busy(l) {
		t.Fatal("an open backup does not make the node busy")
	}
	old := time.Now().Add(-49 * time.Hour)
	_ = os.Chtimes(path, old, old)
	proc := t.TempDir()
	oldProc := procRoot
	procRoot = proc
	defer func() { procRoot = oldProc }()
	if busy(l) {
		t.Fatal("a job file older than two days without a provider makes the node busy")
	}
	_ = os.MkdirAll(filepath.Join(proc, "777"), 0o700)
	_ = os.WriteFile(filepath.Join(proc, "777", "cmdline"), []byte("/opt/restow-pve/bin/restow-pve\x00provider\x00backup-vm"), 0o600)
	_ = os.MkdirAll(filepath.Dir(l.providerPIDFile(101)), 0o700)
	_ = os.WriteFile(l.providerPIDFile(101), []byte("777"), 0o600)
	if !busy(l) {
		t.Fatal("a running provider does not make the node busy")
	}
}

// restore-vm-volume-init ends the restore server and removes its files on every way out but a
// served socket: an early end, a server that never opens its socket, a cancelled call.
func TestRestoreVolumeInitLeavesNothingBehindWhenItFails(t *testing.T) {
	t.Run("the server ends", func(t *testing.T) {
		p := restoreProvider(t, "exit")
		_, err := p.restoreVolumeInit(context.Background(), restoreReq())
		if err == nil || !errorsContain(err, "has no disk drive-scsi0") {
			t.Fatalf("err = %v", err)
		}
		if files := restoreFiles(t, p); len(files) != 0 {
			t.Fatalf("files left: %v", files)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		p := restoreProvider(t, "hang")
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			for i := 0; i < 100; i++ {
				if readPID(filepath.Join(p.restoreDir(), restoreKey(restoreReq().Volname, restoreReq().Device)+".pid")) > 0 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			cancel()
		}()
		_, err := p.restoreVolumeInit(ctx, restoreReq())
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
		if files := restoreFiles(t, p); len(files) != 0 {
			t.Fatalf("files left: %v", files)
		}
		if len(liveRestoreServers(p.Layout)) != 0 || busy(p.Layout) {
			t.Fatal("busy after the cancelled init")
		}
	})
	t.Run("no socket in time", func(t *testing.T) {
		p := restoreProvider(t, "hang")
		old := restoreServerStartTimeout
		restoreServerStartTimeout = 300 * time.Millisecond
		defer func() { restoreServerStartTimeout = old }()
		_, err := p.restoreVolumeInit(context.Background(), restoreReq())
		if err == nil || !errorsContain(err, "did not start") {
			t.Fatalf("err = %v", err)
		}
		if files := restoreFiles(t, p); len(files) != 0 {
			t.Fatalf("files left: %v", files)
		}
	})
}

func errorsContain(err error, s string) bool {
	return err != nil && strings.Contains(err.Error(), s)
}
