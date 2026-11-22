package oneshot

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// oneshot.sh shares the signature check with linux.sh as a copy
// (docs/BAREMETAL-ONESHOT.md 8.1, decided in O3): this test keeps both
// copies equal.
var sharedShellFunctions = []string{"sha256_of", "is_dev_version", "key_line", "key_fingerprint",
	"verify_with_ssh_keygen", "verify_with_openssl", "verify_release"}

func shellFunction(t *testing.T, script, name string) string {
	t.Helper()
	re := regexp.MustCompile(`(?ms)^` + name + `\(\) \{(?: [^\n]*\}$|\n.*?^\}$)`)
	m := re.FindString(script)
	if m == "" {
		t.Fatalf("no function %s", name)
	}
	return m
}

func readScript(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "install", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestOneshotScriptSharesTheSignatureCheckWithLinuxSh(t *testing.T) {
	linux, one := readScript(t, "linux.sh"), readScript(t, "oneshot.sh")
	for _, fn := range sharedShellFunctions {
		if a, b := shellFunction(t, linux, fn), shellFunction(t, one, fn); a != b {
			t.Errorf("%s differs between linux.sh and oneshot.sh:\n%s\n----\n%s", fn, a, b)
		}
	}
}

// scriptRun runs oneshot.sh against a fake instance (curl from a folder)
// and a fake agent that records its arguments and its stdin.
type scriptRun struct {
	dir, out string
	code     int
	output   string
}

func runScript(t *testing.T, code string, args []string, edit func(root string)) scriptRun {
	return runScriptPinned(t, code, args, edit, "")
}

// runScriptPinned runs it with RESTOW_SHA256SUMS_SHA256 = pinned (default: the
// hash of the list served).
func runScriptPinned(t *testing.T, code string, args []string, edit func(root string), pinned string) scriptRun {
	t.Helper()
	return runScriptEnv(t, code, args, edit, pinned, nil)
}

// runScriptEnv runs it with more environment variables.
func runScriptEnv(t *testing.T, code string, args []string, edit func(root string), pinned string, env []string) scriptRun {
	t.Helper()
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("oneshot.sh runs on x86_64 Linux")
	}
	for _, tool := range []string{"sh", "sha256sum", "awk", "mktemp"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " missing")
		}
	}
	dir := t.TempDir()
	root, bin, out, work := filepath.Join(dir, "instance"), filepath.Join(dir, "bin"), filepath.Join(dir, "out"), filepath.Join(dir, "work")
	for _, d := range []string{filepath.Join(root, "install/agent/0.5.1/linux-amd64"), bin, out, work} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, s string, mode os.FileMode) {
		if err := os.WriteFile(p, []byte(s), mode); err != nil {
			t.Fatal(err)
		}
	}
	agent := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 0.5.1; exit 0; fi\nprintf '%s\\n' \"$@\" >\"$FAKE_OUT/argv\"\nenv >\"$FAKE_OUT/env\"\ncat >\"$FAKE_OUT/stdin\"\nexit 4\n"
	write(filepath.Join(root, "install/agent/0.5.1/linux-amd64/restow-agent"), agent, 0o644)
	restic := "#!/bin/sh\necho restic\n"
	write(filepath.Join(root, "install/agent/0.5.1/linux-amd64/restic"), restic, 0o644)
	sums := sumHex([]byte(agent)) + "  linux-amd64/restow-agent\n" + sumHex([]byte(restic)) + "  linux-amd64/restic\n"
	write(filepath.Join(root, "install/agent/0.5.1/SHA256SUMS"), sums, 0o644)
	// As strict as curl about its arguments: one URL, and the options
	// oneshot.sh uses with their values; anything else is curl's exit 3.
	curl := `#!/bin/sh
out=''; url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --cacert) echo "$2" >>"$FAKE_OUT/cacert.log"; shift 2 ;;
    --retry|--retry-delay|--connect-timeout|--max-time|--proto) shift 2 ;;
    -fsSL|--tlsv1.2) shift ;;
    *)
      case "$1" in http://*) ;; *) echo "curl: (3) URL using bad/illegal format or missing URL: $1" >&2; exit 3 ;; esac
      [ -z "$url" ] || { echo "curl: a second URL: $1" >&2; exit 3; }
      url=$1; shift ;;
  esac
done
[ -n "$out" ] || { echo "curl: no -o" >&2; exit 2; }
echo "$url" >>"$FAKE_OUT/curl.log"
f="$FAKE_ROOT${url#http://instance.test}"
[ -f "$f" ] || exit 22
cp "$f" "$out"
`
	write(filepath.Join(bin, "curl"), curl, 0o755)
	if edit != nil {
		edit(root)
	}
	if pinned == "" {
		sumsNow, _ := os.ReadFile(filepath.Join(root, "install/agent/0.5.1/SHA256SUMS"))
		pinned = sumHex(sumsNow)
	}
	script := strings.NewReplacer("__RESTOW_URL__", "http://instance.test", "__RESTOW_VERSION__", "0.5.1", "__RESTOW_RELEASE_KEY__", "").
		Replace(readScript(t, "oneshot.sh"))
	write(filepath.Join(dir, "oneshot.sh"), script, 0o644)
	cmd := exec.Command("sh", append([]string{filepath.Join(dir, "oneshot.sh")}, args...)...)
	cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin", "FAKE_OUT=" + out, "FAKE_ROOT=" + root,
		"RESTOW_ALLOW_INSECURE_HTTP=1", "RESTOW_ONESHOT_TEST_DIR=" + work, "RESTOW_SHA256SUMS_SHA256=" + pinned}
	if code != "" {
		cmd.Env = append(cmd.Env, "RESTOW_ONESHOT_CODE="+code)
	}
	cmd.Env = append(cmd.Env, env...)
	b, err := cmd.CombinedOutput()
	exit := 0
	if ee, ok := err.(*exec.ExitError); ok {
		exit = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(work); len(entries) != 0 {
		t.Errorf("the work folder is left behind: %v", entries)
	}
	return scriptRun{dir: dir, out: out, code: exit, output: string(b)}
}

func TestOneshotScriptStartsTheCheckedAgentWithTheCodeOnStdin(t *testing.T) {
	r := runScript(t, "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS", []string{"--lang", "de"}, nil)
	if r.code != 4 {
		t.Fatalf("exit %d (the agent's 4 passed on):\n%s", r.code, r.output)
	}
	argv, _ := os.ReadFile(filepath.Join(r.out, "argv"))
	stdin, _ := os.ReadFile(filepath.Join(r.out, "stdin"))
	if string(argv) != "oneshot\n--instance\nhttp://instance.test\n--code-stdin\n--lang\nde\n" {
		t.Errorf("argv %q", argv)
	}
	if string(stdin) != "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS\n" {
		t.Errorf("stdin %q", stdin)
	}
	// The agent does not inherit the code in its environment.
	if env, _ := os.ReadFile(filepath.Join(r.out, "env")); strings.Contains(string(env), "OS-7K3QX") || len(env) == 0 {
		t.Errorf("the agent's environment: %s", env)
	}
	log, _ := os.ReadFile(filepath.Join(r.out, "curl.log"))
	if strings.Contains(string(log), "OS-") || strings.Contains(string(log), "restic") {
		t.Errorf("downloads %s", log)
	}
}

func TestOneshotScriptRefusals(t *testing.T) {
	code := "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS"
	for name, tc := range map[string]struct {
		code string
		args []string
		edit func(root string)
		want string
	}{
		"no code":       {"", nil, nil, "no code"},
		"recovery code": {"RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS", nil, nil, "one-time code from Restow"},
		"shell in code": {"OS-1;reboot", nil, nil, "do not belong"},
		"code in argv":  {"", []string{code}, nil, "does not belong on the command line"},
		"code in both":  {code, []string{"--lang", "de", code}, nil, "does not belong on the command line"},
		"changed agent": {code, nil, func(root string) {
			p := filepath.Join(root, "install/agent/0.5.1/linux-amd64/restow-agent")
			b, _ := os.ReadFile(p)
			_ = os.WriteFile(p, append(b, '#'), 0o644)
		}, "checksum mismatch"},
		"no agent line": {code, nil, func(root string) {
			_ = os.WriteFile(filepath.Join(root, "install/agent/0.5.1/SHA256SUMS"), []byte(strings.Repeat("ab", 32)+"  linux-amd64/restic\n"), 0o644)
		}, "no entry"},
	} {
		t.Run(name, func(t *testing.T) {
			r := runScript(t, tc.code, tc.args, tc.edit)
			if r.code == 0 || r.code == 4 || !strings.Contains(r.output, tc.want) {
				t.Fatalf("exit %d, want %q:\n%s", r.code, tc.want, r.output)
			}
			if _, err := os.Stat(filepath.Join(r.out, "argv")); err == nil {
				t.Error("the agent ran")
			}
		})
	}
}

func TestOneshotScriptRefusesAnotherSumsList(t *testing.T) {
	// RESTOW_SHA256SUMS_SHA256 names a list the admin checked; the instance serves another.
	r := runScriptPinned(t, "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS", nil, nil, strings.Repeat("0", 64))
	if r.code == 0 || r.code == 4 || !strings.Contains(r.output, "RESTOW_SHA256SUMS_SHA256") {
		t.Fatalf("exit %d:\n%s", r.code, r.output)
	}
	if _, err := os.Stat(filepath.Join(r.out, "argv")); err == nil {
		t.Error("the agent ran")
	}
}

func TestOneshotScriptDirectModeChecksRestic(t *testing.T) {
	code := "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS"
	r := runScript(t, code, []string{"--direct"}, nil)
	if r.code != 4 {
		t.Fatalf("exit %d:\n%s", r.code, r.output)
	}
	argv, _ := os.ReadFile(filepath.Join(r.out, "argv"))
	lines := strings.Split(strings.TrimSpace(string(argv)), "\n")
	if len(lines) != 7 || lines[4] != "--direct" || lines[5] != "--restic" || !strings.HasSuffix(lines[6], "/restic") {
		t.Fatalf("argv %q", lines)
	}
	if log, _ := os.ReadFile(filepath.Join(r.out, "curl.log")); !strings.Contains(string(log), "linux-amd64/restic") {
		t.Errorf("downloads %s", log)
	}
	// Without --direct restic is not downloaded.
	r = runScript(t, code, nil, nil)
	if log, _ := os.ReadFile(filepath.Join(r.out, "curl.log")); strings.Contains(string(log), "restic") {
		t.Errorf("downloads %s", log)
	}
	for name, tc := range map[string]struct {
		args []string
		edit func(root string)
		want string
	}{
		"changed restic": {[]string{"--direct"}, func(root string) {
			p := filepath.Join(root, "install/agent/0.5.1/linux-amd64/restic")
			b, _ := os.ReadFile(p)
			_ = os.WriteFile(p, append(b, '#'), 0o644)
		}, "checksum mismatch for restic"},
		"a restic of one's own":           {[]string{"--direct", "--restic", "/tmp/x"}, nil, "set by this script"},
		"a restic of one's own, one dash": {[]string{"--direct", "-restic=/tmp/x"}, nil, "set by this script"},
		"direct with one dash":            {[]string{"-direct"}, nil, "exactly as --direct"},
		"direct with a value":             {[]string{"--direct=true"}, nil, "exactly as --direct"},
		"direct with one dash and value":  {[]string{"-direct=1"}, nil, "exactly as --direct"},
	} {
		r := runScript(t, code, tc.args, tc.edit)
		if r.code == 0 || r.code == 4 || !strings.Contains(r.output, tc.want) {
			t.Errorf("%s: exit %d, want %q:\n%s", name, r.code, tc.want, r.output)
		}
		if _, err := os.Stat(filepath.Join(r.out, "argv")); err == nil {
			t.Errorf("%s: the agent ran", name)
		}
	}
}

// The CA of a private instance goes to every download, with the URL as the
// one URL of curl (O-E2 in CI run 44797153253: the target file went along as
// a second URL, and every download failed with curl's exit 3).
func TestOneshotScriptDownloadsWithTheCAFile(t *testing.T) {
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, []byte("not a certificate, the fake curl does not read it\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := runScriptEnv(t, "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS", nil, nil, "", []string{"RESTOW_CA_FILE=" + ca})
	if r.code != 4 {
		t.Fatalf("exit %d (the agent's 4 passed on):\n%s", r.code, r.output)
	}
	downloads, _ := os.ReadFile(filepath.Join(r.out, "curl.log"))
	cas, _ := os.ReadFile(filepath.Join(r.out, "cacert.log"))
	n := strings.Count(string(downloads), "\n")
	if n == 0 || strings.Count(string(cas), ca+"\n") != n {
		t.Errorf("downloads %q, CA files %q", downloads, cas)
	}
	if env, _ := os.ReadFile(filepath.Join(r.out, "env")); !strings.Contains(string(env), "RESTOW_CA_FILE="+ca) {
		t.Errorf("the agent does not get the CA file: %s", env)
	}
}
