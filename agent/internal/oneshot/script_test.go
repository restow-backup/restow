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

func runScript(t *testing.T, args []string, edit func(root string)) scriptRun {
	return runScriptPinned(t, args, edit, "")
}

// runScriptPinned runs it with RESTOW_SHA256SUMS_SHA256 = pinned (default: the
// hash of the list served).
func runScriptPinned(t *testing.T, args []string, edit func(root string), pinned string) scriptRun {
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
	agent := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 0.5.1; exit 0; fi\nprintf '%s\\n' \"$@\" >\"$FAKE_OUT/argv\"\ncat >\"$FAKE_OUT/stdin\"\nexit 4\n"
	write(filepath.Join(root, "install/agent/0.5.1/linux-amd64/restow-agent"), agent, 0o644)
	sums := sumHex([]byte(agent)) + "  linux-amd64/restow-agent\n" + strings.Repeat("ab", 32) + "  linux-amd64/restic\n"
	write(filepath.Join(root, "install/agent/0.5.1/SHA256SUMS"), sums, 0o644)
	curl := `#!/bin/sh
out=''; url=''; prev=''
for a in "$@"; do
  [ "$prev" = -o ] && out=$a
  case "$a" in http://*) url=$a ;; esac
  prev=$a
done
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
	b, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(work); len(entries) != 0 {
		t.Errorf("the work folder is left behind: %v", entries)
	}
	return scriptRun{dir: dir, out: out, code: code, output: string(b)}
}

func TestOneshotScriptStartsTheCheckedAgentWithTheCodeOnStdin(t *testing.T) {
	r := runScript(t, []string{"OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS", "--lang", "de"}, nil)
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
	log, _ := os.ReadFile(filepath.Join(r.out, "curl.log"))
	if strings.Contains(string(log), "OS-") || strings.Contains(string(log), "restic") {
		t.Errorf("downloads %s", log)
	}
}

func TestOneshotScriptRefusals(t *testing.T) {
	code := "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS"
	for name, tc := range map[string]struct {
		args []string
		edit func(root string)
		want string
	}{
		"no code":       {nil, nil, "usage"},
		"recovery code": {[]string{"RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS"}, nil, "one-time code from Restow"},
		"shell in code": {[]string{"OS-1;reboot"}, nil, "do not belong"},
		"code twice":    {[]string{code, code}, nil, "once"},
		"changed agent": {[]string{code}, func(root string) {
			p := filepath.Join(root, "install/agent/0.5.1/linux-amd64/restow-agent")
			b, _ := os.ReadFile(p)
			_ = os.WriteFile(p, append(b, '#'), 0o644)
		}, "checksum mismatch"},
		"no agent line": {[]string{code}, func(root string) {
			_ = os.WriteFile(filepath.Join(root, "install/agent/0.5.1/SHA256SUMS"), []byte(strings.Repeat("ab", 32)+"  linux-amd64/restic\n"), 0o644)
		}, "no entry"},
	} {
		t.Run(name, func(t *testing.T) {
			r := runScript(t, tc.args, tc.edit)
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
	r := runScriptPinned(t, []string{"OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS"}, nil, strings.Repeat("0", 64))
	if r.code == 0 || r.code == 4 || !strings.Contains(r.output, "RESTOW_SHA256SUMS_SHA256") {
		t.Fatalf("exit %d:\n%s", r.code, r.output)
	}
	if _, err := os.Stat(filepath.Join(r.out, "argv")); err == nil {
		t.Error("the agent ran")
	}
}
