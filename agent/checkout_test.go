package agent

import (
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// windowsReserved are the device names Windows reserves as file names,
// with or without an extension.
var windowsReserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\..*)?$`)

// maxRepoPath is the longest path a file below agent/ may have, counted
// from the root of the repository.
const maxRepoPath = 200

// windowsRefuses says why Windows cannot hold a file or folder of this
// name, or "".
func windowsRefuses(name string) string {
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "a control character"
		}
		if strings.ContainsRune(`<>:"|?*\`, r) {
			return "the character " + string(r)
		}
	}
	switch {
	case strings.HasSuffix(name, "."):
		return "a trailing dot"
	case strings.HasSuffix(name, " "):
		return "a trailing space"
	case windowsReserved.MatchString(name):
		return "a reserved device name"
	}
	return ""
}

// TestEveryPathChecksOutOnWindows: no file or folder below agent/ has a
// name Windows refuses. One such path makes `git checkout` fail there for
// the whole repository, for every contributor on Windows and for the
// Windows job of the CI. Fixture trees of a Linux machine (sysfs has
// "pci0000:00") are stored with the names baremetal.FixtureName writes.
func TestEveryPathChecksOutOnWindows(t *testing.T) {
	// Build output and caches that git ignores (.gitignore) are no part of
	// a checkout.
	ignored := map[string]bool{"dist": true, ".cache": true, "prebuilt": true}
	n := 0
	err := filepath.WalkDir(".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == "." {
			return nil
		}
		if d.IsDir() && (d.Name() == ".git" || (ignored[d.Name()] && filepath.Dir(p) == ".")) {
			return filepath.SkipDir
		}
		n++
		if why := windowsRefuses(d.Name()); why != "" {
			t.Errorf("%s: the name has %s; Windows cannot check this path out (fixture trees: write it with baremetal.FixturePath)", filepath.ToSlash(p), why)
		}
		// Windows limits a whole path to 260 characters unless long paths
		// are switched on; the folder of the checkout comes on top.
		if rel := "agent/" + filepath.ToSlash(p); len(rel) > maxRepoPath {
			t.Errorf("%s: %d characters, more than %d; with the folder of a checkout the path gets too long for Windows", rel, len(rel), maxRepoPath)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n < 500 {
		t.Fatalf("only %d paths found below agent/: the test does not see the tree", n)
	}
}

func TestWindowsRefuses(t *testing.T) {
	for name, bad := range map[string]bool{
		"pci0000:00": true, "0000:00:17.0": true, "a<b": true, "a>b": true, `a"b`: true, "a|b": true, "a?b": true, "a*b": true, `a\b`: true,
		"tab\there": true, "dot.": true, "space ": true, "NUL": true, "nul.txt": true, "com1": true, "LPT9.log": true, "CONIN$": true,
		"pci0000%3A00": false, "expected.json": false, ".restow-keep": false, "console": false, "com10": false, "null": false, "a b": false, ".hidden": false,
	} {
		if got := windowsRefuses(name) != ""; got != bad {
			t.Errorf("%q: refused %v, want %v", name, got, bad)
		}
	}
}
