package restic

import (
	"bytes"
	"strings"
	"testing"
)

func TestRestoreArgsDefaultUnchanged(t *testing.T) {
	args, err := RestoreArgs(RestoreOptions{SnapshotID: "abc", Target: "/t"})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(args, " "); got != "restore --json --target /t --overwrite never --verify --retry-lock 15m abc" {
		t.Errorf("default restore args changed: %s", got)
	}
}

// TestRestoreArgsRecovery: the bare-metal restore never combines --no-lock
// with --retry-lock (restic refuses both together, R2).
func TestRestoreArgsRecovery(t *testing.T) {
	args, err := RestoreArgs(RestoreOptions{SnapshotID: "abc", Target: "/mnt/restow-target", NoLock: true, NoCache: true, Sparse: true,
		Overwrite: "if-changed", Excludes: []string{"/srv"}, ExcludeXattrs: []string{"user.*"}, OwnershipByName: true, Subfolder: "/etc"})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(args, " ")
	want := "restore --json --no-lock --no-cache --target /mnt/restow-target --sparse --overwrite if-changed --verify --ownership-by-name --exclude /srv --exclude-xattr user.* abc:/etc"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
	if strings.Contains(got, "--retry-lock") {
		t.Error("--retry-lock together with --no-lock")
	}
	if args, _ := RestoreArgs(RestoreOptions{SnapshotID: "abc", Target: "/t", NoLock: true, NoVerify: true, Overwrite: "always"}); strings.Contains(strings.Join(args, " "), "--verify") {
		t.Error("NoVerify kept --verify")
	}
	for _, o := range []RestoreOptions{
		{SnapshotID: "abc", Target: "/t", Overwrite: "sometimes"},
		{SnapshotID: "abc", Target: "/t", Excludes: []string{"relative"}},
		{SnapshotID: "abc", Target: "/t", Subfolder: "etc"},
		{SnapshotID: "abc", Target: "/t", ExcludeXattrs: []string{""}},
		{Target: "/t"},
	} {
		if _, err := RestoreArgs(o); err == nil {
			t.Errorf("%+v accepted", o)
		}
	}
}

func TestLsAndDumpArgs(t *testing.T) {
	if got := strings.Join(lsArgs("s", LsOptions{}), " "); got != "ls --json --retry-lock 5m s" {
		t.Errorf("ls default: %s", got)
	}
	if got := strings.Join(lsArgs("s", LsOptions{NoLock: true, NoCache: true, Recursive: true, Paths: []string{"/boot"}}), " "); got != "ls --json --no-lock --no-cache --recursive s /boot" {
		t.Errorf("ls recovery: %s", got)
	}
	args, err := DumpArgs("s", "/var/lib/restow-agent/baremetal/layout.json", DumpOptions{NoLock: true, NoCache: true})
	if err != nil || strings.Join(args, " ") != "dump --no-lock --no-cache s /var/lib/restow-agent/baremetal/layout.json" {
		t.Errorf("dump: %v %v", args, err)
	}
	if _, err := DumpArgs("-s", "/x", DumpOptions{}); err == nil {
		t.Error("an option as snapshot accepted")
	}
	if _, err := DumpArgs("s", "x", DumpOptions{}); err == nil {
		t.Error("a relative path accepted")
	}
}

func TestDumpWriterCap(t *testing.T) {
	var buf bytes.Buffer
	w := &dumpWriter{w: &buf, max: 5}
	_, _ = w.Write([]byte("abc"))
	_, _ = w.Write([]byte("defg"))
	if buf.String() != "abcde" || !w.over {
		t.Errorf("cap: %q over=%v", buf.String(), w.over)
	}
}

func TestRunnerEnvRecovery(t *testing.T) {
	r := &Runner{Bin: "restic", Repo: "rest:https://x/", PasswordBytes: []byte("pw"), CACert: "/run/restow-recovery/tls/pinned.pem", Proxy: "http://192.0.2.5:3128"}
	env := strings.Join(r.Env(), "\n")
	for _, want := range []string{"RESTIC_PASSWORD=pw", "RESTIC_CACERT=/run/restow-recovery/tls/pinned.pem", "HTTPS_PROXY=http://192.0.2.5:3128"} {
		if !strings.Contains(env, want) {
			t.Errorf("env lacks %s", want)
		}
	}
	buf := r.PasswordBytes
	r.ZeroSecrets()
	if r.PasswordBytes != nil || buf[0] != 0 || buf[1] != 0 {
		t.Error("password not zeroed")
	}
}
