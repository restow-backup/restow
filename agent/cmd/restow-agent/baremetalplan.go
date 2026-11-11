package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// planStdin is the standard input of `baremetal plan` (tests replace it).
var planStdin io.Reader = os.Stdin

// planError is a refusal of `baremetal plan`: exit 1 and, with --json, the
// error object of restow-plan-v1.
type planError struct {
	code string
	err  error
}

func (e *planError) Error() string { return e.err.Error() }

func refuse(code string, err error) *planError { return &planError{code: code, err: err} }

var reSnapshotID = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

// plannerLimits limits the process before the planner reads its input
// (baremetal.SetPlannerLimits: data segment, CPU time, heap goal). The
// limits hold for the rest of the process and cannot be raised again, so
// only the command's own process may get them: the tests of this package
// run the command inside the test binary and replace this (a test binary
// limited to 512 MiB of data and 30 s of CPU dies later in tests that
// have nothing to do with the planner, first under the race detector).
var plannerLimits = baremetal.SetPlannerLimits

// cmdBaremetalPlan is `restow-agent baremetal plan` (contract C-M2-1): the
// pure restore planner. It reads only its arguments (and stdin), starts no
// process and, on Linux, limits itself (data segment 512 MiB, CPU 30 s).
// Exit 0: a plan was computed (problems are data); 1: the input was
// refused or the planner failed; 2: usage.
func cmdBaremetalPlan(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := newFlagSet("baremetal plan", stderr)
	manifestArg := fs.String("manifest", "", "the layout manifest (a file, or - for standard input)")
	factsArg := fs.String("facts", "", "facts from the snapshot, restow-plan-facts-v1 (a file, or - for standard input after the manifest)")
	targetArg := fs.String("target", "", "same, minimal, other-controller or a target file (restow-plan-target-v1)")
	choicesArg := fs.String("choices", "", "the operator's choices (a file)")
	snapshot := fs.String("snapshot", "", "the snapshot ID to put into the restore step")
	asJSON := fs.Bool("json", false, "print the plan as JSON (restow-plan-v1)")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if *manifestArg == "" || *targetArg == "" || fs.NArg() > 0 {
		fmt.Fprintln(stderr, baremetalUsage)
		return exitUsage
	}
	if *snapshot != "" && !reSnapshotID.MatchString(*snapshot) {
		fmt.Fprintln(stderr, "restow-agent baremetal plan: --snapshot must be a snapshot ID (hex)")
		return exitUsage
	}
	if *choicesArg == "-" || *targetArg == "-" {
		fmt.Fprintln(stderr, "restow-agent baremetal plan: only --manifest and --facts can read standard input")
		return exitUsage
	}
	if err := plannerLimits(); err != nil {
		fmt.Fprintf(stderr, "restow-agent baremetal plan: limits: %v\n", err)
	}
	plan, perr := runPlan(*manifestArg, *factsArg, *targetArg, *choicesArg, *snapshot, stdin)
	if perr != nil {
		if *asJSON {
			b, _ := json.Marshal(map[string]any{"format": baremetal.PlanFormat, "ok": false,
				"error": map[string]string{"code": perr.code, "message": printable(perr.Error(), 2000)}})
			fmt.Fprintln(stdout, string(b))
		}
		fmt.Fprintf(stderr, "restow-agent baremetal plan: %s: %s\n", perr.code, printable(perr.Error(), 2000))
		return exitError
	}
	if *asJSON {
		b, err := baremetal.EncodePlan(plan)
		if err != nil {
			fmt.Fprintf(stderr, "restow-agent baremetal plan: %v\n", err)
			return exitError
		}
		fmt.Fprintln(stdout, string(b))
		return exitOK
	}
	printPlanSummary(stdout, plan)
	return exitOK
}

// runPlan reads the inputs and plans; a panic of the planner is
// planner_internal.
func runPlan(manifestArg, factsArg, targetArg, choicesArg, snapshot string, stdin io.Reader) (plan *baremetal.RestorePlan, perr *planError) {
	rawManifest, rawFacts, perr := readPlanInputs(manifestArg, factsArg, stdin)
	if perr != nil {
		return nil, perr
	}
	m, err := baremetal.Decode(rawManifest)
	if errors.Is(err, baremetal.ErrTooLarge) {
		return nil, refuse("input_too_large", err)
	}
	if err != nil {
		return nil, refuse("manifest_invalid", err)
	}
	if m.Platform != baremetal.PlatformLinux {
		return nil, refuse("platform_unsupported", fmt.Errorf("the planner plans Linux layouts only in this version (platform %q)", m.Platform))
	}
	var facts *baremetal.Facts
	if rawFacts != nil {
		facts, err = baremetal.ParseFacts(rawFacts)
		if errors.Is(err, baremetal.ErrInputTooLarge) {
			return nil, refuse("input_too_large", err)
		}
		if err != nil {
			return nil, refuse("facts_invalid", err)
		}
	}
	var choices baremetal.Choices
	if choicesArg != "" {
		b, perr := readCapped(choicesArg, baremetal.MaxChoicesBytes, "choices_invalid")
		if perr != nil {
			return nil, perr
		}
		if choices, err = baremetal.ParseChoices(b); err != nil {
			if errors.Is(err, baremetal.ErrInputTooLarge) {
				return nil, refuse("input_too_large", err)
			}
			return nil, refuse("choices_invalid", err)
		}
	}
	defer func() {
		if r := recover(); r != nil {
			plan, perr = nil, refuse("planner_internal", fmt.Errorf("the planner failed: %v", r))
		}
	}()
	var target *baremetal.Target
	switch targetArg {
	case baremetal.TargetSame, baremetal.TargetMinimal, baremetal.TargetOtherController:
		t, synth, err := baremetal.SyntheticTarget(m, targetArg, facts)
		if err != nil {
			return nil, refuse("target_invalid", err)
		}
		target = t
		if choices.Shrink == "" {
			choices.Shrink = synth.Shrink
		}
	default:
		b, perr := readCapped(targetArg, baremetal.MaxTargetBytes, "target_invalid")
		if perr != nil {
			return nil, perr
		}
		t, err := baremetal.ParseTarget(b)
		if errors.Is(err, baremetal.ErrInputTooLarge) {
			return nil, refuse("input_too_large", err)
		}
		if err != nil {
			return nil, refuse("target_invalid", err)
		}
		target = t
	}
	plan, _ = baremetal.PlanWith(m, target, facts, choices, baremetal.PlanOptions{Snapshot: snapshot})
	return plan, nil
}

// readPlanInputs reads the manifest and the facts. With both as "-",
// standard input carries two JSON values back to back: the manifest, then
// the facts.
func readPlanInputs(manifestArg, factsArg string, stdin io.Reader) ([]byte, []byte, *planError) {
	if manifestArg == "-" && factsArg == "-" {
		lim := &countingReader{r: io.LimitReader(stdin, baremetal.MaxLayoutBytes+baremetal.MaxFactsBytes+4096+1)}
		dec := json.NewDecoder(lim)
		var raw1, raw2 json.RawMessage
		if err := dec.Decode(&raw1); err != nil {
			if lim.n > baremetal.MaxLayoutBytes+baremetal.MaxFactsBytes+4096 {
				return nil, nil, refuse("input_too_large", errors.New("standard input is too large"))
			}
			return nil, nil, refuse("manifest_invalid", fmt.Errorf("standard input: %v", err))
		}
		if len(raw1) > baremetal.MaxLayoutBytes {
			return nil, nil, refuse("input_too_large", errors.New("the manifest is larger than 512 KiB"))
		}
		if err := dec.Decode(&raw2); err != nil {
			if lim.n > baremetal.MaxLayoutBytes+baremetal.MaxFactsBytes+4096 {
				return nil, nil, refuse("input_too_large", errors.New("standard input is too large"))
			}
			return nil, nil, refuse("facts_invalid", fmt.Errorf("standard input (facts after the manifest): %v", err))
		}
		if len(raw2) > baremetal.MaxFactsBytes {
			return nil, nil, refuse("input_too_large", errors.New("the facts are larger than 32 MiB"))
		}
		var extra json.RawMessage
		if err := dec.Decode(&extra); err != io.EOF {
			return nil, nil, refuse("facts_invalid", errors.New("standard input carries more than the manifest and the facts"))
		}
		return []byte(raw1), []byte(raw2), nil
	}
	readArg := func(arg string, max int64, what string) ([]byte, *planError) {
		if arg == "-" {
			b, err := io.ReadAll(io.LimitReader(stdin, max+1))
			if err != nil {
				return nil, refuse(what, err)
			}
			if int64(len(b)) > max {
				return nil, refuse("input_too_large", fmt.Errorf("standard input is larger than %d bytes", max))
			}
			return b, nil
		}
		return readCapped(arg, max, what)
	}
	m, perr := readArg(manifestArg, baremetal.MaxLayoutBytes, "manifest_invalid")
	if perr != nil {
		return nil, nil, perr
	}
	var f []byte
	if factsArg != "" {
		if f, perr = readArg(factsArg, baremetal.MaxFactsBytes, "facts_invalid"); perr != nil {
			return nil, nil, perr
		}
	}
	return bytes.TrimSpace(m), f, nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// readCapped reads a file of at most max bytes.
func readCapped(name string, max int64, code string) ([]byte, *planError) {
	f, err := os.Open(name)
	if err != nil {
		return nil, refuse(code, err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, refuse(code, err)
	}
	if int64(len(b)) > max {
		return nil, refuse("input_too_large", fmt.Errorf("%s is larger than %d bytes", name, max))
	}
	return b, nil
}

// printable replaces control characters, so an error message can be
// printed and carried in JSON.
func printable(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == 0x2028 || r == 0x2029 || r == unicode.ReplacementChar {
			return '?'
		}
		return r
	}, strings.ToValidUTF8(s, "?"))
	if len(s) > max {
		s = s[:max]
		s = strings.ToValidUTF8(s, "")
	}
	return s
}

// printPlanSummary is the plan for people to read.
func printPlanSummary(w io.Writer, p *baremetal.RestorePlan) {
	verdict := "executable"
	if !p.OK {
		verdict = "not executable"
	}
	fmt.Fprintf(w, "Plan for target %s: %s (%d problems, %d warnings, %d steps).\n", printable(p.Target, 100), verdict, len(p.Problems), len(p.Warnings), len(p.Steps))
	for _, f := range p.Problems {
		fmt.Fprintf(w, "  problem %s: %s\n", f.Code, printable(f.Message, 1000))
	}
	for _, f := range p.Warnings {
		fmt.Fprintf(w, "  warning %s: %s\n", f.Code, printable(f.Message, 1000))
	}
	for _, a := range p.Mapping {
		target := "-"
		if a.Target != nil {
			target = *a.Target
		}
		fmt.Fprintf(w, "Disk %s -> %s (%s)\n", a.Source, printable(target, 100), a.Action)
	}
	for _, d := range p.MinimumSizes.Disks {
		fmt.Fprintf(w, "Minimum size of %s (%s): %d bytes (now %d)\n", d.Disk, printable(d.KName, 100), d.MinBytes, d.SizeBytes)
	}
}
