// Command fetch downloads a release artifact, verifies its SHA-256 against a
// pinned value and unpacks it. It is a build-time helper for build.sh and the
// integration tests (restic and rest-server ship as .bz2 and .tar.gz, and the
// Go build image has no bzip2). It is not part of the shipped agent.
//
//	go run ./tools/fetch -url URL -sha256 HEX -format bz2 -out dist/restic
//
// Formats: raw (store as is), bz2 (decompress a single file), tar.gz (extract
// the member whose base name is -member).
package main

import (
	"archive/tar"
	"compress/bzip2"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// maxDownload bounds a download (restic is about 10 MB).
const maxDownload = 200 << 20

func main() {
	url := flag.String("url", "", "https URL of the artifact")
	want := flag.String("sha256", "", "expected SHA-256 of the downloaded file (hex)")
	format := flag.String("format", "raw", "raw | bz2 | tar.gz")
	member := flag.String("member", "", "tar.gz: base name of the file to extract")
	out := flag.String("out", "", "output file")
	mode := flag.Uint("mode", 0o755, "output file mode")
	flag.Parse()
	if err := run(*url, *want, *format, *member, *out, os.FileMode(*mode)); err != nil {
		fmt.Fprintln(os.Stderr, "fetch:", err)
		os.Exit(1)
	}
}

func run(url, want, format, member, out string, mode os.FileMode) error {
	if url == "" || want == "" || out == "" {
		return errors.New("-url, -sha256 and -out are required")
	}
	if !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("refusing non-HTTPS URL %q", url)
	}
	want = strings.ToLower(strings.TrimSpace(want))
	if raw, err := hex.DecodeString(want); err != nil || len(raw) != 32 {
		return fmt.Errorf("-sha256 %q is not a SHA-256", want)
	}
	tmp, err := os.CreateTemp(filepath.Dir(out), ".fetch-*")
	if err != nil {
		if mkErr := os.MkdirAll(filepath.Dir(out), 0o755); mkErr != nil {
			return mkErr
		}
		if tmp, err = os.CreateTemp(filepath.Dir(out), ".fetch-*"); err != nil {
			return err
		}
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	got, err := download(url, tmp)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("SHA-256 mismatch for %s\n  expected %s\n  got      %s\nThe pinned checksum in tools.env is authoritative; do not continue.", url, want, got)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return unpack(tmp, format, member, out, mode)
}

func download(url string, dst io.Writer) (string, error) {
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, h), io.LimitReader(resp.Body, maxDownload+1))
	if err != nil {
		return "", err
	}
	if n > maxDownload {
		return "", fmt.Errorf("GET %s: larger than %d bytes", url, maxDownload)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func unpack(src io.Reader, format, member, out string, mode os.FileMode) error {
	var body io.Reader
	switch format {
	case "raw":
		body = src
	case "bz2":
		body = bzip2.NewReader(src)
	case "tar.gz":
		gz, err := gzip.NewReader(src)
		if err != nil {
			return err
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		found := false
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if hdr.Typeflag == tar.TypeReg && path.Base(hdr.Name) == member {
				body, found = tr, true
				break
			}
		}
		if !found {
			return fmt.Errorf("member %q not found in the archive", member)
		}
	default:
		return fmt.Errorf("unknown format %q", format)
	}
	dir := filepath.Dir(out)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dst, err := os.CreateTemp(dir, ".unpack-*")
	if err != nil {
		return err
	}
	name := dst.Name()
	defer os.Remove(name)
	n, err := io.Copy(dst, io.LimitReader(body, 4*maxDownload))
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("the unpacked file is empty")
	}
	if err := os.Chmod(name, mode); err != nil {
		return err
	}
	return os.Rename(name, out)
}
