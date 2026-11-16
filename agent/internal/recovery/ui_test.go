package recovery

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func newTestUI(input string) (*UI, *bytes.Buffer) {
	var out bytes.Buffer
	return &UI{In: strings.NewReader(input), Out: &out, Lang: LangEN}, &out
}

func TestUIConfirmDisk(t *testing.T) {
	disks := []string{"/dev/sda  Samsung  1.0 TB  wwn.5000c500a1b2c3d4  will be erased"}
	ui, out := newTestUI("c3d4\nERASE\n")
	ok, err := ui.TypeToConfirm("/dev/sda", "Samsung", "1.0 TB", "wwn.5000c500a1b2c3d4")
	if err != nil || !ok {
		t.Fatalf("tail: %v %v", ok, err)
	}
	// The prompt for one disk names it by path, model, size and identity
	// and says that it is erased.
	for _, want := range []string{"/dev/sda", "Samsung", "1.0 TB", "wwn.5000c500a1b2c3d4", "ERASED"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the prompt for a disk lacks %q:\n%s", want, out.String())
		}
	}
	out.Reset()
	if ok, err := ui.ConfirmErase(disks); err != nil || !ok {
		t.Fatalf("erase word: %v %v", ok, err)
	}
	// The disks stand right above the erase word.
	if got := out.String(); !strings.Contains(got, disks[0]) || strings.Index(got, disks[0]) > strings.Index(got, "Type ERASE") ||
		!strings.Contains(got, T(LangEN, "confirm.title")) {
		t.Errorf("the erase prompt does not list the disks above the word:\n%s", got)
	}
	// A wrong tail three times aborts.
	ui, _ = newTestUI("0000\n1111\n2222\n")
	if ok, _ := ui.TypeToConfirm("/dev/sda", "m", "1 GB", "wwn.5000c500a1b2c3d4"); ok {
		t.Error("a wrong tail was accepted")
	}
	// German: LÖSCHEN, and ERASE for a keyboard without Ö (the prompt
	// says so); a wrong word refuses.
	ui, out = newTestUI("LÖSCHEN\nERASE\nloeschen\n")
	ui.Lang = LangDE
	if ok, _ := ui.ConfirmErase(disks); !ok {
		t.Error("LÖSCHEN refused")
	}
	if !strings.Contains(out.String(), "LÖSCHEN (oder ERASE)") || !strings.Contains(out.String(), "GELÖSCHT") {
		t.Errorf("the German erase prompt:\n%s", out.String())
	}
	if ok, _ := ui.ConfirmErase(disks); !ok {
		t.Error("ERASE refused in German")
	}
	if ok, _ := ui.ConfirmErase(disks); ok {
		t.Error("a wrong erase word was accepted")
	}
	// Without a disk to name, nothing is confirmed (and nothing is asked).
	ui, out = newTestUI("ERASE\n")
	if ok, _ := ui.ConfirmErase(nil); ok || out.Len() != 0 {
		t.Errorf("an erase without disks was confirmed:\n%s", out.String())
	}
	// End of input aborts.
	ui, _ = newTestUI("")
	if _, err := ui.TypeToConfirm("/dev/sda", "m", "1 GB", "serial.X1"); !errors.Is(err, ErrAborted) {
		t.Errorf("end of input: %v", err)
	}
}

func TestUIChooseYesNoMenu(t *testing.T) {
	menu := 0
	ui, out := newTestUI("?\n9\n2\n\nj\nmaybe\nn\n")
	ui.Menu = func() { menu++ }
	i, err := ui.Choose("pick", []string{"a", "b"}, 0)
	if err != nil || i != 1 || menu != 1 {
		t.Fatalf("choose: %d %v menu %d", i, err, menu)
	}
	if !strings.Contains(out.String(), "Invalid input") {
		t.Error("an invalid choice was not reported")
	}
	if i, _ := ui.Choose("", []string{"a", "b"}, 0); i != 0 {
		t.Errorf("default: %d", i)
	}
	if ok, _ := ui.YesNo("continue", false); !ok {
		t.Error("j is yes")
	}
	if ok, _ := ui.YesNo("continue", true); ok {
		t.Error("n after an invalid answer is no")
	}
}

func TestUISecretAndResume(t *testing.T) {
	ui, out := newTestUI("geheim-1\ngeheim-2\ngeheim-1\ngeheim-1\n")
	b, err := ui.SecretTwice("passphrase")
	if err != nil || string(b) != "geheim-1" {
		t.Fatalf("secret: %q %v", b, err)
	}
	if strings.Contains(out.String(), "geheim") {
		t.Error("the secret was echoed")
	}
	if !strings.Contains(out.String(), "differ") {
		t.Error("the mismatch was not reported")
	}
	zero(b)
	if b[0] != 0 {
		t.Error("zero")
	}
}

// TestUITypedSPKI: the whole check value is required; a prefix fails.
func TestUITypedSPKI(t *testing.T) {
	check := "ABCD-EFGH-JKMN-PQRS"
	for typed, want := range map[string]bool{"abcd efgh jkmn pqrs": true, "ABCDEFGHJKMNPQRS": true, "ABCD-EFGH": false, "": false, "ABCD-EFGH-JKMN-PQRT": false} {
		if got := SPKICheckMatches(typed, check); got != want {
			t.Errorf("%q: %v, want %v", typed, got, want)
		}
	}
}

func TestUITryLineAndProgress(t *testing.T) {
	ui, out := newTestUI("a\n")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if l, ok := ui.TryLine(ctx); !ok || l != "a" {
		t.Errorf("TryLine: %q %v", l, ok)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel2()
	if _, ok := ui.TryLine(ctx2); ok {
		t.Error("TryLine after the end of input")
	}
	now := time.Unix(1000, 0)
	ui.Serial, ui.Now = true, func() time.Time { return now }
	ui.Progress("one")
	ui.Progress("two")
	now = now.Add(6 * time.Second)
	ui.Progress("three")
	if s := out.String(); !strings.Contains(s, "one\n") || strings.Contains(s, "two") || !strings.Contains(s, "three\n") {
		t.Errorf("serial progress: %q", s)
	}
	ui2, out2 := newTestUI("")
	ui2.Progress("x")
	ui2.Line("done")
	if s := out2.String(); !strings.Contains(s, "\r\x1b[Kx\ndone\n") {
		t.Errorf("screen progress: %q", s)
	}
}

func TestSanitizeForConsole(t *testing.T) {
	for in, want := range map[string]string{
		"plain äöü":   "plain äöü",
		"\x1b[2J":     `\x1b[2J`,
		"a\rb\nc\td":  `a\x0db\x0ac\x09d`,
		"c1\u0085x":   `c1\xc2\x85x`,
		"bad\xffutf8": `bad\xffutf8`,
		"line sep":    `line\xe2\x80\xa8sep`,
		"del\x7f":     `del\x7f`,
		"‮RTL stays":  "‮RTL stays",
	} {
		if got := SanitizeForConsole(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if IdentityTail("ab") != "ab" || IdentityTail("serial.S1234-1") != "34-1" {
		t.Error("identity tail")
	}
}
