// Package restic runs the restic binary for the agent. restic does the actual
// work (deduplication, encryption, transfer); this package builds its command
// lines, feeds it the repository credentials through environment variables,
// parses its --json output and maps its exit codes to errors that say what to
// do. Secrets never appear on a command line.
package restic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/procenv"
)

// Runner invokes restic against one repository.
type Runner struct {
	// Bin is the path of the restic executable.
	Bin string
	// Repo is the repository, e.g. rest:https://host/agent/restic/<id>/.
	Repo string
	// Password is the repository password (RESTIC_PASSWORD).
	Password string
	// RESTUser and RESTPass authenticate against the REST backend
	// (RESTIC_REST_USERNAME / RESTIC_REST_PASSWORD).
	RESTUser string
	RESTPass string
	// CacheDir is restic's cache directory.
	CacheDir string
	// TmpDir holds the short-lived option files handed to restic; it also
	// becomes TMPDIR of the process. Must be private (0700).
	TmpDir string
	// Log receives restic's stderr lines and unparseable stdout lines.
	Log func(line string)
	// ExtraEnv is appended to the environment last (tests).
	ExtraEnv []string
	// CancelGrace is how long restic gets to shut down after an interrupt
	// before it is killed. Default 45 s.
	CancelGrace time.Duration
}

func (r *Runner) log(line string) {
	if r.Log != nil {
		r.Log(line)
	}
}

// Env returns the environment of a restic process.
func (r *Runner) Env() []string {
	env := procenv.Base()
	if _, ok := procenv.Get(env, "HOME"); !ok && r.CacheDir != "" {
		env = procenv.Set(env, "HOME", filepath.Dir(r.CacheDir))
	}
	env = procenv.Set(env, "RESTIC_REPOSITORY", r.Repo)
	env = procenv.Set(env, "RESTIC_PASSWORD", r.Password)
	if r.RESTUser != "" {
		env = procenv.Set(env, "RESTIC_REST_USERNAME", r.RESTUser)
		env = procenv.Set(env, "RESTIC_REST_PASSWORD", r.RESTPass)
	}
	if r.CacheDir != "" {
		env = procenv.Set(env, "RESTIC_CACHE_DIR", r.CacheDir)
	}
	if r.TmpDir != "" {
		env = procenv.Set(env, "TMPDIR", r.TmpDir)
	}
	// One status message every two seconds instead of ten per second; the
	// agent forwards the latest one to the server every five seconds (the
	// run drawer draws its charts from those reports).
	env = procenv.Set(env, "RESTIC_PROGRESS_FPS", progressFPS)
	return append(env, r.ExtraEnv...)
}

type execSpec struct {
	// Command names the restic subcommand for error messages.
	Command string
	Args    []string
	// OnStdoutLine receives each stdout line (JSON output). Lines longer than
	// maxLineBytes are dropped.
	OnStdoutLine func(line []byte)
	// OnStderrError receives restic's JSON error messages (message_type
	// "error"), which restic 0.19 writes to stderr, not stdout. They also stay
	// in the stderr tail. Calls to it and to OnStdoutLine never overlap.
	OnStderrError func(line []byte)
	// RawStdout, when set, receives restic's stdout unchanged instead of
	// OnStdoutLine (restic dump).
	RawStdout io.Writer
}

type execResult struct {
	ExitCode int
	Stderr   []string
	// Fatal is restic's own final error message (exit_error), if any.
	Fatal string
}

// progressFPS is RESTIC_PROGRESS_FPS: status messages per second. 0.5 is one
// every two seconds, so the 5 second report to the server always finds a fresh
// one.
const progressFPS = "0.5"

const (
	maxLineBytes  = 1 << 20
	stderrKeep    = 60
	defaultGrace  = 45 * time.Second
	stderrLineCap = 4096
)

func (r *Runner) exec(ctx context.Context, spec execSpec) (*execResult, error) {
	if r.Bin == "" {
		return nil, errors.New("restic binary path is not set")
	}
	cmd := exec.CommandContext(ctx, r.Bin, spec.Args...)
	cmd.Env = r.Env()
	cmd.Stdin = nil
	// Ask restic to stop cleanly (it removes its lock and temporary files) and
	// only kill it when it does not react.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGINT) }
	cmd.WaitDelay = r.CancelGrace
	if cmd.WaitDelay == 0 {
		cmd.WaitDelay = defaultGrace
	}
	res := &execResult{}
	var mu sync.Mutex
	// stdout and stderr are copied by two goroutines: the handlers take turns.
	var handlerMu sync.Mutex
	handle := func(fn func([]byte), line []byte) {
		handlerMu.Lock()
		defer handlerMu.Unlock()
		fn(line)
	}
	stdoutLines := newLineWriter(func(line []byte) {
		if spec.OnStdoutLine != nil {
			handle(spec.OnStdoutLine, line)
		}
	})
	if spec.RawStdout != nil {
		cmd.Stdout = spec.RawStdout
	} else {
		cmd.Stdout = stdoutLines
	}
	cmd.Stderr = newLineWriter(func(line []byte) {
		text := strings.TrimSpace(strings.ReplaceAll(string(line), "\r", ""))
		if len(text) > stderrLineCap {
			text = text[:stderrLineCap] + "...(truncated)"
		}
		kind := peekType(line)
		if kind == msgExitError {
			var ee exitErrorMessage
			if json.Unmarshal(line, &ee) == nil {
				mu.Lock()
				res.Fatal = ee.Message
				mu.Unlock()
				r.log(ee.Message)
				return
			}
		}
		if strings.TrimSpace(text) == "" {
			return
		}
		mu.Lock()
		res.Stderr = append(res.Stderr, text)
		if len(res.Stderr) > stderrKeep {
			res.Stderr = res.Stderr[len(res.Stderr)-stderrKeep:]
		}
		mu.Unlock()
		if kind == msgError && spec.OnStderrError != nil {
			// The handler logs the error in a readable form.
			handle(spec.OnStderrError, line)
			return
		}
		r.log(text)
	})
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("cannot start restic (%s): %w", r.Bin, err)
	}
	// Wait copies the output through the writers above and, with WaitDelay
	// set, does not hang if a grandchild keeps the pipes open.
	waitErr := cmd.Wait()
	stdoutLines.flush()
	cmd.Stderr.(*lineWriter).flush()
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if waitErr != nil {
		var ee *exec.ExitError
		switch {
		case errors.As(waitErr, &ee), errors.Is(waitErr, exec.ErrWaitDelay):
			// Exit code taken from ProcessState above.
		case ctx.Err() != nil:
			res.ExitCode = exitKilledBySignal
		default:
			return res, waitErr
		}
	}
	if res.ExitCode == -1 {
		res.ExitCode = exitKilledBySignal
	}
	return res, nil
}

// lineWriter is an io.Writer that splits its input into lines.
type lineWriter struct {
	mu       sync.Mutex
	fn       func(line []byte)
	acc      []byte
	overflow bool
}

func newLineWriter(fn func(line []byte)) *lineWriter { return &lineWriter{fn: fn} }

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	rest := p
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\n')
		chunk := rest
		if i >= 0 {
			chunk = rest[:i]
		}
		if !w.overflow {
			if len(w.acc)+len(chunk) > maxLineBytes {
				w.overflow = true
				w.acc = w.acc[:0]
			} else {
				w.acc = append(w.acc, chunk...)
			}
		}
		if i < 0 {
			break
		}
		if !w.overflow {
			w.fn(bytes.TrimRight(w.acc, "\r"))
		}
		w.acc, w.overflow = w.acc[:0], false
		rest = rest[i+1:]
	}
	return len(p), nil
}

func (w *lineWriter) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.acc) > 0 && !w.overflow {
		w.fn(bytes.TrimRight(w.acc, "\r"))
	}
	w.acc, w.overflow = nil, false
}

// failure builds the error for a non-zero exit.
func failure(command string, res *execResult) *Error {
	e := &Error{Command: command, ExitCode: res.ExitCode, Stderr: stderrTail(res.Stderr, 10), Fatal: res.Fatal}
	switch {
	case res.Fatal != "":
		e.Message = res.Fatal
	case len(res.Stderr) > 0:
		e.Message = res.Stderr[len(res.Stderr)-1]
	}
	return e
}

var versionRe = regexp.MustCompile(`restic\s+(\d+\.\d+\.\d+\S*)`)

// Version returns the restic version (for example "0.19.1").
func (r *Runner) Version(ctx context.Context) (string, error) {
	var out []string
	res, err := r.exec(ctx, execSpec{Command: "version", Args: []string{"version"},
		OnStdoutLine: func(l []byte) { out = append(out, string(l)) }})
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", failure("version", res)
	}
	if m := versionRe.FindStringSubmatch(strings.Join(out, "\n")); m != nil {
		return m[1], nil
	}
	return "", fmt.Errorf("cannot parse restic version output %q", strings.Join(out, " "))
}

// CheckAccess reads the repository config: it proves that the repository
// exists, the credentials are accepted and the password is right.
func (r *Runner) CheckAccess(ctx context.Context) error {
	res, err := r.exec(ctx, execSpec{Command: "cat", Args: []string{"cat", "config", "--retry-lock", "1m"}})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return failure("cat config", res)
	}
	return nil
}

// Unlock removes stale locks (restic only removes locks that are provably
// stale: dead process on this host, or not refreshed for 30 minutes).
func (r *Runner) Unlock(ctx context.Context) error {
	res, err := r.exec(ctx, execSpec{Command: "unlock", Args: []string{"unlock"}})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return failure("unlock", res)
	}
	return nil
}

// privateTempDir creates a 0700 directory under TmpDir for option files.
func (r *Runner) privateTempDir(prefix string) (string, func(), error) {
	base := r.TmpDir
	if base == "" {
		base = os.TempDir()
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", nil, err
	}
	dir, err := os.MkdirTemp(base, prefix)
	if err != nil {
		return "", nil, err
	}
	return dir, func() { _ = os.RemoveAll(dir) }, nil
}
