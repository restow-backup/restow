package redact

import (
	"bytes"
	"io"
	"sync"
)

// Writer redacts whatever is written through it, line by line, before passing
// it on. A partial trailing line is held back until its newline arrives (or
// Flush is called), so a secret split across two writes is still caught.
type Writer struct {
	mu  sync.Mutex
	w   io.Writer
	r   *Redactor
	buf []byte
}

// NewWriter wraps w. A nil redactor selects Default.
func NewWriter(w io.Writer, r *Redactor) *Writer {
	if r == nil {
		r = Default
	}
	return &Writer{w: w, r: r}
}

// Write implements io.Writer. It always reports len(p) as written on success.
func (rw *Writer) Write(p []byte) (int, error) {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	rw.buf = append(rw.buf, p...)
	for {
		i := bytes.IndexByte(rw.buf, '\n')
		if i < 0 {
			break
		}
		line := string(rw.buf[:i+1])
		rw.buf = rw.buf[i+1:]
		if _, err := io.WriteString(rw.w, rw.r.Redact(line)); err != nil {
			return len(p), err
		}
	}
	// Bound the held-back partial line so a stream without newlines cannot
	// grow memory without limit.
	if len(rw.buf) > 64*1024 {
		chunk := string(rw.buf)
		rw.buf = rw.buf[:0]
		if _, err := io.WriteString(rw.w, rw.r.Redact(chunk)); err != nil {
			return len(p), err
		}
	}
	return len(p), nil
}

// Flush writes a held-back partial line.
func (rw *Writer) Flush() error {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	if len(rw.buf) == 0 {
		return nil
	}
	chunk := string(rw.buf)
	rw.buf = rw.buf[:0]
	_, err := io.WriteString(rw.w, rw.r.Redact(chunk))
	return err
}
