package recovery

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The console dialogs of recover (docs/BAREMETAL.md 10.1): line by line
// (numbered choice, yes/no, input), no full-screen interface, so they work
// the same on a VGA console, a serial console and over SSH, and are
// testable through stdin. Every string from elsewhere (manifest, instance,
// tool output) goes through SanitizeForConsole.

// ErrAborted is returned when the operator aborts a dialog (or the input
// ends).
var ErrAborted = errors.New("aborted by the operator")

// UI is the console of recover.
type UI struct {
	In  io.Reader
	Out io.Writer
	// Lang is de or en.
	Lang string
	// Serial: progress is a new line every 5 seconds instead of a line
	// redrawn with \r.
	Serial bool
	// Menu is called when the operator types ? at a prompt.
	Menu func()
	// Now replaces time.Now (tests).
	Now func() time.Time

	once     sync.Once
	ch       chan lineMsg
	mu       sync.Mutex
	lastProg time.Time
	inProg   bool
}

type lineMsg struct {
	b   []byte
	err error
}

// lines is fed by one goroutine that reads the input line by line, so a
// watcher (the cancel key during the restore) and the dialogs share it
// without losing a line.
func (u *UI) lines() chan lineMsg {
	u.once.Do(func() {
		u.ch = make(chan lineMsg)
		rd := bufio.NewReader(u.In)
		go func() {
			for {
				b, err := rd.ReadBytes('\n')
				if err != nil && (len(b) == 0 || !errors.Is(err, io.EOF)) {
					zero(b)
					u.ch <- lineMsg{err: err}
					if errors.Is(err, io.EOF) {
						for {
							u.ch <- lineMsg{err: err}
						}
					}
					return
				}
				u.ch <- lineMsg{b: b}
			}
		}()
	})
	return u.ch
}

// readBytes takes the next line (with its line end).
func (u *UI) readBytes() ([]byte, error) {
	m := <-u.lines()
	if m.err != nil {
		if errors.Is(m.err, io.EOF) {
			return nil, ErrAborted
		}
		return nil, m.err
	}
	return m.b, nil
}

// TryLine waits for a line until ctx ends; ok is false then.
func (u *UI) TryLine(ctx context.Context) (string, bool) {
	select {
	case m := <-u.lines():
		if m.err != nil {
			<-ctx.Done()
			return "", false
		}
		return strings.TrimRight(string(m.b), "\r\n"), true
	case <-ctx.Done():
		return "", false
	}
}

func (u *UI) now() time.Time {
	if u.Now != nil {
		return u.Now()
	}
	return time.Now()
}

// Text is the text of id in the console's language.
func (u *UI) Text(id string, kv ...any) string { return T(u.Lang, id, kv...) }

// Say prints the text of id.
func (u *UI) Say(id string, kv ...any) { u.Line(u.Text(id, kv...)) }

// Line prints a line that is already in the console's language (texts are
// trusted, parameters were sanitized by T).
func (u *UI) Line(s string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.inProg && !u.Serial {
		fmt.Fprint(u.Out, "\n")
	}
	u.inProg = false
	fmt.Fprintln(u.Out, s)
}

// Raw prints a string from elsewhere, sanitized.
func (u *UI) Raw(s string) { u.Line(SanitizeForConsole(s)) }

func (u *UI) prompt(p string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.inProg && !u.Serial {
		fmt.Fprint(u.Out, "\n")
	}
	u.inProg = false
	fmt.Fprint(u.Out, p+" ")
}

// ReadLine reads one line (without the line end); io.EOF when the input
// ends.
func (u *UI) ReadLine() (string, error) {
	b, err := u.readBytes()
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(b), "\r\n"), nil
}

// Input asks for a line; empty input gives def. ? opens the menu and asks
// again.
func (u *UI) Input(prompt, def string) (string, error) {
	for {
		p := prompt
		if def != "" {
			p += " [" + SanitizeForConsole(def) + "]"
		}
		u.prompt(p + ":")
		line, err := u.ReadLine()
		if err != nil {
			return "", err
		}
		line = strings.TrimSpace(line)
		if line == "?" && u.Menu != nil {
			u.Menu()
			continue
		}
		if line == "" {
			return def, nil
		}
		return line, nil
	}
}

// Choose shows numbered options and returns the index chosen (0-based);
// def is the index taken on empty input (-1: no default).
func (u *UI) Choose(title string, options []string, def int) (int, error) {
	for {
		if title != "" {
			u.Line(title)
		}
		for i, o := range options {
			mark := " "
			if i == def {
				mark = "*"
			}
			u.Line(fmt.Sprintf("%s %d) %s", mark, i+1, o))
		}
		d := ""
		if def >= 0 {
			d = strconv.Itoa(def + 1)
		}
		in, err := u.Input(u.Text("ui.choose", "n", len(options)), d)
		if err != nil {
			return -1, err
		}
		n, err := strconv.Atoi(in)
		if err == nil && n >= 1 && n <= len(options) {
			return n - 1, nil
		}
		u.Say("ui.invalid")
	}
}

// YesNo asks a question; empty input gives def.
func (u *UI) YesNo(question string, def bool) (bool, error) {
	d := u.Text("ui.no")
	if def {
		d = u.Text("ui.yes")
	}
	for {
		in, err := u.Input(u.Text("ui.yesno", "question", question), d)
		if err != nil {
			return false, err
		}
		switch strings.ToLower(in) {
		case "y", "yes", "j", "ja", strings.ToLower(u.Text("ui.yes")):
			return true, nil
		case "n", "no", "nein", strings.ToLower(u.Text("ui.no")):
			return false, nil
		}
		u.Say("ui.invalid")
	}
}

// Secret reads a line without echo (when the input is a terminal). The
// caller zeroes the buffer when it is done with it.
func (u *UI) Secret(prompt string) ([]byte, error) {
	u.prompt(prompt + ":")
	restore := echoOff(u.In)
	line, err := u.readBytes()
	restore()
	u.mu.Lock()
	fmt.Fprintln(u.Out)
	u.mu.Unlock()
	if err != nil {
		return nil, err
	}
	n := len(line)
	for n > 0 && (line[n-1] == '\n' || line[n-1] == '\r') {
		n--
	}
	out := make([]byte, n)
	copy(out, line[:n])
	zero(line)
	return out, nil
}

// SecretTwice asks for a new secret twice until both entries agree and are
// not empty.
func (u *UI) SecretTwice(prompt string) ([]byte, error) {
	for {
		a, err := u.Secret(prompt)
		if err != nil {
			return nil, err
		}
		b, err := u.Secret(u.Text("ui.secret_repeat"))
		if err != nil {
			zero(a)
			return nil, err
		}
		if len(a) > 0 && string(a) == string(b) {
			zero(b)
			return a, nil
		}
		zero(a)
		zero(b)
		u.Say("ui.secret_mismatch")
	}
}

// IdentityTail is what the operator types to confirm a disk: the last four
// characters of its identity.
func IdentityTail(identity string) string {
	r := []rune(identity)
	if len(r) <= 4 {
		return identity
	}
	return string(r[len(r)-4:])
}

// TypeToConfirm asks for the last four characters of a disk's identity;
// three wrong entries abort.
func (u *UI) TypeToConfirm(model, size, identity string) (bool, error) {
	want := strings.ToLower(IdentityTail(identity))
	for try := 0; try < 3; try++ {
		in, err := u.Input(u.Text("ui.confirm_tail", "model", model, "size", size, "identity", identity), "")
		if err != nil {
			return false, err
		}
		if strings.ToLower(strings.TrimSpace(in)) == want && want != "" {
			return true, nil
		}
		u.Say("ui.invalid")
	}
	return false, nil
}

// ConfirmErase asks for the erase word (LÖSCHEN or ERASE; both are
// accepted in either language, case matters).
func (u *UI) ConfirmErase() (bool, error) {
	word := u.Text("ui.erase_word")
	in, err := u.Input(u.Text("ui.confirm_erase", "word", word), "")
	if err != nil {
		return false, err
	}
	in = strings.TrimSpace(in)
	return in == word || in == "ERASE" || in == "LÖSCHEN", nil
}

// Progress shows a progress line: redrawn with \r on a screen, a new line
// at most every 5 seconds on a serial console.
func (u *UI) Progress(s string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	s = SanitizeForConsole(s)
	if u.Serial {
		if now := u.now(); u.lastProg.IsZero() || now.Sub(u.lastProg) >= 5*time.Second {
			u.lastProg = now
			fmt.Fprintln(u.Out, s)
		}
		return
	}
	fmt.Fprint(u.Out, "\r\x1b[K"+s)
	u.inProg = true
}

// SanitizeForConsole makes a foreign string safe to print: C0 and C1
// control characters (also ESC, so no terminal sequence gets through),
// DEL, U+2028, U+2029 and invalid UTF-8 become \xNN per byte.
func SanitizeForConsole(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		bad := (r == utf8.RuneError && n <= 1) || r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) || r == 0x2028 || r == 0x2029
		if bad {
			for k := 0; k < n; k++ {
				fmt.Fprintf(&b, `\x%02x`, s[i+k])
			}
		} else {
			b.WriteString(s[i : i+n])
		}
		i += n
	}
	return b.String()
}

// zero overwrites a buffer that held a secret.
func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
