package baremetal

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Maximum lengths of manifest strings, in bytes of UTF-8 (contract C1).
const (
	maxStringBytes  = 4096
	maxCmdlineBytes = 8192
	maxSbatBytes    = 256
)

// errBadString is wrapped by checkString.
var errBadString = errors.New("invalid string")

// checkString rejects what may not appear in a manifest string: invalid
// UTF-8, the C0 control characters U+0000 to U+001F, DEL and the C1 controls
// U+007F to U+009F, and the line and paragraph separators U+2028 and U+2029
// (Go's encoder always escapes those two, JavaScript's never does, so they
// would make the canonical bytes differ). A label with "\x1b[" or "\r" thus
// makes the manifest invalid instead of rewriting a console line
// (docs/BAREMETAL.md, 4.2 and 16).
func checkString(s string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("%w: not valid UTF-8", errBadString)
	}
	for i, r := range s {
		if forbiddenRune(r) {
			return fmt.Errorf("%w: control character U+%04X at byte %d", errBadString, r, i)
		}
	}
	return nil
}

func forbiddenRune(r rune) bool {
	return r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0x2028 || r == 0x2029
}

// cleanString makes a value read from the machine fit for the manifest:
// invalid UTF-8 and forbidden characters become "?", and the result is cut
// to max bytes on a character boundary. Collectors use it for free text
// (models, labels, file contents); identifiers that must match exactly are
// checked with checkString instead.
func cleanString(s string, max int) string {
	if checkString(s) != nil {
		var b strings.Builder
		for _, r := range strings.ToValidUTF8(s, "?") {
			if forbiddenRune(r) {
				b.WriteByte('?')
				continue
			}
			b.WriteRune(r)
		}
		s = b.String()
	}
	if max > 0 && len(s) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut]
	}
	return s
}

// clean is cleanString with the default limit.
func clean(s string) string { return cleanString(strings.TrimSpace(s), maxStringBytes) }

// cleanPtr returns nil for an empty value.
func cleanPtr(s string) *string {
	s = clean(s)
	if s == "" {
		return nil
	}
	return &s
}
