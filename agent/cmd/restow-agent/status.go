package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

type statusReport struct {
	AgentVersion string         `json:"agentVersion"`
	Platform     string         `json:"platform"`
	Enrolled     bool           `json:"enrolled"`
	Credentials  string         `json:"credentials"` // readable | unreadable | missing
	EndpointID   string         `json:"endpointId,omitempty"`
	ServerURL    string         `json:"serverUrl,omitempty"`
	Binary       string         `json:"binary"`
	Hooks        string         `json:"hooks,omitempty"`
	Service      serviceReport  `json:"service"`
	Restic       resticReport   `json:"restic"`
	Runtime      *status.Status `json:"runtime,omitempty"`
	Notes        []string       `json:"notes,omitempty"`
}

type serviceReport struct {
	Manager string `json:"manager,omitempty"`
	State   string `json:"state"`
	PID     int    `json:"pid,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

type resticReport struct {
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

func cmdStatus(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("status", stderr)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	layout := paths.Default()
	rep := statusReport{AgentVersion: buildinfo.Version, Platform: sysinfo.OS() + "/" + sysinfo.Arch(), Credentials: "missing", Binary: executable()}
	if !devLayout() {
		if rep.Binary != paths.InstalledAgentBinary() {
			rep.Notes = append(rep.Notes, "this agent binary is not the installed one ("+paths.InstalledAgentBinary()+")")
		} else if _, err := paths.TrustedFile(rep.Binary); err != nil {
			rep.Notes = append(rep.Notes, "the installation is not safe and the service does nothing until it is repaired: "+err.Error())
		}
	}

	rt, rtErr := status.Load(layout.StatusFile())
	if rtErr != nil {
		rep.Notes = append(rep.Notes, "the runtime status file is unreadable: "+rtErr.Error())
	}
	if rt.EndpointID != "" || !rt.UpdatedAt.IsZero() {
		rep.Runtime = rt
	}

	st, _, err := state.Load(layout.StateFile())
	switch {
	case err == nil:
		rep.Enrolled, rep.Credentials = true, "readable"
		rep.EndpointID, rep.ServerURL = st.EndpointID, st.ServerURL
		rep.Hooks = hooks.NormalizeMode(st.Hooks)
	case errors.Is(err, state.ErrNotEnrolled):
		rep.Credentials = "missing"
	case os.IsPermission(err) || errors.Is(err, os.ErrPermission):
		rep.Credentials = "unreadable"
		rep.Notes = append(rep.Notes, "the credentials are readable by root only; run with sudo for the full picture")
	default:
		rep.Credentials = "unreadable"
		rep.Notes = append(rep.Notes, err.Error())
	}
	if !rep.Enrolled && rt.EndpointID != "" {
		rep.Enrolled, rep.EndpointID, rep.ServerURL = true, rt.EndpointID, rt.ServerURL
	}

	rep.Service = serviceReport{State: "unknown"}
	if m, merr := svc.New(); merr == nil {
		info := m.Status()
		rep.Service = serviceReport{Manager: m.Name(), State: info.State.String(), PID: info.PID, Detail: info.Detail}
	} else {
		rep.Service.Detail = merr.Error()
	}

	if bin, berr := paths.TrustedRestic(); berr == nil {
		rep.Restic.Path = bin
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		r := &restic.Runner{Bin: bin}
		if v, verr := r.Version(ctx); verr == nil {
			rep.Restic.Version = v
		} else {
			rep.Restic.Error = verr.Error()
		}
		cancel()
	} else {
		rep.Restic.Error = berr.Error()
	}

	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
		return exitOK
	}
	printStatus(stdout, rep)
	return exitOK
}

func ago(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	d := time.Since(t).Round(time.Second)
	when := t.Local().Format("2006-01-02 15:04:05 MST")
	switch {
	case d < 0:
		return when + " (in the future: check the clock)"
	case d < time.Minute:
		return when + " (just now)"
	case d < time.Hour:
		return fmt.Sprintf("%s (%d min ago)", when, int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%s (%.0f h ago)", when, d.Hours())
	}
	return fmt.Sprintf("%s (%d days ago)", when, int(d.Hours()/24))
}

func printStatus(w io.Writer, r statusReport) {
	p := func(label, format string, args ...any) {
		fmt.Fprintf(w, "%-15s %s\n", label+":", fmt.Sprintf(format, args...))
	}
	fmt.Fprintf(w, "Restow agent %s (%s)\n\n", r.AgentVersion, r.Platform)
	if !r.Enrolled {
		p("Enrolled", "no")
		fmt.Fprintln(w, "\nThis machine is not enrolled. Create a server or client in the Restow UI (Endpoints)\nand run the install command shown there.")
	} else {
		p("Enrolled", "yes, endpoint %s", r.EndpointID)
		p("Instance", "%s", r.ServerURL)
		if r.Hooks != "" {
			p("Hooks", "%s", describeHooks(r.Hooks, paths.Default()))
		}
	}
	p("Binary", "%s", r.Binary)
	svcLine := r.Service.State
	if r.Service.PID > 0 {
		svcLine += fmt.Sprintf(" (pid %d)", r.Service.PID)
	}
	if r.Service.Manager != "" {
		svcLine += ", " + r.Service.Manager
	}
	p("Service", "%s", svcLine)
	if r.Service.Detail != "" && r.Service.State == "unknown" {
		p("", "%s", r.Service.Detail)
	}
	if r.Restic.Version != "" {
		p("restic", "%s (%s)", r.Restic.Version, r.Restic.Path)
	} else {
		p("restic", "not usable: %s", r.Restic.Error)
	}
	if rt := r.Runtime; rt != nil && r.Enrolled {
		fmt.Fprintln(w)
		if rt.Profile != "" {
			p("Profile", "%s", rt.Profile)
		}
		if !rt.Heartbeat.At.IsZero() {
			if rt.Heartbeat.OK {
				p("Last contact", "%s", ago(rt.Heartbeat.At))
			} else {
				p("Last contact", "FAILED at %s", ago(rt.Heartbeat.At))
				p("", "%s", rt.Heartbeat.Error)
			}
		}
		if rt.ConfigVersion != "" {
			p("Configuration", "version %s, %s", rt.ConfigVersion, rt.Schedule)
		}
		if rt.Current != nil {
			p("Running", "%s since %s", rt.Current.Kind, ago(rt.Current.StartedAt))
		}
		if rt.WaitingForJob {
			p("Backups", "waiting for a backup job")
			p("", "Nothing is backed up until this machine is added to a backup job in the Restow UI.")
		}
		if !rt.NextRunAt.IsZero() {
			p("Next backup", "%s", ago(rt.NextRunAt))
		}
		if b := rt.LastBackup; b != nil {
			line := fmt.Sprintf("%s at %s", b.Status, ago(b.FinishedAt))
			if b.SnapshotID != "" {
				line += ", snapshot " + shortSnap(b.SnapshotID)
			}
			p("Last backup", "%s", line)
			if b.Status != "succeeded" && b.Message != "" {
				p("", "%s", oneLine(b.Message))
			}
		} else {
			p("Last backup", "none yet")
		}
		if !rt.LastSuccessAt.IsZero() {
			p("Last success", "%s", ago(rt.LastSuccessAt))
		}
		if rt.ConsecutiveFailures > 0 {
			p("Failed runs", "%d in a row", rt.ConsecutiveFailures)
		}
		if rt.Interrupted {
			p("Note", "the last backup was interrupted and resumes when possible")
		}
		if rt.LastError != "" {
			p("Last problem", "%s", oneLine(rt.LastError))
		}
		if !rt.UpdatedAt.IsZero() && time.Since(rt.UpdatedAt) > 15*time.Minute && r.Service.State == "running" {
			p("Note", "the runtime status was last written %s; the service may be stuck", ago(rt.UpdatedAt))
		}
	}
	for _, n := range r.Notes {
		fmt.Fprintf(w, "\nNote: %s\n", n)
	}
}

func shortSnap(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 200 {
		s = s[:200] + "..."
	}
	return s
}
