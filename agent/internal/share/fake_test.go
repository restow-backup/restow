package share

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// fakeSys is a System over a temp folder: statfs answers a fixed magic, the
// mount table lists the configured mounts, xattrs live in memory.
type fakeSys struct {
	mu     sync.Mutex
	magic  int64
	mounts map[string]string // mount point -> "fstype ro|rw"
	x      map[string]map[string][]byte
	// getErr / setErr: errors per "path|name" or "*|name" (all paths).
	getErr map[string]error
	setErr map[string]error
	sets   []string // "name path" in order
	gets   int
}

func newFakeSys(magic int64) *fakeSys {
	return &fakeSys{magic: magic, mounts: map[string]string{}, x: map[string]map[string][]byte{},
		getErr: map[string]error{}, setErr: map[string]error{}}
}

func (f *fakeSys) mount(point, fstype string, ro bool) *fakeSys {
	opt := "rw"
	if ro {
		opt = "ro"
	}
	f.mounts[point] = fstype + " " + opt
	return f
}

func (f *fakeSys) Statfs(string) (int64, error) { return f.magic, nil }

func (f *fakeSys) MountInfo() ([]byte, error) {
	var b strings.Builder
	b.WriteString("22 1 0:21 / / rw,relatime - overlay overlay rw\n")
	i := 30
	for point, spec := range f.mounts {
		parts := strings.Fields(spec)
		escaped := strings.ReplaceAll(point, " ", `\040`)
		fmt.Fprintf(&b, "%d 22 0:%d / %s %s,relatime - %s //srv/share %s,vers=3.1.1\n", i, i, escaped, parts[1], parts[0], parts[1])
		i++
	}
	return []byte(b.String()), nil
}

func (f *fakeSys) err(m map[string]error, path, name string) error {
	if e, ok := m[path+"|"+name]; ok {
		return e
	}
	return m["*|"+name]
}

func (f *fakeSys) GetXattr(path, name string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets++
	if e := f.err(f.getErr, path, name); e != nil {
		return nil, e
	}
	v, ok := f.x[path][name]
	if !ok {
		return nil, errNoData
	}
	return append([]byte(nil), v...), nil
}

func (f *fakeSys) SetXattr(path, name string, value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.err(f.setErr, path, name); e != nil {
		return e
	}
	if f.x[path] == nil {
		f.x[path] = map[string][]byte{}
	}
	f.x[path][name] = append([]byte(nil), value...)
	f.sets = append(f.sets, name+" "+path)
	return nil
}

func (f *fakeSys) put(path, name string, value []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.x[path] == nil {
		f.x[path] = map[string][]byte{}
	}
	f.x[path][name] = value
}

func (f *fakeSys) value(path, name string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.x[path][name]
}

func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
