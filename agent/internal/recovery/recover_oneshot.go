package recovery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// recover in the mode oneshot (docs/BAREMETAL-ONESHOT.md 9.3): the session
// was exchanged on the fresh machine before the switch; the recovery
// environment brings its network up from the measured one, reports back
// (booted), takes the admin's decisions instead of questions and restarts
// after a success.

// OneshotEnv is what the mode oneshot needs of the machine beyond FlowEnv.
type OneshotEnv interface {
	// OneshotNetwork writes the networkd files and reloads networkd.
	OneshotNetwork(ctx context.Context, files []NetworkFile) error
	// EnableRemoteKeys starts sshd with exactly these keys and no
	// password; it returns the host key fingerprints.
	EnableRemoteKeys(ctx context.Context, keys []string) ([]api.RecoverySSHHostKey, error)
	// ForgetOneshot removes the session data (after the finish).
	ForgetOneshot() error
	// MarkWriting records, next to the session data, that the execution
	// starts writing to the disks; WritingStarted reads it after a restart
	// of recover (a crash, the OOM killer), so a failure then does not
	// restart the machine into half-written disks (9.3).
	MarkWriting() error
	WritingStarted() bool
}

func (r *Recover) oneshotEnv() (OneshotEnv, error) {
	e, ok := r.Env.(OneshotEnv)
	if !ok {
		return nil, errors.New("this environment cannot run a oneshot restore")
	}
	return e, nil
}

// oneshotNetwork brings up the network the command measured (10.2); in
// the rescue system's direct mode the network is the rescue system's own.
func (r *Recover) oneshotNetwork(ctx context.Context) error {
	if r.Direct {
		return nil
	}
	e, err := r.oneshotEnv()
	if err != nil {
		return err
	}
	n, err := ParseOneshotNetwork(r.Oneshot.Network)
	if err != nil {
		return err
	}
	files, err := OneshotNetworkFiles(n)
	if err != nil {
		// No usable measured network: DHCP as on every start of the ISO.
		r.logf("oneshot network: %v; DHCP only", err)
		return nil
	}
	return e.OneshotNetwork(ctx, files)
}

// oneshotSession takes the session of the session data, reports back from
// the recovery environment with the hardware found here (the instance ends
// the session when it is not the machine of the exchange) and takes the
// decisions of the release.
func (r *Recover) oneshotSession(ctx context.Context, target *baremetal.Target) error {
	hc := r.HTTPClient
	if hc == nil {
		var err error
		if hc, err = NewHTTPClient(r.trust); err != nil {
			return err
		}
	}
	allowHTTP := strings.HasPrefix(r.origin, "http://")
	s, err := NewSession(r.origin, allowHTTP, hc)
	if err != nil {
		return err
	}
	s.ID, s.Secret = r.Oneshot.Session.ID, r.Oneshot.Session.Secret
	s.registerSecret()
	r.session = s
	r.UI.Say("approval.match", "match", FormatMatchCode(s.MatchCode()))
	if err := s.OneshotBooted(ctx, ExchangeHardware(target)); err != nil {
		if IsProblem(err, ProblemSessionEnded) || IsProblem(err, ProblemStateConflict) {
			r.UI.Say("oneshot.session_ended")
			return &problemError{code: ProblemAccessExpired, err: err}
		}
		return err
	}
	_ = s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseBooted})
	st, err := s.Current(ctx)
	if err != nil {
		return err
	}
	if st.Status != api.RecoveryActive || st.Oneshot == nil || st.Oneshot.Decided == nil {
		r.UI.Say("oneshot.session_ended")
		return &problemError{code: ProblemAccessExpired, err: fmt.Errorf("the session is %s without the decisions of its release", st.Status)}
	}
	dec := st.Oneshot.Decided
	r.decided = dec
	r.Answers.ApplyDecided(dec)
	r.logf("oneshot: released with network %s, shrink %v, Secure Boot findings as warnings %v, remote access %v",
		dec.NetworkMode, dec.ConfirmShrink, dec.SecureBootWarningsOnly, dec.RemoteAccess)
	_ = s.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseConnected})
	if dec.RemoteAccess && !r.Direct {
		r.oneshotRemote(ctx, st.Oneshot.SSHKeys)
	}
	return nil
}

// oneshotRemote starts sshd with the keys of root of the fresh machine,
// only when they are exactly the ones the admin saw with the release
// (fingerprints); otherwise remote access stays off.
func (r *Recover) oneshotRemote(ctx context.Context, approved []string) {
	keys, err := r.Oneshot.ApprovedKeys(approved)
	if err != nil {
		r.logf("remote access: %v", err)
		r.UI.Say("oneshot.keys_mismatch")
		return
	}
	e, err := r.oneshotEnv()
	if err == nil {
		var hostKeys []api.RecoverySSHHostKey
		if hostKeys, err = e.EnableRemoteKeys(ctx, keys); err == nil {
			r.remoteOn = true
			for _, k := range hostKeys {
				r.UI.Say("remote.hostkeys", "type", k.Type, "fingerprint", k.Fingerprint)
			}
			_ = r.session.Progress(ctx, api.RecoveryProgress{Phase: api.RecoveryPhaseConnected, SSHHostKeys: hostKeys})
			_ = r.session.Event(ctx, api.RecoveryEventRemoteAccessEnabled, map[string]string{"keys": fmt.Sprint(len(keys))})
			r.UI.Say("remote.keys")
			return
		}
	}
	r.logf("remote access: %v", err)
	r.UI.Raw(redact.Redact(err.Error()))
}

// networkTakeover is the takeover of the fresh machine's network for the
// executor (10.4): with networkMode takeover the network the command
// measured; with keep only the bindings to the old hardware go and
// cloud-init is limited (11.2). Nil outside a oneshot restore.
func (r *Recover) networkTakeover(m *baremetal.Manifest) (*NetworkTakeover, error) {
	if r.Oneshot == nil || r.decided == nil || m == nil || m.Linux == nil {
		return nil, nil
	}
	n, err := ParseOneshotNetwork(r.Oneshot.Network)
	if err != nil {
		return nil, err
	}
	nt := &NetworkTakeover{Net: TakeoverNetOf(n), Takeover: r.decided.NetworkMode == "takeover", SessionID: r.session.ID, Now: r.Env.Now()}
	for _, ni := range m.Linux.Network {
		if !ni.Physical {
			continue
		}
		nt.OldNames = append(nt.OldNames, ni.Name)
		if ni.MAC != nil {
			nt.OldMACs = append(nt.OldMACs, *ni.MAC)
		}
	}
	return nt, nil
}

// markWriting persists that the disks are about to be written. Without
// the mark nothing is written: a restart of recover after a crash could
// otherwise restart the machine into half-written disks.
func (r *Recover) markWriting() error {
	if r.Oneshot == nil {
		return nil
	}
	e, err := r.oneshotEnv()
	if err != nil {
		return err
	}
	return e.MarkWriting()
}

// noteEarlierWrite: recover started again (systemd restarted it after a
// crash) after an earlier run had begun to write.
func (r *Recover) noteEarlierWrite() {
	if r.Oneshot == nil {
		return
	}
	if e, err := r.oneshotEnv(); err == nil && e.WritingStarted() {
		r.writing = true
		r.UI.Say("oneshot.restarted_after_write")
		r.logf("oneshot: an earlier run of recover began to write the disks; no automatic restart")
	}
}

// oneshotEnd is the end of a oneshot restore that did not succeed (9.3):
// before the first write the fresh machine's own system is untouched, and
// after a minute (any key stops it) the machine starts it again; after the
// first write it stays in the recovery environment.
func (r *Recover) oneshotEnd(ctx context.Context, res *Result) {
	if r.Oneshot == nil || (res != nil && res.Status == api.RecoverySucceeded) {
		return
	}
	if r.writing {
		r.UI.Say("oneshot.failed_written")
		return
	}
	if r.Direct {
		r.UI.Say("oneshot.failed_direct")
		return
	}
	if r.countdownFor(ctx, r.RebootWait, 60*time.Second, "oneshot.failed_untouched", nil) {
		_ = r.Env.Reboot(ctx)
		return
	}
	r.UI.Say("oneshot.reboot_stopped")
}

// forgetOneshot removes the session data once the instance took the
// finish: a restart of recover before that needs it (9.2).
func (r *Recover) forgetOneshot() {
	if r.Oneshot == nil {
		return
	}
	if e, err := r.oneshotEnv(); err == nil {
		if err := e.ForgetOneshot(); err != nil {
			r.logf("oneshot: %v", err)
		}
	}
}
