package recovery

import "github.com/restow-backup/restow/agent/internal/api"

// Exit codes of recover. restow-recover.service restarts recover after any
// failure except ExitSessionEnded (RestartPreventExitStatus).
const (
	ExitSucceeded = 0
	ExitFailed    = 1
	ExitCancelled = 3
	// ExitSessionEnded: an unattended run redeemed its code and the session
	// ended without success. A restart would read the same answers and try
	// the used code again (the instance refuses it, then rate limits) every
	// few seconds, and the screen with the result would scroll away; in the
	// lab the network is cut and every restart waits for an address. The
	// result stays on the console; a new attempt needs a new code. A
	// oneshot restore counts as unattended: its session came along.
	ExitSessionEnded = 4
)

// ExitCode is the exit code of a run that ended with res and err.
func (r *Recover) ExitCode(res *Result, err error) int {
	if err == nil && res != nil && res.Status == api.RecoverySucceeded {
		return ExitSucceeded
	}
	if (r.Answers != nil || r.Oneshot != nil) && r.redeemed() {
		return ExitSessionEnded
	}
	if res != nil && res.Status == api.RecoveryCancelled {
		return ExitCancelled
	}
	return ExitFailed
}

// redeemed: this run redeemed its code (it has a session, or a probe
// handed its result to the lab).
func (r *Recover) redeemed() bool {
	return (r.session != nil && r.session.ID != "") || r.probeRelayed
}
