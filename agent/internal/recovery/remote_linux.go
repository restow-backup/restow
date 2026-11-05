//go:build linux

package recovery

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// Remote is the remote access of the recovery system (10.2 point 3): off
// at the start; before the exchange a one-time root password (twelve
// characters of the code alphabet), after it only the keys from the web
// interface. It ends with the restart.
type Remote struct {
	Exec   Exec
	RunDir string
	// SSHD is the sshd binary; "" resolves it among the ISO's tools
	// (tests set a stand-in).
	SSHD string

	mu   sync.Mutex
	sshd *exec.Cmd
	keys bool
}

func (r *Remote) dir() string {
	if r.RunDir == "" {
		return "/run/restow-recovery"
	}
	return r.RunDir
}

// OneTimePassword makes the root password of the password phase.
func OneTimePassword() (string, error) {
	var b strings.Builder
	for i := 0; i < 12; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(Alphabet))))
		if err != nil {
			return "", err
		}
		b.WriteByte(Alphabet[n.Int64()])
	}
	return b.String(), nil
}

// SSHDConfig is the configuration of sshd for recover.
func SSHDConfig(passwords bool, authorizedKeys string) string {
	pw := "no"
	if passwords {
		pw = "yes"
	}
	var b strings.Builder
	b.WriteString("# written by restow-agent recover\n")
	b.WriteString("Port 22\nPermitRootLogin yes\nMaxAuthTries 3\nMaxStartups 3:50:10\nLoginGraceTime 30\n")
	fmt.Fprintf(&b, "PasswordAuthentication %s\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n", pw)
	if authorizedKeys != "" {
		fmt.Fprintf(&b, "AuthorizedKeysFile %s\n", authorizedKeys)
	}
	b.WriteString("X11Forwarding no\nAllowTcpForwarding no\nAllowAgentForwarding no\nPermitTunnel no\nPrintMotd no\n")
	return b.String()
}

// EnablePassword starts sshd with a one-time root password; it returns
// the password (shown on the console only) and the host key fingerprints.
func (r *Remote) EnablePassword(ctx context.Context) (string, []api.RecoverySSHHostKey, error) {
	if _, err := r.Exec.Run(ctx, RunSpec{Argv: []string{"ssh-keygen", "-A"}, Timeout: time.Minute}); err != nil {
		return "", nil, err
	}
	pw, err := OneTimePassword()
	if err != nil {
		return "", nil, err
	}
	redact.Add(pw)
	line := []byte("root:" + pw + "\n")
	_, err = r.Exec.Run(ctx, RunSpec{Argv: []string{"chpasswd"}, Stdin: line, StdinSecret: true, Timeout: time.Minute})
	zero(line)
	if err != nil {
		return "", nil, err
	}
	if err := r.start(SSHDConfig(true, "")); err != nil {
		return "", nil, err
	}
	keys, err := r.HostKeys(ctx)
	return pw, keys, err
}

// UseKeys switches to the keys from the web interface: authorized_keys is
// written, the password is locked, sshd and every process below it (the
// per-connection children OpenSSH starts in their own session, their
// shells and what those started) are killed, and sshd starts again with
// PasswordAuthentication no. It fails, and the switch is not reported,
// when a process of the password phase is still alive afterwards.
func (r *Remote) UseKeys(ctx context.Context, keys []string) error {
	r.mu.Lock()
	running := r.sshd != nil
	r.mu.Unlock()
	if !running {
		return nil
	}
	var b strings.Builder
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" || strings.ContainsAny(k, "\n\r") {
			continue
		}
		b.WriteString(k + "\n")
	}
	ak := filepath.Join(r.dir(), "authorized_keys")
	if err := os.WriteFile(ak, []byte(b.String()), 0o600); err != nil {
		return err
	}
	// Locking the password makes it useless even if sshd kept it.
	_, _ = r.Exec.Run(ctx, RunSpec{Argv: []string{"chpasswd", "-e"}, Stdin: []byte("root:!\n"), Timeout: time.Minute})
	stopErr := r.stop()
	if err := r.start(SSHDConfig(false, ak)); err != nil {
		return err
	}
	if stopErr != nil {
		return stopErr
	}
	r.mu.Lock()
	r.keys = true
	r.mu.Unlock()
	return nil
}

func (r *Remote) start(config string) error {
	if err := os.MkdirAll(r.dir(), 0o700); err != nil {
		return err
	}
	cfg := filepath.Join(r.dir(), "sshd_config")
	if err := os.WriteFile(cfg, []byte(config), 0o600); err != nil {
		return err
	}
	bin := r.SSHD
	if bin == "" {
		var err error
		if bin, err = Resolve("sshd"); err != nil {
			return err
		}
	}
	_ = os.MkdirAll("/run/sshd", 0o755)
	cmd := exec.Command(bin, "-D", "-e", "-f", cfg)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	if err := cmd.Start(); err != nil {
		return err
	}
	r.mu.Lock()
	r.sshd = cmd
	r.mu.Unlock()
	go func() { _ = cmd.Wait() }()
	return nil
}

// stop ends sshd and every process below it. Killing the listener alone
// leaves the established connections running (OpenSSH forks one child per
// connection, sshd-session from 9.8 on, and that child calls setsid, so
// neither the listener's process group nor a death signal reaches it).
func (r *Remote) stop() error {
	r.mu.Lock()
	cmd := r.sshd
	r.sshd = nil
	r.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return killTree("/proc", cmd.Process.Pid, 5*time.Second)
}

// procEntry is one process of /proc: its parent, state and start time
// (field 22 of stat, which tells a reused pid apart).
type procEntry struct {
	ppid  int
	state byte
	start string
}

func readProcStat(proc string, pid int) (procEntry, bool) {
	b, err := os.ReadFile(filepath.Join(proc, strconv.Itoa(pid), "stat"))
	if err != nil {
		return procEntry{}, false
	}
	// The command name is in parentheses and may hold spaces and ')'.
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return procEntry{}, false
	}
	f := strings.Fields(string(b[i+1:]))
	// f[0] is field 3 (state), f[1] field 4 (ppid), f[19] field 22.
	if len(f) < 20 || len(f[0]) != 1 {
		return procEntry{}, false
	}
	ppid, err := strconv.Atoi(f[1])
	if err != nil {
		return procEntry{}, false
	}
	return procEntry{ppid: ppid, state: f[0][0], start: f[19]}, true
}

// descendants are root and every process below it, with their start times.
func descendants(proc string, root int) map[int]string {
	ents, _ := os.ReadDir(proc)
	children := map[int][]int{}
	starts := map[int]string{}
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if pe, ok := readProcStat(proc, pid); ok {
			children[pe.ppid] = append(children[pe.ppid], pid)
			starts[pid] = pe.start
		}
	}
	out := map[int]string{}
	if pe, ok := readProcStat(proc, root); ok {
		out[root] = pe.start
	}
	queue := []int{root}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		for _, c := range children[p] {
			if _, seen := out[c]; !seen {
				out[c] = starts[c]
				queue = append(queue, c)
			}
		}
	}
	return out
}

// killTree stops root and everything below it with SIGSTOP until a scan
// finds nothing new (a stopped process cannot fork, and a child of a
// stopped process is not reparented), kills them all with SIGKILL and
// waits until none of them is alive any more (gone, a zombie or its pid
// reused by another start time).
func killTree(proc string, root int, wait time.Duration) error {
	seen := map[int]string{}
	for round := 0; round < 64; round++ {
		found := false
		for pid, start := range descendants(proc, root) {
			if _, ok := seen[pid]; ok {
				continue
			}
			found = true
			seen[pid] = start
			_ = syscall.Kill(pid, syscall.SIGSTOP)
		}
		if !found {
			break
		}
	}
	for pid := range seen {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	deadline := time.Now().Add(wait)
	for {
		var alive []int
		for pid, start := range seen {
			if pe, ok := readProcStat(proc, pid); ok && pe.start == start && pe.state != 'Z' && pe.state != 'X' {
				alive = append(alive, pid)
			}
		}
		if len(alive) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			sort.Ints(alive)
			return fmt.Errorf("remote access: processes of the previous sshd still run: %v", alive)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Running reports whether remote access is on.
func (r *Remote) Running() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.sshd != nil }

// HostKeys are the fingerprints of the host keys (ssh-keygen -l).
func (r *Remote) HostKeys(ctx context.Context) ([]api.RecoverySSHHostKey, error) {
	files, _ := filepath.Glob("/etc/ssh/ssh_host_*_key.pub")
	var out []api.RecoverySSHHostKey
	for _, f := range files {
		res, err := r.Exec.Run(ctx, RunSpec{Argv: []string{"ssh-keygen", "-l", "-f", f}, Timeout: time.Minute})
		if err != nil {
			continue
		}
		fields := strings.Fields(string(res.Output))
		if len(fields) >= 4 {
			out = append(out, api.RecoverySSHHostKey{Type: strings.Trim(fields[len(fields)-1], "()"), Fingerprint: fields[1]})
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no host keys")
	}
	return out, nil
}
