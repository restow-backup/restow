//go:build windows && windowsintegration

package procctl

import (
	"os/exec"
	"testing"
	"time"
)

func TestJobTerminateEndsTheChild(t *testing.T) {
	cmd := exec.Command("ping", "-n", "60", "127.0.0.1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if err := job.Terminate(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the child survived TerminateJobObject")
	}
}
