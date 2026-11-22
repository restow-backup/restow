// Package payload builds what a oneshot restore loads with kexec
// (docs/BAREMETAL-ONESHOT.md 8.6): it reads the kernel, the initrd and the
// live file system out of the signed recovery ISO, and appends the live file
// system and the session data to the ISO's initrd as one uncompressed cpio
// archive. Nothing here runs a program or needs Linux; the caller has checked
// the ISO against the signed checksums before it opens it here.
package payload

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	sectorSize = 2048
	// The volume descriptors start at sector 16; a real ISO has a handful.
	firstDescriptor = 16
	maxDescriptors  = 32
	// maxDirBytes bounds one directory extent (the ISO's largest is a few KiB).
	maxDirBytes = 1 << 20
	// maxDepth bounds a path.
	maxDepth = 8
)

// ErrNotISO is returned for data that is not an ISO 9660 image.
var ErrNotISO = errors.New("not an ISO 9660 image")

// ISO is an ISO 9660 image with Rock Ridge names (what live-build writes
// through xorriso). Only plain files and directories are read: no
// multi-extent files, no interleaving.
type ISO struct {
	r    io.ReaderAt
	size int64
	root dirRecord
	// skip is the SUSP skip length of the root's SP entry.
	skip int
}

// Entry is a file or directory of the image.
type Entry struct {
	Name   string
	Extent uint32
	Size   int64
	Dir    bool
}

type dirRecord struct {
	extent uint32
	size   uint32
	flags  byte
	name   []byte
	susp   []byte
}

// OpenISO reads the primary volume descriptor of an image of size bytes.
func OpenISO(r io.ReaderAt, size int64) (*ISO, error) {
	buf := make([]byte, sectorSize)
	for i := 0; i < maxDescriptors; i++ {
		off := int64(firstDescriptor+i) * sectorSize
		if off+sectorSize > size {
			return nil, ErrNotISO
		}
		if _, err := r.ReadAt(buf, off); err != nil {
			return nil, fmt.Errorf("read the volume descriptors: %w", err)
		}
		if string(buf[1:6]) != "CD001" {
			return nil, ErrNotISO
		}
		switch buf[0] {
		case 1:
			if bs := binary.LittleEndian.Uint16(buf[128:130]); bs != sectorSize {
				return nil, fmt.Errorf("logical block size %d, want %d", bs, sectorSize)
			}
			root, _, err := parseRecord(buf[156:190])
			if err != nil {
				return nil, fmt.Errorf("root directory record: %w", err)
			}
			iso := &ISO{r: r, size: size, root: root}
			if err := iso.checkExtent(root.extent, int64(root.size)); err != nil {
				return nil, err
			}
			iso.skip = iso.rootSkip()
			return iso, nil
		case 255:
			return nil, errors.New("no primary volume descriptor")
		}
	}
	return nil, errors.New("no primary volume descriptor in the first descriptors")
}

// parseRecord reads one directory record; it returns the record and its length.
func parseRecord(b []byte) (dirRecord, int, error) {
	if len(b) < 34 {
		return dirRecord{}, 0, errors.New("short directory record")
	}
	l := int(b[0])
	if l < 34 || l > len(b) {
		return dirRecord{}, 0, errors.New("bad directory record length")
	}
	nl := int(b[32])
	if 33+nl > l {
		return dirRecord{}, 0, errors.New("bad file identifier length")
	}
	rec := dirRecord{
		extent: binary.LittleEndian.Uint32(b[2:6]),
		size:   binary.LittleEndian.Uint32(b[10:14]),
		flags:  b[25],
		name:   b[33 : 33+nl],
	}
	su := 33 + nl
	if nl%2 == 0 {
		su++ // padding byte after an even-length identifier
	}
	if su < l {
		rec.susp = b[su:l]
	}
	return rec, l, nil
}

func (iso *ISO) checkExtent(extent uint32, size int64) error {
	end := int64(extent)*sectorSize + size
	if size < 0 || end > iso.size || end < 0 {
		return fmt.Errorf("extent %d with %d bytes lies outside the image", extent, size)
	}
	return nil
}

// rootSkip reads the SUSP SP entry of the root's "." record (the bytes to
// skip in every other record's system use area).
func (iso *ISO) rootSkip() int {
	recs, err := iso.records(iso.root)
	if err != nil || len(recs) == 0 {
		return 0
	}
	su := recs[0].susp
	if len(su) >= 7 && su[0] == 'S' && su[1] == 'P' && su[4] == 0xBE && su[5] == 0xEF {
		return int(su[6])
	}
	return 0
}

// records lists the records of a directory, "." and ".." included.
func (iso *ISO) records(dir dirRecord) ([]dirRecord, error) {
	if dir.flags&2 == 0 {
		return nil, errors.New("not a directory")
	}
	if dir.size > maxDirBytes {
		return nil, fmt.Errorf("directory of %d bytes is too large", dir.size)
	}
	if err := iso.checkExtent(dir.extent, int64(dir.size)); err != nil {
		return nil, err
	}
	data := make([]byte, dir.size)
	if _, err := iso.r.ReadAt(data, int64(dir.extent)*sectorSize); err != nil {
		return nil, fmt.Errorf("read a directory: %w", err)
	}
	var out []dirRecord
	for off := 0; off < len(data); {
		if data[off] == 0 {
			// Records do not cross sectors: the rest of this sector is padding.
			off = (off/sectorSize + 1) * sectorSize
			continue
		}
		end := (off/sectorSize + 1) * sectorSize
		if end > len(data) {
			end = len(data)
		}
		rec, l, err := parseRecord(data[off:end])
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
		off += l
	}
	return out, nil
}

// name is the Rock Ridge name of a record, else its ISO 9660 identifier
// without the version (";1") and a trailing dot. Rock Ridge names that need
// a continuation area are not read (the names of the recovery ISO are short).
func (iso *ISO) name(rec dirRecord) string {
	su := rec.susp
	if iso.skip > 0 && iso.skip <= len(su) {
		su = su[iso.skip:]
	}
	var rr []byte
	found := false
	for i := 0; i+4 <= len(su); {
		l := int(su[i+2])
		if l < 4 || i+l > len(su) {
			break
		}
		if su[i] == 'N' && su[i+1] == 'M' && l >= 5 {
			rr = append(rr, su[i+5:i+l]...)
			found = true
		}
		i += l
	}
	if found {
		return string(rr)
	}
	n := string(rec.name)
	if i := strings.IndexByte(n, ';'); i >= 0 {
		n = n[:i]
	}
	return strings.TrimSuffix(n, ".")
}

// Lookup finds an absolute path (/live/vmlinuz).
func (iso *ISO) Lookup(path string) (Entry, error) {
	if !strings.HasPrefix(path, "/") {
		return Entry{}, fmt.Errorf("%q is not an absolute path", path)
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) > maxDepth {
		return Entry{}, fmt.Errorf("%q is too deep", path)
	}
	cur := iso.root
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			return Entry{}, fmt.Errorf("%q is not a clean path", path)
		}
		recs, err := iso.records(cur)
		if err != nil {
			return Entry{}, fmt.Errorf("%s: %w", path, err)
		}
		var next *dirRecord
		for j := range recs {
			r := recs[j]
			if len(r.name) == 1 && (r.name[0] == 0 || r.name[0] == 1) {
				continue
			}
			if iso.name(r) == part {
				if next != nil {
					return Entry{}, fmt.Errorf("%s: %q is there twice", path, part)
				}
				next = &recs[j]
			}
		}
		if next == nil {
			return Entry{}, fmt.Errorf("%s: %q not found", path, part)
		}
		if next.flags&0x80 != 0 {
			return Entry{}, fmt.Errorf("%s: multi-extent files are not read", path)
		}
		if i < len(parts)-1 && next.flags&2 == 0 {
			return Entry{}, fmt.Errorf("%s: %q is not a directory", path, part)
		}
		cur = *next
	}
	if err := iso.checkExtent(cur.extent, int64(cur.size)); err != nil {
		return Entry{}, fmt.Errorf("%s: %w", path, err)
	}
	return Entry{Name: parts[len(parts)-1], Extent: cur.extent, Size: int64(cur.size), Dir: cur.flags&2 != 0}, nil
}

// Open returns a reader of a regular file of the image.
func (iso *ISO) Open(path string) (*io.SectionReader, error) {
	e, err := iso.Lookup(path)
	if err != nil {
		return nil, err
	}
	if e.Dir {
		return nil, fmt.Errorf("%s is a directory", path)
	}
	return io.NewSectionReader(iso.r, int64(e.Extent)*sectorSize, e.Size), nil
}

// ReadFile reads a small file of the image (at most max bytes).
func (iso *ISO) ReadFile(path string, max int64) ([]byte, error) {
	sr, err := iso.Open(path)
	if err != nil {
		return nil, err
	}
	if sr.Size() > max {
		return nil, fmt.Errorf("%s has %d bytes, more than %d", path, sr.Size(), max)
	}
	var b bytes.Buffer
	if _, err := io.Copy(&b, sr); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
