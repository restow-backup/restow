//go:build linux || darwin

package cmdrun

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestExecRunnerRunInput(t *testing.T) {
	r := ExecRunner{}
	out, err := r.RunInput(context.Background(), []byte("label: gpt\n"), 5*time.Second, 0, "cat")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "label: gpt\n" {
		t.Errorf("stdin not passed: %q", out)
	}
	out, err = r.RunInputNoKill(context.Background(), []byte("x"), 5*time.Second, 0, "cat")
	if err != nil || string(out) != "x" {
		t.Errorf("no-kill input: %q %v", out, err)
	}
	if _, err := r.RunInput(context.Background(), nil, 0, 0, "cryptsetup", "--dump-volume-key"); err == nil {
		t.Error("a forbidden argument passed RunInput")
	}
	if _, err := r.RunInput(context.Background(), []byte("0123456789"), 0, 4, "cat"); err == nil {
		t.Error("output cap of RunInput ignored")
	}
}

// TestFakeRunInputNeverRecordsStdin: the fake records only the size of the
// input, so a passphrase cannot end up in a golden file or a test log.
func TestFakeRunInputNeverRecordsStdin(t *testing.T) {
	f := NewFake(t)
	f.Add([]string{"cryptsetup", "open", "--key-file", "-", "/dev/sda3", "root"}, "", 0)
	secret := "correct-horse-battery-staple"
	if _, err := f.RunInput(context.Background(), []byte(secret), 0, 0, "cryptsetup", "open", "--key-file", "-", "/dev/sda3", "root"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.RunInputNoKill(context.Background(), []byte(secret), 0, 0, "cryptsetup", "open", "--key-file", "-", "/dev/sda3", "root"); err != nil {
		t.Fatal(err)
	}
	lines := f.CallLines()
	if strings.Contains(lines, secret) || strings.Contains(strings.Join(f.Unused(), " "), secret) {
		t.Fatalf("stdin recorded: %s", lines)
	}
	for _, c := range f.Calls() {
		for _, a := range c {
			if strings.Contains(a, "horse") {
				t.Fatalf("stdin in call %q", c)
			}
		}
	}
	if !strings.Contains(lines, StdinMarker(len(secret))) {
		t.Errorf("marker missing: %s", lines)
	}
	if len(f.Unused()) != 0 {
		t.Errorf("recording not marked used: %v", f.Unused())
	}
	if !f.RanNoKill([]string{"cryptsetup", "open", "--key-file", "-", "/dev/sda3", "root"}) {
		t.Error("no-kill not noted")
	}
}
