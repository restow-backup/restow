package share

import (
	"path"
	"strings"

	"github.com/restow-backup/restow/agent/internal/restic"
)

// SystemFilesPreset is "Skip temporary and system files" (7.5). The server
// adds it to the session's excludes; it is here for the tests and for
// documentation of what the walk skips.
var SystemFilesPreset = []string{
	"~$*", "*.tmp", "Thumbs.db", "desktop.ini", ".DS_Store", "*.lck", "$RECYCLE.BIN",
	"System Volume Information", ".snapshot", "~snapshot", "#recycle", "#snapshot", "@eaDir", ".@__thumb",
}

// Matcher applies restic's exclude semantics to the walk, so the walk skips
// exactly what restic skips: a pattern that starts with '/' is anchored at
// the file system root, any other pattern matches at any depth; `*`, `?` and
// `[...]` match within one path component, `**` any number of components; a
// pattern that matches a folder excludes everything below it.
type Matcher struct {
	patterns        [][]string
	caseInsensitive bool
}

// patternLine is the exclude-file line of one pattern. Session patterns are
// patterns, not exclude-file lines: a leading `#` is a literal character (the
// presets "#recycle" and "#snapshot"), escaped so restic does not read the
// line as a comment.
func patternLine(p string) (string, bool) {
	t := strings.TrimSpace(p)
	if strings.HasPrefix(t, "#") {
		t = `\` + t
	}
	return restic.ExcludeFileLine(t)
}

// NewMatcher compiles patterns (lines restic could not use are dropped, as
// in the exclude file).
func NewMatcher(patterns []string, caseInsensitive bool) *Matcher {
	m := &Matcher{caseInsensitive: caseInsensitive}
	for _, p := range patterns {
		line, ok := patternLine(p)
		if !ok {
			continue
		}
		line = strings.ReplaceAll(line, "$$", "$")
		if caseInsensitive {
			line = strings.ToLower(line)
		}
		anchored := strings.HasPrefix(line, "/")
		parts := strings.Split(strings.Trim(line, "/"), "/")
		if !anchored {
			parts = append([]string{"**"}, parts...)
		}
		m.patterns = append(m.patterns, parts)
	}
	return m
}

// Empty: no pattern.
func (m *Matcher) Empty() bool { return m == nil || len(m.patterns) == 0 }

// Match says whether the absolute path p (as restic sees it) is excluded.
func (m *Matcher) Match(p string) bool {
	if m.Empty() {
		return false
	}
	if m.caseInsensitive {
		p = strings.ToLower(p)
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for _, pattern := range m.patterns {
		if matchParts(pattern, parts) {
			return true
		}
	}
	return false
}

// matchParts: does pattern match a prefix of parts (a match of a folder
// excludes its subtree, so only the pattern has to be used up)?
func matchParts(pattern, parts []string) bool {
	if len(pattern) == 0 {
		return true
	}
	if pattern[0] == "**" {
		for i := 0; i <= len(parts); i++ {
			if matchParts(pattern[1:], parts[i:]) {
				return true
			}
		}
		return false
	}
	if len(parts) == 0 {
		return false
	}
	ok, err := path.Match(pattern[0], parts[0])
	if err != nil || !ok {
		return false
	}
	return matchParts(pattern[1:], parts[1:])
}

// ExcludeLines is the content of the exclude file: the job's patterns that
// restic can use, then the offline files as escaped literal paths (4.4). The
// second result lists the patterns that were dropped.
func ExcludeLines(patterns []string, literal []string) (lines []string, dropped []string) {
	for _, p := range patterns {
		if line, ok := patternLine(p); ok {
			lines = append(lines, line)
		} else if strings.TrimSpace(p) != "" {
			dropped = append(dropped, p)
		}
	}
	for _, l := range literal {
		if line, ok := restic.ExcludeFileLine(restic.EscapeIncludePath(l)); ok {
			lines = append(lines, line)
		}
	}
	return lines, dropped
}
