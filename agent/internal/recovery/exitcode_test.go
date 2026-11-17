package recovery

import (
	"errors"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// An unattended run that redeemed its code ends with ExitSessionEnded
// unless it succeeded, so systemd does not restart it with the used code
// (P3: 56 restarts in two hours, the first run's log scrolled away).
func TestExitCode(t *testing.T) {
	failed := &Result{Status: api.RecoveryFailed}
	cancelled := &Result{Status: api.RecoveryCancelled}
	ok := &Result{Status: api.RecoverySucceeded}
	boom := errors.New("boom")
	answers := &Answers{Source: SourceFWCfg}
	session := &Session{ID: "s1"}
	for _, c := range []struct {
		name string
		r    *Recover
		res  *Result
		err  error
		want int
	}{
		{"succeeded", &Recover{Answers: answers, session: session}, ok, nil, ExitSucceeded},
		{"attended, failed after the code", &Recover{session: session}, failed, boom, ExitFailed},
		{"attended, cancelled", &Recover{session: session}, cancelled, nil, ExitCancelled},
		{"unattended, failed before the code (network)", &Recover{Answers: answers}, nil, boom, ExitFailed},
		{"unattended, cancelled before the code", &Recover{Answers: answers}, cancelled, nil, ExitCancelled},
		{"unattended, failed after the code", &Recover{Answers: answers, session: session}, failed, boom, ExitSessionEnded},
		{"unattended, cancelled after the code", &Recover{Answers: answers, session: session}, cancelled, nil, ExitSessionEnded},
		{"probe, result relayed to the lab", &Recover{Answers: answers, probeRelayed: true}, failed, nil, ExitSessionEnded},
		{"success with an error", &Recover{Answers: answers, session: session}, ok, boom, ExitSessionEnded},
	} {
		if got := c.r.ExitCode(c.res, c.err); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}
