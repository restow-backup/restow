package runlog

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/redact"
)

func fixedClock() func() time.Time {
	t := time.Date(2026, 9, 30, 22, 0, 0, 0, time.UTC)
	return func() time.Time { return t }
}

func TestTailKeepsLast200Lines(t *testing.T) {
	l := New(nil)
	l.SetClock(fixedClock())
	for i := 0; i < 250; i++ {
		l.Infof("line %d", i)
	}
	lines := strings.Split(l.Tail(), "\n")
	if len(lines) != MaxLines {
		t.Fatalf("got %d lines, want %d", len(lines), MaxLines)
	}
	if !strings.HasSuffix(lines[0], "line 50") || !strings.HasSuffix(lines[199], "line 249") {
		t.Fatalf("wrong window: first=%q last=%q", lines[0], lines[199])
	}
	if l.Dropped() != 50 {
		t.Fatalf("dropped = %d, want 50", l.Dropped())
	}
}

func TestTailPartialBuffer(t *testing.T) {
	l := New(nil)
	l.SetClock(fixedClock())
	l.Infof("one")
	l.Warnf("two")
	want := "2026-09-30T22:00:00Z INFO one\n2026-09-30T22:00:00Z WARN two"
	if got := l.Tail(); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRedactsSecrets(t *testing.T) {
	r := &redact.Redactor{}
	r.Add("super-secret-repo-password")
	l := New(nil)
	l.redact = r
	l.Infof("password is super-secret-repo-password")
	l.Raw("restic", "Fatal: RESTIC_PASSWORD=abc123 rejected\nsecond line")
	tail := l.Tail()
	if strings.Contains(tail, "super-secret-repo-password") || strings.Contains(tail, "abc123") {
		t.Fatalf("secret leaked: %s", tail)
	}
	if !strings.Contains(tail, "restic: second line") {
		t.Fatalf("raw lines not split: %s", tail)
	}
}

func TestLongLineTruncated(t *testing.T) {
	l := New(nil)
	l.Infof("%s", strings.Repeat("x", 5000))
	if n := len(l.Tail()); n > 2100 {
		t.Fatalf("line not truncated: %d bytes", n)
	}
}

func TestConcurrentUse(t *testing.T) {
	l := New(nil)
	done := make(chan struct{})
	for g := 0; g < 4; g++ {
		go func(g int) {
			for i := 0; i < 100; i++ {
				l.Infof("g%d-%d", g, i)
			}
			done <- struct{}{}
		}(g)
	}
	for g := 0; g < 4; g++ {
		<-done
	}
	if got := len(strings.Split(l.Tail(), "\n")); got != MaxLines {
		t.Fatal(fmt.Sprintf("expected %d lines, got %d", MaxLines, got))
	}
}
