package sqlserver

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// memFS is the smallest FS for the journal tests.
type memFS struct{ files map[string][]byte }

func (m *memFS) FreeBytes(string) (uint64, error)            { return 1 << 40, nil }
func (m *memFS) MkdirWithSIDs(string, []string) error        { return nil }
func (m *memFS) SetReadSIDs(string, []string) error          { return nil }
func (m *memFS) PrepareStagingRoot(r string) (string, error) { return r, nil }
func (m *memFS) RemoveAll(string) error                      { return nil }
func (m *memFS) Volume(string) (VolumeFacts, error)          { return VolumeFacts{}, nil }
func (m *memFS) WriteFile(p string, b []byte) error          { m.files[p] = b; return nil }
func (m *memFS) SHA256File(context.Context, string) (string, int64, error) {
	return "", 0, errors.New("no")
}
func (m *memFS) ReadFile(p string) ([]byte, error) {
	b, ok := m.files[p]
	if !ok {
		return nil, os.ErrNotExist
	}
	return b, nil
}

func read(s string) Output { return ReadOutput(strings.NewReader(s), nil) }

func TestReadOutputAndFinish(t *testing.T) {
	var progress []int
	out := ReadOutput(strings.NewReader("\xef\xbb\xbf{\"type\":\"progress\",\"step\":\"backup\",\"percent\":5}\r\n"+
		"{\"type\":\"sqlmessage\",\"number\":3014,\"class\":0,\"message\":\"BACKUP DATABASE successfully processed\"}\n\n"+
		"{\"type\":\"result\",\"data\":{\"a\":1}}\n"), func(l Line) { progress = append(progress, l.Percent) })
	if out.Bad != "" || string(out.Result) != `{"a":1}` || len(out.Messages) != 1 || len(progress) != 1 || progress[0] != 5 {
		t.Fatalf("%+v %v", out, progress)
	}
	if r := Finish(out, 0, nil, false, false, ""); !r.OK() {
		t.Fatalf("%+v", r)
	}
	// A result with exit 2, or an error with exit 0: the script is broken.
	if r := Finish(out, 2, nil, false, false, ""); r.OK() || r.Problem.Code != api.SQLScriptFailed {
		t.Fatalf("%+v", r)
	}
	errOut := read(`{"type":"error","problem":{"code":"sql_login_missing","step":"connect","number":18456,"message":"Login failed"}}`)
	if r := Finish(errOut, 2, nil, false, false, ""); r.OK() || r.Problem.Code != api.SQLLoginMissing || r.Problem.Number != 18456 {
		t.Fatalf("%+v", r)
	}
	// The trap of the script wrote an error and exit 3: a crash, with its message.
	if r := Finish(errOut, 3, nil, false, false, ""); r.Problem.Code != api.SQLScriptFailed || !strings.Contains(r.Problem.Message, "exit code 3") {
		t.Fatalf("%+v", r.Problem)
	}
	// Nothing at all, with error output.
	if r := Finish(read(""), -1073741510, nil, false, false, "Unhandled exception"); r.Problem.Code != api.SQLScriptFailed ||
		!strings.Contains(r.Problem.Message, "Unhandled exception") {
		t.Fatalf("%+v", r.Problem)
	}
	if r := Finish(read(""), 0, nil, true, false, ""); !r.TimedOut || r.OK() {
		t.Fatalf("%+v", r)
	}
	if r := Finish(read(""), 0, nil, false, true, ""); !r.Cancelled || r.OK() {
		t.Fatalf("%+v", r)
	}
	if r := Finish(read(""), 0, errors.New("file not found"), false, false, ""); !strings.Contains(r.Problem.Message, "could not be started") {
		t.Fatalf("%+v", r)
	}
}

func TestReadOutputRefusesGarbage(t *testing.T) {
	for name, s := range map[string]string{
		"text":          "Ausnahme beim Aufrufen von \"Open\"\n",
		"array":         "[1,2]\n",
		"unknown type":  `{"type":"surprise"}` + "\n",
		"two results":   `{"type":"result","data":{}}` + "\n" + `{"type":"result","data":{}}` + "\n",
		"empty result":  `{"type":"result"}` + "\n",
		"empty error":   `{"type":"error"}` + "\n",
		"error, result": `{"type":"error","problem":{"code":"x"}}` + "\n" + `{"type":"result","data":{}}` + "\n",
		"long line":     `{"type":"sqlmessage","message":"` + strings.Repeat("x", MaxLineBytes) + `"}` + "\n" + `{"type":"result","data":{}}`,
	} {
		out := read(s)
		if out.Bad == "" {
			t.Errorf("%s: accepted", name)
			continue
		}
		if r := Finish(out, 0, nil, false, false, ""); r.OK() || r.Problem.Code != api.SQLScriptFailed {
			t.Errorf("%s: %+v", name, r)
		}
	}
	// Too much output in all.
	var b strings.Builder
	line := `{"type":"progress","step":"backup","percent":1}` + "\n"
	for b.Len() <= MaxOutputBytes {
		b.WriteString(line)
	}
	b.WriteString(`{"type":"result","data":{}}`)
	if out := read(b.String()); out.Bad == "" || out.Result != nil {
		t.Fatalf("%d bytes accepted", b.Len())
	}
	// Messages are bounded in number and length.
	b.Reset()
	for i := 0; i < 300; i++ {
		b.WriteString(`{"type":"sqlmessage","message":"` + strings.Repeat("y", 2000) + `"}` + "\n")
	}
	out := read(b.String())
	if len(out.Messages) != maxKeptMessages || len([]rune(out.Messages[0].Message)) != api.MaxSQLMessageRunes {
		t.Fatalf("%d messages", len(out.Messages))
	}
}

func TestBoundMessage(t *testing.T) {
	if got := BoundMessage("a\x00b\nc\xff"); got != "a b c" {
		t.Fatalf("%q", got)
	}
}
