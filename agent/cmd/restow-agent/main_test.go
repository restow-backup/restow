package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

// fakeRestic is a restic stand-in that answers the few commands the CLI tests
// need: version, cat config, unlock, backup and ls.
const fakeRestic = `#!/bin/sh
case "$1" in
version) echo "restic 0.19.1 compiled with go1.25.10 on linux/arm64" ;;
cat) exit "${FAKE_CAT_EXIT:-0}" ;;
backup)
  echo '{"message_type":"summary","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10,"total_files_processed":1,"total_bytes_processed":10,"snapshot_id":"cccc000000000000000000000000000000000000000000000000000000000000"}' ;;
esac
exit 0
`

type cli struct {
	t   *testing.T
	dir string
	srv *fakeserver.Server
}

// newCLI prepares a development layout (no root, no service) and a fake
// instance on plain HTTP.
func newCLI(t *testing.T) *cli {
	t.Helper()
	c := &cli{t: t, dir: t.TempDir(), srv: fakeserver.New(false)}
	t.Cleanup(c.srv.Close)
	restic := filepath.Join(c.dir, "restic")
	if err := os.WriteFile(restic, []byte(fakeRestic), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RESTOW_AGENT_DIR", filepath.Join(c.dir, "agent"))
	t.Setenv("RESTOW_RESTIC_PATH", restic)
	t.Setenv("RESTOW_URL", c.srv.URL)
	t.Setenv("RESTOW_TOKEN", c.srv.EnrollToken)
	src := filepath.Join(c.dir, "src")
	_ = os.MkdirAll(src, 0o755)
	_ = os.WriteFile(filepath.Join(src, "a.txt"), []byte("hello"), 0o644)
	c.srv.Config.Paths = []string{src}
	return c
}

func (c *cli) run(args ...string) (stdout, stderr string, code int) {
	c.t.Helper()
	var so, se bytes.Buffer
	code = run(args, &so, &se)
	return so.String(), se.String(), code
}

func TestUsageAndUnknownCommands(t *testing.T) {
	var so, se bytes.Buffer
	if code := run(nil, &so, &se); code != exitUsage || !strings.Contains(se.String(), "Usage: restow-agent") {
		t.Fatalf("no args: %d %s", code, se.String())
	}
	so.Reset()
	se.Reset()
	if code := run([]string{"frobnicate"}, &so, &se); code != exitUsage || !strings.Contains(se.String(), `unknown command "frobnicate"`) {
		t.Fatalf("unknown: %d %s", code, se.String())
	}
	so.Reset()
	if code := run([]string{"help"}, &so, &se); code != exitOK || !strings.Contains(so.String(), "enroll") {
		t.Fatalf("help: %d", code)
	}
	so.Reset()
	if code := run([]string{"version"}, &so, &se); code != exitOK || !strings.Contains(so.String(), "restow-agent ") || !strings.Contains(so.String(), "platform:") {
		t.Fatalf("version: %d %s", code, so.String())
	}
	so.Reset()
	if code := run([]string{"version", "--short"}, &so, &se); code != exitOK || strings.Count(so.String(), "\n") != 1 {
		t.Fatalf("version --short: %d %q", code, so.String())
	}
}

func TestEnrollRefusals(t *testing.T) {
	c := newCLI(t)

	t.Setenv("RESTOW_TOKEN", "")
	if _, se, code := c.run("enroll", "--allow-insecure-http"); code != exitError || !strings.Contains(se, "RESTOW_TOKEN is not set") {
		t.Fatalf("no token: %d %s", code, se)
	}
	t.Setenv("RESTOW_TOKEN", "not-a-token")
	if _, se, code := c.run("enroll", "--allow-insecure-http"); code != exitError || !strings.Contains(se, "rset_") {
		t.Fatalf("bad prefix: %d %s", code, se)
	}
	t.Setenv("RESTOW_TOKEN", c.srv.EnrollToken)
	t.Setenv("RESTOW_URL", "")
	if _, se, code := c.run("enroll"); code != exitError || !strings.Contains(se, "RESTOW_URL is not set") {
		t.Fatalf("no url: %d %s", code, se)
	}
	t.Setenv("RESTOW_URL", c.srv.URL) // http://...
	t.Setenv("RESTOW_TOKEN", c.srv.EnrollToken)
	if _, se, code := c.run("enroll"); code != exitError || !strings.Contains(se, "only talks HTTPS") {
		t.Fatalf("plain http without the dev flag must be refused: %d %s", code, se)
	}
	if len(c.srv.Enrollments) != 0 {
		t.Fatal("no request may reach the server in these cases")
	}
	if _, err := os.Stat(filepath.Join(c.dir, "agent", "state", "state.json")); err == nil {
		t.Fatal("state written after a refusal")
	}
}

func TestEnrollRejectedToken(t *testing.T) {
	c := newCLI(t)
	t.Setenv("RESTOW_TOKEN", "rset_this_token_was_never_issued")
	_, se, code := c.run("enroll", "--allow-insecure-http")
	if code != exitError {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{"did not accept the enrollment token", "valid for 24 hours", "Create a new server or client"} {
		if !strings.Contains(se, want) {
			t.Errorf("message lacks %q:\n%s", want, se)
		}
	}
	if strings.Contains(se, "rset_this_token_was_never_issued") {
		t.Fatalf("the token was printed:\n%s", se)
	}
}

func TestEnrollUntrustedCertificateExplains(t *testing.T) {
	tlsSrv := fakeserver.New(true)
	defer tlsSrv.Close()
	c := newCLI(t)
	t.Setenv("RESTOW_URL", tlsSrv.URL)
	t.Setenv("RESTOW_TOKEN", tlsSrv.EnrollToken)
	_, se, code := c.run("enroll")
	if code != exitError || !strings.Contains(se, "not trusted") {
		t.Fatalf("exit %d\n%s", code, se)
	}
}

func TestEnrollInvalidAnswerIsRejected(t *testing.T) {
	c := newCLI(t)
	c.srv.AgentSecret = "wrong-prefix-secret-value-0123456789"
	_, se, code := c.run("enroll", "--allow-insecure-http")
	if code != exitError || !strings.Contains(se, "unusable enrollment answer") || !strings.Contains(se, "rsea_") {
		t.Fatalf("exit %d\n%s", code, se)
	}
	if _, err := os.Stat(filepath.Join(c.dir, "agent", "state", "state.json")); err == nil {
		t.Fatal("an invalid answer must not be stored")
	}
}

func TestEnrollStatusBackupUninstallFlow(t *testing.T) {
	c := newCLI(t)
	so, se, code := c.run("enroll", "--allow-insecure-http")
	if code != exitOK || !strings.Contains(so, "Enrolled as endpoint ep-0001") || !strings.Contains(so, "backup repository is reachable") {
		t.Fatalf("enroll: %d\n%s\n%s", code, so, se)
	}
	for _, secret := range []string{c.srv.AgentSecret, c.srv.RepoPassword, "rset_test_token_0123456789"} {
		if strings.Contains(so+se, secret) {
			t.Fatalf("enroll printed a secret:\n%s\n%s", so, se)
		}
	}
	statePath := filepath.Join(c.dir, "agent", "state", "state.json")
	st, err := os.Stat(statePath)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", err, st)
	}
	raw, _ := os.ReadFile(statePath)
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil || stored["allowInsecureHttp"] != true || stored["endpointId"] != "ep-0001" {
		t.Fatalf("stored state: %v %s", err, raw)
	}
	if len(c.srv.Enrollments) != 1 || c.srv.Enrollments[0].OS == "" || c.srv.Enrollments[0].Arch == "" || c.srv.Enrollments[0].AgentVersion == "" {
		t.Fatalf("enrollment request: %+v", c.srv.Enrollments)
	}
	// Enrolling again is a no-op.
	so, _, code = c.run("enroll", "--allow-insecure-http")
	if code != exitOK || !strings.Contains(so, "already enrolled") || len(c.srv.Enrollments) != 1 {
		t.Fatalf("second enroll: %d %s", code, so)
	}

	// status, text and JSON.
	so, _, code = c.run("status")
	if code != exitOK || !strings.Contains(so, "yes, endpoint ep-0001") || !strings.Contains(so, "restic:") {
		t.Fatalf("status: %d\n%s", code, so)
	}
	for _, secret := range []string{c.srv.AgentSecret, c.srv.RepoPassword} {
		if strings.Contains(so, secret) {
			t.Fatalf("status printed a secret:\n%s", so)
		}
	}
	so, _, code = c.run("status", "--json")
	var rep map[string]any
	if code != exitOK || json.Unmarshal([]byte(so), &rep) != nil || rep["enrolled"] != true || rep["endpointId"] != "ep-0001" {
		t.Fatalf("status --json: %d %s", code, so)
	}

	// backup-now runs a real run against the fake instance.
	so, se, code = c.run("backup-now")
	if code != exitOK || !strings.Contains(so, "Backup finished: snapshot cccc") {
		t.Fatalf("backup-now: %d\n%s\n%s", code, so, se)
	}
	runs := c.srv.AllRuns()
	if len(runs) != 1 || runs[0].Finish == nil || runs[0].Finish.Status != "succeeded" {
		t.Fatalf("server view: %+v", runs)
	}

	// service commands refuse to touch the system in a development layout.
	if _, se, code := c.run("service", "install"); code != exitError || !strings.Contains(se, "system service is not touched") {
		t.Fatalf("service in dev layout: %d %s", code, se)
	}

	// uninstall removes the agent directories and never the running binary.
	exe, _ := os.Executable()
	so, se, code = c.run("uninstall", "--yes")
	if code != exitOK {
		t.Fatalf("uninstall: %d\n%s\n%s", code, so, se)
	}
	if _, err := os.Stat(statePath); err == nil {
		t.Fatal("state survived the uninstall")
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatal("uninstall in a development layout deleted the running binary")
	}
	if _, err := os.Stat(os.Getenv("RESTOW_RESTIC_PATH")); err != nil {
		t.Fatal("uninstall in a development layout deleted restic")
	}
	so, _, _ = c.run("status")
	if !strings.Contains(so, "not enrolled") && !strings.Contains(so, "Enrolled:       no") {
		t.Fatalf("status after uninstall:\n%s", so)
	}
}

func TestBackupNowWithoutEnrollment(t *testing.T) {
	c := newCLI(t)
	_, se, code := c.run("backup-now")
	if code != exitError || !strings.Contains(se, "not enrolled") {
		t.Fatalf("%d %s", code, se)
	}
}

func TestStatusNotEnrolled(t *testing.T) {
	c := newCLI(t)
	so, _, code := c.run("status")
	if code != exitOK || !strings.Contains(so, "Enrolled:       no") || !strings.Contains(so, "install command") {
		t.Fatalf("%d\n%s", code, so)
	}
}

func TestCheckRepositoryURL(t *testing.T) {
	server := "https://restow.example.com"
	good := []string{"rest:https://restow.example.com/agent/restic/ep-1/", "rest:https://RESTOW.example.com:443/agent/restic/ep-1/"}
	for _, r := range good {
		if err := checkRepositoryURL(r, server, false); err != nil {
			t.Errorf("%s: %v", r, err)
		}
	}
	bad := []string{
		"rest:http://restow.example.com/agent/restic/ep-1/", "s3:https://x/bucket", "/local/path", "sftp:host:/x",
		"rest:https://user:pass@restow.example.com/x/",
		// Another host would receive the agent's secret (a forged X-Forwarded-Host at enrollment).
		"rest:https://evil.example.net/agent/restic/ep-1/", "rest:https://restow.example.com.evil.net/agent/restic/ep-1/",
	}
	for _, r := range bad {
		if err := checkRepositoryURL(r, server, false); err == nil {
			t.Errorf("%s must be refused", r)
		}
	}
	if err := checkRepositoryURL("rest:http://127.0.0.1:8080/x/", "http://127.0.0.1:9000", true); err != nil {
		t.Errorf("dev flag: %v", err)
	}
}

func TestEnrollRefusesARepositoryOnAnotherHost(t *testing.T) {
	c := newCLI(t)
	c.srv.RepoURL = "rest:http://evil.example.net/agent/restic/ep-0001/"
	_, se, code := c.run("enroll", "--allow-insecure-http")
	if code != exitError || !strings.Contains(se, "not on the Restow instance") {
		t.Fatalf("exit %d\n%s", code, se)
	}
}

func TestHooksPolicyIsLocal(t *testing.T) {
	c := newCLI(t)
	if _, se, code := c.run("enroll", "--allow-insecure-http", "--hooks", "everything"); code != exitUsage || !strings.Contains(se, "unknown hook mode") {
		t.Fatalf("bad mode: %d %s", code, se)
	}
	t.Setenv("RESTOW_TOKEN", c.srv.EnrollToken) // the agent removes it from its environment
	so, se, code := c.run("enroll", "--allow-insecure-http")
	if code != exitOK || !strings.Contains(so, "Hooks from the Restow server: off") {
		t.Fatalf("enroll: %d\n%s\n%s", code, so, se)
	}
	if c.srv.Enrollments[0].Hooks != "off" {
		t.Fatalf("the enrollment must report the policy: %+v", c.srv.Enrollments[0])
	}
	so, _, code = c.run("hooks")
	if code != exitOK || !strings.Contains(so, "Hook policy:  off") {
		t.Fatalf("hooks status: %d %s", code, so)
	}
	so, se, code = c.run("hooks", "scripts")
	if code != exitOK || !strings.Contains(so, "scripts only") {
		t.Fatalf("hooks scripts: %d %s %s", code, so, se)
	}
	if st, err := os.Stat(filepath.Join(c.dir, "agent", "state", "hooks.d")); err != nil || !st.IsDir() {
		t.Fatal("scripts mode creates the hooks folder")
	}
	raw, _ := os.ReadFile(filepath.Join(c.dir, "agent", "state", "state.json"))
	if !strings.Contains(string(raw), `"hooks": "scripts"`) {
		t.Fatalf("state: %s", raw)
	}
	so, _, _ = c.run("status")
	if !strings.Contains(so, "scripts only") {
		t.Fatalf("status shows the policy:\n%s", so)
	}
	if _, _, code := c.run("hooks", "off"); code != exitOK {
		t.Fatal("hooks off")
	}
	// A new enrollment (--force) keeps the machine's policy unless one is given.
	c.run("hooks", "any")
	c.srv.SetEnrollToken("rset_second_token_0123456789")
	t.Setenv("RESTOW_TOKEN", "rset_second_token_0123456789")
	if so, se, code := c.run("enroll", "--allow-insecure-http", "--force"); code != exitOK || !strings.Contains(so, "any command") {
		t.Fatalf("re-enroll: %d %s %s", code, so, se)
	}
}
