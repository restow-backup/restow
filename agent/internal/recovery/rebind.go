package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/state"
)

// RebindAPI is the part of the session the reconnection uses.
type RebindAPI interface {
	Rebind(ctx context.Context, req api.RecoveryRebindRequest) (*api.EnrollResponse, error)
}

// TargetStatePath is the state file of the agent in the restored system.
const TargetStatePath = "/etc/restow-agent/state.json"

// Rebind connects the restored machine again (10.19): the host name comes
// from /etc/hostname of the target, the answer is written as the agent's
// state file of the target (0600, root) through the target root.
func Rebind(ctx context.Context, s RebindAPI, token, origin string, r Rootfs, m *baremetal.Manifest, agentVersion string) (*state.State, error) {
	if !strings.HasPrefix(token, "rset_") {
		return nil, errors.New("not a reconnect token")
	}
	redact.Add(token)
	host := "restored"
	if b, err := r.ReadFile("/etc/hostname", 4096); err == nil {
		if h := strings.TrimSpace(strings.SplitN(string(b), "\n", 2)[0]); h != "" {
			host = h
		}
	}
	req := api.RecoveryRebindRequest{Token: token, Hostname: host, OS: "linux", Arch: runtime.GOARCH, AgentVersion: agentVersion, Hooks: "off"}
	if m != nil && m.Linux != nil {
		req.OSVersion = osVersion(m)
		if m.Linux.Agent.Hooks != "" {
			req.Hooks = m.Linux.Agent.Hooks
		}
		if m.Linux.OS.Arch != "" {
			req.Arch = m.Linux.OS.Arch
		}
	}
	resp, err := s.Rebind(ctx, req)
	if err != nil {
		return nil, err
	}
	profile := api.ProfileServer
	if resp.Config != nil && resp.Config.Profile != "" {
		profile = resp.Config.Profile
	}
	st := &state.State{SchemaVersion: state.SchemaVersion, ServerURL: strings.TrimRight(origin, "/"), EndpointID: resp.EndpointID.String(),
		Hostname: host, Profile: profile, EnrolledAt: time.Now().UTC(), Hooks: req.Hooks,
		AgentSecret: resp.AgentSecret, RepositoryURL: resp.Repository.URL, RepositoryPassword: resp.Repository.Password}
	redact.Add(st.Secrets()...)
	if err := st.Validate(); err != nil {
		return nil, err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := r.MkdirAll("/etc/restow-agent", 0o700); err != nil {
		return nil, err
	}
	if err := r.WriteFileAtomic(TargetStatePath, append(b, '\n'), 0o600, 0, 0, ""); err != nil {
		return nil, err
	}
	return st, nil
}

func osVersion(m *baremetal.Manifest) string {
	o := m.Linux.OS
	if o.PrettyName != nil && *o.PrettyName != "" {
		return *o.PrettyName
	}
	return strings.TrimSpace(o.ID + " " + deref(o.VersionID))
}
