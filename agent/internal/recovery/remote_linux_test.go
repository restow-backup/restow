//go:build linux

package recovery

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestRemoteUseKeysEndsPasswordSessions: the switch to keys ends the
// sessions of the password phase, not only the listening sshd (10.2
// point 3). The stand-in sshd starts what OpenSSH starts per connection:
// a child in its own session (setsid), and below it a shell with a
// child of its own.
func TestRemoteUseKeysEndsPasswordSessions(t *testing.T) {
	for _, tool := range []string{"sh", "setsid", "sleep"} {
		if _, err := os.Stat("/usr/bin/" + tool); err != nil {
			if _, err := os.Stat("/bin/" + tool); err != nil {
				t.Skipf("%s missing", tool)
			}
		}
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "sshd")
	body := "#!/bin/sh\n" +
		"[ -e " + dir + "/started ] && exec sleep 300\n" +
		": > " + dir + "/started\n" +
		"setsid sh -c 'echo $$ > " + dir + "/session; sleep 300 & echo $! > " + dir + "/shell; wait' &\n" +
		"exec sleep 300\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &Remote{Exec: newFakeExec(), RunDir: filepath.Join(dir, "run"), SSHD: script}
	if err := r.start(SSHDConfig(true, "")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.stop() })
	pid := func(name string) int {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
				if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
					return n
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("%s did not start", name)
		return 0
	}
	session, shell := pid("session"), pid("shell")
	alive := func(p int) bool {
		pe, ok := readProcStat("/proc", p)
		return ok && pe.state != 'Z' && pe.state != 'X'
	}
	if !alive(session) || !alive(shell) {
		t.Fatal("the session did not start")
	}
	if pe, _ := readProcStat("/proc", session); pe.ppid != r.sshd.Process.Pid {
		t.Fatalf("the session's parent is %d, not the sshd %d", pe.ppid, r.sshd.Process.Pid)
	}
	if err := r.UseKeys(context.Background(), []string{"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin"}); err != nil {
		t.Fatal(err)
	}
	for name, p := range map[string]int{"session": session, "shell": shell} {
		if alive(p) {
			t.Errorf("the %s of the password phase (pid %d) still runs after the switch to keys", name, p)
		}
	}
	if !r.Running() {
		t.Error("sshd did not start again")
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, "run", "sshd_config"))
	if !strings.Contains(string(cfg), "PasswordAuthentication no") || !strings.Contains(string(cfg), "AuthorizedKeysFile "+filepath.Join(dir, "run", "authorized_keys")) {
		t.Errorf("sshd_config after the switch:\n%s", cfg)
	}
}
