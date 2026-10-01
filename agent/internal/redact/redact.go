// Package redact removes secrets from text before it reaches a log, the run
// log tail that is sent to the server, or an error message.
//
// Two mechanisms work together: exact values (the agent secret, the repository
// password, the enrollment token) registered with Add, and patterns for
// well-known secret shapes (Restow token prefixes, Basic authorization
// headers, credentials inside URLs, NAME=value pairs whose name suggests a
// secret). The patterns are a safety net for text produced by third parties
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
	// Restow enrollment tokens and agent secrets.
	{regexp.MustCompile(`\brs(?:et|ea)_[A-Za-z0-9_-]{8,}`), Mask},
	// Authorization headers.
	{regexp.MustCompile(`(?i)(authorization:\s*(?:basic|bearer)\s+)[^\s"']+`), "${1}" + Mask},
	{regexp.MustCompile(`(?i)\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}`), "Basic " + Mask},
	// Credentials embedded in a URL: scheme://user:password@host
	{regexp.MustCompile(`(?i)(\b[a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)`), "${1}" + Mask + "${2}"},
	// NAME=value / name: value / "name":"value" where the name hints at a secret.
	{regexp.MustCompile(`(?i)((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)`), "${1}" + Mask},
}

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
