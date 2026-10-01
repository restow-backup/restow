// Package logging sets up the agent's structured log: text lines on stderr
// (captured by journald or launchd) and in a size-rotated file, always passed
// through the secret redactor.
package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// RotatingFile is an io.WriteCloser that moves agent.log to agent.log.1 (and
// so on) once it grows past MaxBytes, keeping at most Keep old files.
type RotatingFile struct {
	Path     string
	MaxBytes int64
	Keep     int

	mu   sync.Mutex
	f    *os.File
	size int64
}

// NewRotatingFile opens (creating directories as needed) the log file.
func NewRotatingFile(path string, maxBytes int64, keep int) (*RotatingFile, error) {
	r := &RotatingFile{Path: path, MaxBytes: maxBytes, Keep: keep}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *RotatingFile) open() error {
	if err := os.MkdirAll(filepath.Dir(r.Path), 0o750); err != nil {
		return err
	}
	f, err := os.OpenFile(r.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	r.f, r.size = f, st.Size()
	return nil
}

// Write implements io.Writer.
func (r *RotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	if r.MaxBytes > 0 && r.size+int64(len(p)) > r.MaxBytes && r.size > 0 {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *RotatingFile) rotate() error {
	if err := r.f.Close(); err != nil {
		return err
	}
	r.f = nil
	if r.Keep > 0 {
		_ = os.Remove(fmt.Sprintf("%s.%d", r.Path, r.Keep))
		for i := r.Keep - 1; i >= 1; i-- {
			_ = os.Rename(fmt.Sprintf("%s.%d", r.Path, i), fmt.Sprintf("%s.%d", r.Path, i+1))
		}
		if err := os.Rename(r.Path, r.Path+".1"); err != nil {
			return err
		}
	} else if err := os.Remove(r.Path); err != nil {
		return err
	}
	return r.open()
}

// Close closes the current file.
func (r *RotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}
