//go:build unix

package hooks

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type collector struct {
	mu    sync.Mutex
	lines []string
}

func (c *collector) add(l string) { c.mu.Lock(); c.lines = append(c.lines, l); c.mu.Unlock() }
func (c *collector) joined() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.lines, "|")
}

func TestHookSuccessCapturesBothStreams(t *testing.T) {
	var c collector
	res, err := Run(context.Background(), Options{Kind: Pre, Command: "echo out; echo err >&2; echo \"id=$RESTOW_ENDPOINT_ID\"",
		Timeout: 10 * time.Second, Env: []string{"RESTOW_ENDPOINT_ID=ep-1"}, Output: c.add})
	if err != nil || res.ExitCode != 0 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	got := c.joined()
	for _, want := range []string{"out", "err", "id=ep-1"} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q: %s", want, got)
		}
	}
}

func TestHookFailureExitCode(t *testing.T) {
	var c collector
	res, err := Run(context.Background(), Options{Kind: Pre, Command: "echo dumping; exit 7", Timeout: 10 * time.Second, Output: c.add})
	var he *Error
	if !errors.As(err, &he) || he.ExitCode != 7 || he.TimedOut || res.ExitCode != 7 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(c.joined(), "dumping") {
		t.Fatalf("output of a failed hook must be kept: %s", c.joined())
	}
	if !strings.Contains(he.Error(), "exit code 7") {
		t.Fatalf("message: %s", he.Error())
	}
}

func TestHookTimeoutKillsProcessTree(t *testing.T) {
	var c collector
	start := time.Now()
	// The inner sleep would outlive the shell if only the shell were killed.
	res, err := Run(context.Background(), Options{Kind: Post, Command: "echo begin; sleep 60 & sleep 60; echo never", Timeout: 300 * time.Millisecond, Output: c.add})
	var he *Error
	if !errors.As(err, &he) || !he.TimedOut || !res.TimedOut {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if time.Since(start) > 15*time.Second {
		t.Fatalf("timeout not enforced promptly: %v", time.Since(start))
	}
	if strings.Contains(c.joined(), "never") {
		t.Fatal("hook kept running after the timeout")
	}
	if !strings.Contains(he.Error(), "did not finish") {
		t.Fatalf("message: %s", he.Error())
	}
}

func TestHookContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	_, err := Run(ctx, Options{Kind: Pre, Command: "sleep 60", Timeout: time.Minute})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestHookEnvironmentIsReduced(t *testing.T) {
	t.Setenv("AWS_SECRET_ACCESS_KEY", "do-not-leak")
	var c collector
	_, err := Run(context.Background(), Options{Kind: Pre, Command: "env", Timeout: 10 * time.Second, Output: c.add})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(c.joined(), "do-not-leak") {
		t.Fatal("hook inherited a foreign secret from the agent environment")
	}
}

func TestEmptyCommandIsNoop(t *testing.T) {
	if res, err := Run(context.Background(), Options{Kind: Pre, Command: "  "}); err != nil || res.Duration != 0 {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestBackgroundChildHoldingPipeDoesNotHang(t *testing.T) {
	start := time.Now()
	_, err := Run(context.Background(), Options{Kind: Pre, Command: "(sleep 30 &) ; echo done", Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 8*time.Second {
		t.Fatalf("hung on a daemonised child: %v", time.Since(start))
	}
}
