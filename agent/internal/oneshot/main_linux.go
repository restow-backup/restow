//go:build linux

package oneshot

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/recovery"
	"github.com/restow-backup/restow/agent/internal/release"
)

// MainOptions are the flags of restow-agent oneshot.
type MainOptions struct {
	Instance    string
	CodeStdin   bool
	AnswersFile string
	Lang        string
	Keymap      string
	Version     string
	Direct      bool
	ResticBin   string
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
}

var reSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// spkiRecorder keeps the SHA-256 of the public key of the leaf the last
// verified TLS connection presented (docs/BAREMETAL-ONESHOT.md 5.1): recover
// accepts the same instance by it when the recovery environment lacks the
// certificate's root.
type spkiRecorder struct {
	mu  sync.Mutex
	sum string
}

func (r *spkiRecorder) verify(cs tls.ConnectionState) error {
	if len(cs.PeerCertificates) == 0 {
		return errors.New("no certificate")
	}
	h := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
	r.mu.Lock()
	r.sum = hex.EncodeToString(h[:])
	r.mu.Unlock()
	return nil
}

func (r *spkiRecorder) get() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sum
}

// httpClient trusts the system's roots, or the CA file; the chain is checked
// as usual before the recorder sees it. No redirect is followed.
func httpClient(caPEM []byte, rec *spkiRecorder) (*http.Client, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, VerifyConnection: rec.verify}
	if len(caPEM) > 0 {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, errors.New("RESTOW_CA_FILE holds no PEM certificate")
		}
		cfg.RootCAs = pool
	}
	tr := &http.Transport{TLSClientConfig: cfg, Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true,
		TLSHandshakeTimeout: 30 * time.Second, ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 90 * time.Second}
	return &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

// Main runs restow-agent oneshot. The code comes on the first line of
// stdin (the script pipes it in, so it is in no process list); the console
// dialogs then read the terminal.
func Main(o MainOptions) int {
	if runtime.GOARCH != "amd64" || !kexecSupported {
		fmt.Fprintln(o.Stderr, "restow-agent oneshot: this machine is not x86_64; use the recovery ISO")
		return ExitRefused
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(o.Stderr, "restow-agent oneshot: run as root")
		return ExitUsage
	}
	if o.Instance == "" || !o.CodeStdin {
		fmt.Fprintln(o.Stderr, "usage: echo <code> | restow-agent oneshot --instance <url> --code-stdin [--answers <file>] [--lang de|en] [--keymap us]")
		return ExitUsage
	}
	code, err := bufio.NewReader(io.LimitReader(o.Stdin, 256)).ReadString('\n')
	if err != nil && code == "" {
		fmt.Fprintln(o.Stderr, "restow-agent oneshot: no code on stdin")
		return ExitUsage
	}
	if o.Direct && o.ResticBin == "" {
		fmt.Fprintln(o.Stderr, "restow-agent oneshot --direct needs --restic <checked restic>")
		return ExitUsage
	}
	opts := Options{Instance: o.Instance, Code: strings.TrimSpace(code), Direct: o.Direct, ResticBin: o.ResticBin,
		Lang: o.Lang, Keymap: o.Keymap, Version: o.Version}
	if o.AnswersFile != "" {
		b, err := os.ReadFile(o.AnswersFile)
		if err == nil {
			opts.Answers, err = ParseAnswers(b)
		}
		if err != nil {
			fmt.Fprintln(o.Stderr, err)
			return ExitUsage
		}
		if opts.Lang == "" {
			opts.Lang = opts.Answers.Language
		}
		if opts.Keymap == "" {
			opts.Keymap = opts.Answers.Keymap
		}
	}
	if opts.Lang == "" {
		opts.Lang = recovery.LangEN
		if strings.HasPrefix(os.Getenv("LANG"), "de") {
			opts.Lang = recovery.LangDE
		}
	}
	if opts.Lang != recovery.LangDE && opts.Lang != recovery.LangEN {
		fmt.Fprintln(o.Stderr, "--lang must be de or en")
		return ExitUsage
	}
	if sums := strings.ToLower(strings.TrimSpace(os.Getenv("RESTOW_SHA256SUMS_SHA256"))); sums != "" {
		if !reSHA256.MatchString(sums) {
			fmt.Fprintln(o.Stderr, "RESTOW_SHA256SUMS_SHA256 is not a SHA-256")
			return ExitUsage
		}
		opts.Trust.TrustedSumsSHA256 = sums
	} else if k, err := release.TrustedKey(); err == nil {
		opts.Trust.Key = k
	}
	opts.Trust.AgentVersion = o.Version
	if p := os.Getenv("RESTOW_CA_FILE"); p != "" {
		b, err := os.ReadFile(p)
		if err != nil {
			fmt.Fprintln(o.Stderr, err)
			return ExitUsage
		}
		opts.CAPEM = b
	}
	opts.AllowHTTP = os.Getenv("RESTOW_ALLOW_INSECURE_HTTP") != ""
	rec := &spkiRecorder{}
	if opts.HTTP, err = httpClient(opts.CAPEM, rec); err != nil {
		fmt.Fprintln(o.Stderr, err)
		return ExitUsage
	}
	opts.SPKI = rec.get
	in := io.Reader(strings.NewReader(""))
	if opts.Answers == nil {
		tty, err := os.OpenFile("/dev/tty", os.O_RDWR|syscall.O_NOCTTY, 0)
		if err != nil {
			fmt.Fprintln(o.Stderr, "restow-agent oneshot: no terminal to confirm the disks on; run it in an SSH session or the provider's console, or pass --answers")
			return ExitUsage
		}
		defer tty.Close()
		in = tty
	}
	ui := &recovery.UI{In: in, Out: o.Stdout, Lang: opts.Lang, Serial: true}
	env := &LinuxEnv{Runner: cmdrun.ExecRunner{}, Stdin: in, Stdout: o.Stdout, Stderr: o.Stderr}
	c := &Command{UI: ui, Env: env, Opts: opts}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-sigs
		cancel()
		ui.Abort()
	}()
	return c.Run(ctx)
}
