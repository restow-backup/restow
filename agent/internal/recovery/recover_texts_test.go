package recovery

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// Tests of what the operator reads and is asked at the console: the
// prompts before the erase, the texts of the checks and steps in the
// operator's language, and the rules for every text (formal address, no
// product names of other vendors, no dashes).

// planCase plans a manifest of the planner's fixtures against one of its
// targets.
func planCase(t *testing.T, manifest, target string, c baremetal.Choices) (*baremetal.Manifest, *baremetal.Target, *baremetal.Facts, *baremetal.RestorePlan) {
	t.Helper()
	m := loadManifestFile(t, manifest)
	read := func(dir, name string) []byte {
		b, err := os.ReadFile(filepath.Join("../baremetal/testdata", dir, name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	f, err := baremetal.ParseFacts(read("facts", manifest))
	if err != nil {
		t.Fatal(err)
	}
	tg, err := baremetal.ParseTarget(read("targets", target))
	if err != nil {
		t.Fatal(err)
	}
	p, _ := baremetal.Plan(m, tg, f, c)
	return m, tg, f, p
}

func consoleRecover(lang, input string) (*Recover, *strings.Builder) {
	var out strings.Builder
	ui := &UI{In: strings.NewReader(input), Out: &out, Lang: lang}
	return &Recover{UI: ui, lang: lang, Log: &LogBuffer{}}, &out
}

// Finding 21: the shrink question shows what would shrink, names the
// volume group and the real target disk, and Enter means no.
func TestShrinkPromptShowsTheProposalAndDefaultsToNo(t *testing.T) {
	for _, lang := range []string{LangEN, LangDE} {
		m, tg, f, p := planCase(t, "debian12-uefi-luks-lvm", "debian12-uefi-luks-lvm.smaller-128gb", baremetal.Choices{})
		if p.OK {
			t.Fatal("the plan needs no shrink confirmation")
		}
		// Enter alone: nothing shrinks.
		r, out := consoleRecover(lang, "\n")
		np, c := r.refinePlan(context.Background(), m, tg, f, baremetal.Choices{}, p, baremetal.PlanOptions{})
		if c.Shrink == "auto" || np.OK {
			t.Errorf("%s: Enter at the shrink question shrinks the volumes (choices %+v)", lang, c)
		}
		got := out.String()
		for _, want := range []string{
			T(lang, "shrink.title"),
			T(lang, "shrink.vg", "vg", "srv01-vg", "target", "/dev/nvme0n1 (Samsung SSD 980 PRO 1TB, "+FormatBytes(tg.Disks[0].SizeBytes)+")"),
			T(lang, "shrink.lv", "lv", "srv01-vg/root", "from", FormatBytes(53687091200), "to", FormatBytes(16114515968)),
			T(lang, "shrink.ask") + " [" + map[string]string{LangEN: "y/n", LangDE: "j/n"}[lang] + "] [" + T(lang, "ui.no") + "]",
		} {
			if !strings.Contains(got, want) {
				t.Errorf("%s: the shrink dialog lacks %q:\n%s", lang, want, got)
			}
		}
		if strings.Contains(got, "vg srv01-vg") || strings.Contains(got, "{") {
			t.Errorf("%s: garbled shrink dialog:\n%s", lang, got)
		}
		// Yes: the plan shrinks as shown and can run.
		r, _ = consoleRecover(lang, T(lang, "ui.yes")+"\n")
		np, c = r.refinePlan(context.Background(), m, tg, f, baremetal.Choices{}, p, baremetal.PlanOptions{})
		if c.Shrink != "auto" || !np.OK {
			t.Errorf("%s: yes at the shrink question: choices %+v, problems %+v", lang, c, np.Problems)
		}
		// Declined, the plan screen says why it cannot run, as a sentence.
		text := TParams(lang, "code."+p.Problems[0].Code, p.Problems[0].Params)
		if strings.Contains(text, "{") || strings.Contains(text, "vg srv01-vg") || !strings.Contains(text, "d0") || !strings.Contains(text, "t0") {
			t.Errorf("%s: %s", lang, text)
		}
	}
	// A partition proposal (a disk without LVM).
	r, out := consoleRecover(LangEN, "")
	r.showShrink(baremetal.Finding{Code: baremetal.ProblemShrinkNeedsConfirmation, Params: map[string]any{"disk": "d1", "target": "t9",
		"proposal": []any{map[string]any{"partition": int64(3), "fromBytes": int64(200 << 30), "toBytes": int64(120 << 30)}}}},
		&baremetal.Target{Disks: []baremetal.TargetDisk{{ID: "t9", Path: "/dev/sdb", Model: strPtrT("M"), SizeBytes: 128 << 30}}})
	for _, want := range []string{"Disk d1 of the backup on /dev/sdb (M, 128.0 GiB):", "partition 3: 200.0 GiB becomes 120.0 GiB"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the partition proposal lacks %q:\n%s", want, out.String())
		}
	}
}

// Finding 22: the Secure Boot question is a question, says that recover
// switches nothing off and what the operator must do, shows no internal
// code, and Enter means no.
func TestSecureBootQuestionClaimsNothing(t *testing.T) {
	for _, lang := range []string{LangEN, LangDE} {
		m, tg, f, p := planCase(t, "debian12-uefi-luks-lvm", "debian12-uefi-luks-lvm.sb-no-third-party-ca", baremetal.Choices{})
		r, out := consoleRecover(lang, "\n")
		_, c := r.refinePlan(context.Background(), m, tg, f, baremetal.Choices{}, p, baremetal.PlanOptions{})
		if c.SecureBootOff {
			t.Errorf("%s: Enter at the Secure Boot question accepts", lang)
		}
		got := out.String()
		if strings.Count(got, T(lang, "secureboot.ask")) != 1 {
			t.Errorf("%s: the question is not asked exactly once for the two findings:\n%s", lang, got)
		}
		for _, never := range []string{"secure_boot_ca_missing", "secure_boot_disabled_by_choice", "{"} {
			if strings.Contains(got, never) {
				t.Errorf("%s: the dialog shows %q:\n%s", lang, never, got)
			}
		}
		// Both findings are listed before the question.
		if strings.Count(got, "shimx64.efi") != 1 || strings.Count(got, "BOOTX64.EFI") != 1 || strings.Index(got, "shimx64.efi") > strings.Index(got, T(lang, "secureboot.ask")) {
			t.Errorf("%s: the findings do not stand before the question:\n%s", lang, got)
		}
		r, _ = consoleRecover(lang, T(lang, "ui.yes")+"\n")
		np, c := r.refinePlan(context.Background(), m, tg, f, baremetal.Choices{}, p, baremetal.PlanOptions{})
		if !c.SecureBootOff || !np.OK {
			t.Fatalf("%s: yes: choices %+v, problems %+v", lang, c, np.Problems)
		}
		// What follows the yes: a warning in the plan and a hint after the
		// restore. Neither says that Secure Boot is off.
		var warning string
		for _, w := range np.Warnings {
			if w.Code == baremetal.WarnSecureBootDisabledByChoice {
				warning = TParams(lang, "code."+w.Code, w.Params)
			}
		}
		hint := T(lang, "hint."+HintSecureBootDisabled)
		for name, text := range map[string]string{"question": T(lang, "secureboot.ask"), "warning": warning, "hint": hint} {
			if !strings.Contains(text, "Firmware-Setup") && !strings.Contains(text, "firmware setup") {
				t.Errorf("%s: the %s does not say where Secure Boot is switched off: %q", lang, name, text)
			}
			if strings.Contains(text, "secure_boot_") || strings.Contains(text, "{") {
				t.Errorf("%s: the %s shows a code: %q", lang, name, text)
			}
			for _, claim := range []string{"wurde für dieses System ausgeschaltet", "wird auf diesem Rechner ausgeschaltet", "was turned off", "is to be turned off"} {
				if strings.Contains(text, claim) {
					t.Errorf("%s: the %s claims %q: %q", lang, name, claim, text)
				}
			}
		}
	}
}

// Finding 23: the snapshot that overwrites the disks is shown with its
// point in time and check state, in the console's language, and a check
// that did not pass is called out.
func TestSnapshotIsShownWithTimeAndCheck(t *testing.T) {
	id := strings.Repeat("ab", 32)
	when := time.Date(2026, 11, 4, 22, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		lang, check, state string
		warn               bool
	}{
		{LangEN, "passed", "passed", false},
		{LangDE, "passed", "bestanden", false},
		{LangDE, "failed", "gescheitert", true},
		{LangDE, "incomplete", "unvollständig", true},
		{LangDE, "none", "nicht geprüft", true},
		{LangEN, "none", "not checked", true},
		{LangEN, "something-new", "unknown", true},
	} {
		r, out := consoleRecover(tc.lang, "")
		r.noteSnapshot(&api.RecoveryCredentials{SnapshotID: id, Snapshots: []api.RecoverySnapshot{
			{ID: strings.Repeat("cd", 32), Time: when.Add(-24 * time.Hour), Check: "passed"}, {ID: id, Time: when, Check: tc.check}}}, id)
		for _, text := range []string{"snapshot.chosen", "confirm.snapshot"} {
			out.Reset()
			r.showSnapshot(text)
			got := out.String()
			want := T(tc.lang, text, "id", shortID(id), "time", "2026-11-04 22:00", "check", tc.state)
			if !strings.Contains(got, want) || strings.Contains(got, "{") {
				t.Errorf("%s %s %s: want %q in:\n%s", tc.lang, tc.check, text, want, got)
			}
			if warned := strings.Contains(got, T(tc.lang, "snapshot.not_passed", "check", tc.state)); warned != tc.warn {
				t.Errorf("%s %s %s: warning shown %v, want %v:\n%s", tc.lang, tc.check, text, warned, tc.warn, got)
			}
		}
	}
	// A snapshot the list of the instance does not hold: said as unknown,
	// not as passed.
	r, out := consoleRecover(LangEN, "")
	r.noteSnapshot(&api.RecoveryCredentials{SnapshotID: id}, id)
	r.showSnapshot("snapshot.chosen")
	if !strings.Contains(out.String(), "unknown time") || !strings.Contains(out.String(), T(LangEN, "snapshot.not_passed", "check", "unknown")) {
		t.Errorf("a snapshot without facts:\n%s", out.String())
	}
}

// Finding 24: every disk to erase is confirmed by itself, also one without
// a signature, and all of them stand above the erase word.
func TestConfirmListsAndAsksEveryDisk(t *testing.T) {
	_, tg, _, p := planCase(t, "debian12-uefi-luks-lvm", "debian12-uefi-luks-lvm.smaller-128gb", baremetal.Choices{Shrink: "auto"})
	if !p.OK || len(tg.Disks[0].Signatures) != 0 {
		t.Fatalf("plan ok %v, signatures %v", p.OK, tg.Disks[0].Signatures)
	}
	id := strings.Repeat("ab", 32)
	confirm := func(lang, input string) (bool, string) {
		r, out := consoleRecover(lang, input)
		r.noteSnapshot(&api.RecoveryCredentials{Snapshots: []api.RecoverySnapshot{{ID: id, Time: time.Date(2026, 11, 4, 22, 0, 0, 0, time.UTC), Check: "failed"}}}, id)
		ok, _ := r.confirm(context.Background(), p, tg, nil)
		return ok, out.String()
	}
	// The erase word alone does not confirm a disk without a signature:
	// the disk itself is asked first.
	if ok, got := confirm(LangEN, "ERASE\nERASE\nERASE\nERASE\n"); ok {
		t.Errorf("the erase word alone confirmed a disk that carries no signature:\n%s", got)
	}
	ok, got := confirm(LangEN, "EW0-1\nERASE\n")
	if ok {
		t.Errorf("five characters were taken as the last four:\n%s", got)
	}
	ok, got = confirm(LangEN, "W0-1\nERASE\n")
	if !ok {
		t.Fatalf("not confirmed:\n%s", got)
	}
	size := FormatBytes(tg.Disks[0].SizeBytes)
	tail := T(LangEN, "ui.confirm_tail", "path", "/dev/nvme0n1", "model", "Samsung SSD 980 PRO 1TB", "size", size, "identity", "serial.NEW0-1")
	line := T(LangEN, "confirm.disk", "path", "/dev/nvme0n1", "model", "Samsung SSD 980 PRO 1TB", "size", size, "identity", "serial.NEW0-1")
	word := T(LangEN, "ui.confirm_erase", "word", "ERASE")
	snap := T(LangEN, "confirm.snapshot", "id", shortID(id), "time", "2026-11-04 22:00", "check", "failed")
	at := func(s string) int { return strings.Index(got, s) }
	for name, s := range map[string]string{"prompt for the disk": tail, "disk line": line, "word prompt": word, "snapshot": snap,
		"title": T(LangEN, "confirm.title"), "check warning": T(LangEN, "snapshot.not_passed", "check", "failed")} {
		if at(s) < 0 {
			t.Errorf("the confirmation lacks the %s (%q):\n%s", name, s, got)
		}
	}
	if !(at(snap) < at(tail) && at(tail) < at(T(LangEN, "confirm.title")) && at(T(LangEN, "confirm.title")) < at(line) && at(line) < at(word)) {
		t.Errorf("order of the confirmation:\n%s", got)
	}
	if !strings.Contains(tail, "ERASED") || !strings.Contains(line, "erased") {
		t.Errorf("the texts do not say that the disk is erased: %q %q", tail, line)
	}
	// German: the same, and the prompt names ERASE for a keyboard without Ö.
	ok, got = confirm(LangDE, "w0-1\nERASE\n")
	if !ok || !strings.Contains(got, "wird GELÖSCHT") || !strings.Contains(got, "wird gelöscht") || !strings.Contains(got, "LÖSCHEN (oder ERASE)") ||
		!strings.Contains(got, "/dev/nvme0n1") || !strings.Contains(got, "Prüfung dieser Sicherung: gescheitert") {
		t.Errorf("German confirmation (confirmed %v):\n%s", ok, got)
	}
}

// Finding 25: the check report on the console is in the operator's
// language (results and findings); the report itself carries English.
func TestVerificationIsShownInTheOperatorsLanguage(t *testing.T) {
	restic := NewCheck(CheckResticVerify).FailT(ProblemSystemFilesIncomplete, "", nil, "sys_missing", "count", 3)
	fstab := NewCheck(CheckFstab).FailT(ProblemVerifyFailed, "UUID=0000", map[string]string{"line": "4"}, "tab_no_dev", "line", 4, "source", "UUID=0000")
	boot := NewCheck(CheckBootEntries).WarnT(ProblemVerifyFailed, `\EFI\BOOT`, nil, "only_fallback")
	free := NewCheck(CheckMountPoints).Warn(ProblemVerifyFailed, "/x", "free text \x1b[31m", nil)
	checks := []*Check{restic, fstab, boot, free}
	v := BuildVerification("s", strings.Repeat("0", 64), time.Now(), time.Now(), 3, checks, nil, nil, nil)
	if v.Checks[0].Findings[0].Message != "3 files that could not be restored are system files, or their path is not known." {
		t.Errorf("the report does not carry the English text: %q", v.Checks[0].Findings[0].Message)
	}
	r, out := consoleRecover(LangDE, "")
	r.showVerification(v, &ExecReport{Checks: checks})
	got := out.String()
	for _, want := range []string{
		"GESCHEITERT  " + T(LangDE, "check."+CheckResticVerify),
		"    3 nicht wiederhergestellte Dateien sind Systemdateien, oder ihr Pfad ist nicht bekannt.",
		"    Zeile 4: UUID=0000 gibt es nicht.",
		"WARNUNG  " + T(LangDE, "check."+CheckBootEntries),
		"    " + T(LangDE, "find.only_fallback"),
		// A check that did not run.
		"WARNUNG  " + T(LangDE, "check."+CheckInitramfs),
		"    " + T(LangDE, "find.not_run"),
		// A finding without a catalogue text: its message, never a
		// control character.
		"    free text",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the German check report lacks %q:\n%s", want, got)
		}
	}
	for _, never := range []string{"FAILED", "WARNING", "could not be restored", "does not exist", "check not run", "The check did not run", "\x1b"} {
		if strings.Contains(got, never) {
			t.Errorf("English in the German check report (%q):\n%s", never, got)
		}
	}
	r, out = consoleRecover(LangEN, "")
	r.showVerification(v, &ExecReport{Checks: checks})
	if !strings.Contains(out.String(), "FAILED  "+T(LangEN, "check."+CheckResticVerify)) || !strings.Contains(out.String(), "    Line 4: UUID=0000 does not exist.") {
		t.Errorf("the English check report:\n%s", out.String())
	}
}

// Every finding a check adds has a text in both languages, and every
// placeholder of that text is given.
func TestFindingTextsExist(t *testing.T) {
	fset := token.NewFileSet()
	n := 0
	for _, file := range []string{"verify_checks.go", "verify.go"} {
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "WarnT" && sel.Sel.Name != "FailT") {
				return true
			}
			pos := fset.Position(call.Pos())
			lit, ok := call.Args[3].(*ast.BasicLit)
			if !ok {
				t.Errorf("%s: the text id of a finding is not a literal", pos)
				return true
			}
			id, _ := strconv.Unquote(lit.Value)
			n++
			given := map[string]bool{}
			for i := 4; i+1 < len(call.Args); i += 2 {
				if k, ok := call.Args[i].(*ast.BasicLit); ok {
					name, _ := strconv.Unquote(k.Value)
					given[name] = true
				}
			}
			for _, lang := range []string{LangEN, LangDE} {
				if !HasText(lang, "find."+id) {
					t.Errorf("%s: find.%s has no %s text", pos, id, lang)
				}
			}
			for _, p := range placeholders(textEN["find."+id]) {
				if !given[p] {
					t.Errorf("%s: find.%s needs {%s}, which the call does not give", pos, id, p)
				}
			}
			return true
		})
	}
	if n < 30 {
		t.Errorf("only %d findings found in the checks", n)
	}
}

// Finding 25: every step of every plan has a text by its kind in both
// languages, so the step list is not English in the German console.
func TestStepTextsExist(t *testing.T) {
	kinds := map[string]baremetal.Step{}
	plans, err := filepath.Glob("../baremetal/testdata/plans/*.json")
	if err != nil || len(plans) < 50 {
		t.Fatalf("plans: %d %v", len(plans), err)
	}
	for _, p := range plans {
		for _, s := range readPlan(t, strings.TrimSuffix(filepath.Base(p), ".json")).Steps {
			kinds[s.Kind] = s
		}
	}
	// The kinds the planner can emit, from its source (the fixtures do not
	// reach every one).
	src, err := os.ReadFile("../baremetal/plan.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range regexp.MustCompile(`pl\.step\("[a-z]+", "([a-z_]+)"`).FindAllStringSubmatch(string(src), -1) {
		if _, ok := kinds[m[1]]; !ok {
			kinds[m[1]] = baremetal.Step{Kind: m[1], Target: strPtrT("x"), Reason: "reason of " + m[1]}
		}
	}
	for _, k := range []string{"initramfs", "initramfs_extra", "uki", "mok_import", "grub_env", "pmbr_boot", "part_label", "verify"} {
		if _, ok := kinds[k]; !ok {
			t.Errorf("the step kind %s was not found in the planner", k)
		}
	}
	for kind, s := range kinds {
		for _, lang := range []string{LangEN, LangDE} {
			if !HasText(lang, "step."+kind) {
				t.Errorf("step.%s has no %s text", kind, lang)
				continue
			}
			got := StepText(lang, &s)
			if strings.Contains(got, "{") || got == "" {
				t.Errorf("step.%s in %s: %q", kind, lang, got)
			}
			if s.Target != nil && strings.Contains(catalogs[lang]["step."+kind], "{target}") && !strings.Contains(got, SanitizeForConsole(*s.Target)) {
				t.Errorf("step.%s in %s does not name its target %s: %q", kind, lang, *s.Target, got)
			}
		}
		if s.Reason != "" && StepText(LangDE, &s) == s.Reason {
			t.Errorf("step.%s: the German console shows the plan's English reason", kind)
		}
	}
	// A kind this ISO does not know falls back to the plan's reason.
	if got := StepText(LangDE, &baremetal.Step{Kind: "from_the_future", Reason: "do \x1b something"}); got != `do \x1b something` {
		t.Errorf("unknown kind: %q", got)
	}
}

// The step list of a run is in the console's language.
func TestExecuteShowsStepsInTheOperatorsLanguage(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	var out strings.Builder
	h.x.UI = &UI{In: strings.NewReader(""), Out: &out, Lang: LangDE}
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{"Partitionstabelle von /dev/nvme0n1 mit ihren Kennungen anlegen", "LUKS-Volume auf /dev/nvme0n1p3 anlegen",
		"Dateien des Snapshots wiederherstellen", "initramfs von 6.1.0-27-amd64 neu bauen", "Wiederhergestelltes System prüfen"} {
		if !strings.Contains(got, want) {
			t.Errorf("the German step list lacks %q:\n%s", want, got)
		}
	}
	for _, never := range []string{"recreate the GPT", "restore the files", "rebuild the initramfs", "check the restored system"} {
		if strings.Contains(got, never) {
			t.Errorf("English step text %q in the German console:\n%s", never, got)
		}
	}
	// The log and the progress for the server keep the plan's reason.
	if !strings.Contains(strings.Join(h.sess.messages(), "\n"), "restore the files of the snapshot") {
		t.Errorf("the progress for the server lost the plan's reason: %v", h.sess.messages())
	}
}

// Finding 26 and the rules for every text: no product names of other
// vendors, no dashes, formal address in German without bare imperatives
// where the operator is told to act.
func TestTextRules(t *testing.T) {
	vendor := regexp.MustCompile(`(?i)\b(windows|microsoft|vmware|hyper-v|apple|macos)\b`)
	for lang, cat := range catalogs {
		for id, s := range cat {
			if vendor.MatchString(s) {
				t.Errorf("%s %s names a product of another vendor: %s", lang, id, s)
			}
			if strings.ContainsAny(s, "\u2014\u2013") {
				t.Errorf("%s %s has a dash: %s", lang, id, s)
			}
		}
	}
	// German tells the operator what to do with "Sie", not with a bare
	// infinitive or imperative.
	for id, want := range map[string]string{
		"answers.medium":       "schalten Sie den Rechner jetzt aus und entfernen Sie das Medium",
		"resume.no_marker":     "Starten Sie neu und beantworten Sie",
		"clock.set":            "Geben Sie UTC",
		"unattended.countdown": "Drücken Sie eine beliebige Taste",
		"pass.generated":       "notieren Sie sie",
		"net.no_nic_hint":      "Sehen Sie in der Firmwareliste",
		"ui.invalid":           "versuchen Sie es noch einmal",
	} {
		if !strings.Contains(textDE[id], want) {
			t.Errorf("%s: %q", id, textDE[id])
		}
	}
	bare := regexp.MustCompile(`(jetzt ausschalten|das Medium entfernen\.|bitte notieren|^Siehe |, bitte noch einmal|Abbruch mit einer)`)
	for id, s := range textDE {
		if bare.MatchString(s) {
			t.Errorf("%s: not addressed with Sie: %s", id, s)
		}
	}
	// The texts for what the server answers to a finish exist in both
	// languages (9.8), as do the result words.
	for _, id := range []string{"server.success_report_missing", "server.success_checks_failed", "server.success_checks_missing",
		"server.success_snapshot_unknown", "server.unknown", "finish.refused", "finish.ended", "creds.snapshot_gone",
		"result.ok", "result.warning", "result.failed", "state.failed", "state.cancelled", "state.succeeded"} {
		for _, lang := range []string{LangEN, LangDE} {
			if !HasText(lang, id) {
				t.Errorf("%s has no %s text", id, lang)
			}
		}
	}
}
