package payload

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Paths of the live system in the recovery ISO (live-build).
const (
	KernelPath   = "/live/vmlinuz"
	InitrdPath   = "/live/initrd.img"
	SquashfsPath = "/live/filesystem.squashfs"
	// SumsPath is live-build's list of the image's files and their SHA-256.
	SumsPath = "/sha256sum.txt"
)

// Paths inside the appended archive (docs/BAREMETAL-ONESHOT.md 8.6, 9.1):
// live-boot finds the medium in MediumDir (live-media=/restow/medium), the
// init-bottom script of the ISO moves DataPath to /run/restow-oneshot.
const (
	MediumDir    = "restow/medium"
	SquashfsName = MediumDir + "/live/filesystem.squashfs"
	DataPath     = "restow/oneshot.json"
	// MaxDataBytes bounds the session data.
	MaxDataBytes = 256 << 10
)

// LiveFiles are the three files of the live system, each checked against
// live-build's sha256sum.txt of the same image. That list is no proof of
// authenticity (the signed checksums of the release are, checked before);
// it guards against a mistake of this reader.
type LiveFiles struct {
	Kernel, Initrd, Squashfs *io.SectionReader
	// SHA256 of each file, by ISO path.
	SHA256 map[string]string
}

var reSumLine = regexp.MustCompile(`^([0-9a-f]{64}) [ *]\.?/?(\S+)$`)

// LiveFiles opens the kernel, the initrd and the live file system and checks
// their SHA-256 against sha256sum.txt of the image.
func (iso *ISO) LiveFiles() (*LiveFiles, error) {
	sums, err := iso.ReadFile(SumsPath, 4<<20)
	if err != nil {
		return nil, fmt.Errorf("the recovery ISO has no list of checksums: %w", err)
	}
	want := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		m := reSumLine.FindStringSubmatch(strings.TrimRight(sc.Text(), "\r"))
		if m != nil {
			if _, dup := want["/"+m[2]]; dup {
				return nil, fmt.Errorf("sha256sum.txt names %s twice", m[2])
			}
			want["/"+m[2]] = m[1]
		}
	}
	lf := &LiveFiles{SHA256: map[string]string{}}
	for _, f := range []struct {
		path string
		dst  **io.SectionReader
	}{{KernelPath, &lf.Kernel}, {InitrdPath, &lf.Initrd}, {SquashfsPath, &lf.Squashfs}} {
		sr, err := iso.Open(f.path)
		if err != nil {
			return nil, err
		}
		w, ok := want[f.path]
		if !ok {
			return nil, fmt.Errorf("sha256sum.txt does not name %s", f.path)
		}
		h := sha256.New()
		if _, err := io.Copy(h, io.NewSectionReader(sr, 0, sr.Size())); err != nil {
			return nil, fmt.Errorf("read %s: %w", f.path, err)
		}
		if got := hex.EncodeToString(h.Sum(nil)); got != w {
			return nil, fmt.Errorf("%s has SHA-256 %s, the image lists %s", f.path, got, w)
		}
		lf.SHA256[f.path] = w
		*f.dst = sr
	}
	return lf, nil
}

// Assemble writes the initrd a oneshot restore loads: the ISO's initrd as it
// is, zero bytes up to a multiple of four, then one uncompressed newc archive
// with the live file system under MediumDir and the session data (0600) at
// DataPath. The kernel unpacks concatenated archives one after the other,
// compressed or not. It returns the number of bytes written.
func Assemble(w io.Writer, initrd io.Reader, squashfs io.Reader, squashfsSize int64, data []byte) (int64, error) {
	if len(data) == 0 || len(data) > MaxDataBytes {
		return 0, fmt.Errorf("session data of %d bytes (1 to %d)", len(data), MaxDataBytes)
	}
	if squashfsSize <= 0 {
		return 0, errors.New("the live file system is empty")
	}
	cw := &countWriter{w: w}
	if _, err := io.Copy(cw, initrd); err != nil {
		return cw.n, fmt.Errorf("copy the initrd: %w", err)
	}
	if err := pad(cw, 4); err != nil {
		return cw.n, err
	}
	a := NewCPIO(cw)
	for _, d := range []string{"restow", MediumDir, MediumDir + "/live"} {
		if err := a.Dir(d, 0o755); err != nil {
			return cw.n, err
		}
	}
	if err := a.File(SquashfsName, 0o644, squashfsSize, squashfs); err != nil {
		return cw.n, err
	}
	if err := a.File(DataPath, 0o600, int64(len(data)), bytes.NewReader(data)); err != nil {
		return cw.n, err
	}
	if err := a.Close(); err != nil {
		return cw.n, err
	}
	return cw.n, nil
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

var zeros [512]byte

func pad(cw *countWriter, to int64) error {
	if r := cw.n % to; r != 0 {
		_, err := cw.Write(zeros[:to-r])
		return err
	}
	return nil
}
