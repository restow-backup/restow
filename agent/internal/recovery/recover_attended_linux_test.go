//go:build linux

package recovery

// The attended flow of recover (docs/BAREMETAL.md 10.2 to 10.20, 21.1:
// "recovery/ui.go mit Skript auf stdin"): what the operator sees after
// the code dialog of the web interface, driven by a script on stdin
// against a TLS test instance whose key is confirmed with the typed check
// value. Confirmation, abort, resume, check value and approval.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// newFakeRecoveryTLS is the fake instance behind HTTPS (the attended flow
// accepts no http:// address).
func newFakeRecoveryTLS(t *testing.T, code string) *fakeRecovery {
	t.Helper()
	f := &fakeRecovery{t: t, sessionID: "5b1f0c2e-8f7a-4d7e-9a43-1c2d3e4f5a6b", status: api.RecoveryPendingApproval}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	origin, err := CanonicalOrigin(f.srv.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	f.codeHash = HashCodeProof(CodeProof(origin, code))
	return f
}

// spkiOf is the check value the web interface shows for the test
// instance's key.
func spkiOf(t *testing.T, f *fakeRecovery) string {
	t.Helper()
	c, err := SPKICheck(SPKISHA256(f.srv.Certificate()))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// attended is one attended run: the script is typed line by line; the
// after lines are typed once recover asks about the reconnection (after
// the execution, so its cancel watcher cannot take them): the answer to
// that question, then the after-success menu.
type attended struct {
	t       *testing.T
	f       *fakeRecovery
	env     *testEnv
	exe     *fakeExec
	out     syncBuffer
	raw     []byte
	approve bool
	res     *Result
	err     error
}

func newAttended(t *testing.T) *attended {
	t.Helper()
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY to run the attended recovery flow with restic")
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
	f := newFakeRecoveryTLS(t, testCode)
	f.snapshotID, f.layoutSHA = snap, sha256Hex(string(raw))
	exe := newFakeExec()
	env := &testEnv{t: t, hw: hardwareFor(m), repo: repo, resticB: bin, target: t.TempDir(), exec: exe, realTLS: true,
		iso: &fakeIsolator{exec: exe, reply: func(IsolateSpec) string { return "kernel/drivers/nvme/host/nvme.ko\n" }}, ops: &fakeOps{exec: exe, mounted: map[string]bool{}}}
	return &attended{t: t, f: f, env: env, exe: exe, raw: raw, approve: true}
}

// syncBuffer is the console: written by the UI, watched for the
// reconnection question, read by the test.
type syncBuffer struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	trigger string
	fire    func()
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n, err := b.buf.Write(p)
	if b.fire != nil && strings.Contains(b.buf.String(), b.trigger) {
		go b.fire()
		b.fire = nil
	}
	return n, err
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// run types script (one line each) and, at the reconnection question,
// after.
func (a *attended) run(script []string, after ...string) {
	a.t.Helper()
	pr, pw := io.Pipe()
	a.t.Cleanup(func() { pw.Close() })
	go func() {
		for _, l := range script {
			if _, err := io.WriteString(pw, l+"\n"); err != nil {
				return
			}
		}
	}()
	a.out.mu.Lock()
	a.out.trigger = T(LangEN, "rebind.ask")
	a.out.fire = func() {
		for _, l := range after {
			if _, err := io.WriteString(pw, l+"\n"); err != nil {
				return
			}
		}
	}
	a.out.mu.Unlock()
	if a.approve {
		go func() {
			// The administrator approves in the web interface a moment
			// after the exchange.
			for i := 0; i < 500; i++ {
				time.Sleep(20 * time.Millisecond)
				a.f.mu.Lock()
				if a.f.secretSHA != "" {
					time.Sleep(60 * time.Millisecond)
					a.f.status = api.RecoveryActive
					a.f.mu.Unlock()
					return
				}
				a.f.mu.Unlock()
			}
		}()
	}
	r := &Recover{UI: &UI{In: pr, Out: &a.out, Lang: LangEN}, Env: a.env, Version: "0.5.0", Log: &LogBuffer{}, Poll: 20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	// A prompt the script does not answer ends the input (the dialog
	// aborts) instead of hanging the test.
	watchdog := time.AfterFunc(2*time.Minute, func() { pw.CloseWithError(io.EOF) })
	defer watchdog.Stop()
	a.res, a.err = r.Run(ctx)
	pw.Close()
}

func (a *attended) finish() *api.RecoveryFinish {
	a.f.mu.Lock()
	defer a.f.mu.Unlock()
	return a.f.finish
}

func (a *attended) seen() []string {
	a.f.mu.Lock()
	defer a.f.mu.Unlock()
	return append([]string(nil), a.f.seen...)
}

// The lines of the attended dialog up to the plan, in order: keyboard
// (default us), language (default English), network (DHCP), no proxy,
// the address, the trust mode (default: check value), the check value,
// the code. After the plan: no command list, a typed passphrase twice,
// (this plan asks nothing about the fallback boot path).
func (a *attended) upToCode(check string) []string {
	return []string{"", "", "", "", a.f.srv.URL, "", check, FormatCode(testCode)}
}

var passLines = []string{"", "", testPassphrase, testPassphrase}

// TestRecoverFullFlowAttended: the whole attended run with an approval
// that comes after the exchange; the restore really happens, no secret is
// shown or sent, and the after-success menu powers off.
func TestRecoverFullFlowAttended(t *testing.T) {
	a := newAttended(t)
	script := append(a.upToCode(spkiOf(t, a.f)), passLines...)
	script = append(script, "ERASE")
	a.run(script, "", "2")
	if a.err != nil {
		t.Fatalf("run: %v\n%s\n%s", a.err, a.out.String(), a.exe.lines())
	}
	fin := a.finish()
	if fin == nil || fin.Status != api.RecoverySucceeded {
		t.Fatalf("finish %+v\n%s", fin, a.out.String())
	}
	if b, err := os.ReadFile(filepath.Join(a.env.target, "home/alice/notes.txt")); err != nil || string(b) != "hello\n" {
		t.Errorf("restored file: %q %v", b, err)
	}
	// The approval came after the exchange: recover waited (polled the
	// session) and fetched the credentials only then.
	seen := strings.Join(a.seen(), "\n")
	if !strings.Contains(a.out.String(), T(LangEN, "approval.waiting")) || !strings.Contains(a.out.String(), T(LangEN, "approval.granted")) {
		t.Errorf("no approval wait:\n%s", a.out.String())
	}
	if i, j := strings.Index(seen, "GET "+CurrentPath+"\n"), strings.Index(seen, "GET "+CurrentPath+"/credentials"); i < 0 || j < i {
		t.Errorf("credentials before the approval poll:\n%s", seen)
	}
	everything := a.exe.lines() + a.out.String() + strings.Join(a.f.logLines, "\n")
	for _, secret := range []string{testPassphrase, "repo-password-for-recovery-0123", testCode, FormatCode(testCode)} {
		if strings.Contains(everything, secret) {
			t.Errorf("a secret leaked: %s", secret)
		}
	}
	if !strings.Contains(a.exe.lines(), "luksFormat") || !strings.Contains(a.exe.lines(), "wipefs") {
		t.Errorf("the plan did not run:\n%s", a.exe.lines())
	}
	if !strings.Contains(strings.Join(a.env.actions, ","), "poweroff") {
		t.Errorf("after success: %v", a.env.actions)
	}
	if !strings.Contains(a.out.String(), "RESTOW-RECOVER-RESULT succeeded") {
		t.Error("no result line")
	}
}

// TestRecoverAttendedWrongEraseWord: another word than the erase word
// cancels; nothing is erased.
func TestRecoverAttendedWrongEraseWord(t *testing.T) {
	a := newAttended(t)
	script := append(a.upToCode(spkiOf(t, a.f)), passLines...)
	script = append(script, "erase")
	a.run(script)
	if a.res == nil || a.res.Status != api.RecoveryCancelled {
		t.Fatalf("status %+v %v\n%s", a.res, a.err, a.out.String())
	}
	for _, never := range []string{"wipefs", "sfdisk", "luksFormat", "mkfs.", "restic restore"} {
		if strings.Contains(a.exe.lines(), never) {
			t.Errorf("%s ran without the erase word", never)
		}
	}
	if fin := a.finish(); fin == nil || fin.Status != api.RecoveryCancelled {
		t.Errorf("finish %+v", fin)
	}
}

// TestRecoverAttendedSPKIMismatch: a check value that does not match the
// key sends nothing to the instance, not even the code.
func TestRecoverAttendedSPKIMismatch(t *testing.T) {
	a := newAttended(t)
	a.approve = false
	a.run(a.upToCode("AAAA-BBBB-CCCC-DDDD"))
	if ProblemCode(a.err) != ProblemSPKIMismatch {
		t.Fatalf("err %v\n%s", a.err, a.out.String())
	}
	if s := a.seen(); len(s) != 0 {
		t.Errorf("sent to the instance after a wrong check value: %v", s)
	}
	if strings.TrimSpace(a.exe.lines()) != "" {
		t.Errorf("commands ran:\n%s", a.exe.lines())
	}
}

// TestRecoverAttendedResume: the target disk carries the disk GUID of the
// manifest and the marker of a started run of this snapshot; the operator
// takes the offer, and the run continues without erasing anything.
func TestRecoverAttendedResume(t *testing.T) {
	a := newAttended(t)
	m, _ := baremetal.Decode(a.raw)
	a.env.hw.Blocks[0].Signatures = []baremetal.TargetSignature{{Kind: "disk_guid", UUID: m.Linux.Disks[0].Table.ID}}
	root, err := OpenRootfs(a.env.target)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteMarker(chownless{root}, Marker{SnapshotID: a.f.snapshotID, LayoutSHA256: a.f.layoutSHA, PlanSHA256: strings.Repeat("9b", 32), CleanStop: true}); err != nil {
		t.Fatal(err)
	}
	// After the code: the resume offer (default yes), then the plan and the
	// passphrase of the first run; no erase word.
	script := append(a.upToCode(spkiOf(t, a.f)), "")
	script = append(script, passLines...)
	a.run(script, "", "3")
	if a.err != nil {
		t.Fatalf("run: %v\n%s\n%s", a.err, a.out.String(), a.exe.lines())
	}
	offer := T(LangEN, "resume.offer", "id", "?", "step", "?")
	if !strings.Contains(a.out.String(), offer) || strings.Contains(a.out.String(), T(LangEN, "ui.confirm_erase", "word", "ERASE")) {
		t.Errorf("no resume offer, or an erase confirmation:\n%s", a.out.String())
	}
	lines := a.exe.lines()
	for _, never := range []string{"wipefs", "sfdisk", "luksFormat", "pvcreate", "mkfs."} {
		if strings.Contains(lines, never) {
			t.Errorf("%s in a resumed run", never)
		}
	}
	// The existing volume is opened with the passphrase of the first run.
	if !strings.Contains(lines, "cryptsetup open --key-file - /dev/nvme0n1p3 nvme0n1p3_crypt") {
		t.Errorf("the volume of the first run was not opened:\n%s", lines)
	}
	if fin := a.finish(); fin == nil || fin.Status != api.RecoverySucceeded {
		t.Fatalf("finish %+v\n%s", fin, a.out.String())
	}
	if !strings.Contains(strings.Join(a.env.actions, ","), "shell") {
		t.Errorf("after success (shell): %v", a.env.actions)
	}
}
