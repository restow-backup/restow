package share

import (
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"unicode/utf8"
)

// The permissions sidecar (docs/FILESHARES.md 4.6): /.restow/acls.jsonl.gz in
// every snapshot, gzip of JSON Lines. The TypeScript reader
// (packages/core/src/file-shares/sidecar.ts, Phase B) shares the golden files
// in testdata/sidecar/.

// SidecarFormat is the header's `format`.
const SidecarFormat = "restow-share-permissions"

// SidecarVersion is the format version this package writes and reads.
const SidecarVersion = 1

// SidecarFile is the sidecar's name inside the scratch folder (/.restow).
const SidecarFile = "acls.jsonl.gz"

// ManifestFile is the manifest's name inside the scratch folder.
const ManifestFile = "manifest.json"

// ErrStopSidecar ends ReadSidecar early without an error when the callback returns it.
var ErrStopSidecar = errors.New("stop reading the sidecar")

// ErrSidecarNewer: the sidecar has a higher version than this reader knows;
// permissions are skipped with one warning (acl_format_newer).
var ErrSidecarNewer = errors.New("the permissions were saved in a newer format")

// SidecarHeader is the first line.
type SidecarHeader struct {
	T        string `json:"t"`
	Format   string `json:"format"`
	V        int    `json:"v"`
	Protocol string `json:"protocol"`
	// Xattr names what the descriptors hold: system.cifs_ntsd_full,
	// system.cifs_ntsd, system.cifs_acl, system.nfs4_acl, posix, or none.
	Xattr   string `json:"xattr"`
	Created string `json:"created"`
	Runner  string `json:"runner"`
	Reused  int    `json:"reused"`
}

// SidecarTrailer is the last line; a sidecar without it is incomplete.
type SidecarTrailer struct {
	T           string `json:"t"`
	Entries     int    `json:"entries"`
	Descriptors int    `json:"descriptors"`
	Errors      int    `json:"errors"`
}

// PosixACL is the descriptor of an NFSv3 file: its two POSIX ACL xattrs.
type PosixACL struct {
	Access  []byte `json:"access,omitempty"`
	Default []byte `json:"default,omitempty"`
}

// Descriptor is the permissions of one or more files: the raw xattr value
// (SMB security descriptor, NFSv4 ACL) or a POSIX ACL pair.
type Descriptor struct {
	Raw   []byte
	Posix *PosixACL
}

// ID is the first 16 hex characters of the SHA-256 of the descriptor's bytes
// (for POSIX ACLs: of its JSON form).
func (d Descriptor) ID() string {
	sum := sha256.Sum256(d.bytes())
	return hex.EncodeToString(sum[:])[:16]
}

func (d Descriptor) bytes() []byte {
	if d.Posix != nil {
		b, _ := json.Marshal(d.Posix)
		return b
	}
	return d.Raw
}

// Empty: nothing was captured.
func (d Descriptor) Empty() bool {
	return len(d.Raw) == 0 && (d.Posix == nil || (len(d.Posix.Access) == 0 && len(d.Posix.Default) == 0))
}

// SidecarEntry is one file or folder.
type SidecarEntry struct {
	// Path is relative to the share root, '/'-separated, "" for the root.
	Path       string
	Descriptor *Descriptor
	// Attrs are the DOS attributes (SMB), when read.
	Attrs *uint32
	// Created is the creation time in 100 ns units since 1601 (SMB).
	Created *uint64
	// CTime (ns since 1970) and Size are what the ACL reuse of the next run
	// compares (4.3); not part of the restore.
	CTime int64
	Size  int64
}

// SidecarError is a path whose permissions could not be read.
type SidecarError struct {
	Path  string
	Errno string
}

type descriptorLine struct {
	T  string          `json:"t"`
	ID string          `json:"id"`
	B  json.RawMessage `json:"b"`
}

type entryLine struct {
	T  string  `json:"t"`
	P  *string `json:"p,omitempty"`
	PB string  `json:"pb,omitempty"`
	D  string  `json:"d,omitempty"`
	A  *uint32 `json:"a,omitempty"`
	C  string  `json:"c,omitempty"`
	CT string  `json:"ct,omitempty"`
	S  *int64  `json:"s,omitempty"`
}

type errorLine struct {
	T   string  `json:"t"`
	P   *string `json:"p,omitempty"`
	PB  string  `json:"pb,omitempty"`
	Err string  `json:"err"`
}

// SidecarWriter writes a sidecar. Safe for concurrent use.
type SidecarWriter struct {
	mu      sync.Mutex
	gz      *gzip.Writer
	buf     *bufio.Writer
	seen    map[string]bool
	trailer SidecarTrailer
	closed  bool
}

// NewSidecarWriter writes the header and returns the writer.
func NewSidecarWriter(w io.Writer, h SidecarHeader) (*SidecarWriter, error) {
	gz := gzip.NewWriter(w)
	sw := &SidecarWriter{gz: gz, buf: bufio.NewWriterSize(gz, 64*1024), seen: map[string]bool{},
		trailer: SidecarTrailer{T: "z"}}
	h.T, h.Format, h.V = "h", SidecarFormat, SidecarVersion
	if err := sw.line(h); err != nil {
		return nil, err
	}
	return sw, nil
}

func (w *SidecarWriter) line(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := w.buf.Write(b); err != nil {
		return err
	}
	return w.buf.WriteByte('\n')
}

func pathFields(p string) (*string, string) {
	if utf8.ValidString(p) {
		return &p, ""
	}
	return nil, base64.StdEncoding.EncodeToString([]byte(p))
}

func descriptorJSON(d Descriptor) (json.RawMessage, error) {
	if d.Posix != nil {
		return json.Marshal(d.Posix)
	}
	return json.Marshal(base64.StdEncoding.EncodeToString(d.Raw))
}

// Entry writes one entry (and its descriptor before its first use).
func (w *SidecarWriter) Entry(e SidecarEntry) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	line := entryLine{T: "e", A: e.Attrs}
	line.P, line.PB = pathFields(e.Path)
	if e.Descriptor != nil && !e.Descriptor.Empty() {
		id := e.Descriptor.ID()
		if !w.seen[id] {
			b, err := descriptorJSON(*e.Descriptor)
			if err != nil {
				return err
			}
			if err := w.line(descriptorLine{T: "d", ID: id, B: b}); err != nil {
				return err
			}
			w.seen[id] = true
			w.trailer.Descriptors++
		}
		line.D = id
	}
	if e.Created != nil {
		line.C = strconv.FormatUint(*e.Created, 10)
	}
	if e.CTime != 0 {
		line.CT = strconv.FormatInt(e.CTime, 10)
	}
	if e.Size > 0 {
		s := e.Size
		line.S = &s
	}
	w.trailer.Entries++
	return w.line(line)
}

// Error records a path whose permissions could not be read.
func (w *SidecarWriter) Error(path, errno string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	line := errorLine{T: "x", Err: errno}
	line.P, line.PB = pathFields(path)
	w.trailer.Errors++
	return w.line(line)
}

// Counts are the counts written so far.
func (w *SidecarWriter) Counts() SidecarTrailer {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.trailer
}

// Close writes the trailer and flushes the gzip stream (not the underlying writer).
func (w *SidecarWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if err := w.line(w.trailer); err != nil {
		return err
	}
	if err := w.buf.Flush(); err != nil {
		return err
	}
	return w.gz.Close()
}

// SidecarRecord is what the reader hands out per entry or error line.
type SidecarRecord struct {
	Entry *SidecarEntry
	Error *SidecarError
}

// SidecarResult is what ReadSidecar learned beyond the records.
type SidecarResult struct {
	Header  SidecarHeader
	Trailer *SidecarTrailer // nil: incomplete
}

type rawLine struct {
	T   string          `json:"t"`
	V   int             `json:"v"`
	ID  string          `json:"id"`
	B   json.RawMessage `json:"b"`
	P   *string         `json:"p"`
	PB  string          `json:"pb"`
	D   string          `json:"d"`
	A   *uint32         `json:"a"`
	C   string          `json:"c"`
	CT  string          `json:"ct"`
	S   *int64          `json:"s"`
	Err string          `json:"err"`
}

func decodePath(p *string, pb string) (string, error) {
	if p != nil {
		return *p, nil
	}
	if pb == "" {
		return "", errors.New("sidecar line without a path")
	}
	b, err := base64.StdEncoding.DecodeString(pb)
	if err != nil {
		return "", fmt.Errorf("sidecar path: %w", err)
	}
	return string(b), nil
}

func decodeDescriptor(b json.RawMessage) (Descriptor, error) {
	if len(b) > 0 && b[0] == '{' {
		var p PosixACL
		if err := json.Unmarshal(b, &p); err != nil {
			return Descriptor{}, err
		}
		return Descriptor{Posix: &p}, nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return Descriptor{}, err
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return Descriptor{}, err
	}
	return Descriptor{Raw: raw}, nil
}

// ReadSidecar reads a gzip'ed sidecar and calls fn for every entry and error
// line, in order. Unknown line types and fields are ignored; a header with a
// higher version returns ErrSidecarNewer before any record. A missing trailer
// is not an error (result.Trailer is nil): the caller applies what there is
// and says so. A truncated gzip stream likewise ends the records without an
// error when at least the header was read.
func ReadSidecar(r io.Reader, fn func(SidecarRecord) error) (SidecarResult, error) {
	var res SidecarResult
	gz, err := gzip.NewReader(r)
	if err != nil {
		return res, fmt.Errorf("sidecar: %w", err)
	}
	defer gz.Close()
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	descriptors := map[string]Descriptor{}
	first := true
	for sc.Scan() {
		var l rawLine
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			if first {
				return res, fmt.Errorf("sidecar header: %w", err)
			}
			continue
		}
		if first {
			first = false
			if l.T != "h" {
				return res, errors.New("sidecar: the first line is not a header")
			}
			if err := json.Unmarshal(sc.Bytes(), &res.Header); err != nil {
				return res, err
			}
			if res.Header.Format != SidecarFormat {
				return res, fmt.Errorf("sidecar: unknown format %q", res.Header.Format)
			}
			if res.Header.V > SidecarVersion {
				return res, ErrSidecarNewer
			}
			continue
		}
		switch l.T {
		case "d":
			d, err := decodeDescriptor(l.B)
			if err == nil {
				descriptors[l.ID] = d
			}
		case "e":
			p, err := decodePath(l.P, l.PB)
			if err != nil {
				continue
			}
			e := &SidecarEntry{Path: p, Attrs: l.A}
			if l.D != "" {
				if d, ok := descriptors[l.D]; ok {
					e.Descriptor = &d
				}
			}
			if l.C != "" {
				if c, err := strconv.ParseUint(l.C, 10, 64); err == nil {
					e.Created = &c
				}
			}
			if l.CT != "" {
				e.CTime, _ = strconv.ParseInt(l.CT, 10, 64)
			}
			if l.S != nil {
				e.Size = *l.S
			}
			if err := fn(SidecarRecord{Entry: e}); err != nil {
				if errors.Is(err, ErrStopSidecar) {
					return res, nil
				}
				return res, err
			}
		case "x":
			p, err := decodePath(l.P, l.PB)
			if err != nil {
				continue
			}
			if err := fn(SidecarRecord{Error: &SidecarError{Path: p, Errno: l.Err}}); err != nil {
				if errors.Is(err, ErrStopSidecar) {
					return res, nil
				}
				return res, err
			}
		case "z":
			var t SidecarTrailer
			if json.Unmarshal(sc.Bytes(), &t) == nil {
				res.Trailer = &t
			}
		}
	}
	if first {
		if err := sc.Err(); err != nil {
			return res, fmt.Errorf("sidecar: %w", err)
		}
		return res, errors.New("sidecar: empty")
	}
	// A cut-off stream (io.ErrUnexpectedEOF) leaves Trailer nil: incomplete, not fatal.
	return res, nil
}

// Manifest is /.restow/manifest.json (4.6).
type Manifest struct {
	Format      string             `json:"format"`
	V           int                `json:"v"`
	ShareID     string             `json:"shareId"`
	Protocol    string             `json:"protocol"`
	Includes    []string           `json:"includes"`
	CreatedAt   string             `json:"createdAt"`
	Files       int64              `json:"files"`
	Bytes       int64              `json:"bytes"`
	Permissions ManifestPermission `json:"permissions"`
}

// ManifestPermission summarises the sidecar.
type ManifestPermission struct {
	Mode        string `json:"mode"`
	Xattr       string `json:"xattr"`
	Entries     int    `json:"entries"`
	Descriptors int    `json:"descriptors"`
	Errors      int    `json:"errors"`
}

// ManifestFormat is the manifest's `format`.
const ManifestFormat = "restow-share-manifest"
