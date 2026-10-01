// Package runlog collects the log of one run. The last lines are sent to the
// server when the run finishes (`logTail`), so everything that goes in is
// redacted first and each line is bounded.
package runlog

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/redact"
)

// MaxLines is the number of lines kept and reported (spec: last 200 lines).
const MaxLines = 200

// maxLineLen bounds a single line so one runaway line cannot fill the report.
const maxLineLen = 2000

// Log is a ring buffer of redacted lines that also forwards to the agent log.
type Log struct {
	mu      sync.Mutex
	lines   []string
	next    int
	full    bool
	dropped int
	logger  *slog.Logger
	redact  *redact.Redactor
	now     func() time.Time
}

// New creates a run log. logger may be nil.
func New(logger *slog.Logger) *Log {
	return &Log{
		lines:  make([]string, MaxLines),
		logger: logger,
		redact: redact.Default,
		now:    time.Now,
	}
}

// SetClock replaces the time source (tests).
func (l *Log) SetClock(now func() time.Time) { l.now = now }

// Infof records an informational line.
func (l *Log) Infof(format string, args ...any) { l.add("INFO", fmt.Sprintf(format, args...)) }

// Warnf records a warning.
func (l *Log) Warnf(format string, args ...any) { l.add("WARN", fmt.Sprintf(format, args...)) }

// Errorf records an error.
func (l *Log) Errorf(format string, args ...any) { l.add("ERROR", fmt.Sprintf(format, args...)) }

// Raw records output of an external program (restic, hooks) with a source
// prefix, one buffer line per input line.
func (l *Log) Raw(source, text string) {
	for _, line := range strings.Split(strings.TrimRight(text, "\r\n"), "\n") {
		line = strings.TrimSpace(strings.ReplaceAll(line, "\r", ""))
		if line == "" {
			continue
		}
		l.add("INFO", source+": "+line)
	}
}

func (l *Log) add(level, msg string) {
	msg = l.redact.Redact(msg)
	if len(msg) > maxLineLen {
		msg = msg[:maxLineLen] + "...(truncated)"
	}
	line := l.now().UTC().Format("2006-01-02T15:04:05Z") + " " + level + " " + msg
	l.mu.Lock()
	if l.full {
		l.dropped++
	}
	l.lines[l.next] = line
	l.next++
	if l.next == len(l.lines) {
		l.next = 0
		l.full = true
	}
	l.mu.Unlock()
	if l.logger != nil {
		switch level {
		case "ERROR":
			l.logger.Error(msg)
		case "WARN":
			l.logger.Warn(msg)
		default:
			l.logger.Info(msg)
		}
	}
}

// Tail returns the retained lines, oldest first, joined by newlines.
func (l *Log) Tail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	if l.full {
		out = append(out, l.lines[l.next:]...)
		out = append(out, l.lines[:l.next]...)
	} else {
		out = append(out, l.lines[:l.next]...)
	}
	return strings.Join(out, "\n")
}

// Dropped reports how many older lines were pushed out of the buffer.
func (l *Log) Dropped() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.dropped
}
