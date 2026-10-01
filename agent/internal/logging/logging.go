package logging

import (
	"io"
	"log/slog"
	"os"

	"github.com/restow-backup/restow/agent/internal/redact"
)

// Options configures Setup.
type Options struct {
	// LogFile is the rotating log file; empty disables file logging.
	LogFile string
	// Stderr enables logging to stderr.
	Stderr bool
	// Debug enables debug level.
	Debug bool
}

// Setup builds the process logger. The returned close function flushes and
// closes the log file. A log file that cannot be opened is not fatal: the
// error is reported on stderr and logging continues there.
func Setup(o Options) (*slog.Logger, func()) {
	var sinks []io.Writer
	var closers []io.Closer
	if o.Stderr {
		sinks = append(sinks, os.Stderr)
	}
	var fileErr error
	if o.LogFile != "" {
		f, err := NewRotatingFile(o.LogFile, 5<<20, 3)
		if err != nil {
			fileErr = err
			if !o.Stderr {
				sinks = append(sinks, os.Stderr)
			}
		} else {
			sinks = append(sinks, f)
			closers = append(closers, f)
		}
	}
	if len(sinks) == 0 {
		sinks = append(sinks, io.Discard)
	}
	w := redact.NewWriter(io.MultiWriter(sinks...), redact.Default)
	level := slog.LevelInfo
	if o.Debug {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: level}))
	if fileErr != nil {
		logger.Warn("cannot open the agent log file; logging to stderr only", "path", o.LogFile, "error", fileErr)
	}
	return logger, func() {
		_ = w.Flush()
		for _, c := range closers {
			_ = c.Close()
		}
	}
}

// Discard returns a logger that drops everything (tests).
func Discard() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
