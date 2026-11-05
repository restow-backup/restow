package cmdrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type recordingTB struct {
	errs []string
}

func (r *recordingTB) Helper() {}
func (r *recordingTB) Errorf(format string, args ...any) {
	r.errs = append(r.errs, fmt.Sprintf(format, args...))
}

func TestForbidden(t *testing.T) {
	for _, argv := range [][]string{
		{"cryptsetup", "luksDump", "--dump-volume-key", "/dev/sda3"},
		{"cryptsetup", "luksDump", "--dump-master-key", "/dev/sda3"},
		{"cryptsetup", "luksHeaderBackup", "/dev/sda3", "--header-backup-file", "x"},
		{"dmsetup", "table", "--showkeys"},
		{"dmsetup", "table", "--showkeys=1"},
	} {
		if !errors.Is(Forbidden(argv), ErrForbidden) {
			t.Errorf("%q allowed", argv)
		}
	}
	if err := Forbidden([]string{"cryptsetup", "luksDump", "--dump-json-metadata", "/dev/sda3"}); err != nil {
		t.Fatal(err)
	}
}

func TestFakeFailsOnForbiddenAndUnrecorded(t *testing.T) {
	rec := &recordingTB{}
	f := NewFake(rec).Add([]string{"dmsetup", "table", "--showkeys"}, "secret", 0)
	if _, err := f.Run(context.Background(), "dmsetup", "table", "--showkeys"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err %v", err)
	}
	if len(rec.errs) != 1 {
		t.Fatalf("the fake must fail the test on a forbidden argv: %v", rec.errs)
	}
	if _, err := f.Run(context.Background(), "lsblk", "-J"); !IsNotFound(err) {
		t.Fatalf("err %v", err)
	}
	if len(rec.errs) != 2 {
		t.Fatalf("the fake must fail the test on an unrecorded call: %v", rec.errs)
	}
	f.AllowMissing = true
	if _, err := f.Run(context.Background(), "lsblk", "-J"); !IsNotFound(err) || len(rec.errs) != 2 {
		t.Fatalf("AllowMissing: %v %v", err, rec.errs)
	}
}

func TestFakeLoadDir(t *testing.T) {
	dir := t.TempDir()
	write := func(n, s string) {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("01.cmd", "lvs\n--reportformat\njson\n")
	write("01.out", `{"report":[]}`)
	write("02.cmd", "btrfs\nfilesystem\nusage\n/\n")
	write("02.exit", "1\n")
	write("02.err", "ERROR: not a btrfs filesystem\n")
	f, err := LoadDir(t, dir)
	if err != nil {
		t.Fatal(err)
	}
	out, err := f.Run(context.Background(), "lvs", "--reportformat", "json")
	if err != nil || string(out) != `{"report":[]}` {
		t.Fatalf("%q %v", out, err)
	}
	_, err = f.Run(context.Background(), "btrfs", "filesystem", "usage", "/")
	var ee *ExitError
	if !errors.As(err, &ee) || ee.Code != 1 || ExitCode(err) != 1 {
		t.Fatalf("%v", err)
	}
	if len(f.Unused()) != 0 || f.CallLines() != "lvs --reportformat json\nbtrfs filesystem usage /\n" {
		t.Fatalf("%v %q", f.Unused(), f.CallLines())
	}
}

func TestExecRunner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /bin")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "tool")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"$LC_ALL $1\"\n[ \"$1\" = fail ] && { echo oops >&2; exit 3; }\n[ \"$1\" = big ] && head -c 2000 /dev/zero\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := ExecRunner{Dirs: []string{dir}, MaxOutput: 1000}
	out, err := r.Run(context.Background(), "tool", "x")
	if err != nil || string(out) != "C x\n" {
		t.Fatalf("%q %v", out, err)
	}
	_, err = r.Run(context.Background(), "tool", "fail")
	if ExitCode(err) != 3 {
		t.Fatalf("%v", err)
	}
	if _, err := r.Run(context.Background(), "tool", "big"); !errors.Is(err, ErrOutputTooLarge) {
		t.Fatalf("%v", err)
	}
	if _, err := r.Run(context.Background(), "missing"); !IsNotFound(err) {
		t.Fatalf("%v", err)
	}
	if _, err := r.Run(context.Background(), "tool", "--showkeys"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("%v", err)
	}
	if _, err := r.Run(context.Background(), "../tool"); err == nil {
		t.Fatal("path accepted")
	}
}

func TestExecRunnerNoKill(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /bin/sh")
	}
	dir := t.TempDir()
	mark := filepath.Join(dir, "mark")
	// The tool ignores the first SIGTERM for a moment (like lvm2 in its
	// critical section) and then exits by itself.
	script := filepath.Join(dir, "tool")
	body := "#!/bin/sh\ntrap 'sleep 0.3; echo term > " + mark + "; exit 7' TERM\nsleep 0.4 &\nwait $!\n" +
		"[ \"$1\" = long ] && { sleep 5 & wait $!; }\necho done\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	r := ExecRunner{Dirs: []string{dir}}
	// The caller's cancellation does not reach the command.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := r.RunNoKill(ctx, 0, "tool")
	if err != nil || string(out) != "done\n" {
		t.Fatalf("cancelled context reached the command: %q %v", out, err)
	}
	// At the time limit: SIGTERM, then waited for (the trap ran to its end,
	// it was not killed).
	_, err = r.RunNoKill(context.Background(), 100*time.Millisecond, "tool", "long")
	if err == nil || !strings.Contains(err.Error(), "SIGTERM") {
		t.Fatalf("%v", err)
	}
	if b, rerr := os.ReadFile(mark); rerr != nil || strings.TrimSpace(string(b)) != "term" {
		t.Fatalf("the command was killed before its SIGTERM handler finished: %q %v", b, rerr)
	}
	// RunNoKill on a plain Runner drops the cancellation.
	f := NewFake(t).Add([]string{"lvremove", "-y", "vg0/x"}, "", 0)
	if _, err := RunNoKill(ctx, f, time.Minute, "lvremove", "-y", "vg0/x"); err != nil || !f.RanNoKill([]string{"lvremove", "-y", "vg0/x"}) {
		t.Fatalf("%v", err)
	}
}
