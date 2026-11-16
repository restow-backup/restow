//go:build unix

package share

import (
	"bytes"
	"errors"
	"fmt"
	"runtime"
	"testing"
)

// syntheticSidecar is a sidecar of n files in folders of 1000 with a few
// descriptors, DOS attributes and creation times, as an SMB share has them.
func syntheticSidecar(t *testing.T, n int) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := NewSidecarWriter(&buf, SidecarHeader{Protocol: ProtocolSMB, Xattr: XattrNTSDFull})
	mustNoErr(t, err)
	descriptors := []*Descriptor{{Raw: []byte("SD:users")}, {Raw: []byte("SD:finance")}, {Raw: []byte("SD:hr")}}
	for i := 0; i < n; i++ {
		attrs, created := uint32(0x20), uint64(133000000000000000+i)
		mustNoErr(t, w.Entry(SidecarEntry{Path: syntheticPath(i), Descriptor: descriptors[i%len(descriptors)],
			Attrs: &attrs, Created: &created, CTime: int64(1_700_000_000_000_000_000 + i), Size: int64(i)}))
	}
	mustNoErr(t, w.Close())
	return buf.Bytes()
}

func syntheticPath(i int) string {
	return fmt.Sprintf("Department %03d/Projects/2026/document-%07d.docx", i/1000, i)
}

func loadSynthetic(data []byte, maxEntries int) (*Previous, error) {
	return LoadPrevious(func(fn func(SidecarRecord) error) (SidecarResult, error) {
		return ReadSidecar(bytes.NewReader(data), fn)
	}, maxEntries)
}

func TestPreviousLookup(t *testing.T) {
	prev, err := loadSynthetic(syntheticSidecar(t, 3000), 0)
	mustNoErr(t, err)
	if prev.Len() != 3000 {
		t.Fatalf("entries %d", prev.Len())
	}
	e, ok := prev.Lookup(syntheticPath(1234))
	if !ok || e.CTime != 1_700_000_000_000_000_000+1234 || e.Size != 1234 || *e.Attrs != 0x20 ||
		*e.Created != 133000000000000000+1234 || string(e.Descriptor.Raw) != "SD:finance" {
		t.Fatalf("entry %+v", e)
	}
	other, _ := prev.Lookup(syntheticPath(1237))
	if other.Descriptor != e.Descriptor {
		t.Fatal("the same descriptor is held more than once")
	}
	if _, ok := prev.Lookup("Department 001/missing.docx"); ok {
		t.Fatal("a path the sidecar does not have")
	}
	var none *Previous
	if _, ok := none.Lookup("a"); ok || none.Len() != 0 {
		t.Fatal("a nil Previous holds nothing")
	}
	// Without attributes, creation time or descriptor.
	p := NewPrevious()
	p.Add("plain", PreviousEntry{CTime: 5, Size: 6})
	if e, _ := p.Lookup("plain"); e.Attrs != nil || e.Created != nil || e.Descriptor != nil || e.CTime != 5 {
		t.Fatalf("entry %+v", e)
	}
}

func TestLoadPreviousStopsAboveTheLimit(t *testing.T) {
	data := syntheticSidecar(t, 50)
	if _, err := loadSynthetic(data, 49); !errors.Is(err, ErrTooManyPrevious) {
		t.Fatalf("err %v", err)
	}
	prev, err := loadSynthetic(data, 50)
	mustNoErr(t, err)
	if prev.Len() != 50 {
		t.Fatalf("entries %d", prev.Len())
	}
}

// TestLoadPreviousMemoryIsBounded loads a large sidecar and checks what the
// index keeps per entry: about previousEntryBytes, independent of the path
// length, which the reuse limit is computed with.
func TestLoadPreviousMemoryIsBounded(t *testing.T) {
	const n = 200_000
	data := syntheticSidecar(t, n)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	prev, err := loadSynthetic(data, 0)
	mustNoErr(t, err)
	runtime.GC()
	runtime.ReadMemStats(&after)
	if prev.Len() != n {
		t.Fatalf("entries %d", prev.Len())
	}
	perEntry := (int64(after.HeapAlloc) - int64(before.HeapAlloc)) / n
	t.Logf("%d bytes per entry", perEntry)
	if perEntry > previousEntryBytes {
		t.Fatalf("%d bytes per entry, more than %d", perEntry, previousEntryBytes)
	}
	runtime.KeepAlive(prev)
}

func TestReuseMaxEntriesFollowsTheMemoryLimit(t *testing.T) {
	if got := reuseMaxEntries(); got <= 0 {
		t.Fatalf("limit %d", got)
	}
}
