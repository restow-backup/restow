package dbprobe

import (
	"regexp"
	"strings"
)

// Error texts of database servers never carry a credential (docs/DATABASES.md
// 10): URLs lose their user and password, the connection's user and password
// are replaced, IDENTIFIED BY clauses lose their secret, and the text is
// bounded. The server runs the same rules again (@restow/core
// databases/sanitize.ts) on everything an agent reports.

// MaxMessage bounds a message.
const MaxMessage = 500

const hidden = "***"

var (
	controlChars   = regexp.MustCompile("[\x00-\x08\x0b-\x1f\x7f]")
	urlCredentials = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^\s/@]*@`)
	keyValueSecret = regexp.MustCompile(`(?i)\b(password|passwd|pwd|pass)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s;,]+)`)
	identifiedBy   = regexp.MustCompile(`(?i)\bIDENTIFIED\s+BY\s+(PASSWORD\s+)?('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`)
	identifiedVia  = regexp.MustCompile(`(?i)\b(IDENTIFIED\s+(?:VIA|WITH)\s+[A-Za-z0-9_]+\s+(?:USING|AS))\s+(PASSWORD\s*\(\s*)?('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(\s*\))?`)
	spaces         = regexp.MustCompile(`\s+`)
)

// Sanitize removes what must never leave the agent from one message.
func Sanitize(message, user, password string) string {
	text := controlChars.ReplaceAllString(message, " ")
	text = urlCredentials.ReplaceAllString(text, "${1}"+hidden+"@")
	text = keyValueSecret.ReplaceAllString(text, "${1}="+hidden)
	text = redactIdentifiedBy(text)
	if password != "" {
		text = strings.ReplaceAll(text, password, hidden)
	}
	// A user name of one or two characters would replace letters everywhere.
	if len(user) >= 3 {
		text = strings.ReplaceAll(text, user, hidden)
	}
	text = strings.TrimSpace(spaces.ReplaceAllString(text, " "))
	if r := []rune(text); len(r) > MaxMessage {
		text = string(r[:MaxMessage-1]) + "…"
	}
	return text
}

// redactIdentifiedBy drops the secret of IDENTIFIED BY / VIA clauses.
func redactIdentifiedBy(text string) string {
	text = identifiedBy.ReplaceAllStringFunc(text, func(m string) string {
		if sub := identifiedBy.FindStringSubmatch(m); sub != nil && sub[1] != "" {
			return "IDENTIFIED BY PASSWORD '" + hidden + "'"
		}
		return "IDENTIFIED BY '" + hidden + "'"
	})
	return identifiedVia.ReplaceAllString(text, "${1} '"+hidden+"'")
}
