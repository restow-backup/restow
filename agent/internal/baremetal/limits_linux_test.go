//go:build linux

package baremetal

import (
	"fmt"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
	"syscall"
	"testing"
)

// TestSetPlannerLimits: the planner limits its data segment to 512 MiB and
// its CPU time to 30 s (docs/BAREMETAL.md 12.2). The limits hold for the
// life of a process and cannot be raised again, so the test sets them in a
// child (this test binary, started again) and never in itself: a test
// binary limited like that fails later in unrelated tests.
func TestSetPlannerLimits(t *testing.T) {
	if os.Getenv("RESTOW_TEST_PLANNER_LIMITS") == "1" {
		if err := SetPlannerLimits(); err != nil {
			fmt.Println("error:", err)
			os.Exit(3)
		}
		var data, cpu syscall.Rlimit
		_ = syscall.Getrlimit(syscall.RLIMIT_DATA, &data)
		_ = syscall.Getrlimit(syscall.RLIMIT_CPU, &cpu)
		fmt.Printf("limits data=%d/%d cpu=%d/%d heap=%d\n", data.Cur, data.Max, cpu.Cur, cpu.Max, debug.SetMemoryLimit(-1))
		os.Exit(0)
	}
	var before syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_DATA, &before); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSetPlannerLimits$")
	cmd.Env = append(os.Environ(), "RESTOW_TEST_PLANNER_LIMITS=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("the child: %v\n%s", err, out)
	}
	want := fmt.Sprintf("limits data=%d/%d cpu=%d/%d heap=%d", min(before.Cur, plannerDataLimit), min(before.Max, plannerDataLimit),
		plannerCPUSeconds, plannerCPUSeconds, plannerMemoryLimit)
	if !strings.Contains(string(out), want) {
		t.Errorf("the child reports %q, want %q", strings.TrimSpace(string(out)), want)
	}
	// This process is not limited by the test.
	var after syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_DATA, &after); err != nil || after != before {
		t.Errorf("the limits of the test process changed: %+v, before %+v (%v)", after, before, err)
	}
}
