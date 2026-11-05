//go:build linux

package recovery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// testEnv is FlowEnv for the full flow: fake hardware, a fake command
// runner and isolator, a real target folder and the real restic against
// a local repository.
type testEnv struct {
	t        *testing.T
	hw       HardwareInput
	repo     string
	resticB  string
	target   string
	exec     *fakeExec
	iso      *fakeIsolator
	ops      *fakeOps
	mu       sync.Mutex
	actions  []string
	executor *Executor
	// realTLS probes the instance for real (the attended flow with a TLS
	// test server).
	realTLS bool
}

func (e *testEnv) note(s string) { e.mu.Lock(); e.actions = append(e.actions, s); e.mu.Unlock() }

func (e *testEnv) Now() time.Time                                      { return time.Now() }
func (e *testEnv) Hardware(ctx context.Context) (HardwareInput, error) { return e.hw, nil }
func (e *testEnv) Interfaces() []NetIface {
	return []NetIface{{Name: "enp1s0", MAC: "52:54:00:12:34:56", Link: true, Physical: true, Addresses: []string{"192.0.2.10/24"}}}
}
func (e *testEnv) ApplyNetwork(ctx context.Context, n AnswersNetwork) error {
	e.note("network " + n.Mode)
	return nil
}
func (e *testEnv) WaitNetwork(ctx context.Context, ui *UI, timeout time.Duration) []NetIface {
	return e.Interfaces()
}
func (e *testEnv) NoDriverDevices(ctx context.Context) []string { return nil }
func (e *testEnv) LoadKeymap(ctx context.Context, layout, variant string) error {
	e.note("keymap " + layout)
	return nil
}
func (e *testEnv) SetClock(t time.Time) error { return nil }
func (e *testEnv) ProbeTLS(ctx context.Context, origin, proxy string) (*TLSProbe, error) {
	if e.realTLS {
		return ProbeTLS(ctx, origin, proxy, nil)
	}
	return nil, fmt.Errorf("no TLS in this test")
}
func (e *testEnv) DateHint(ctx context.Context, origin, proxy string) (time.Time, error) {
	return time.Time{}, nil
}
func (e *testEnv) ReadFile(p string) ([]byte, error) { return os.ReadFile(p) }
func (e *testEnv) Restic(repo string, password []byte, user, pass string, trust TrustConfig) (ResticReader, ResticRestorer, func(), error) {
	r := &restic.Runner{Bin: e.resticB, Repo: e.repo, PasswordBytes: password, TmpDir: e.t.TempDir(), OwnProcessGroup: true}
	return RunnerReader{Runner: r}, ResticExec{Runner: r}, r.ZeroSecrets, nil
}
func (e *testEnv) Executor(x *Executor, t *baremetal.Target) {
	x.Exec, x.Ops, x.Isolator, x.TargetRoot = e.exec, e.ops, e.iso, e.target
	x.OpenRootfs = func() (Rootfs, error) {
		r, err := OpenRootfs(e.target)
		if err != nil {
			return nil, err
		}
		return chownless{r}, nil
	}
	order := []int64{}
	for i := 0; i < 16; i++ {
		order = append(order, int64(i))
	}
	entries := map[int]baremetal.LoadOption{}
	for i := 0; i < 16; i++ {
		entries[i] = baremetal.LoadOption{Path: `\EFI\test\none.efi`}
	}
	x.Verifier = StandardVerifier{Env: &allExists{order: order, entries: entries}, Target: t}
	e.executor = x
}
func (e *testEnv) Finalize(ctx context.Context, x *Executor) { e.note("finalize") }
func (e *testEnv) Shell(ctx context.Context) error           { e.note("shell"); return nil }
func (e *testEnv) Reboot(ctx context.Context) error          { e.note("reboot"); return nil }
func (e *testEnv) PowerOff(ctx context.Context) error        { e.note("poweroff"); return nil }
func (e *testEnv) EnableRemote(ctx context.Context) (string, []api.RecoverySSHHostKey, error) {
	return "", nil, fmt.Errorf("no remote access in this test")
}
func (e *testEnv) RemoteKeys(ctx context.Context, keys []string) error { return nil }

// chownless lets the flow run without root: owners are not changed.
type chownless struct{ *DirRootfs }

func (c chownless) Chown(p string, uid, gid int) error {
	if os.Geteuid() == 0 {
		return c.DirRootfs.Chown(p, uid, gid)
	}
	return nil
}

func (c chownless) WriteFileAtomic(p string, data []byte, mode fs.FileMode, uid, gid int, backup string) error {
	if os.Geteuid() != 0 {
		uid, gid = os.Getuid(), os.Getgid()
	}
	return c.DirRootfs.WriteFileAtomic(p, data, mode, uid, gid, backup)
}

type allExists struct {
	order   []int64
	entries map[int]baremetal.LoadOption
}

func (a *allExists) Exists(string) bool                                             { return true }
func (a *allExists) Statfs(string) (int64, int64, error)                            { return 60, 100, nil }
func (a *allExists) BootOrder() []int64                                             { return a.order }
func (a *allExists) BootEntries() map[int]baremetal.LoadOption                      { return a.entries }
func (a *allExists) ReadHead(string, int) ([]byte, error)                           { return []byte("GRUB"), nil }
func (a *allExists) Signatures(context.Context, string) []baremetal.TargetSignature { return nil }

// snapshotOf backs up a source tree that holds the manifest and a few
// files of the system into a new local repository.
func snapshotOf(t *testing.T, bin string, manifest []byte) (repo, snapshot string) {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	repo = filepath.Join(dir, "repo")
	files := map[string]string{
		"var/lib/restow-agent/baremetal/layout.json": string(manifest),
		"etc/fstab":                                  "/dev/mapper/srv01--vg-root / ext4 errors=remount-ro 0 1\n/dev/nvme0n1p2 /boot ext4 defaults 0 2\n/dev/nvme0n1p1 /boot/efi vfat umask=0077 0 1\n/dev/mapper/srv01--vg-home /home ext4 defaults 0 2\n",
		"etc/crypttab":                               "nvme0n1p3_crypt UUID=2b1f0c3e-6d7a-4e8b-9c0d-1e2f3a4b5c6d none luks,discard\n",
		"etc/default/grub":                           "GRUB_CMDLINE_LINUX_DEFAULT=\"quiet\"\nGRUB_CMDLINE_LINUX=\"\"\n",
		"etc/hostname":                               "srv01\n",
		"etc/initramfs-tools/conf.d/resume":          "RESUME=/dev/mapper/srv01--vg-swap_1\n",
		"boot/initrd.img-6.1.0-27-amd64":             "initrd",
		"boot/grub/grub.cfg":                         "linux /vmlinuz root=/dev/mapper/srv01--vg-root ro\n",
		"lib/modules/6.1.0-27-amd64/modules.alias":   "alias pci:v*d*sv*sd*bc01sc08i02* nvme\n",
		"lib/modules/6.1.0-27-amd64/modules.builtin": "",
		"home/alice/notes.txt":                       "hello\n",
	}
	for p, c := range files {
		full := filepath.Join(src, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env := append(os.Environ(), "RESTIC_PASSWORD=repo-password-for-recovery-0123", "RESTIC_REPOSITORY="+repo, "RESTIC_CACHE_DIR="+filepath.Join(dir, "cache"))
	run := func(args ...string) []byte {
		cmd := exec.Command(bin, args...)
		cmd.Env, cmd.Dir = env, src
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("restic %v: %v\n%s", args, err, out)
		}
		return out
	}
	run("init", "-q")
	out := run("backup", "-q", "--json", ".")
	var sum struct {
		SnapshotID string `json:"snapshot_id"`
	}
	for _, l := range bytes.Split(out, []byte("\n")) {
		if bytes.Contains(l, []byte(`"summary"`)) {
			_ = json.Unmarshal(l, &sum)
		}
	}
	if len(sum.SnapshotID) != 64 {
		t.Fatalf("no snapshot id in %s", out)
	}
	return repo, sum.SnapshotID
}

// hardwareFor is the replacement machine: the disks of the manifest with
// serials as identities.
func hardwareFor(m *baremetal.Manifest) HardwareInput {
	in := HardwareInput{Firmware: baremetal.TargetFirmware{Mode: m.Linux.Firmware.Mode}, RAMBytes: 16 << 30}
	for i, d := range m.Linux.Disks {
		in.Blocks = append(in.Blocks, BlockInfo{KName: d.KName, SizeBytes: d.SizeBytes, Logical: d.LogicalSectorSize, Physical: d.PhysicalSectorSize,
			Serial: fmt.Sprintf("restow-e2e-target%d", i), Transport: deref(d.Transport), Zoned: "none"})
	}
	in.NICs = []baremetal.TargetNIC{{Name: "enp1s0", MAC: strPtrT("52:54:00:12:34:56")}}
	return in
}

func TestRecoverFullFlowUnattended(t *testing.T) {
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY to run the full recovery flow with restic")
	}
	raw, err := os.ReadFile("../baremetal/testdata/manifests/debian12-uefi-luks-lvm.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := baremetal.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	repo, snap := snapshotOf(t, bin, raw)
	f := newFakeRecovery(t, "", testCode)
	f.snapshotID, f.layoutSHA = snap, sha256Hex(string(raw))
	go func() {
		// The administrator approves after a moment.
		for i := 0; i < 100; i++ {
			time.Sleep(20 * time.Millisecond)
			f.mu.Lock()
			if f.secretSHA != "" {
				f.status = api.RecoveryActive
				f.mu.Unlock()
				return
			}
			f.mu.Unlock()
		}
	}()
	answers := fmt.Sprintf(`{"format":"restow-answers-v1","instanceUrl":%q,"code":%q,"keymap":"de","language":"de",
	  "network":{"mode":"dhcp"},"diskMapping":{"d0":"serial.restow-e2e-target0"},"passphrase":%q,
	  "keyFiles":"regenerate","confirmErase":["serial.restow-e2e-target0"],"renameNics":true,"rawLvs":"skip",
	  "rebindToken":"rset_reconnect_token_0123","afterSuccess":"poweroff"}`, f.srv.URL, FormatCode(testCode), testPassphrase)
	a, err := LoadAnswers(SourceFWCfg, []byte(answers), true)
	if err != nil {
		t.Fatal(err)
	}
	exe := newFakeExec()
	env := &testEnv{t: t, hw: hardwareFor(m), repo: repo, resticB: bin, target: t.TempDir(), exec: exe,
		iso: &fakeIsolator{exec: exe, reply: func(IsolateSpec) string { return "kernel/drivers/nvme/host/nvme.ko\n" }}, ops: &fakeOps{exec: exe, mounted: map[string]bool{}}}
	var out bytes.Buffer
	ui := &UI{In: strings.NewReader(""), Out: &out, Lang: LangEN}
	r := &Recover{UI: ui, Env: env, Answers: a, Version: "0.5.0", Log: &LogBuffer{}, Poll: 20 * time.Millisecond}
	res, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v\n%s\n%s", err, out.String(), exe.lines())
	}
	f.mu.Lock()
	fin := f.finish
	logLines := strings.Join(f.logLines, "\n")
	rebind := f.rebind
	f.mu.Unlock()
	if fin == nil || fin.Status != api.RecoverySucceeded {
		t.Fatalf("finish %+v\nresult %+v\n%s", fin, res, out.String())
	}
	var v api.RecoveryVerification
	if err := json.Unmarshal(fin.Verification, &v); err != nil || v.Format != api.RecoveryVerificationFormat || len(v.Checks) != 10 {
		t.Fatalf("verification %s: %v", fin.Verification, err)
	}
	if v.Result == api.VerifyFailed {
		t.Errorf("verification failed: %s", fin.Verification)
	}
	if testing.Verbose() {
		t.Logf("verification %s\nwarnings %+v\nconsole:\n%s", fin.Verification, fin.Warnings, out.String())
	}
	assertKnownCodes(t, fin.Warnings)
	// The restore really happened, the fixups ran on the restored files.
	if b, err := os.ReadFile(filepath.Join(env.target, "home/alice/notes.txt")); err != nil || string(b) != "hello\n" {
		t.Errorf("restored file: %q %v", b, err)
	}
	fstab, _ := os.ReadFile(filepath.Join(env.target, "etc/fstab"))
	if strings.Contains(string(fstab), "/dev/nvme0n1p2") {
		t.Errorf("fstab not fixed:\n%s", fstab)
	}
	if _, err := os.Stat(filepath.Join(env.target, MarkerPath)); err == nil {
		t.Error("the marker is still there")
	}
	// No secret anywhere: calls, console, session log.
	everything := exe.lines() + out.String() + logLines + string(fin.Verification)
	for _, secret := range []string{testPassphrase, "repo-password-for-recovery-0123", testCode, FormatCode(testCode)} {
		if strings.Contains(everything, secret) {
			t.Errorf("a secret leaked: %s", secret)
		}
	}
	// Reconnected, the agent's state is in the target.
	if rebind == nil || rebind.Hostname != "srv01" {
		t.Errorf("rebind %+v", rebind)
	}
	st, err := os.Stat(filepath.Join(env.target, "etc/restow-agent/state.json"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("state.json: %v", err)
	}
	if !strings.Contains(strings.Join(env.actions, ","), "poweroff") {
		t.Errorf("after success: %v", env.actions)
	}
	if !strings.Contains(out.String(), "RESTOW-RECOVER-RESULT succeeded") {
		t.Error("no result line")
	}
	if !strings.Contains(exe.lines(), "luksFormat") || !strings.Contains(exe.lines(), "<stdin:") {
		t.Error("the plan did not run")
	}
}

func TestRecoverPlanOnly(t *testing.T) {
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY")
	}
	raw, _ := os.ReadFile("../baremetal/testdata/manifests/debian12-uefi-luks-lvm.json")
	m, _ := baremetal.Decode(raw)
	repo, snap := snapshotOf(t, bin, raw)
	f := newFakeRecovery(t, "", testCode)
	f.status = api.RecoveryActive
	f.snapshotID, f.layoutSHA = snap, sha256Hex(string(raw))
	answers := fmt.Sprintf(`{"format":"restow-answers-v1","instanceUrl":%q,"code":%q,"diskMapping":"auto","confirmErase":[]}`, f.srv.URL, FormatCode(testCode))
	a, err := LoadAnswers(SourceFWCfg, []byte(answers), true)
	if err != nil {
		t.Fatal(err)
	}
	exe := newFakeExec()
	env := &testEnv{t: t, hw: hardwareFor(m), repo: repo, resticB: bin, target: t.TempDir(), exec: exe, iso: &fakeIsolator{}, ops: &fakeOps{exec: exe}}
	var out, plan bytes.Buffer
	r := &Recover{UI: &UI{In: strings.NewReader(""), Out: &out, Lang: LangEN}, Env: env, Answers: a, Version: "0.5.0", Log: &LogBuffer{}, PlanOnly: true, PlanOut: &plan}
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	var p baremetal.RestorePlan
	if err := json.Unmarshal(plan.Bytes(), &p); err != nil || p.Format != baremetal.PlanFormat || len(p.Steps) == 0 {
		t.Fatalf("plan output: %v\n%s", err, plan.String())
	}
	if strings.TrimSpace(exe.lines()) != "" {
		t.Errorf("--plan-only ran commands:\n%s", exe.lines())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.finish == nil || f.finish.Status != api.RecoveryCancelled {
		t.Errorf("finish %+v", f.finish)
	}
}

func TestRecoverConfirmMismatchErasesNothing(t *testing.T) {
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY")
	}
	raw, _ := os.ReadFile("../baremetal/testdata/manifests/debian12-uefi-luks-lvm.json")
	m, _ := baremetal.Decode(raw)
	repo, snap := snapshotOf(t, bin, raw)
	f := newFakeRecovery(t, "", testCode)
	f.status = api.RecoveryActive
	f.snapshotID, f.layoutSHA = snap, sha256Hex(string(raw))
	answers := fmt.Sprintf(`{"format":"restow-answers-v1","instanceUrl":%q,"code":%q,"diskMapping":"auto","passphrase":"x-y-z","confirmErase":["serial.some-other-disk"]}`, f.srv.URL, FormatCode(testCode))
	a, _ := LoadAnswers(SourceFWCfg, []byte(answers), true)
	exe := newFakeExec()
	env := &testEnv{t: t, hw: hardwareFor(m), repo: repo, resticB: bin, target: t.TempDir(), exec: exe, iso: &fakeIsolator{}, ops: &fakeOps{exec: exe}}
	var out bytes.Buffer
	r := &Recover{UI: &UI{In: strings.NewReader(""), Out: &out, Lang: LangEN}, Env: env, Answers: a, Version: "0.5.0", Log: &LogBuffer{}}
	res, _ := r.Run(context.Background())
	if res == nil || res.Status != api.RecoveryCancelled {
		t.Errorf("status %+v", res)
	}
	if strings.Contains(exe.lines(), "wipefs") || strings.Contains(exe.lines(), "sfdisk") {
		t.Error("a disk was erased without a matching confirmErase")
	}
}
