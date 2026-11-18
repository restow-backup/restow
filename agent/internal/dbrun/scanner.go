package dbrun

import (
	"bytes"
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
// DEFINER clause from exactly the header forms the dump programs write.

const (
	scanHeadMax     = 64 << 10
	scanDecideBytes = 16
)

const scanQuoted = "`(?:[^`]|``)*`"

var (
	scanDefiner        = "DEFINER=" + scanQuoted + "(?:@" + scanQuoted + ")?"
	scanRoutine        = regexp.MustCompile("^CREATE (?:" + scanDefiner + " )?(PROCEDURE|FUNCTION|AGGREGATE FUNCTION) ")
	scanRoutineDefiner = regexp.MustCompile("^CREATE " + scanDefiner + " (PROCEDURE |FUNCTION |AGGREGATE FUNCTION )")
	scanTrigger        = regexp.MustCompile(`^/\*!50003 CREATE\*/ (?:/\*!50017 ` + scanDefiner + `\s?\*/ )?/\*!50003 TRIGGER `)
	scanTriggerDefiner = regexp.MustCompile(`^(/\*!50003 CREATE\*/ )/\*!50017 ` + scanDefiner + `\s?\*/ (/\*!50003 TRIGGER )`)
	scanEvent          = regexp.MustCompile(`^/\*!50106 CREATE\*/ (?:/\*!50117 ` + scanDefiner + `\s?\*/ )?/\*!50106 EVENT `)
	scanEventDefiner   = regexp.MustCompile(`^(/\*!50106 CREATE\*/ )/\*!50117 ` + scanDefiner + `\s?\*/ (/\*!50106 EVENT )`)
	scanViewStart      = regexp.MustCompile(`^/\*!50001 CREATE ALGORITHM=`)
	scanViewDefiner    = regexp.MustCompile(`^/\*!50013 ` + scanDefiner + ` SQL SECURITY (DEFINER|INVOKER) \*/\s*$`)
	scanViewBody       = regexp.MustCompile(`^/\*!50001 VIEW `)
)

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
	strip           bool
	head            []byte
	passing         bool
	tail            string
	delimiter       string
	atStart         bool
	viewLine        int
}

// NewMysqlDumpScanner makes a scanner; stripDefiners for a restore.
func NewMysqlDumpScanner(stripDefiners bool) *MysqlDumpScanner {
	return &MysqlDumpScanner{Counts: map[string]int{}, strip: stripDefiners, delimiter: ";", atStart: true}
}

// Push returns the bytes to hand on for chunk.
func (s *MysqlDumpScanner) Push(chunk []byte) []byte {
	var out []byte
	for len(chunk) > 0 {
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
		s.head = append(s.head, piece...)
		if nl >= 0 {
			out = append(out, s.finishLine()...)
			continue
		}
		if len(s.head) > scanHeadMax || (len(s.head) >= scanDecideBytes && !scanCandidate(string(s.head[:scanDecideBytes]))) {
			start := s.head
			out = append(out, start...)
			s.head = nil
			s.passing = true
			s.tail = ""
			s.look(string(start), false)
			s.noteTail(start)
		}
	}
	return out
}

// End returns what is still held at the end of the stream.
func (s *MysqlDumpScanner) End() []byte {
	if s.passing || len(s.head) == 0 {
		return nil
	}
	return s.finishLine()
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
		}
		return line
	}
	if !s.atStart {
		return line
	}
	switch {
	case strings.HasPrefix(line, "CREATE TABLE "):
		s.Counts["TABLE"]++
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
		if rewrite && scanEventDefiner.MatchString(line) {
			s.DefinersRemoved++
			loc := scanEventDefiner.FindStringSubmatchIndex(line)
			return line[loc[2]:loc[3]] + line[loc[4]:]
		}
	}
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
	return len(p), nil
}

// Close writes what is still held.
func (f *definerFilter) Close() error {
	if out := f.s.End(); len(out) > 0 {
		_, err := f.w.Write(out)
		return err
	}
	return nil
}
