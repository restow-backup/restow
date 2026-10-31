package paths

// Windows path forms, as plain string functions without a build tag: the
// trust check, the restore target rules and the uninstall guard use them on
// Windows, and the tests run them on every system (path/filepath would use
// the separator of the system the tests run on).

import (
	"fmt"
	"strings"
)

// WinPathError explains why a string is not a plain local drive path.
type WinPathError struct {
	Path   string
	Reason string
}

func (e *WinPathError) Error() string { return fmt.Sprintf("%q %s", e.Path, e.Reason) }

var reservedDeviceNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true, "CONIN$": true, "CONOUT$": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
	"COM\u00b9": true, "COM\u00b2": true, "COM\u00b3": true, "LPT\u00b9": true, "LPT\u00b2": true, "LPT\u00b3": true,
}

// SplitDrivePath checks that p is a canonical local drive path (X:\a\b) and
// returns the drive ("C:") and the components below the root. Refused: UNC
// paths (\\server\share), device paths (\\?\, \\.\), drive-relative paths
// (C:foo), forward slashes, empty, "." and ".." components, a trailing
// backslash (except the root itself), a colon after the drive (alternate data
// streams), the characters <>"|?* and control characters, components ending
// in a dot or a space (Windows would silently trim them) and reserved device
// names (CON, NUL, COM1, ... also with an extension).
func SplitDrivePath(p string) (drive string, parts []string, err error) {
	fail := func(reason string) (string, []string, error) { return "", nil, &WinPathError{Path: p, Reason: reason} }
	if strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, `//`) {
		return fail("is a network or device path; only local drive paths like C:\\folder are allowed")
	}
	if len(p) < 3 || p[1] != ':' || p[2] != '\\' || !isDriveLetter(p[0]) {
		return fail("is not an absolute drive path like C:\\folder")
	}
	if strings.ContainsRune(p, '/') {
		return fail("contains a forward slash; use backslashes")
	}
	drive = strings.ToUpper(p[:2])
	rest := p[3:]
	if rest == "" {
		return drive, nil, nil
	}
	for _, c := range rest {
		switch {
		case c < 0x20 || c == 0x7f:
			return fail("contains a control character")
		case strings.ContainsRune(`<>"|?*:`, c):
			return fail(fmt.Sprintf("contains the character %q, which is not allowed in Windows paths here", c))
		}
	}
	parts = strings.Split(rest, `\`)
	for _, part := range parts {
		switch {
		case part == "":
			return fail("has an empty component (double or trailing backslash)")
		case part == "." || part == "..":
			return fail("contains \".\" or \"..\"")
		case strings.HasSuffix(part, ".") || strings.HasSuffix(part, " "):
			return fail(fmt.Sprintf("has the component %q ending in a dot or a space, which Windows trims", part))
		}
		base := strings.ToUpper(part)
		if i := strings.IndexByte(base, '.'); i >= 0 {
			base = base[:i]
		}
		if reservedDeviceNames[strings.TrimRight(base, " ")] {
			return fail(fmt.Sprintf("uses the reserved device name %q", part))
		}
	}
	return drive, parts, nil
}

func isDriveLetter(c byte) bool { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') }

// JoinDrivePath builds X:\a\b from a drive and components.
func JoinDrivePath(drive string, parts ...string) string {
	return strings.ToUpper(drive) + `\` + strings.Join(parts, `\`)
}

// CleanFinalPath turns what GetFinalPathNameByHandleW returns (\\?\C:\x) into
// a drive path with an upper-case drive letter. Paths on other volume forms
// (\\?\UNC\..., \\?\Volume{...}) come back unchanged and fail SplitDrivePath.
func CleanFinalPath(p string) string {
	p = strings.TrimPrefix(p, `\\?\`)
	if len(p) >= 2 && p[1] == ':' && isDriveLetter(p[0]) {
		p = strings.ToUpper(p[:1]) + p[1:]
	}
	if len(p) == 2 && p[1] == ':' {
		p += `\`
	}
	return p
}

// WinPathEqualOrBelow reports whether p is base or lies below it, comparing
// without regard to case (both are canonical drive paths).
func WinPathEqualOrBelow(p, base string) bool {
	p, base = strings.ToUpper(strings.TrimRight(p, `\`)), strings.ToUpper(strings.TrimRight(base, `\`))
	if base == "" {
		return false
	}
	return p == base || strings.HasPrefix(p, base+`\`)
}
