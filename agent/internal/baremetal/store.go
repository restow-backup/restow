package baremetal

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/restow-backup/restow/agent/internal/atomicfile"
)

// LayoutFile is the name of the manifest in the bare-metal folder.
const LayoutFile = "layout.json"

var reRawName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// WriteBaremetalDir writes the manifest and raw/ into dir
// (Layout.BaremetalDir(), docs/BAREMETAL.md 4.3): the folder is 0700, the
// old raw/ is removed first, each file is written to a temporary file and
// renamed into place; layout.json holds exactly the canonical bytes.
func WriteBaremetalDir(dir string, manifest []byte, raw RawSet) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	rawDir := filepath.Join(dir, "raw")
	if err := os.RemoveAll(rawDir); err != nil {
		return err
	}
	if err := os.Mkdir(rawDir, 0o700); err != nil {
		return err
	}
	names := make([]string, 0, len(raw))
	for n := range raw {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if !reRawName.MatchString(n) {
			return fmt.Errorf("raw file name %q", n)
		}
		if err := writeAtomic(rawDir, n, raw[n]); err != nil {
			return err
		}
	}
	return writeAtomic(dir, LayoutFile, manifest)
}

func writeAtomic(dir, name string, b []byte) error {
	f, err := os.CreateTemp(dir, "."+name+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, werr := f.Write(b)
	if werr == nil {
		werr = f.Sync()
	}
	cerr := f.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp, 0o600)
	}
	if werr == nil {
		werr = atomicfile.Rename(tmp, filepath.Join(dir, name))
	}
	if werr != nil {
		_ = os.Remove(tmp)
	}
	return werr
}
