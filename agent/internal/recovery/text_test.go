package recovery

import (
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

func TestTextCatalogues(t *testing.T) {
	for id := range textEN {
		if _, ok := textDE[id]; !ok {
			t.Errorf("%s has no German text", id)
		}
	}
	for id, de := range textDE {
		en, ok := textEN[id]
		if !ok {
			t.Errorf("%s has no English text", id)
			continue
		}
		if !reflect.DeepEqual(placeholders(en), placeholders(de)) {
			t.Errorf("%s: placeholders %v (en) and %v (de) differ", id, placeholders(en), placeholders(de))
		}
	}
	var ids []string
	for _, c := range append(append(append(append([]string{}, baremetal.PlanProblemCodes...), baremetal.PlanWarningCodes...), RecoverProblemCodes...), RecoverWarningCodes...) {
		ids = append(ids, "code."+c)
	}
	for _, c := range CheckIDs {
		ids = append(ids, "check."+c)
	}
	for _, c := range HintCodes {
		ids = append(ids, "hint."+c)
	}
	for _, id := range ids {
		for _, lang := range []string{LangEN, LangDE} {
			if !HasText(lang, id) {
				t.Errorf("%s has no %s text", id, lang)
			}
		}
	}
	for code, params := range HintParams {
		got := map[string]bool{}
		for _, p := range placeholders(textEN["hint."+code]) {
			got[p] = true
		}
		for _, p := range params {
			if !got[p] {
				t.Errorf("hint.%s does not use {%s}", code, p)
			}
		}
	}
	// Formal address in German, no informal pronouns.
	informal := regexp.MustCompile(`(^|[^\pL])(du|dich|dir|dein|deine|deinen|deinem|deiner|euch|euer)([^\pL]|$)`)
	for id, s := range textDE {
		if informal.MatchString(s) {
			t.Errorf("%s: informal address: %s", id, s)
		}
	}
}

func TestTFillAndSanitize(t *testing.T) {
	got := T(LangDE, "approval.machine", "name", "web\x1b[31m01", "hostname", "h")
	if strings.Contains(got, "\x1b") || !strings.Contains(got, `\x1b`) {
		t.Errorf("parameter not sanitized: %q", got)
	}
	if T("xx", "ui.yes") != "yes" {
		t.Error("unknown language does not fall back to English")
	}
	if T(LangEN, "no.such.id") != "no.such.id" {
		t.Error("missing id")
	}
	if got := TParams(LangEN, "code.target_too_small", map[string]any{"target": "t0", "haveBytes": int64(5), "disk": "d0", "needBytes": 7}); got != "Target disk t0 has 5 bytes, d0 needs at least 7 bytes." {
		t.Errorf("TParams: %q", got)
	}
	if LangForKeymap("ch") != LangDE || LangForKeymap("fr") != LangEN {
		t.Error("language for keymap")
	}
}
