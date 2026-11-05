// Package redact removes secrets from text before it reaches a log, the run
// log tail that is sent to the server, or an error message.
//
// Two mechanisms work together: exact values (the agent secret, the repository
// password, the enrollment token) registered with Add, and patterns for
// well-known secret shapes (Restow token prefixes, Basic authorization
// headers, credentials inside URLs, NAME=value pairs whose name suggests a
// secret, recovery codes, 64-digit hexadecimal session secrets and code
// proofs). The patterns are a safety net for text produced by third parties
// (restic, hooks); they do not make it safe to print secrets on purpose.
package redact

import (
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Mask replaces every redacted value.
const Mask = "[REDACTED]"

// minSecretLen keeps very short values (which would garble unrelated text)
// out of the exact-match list. Generated Restow secrets are far longer.
const minSecretLen = 8

var patterns = []struct {
	re   *regexp.Regexp
	repl string
}{
	// Key material (PEM, OpenSSH): from BEGIN to END, or to the end of the
	// text when the END is missing. KeyBlocks does this across lines.
	{keyBlock, Mask},
	// Restow enrollment and reconnect tokens and agent secrets.
	{regexp.MustCompile(`\brs(?:et|ea)_[A-Za-z0-9_-]{8,}`), Mask},
	// Recovery codes (RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, dashes optional).
	{regexp.MustCompile(`(?i)\bRC-?(?:[0-9A-HJKMNP-TV-X]{5}-?){4}[0-9A-HJKMNP-TV-X]{5}\b`), Mask},
	// 64-digit hexadecimal values after a name like sessionSecret, codeProof,
	// secret or password (recovery session secrets and code proofs).
	{regexp.MustCompile(`(?i)((?:session[A-Za-z0-9_]*|codeProof|secret|password)["']?\s*[=:]\s*["']?)[0-9a-f]{64}`), "${1}" + Mask},
	// Authorization headers.
	{regexp.MustCompile(`(?i)(authorization:\s*(?:basic|bearer)\s+)[^\s"']+`), "${1}" + Mask},
	{regexp.MustCompile(`(?i)\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}`), "Basic " + Mask},
	// Credentials embedded in a URL: scheme://user:password@host
	{regexp.MustCompile(`(?i)(\b[a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)`), "${1}" + Mask + "${2}"},
	// NAME=value / name: value / "name":"value" where the name hints at a secret.
	{regexp.MustCompile(`(?i)((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)`), "${1}" + Mask},
}

var (
	keyBlock      = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]+-----.*?(?:-----END [A-Z ]+-----|$)`)
	keyBlockShut  = regexp.MustCompile(`-----BEGIN [A-Z ]+-----.*?-----END [A-Z ]+-----`)
	keyBlockBegin = regexp.MustCompile(`-----BEGIN [A-Z ]+-----`)
	keyBlockEnd   = regexp.MustCompile(`-----END [A-Z ]+-----`)
)

// KeyBlocks masks key material in text that is redacted line by line (a
// log): every line from a BEGIN line to its END line is masked, also when
// the lines come in separate calls. The zero value is ready to use; it is
// not safe for concurrent use.
type KeyBlocks struct {
	open bool
}

// Line returns line redacted with r, masked where it is inside a key block.
func (k *KeyBlocks) Line(r *Redactor, line string) string {
	prefix := ""
	rest := line
	if k.open {
		loc := keyBlockEnd.FindStringIndex(rest)
		if loc == nil {
			return Mask
		}
		k.open = false
		prefix = Mask
		rest = rest[loc[1]:]
	}
	rest = keyBlockShut.ReplaceAllString(rest, Mask)
	if loc := keyBlockBegin.FindStringIndex(rest); loc != nil {
		k.open = true
		return prefix + r.Redact(rest[:loc[0]]) + Mask
	}
	return prefix + r.Redact(rest)
}

// Open reports whether the last line ended inside a key block.
func (k *KeyBlocks) Open() bool { return k.open }

// Redactor holds the exact secret values to remove. The zero value is ready
// to use and safe for concurrent use.
type Redactor struct {
	mu      sync.RWMutex
	secrets []string // sorted by length, longest first
}

// Default is the process-wide redactor used by the logger and the run log.
var Default = &Redactor{}

// Add registers secret values. Values shorter than eight characters are
// ignored. Common encodings of a value (URL escaped) are registered too.
func (r *Redactor) Add(values ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range values {
		for _, form := range forms(v) {
			if len(form) < minSecretLen || r.has(form) {
				continue
			}
			r.secrets = append(r.secrets, form)
		}
	}
	sort.SliceStable(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
}

func (r *Redactor) has(v string) bool {
	for _, s := range r.secrets {
		if s == v {
			return true
		}
	}
	return false
}

func forms(v string) []string {
	out := []string{v}
	if q := url.QueryEscape(v); q != v {
		out = append(out, q)
	}
	if p := url.PathEscape(v); p != v {
		out = append(out, p)
	}
	return out
}

// Redact returns s with all registered values and secret-shaped text masked.
func (r *Redactor) Redact(s string) string {
	if s == "" {
		return s
	}
	r.mu.RLock()
	for _, secret := range r.secrets {
		if strings.Contains(s, secret) {
			s = strings.ReplaceAll(s, secret, Mask)
		}
	}
	r.mu.RUnlock()
	for _, p := range patterns {
		s = p.re.ReplaceAllString(s, p.repl)
	}
	return s
}

// Redact masks s using the default redactor.
func Redact(s string) string { return Default.Redact(s) }

// Add registers secrets with the default redactor.
func Add(values ...string) { Default.Add(values...) }
