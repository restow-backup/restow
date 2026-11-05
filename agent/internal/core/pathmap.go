package core

import (
	"bufio"
	"bytes"
	"path"
	"sort"
	"strings"
)

// Firmlink is a line of /usr/share/firmlinks: a path of the system volume
// and where it lives on the Data volume (relative to it).
type Firmlink struct {
	Link string
	Data string
}

// Firmlinks are the firmlinks of a Mac, longest link first.
type Firmlinks []Firmlink

// dataVolume is where the Data volume is mounted on macOS 10.15 and later.
const dataVolume = "/System/Volumes/Data"

// ParseFirmlinks reads /usr/share/firmlinks ("/<path>\t<data-relative>").
func ParseFirmlinks(b []byte) Firmlinks {
	var out Firmlinks
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Split(strings.TrimRight(sc.Text(), "\r"), "\t")
		if len(f) != 2 || !strings.HasPrefix(f[0], "/") || f[1] == "" {
			continue
		}
		out = append(out, Firmlink{Link: path.Clean(f[0]), Data: strings.Trim(f[1], "/")})
	}
	sort.SliceStable(out, func(i, j int) bool { return len(out[i].Link) > len(out[j].Link) })
	return out
}

// darwinLinked are the top-level symbolic links of macOS into /private.
var darwinLinked = []string{"/etc", "/var", "/tmp"}

// expandDarwinExcludes gives every absolute exclude in all the spellings a
// macOS backup can see it under (docs/BAREMETAL.md 5.3): the link form
// (/etc and /private/etc), the Data volume form (/System/Volumes/Data plus
// the data-relative path, for backups of the Data volume) and, with
// snapshotRoot, the form below a mounted APFS snapshot (M6). Relative
// patterns stay as they are; the order is kept and duplicates dropped.
func expandDarwinExcludes(ex []string, fl Firmlinks, snapshotRoot string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, e := range ex {
		add(e)
		if !strings.HasPrefix(e, "/") {
			continue
		}
		private := e
		for _, l := range darwinLinked {
			if e == l || strings.HasPrefix(e, l+"/") {
				private = "/private" + e
			}
			if rest, ok := strings.CutPrefix(e, "/private"+l); ok && (rest == "" || strings.HasPrefix(rest, "/")) {
				add(l + rest)
			}
		}
		add(private)
		rel := dataRelative(private, fl)
		if rel == "" {
			continue
		}
		add(dataVolume + "/" + rel)
		if snapshotRoot != "" {
			add(strings.TrimRight(snapshotRoot, "/") + "/" + rel)
		}
	}
	return out
}

// dataRelative maps a path to its place on the Data volume: through the
// firmlinks, else (the files of /private and similar) the path itself.
func dataRelative(p string, fl Firmlinks) string {
	if strings.HasPrefix(p, dataVolume+"/") {
		return strings.TrimPrefix(p, dataVolume+"/")
	}
	for _, f := range fl {
		if p == f.Link || strings.HasPrefix(p, f.Link+"/") {
			return f.Data + strings.TrimPrefix(p, f.Link)
		}
	}
	return strings.TrimPrefix(p, "/")
}
