package share

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func u32(v uint32) *uint32 { return &v }
func u64(v uint64) *uint64 { return &v }

// goldenSidecar writes the sidecar of testdata/sidecar/v1-basic.jsonl.
func goldenSidecar(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := NewSidecarWriter(&buf, SidecarHeader{Protocol: ProtocolSMB, Xattr: XattrNTSDFull,
		Created: "2026-10-10T22:00:03Z", Runner: "0.4.0", Reused: 0})
	mustNoErr(t, err)
	sdA := &Descriptor{Raw: []byte("descriptor-A")}
	sdB := &Descriptor{Raw: []byte("descriptor-B")}
	mustNoErr(t, w.Entry(SidecarEntry{Path: "", Descriptor: sdA, Attrs: u32(16)}))
	mustNoErr(t, w.Entry(SidecarEntry{Path: "Finance", Descriptor: sdA, Attrs: u32(16), CTime: 1760133603000000000}))
	mustNoErr(t, w.Entry(SidecarEntry{Path: "Finance/2026/Q3.xlsx", Descriptor: sdB, Attrs: u32(32),
		Created: u64(133701234567890000), CTime: 1760133603123456789, Size: 4096}))
	mustNoErr(t, w.Entry(SidecarEntry{Path: "Gr\xfc\xdfe.txt", Descriptor: sdB}))
	mustNoErr(t, w.Error("HR/locked", "EACCES"))
	mustNoErr(t, w.Entry(SidecarEntry{Path: "HR/locked"}))
	mustNoErr(t, w.Entry(SidecarEntry{Path: "Ünïcode/ok", Descriptor: &Descriptor{Posix: &PosixACL{Access: []byte{2, 0, 0, 0}}}}))
	mustNoErr(t, w.Close())
	return buf.Bytes()
}

func gunzip(t *testing.T, b []byte) string {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(b))
	mustNoErr(t, err)
	out, err := io.ReadAll(r)
	mustNoErr(t, err)
	return string(out)
}

func gz(t *testing.T, text string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, err := w.Write([]byte(text))
	mustNoErr(t, err)
	mustNoErr(t, w.Close())
	return buf.Bytes()
}

func TestSidecarWriterMatchesGolden(t *testing.T) {
	got := gunzip(t, goldenSidecar(t))
	golden := filepath.Join("testdata", "sidecar", "v1-basic.jsonl")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		mustNoErr(t, os.WriteFile(golden, []byte(got), 0o644))
	}
	want, err := os.ReadFile(golden)
	mustNoErr(t, err)
	if got != string(want) {
		t.Fatalf("sidecar differs from %s:\n%s", golden, got)
	}
	// Descriptors are written once, before their first use.
	if n := strings.Count(got, `"t":"d"`); n != 3 {
		t.Fatalf("want 3 descriptor lines, got %d", n)
	}
	if strings.Index(got, `"t":"d","id":"`+(Descriptor{Raw: []byte("descriptor-B")}).ID()) >
		strings.Index(got, `"p":"Finance/2026/Q3.xlsx"`) {
		t.Fatal("descriptor B is written after its first use")
	}
}

func TestSidecarReaderReadsGolden(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "sidecar", "v1-basic.jsonl"))
	mustNoErr(t, err)
	var entries []SidecarEntry
	var errs []SidecarError
	res, err := ReadSidecar(bytes.NewReader(gz(t, string(data))), func(r SidecarRecord) error {
		if r.Entry != nil {
			entries = append(entries, *r.Entry)
		}
		if r.Error != nil {
			errs = append(errs, *r.Error)
		}
		return nil
	})
	mustNoErr(t, err)
	if res.Header.Protocol != ProtocolSMB || res.Header.Xattr != XattrNTSDFull || res.Trailer == nil {
		t.Fatalf("header/trailer: %+v %+v", res.Header, res.Trailer)
	}
	if res.Trailer.Entries != 6 || res.Trailer.Descriptors != 3 || res.Trailer.Errors != 1 {
		t.Fatalf("trailer: %+v", res.Trailer)
	}
	if len(entries) != 6 || len(errs) != 1 || errs[0].Path != "HR/locked" || errs[0].Errno != "EACCES" {
		t.Fatalf("records: %d entries, errors %+v", len(entries), errs)
	}
	q3 := entries[2]
	if q3.Path != "Finance/2026/Q3.xlsx" || string(q3.Descriptor.Raw) != "descriptor-B" || *q3.Attrs != 32 ||
		*q3.Created != 133701234567890000 || q3.CTime != 1760133603123456789 || q3.Size != 4096 {
		t.Fatalf("entry: %+v", q3)
	}
	if entries[3].Path != "Gr\xfc\xdfe.txt" {
		t.Fatalf("non-UTF-8 path: %q", entries[3].Path)
	}
	if entries[4].Descriptor != nil {
		t.Fatal("an entry without descriptor got one")
	}
	if entries[5].Descriptor.Posix == nil || !bytes.Equal(entries[5].Descriptor.Posix.Access, []byte{2, 0, 0, 0}) {
		t.Fatalf("posix descriptor: %+v", entries[5].Descriptor)
	}
}

func TestSidecarReaderToleratesUnknownAndIncomplete(t *testing.T) {
	text := `{"t":"h","format":"restow-share-permissions","v":1,"protocol":"nfs","xattr":"system.nfs4_acl","future":true}
{"t":"d","id":"aa","b":"AQID"}
{"t":"q","whatever":1}
{"t":"e","p":"a","d":"aa","newfield":"x"}
not json at all
{"t":"e","p":"b","d":"unknown-id"}
`
	var got []SidecarEntry
	res, err := ReadSidecar(bytes.NewReader(gz(t, text)), func(r SidecarRecord) error {
		got = append(got, *r.Entry)
		return nil
	})
	mustNoErr(t, err)
	if res.Trailer != nil {
		t.Fatal("a sidecar without trailer must read as incomplete")
	}
	if len(got) != 2 || !bytes.Equal(got[0].Descriptor.Raw, []byte{1, 2, 3}) || got[1].Descriptor != nil {
		t.Fatalf("entries: %+v", got)
	}

	// A cut-off gzip stream is incomplete, not an error.
	full := gz(t, text)
	_, err = ReadSidecar(bytes.NewReader(full[:len(full)-10]), func(SidecarRecord) error { return nil })
	mustNoErr(t, err)
}

func TestSidecarReaderRefusesNewerVersionAndOtherFormats(t *testing.T) {
	newer := `{"t":"h","format":"restow-share-permissions","v":2,"protocol":"smb"}` + "\n" + `{"t":"e","p":"a"}` + "\n"
	called := false
	_, err := ReadSidecar(bytes.NewReader(gz(t, newer)), func(SidecarRecord) error { called = true; return nil })
	if !errors.Is(err, ErrSidecarNewer) || called {
		t.Fatalf("newer: err %v, called %v", err, called)
	}
	other := `{"t":"h","format":"something-else","v":1}` + "\n"
	if _, err := ReadSidecar(bytes.NewReader(gz(t, other)), func(SidecarRecord) error { return nil }); err == nil {
		t.Fatal("another format was accepted")
	}
	if _, err := ReadSidecar(bytes.NewReader(gz(t, `{"t":"e","p":"a"}`+"\n")), func(SidecarRecord) error { return nil }); err == nil {
		t.Fatal("a sidecar without header was accepted")
	}
	if _, err := ReadSidecar(bytes.NewReader(gz(t, "")), func(SidecarRecord) error { return nil }); err == nil {
		t.Fatal("an empty sidecar was accepted")
	}
	if _, err := ReadSidecar(strings.NewReader("plain"), func(SidecarRecord) error { return nil }); err == nil {
		t.Fatal("a non-gzip stream was accepted")
	}
}

func TestSidecarStopEarly(t *testing.T) {
	n := 0
	res, err := ReadSidecar(bytes.NewReader(goldenSidecar(t)), func(SidecarRecord) error { n++; return ErrStopSidecar })
	mustNoErr(t, err)
	if n != 1 || res.Header.Xattr != XattrNTSDFull {
		t.Fatalf("stop: n=%d header %+v", n, res.Header)
	}
}

func TestDescriptorID(t *testing.T) {
	// The first 16 hex characters of the SHA-256 of the raw bytes.
	if id := (Descriptor{Raw: []byte("abc")}).ID(); id != "ba7816bf8f01cfea" {
		t.Fatalf("id %s", id)
	}
	if (Descriptor{}).Empty() != true || (Descriptor{Posix: &PosixACL{}}).Empty() != true {
		t.Fatal("empty descriptors")
	}
}
