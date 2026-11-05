//go:build linux

package recovery

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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
// written, sshd restarts with PasswordAuthentication no (a running
// password session ends).
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
	r.stop()
	if err := r.start(SSHDConfig(false, ak)); err != nil {
		return err
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
	bin, err := Resolve("sshd")
	if err != nil {
		return err
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

func (r *Remote) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sshd != nil && r.sshd.Process != nil {
		_ = r.sshd.Process.Kill()
	}
	r.sshd = nil
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
