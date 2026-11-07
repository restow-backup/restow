package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/core"
	"github.com/restow-backup/restow/agent/internal/eventlog"
	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/state"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

const (
	tokenPrefix  = "rset_"
	secretPrefix = "rsea_"
)

// checkRepositoryURL accepts rest:https:// repositories (rest:http:// only for
// the development flag) on the host of the Restow instance itself: the agent
// sends its secret to the repository, so an enrollment answer (or a state
// file) that points it at another host is refused.
func checkRepositoryURL(repo, serverURL string, allowInsecure bool) error {
	rest, ok := strings.CutPrefix(repo, "rest:")
	if !ok {
		return fmt.Errorf("the repository %q is not a restic REST repository (rest:https://...)", redactURL(repo))
	}
	if u, err := url.Parse(rest); err == nil && u.User != nil {
		return errors.New("the repository URL must not contain credentials")
	}
	repoURL, err := api.ParseBaseURL(strings.TrimRight(rest, "/"), allowInsecure)
	if err != nil {
		return fmt.Errorf("the repository URL is unusable: %w", err)
	}
	server, err := api.ParseBaseURL(serverURL, allowInsecure)
	if err != nil {
		return fmt.Errorf("the instance URL is unusable: %w", err)
	}
	if !strings.EqualFold(repoURL.Hostname(), server.Hostname()) || repoURL.Scheme != server.Scheme {
		return fmt.Errorf("the backup repository is on %s://%s, not on the Restow instance %s://%s; refusing to send the agent's credentials there",
			repoURL.Scheme, repoURL.Host, server.Scheme, server.Host)
	}
	return nil
}

func redactURL(s string) string { return redact.Redact(s) }

func validateEnrollment(resp *api.EnrollResponse, serverURL string, allowInsecure bool) error {
	switch {
	case resp.EndpointID == "":
		return errors.New("the server answered without an endpoint id")
	case !strings.HasPrefix(resp.AgentSecret, secretPrefix) || len(resp.AgentSecret) < len(secretPrefix)+16:
		return errors.New("the server answered without a valid agent secret (expected the rsea_ prefix)")
	case resp.Repository.URL == "" || resp.Repository.Password == "":
		return errors.New("the server answered without repository details")
	}
	return checkRepositoryURL(resp.Repository.URL, serverURL, allowInsecure)
}

func cmdEnroll(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("enroll", stderr)
	insecure := fs.Bool("allow-insecure-http", false, "DEVELOPMENT ONLY: accept a plain http:// instance URL")
	force := fs.Bool("force", false, "enroll again although this machine is already enrolled (the old endpoint stays on the server)")
	hooksFlag := fs.String("hooks", "", "hooks from the Restow server: off (default), scripts (only scripts in /etc/restow-agent/hooks.d) or any (any shell command, as root)")
	debug := fs.Bool("debug", false, "verbose logging")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if !requireRoot("enroll", stderr) {
		return exitError
	}
	logger := stderrLogger(debugEnabled(*debug), stderr)

	// The token only ever comes from the environment (never from a flag or a
	// URL) and is removed from it right away.
	token := strings.TrimSpace(os.Getenv("RESTOW_TOKEN"))
	_ = os.Unsetenv("RESTOW_TOKEN")
	baseURL := strings.TrimSpace(os.Getenv("RESTOW_URL"))

	hooksMode := hooks.ModeOff
	if *hooksFlag != "" {
		m, err := hooks.ParseMode(*hooksFlag)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return exitUsage
		}
		hooksMode = m
	}

	layout := paths.Default()
	existing, _, existingErr := state.Load(layout.StateFile())
	if existingErr == nil && *hooksFlag == "" {
		hooksMode = hooks.NormalizeMode(existing.Hooks) // a new enrollment keeps the machine's policy
	}
	if err := existingErr; err == nil && !*force {
		fmt.Fprintf(stdout, "This machine is already enrolled as endpoint %s (%s).\nNothing to do. To enroll again with a new token use: restow-agent enroll --force\n",
			existing.EndpointID, existing.ServerURL)
		if *hooksFlag != "" {
			fmt.Fprintln(stdout, "The hook policy of an enrolled machine is changed with: restow-agent hooks off|scripts|any")
		}
		return exitOK
	} else if err != nil && !errors.Is(err, state.ErrNotEnrolled) {
		if !*force {
			fmt.Fprintf(stderr, "The existing enrollment cannot be read: %v\nEnroll again with a new token using: restow-agent enroll --force\n", err)
			return exitError
		}
	}

	if token == "" {
		fmt.Fprintln(stderr, "RESTOW_TOKEN is not set. Create a server or client in the Restow UI (Endpoints) and run the install command shown there; it sets the token for you.")
		return exitError
	}
	redact.Add(token)
	if !strings.HasPrefix(token, tokenPrefix) {
		fmt.Fprintf(stderr, "The token does not look like a Restow enrollment token (it should start with %s). Copy the command from the Restow UI again.\n", tokenPrefix)
		return exitError
	}
	if baseURL == "" {
		fmt.Fprintln(stderr, "RESTOW_URL is not set. Use the install command from the Restow UI, or set RESTOW_URL=https://<your Restow instance>.")
		return exitError
	}
	if _, err := api.ParseBaseURL(baseURL, *insecure); err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	if *insecure {
		fmt.Fprintln(stderr, "WARNING: --allow-insecure-http is set. Credentials will travel unencrypted. Use this for local development only.")
	}

	hostname := os.Getenv("RESTOW_HOSTNAME")
	if hostname == "" {
		hostname = sysinfo.Hostname()
	}
	// The token can be used once: everything local that the enrollment needs
	// is checked before the server sees it, so a folder someone else
	// prepared, a full disk or an unusable DPAPI fails without using it up
	// and without leaving an endpoint on the server (an existing state stays).
	if err := layout.Ensure(); err != nil {
		fmt.Fprintf(stderr, "Cannot create the agent directories: %v\nThe token was not used. Fix the problem and run the command again.\n", err)
		return exitError
	}
	if err := state.CheckWritable(layout.StateFile()); err != nil {
		fmt.Fprintf(stderr, "The credentials could not be stored in %s: %v\nThe token was not used. Fix the problem (permissions, disk space) and run the command again.\n", layout.StateFile(), err)
		return exitError
	}

	ctx, cancel := signalContext()
	defer cancel()
	ectx, ecancel := context.WithTimeout(ctx, 3*time.Minute)
	defer ecancel()
	// What the machine is decides the profile when it was added as a client
	// but runs services (a container, a VM without a desktop).
	machine, dataFolders := core.MachineFactsOf(sysinfo.DetectMachine())
	resp, err := api.Enroll(ectx, baseURL, *insecure, api.EnrollRequest{
		Token: token, Hostname: hostname, OS: sysinfo.OS(), Arch: sysinfo.Arch(),
		AgentVersion: buildinfo.Version, OSVersion: sysinfo.OSVersion(), Hooks: hooksMode,
		Machine: machine, DataFolders: dataFolders, Capabilities: core.Capabilities(machine.Windows != nil),
	})
	if err != nil {
		var ae *api.APIError
		isAPI := errors.As(err, &ae)
		if api.IsTokenRefused(err) {
			fmt.Fprintf(stderr, "The Restow instance did not accept the enrollment token (HTTP %d %s).\n", ae.Status, ae.Title)
			if ae.Detail != "" {
				fmt.Fprintf(stderr, "Reason given: %s\n", redact.Redact(ae.Detail))
			}
			fmt.Fprintln(stderr, "Enrollment tokens are valid for 24 hours and can be used once. Create a new server or client in the Restow UI (Endpoints) and run the install command again.")
			return exitTokenRefused
		}
		if isAPI && ae.Status == 407 {
			// A proxy that wants a login: the request never reached the instance.
			fmt.Fprintf(stderr, "Enrollment failed: the proxy asked for authentication (HTTP 407) and the request did not reach %s. "+
				"Give the proxy with its user name and password (-Proxy http://user:password@proxy:port, or HTTPS_PROXY), or ask for this computer to be allowed through. The token was not used.\n", baseURL)
			return exitUnreachable
		}
		if isAPI && ae.Status >= 400 && ae.Status < 500 && ae.Status != 429 {
			// Answered, but not as the instance refuses a token: a wrong
			// address, a reverse proxy, a web application firewall, an
			// unsupported system. A new token would not help.
			fmt.Fprintf(stderr, "Enrollment failed: %s answered HTTP %d %s to the enrollment request. This is no refusal of the token.\n", baseURL, ae.Status, ae.Title)
			if ae.Detail != "" {
				fmt.Fprintf(stderr, "Reason given: %s\n", redact.Redact(ae.Detail))
			}
			fmt.Fprintln(stderr, "Check that the URL is the address of the Restow web interface, and that no reverse proxy, web application firewall or proxy blocks or rewrites /agent/v1/enroll. Then run the install command again with the same token, unless the reason above says it is used up.")
			return exitError
		}
		fmt.Fprintf(stderr, "Enrollment failed: %s\n", api.Explain(err, baseURL))
		if api.IsNetworkError(err) {
			fmt.Fprintln(stderr, "If the request reached the instance before the connection broke, the token may be used up; then create a new one in the UI.")
			return exitUnreachable
		}
		return exitError
	}
	if err := validateEnrollment(resp, baseURL, *insecure); err != nil {
		fmt.Fprintf(stderr, "The Restow instance sent an unusable enrollment answer: %v\nThe token may be used up; create a new one in the UI. If this repeats, check that the instance and the agent have the same version.\n", err)
		return exitError
	}

	profile := api.ProfileServer
	if resp.Config != nil && resp.Config.Profile != "" {
		profile = resp.Config.Profile
	}
	st := &state.State{
		ServerURL: strings.TrimRight(baseURL, "/"), EndpointID: resp.EndpointID.String(), Hostname: hostname, Profile: profile,
		EnrolledAt: time.Now().UTC(), AllowInsecureHTTP: *insecure, Hooks: hooksMode,
		AgentSecret: resp.AgentSecret, RepositoryURL: resp.Repository.URL, RepositoryPassword: resp.Repository.Password,
	}
	redact.Add(st.Secrets()...)
	if err := st.Save(layout.StateFile()); err != nil {
		// The agent API has no call to withdraw an enrollment with its own
		// credentials, so the new endpoint stays on the server.
		fmt.Fprintf(stderr, "Enrolled as endpoint %s, but the credentials could not be stored in %s: %v\n"+
			"The token is used up, and the endpoint now exists on the server without a machine that can use it: delete it in the Restow UI (Endpoints). "+
			"Fix the problem (permissions, disk space), create a new token and run the command again.\n", st.EndpointID, layout.StateFile(), err)
		return exitError
	}
	eventlog.Info(eventlog.IDEnrolled, fmt.Sprintf("This computer was enrolled at %s as endpoint %s.", st.ServerURL, st.EndpointID))
	fmt.Fprintf(stdout, "Enrolled as endpoint %s (%s profile) on %s.\nCredentials are stored in %s ("+credentialProtection+").\n",
		st.EndpointID, st.Profile, st.ServerURL, layout.StateFile())
	fmt.Fprintf(stdout, "Hooks from the Restow server: %s (change on this machine with: restow-agent hooks off|scripts|any).\n", describeHooks(hooksMode, layout))
	if *force {
		fmt.Fprintln(stdout, "If the agent service is running, restart it to use the new enrollment: restow-agent service restart")
	}

	verifyEnrollment(ctx, stdout, stderr, logger, layout, st)
	return exitOK
}

// verifyEnrollment proves that the stored credentials work against the API and
// the backup repository. Problems are reported, but do not undo the enrollment.
func verifyEnrollment(ctx context.Context, stdout, stderr io.Writer, logger *slog.Logger, layout paths.Layout, st *state.State) {
	client, err := api.New(api.Options{BaseURL: st.ServerURL, EndpointID: st.EndpointID, AgentSecret: st.AgentSecret, AllowInsecureHTTP: st.AllowInsecureHTTP})
	if err != nil {
		fmt.Fprintf(stderr, "WARNING: cannot verify the enrollment: %v\n", err)
		return
	}
	vctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if _, err := client.Config(vctx); err != nil {
		fmt.Fprintf(stderr, "WARNING: the agent API does not accept the new credentials yet: %s\n", api.Explain(err, st.ServerURL))
		return
	}
	fmt.Fprintln(stdout, "Check: the Restow instance accepts the credentials.")

	bin, err := paths.TrustedRestic()
	if err != nil {
		fmt.Fprintf(stderr, "WARNING: cannot check the backup repository: %v\n", err)
		return
	}
	runner := &restic.Runner{Bin: bin, Repo: st.RepositoryURL, Password: st.RepositoryPassword,
		RESTUser: st.EndpointID, RESTPass: st.AgentSecret, CacheDir: layout.CacheDir(),
		TmpDir: filepath.Join(layout.DataDir, "restic-tmp"), Log: func(l string) { logger.Debug("restic: " + l) }}
	_ = os.MkdirAll(layout.CacheDir(), 0o700)
	_ = os.MkdirAll(runner.TmpDir, 0o700)
	ver, verr := runner.Version(vctx)
	if verr != nil {
		fmt.Fprintf(stderr, "WARNING: restic is not usable: %v\n", verr)
		return
	}
	if err := runner.CheckAccess(vctx); err != nil {
		msg := err.Error()
		var re *restic.Error
		if errors.As(err, &re) && re.Hint() != "" {
			msg += ". " + re.Hint()
		}
		fmt.Fprintf(stderr, "WARNING: the backup repository is not usable yet: %s\n", msg)
		return
	}
	fmt.Fprintf(stdout, "Check: the backup repository is reachable and the password is correct (restic %s).\n", ver)
}
