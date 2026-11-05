package cmdrun

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TB is the part of testing.TB the fake needs (so this file does not
// import package testing into the agent binary).
type TB interface {
	Helper()
	Errorf(format string, args ...any)
}

// Recorded is the recorded result of one command.
type Recorded struct {
	Stdout string
	Stderr string
	Exit   int
}

// FakeRunner answers commands from recordings. A recording is keyed by the
// exact argv (name and arguments). A call that has no recording fails the
// test, unless AllowMissing is set, then it behaves as if the tool were not
// installed; a call with a Forbidden argument always fails the test.
type FakeRunner struct {
	T TB
	// AllowMissing answers unrecorded calls with ErrNotFound instead of
	// failing the test.
	AllowMissing bool

	mu     sync.Mutex
	recs   map[string]Recorded
	calls  [][]string
	used   []string
	noKill map[string]bool
}

// NewFake returns an empty fake.
func NewFake(t TB) *FakeRunner { return &FakeRunner{T: t, recs: map[string]Recorded{}} }

func key(argv []string) string { return strings.Join(argv, "\x00") }

// Add records the answer to argv.
func (f *FakeRunner) Add(argv []string, stdout string, exit int) *FakeRunner {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.recs == nil {
		f.recs = map[string]Recorded{}
	}
	f.recs[key(argv)] = Recorded{Stdout: stdout, Exit: exit}
	return f
}

// AddRecorded records a full answer.
func (f *FakeRunner) AddRecorded(argv []string, r Recorded) *FakeRunner {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.recs == nil {
		f.recs = map[string]Recorded{}
	}
	f.recs[key(argv)] = r
	return f
}

// LoadDir reads recordings from dir: for each <n>.cmd (one argument per
// line, the first is the tool), <n>.out holds stdout, <n>.err stderr and
// <n>.exit the exit code (absent: 0).
func LoadDir(t TB, dir string) (*FakeRunner, error) {
	f := NewFake(t)
	cmds, err := filepath.Glob(filepath.Join(dir, "*.cmd"))
	if err != nil {
		return nil, err
	}
	for _, c := range cmds {
		raw, err := os.ReadFile(c)
		if err != nil {
			return nil, err
		}
		argv := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
		base := strings.TrimSuffix(c, ".cmd")
		var r Recorded
		if b, err := os.ReadFile(base + ".out"); err == nil {
			r.Stdout = string(b)
		}
		if b, err := os.ReadFile(base + ".err"); err == nil {
			r.Stderr = string(b)
		}
		if b, err := os.ReadFile(base + ".exit"); err == nil {
			n, err := strconv.Atoi(strings.TrimSpace(string(b)))
			if err != nil {
				return nil, fmt.Errorf("%s.exit: %w", base, err)
			}
			r.Exit = n
		}
		if _, dup := f.recs[key(argv)]; dup {
			return nil, fmt.Errorf("%s: argv recorded twice", c)
		}
		f.recs[key(argv)] = r
	}
	return f, nil
}

// Run answers from the recordings.
func (f *FakeRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	argv := append([]string{name}, args...)
	f.mu.Lock()
	f.calls = append(f.calls, argv)
	r, ok := f.recs[key(argv)]
	f.used = append(f.used, key(argv))
	f.mu.Unlock()
	return f.answer(ctx, argv, r, ok)
}

func (f *FakeRunner) answer(ctx context.Context, argv []string, r Recorded, ok bool) ([]byte, error) {
	name := argv[0]
	if err := Forbidden(argv); err != nil {
		if f.T != nil {
			f.T.Helper()
			f.T.Errorf("forbidden command: %q", argv)
		}
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !ok {
		if !f.AllowMissing && f.T != nil {
			f.T.Helper()
			f.T.Errorf("unrecorded command: %q", argv)
		}
		return nil, fmt.Errorf("%s: %w", name, exec.ErrNotFound)
	}
	if r.Exit == 127 {
		return nil, fmt.Errorf("%s: %w", name, exec.ErrNotFound)
	}
	if r.Exit != 0 {
		return []byte(r.Stdout), &ExitError{Argv: argv, Code: r.Exit, Stderr: r.Stderr}
	}
	return []byte(r.Stdout), nil
}

// RunNoKill answers like Run and notes that argv ran without being
// killable; the caller's cancellation does not reach it.
func (f *FakeRunner) RunNoKill(ctx context.Context, _ time.Duration, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	if f.noKill == nil {
		f.noKill = map[string]bool{}
	}
	f.noKill[key(append([]string{name}, args...))] = true
	f.mu.Unlock()
	return f.Run(context.WithoutCancel(ctx), name, args...)
}

// StdinMarker is what the fake records in place of the input of RunInput:
// the size, never the content (a passphrase must not end up in a test log).
func StdinMarker(n int) string { return fmt.Sprintf("<stdin:%d bytes>", n) }

// RunInput answers like Run for argv; the call is recorded with
// StdinMarker appended (the recording is looked up without it).
func (f *FakeRunner) RunInput(ctx context.Context, stdin []byte, _ time.Duration, _ int, name string, args ...string) ([]byte, error) {
	return f.runInput(ctx, false, stdin, name, args...)
}

// RunInputNoKill is RunInput through the no-kill path.
func (f *FakeRunner) RunInputNoKill(ctx context.Context, stdin []byte, _ time.Duration, _ int, name string, args ...string) ([]byte, error) {
	return f.runInput(context.WithoutCancel(ctx), true, stdin, name, args...)
}

func (f *FakeRunner) runInput(ctx context.Context, noKill bool, stdin []byte, name string, args ...string) ([]byte, error) {
	argv := append([]string{name}, args...)
	f.mu.Lock()
	f.calls = append(f.calls, append(append([]string(nil), argv...), StdinMarker(len(stdin))))
	r, ok := f.recs[key(argv)]
	if noKill {
		if f.noKill == nil {
			f.noKill = map[string]bool{}
		}
		f.noKill[key(argv)] = true
	}
	f.used = append(f.used, key(argv))
	f.mu.Unlock()
	return f.answer(ctx, argv, r, ok)
}

// RanNoKill reports whether argv ran through RunNoKill.
func (f *FakeRunner) RanNoKill(argv []string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.noKill[key(argv)]
}

// Calls returns the argv of every call so far, in order.
func (f *FakeRunner) Calls() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]string, len(f.calls))
	copy(out, f.calls)
	return out
}

// CallLines renders the calls one per line (golden files).
func (f *FakeRunner) CallLines() string {
	var b strings.Builder
	for _, c := range f.Calls() {
		b.WriteString(strings.Join(c, " "))
		b.WriteByte('\n')
	}
	return b.String()
}

// Unused lists the recordings no call used (sorted), to keep fixtures tidy.
func (f *FakeRunner) Unused() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	used := map[string]bool{}
	for _, k := range f.used {
		used[k] = true
	}
	var out []string
	for k := range f.recs {
		if !used[k] {
			out = append(out, strings.ReplaceAll(k, "\x00", " "))
		}
	}
	sort.Strings(out)
	return out
}
