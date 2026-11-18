package dbrun

import (
	"bytes"
	"errors"
	"io"
	"regexp"
	"strings"
)

// The dump of mysqldump or mariadb-dump read as text (16 "D4" M3, M4), like
// packages/core databases/mysql-tools.ts MysqlDumpScanner: line by line,
// without holding a long line (only the beginning of a possible DDL header,
// up to 64 KiB, is looked at; an INSERT or any other line passes as it
// comes); it knows where a statement starts, so a line inside the body of a
// routine never counts. It counts the objects and, for a restore, removes the
// DEFINER clause from exactly the header forms the dump programs write and
// sets every event header to DISABLE. A header longer than it looks at is
// rewritten within its first bytes, or the restore stops (Failure).

const (
	scanHeadMax     = 64 << 10
	scanDecideBytes = 16
)

// scanQuoted is a quoted name: backticks, or double quotes as the dump
// programs write under ANSI_QUOTES.
const scanQuoted = "(?:`(?:[^`]|``)*`|\"(?:[^\"]|\"\")*\")"

// scanRoutineKinds are the routines' kinds, MariaDB's packages included.
const scanRoutineKinds = "PROCEDURE|FUNCTION|AGGREGATE FUNCTION|PACKAGE BODY|PACKAGE"

var (
	scanDefiner        = "DEFINER=" + scanQuoted + "(?:@" + scanQuoted + ")?"
	scanRoutine        = regexp.MustCompile("^CREATE (?:" + scanDefiner + " )?(" + scanRoutineKinds + ") ")
	scanRoutineDefiner = regexp.MustCompile("^CREATE " + scanDefiner + " ((?:" + scanRoutineKinds + ") )")
	scanTrigger        = regexp.MustCompile(`^/\*!50003 CREATE\*/ (?:/\*!50017 ` + scanDefiner + `\s?\*/ )?/\*!50003 TRIGGER `)
	scanTriggerDefiner = regexp.MustCompile(`^(/\*!50003 CREATE\*/ )/\*!50017 ` + scanDefiner + `\s?\*/ (/\*!50003 TRIGGER )`)
	scanEvent          = regexp.MustCompile(`^/\*!50106 CREATE\*/ (?:/\*!50117 ` + scanDefiner + `\s?\*/ )?/\*!50106 EVENT `)
	scanEventDefiner   = regexp.MustCompile(`^(/\*!50106 CREATE\*/ )/\*!50117 ` + scanDefiner + `\s?\*/ (/\*!50106 EVENT )`)
	scanViewStart      = regexp.MustCompile(`^/\*!50001 CREATE ALGORITHM=`)
	scanViewDefiner    = regexp.MustCompile(`^/\*!50013 ` + scanDefiner + ` SQL SECURITY (DEFINER|INVOKER) \*/\s*$`)
	scanViewBody       = regexp.MustCompile(`^/\*!50001 VIEW `)
)

const scanEventNameAt = "/*!50106 EVENT "

// isWordByte is a byte of an unquoted name or keyword; a name may begin with
// a digit (1DO is no DO).
func isWordByte(c byte) bool {
	return c == '_' || c == '$' || (c >= '0' && c <= '9') || (c|0x20 >= 'a' && c|0x20 <= 'z') || c >= 0x80
}

// quotedEnd is the end of the quoted word that starts at start, or -1 when it
// is cut.
func quotedEnd(line string, start int) int {
	quote := line[start]
	for i := start + 1; i < len(line); {
		c := line[i]
		if c == '\\' && quote != '`' {
			i += 2
			continue
		}
		if c == quote {
			if i+1 < len(line) && line[i+1] == quote {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return -1
}

// MysqlDisableEvent is an event's header with its status set to DISABLE (core
// mysqlDisableEvent): every ENABLE between the name and DO, outside quotes,
// becomes DISABLE; a header without a status gets DISABLE before DO. ok is
// false when DO is not on the line.
func MysqlDisableEvent(line string, from int) (string, bool) {
	var enables []int
	sawStatus := false
	for i := from; i < len(line); {
		c := line[i]
		switch {
		case c == '`' || c == '\'' || c == '"':
			i = quotedEnd(line, i)
			if i < 0 {
				return "", false
			}
		case isWordByte(c):
			j := i
			for j < len(line) && isWordByte(line[j]) {
				j++
			}
			if j == len(line) {
				return "", false
			}
			switch strings.ToUpper(line[i:j]) {
			case "DO":
				out := line
				if !sawStatus {
					out = line[:i] + "DISABLE " + line[i:]
				}
				for k := len(enables) - 1; k >= 0; k-- {
					at := enables[k]
					out = out[:at] + "DISABLE" + out[at+len("ENABLE"):]
				}
				return out, true
			case "ENABLE":
				enables = append(enables, i)
				sawStatus = true
			case "DISABLE":
				sawStatus = true
			}
			i = j
		default:
			i++
		}
	}
	return "", false
}

func scanCandidate(head string) bool {
	for _, prefix := range []string{"CREATE ", "/*!50001 ", "/*!50003 ", "/*!50013 ", "/*!50106 "} {
		if strings.HasPrefix(head, prefix) {
			return true
		}
	}
	return strings.HasPrefix("CREATE ", head) || strings.HasPrefix("/*!50", head)
}

// MysqlDumpScanner reads a dump; see the comment at the top of this file.
type MysqlDumpScanner struct {
	Counts          map[string]int
	DefinersRemoved int
	// EventsDisabled counts the event headers set to DISABLE (restore).
	EventsDisabled int
	// Failure says why a restore must stop: a header the filter has to
	// rewrite could not be checked. Nothing after it is handed on.
	Failure   string
	strip     bool
	head      []byte
	passing   bool
	tail      string
	delimiter string
	atStart   bool
	viewLine  int
}

// NewMysqlDumpScanner makes a scanner; stripDefiners for a restore.
func NewMysqlDumpScanner(stripDefiners bool) *MysqlDumpScanner {
	return &MysqlDumpScanner{Counts: map[string]int{}, strip: stripDefiners, delimiter: ";", atStart: true}
}

// Push returns the bytes to hand on for chunk.
func (s *MysqlDumpScanner) Push(chunk []byte) []byte {
	var out []byte
	for len(chunk) > 0 && s.Failure == "" {
		nl := bytes.IndexByte(chunk, '\n')
		end := len(chunk)
		if nl >= 0 {
			end = nl + 1
		}
		piece := chunk[:end]
		chunk = chunk[end:]
		if s.passing {
			out = append(out, piece...)
			s.noteTail(piece)
			if nl >= 0 {
				s.passing = false
				s.endLine(nil)
			}
			continue
		}
		// A line longer than scanHeadMax is judged by its first scanHeadMax+1
		// bytes, however the chunks fall; the rest of it passes.
		content := len(piece)
		if nl >= 0 {
			content--
		}
		room := scanHeadMax + 1 - len(s.head)
		var rest []byte
		if content >= room {
			s.head = append(s.head, piece[:room]...)
			rest = piece[room:]
		} else {
			s.head = append(s.head, piece...)
			if nl >= 0 {
				out = append(out, s.finishLine()...)
				continue
			}
		}
		if len(s.head) > scanHeadMax || (len(s.head) >= scanDecideBytes && !scanCandidate(string(s.head[:scanDecideBytes]))) {
			start := s.head
			prefix := string(start)
			handed := prefix
			if s.strip {
				var ok bool
				if handed, ok = s.lookPrefix(prefix); !ok {
					break
				}
			} else {
				s.look(prefix, false)
			}
			out = append(out, handed...)
			s.head = nil
			s.passing = true
			s.tail = ""
			s.noteTail(start)
			if rest != nil {
				out = append(out, rest...)
				s.noteTail(rest)
				if nl >= 0 {
					s.passing = false
					s.endLine(nil)
				}
			}
		}
	}
	return out
}

// End returns what is still held at the end of the stream.
func (s *MysqlDumpScanner) End() []byte {
	if s.passing || len(s.head) == 0 || s.Failure != "" {
		return nil
	}
	return s.finishLine()
}

// lookPrefix handles the beginning of a line too long to hold (restore): a
// header form must be complete and rewritten within it (look refuses any
// other), or the restore stops.
func (s *MysqlDumpScanner) lookPrefix(prefix string) (string, bool) {
	rewritten := s.look(prefix, true)
	return rewritten, s.Failure == ""
}

func (s *MysqlDumpScanner) noteTail(piece []byte) {
	text := strings.TrimRight(string(piece), " \t\r\n\f\v")
	if text != "" {
		t := s.tail + text
		if len(t) > 8 {
			t = t[len(t)-8:]
		}
		s.tail = t
	}
}

func (s *MysqlDumpScanner) finishLine() []byte {
	line := string(s.head)
	s.head = nil
	eol := ""
	if strings.HasSuffix(line, "\r\n") {
		eol = "\r\n"
	} else if strings.HasSuffix(line, "\n") {
		eol = "\n"
	}
	body := line[:len(line)-len(eol)]
	rewritten := s.look(body, s.strip)
	if s.Failure != "" {
		return nil
	}
	s.endLine(&body)
	return []byte(rewritten + eol)
}

func (s *MysqlDumpScanner) look(line string, rewrite bool) string {
	if s.viewLine > 0 {
		s.viewLine++
		if s.viewLine <= 3 && scanViewDefiner.MatchString(line) {
			if !rewrite {
				return line
			}
			s.DefinersRemoved++
			m := scanViewDefiner.FindStringSubmatch(line)
			return "/*!50013 SQL SECURITY " + m[1] + " */"
		}
		if s.viewLine <= 3 && scanViewBody.MatchString(line) {
			s.Counts["VIEW"]++
			s.viewLine = 0
			return line
		}
		if rewrite && s.viewLine <= 3 && strings.HasPrefix(line, "/*!50013 ") {
			return s.unchecked(line)
		}
		return line
	}
	if !s.atStart {
		return line
	}
	switch {
	case strings.HasPrefix(line, "CREATE TABLE "):
		s.Counts["TABLE"]++
	case strings.HasPrefix(line, "CREATE SEQUENCE "):
		s.Counts["SEQUENCE"]++
	case scanViewStart.MatchString(line):
		s.viewLine = 1
	case scanRoutine.MatchString(line):
		kind := strings.TrimPrefix(scanRoutine.FindStringSubmatch(line)[1], "AGGREGATE ")
		s.Counts[kind]++
		if rewrite && scanRoutineDefiner.MatchString(line) {
			s.DefinersRemoved++
			loc := scanRoutineDefiner.FindStringSubmatchIndex(line)
			return "CREATE " + line[loc[2]:]
		}
	case scanTrigger.MatchString(line):
		s.Counts["TRIGGER"]++
		if rewrite && scanTriggerDefiner.MatchString(line) {
			s.DefinersRemoved++
			loc := scanTriggerDefiner.FindStringSubmatchIndex(line)
			return line[loc[2]:loc[3]] + line[loc[4]:]
		}
	case scanEvent.MatchString(line):
		s.Counts["EVENT"]++
		if !rewrite {
			return line
		}
		header := line
		if scanEventDefiner.MatchString(line) {
			s.DefinersRemoved++
			loc := scanEventDefiner.FindStringSubmatchIndex(line)
			header = line[loc[2]:loc[3]] + line[loc[4]:]
		}
		// Never created enabled: a copy runs no job of the source, not even
		// before the run switches its events off at the end.
		disabled, ok := MysqlDisableEvent(header, strings.Index(header, scanEventNameAt)+len(scanEventNameAt))
		if !ok {
			s.Failure = "an event header of the backup could not be checked"
			return line
		}
		s.EventsDisabled++
		return disabled
	case rewrite && (strings.HasPrefix(line, "CREATE ") || strings.HasPrefix(line, "/*!50003 CREATE*/") ||
		strings.HasPrefix(line, "/*!50106 CREATE*/") || strings.HasPrefix(line, "/*!50013 ")):
		// Fail closed: a statement that begins like a header but in no form the
		// dump programs write may carry a definer the filter cannot see.
		return s.unchecked(line)
	}
	return line
}

func (s *MysqlDumpScanner) unchecked(line string) string {
	s.Failure = "a statement header of the backup is in no form Restow checks"
	return line
}

func (s *MysqlDumpScanner) endLine(body *string) {
	t := s.tail
	s.tail = ""
	if body != nil {
		trimmed := strings.TrimRight(*body, " \t\r\n\f\v")
		if strings.HasPrefix(trimmed, "DELIMITER ") {
			d := strings.TrimSpace(strings.TrimPrefix(trimmed, "DELIMITER "))
			if d == "" {
				d = ";"
			}
			s.delimiter = d
			s.atStart = true
			s.viewLine = 0
			return
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			return
		}
		t = trimmed
	}
	s.atStart = strings.HasSuffix(t, s.delimiter)
	if s.atStart {
		s.viewLine = 0
	}
}

// definerFilter is the restore's writer: definers removed on the way to w.
type definerFilter struct {
	w io.Writer
	s *MysqlDumpScanner
}

func (f *definerFilter) Write(p []byte) (int, error) {
	if out := f.s.Push(p); len(out) > 0 {
		if _, err := f.w.Write(out); err != nil {
			return 0, err
		}
	}
	if f.s.Failure != "" {
		return 0, errors.New(f.s.Failure)
	}
	return len(p), nil
}

// Close writes what is still held.
func (f *definerFilter) Close() error {
	if out := f.s.End(); len(out) > 0 {
		if _, err := f.w.Write(out); err != nil {
			return err
		}
	}
	if f.s.Failure != "" {
		return errors.New(f.s.Failure)
	}
	return nil
}
