package restic

import "strings"

// EscapeIncludePath turns a snapshot path into a restic --include pattern that
// matches exactly that path, by escaping the characters restic's glob matcher
// treats specially. Snapshot paths use forward slashes.
func EscapeIncludePath(path string) string {
	if !strings.ContainsAny(path, `*?[\`) {
		return path
	}
	var b strings.Builder
	b.Grow(len(path) + 4)
	for _, r := range path {
		switch r {
		case '*', '?', '[', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// escapeIncludePathWindows is EscapeIncludePath for restic on Windows, where
// restic cleans every pattern with filepath.Clean and the backslash becomes
// a path separator, so escaping with \ does not work (docs/WINDOWS-AGENT.md,
// 16.4). A [ is written as the class [[]; * and ? cannot occur in Windows
// file names, and ] alone is no special character.
func escapeIncludePathWindows(path string) string {
	return strings.ReplaceAll(path, "[", "[[]")
}

// includeFor is the pattern and the option restic restores one snapshot
// path with: on Windows without case (--iinclude), since Windows paths do
// not depend on it.
func includeFor(path string, windows bool) (option, pattern string) {
	if windows {
		return "--iinclude", escapeIncludePathWindows(path)
	}
	return "--include", EscapeIncludePath(path)
}

// excludeFileLine prepares one exclude pattern for --exclude-file. restic
// trims whitespace, treats lines starting with # as comments and expands
// environment variables ($ is written as $$). ok is false for patterns that
// cannot be represented (empty, or starting with #).
func excludeFileLine(pattern string) (line string, ok bool) {
	p := strings.TrimSpace(pattern)
	if p == "" || strings.HasPrefix(p, "#") || strings.ContainsAny(p, "\n\r\x00") {
		return "", false
	}
	return strings.ReplaceAll(p, "$", "$$"), true
}
