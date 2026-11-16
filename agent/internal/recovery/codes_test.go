package recovery

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

type recoverCodesFile struct {
	Problems   []string            `json:"problems"`
	Warnings   []string            `json:"warnings"`
	Checks     []string            `json:"checks"`
	Hints      []string            `json:"hints"`
	HintParams map[string][]string `json:"hintParams"`
}

func readRecoverCodes(t *testing.T) recoverCodesFile {
	t.Helper()
	b, err := os.ReadFile("testdata/recover-codes.json")
	if err != nil {
		t.Fatal(err)
	}
	var f recoverCodesFile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		t.Fatal(err)
	}
	return f
}

// TestRecoverCodesFile keeps testdata/recover-codes.json (read by the
// server) equal to the Go lists (C-M4-6).
func TestRecoverCodesFile(t *testing.T) {
	f := readRecoverCodes(t)
	for name, pair := range map[string][2][]string{
		"problems": {f.Problems, RecoverProblemCodes}, "warnings": {f.Warnings, RecoverWarningCodes},
		"checks": {f.Checks, CheckIDs}, "hints": {f.Hints, HintCodes},
	} {
		if !reflect.DeepEqual(pair[0], pair[1]) {
			t.Errorf("%s: file %v, Go %v", name, pair[0], pair[1])
		}
	}
	if !reflect.DeepEqual(f.HintParams, HintParams) {
		t.Errorf("hintParams: file %v, Go %v", f.HintParams, HintParams)
	}
	for _, list := range [][]string{f.Problems, f.Warnings} {
		if !sort.StringsAreSorted(list) {
			t.Errorf("not sorted: %v", list)
		}
	}
	// Codes of the planner and of recover never overlap, so the server can
	// translate each code to one text.
	plan := map[string]bool{}
	for _, c := range append(append([]string{}, baremetal.PlanProblemCodes...), baremetal.PlanWarningCodes...) {
		plan[c] = true
	}
	for _, c := range append(append([]string{}, f.Problems...), f.Warnings...) {
		if plan[c] {
			t.Errorf("%s is a planner code and a recover code", c)
		}
	}
}

// knownCode reports a planner or recover code (finish warnings and
// findings may carry no other).
func knownCode(c string) bool {
	for _, list := range [][]string{baremetal.PlanProblemCodes, baremetal.PlanWarningCodes, RecoverProblemCodes, RecoverWarningCodes} {
		for _, k := range list {
			if k == c {
				return true
			}
		}
	}
	return false
}

func assertKnownCodes(t *testing.T, warnings []api.RecoveryWarning) {
	t.Helper()
	for _, w := range warnings {
		if !knownCode(w.Code) {
			t.Errorf("warning code %q is in neither plan-codes.json nor recover-codes.json", w.Code)
		}
	}
}

func TestVerificationExamples(t *testing.T) {
	f := readRecoverCodes(t)
	codes := map[string]bool{}
	for _, c := range append(append(append(append([]string{}, f.Problems...), f.Warnings...), baremetal.PlanProblemCodes...), baremetal.PlanWarningCodes...) {
		codes[c] = true
	}
	hints := map[string][]string{}
	for k, v := range f.HintParams {
		hints[k] = v
	}
	for _, name := range []string{"ok", "warning", "failed"} {
		b, err := os.ReadFile("testdata/verification/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		if len(b) > 64<<10 {
			t.Errorf("%s: larger than 64 KiB", name)
		}
		var v struct {
			Format, Result string
			Checks         []struct {
				ID, Result string
				Findings   []struct {
					Code, Ref, Message string
					Params             map[string]string
				}
				Evidence map[string]any
			}
			Hints []struct {
				Code   string
				Params map[string]string
			}
		}
		dec := json.NewDecoder(strings.NewReader(string(b)))
		if err := dec.Decode(&v); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if v.Format != "restow-verify-v1" || v.Result != name {
			t.Errorf("%s: format %s result %s", name, v.Format, v.Result)
		}
		if len(v.Checks) != len(CheckIDs) {
			t.Errorf("%s: %d checks", name, len(v.Checks))
		}
		for i, c := range v.Checks {
			if c.ID != CheckIDs[i] {
				t.Errorf("%s: check %d is %s", name, i, c.ID)
			}
			for _, fd := range c.Findings {
				if !codes[fd.Code] {
					t.Errorf("%s: unknown finding code %s", name, fd.Code)
				}
			}
			for k, ev := range c.Evidence {
				switch e := ev.(type) {
				case string:
					if len([]rune(e)) > 300 {
						t.Errorf("%s: evidence %s too long", name, k)
					}
				case float64, bool:
				default:
					t.Errorf("%s: evidence %s has type %T", name, k, ev)
				}
			}
		}
		for _, h := range v.Hints {
			want, ok := hints[h.Code]
			if !ok {
				t.Errorf("%s: unknown hint %s", name, h.Code)
			}
			var got []string
			for k := range h.Params {
				got = append(got, k)
			}
			sort.Strings(got)
			w := append([]string{}, want...)
			sort.Strings(w)
			if len(got) != len(w) || (len(w) > 0 && !reflect.DeepEqual(got, w)) {
				t.Errorf("%s: hint %s params %v, want %v", name, h.Code, got, w)
			}
		}
	}
}
