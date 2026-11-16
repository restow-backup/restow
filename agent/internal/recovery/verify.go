package recovery

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The verification report (restow-verify-v1, C-M4-6): ten checks with
// result, findings and evidence. verify_linux.go collects the facts; this
// file judges and bounds the report.

// Check is a check being built. texts holds, per finding, the text of the
// catalogue it was made from: the report carries the English text (the
// server and the web show it as it is), the console shows the operator's
// language (Text).
type Check struct {
	api.RecoveryCheck
	texts []findingText
}

// findingText is find.<id> of the catalogue with its parameters; an empty
// id is a finding with a free message.
type findingText struct {
	id string
	kv []any
}

// NewCheck starts a check that is ok until a finding says otherwise.
func NewCheck(id string) *Check {
	return &Check{RecoveryCheck: api.RecoveryCheck{ID: id, Result: api.VerifyOK, Findings: []api.RecoveryFinding{}, Evidence: map[string]any{}}}
}

// Warn adds a finding that makes the check at least a warning.
func (c *Check) Warn(code, ref, message string, params map[string]string) *Check {
	if c.Result == api.VerifyOK {
		c.Result = api.VerifyWarning
	}
	return c.add(code, ref, message, params, findingText{})
}

// Fail adds a finding that fails the check.
func (c *Check) Fail(code, ref, message string, params map[string]string) *Check {
	c.Result = api.VerifyFailed
	return c.add(code, ref, message, params, findingText{})
}

// WarnT is Warn with the text find.<id> of the catalogue (kv are its
// parameters as name, value pairs).
func (c *Check) WarnT(code, ref string, params map[string]string, id string, kv ...any) *Check {
	if c.Result == api.VerifyOK {
		c.Result = api.VerifyWarning
	}
	return c.add(code, ref, T(LangEN, "find."+id, kv...), params, findingText{id: id, kv: kv})
}

// FailT is Fail with the text find.<id> of the catalogue.
func (c *Check) FailT(code, ref string, params map[string]string, id string, kv ...any) *Check {
	c.Result = api.VerifyFailed
	return c.add(code, ref, T(LangEN, "find."+id, kv...), params, findingText{id: id, kv: kv})
}

func (c *Check) add(code, ref, message string, params map[string]string, text findingText) *Check {
	if params == nil {
		params = map[string]string{}
	}
	if len(c.Findings) < api.RecoveryMaxFindingsPerCheck {
		c.Findings = append(c.Findings, api.RecoveryFinding{Code: code, Ref: ref, Message: message, Params: params})
		c.texts = append(c.texts, text)
	}
	return c
}

// Text is finding i in lang: the catalogue text it was made from, or its
// message when it has none.
func (c *Check) Text(i int, lang string) string {
	if c == nil || i < 0 || i >= len(c.Findings) {
		return ""
	}
	if i < len(c.texts) && c.texts[i].id != "" {
		return T(lang, "find."+c.texts[i].id, c.texts[i].kv...)
	}
	return SanitizeForConsole(c.Findings[i].Message)
}

// Set records evidence: a string (cut to 300 characters), an integer or a
// boolean; other values are stored as their text.
func (c *Check) Set(key string, v any) *Check {
	switch t := v.(type) {
	case string:
		c.Evidence[key] = evidenceText(t)
	case int:
		c.Evidence[key] = int64(t)
	case int64, bool:
		c.Evidence[key] = t
	default:
		c.Evidence[key] = evidenceText(fmt.Sprint(v))
	}
	return c
}

func evidenceText(s string) string {
	s = isoText(s)
	if utf8.RuneCountInString(s) > api.RecoveryMaxEvidenceString {
		s = string([]rune(s)[:api.RecoveryMaxEvidenceString])
	}
	return s
}

// Judge is the result of the report: failed when a check failed, warning
// when one warned, ok otherwise.
func Judge(checks []api.RecoveryCheck) string {
	res := api.VerifyOK
	for _, c := range checks {
		switch c.Result {
		case api.VerifyFailed:
			return api.VerifyFailed
		case api.VerifyWarning:
			res = api.VerifyWarning
		}
	}
	return res
}

// BuildVerification assembles the report in the order of CheckIDs (a
// missing check is reported as a warning "not run"), judges it and keeps
// it within 64 KiB by dropping findings from the end.
func BuildVerification(snapshotID, planSHA string, started, finished time.Time, restoreErrors int64, checks []*Check,
	hints []api.RecoveryHint, fixups []api.RecoveryFixupChange, notAdapted []string) api.RecoveryVerification {
	byID := map[string]*Check{}
	for _, c := range checks {
		byID[c.ID] = c
	}
	v := api.RecoveryVerification{Format: api.RecoveryVerificationFormat, SnapshotID: snapshotID, PlanSHA256: planSHA,
		StartedAt: started.UTC().Truncate(time.Second), FinishedAt: finished.UTC().Truncate(time.Second), RestoreErrors: restoreErrors,
		Checks: []api.RecoveryCheck{}, Hints: []api.RecoveryHint{}, Fixups: []api.RecoveryFixupChange{}, NotAdaptedKernels: []string{}}
	for _, id := range CheckIDs {
		c := byID[id]
		if c == nil {
			c = NewCheck(id).WarnT(ProblemVerifyFailed, id, nil, "not_run")
		}
		for i := range c.Findings {
			f := &c.Findings[i]
			f.Message = evidenceText(f.Message)
			f.Ref = evidenceText(f.Ref)
			for k, val := range f.Params {
				f.Params[k] = evidenceText(val)
			}
		}
		v.Checks = append(v.Checks, c.RecoveryCheck)
	}
	seen := map[string]bool{}
	for _, h := range hints {
		b, _ := json.Marshal(h)
		if seen[string(b)] {
			continue
		}
		seen[string(b)] = true
		if h.Params == nil {
			h.Params = map[string]string{}
		}
		for k, val := range h.Params {
			h.Params[k] = evidenceText(val)
		}
		v.Hints = append(v.Hints, h)
	}
	for _, f := range fixups {
		v.Fixups = append(v.Fixups, api.RecoveryFixupChange{Path: evidenceText(f.Path), Rule: evidenceText(f.Rule), Backup: evidenceText(f.Backup)})
	}
	for _, k := range notAdapted {
		v.NotAdaptedKernels = append(v.NotAdaptedKernels, evidenceText(k))
	}
	sort.Strings(v.NotAdaptedKernels)
	v.Result = Judge(v.Checks)
	for {
		b, _ := json.Marshal(v)
		if len(b) <= api.RecoveryMaxVerification {
			break
		}
		cut := false
		for i := len(v.Checks) - 1; i >= 0 && !cut; i-- {
			if n := len(v.Checks[i].Findings); n > 1 {
				v.Checks[i].Findings = v.Checks[i].Findings[:n-1]
				cut = true
			}
		}
		if !cut && len(v.Fixups) > 0 {
			v.Fixups = v.Fixups[:len(v.Fixups)-1]
			cut = true
		}
		if !cut {
			break
		}
	}
	return v
}

// VerificationJSON encodes the report for finish.
func VerificationJSON(v api.RecoveryVerification) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("{}")
	}
	return b
}

// FailedChecks names the checks that failed (for verify_failed).
func FailedChecks(v api.RecoveryVerification) string {
	var ids []string
	for _, c := range v.Checks {
		if c.Result == api.VerifyFailed {
			ids = append(ids, c.ID)
		}
	}
	return strings.Join(ids, ", ")
}
