package baremetal

import (
	"regexp"
	"strings"
)

// Redacted replaces a secret value.
const Redacted = "<redacted>"

// SplitCmdline splits a kernel command line into parameters; double quotes
// group (a"b c"d is one parameter) and stay in the result.
func SplitCmdline(s string) []string {
	var out []string
	var cur strings.Builder
	quoted, have := false, false
	for _, r := range s {
		switch {
		case r == '"':
			quoted = !quoted
			cur.WriteRune(r)
			have = true
		case !quoted && (r == ' ' || r == '\t' || r == '\n'):
			if have {
				out = append(out, cur.String())
				cur.Reset()
				have = false
			}
		default:
			cur.WriteRune(r)
			have = true
		}
	}
	if have {
		out = append(out, cur.String())
	}
	return out
}

// secretWords mark a parameter whose value is secret.
var secretWords = []string{"password", "passwd", "secret", "key", "token", "psk"}

// notSecret are names that contain "key" without being a secret.
var notSecret = []string{"keymap", "keyboard", "keytable", "keyboard_layout"}

var urlUserinfo = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)

// RedactCmdline replaces the values of secret kernel parameters (a name
// containing password, passwd, secret, key, token or psk) and the
// credentials in netroot=/iscsi: and URL forms with <redacted>. The clear
// text exists only in the files of the snapshot (docs/BAREMETAL.md, 4.2).
func RedactCmdline(s string) string {
	params := SplitCmdline(s)
	for i, p := range params {
		name, value, ok := strings.Cut(p, "=")
		if !ok {
			continue
		}
		lname := strings.ToLower(strings.Trim(name, `"`))
		if isSecretName(lname) {
			params[i] = name + "=" + Redacted
			continue
		}
		if lname == "netroot" || strings.HasPrefix(strings.Trim(value, `"`), "iscsi:") {
			value = redactISCSI(value)
		}
		params[i] = name + "=" + urlUserinfo.ReplaceAllString(value, "${1}"+Redacted+"@")
	}
	return strings.Join(params, " ")
}

func isSecretName(name string) bool {
	for _, w := range secretWords {
		if !strings.Contains(name, w) {
			continue
		}
		if w == "key" {
			stripped := name
			for _, n := range notSecret {
				stripped = strings.ReplaceAll(stripped, n, "")
			}
			if !strings.Contains(stripped, "key") {
				continue
			}
		}
		return true
	}
	return false
}

// redactISCSI removes the credentials of an iSCSI root:
// iscsi:[user:password[:reverse-user:reverse-password]@]server:...
func redactISCSI(v string) string {
	q := strings.HasPrefix(v, `"`)
	v = strings.Trim(v, `"`)
	rest, ok := strings.CutPrefix(v, "iscsi:")
	if ok {
		if i := strings.LastIndex(rest, "@"); i >= 0 {
			v = "iscsi:" + Redacted + rest[i:]
		}
	}
	if q {
		v = `"` + v + `"`
	}
	return v
}

// cmdlineValue returns the value of the last parameter name=value.
func cmdlineValue(cmdline, name string) (string, bool) {
	val, found := "", false
	for _, p := range SplitCmdline(cmdline) {
		if k, v, ok := strings.Cut(p, "="); ok && k == name {
			val, found = strings.Trim(v, `"`), true
		}
	}
	return val, found
}
