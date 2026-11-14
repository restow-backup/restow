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

// DirHost serves Host from a directory. A Root other than "/" is a fixture
// tree, which is kept in git and must check out on every system:
//
//   - a symbolic link may be stored as a regular file "<name>.link" holding
//     the target (git on Windows does not keep links);
//   - a name is stored as FixtureName writes it, because sysfs has names
//     that Windows cannot hold ("pci0000:00" is stored as "pci0000%3A00");
//   - a directory that holds nothing else holds the file FixtureKeep,
//     which is no entry of the tree (git keeps no empty directories);
//   - devices are regular files with their first sectors, and statfs
//     answers come from "<Root>/../statfs.json" ({"/mnt": {...}}).
type DirHost struct {
	Root string
	// StatfsFn answers Statfs on a real system; nil reads the fixture file.
	StatfsFn func(p string) (Statfs, error)
}

// FixtureKeep is the file that keeps an otherwise empty directory of a
// fixture tree in git. DirHost does not show it.
const FixtureKeep = ".restow-keep"

// fixtureReserved are the device names Windows reserves, with or without
// an extension, in any case.
var fixtureReserved = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true, "CONIN$": true, "CONOUT$": true,
	"COM0": true, "COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT0": true, "LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true}

// fixtureUnsafe reports a byte no file name on Windows may hold, and the
// percent sign that marks the written form.
func fixtureUnsafe(c byte) bool {
	return c < 0x20 || c == 0x7f || strings.IndexByte(`%:<>"|?*\`, c) >= 0
}

// FixtureName is the name a path component has on disk in a fixture tree:
// every character Windows refuses in a file name (: < > " | ? * \ and
// control characters) and the percent sign are written as %XX, as are a
// trailing dot or space and the first character of a reserved device name
// (NUL, COM1, ...). Other names stay as they are, so most of a tree reads
// as on the machine.
func FixtureName(name string) string {
	if name == "." || name == ".." {
		return name
	}
	base, _, _ := strings.Cut(name, ".")
	reserved := fixtureReserved[strings.ToUpper(base)]
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		last := i == len(name)-1 && (c == '.' || c == ' ')
		if fixtureUnsafe(c) || last || (i == 0 && reserved) {
			fmt.Fprintf(&b, "%%%02X", c)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// fixtureDecode is the name FixtureName wrote.
func fixtureDecode(name string) string {
	if !strings.Contains(name, "%") {
		return name
	}
	hex := func(c byte) (byte, bool) {
		switch {
		case c >= '0' && c <= '9':
			return c - '0', true
		case c >= 'A' && c <= 'F':
			return c - 'A' + 10, true
		case c >= 'a' && c <= 'f':
			return c - 'a' + 10, true
		}
		return 0, false
	}
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		if name[i] == '%' && i+2 < len(name) {
			hi, ok1 := hex(name[i+1])
			lo, ok2 := hex(name[i+2])
			if ok1 && ok2 {
				b.WriteByte(hi<<4 | lo)
				i += 2
				continue
			}
		}
		b.WriteByte(name[i])
	}
	return b.String()
}

// FixturePath is where the absolute path p of a machine lies in the
// fixture tree at root (each component as FixtureName writes it). Tests
// that build a tree write through it.
func FixturePath(root, p string) string {
	out := root
	for _, part := range strings.Split(strings.TrimPrefix(path.Clean("/"+filepath.ToSlash(p)), "/"), "/") {
		if part != "" {
			out = filepath.Join(out, FixtureName(part))
		}
	}
	return out
}

// fixturePattern is FixturePath for a pattern of Glob: the characters of
// a pattern (* ? [ ] \) stay, everything else is written as in a name.
func fixturePattern(root, pattern string) string {
	out := root
	for _, part := range strings.Split(strings.TrimPrefix(path.Clean("/"+pattern), "/"), "/") {
		if part == "" {
			continue
		}
		var b strings.Builder
		for i := 0; i < len(part); i++ {
			c := part[i]
			if strings.IndexByte(`*?[]\`, c) < 0 && fixtureUnsafe(c) {
				fmt.Fprintf(&b, "%%%02X", c)
				continue
			}
			b.WriteByte(c)
		}
		out = filepath.Join(out, b.String())
	}
	return out
}

func (h DirHost) fixture() bool { return h.Root != "" && h.Root != "/" }

func (h DirHost) real(p string) string {
	if !h.fixture() {
		return filepath.FromSlash(p)
	}
	return FixturePath(h.Root, p)
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
	if !h.fixture() {
		return ents, nil
	}
	// Fixture names appear as on the machine, links under their own name,
	// and the file that keeps an empty directory not at all.
	out := make([]fs.DirEntry, 0, len(ents))
	real := map[string]bool{}
	for _, e := range ents {
		real[fixtureDecode(e.Name())] = true
	}
	for _, e := range ents {
		name := fixtureDecode(e.Name())
		if name == FixtureKeep && !e.IsDir() {
			continue
		}
		if link, ok := strings.CutSuffix(name, ".link"); ok && !e.IsDir() {
			if !real[link] {
				out = append(out, linkEntry{name: link})
			}
			continue
		}
		if name != e.Name() {
			out = append(out, namedEntry{DirEntry: e, name: name})
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out, nil
}

// namedEntry is a directory entry of a fixture under the name it has on
// the machine.
type namedEntry struct {
	fs.DirEntry
	name string
}

func (e namedEntry) Name() string { return e.name }

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
	if h.fixture() {
		if b, ferr := os.ReadFile(h.real(p) + ".link"); ferr == nil {
			return strings.TrimSpace(string(b)), nil
		}
	}
	return "", err
}

// Open opens a file or a device for reading. The size of a block device is
// not in its stat (0): it comes from seeking to the end, as for a file.
// Without it every disk looked shorter than a sector, and captureBootCode
// recorded no boot code for any real disk (no grub-install on restore).
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
	size := st.Size()
	if !st.Mode().IsRegular() {
		if end, err := f.Seek(0, io.SeekEnd); err == nil {
			size = end
		}
	}
	return f, size, nil
}

func (h DirHost) Glob(pattern string) ([]string, error) {
	if !h.fixture() {
		matches, err := filepath.Glob(filepath.FromSlash(pattern))
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(matches))
		for _, m := range matches {
			out = append(out, filepath.ToSlash(m))
		}
		sort.Strings(out)
		return out, nil
	}
	matches, err := filepath.Glob(fixturePattern(h.Root, pattern))
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		rel, err := filepath.Rel(h.Root, m)
		if err != nil {
			continue
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		for i := range parts {
			parts[i] = fixtureDecode(parts[i])
		}
		if parts[len(parts)-1] == FixtureKeep {
			continue
		}
		out = append(out, "/"+strings.Join(parts, "/"))
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
