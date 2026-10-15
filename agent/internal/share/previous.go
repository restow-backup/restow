package share

import (
	"errors"
	"hash/maphash"
	"math"
	"runtime/debug"
)

// The ACL reuse (4.3) compares every path of the walk with what the previous
// sidecar recorded for it. A share has millions of files, so the previous
// entries are kept compact: keyed by a 64-bit hash of the path instead of the
// path, as plain values without pointers (the garbage collector never scans
// them), and every descriptor once. A path whose hash collides with another's
// would also need the same change time (in nanoseconds) and size to reuse the
// wrong permissions.

// previousEntryBytes is what one previous entry costs in memory, map overhead
// included (TestLoadPreviousMemoryIsBounded measures it).
const previousEntryBytes = 100

// defaultReuseMaxEntries applies without a memory limit (GOMEMLIMIT).
const defaultReuseMaxEntries = 8_000_000

// ErrTooManyPrevious: the previous sidecar has more entries than the reuse may
// hold; all permissions are read again.
var ErrTooManyPrevious = errors.New("too many files for the permission reuse")

// PreviousEntry is what the previous sidecar recorded for a path (ACL reuse).
type PreviousEntry struct {
	CTime      int64
	Size       int64
	Descriptor *Descriptor
	Attrs      *uint32
	Created    *uint64
}

const (
	hasAttrs uint8 = 1 << iota
	hasCreated
)

// previousEntry is a PreviousEntry without pointers: the descriptor is an
// index into Previous.descriptors (-1: none).
type previousEntry struct {
	ctime      int64
	size       int64
	created    uint64
	attrs      uint32
	descriptor int32
	flags      uint8
}

// Previous is the previous sidecar's entries for the ACL reuse. A nil
// *Previous holds nothing.
type Previous struct {
	seed        maphash.Seed
	entries     map[uint64]previousEntry
	descriptors []*Descriptor
	index       map[*Descriptor]int32
}

// NewPrevious returns an empty Previous.
func NewPrevious() *Previous {
	return &Previous{seed: maphash.MakeSeed(), entries: map[uint64]previousEntry{},
		index: map[*Descriptor]int32{}}
}

// Add records what the previous sidecar said about a path.
func (p *Previous) Add(path string, e PreviousEntry) {
	v := previousEntry{ctime: e.CTime, size: e.Size, descriptor: -1}
	if e.Descriptor != nil {
		i, ok := p.index[e.Descriptor]
		if !ok {
			i = int32(len(p.descriptors))
			p.descriptors = append(p.descriptors, e.Descriptor)
			p.index[e.Descriptor] = i
		}
		v.descriptor = i
	}
	if e.Attrs != nil {
		v.attrs, v.flags = *e.Attrs, v.flags|hasAttrs
	}
	if e.Created != nil {
		v.created, v.flags = *e.Created, v.flags|hasCreated
	}
	p.entries[maphash.String(p.seed, path)] = v
}

// Lookup returns what the previous sidecar said about a path.
func (p *Previous) Lookup(path string) (PreviousEntry, bool) {
	if p == nil {
		return PreviousEntry{}, false
	}
	v, ok := p.entries[maphash.String(p.seed, path)]
	if !ok {
		return PreviousEntry{}, false
	}
	e := PreviousEntry{CTime: v.ctime, Size: v.size}
	if v.descriptor >= 0 {
		e.Descriptor = p.descriptors[v.descriptor]
	}
	if v.flags&hasAttrs != 0 {
		attrs := v.attrs
		e.Attrs = &attrs
	}
	if v.flags&hasCreated != 0 {
		created := v.created
		e.Created = &created
	}
	return e, true
}

// Len is the number of entries.
func (p *Previous) Len() int {
	if p == nil {
		return 0
	}
	return len(p.entries)
}

// LoadPrevious reads a previous sidecar into the reuse index. Only entries
// with a change time can be reused. More than maxEntries of them (0: no
// limit) stop the reading with ErrTooManyPrevious.
func LoadPrevious(read func(func(SidecarRecord) error) (SidecarResult, error), maxEntries int) (*Previous, error) {
	out := NewPrevious()
	tooMany := false
	_, err := read(func(r SidecarRecord) error {
		if r.Entry == nil || r.Entry.CTime == 0 {
			return nil
		}
		if maxEntries > 0 && out.Len() >= maxEntries {
			tooMany = true
			return ErrStopSidecar
		}
		out.Add(r.Entry.Path, PreviousEntry{CTime: r.Entry.CTime, Size: r.Entry.Size,
			Descriptor: r.Entry.Descriptor, Attrs: r.Entry.Attrs, Created: r.Entry.Created})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if tooMany {
		return nil, ErrTooManyPrevious
	}
	return out, nil
}

// reuseMaxEntries is how many previous entries the reuse may hold: a third of
// the memory limit of this process (GOMEMLIMIT), or defaultReuseMaxEntries
// without one.
func reuseMaxEntries() int {
	limit := debug.SetMemoryLimit(-1)
	if limit <= 0 || limit == math.MaxInt64 {
		return defaultReuseMaxEntries
	}
	return int(limit / 3 / previousEntryBytes)
}
