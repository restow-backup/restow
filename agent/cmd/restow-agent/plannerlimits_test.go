package main

import (
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// realPlannerLimits is what the command calls outside the tests (package
// variables are set before init runs).
var realPlannerLimits = plannerLimits

// plannerLimitsAsked counts how often a plan command asked for its limits.
var plannerLimitsAsked atomic.Int64

// The tests run `baremetal plan` inside the test binary. The limits of the
// planner are for the life of a process (and the CPU limit is hard): they
// must not reach the test binary, where they made later tests fail under
// the race detector ("ThreadSanitizer: failed to allocate", "pthread_create
// failed: Resource temporarily unavailable"). The limits themselves are
// tested in a process of their own (internal/baremetal, TestSetPlannerLimits).
func init() {
	plannerLimits = func() error {
		plannerLimitsAsked.Add(1)
		return nil
	}
}

func TestPlanCommandLimitsItsOwnProcessOnly(t *testing.T) {
	// Outside the tests the command limits itself with the real function.
	if reflect.ValueOf(realPlannerLimits).Pointer() != reflect.ValueOf(baremetal.SetPlannerLimits).Pointer() {
		t.Error("baremetal plan does not limit itself with baremetal.SetPlannerLimits")
	}
	before := processLimits(t)
	asked := plannerLimitsAsked.Load()
	manifest := readTestdata(t, "manifests/debian12-uefi-luks-lvm.json")
	out, se, code := planRun(t, manifest, "--manifest", "-", "--target", "same", "--json")
	if code != exitOK || planOutput(t, out)["ok"] != true {
		t.Fatalf("plan: exit %d\n%s", code, se)
	}
	// The command asks for its limits before it plans ...
	if got := plannerLimitsAsked.Load() - asked; got != 1 {
		t.Errorf("the plan command asked for its limits %d times, want once", got)
	}
	// ... and the test binary keeps its own.
	if after := processLimits(t); after != before {
		t.Errorf("the limits of the test process changed from %s to %s", before, after)
	}
}
