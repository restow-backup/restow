package baremetal

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// maxReadBytes caps a file read through Host (sysfs, /proc and /etc files
// are small; loaders are read through Open).
const maxReadBytes = 4 << 20

// ErrTooBig is returned for a file larger than the cap of a read.
var ErrTooBig = errors.New("file too large")

// ReaderAtCloser is an open file for random access.
type ReaderAtCloser interface {
	io.ReaderAt
	io.Closer
}

// Statfs is the part of statfs(2) the capture uses.
type Statfs struct {
	Files     int64 `json:"files"`
	FilesFree int64 `json:"filesFree"`
}

// Host is the file system of the machine being captured, as absolute
// paths ("/proc/self/mountinfo"). DirHost serves it from a directory: "/"
// on the machine, a fixture tree in tests.
type Host interface {
	// ReadFile reads a whole file of at most max bytes (0: maxReadBytes).
	ReadFile(p string, max int64) ([]byte, error)
	ReadDir(p string) ([]fs.DirEntry, error)
	Stat(p string) (fs.FileInfo, error)
	Lstat(p string) (fs.FileInfo, error)
	// Readlink returns the target of a symbolic link.
	Readlink(p string) (string, error)
	// Open opens a file or device for random access with its size.
	Open(p string) (ReaderAtCloser, int64, error)
	// Glob matches a pattern of absolute paths (path.Match syntax).
	Glob(pattern string) ([]string, error)
	// Statfs reports inode counts of the file system mounted at p.
	Statfs(p string) (Statfs, error)
}

// DirHost serves Host from a directory. In fixtures a symbolic link may be
// stored as a regular file "<name>.link" holding the target (git on Windows
// does not keep links), devices as regular files with their first sectors,
// and statfs answers in "<Root>/../statfs.json" ({"/mnt": {...}}).
type DirHost struct {
	Root string
	// StatfsFn answers Statfs on a real system; nil reads the fixture file.
	StatfsFn func(p string) (Statfs, error)
}

func (h DirHost) real(p string) string {
	if h.Root == "" || h.Root == "/" {
		return filepath.FromSlash(p)
	}
	return filepath.Join(h.Root, filepath.FromSlash(strings.TrimPrefix(path.Clean("/"+p), "/")))
}

func (h DirHost) ReadFile(p string, max int64) ([]byte, error) {
	if max <= 0 {
		max = maxReadBytes
	}
	f, err := os.Open(h.real(p))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s: %w", p, ErrTooBig)
	}
	return b, nil
}

func (h DirHost) ReadDir(p string) ([]fs.DirEntry, error) {
	ents, err := os.ReadDir(h.real(p))
	if err != nil {
		return nil, err
	}
	if h.Root == "" || h.Root == "/" {
		return ents, nil
	}
	// Fixture links appear under their own name.
	out := make([]fs.DirEntry, 0, len(ents))
	real := map[string]bool{}
	for _, e := range ents {
		real[e.Name()] = true
	}
	for _, e := range ents {
		if name, ok := strings.CutSuffix(e.Name(), ".link"); ok && !e.IsDir() {
			if !real[name] {
				out = append(out, linkEntry{name: name})
			}
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out, nil
}

type linkEntry struct{ name string }

func (l linkEntry) Name() string               { return l.name }
func (l linkEntry) IsDir() bool                { return false }
func (l linkEntry) Type() fs.FileMode          { return fs.ModeSymlink }
func (l linkEntry) Info() (fs.FileInfo, error) { return nil, errors.New("fixture link") }

func (h DirHost) Stat(p string) (fs.FileInfo, error)  { return os.Stat(h.real(p)) }
func (h DirHost) Lstat(p string) (fs.FileInfo, error) { return os.Lstat(h.real(p)) }

func (h DirHost) Readlink(p string) (string, error) {
	t, err := os.Readlink(h.real(p))
	if err == nil {
		return t, nil
	}
	if h.Root != "" && h.Root != "/" {
		if b, ferr := os.ReadFile(h.real(p) + ".link"); ferr == nil {
			return strings.TrimSpace(string(b)), nil
		}
	}
	return "", err
}

func (h DirHost) Open(p string) (ReaderAtCloser, int64, error) {
	f, err := os.Open(h.real(p))
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, st.Size(), nil
}

func (h DirHost) Glob(pattern string) ([]string, error) {
	matches, err := filepath.Glob(h.real(pattern))
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if h.Root == "" || h.Root == "/" {
			out = append(out, filepath.ToSlash(m))
			continue
		}
		rel, err := filepath.Rel(h.Root, m)
		if err != nil {
			continue
		}
		out = append(out, "/"+filepath.ToSlash(rel))
	}
	sort.Strings(out)
	return out, nil
}

func (h DirHost) Statfs(p string) (Statfs, error) {
	if h.StatfsFn != nil {
		return h.StatfsFn(p)
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(h.Root), "statfs.json"))
	if err != nil {
		return Statfs{}, err
	}
	var all map[string]Statfs
	if err := json.Unmarshal(b, &all); err != nil {
		return Statfs{}, err
	}
	s, ok := all[p]
	if !ok {
		return Statfs{}, fs.ErrNotExist
	}
	return s, nil
}

// exists reports whether p exists on the host (a fixture link counts).
func exists(h Host, p string) bool {
	if _, err := h.Lstat(p); err == nil {
		return true
	}
	_, err := h.Readlink(p)
	return err == nil
}

// readString reads a small file and trims it.
func readString(h Host, p string) (string, bool) {
	b, err := h.ReadFile(p, 64<<10)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

// resolveLink resolves a link relative to its directory.
func resolveLink(h Host, p string) (string, bool) {
	t, err := h.Readlink(p)
	if err != nil {
		return "", false
	}
	if !path.IsAbs(t) {
		t = path.Join(path.Dir(p), t)
	}
	return path.Clean(t), true
}
