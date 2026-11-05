package sqlserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/restow-backup/restow/agent/internal/api"
)

// ScriptRunner runs sql.ps1 with one request. progress receives the
// progress lines as they come (may be nil). It never fails on its own: a
// script that cannot start, crashes, writes garbage or runs over its limit
// ends with a Problem (code sql_script_failed, or Result.TimedOut).
type ScriptRunner interface {
	Run(ctx context.Context, req Request, progress func(Line)) Result
}

// Result is how one script run ended: Data on success, else Problem.
type Result struct {
	Data    json.RawMessage
	Problem *Problem
	// Messages are the informational messages of SQL Server (bounded).
	Messages []Line
	ExitCode int
	// TimedOut: the agent ended the script at its limit (KillAfter).
	TimedOut bool
	// Cancelled: the run was stopped (the context ended).
	Cancelled bool
}

// OK reports whether the operation succeeded.
func (r Result) OK() bool { return r.Problem == nil && len(r.Data) > 0 }

// Decode reads the result data into v.
func (r Result) Decode(v any) error {
	if !r.OK() {
		return errors.New("the operation has no result")
	}
	return json.Unmarshal(r.Data, v)
}

// Bounds of the script's output.
const (
	MaxLineBytes    = 64 << 10
	MaxOutputBytes  = 4 << 20
	MaxStderrBytes  = 16 << 10
	maxKeptMessages = 200
)

// ErrUnsupported is returned where the native SQL Server backup cannot run
// (any system but Windows).
var ErrUnsupported = errors.New("the native SQL Server backup runs on Windows only")

// NewRequest builds the request of an operation with every fixed statement.
func NewRequest(op, instance string, step time.Duration, params any) (Request, error) {
	req := Request{Protocol: Protocol, Op: op, Instance: instance, DataSource: DataSourceFor(instance),
		StepTimeoutSeconds: int(step / time.Second), Statements: Statements()}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return Request{}, err
		}
		req.Params = raw
	}
	return req, nil
}

// EncodeRequest writes the request as JSON with every character outside
// ASCII escaped (\uXXXX), so no console code page can change a database
// name on its way to the script.
func EncodeRequest(req Request) ([]byte, error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.Grow(len(raw))
	for len(raw) > 0 {
		r, size := utf8.DecodeRune(raw)
		if r < utf8.RuneSelf {
			b.WriteByte(raw[0])
		} else if r > 0xFFFF {
			r1, r2 := surrogates(r)
			fmt.Fprintf(&b, `\u%04x\u%04x`, r1, r2)
		} else {
			fmt.Fprintf(&b, `\u%04x`, r)
		}
		raw = raw[size:]
	}
	return b.Bytes(), nil
}

func surrogates(r rune) (rune, rune) {
	r -= 0x10000
	return 0xD800 + (r>>10)&0x3FF, 0xDC00 + r&0x3FF
}

// KillAfter is when the agent ends a script that is still running: the
// statement limit for each step of the operation plus five minutes (the
// driver itself aborts a statement at the step limit, C5).
func KillAfter(req Request) time.Duration {
	step := time.Duration(req.StepTimeoutSeconds) * time.Second
	if step <= 0 {
		step = time.Hour
	}
	steps := 2
	switch req.Op {
	case OpBackup:
		steps = 3
	case OpRestore:
		steps = 3
	case OpVerify:
		steps = 4
	case OpDrop:
		var p DropParams
		_ = json.Unmarshal(req.Params, &p)
		steps = max(1, len(p.Names))
	}
	return time.Duration(steps)*step + 5*time.Minute
}

// Output is what the script wrote to stdout, as read by ReadOutput.
type Output struct {
	Result   json.RawMessage
	Problem  *Problem
	Messages []Line
	// Bad says why the output is not usable ("" when it is).
	Bad string
}

// ReadOutput reads the script's JSON lines with their bounds (MaxLineBytes
// per line, MaxOutputBytes in all). Progress lines go to progress at once.
// A line that is no JSON object of a known type, a line too long, too much
// output or a second result make the output bad (sql_script_failed). It
// reads r to its end (or to the bound) and returns.
func ReadOutput(r io.Reader, progress func(Line)) Output {
	var out Output
	br := bufio.NewReaderSize(io.LimitReader(r, MaxOutputBytes+1), 64<<10)
	var total int64
	bad := func(format string, args ...any) {
		if out.Bad == "" {
			out.Bad = fmt.Sprintf(format, args...)
		}
	}
	for {
		line, tooLong, err := readLine(br)
		total += int64(len(line)) + 1
		if total > MaxOutputBytes {
			bad("the SQL Server script wrote more than %d MiB", MaxOutputBytes>>20)
			_, _ = io.Copy(io.Discard, br)
			break
		}
		if tooLong {
			bad("the SQL Server script wrote a line longer than %d KiB", MaxLineBytes>>10)
		} else if s := bytes.TrimSpace(line); len(s) > 0 {
			readOne(&out, s, progress, bad)
		}
		if err != nil {
			break
		}
	}
	return out
}

func readOne(out *Output, s []byte, progress func(Line), bad func(string, ...any)) {
	// A byte order mark at the start of the output is no error.
	s = bytes.TrimPrefix(s, []byte("\xef\xbb\xbf"))
	var l Line
	if s[0] != '{' || json.Unmarshal(s, &l) != nil {
		bad("the SQL Server script wrote something that is not JSON: %q", shorten(string(s), 200))
		return
	}
	switch l.Type {
	case LineProgress:
		if progress != nil {
			progress(l)
		}
	case LineSQLMessage:
		if len(out.Messages) < maxKeptMessages {
			l.Message = BoundMessage(l.Message)
			out.Messages = append(out.Messages, l)
		}
	case LineResult:
		if out.Result != nil || out.Problem != nil || len(l.Data) == 0 || l.Data[0] != '{' {
			bad("the SQL Server script wrote a second or an empty result")
			return
		}
		out.Result = l.Data
	case LineError:
		if out.Result != nil || out.Problem != nil || l.Problem == nil {
			bad("the SQL Server script wrote a second or an empty error")
			return
		}
		p := *l.Problem
		p.Message = BoundMessage(p.Message)
		out.Problem = &p
	default:
		bad("the SQL Server script wrote a line of an unknown type %q", shorten(l.Type, 40))
	}
}

// readLine reads one line of at most MaxLineBytes; longer lines are
// consumed and reported.
func readLine(br *bufio.Reader) ([]byte, bool, error) {
	var buf []byte
	tooLong := false
	for {
		chunk, err := br.ReadSlice('\n')
		if tooLong || len(buf)+len(chunk) > MaxLineBytes {
			tooLong = true
			buf = nil
		} else {
			buf = append(buf, chunk...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimRight(buf, "\r\n"), tooLong, err
	}
}

// Finish turns what was read into a Result: exit code 0 needs a result, 2
// an error; anything else, bad output, a start failure or a script ended at
// its limit is a problem of the script itself. stderr is a bounded tail of
// the script's error output (it goes into the run log by the caller).
func Finish(out Output, exitCode int, startErr error, timedOut, cancelled bool, stderr string) Result {
	res := Result{Messages: out.Messages, ExitCode: exitCode, TimedOut: timedOut, Cancelled: cancelled}
	scriptFailed := func(msg string) {
		if s := strings.TrimSpace(stderr); s != "" {
			msg += " Error output: " + shorten(s, 400)
		}
		res.Problem = &Problem{Code: api.SQLScriptFailed, Step: StepScript, Message: BoundMessage(msg)}
	}
	switch {
	case startErr != nil:
		scriptFailed("The SQL Server script could not be started: " + startErr.Error() + ".")
	case cancelled:
		res.Problem = &Problem{Code: api.SQLScriptFailed, Step: StepScript, Message: "The SQL Server script was stopped because the run was stopped."}
	case timedOut:
		res.Problem = &Problem{Code: api.SQLScriptFailed, Step: StepScript, Message: "The SQL Server script did not finish within its time limit and was ended."}
		if out.Problem != nil {
			res.Problem.Step = out.Problem.Step
		}
	case out.Bad != "":
		scriptFailed(upperFirst(out.Bad) + ".")
	case exitCode == ExitOK && out.Result != nil && out.Problem == nil:
		res.Data = out.Result
	case exitCode == ExitHandled && out.Problem != nil && out.Result == nil:
		p := *out.Problem
		if p.Code == "" {
			p.Code = api.SQLScriptFailed
		}
		res.Problem = &p
	case out.Problem != nil:
		// The script's own trap: it says what stopped it.
		p := *out.Problem
		p.Code = api.SQLScriptFailed
		p.Message = BoundMessage(fmt.Sprintf("%s (exit code %d)", p.Message, exitCode))
		res.Problem = &p
	default:
		scriptFailed(fmt.Sprintf("The SQL Server script ended with exit code %d without a result.", exitCode))
	}
	return res
}

// BoundMessage keeps a message printable and at most MaxSQLMessageRunes.
func BoundMessage(s string) string {
	s = strings.ToValidUTF8(s, "")
	var b strings.Builder
	n := 0
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			r = ' '
		}
		if n == api.MaxSQLMessageRunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

func shorten(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "..."
}

func upperFirst(s string) string {
	if s == "" {
		return s
	}
	r, size := utf8.DecodeRuneInString(s)
	return strings.ToUpper(string(r)) + s[size:]
}

// tailBuffer keeps the last n bytes written to it.
type tailBuffer struct {
	n   int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.n {
		t.buf = t.buf[len(t.buf)-t.n:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return strings.ToValidUTF8(string(t.buf), "") }
