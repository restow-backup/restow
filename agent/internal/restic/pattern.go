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
