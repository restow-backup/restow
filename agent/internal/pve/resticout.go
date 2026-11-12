//go:build !windows

package pve

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// resticStopGrace is how long restic has after SIGINT to stop cleanly (remove its lock in the
// repository) before it is killed. PVE kills a stopped task's provider soon after asking it to
// stop, so the grace is short; restic itself goes on with its cleanup if the provider dies.
var resticStopGrace = 15 * time.Second

// stopResticGently makes a cancelled context ask restic to stop with SIGINT, as the endpoint
// agent does: a SIGKILLed restic leaves its lock behind, which keeps the server's check and
// retention of the repository out until it is stale.
func stopResticGently(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGINT) }
	cmd.WaitDelay = resticStopGrace
}

// maxResticLine is the part of one output line of restic that is looked at; the rest of a
// longer line is skipped, and reading goes on with the next line.
const maxResticLine = 1 << 20

// lineWriter splits what is written to it into lines, also across writes, and hands each to fn
// (at most maxResticLine bytes of it; truncated says the line was longer). Flush hands over a
// last line without a newline.
type lineWriter struct {
	fn        func(line []byte, truncated bool)
	buf       []byte
	truncated bool
}

func (w *lineWriter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		chunk := p
		if i >= 0 {
			chunk = p[:i]
		}
		if room := maxResticLine - len(w.buf); room < len(chunk) {
			w.buf = append(w.buf, chunk[:max(room, 0)]...)
			w.truncated = true
		} else {
			w.buf = append(w.buf, chunk...)
		}
		if i < 0 {
			break
		}
		w.emit()
		p = p[i+1:]
	}
	return n, nil
}

func (w *lineWriter) emit() {
	w.fn(w.buf, w.truncated)
	w.buf, w.truncated = w.buf[:0], false
	if cap(w.buf) > 64<<10 {
		// One long line must not keep its buffer for the rest of the run.
		w.buf = nil
	}
}

// Flush hands over the last line if it had no newline.
func (w *lineWriter) Flush() {
	if len(w.buf) > 0 || w.truncated {
		w.emit()
	}
}

// resticErrors collects what restic reports while it runs, in bounded memory: the count of
// its error lines (message_type "error": an item it could not read), the first
// maxReportedUnreadable distinct items, and the last lines of its stderr for an error message.
// After an ID map change millions of items can be unreadable, a JSON line each.
type resticErrors struct {
	mu    sync.Mutex
	count int
	items []string
	seen  map[string]bool
	tail  []string
}

// resticTailLines is how many of restic's last stderr lines are kept, each at most
// resticTailLineBytes long.
const (
	resticTailLines     = 10
	resticTailLineBytes = 4 << 10
)

// errorMarker is how restic's JSON error lines start their type; an over-long line is
// recognised by it.
var errorMarker = []byte(`"message_type":"error"`)

// line takes one line of restic's output; tail keeps it for lastLines (stderr).
func (e *resticErrors) line(b []byte, truncated, tail bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if tail {
		s := string(b[:min(len(b), resticTailLineBytes)])
		if strings.TrimSpace(s) != "" {
			if len(e.tail) == resticTailLines {
				copy(e.tail, e.tail[1:])
				e.tail = e.tail[:resticTailLines-1]
			}
			e.tail = append(e.tail, s)
		}
	}
	if truncated {
		// Too long to read as JSON: counted when it is an error line, with no item.
		if bytes.Contains(b, errorMarker) {
			e.count++
		}
		return
	}
	if !bytes.Contains(b, []byte(`"error"`)) {
		return
	}
	var m struct {
		MessageType string `json:"message_type"`
		Item        string `json:"item"`
		Error       struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(b, &m) != nil || m.MessageType != "error" {
		return
	}
	item := m.Item
	if item == "" {
		item = m.Error.Message
	}
	if item == "" {
		return
	}
	e.count++
	if len(e.items) < maxReportedUnreadable {
		if e.seen == nil {
			e.seen = map[string]bool{}
		}
		if !e.seen[item] {
			e.seen[item] = true
			e.items = append(e.items, item)
		} else {
			// The same item twice (on both streams): counted once.
			e.count--
		}
	}
}

// stderr is the writer for restic's stderr.
func (e *resticErrors) stderr() *lineWriter {
	return &lineWriter{fn: func(b []byte, truncated bool) { e.line(b, truncated, true) }}
}

// result is the count of unreadable items and the first of them.
func (e *resticErrors) result() (int, []string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.count, append([]string(nil), e.items...)
}

// lastLines are restic's last stderr lines, joined like lastLines.
func (e *resticErrors) lastLines(n int) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return lastLines(strings.Join(e.tail, "\n"), n)
}
