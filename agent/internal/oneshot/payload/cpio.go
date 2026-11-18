package payload

import (
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

// CPIO writes an uncompressed newc ("070701") archive as the kernel unpacks it
// into the initramfs: every header and every file body starts at a multiple of
// four bytes, the archive ends with TRAILER!!! and is padded to 512 bytes.
// Entries are owned by root, with modification time 0 (the archive is the
// same for the same input).
type CPIO struct {
	w   io.Writer
	n   int64
	ino uint32
	err error
}

// NewCPIO starts an archive on w; w must be at a multiple of four bytes.
func NewCPIO(w io.Writer) *CPIO { return &CPIO{w: w, ino: 1} }

const (
	modeDir  = 0o040000
	modeFile = 0o100000
)

func cleanName(name string) error {
	switch {
	case name == "" || strings.HasPrefix(name, "/") || path.Clean(name) != name:
		return fmt.Errorf("archive name %q is not a clean relative path", name)
	case name == "." || name == ".." || strings.HasPrefix(name, "../"):
		return fmt.Errorf("archive name %q leaves the archive", name)
	case strings.ContainsAny(name, "\x00\n"):
		return fmt.Errorf("archive name %q", name)
	}
	return nil
}

func (c *CPIO) write(p []byte) {
	if c.err != nil {
		return
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	c.err = err
}

func (c *CPIO) align() {
	if r := c.n % 4; r != 0 {
		c.write(zeros[:4-r])
	}
}

func (c *CPIO) header(name string, mode uint32, size int64) {
	if size < 0 || size > 0xFFFFFFFF {
		c.err = fmt.Errorf("%s: %d bytes do not fit a newc header", name, size)
		return
	}
	nlink := uint32(1)
	if mode&modeDir != 0 {
		nlink = 2
	}
	c.ino++
	hdr := fmt.Sprintf("070701%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X%08X",
		c.ino, mode, 0, 0, nlink, 0, uint32(size), 0, 0, 0, 0, len(name)+1, 0)
	c.write([]byte(hdr))
	c.write([]byte(name))
	c.write([]byte{0})
	c.align()
}

// Dir adds a directory.
func (c *CPIO) Dir(name string, perm uint32) error {
	if err := cleanName(name); err != nil {
		return err
	}
	c.header(name, modeDir|perm&0o7777, 0)
	return c.err
}

// File adds a regular file of exactly size bytes from r.
func (c *CPIO) File(name string, perm uint32, size int64, r io.Reader) error {
	if err := cleanName(name); err != nil {
		return err
	}
	c.header(name, modeFile|perm&0o7777, size)
	if c.err != nil {
		return c.err
	}
	n, err := io.Copy(writerFunc(c.write), io.LimitReader(r, size))
	if c.err != nil {
		return c.err
	}
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if n != size {
		return fmt.Errorf("%s: %d of %d bytes", name, n, size)
	}
	c.align()
	return c.err
}

// Close writes the trailer and pads the archive to 512 bytes.
func (c *CPIO) Close() error {
	c.header("TRAILER!!!", 0, 0)
	if r := c.n % 512; r != 0 && c.err == nil {
		c.write(zeros[:512-r])
	}
	if c.err == nil && c.n%4 != 0 {
		return errors.New("archive not aligned")
	}
	return c.err
}

type writerFunc func([]byte)

func (f writerFunc) Write(p []byte) (int, error) {
	f(p)
	return len(p), nil
}
