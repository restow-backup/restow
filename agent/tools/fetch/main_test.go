package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func makeTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "pkg_1.0/README", Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("hi"))
	_ = tw.WriteHeader(&tar.Header{Name: "pkg_1.0/" + name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(content)
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestUnpackTarGzPicksMember(t *testing.T) {
	archive := makeTarGz(t, "rest-server", []byte("binary"))
	out := filepath.Join(t.TempDir(), "sub", "rest-server")
	if err := unpack(bytes.NewReader(archive), "tar.gz", "rest-server", out, 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	if string(b) != "binary" {
		t.Fatalf("content %q", b)
	}
	if st, _ := os.Stat(out); st.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", st.Mode())
	}
	if err := unpack(bytes.NewReader(archive), "tar.gz", "missing", out+"2", 0o755); err == nil {
		t.Fatal("missing member must fail")
	}
}

func TestUnpackBz2AndRaw(t *testing.T) {
	// bzip2 of "hello restic\n" (Python bz2.compress).
	bz := []byte{0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x95, 0x7e, 0xa4, 0x51, 0x00, 0x00, 0x02, 0xd1, 0x80, 0x00, 0x10, 0x40, 0x00, 0x0a, 0x64, 0x9c, 0x00, 0x20, 0x00, 0x22, 0x00, 0xd3, 0x4d, 0x08, 0x06, 0x9a, 0x68, 0x9d, 0x00, 0xe2, 0x3c, 0xdd, 0x2b, 0xc5, 0xdc, 0x91, 0x4e, 0x14, 0x24, 0x25, 0x5f, 0xa9, 0x14, 0x40}
	out := filepath.Join(t.TempDir(), "restic")
	if err := unpack(bytes.NewReader(bz), "bz2", "", out, 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	if string(b) != "hello restic\n" {
		t.Fatalf("content %q", b)
	}
	raw := filepath.Join(t.TempDir(), "raw")
	if err := unpack(strings.NewReader("plain"), "raw", "", raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := unpack(strings.NewReader(""), "raw", "", raw+"2", 0o644); err == nil {
		t.Fatal("empty output must fail")
	}
	if err := unpack(strings.NewReader("x"), "zip", "", raw+"3", 0o644); err == nil {
		t.Fatal("unknown format must fail")
	}
}

func TestRunValidatesArguments(t *testing.T) {
	out := filepath.Join(t.TempDir(), "x")
	cases := []struct{ url, sha, msg string }{
		{"", "", "required"},
		{"http://example.com/x", sum([]byte("x")), "non-HTTPS"},
		{"https://example.com/x", "nothex", "not a SHA-256"},
	}
	for _, c := range cases {
		err := run(c.url, c.sha, "raw", "", out, 0o755)
		if err == nil || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("run(%q, %q): %v, want %q", c.url, c.sha, err, c.msg)
		}
	}
}
