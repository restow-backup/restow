package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const planTestdata = "../../internal/baremetal/testdata"

func planRun(t *testing.T, stdin []byte, args ...string) (string, string, int) {
	t.Helper()
	var so, se bytes.Buffer
	code := cmdBaremetalPlan(args, bytes.NewReader(stdin), &so, &se)
	return so.String(), se.String(), code
}

func readTestdata(t *testing.T, rel string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(planTestdata, rel))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func planOutput(t *testing.T, out string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if v["format"] != "restow-plan-v1" {
		t.Fatalf("format %v", v["format"])
	}
	return v
}

func TestBaremetalPlanStdinStream(t *testing.T) {
	manifest := bytes.TrimSpace(readTestdata(t, "manifests/debian12-uefi-luks-lvm.json"))
	facts := readTestdata(t, "facts/debian12-uefi-luks-lvm.json")
	stream := append(append(append([]byte{}, manifest...), '\n'), facts...)
	for _, target := range []string{"same", "minimal", "other-controller"} {
		out, se, code := planRun(t, stream, "--manifest", "-", "--facts", "-", "--target", target, "--json")
		if code != exitOK {
			t.Fatalf("%s: exit %d: %s", target, code, se)
		}
		v := planOutput(t, out)
		if v["ok"] != true || v["target"] != target {
			t.Errorf("%s: ok %v target %v", target, v["ok"], v["target"])
		}
		// The output equals the golden file of the shared test data.
		var golden, got any
		_ = json.Unmarshal(readTestdata(t, "plans/debian12-uefi-luks-lvm."+target+".json"), &golden)
		_ = json.Unmarshal([]byte(out), &got)
		a, _ := json.Marshal(golden)
		b, _ := json.Marshal(got)
		if !bytes.Equal(a, b) {
			t.Errorf("%s: output differs from the golden plan", target)
		}
	}
	// A third value is refused.
	_, _, code := planRun(t, append(append([]byte{}, stream...), []byte(" {}")...), "--manifest", "-", "--facts", "-", "--target", "same", "--json")
	if code != exitError {
		t.Errorf("third value: exit %d", code)
	}
}

func TestBaremetalPlanFilesAndOneStdin(t *testing.T) {
	manifest := readTestdata(t, "manifests/raid5-spare.json")
	factsFile := filepath.Join(planTestdata, "facts/raid5-spare.json")
	out, se, code := planRun(t, manifest, "--manifest", "-", "--facts", factsFile, "--target", filepath.Join(planTestdata, "targets/raid5-spare.adopt-data.json"), "--snapshot", "0123456789abcdef", "--json")
	if code != exitOK {
		t.Fatalf("exit %d: %s", code, se)
	}
	if !strings.Contains(out, `"0123456789abcdef"`) || strings.Contains(out, "{snapshot}") {
		t.Errorf("snapshot not filled in")
	}
	// The summary for people.
	out, _, code = planRun(t, nil, "--manifest", filepath.Join(planTestdata, "manifests/debian12-uefi-luks-lvm.json"), "--target", "minimal")
	if code != exitOK || !strings.Contains(out, "Plan for target minimal: executable") || !strings.Contains(out, "Minimum size of d0") {
		t.Errorf("summary (%d):\n%s", code, out)
	}
	// Problems are data: exit 0, ok false.
	out, _, code = planRun(t, nil, "--manifest", filepath.Join(planTestdata, "manifests/ubuntu-zfs.json"), "--target", "same", "--json")
	if v := planOutput(t, out); code != exitOK || v["ok"] != false {
		t.Errorf("unsupported layout: exit %d ok %v", code, v["ok"])
	}
}

func TestBaremetalPlanRefusals(t *testing.T) {
	dir := t.TempDir()
	big := filepath.Join(dir, "big.json")
	if err := os.WriteFile(big, bytes.Repeat([]byte(" "), 512*1024+1), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"format":"restow-layout-v1"}`), 0o600)
	cases := []struct {
		name  string
		stdin []byte
		args  []string
		code  string
	}{
		{"too large", nil, []string{"--manifest", big, "--target", "same", "--json"}, "input_too_large"},
		{"invalid", nil, []string{"--manifest", bad, "--target", "same", "--json"}, "manifest_invalid"},
		{"darwin", nil, []string{"--manifest", filepath.Join(planTestdata, "manifests/darwin-minimal.json"), "--target", "same", "--json"}, "platform_unsupported"},
		{"target", nil, []string{"--manifest", filepath.Join(planTestdata, "manifests/ubuntu2404-default.json"), "--target", bad, "--json"}, "target_invalid"},
		{"choices", nil, []string{"--manifest", filepath.Join(planTestdata, "manifests/ubuntu2404-default.json"), "--target", "same", "--choices", bad + ".missing", "--json"}, "choices_invalid"},
		{"facts", []byte(`{"format":"x"}`), []string{"--manifest", filepath.Join(planTestdata, "manifests/ubuntu2404-default.json"), "--facts", "-", "--target", "same", "--json"}, "facts_invalid"},
		{"stdin too large", bytes.Repeat([]byte(" "), 512*1024+1), []string{"--manifest", "-", "--target", "same", "--json"}, "input_too_large"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, se, code := planRun(t, c.stdin, c.args...)
			if code != exitError {
				t.Fatalf("exit %d: %s", code, se)
			}
			v := planOutput(t, out)
			e, _ := v["error"].(map[string]any)
			if v["ok"] != false || e == nil || e["code"] != c.code {
				t.Errorf("error %v, want %s", v["error"], c.code)
			}
		})
	}
	for _, args := range [][]string{
		{"--manifest", "x"},
		{"--target", "same"},
		{"--manifest", "x", "--target", "same", "--snapshot", "latest"},
		{"--manifest", "x", "--target", "-"},
		{"--manifest", "x", "--target", "same", "extra"},
	} {
		if _, _, code := planRun(t, nil, args...); code != exitUsage {
			t.Errorf("%v: exit %d, want %d", args, code, exitUsage)
		}
	}
	var so, se bytes.Buffer
	if code := run([]string{"baremetal", "frobnicate"}, &so, &se); code != exitUsage || !strings.Contains(se.String(), "baremetal capture|plan") {
		t.Errorf("usage: %d %s", code, se.String())
	}
}

// TestBaremetalPlanBinaryUnderLimits builds the agent and runs the planner
// as the server does: under prlimit with the data segment, CPU time and
// file descriptors limited, stdin as the only input. Twice, for the same
// bytes.
func TestBaremetalPlanBinaryUnderLimits(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux only")
	}
	prlimit, err := exec.LookPath("prlimit")
	if err != nil {
		t.Skip("prlimit is not installed")
	}
	if testing.Short() {
		t.Skip("builds the binary")
	}
	bin := filepath.Join(t.TempDir(), "restow-agent")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	manifest := bytes.TrimSpace(readTestdata(t, "manifests/debian12-uefi-luks-lvm.json"))
	facts := readTestdata(t, "facts/debian12-uefi-luks-lvm.json")
	stream := append(append(append([]byte{}, manifest...), '\n'), facts...)
	var outs [][]byte
	for i := 0; i < 2; i++ {
		cmd := exec.Command(prlimit, "--data=536870912", "--cpu=30", "--nofile=16", "--", bin, "baremetal", "plan", "--manifest", "-", "--facts", "-", "--target", "same", "--json")
		cmd.Stdin = bytes.NewReader(stream)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
		cmd.Dir = t.TempDir()
		var so, se bytes.Buffer
		cmd.Stdout, cmd.Stderr = &so, &se
		if err := cmd.Run(); err != nil {
			t.Fatalf("planner under limits: %v\n%s", err, se.String())
		}
		v := planOutput(t, so.String())
		if v["ok"] != true {
			t.Fatalf("plan not ok: %s", so.String())
		}
		outs = append(outs, so.Bytes())
	}
	if !bytes.Equal(outs[0], outs[1]) {
		t.Error("two runs printed different bytes")
	}
}
