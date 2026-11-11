//go:build linux

package recovery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// What the instance answers at the end of a recovery (9.8, 9.9) and what
// recover makes of it: the stored state counts, a closed session is left
// alone, and a backup that is gone gets its own words.

func activeSession(t *testing.T) (*fakeRecovery, *Session) {
	t.Helper()
	f := newFakeRecovery(t, "", testCode)
	s := newTestSession(t, f)
	if _, err := s.Exchange(context.Background(), exchangeRequest(s)); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.status = api.RecoveryActive
	f.mu.Unlock()
	return f, s
}

func (f *fakeRecovery) calls() (seen int, refused []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.seen), append([]string(nil), f.refused...)
}

// The instance stores a reported success as failed: Finish says so with
// the instance's reason.
func TestSessionFinishAnswerIsTheStoredState(t *testing.T) {
	ctx := context.Background()
	for _, reason := range []string{"success_report_missing", "success_checks_failed", "success_checks_missing", "success_snapshot_unknown"} {
		f, s := activeSession(t)
		f.refuseSuccess = reason
		got, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded})
		if err != nil || got.Status != api.RecoveryFailed || got.Reported != api.RecoverySucceeded || got.Reason != reason {
			t.Errorf("%s: %+v %v", reason, got, err)
		}
		if s.EndState() != api.RecoveryFailed || !s.Closed() {
			t.Errorf("%s: end state %q closed %v", reason, s.EndState(), s.Closed())
		}
	}
	// A failed or cancelled report is taken as it is.
	f, s := activeSession(t)
	f.refuseSuccess = "success_checks_failed"
	if got, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoveryCancelled}); err != nil || got.Status != api.RecoveryCancelled || got.Reason != "" {
		t.Errorf("cancelled: %+v %v", got, err)
	}
}

// After the end the session takes nothing: recover sends nothing more
// (no request, so nothing the instance must refuse and audit), and what
// it gets back is ErrSessionClosed, not an error to show.
func TestSessionReportsNothingAfterTheEnd(t *testing.T) {
	ctx := context.Background()
	f, s := activeSession(t)
	if _, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded}); err != nil {
		t.Fatal(err)
	}
	before, _ := f.calls()
	if err := s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseRestoring}); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("progress after the end: %v", err)
	}
	if _, err := s.Log(ctx, []string{"a line"}); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("log after the end: %v", err)
	}
	if err := s.Event(ctx, api.RecoveryEventKeyfileRegenerated, map[string]string{"path": "/k"}); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("event after the end: %v", err)
	}
	if _, err := s.Release(ctx); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("release after the end: %v", err)
	}
	if got, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoveryFailed}); !errors.Is(err, ErrSessionClosed) || got.Status != api.RecoverySucceeded {
		t.Errorf("a second finish: %+v %v", got, err)
	}
	if after, refused := f.calls(); after != before || len(refused) != 0 {
		t.Errorf("%d requests after the end, refused %v", after-before, refused)
	}
	// The rebind is no report: it still goes out.
	if _, err := s.Rebind(ctx, api.RecoveryRebindRequest{Token: "rset_rebind_token_0123456789"}); err != nil {
		t.Errorf("rebind after a stored success: %v", err)
	}

	// The session was ended on the instance (cancelled in the web
	// interface): the first report learns it from the 409, every later one
	// is not sent, and the finish names the state without asking again.
	f, s = activeSession(t)
	f.mu.Lock()
	f.status = api.RecoveryCancelled
	f.mu.Unlock()
	err := s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseRestoring})
	if !errors.Is(err, ErrSessionClosed) || !IsProblem(err, ProblemStateConflict) || ProblemState(err) != api.RecoveryCancelled {
		t.Fatalf("progress to a cancelled session: %v (state %q)", err, ProblemState(err))
	}
	before, _ = f.calls()
	for i := 0; i < 5; i++ {
		_ = s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseRestoring})
		_, _ = s.Log(ctx, []string{"a line"})
	}
	got, err := s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded})
	if !errors.Is(err, ErrSessionClosed) || got.Status != api.RecoveryCancelled {
		t.Errorf("finish of a session the instance cancelled: %+v %v", got, err)
	}
	if after, refused := f.calls(); after != before || len(refused) != 1 {
		t.Errorf("%d requests after the 409, refused %v: want none and one", after-before, refused)
	}

	// A finish that finds the session closed: 409 with the state.
	f, s = activeSession(t)
	f.mu.Lock()
	f.status = api.RecoveryFailed
	f.mu.Unlock()
	got, err = s.Finish(ctx, api.RecoveryFinish{Status: api.RecoverySucceeded})
	if !errors.Is(err, ErrSessionClosed) || got.Status != api.RecoveryFailed {
		t.Errorf("finish to a closed session: %+v %v", got, err)
	}
	// A 409 that is not about the end (a release before the approval) is
	// an error like before, and the session goes on reporting.
	f, s = activeSession(t)
	f.mu.Lock()
	f.status = api.RecoveryPendingApproval
	f.mu.Unlock()
	if _, err := s.Release(ctx); !IsProblem(err, ProblemStateConflict) || errors.Is(err, ErrSessionClosed) || s.Closed() {
		t.Errorf("release in a state that is no end: %v (closed %v)", err, s.Closed())
	}
	if err := s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseWaitingApproval}); err != nil {
		t.Errorf("progress after a refused release: %v", err)
	}
}

// The extensions of a problem answer are taken only as plain codes.
func TestSessionProblemExtensions(t *testing.T) {
	f, s := activeSession(t)
	f.snapshotGone = true
	_, err := s.Credentials(context.Background())
	if !IsProblem(err, ProblemNotAvailable) || ProblemReason(err) != "snapshot_unknown" {
		t.Fatalf("credentials of a code whose backup is gone: %v (reason %q)", err, ProblemReason(err))
	}
	var ae *api.APIError
	if !errors.As(err, &ae) || ae.State != "" || ae.Status != 409 {
		t.Errorf("%+v", ae)
	}
	if ProblemReason(errors.New("x")) != "" || ProblemState(nil) != "" {
		t.Error("an error that is no problem answer has a reason or a state")
	}
	for _, bad := range []string{"Snapshot Unknown", "a\x1b[31m", strings.Repeat("a", 65), ""} {
		if reCode.MatchString(bad) {
			t.Errorf("%q passes as a code", bad)
		}
	}
}

// The instance does not take the reported success: the console and the
// result line say failed with the reason in the operator's language, and
// the machine is not connected again.
func TestRecoverServerRefusesTheSuccess(t *testing.T) {
	for reason, lang := range map[string]string{"success_checks_missing": LangEN, "success_snapshot_unknown": LangDE, "success_from_the_future": LangDE} {
		u := newUnattended(t)
		u.f.refuseSuccess = reason
		res, err := u.run(fmt.Sprintf(`"language":%q,"rebindToken":"rset_reconnect_token_0123",`, lang) + okMapping)
		if err != nil || res == nil || res.Status != api.RecoveryFailed {
			t.Fatalf("%s: result %+v %v\n%s", reason, res, err, u.out.String())
		}
		if fin := u.finish(); fin == nil || fin.Status != api.RecoverySucceeded {
			t.Fatalf("%s: recover did not report the success it measured: %+v", reason, fin)
		}
		console := u.out.String()
		why := T(lang, "server."+reason)
		if reason == "success_from_the_future" {
			why = T(lang, "server.unknown", "code", reason)
		}
		for _, want := range []string{T(lang, "finish.refused", "reason", why), T(lang, "done.failed"), "RESTOW-RECOVER-RESULT failed"} {
			if !strings.Contains(console, want) {
				t.Errorf("%s: the console lacks %q:\n%s", reason, want, console)
			}
		}
		for _, never := range []string{T(lang, "done.succeeded"), T(lang, "rebind.done"), T(lang, "verify.failed"), "RESULT succeeded", "{"} {
			if strings.Contains(console, never) {
				t.Errorf("%s: the console shows %q:\n%s", reason, never, console)
			}
		}
		u.f.mu.Lock()
		rebind, seen := u.f.rebind, strings.Join(u.f.seen, "\n")
		u.f.mu.Unlock()
		if rebind != nil || strings.Contains(seen, "/rebind") {
			t.Errorf("%s: the rebind was tried after the instance stored the recovery as failed", reason)
		}
		if acts := strings.Join(u.env.actions, ","); strings.Contains(acts, "poweroff") || strings.Contains(acts, "reboot") || strings.Contains(acts, "finalize") {
			t.Errorf("%s: after a refused success: %v", reason, u.env.actions)
		}
	}
}

// A recovery that ends well leaves the session alone after the finish:
// nothing is sent that the instance would refuse (and audit), and the
// console shows no error about it.
func TestRecoverIsQuietAfterTheEnd(t *testing.T) {
	u := newUnattended(t)
	res, err := u.run(`"rebindToken":"rset_reconnect_token_0123",` + okMapping)
	if err != nil || res == nil || res.Status != api.RecoverySucceeded {
		t.Fatalf("run: %v %+v\n%s", err, res, u.out.String())
	}
	u.f.mu.Lock()
	refused, seen, rebind := append([]string(nil), u.f.refused...), append([]string(nil), u.f.seen...), u.f.rebind
	u.f.mu.Unlock()
	if len(refused) != 0 {
		t.Errorf("reports after the end of the session: %v", refused)
	}
	finishAt := -1
	for i, call := range seen {
		if strings.HasSuffix(call, "/finish") {
			finishAt = i
		}
	}
	if finishAt < 0 || rebind == nil {
		t.Fatalf("finish at %d, rebind %+v: %v", finishAt, rebind, seen)
	}
	for _, call := range seen[finishAt+1:] {
		if !strings.HasSuffix(call, "/rebind") {
			t.Errorf("%s after the finish", call)
		}
	}
	// Something was logged after the finish (the rebind, the shutdown):
	// it stays in the local log and is not an error on the console.
	u.r.logf("a line after the end")
	u.r.flushLog(context.Background())
	if _, again := u.f.calls(); len(again) != 0 {
		t.Errorf("a log line after the end was sent: %v", again)
	}
	for _, noise := range []string{"log:", "finish:", T(LangEN, "report.log", "reason", ""), T(LangEN, "report.finish", "reason", ""), "recovery-state-conflict", "HTTP 409", "no more reports"} {
		if strings.Contains(u.out.String(), noise) {
			t.Errorf("the console shows %q:\n%s", noise, u.out.String())
		}
	}
}

// The session is cancelled in the web interface while recover works: the
// first report learns it, nothing more is sent, the console stays free of
// errors, and the end says what the instance holds.
func TestRecoverSessionEndedOnTheInstance(t *testing.T) {
	u := newUnattended(t)
	u.env.onExecutor = func() {
		u.f.mu.Lock()
		u.f.status = api.RecoveryCancelled
		u.f.mu.Unlock()
	}
	res, err := u.run(`"rebindToken":"rset_reconnect_token_0123",` + okMapping)
	if err != nil || res == nil || res.Status != api.RecoveryCancelled {
		t.Fatalf("run: %v %+v\n%s", err, res, u.out.String())
	}
	_, refused := u.f.calls()
	if len(refused) != 1 {
		t.Errorf("refused reports %v: want exactly the one that learned of the end", refused)
	}
	console := u.out.String()
	for _, want := range []string{T(LangEN, "finish.ended", "state", T(LangEN, "state.cancelled")), "RESTOW-RECOVER-RESULT cancelled"} {
		if !strings.Contains(console, want) {
			t.Errorf("the console lacks %q:\n%s", want, console)
		}
	}
	for _, noise := range []string{"log:", "finish:", T(LangEN, "report.log", "reason", ""), T(LangEN, "report.finish", "reason", ""), "recovery-state-conflict", "HTTP 409",
		T(LangEN, "done.succeeded"), T(LangEN, "rebind.done"), T(LangEN, "report.rebind", "reason", "")} {
		if strings.Contains(console, noise) {
			t.Errorf("the console shows %q:\n%s", noise, console)
		}
	}
	u.f.mu.Lock()
	seen := strings.Join(u.f.seen, "\n")
	u.f.mu.Unlock()
	if strings.Contains(seen, "/rebind") || strings.Contains(seen, "/finish") {
		t.Errorf("a finish or a rebind was sent to a session the instance had ended:\n%s", seen)
	}
}

// The backup the code was issued for is gone: recover says so in its own
// words, restores no other snapshot and erases nothing.
func TestRecoverSnapshotOfTheCodeIsGone(t *testing.T) {
	for _, lang := range []string{LangEN, LangDE} {
		u := newUnattended(t)
		u.f.snapshotGone = true
		res, err := u.run(fmt.Sprintf(`"language":%q,`, lang) + okMapping)
		if err != nil || res == nil || res.Status != api.RecoveryFailed {
			t.Fatalf("%s: result %+v %v\n%s", lang, res, err, u.out.String())
		}
		console := u.out.String()
		if !strings.Contains(console, T(lang, "creds.snapshot_gone")) || !strings.Contains(console, "RESTOW-RECOVER-RESULT failed") {
			t.Errorf("%s: the console does not say that the backup is gone:\n%s", lang, console)
		}
		for _, never := range []string{"Ask an administrator", "HTTP 409", "baremetal-not-available", T(lang, "code."+ProblemAccessExpired), T(lang, "manifest.reading", "id", "")} {
			if strings.Contains(console, never) {
				t.Errorf("%s: the console shows %q:\n%s", lang, never, console)
			}
		}
		u.nothingWritten("a code whose backup is gone")
	}
}
