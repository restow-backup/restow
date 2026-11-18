//go:build linux

package recovery

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

const oneshotNetworkJSON = `{"interfaces":[{"name":"eth0","mac":"52:54:00:12:34:56","driver":"virtio_net","mtu":1500,"dhcp4":false,"slaac":false,
  "addresses":[{"address":"203.0.113.7","prefix":32,"dynamic":false},{"address":"2001:db8:1::7","prefix":64,"dynamic":false}]}],
  "routes":[{"family":"inet","gateway":"172.31.1.1","dev":"eth0","onlink":true,"metric":0},{"family":"inet6","gateway":"fe80::1","dev":"eth0","onlink":false,"metric":0}],
  "dns":["185.12.64.1"],"searchDomains":[]}`

// oneshotRun is a oneshot restore in the recovery environment against the
// fake instance and the real restic.
type oneshotRun struct {
	f   *fakeRecovery
	env *testEnv
	exe *fakeExec
	out bytes.Buffer
	res *Result
	err error
}

func newOneshotRun(t *testing.T, edit func(f *fakeRecovery, d *OneshotData)) *oneshotRun {
	t.Helper()
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		t.Skip("set RESTIC_BINARY to run the oneshot flow with restic")
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
	secret, sha, _ := NewSessionSecret()
	f.secretSHA, f.status = sha, api.RecoveryActive
	key, _ := ParseAuthorizedKey(testKeyLineFor(7))
	f.oneshot = &api.OneshotCurrent{Decided: &api.OneshotDecided{NetworkMode: "takeover", RemoteAccess: true}, SSHKeys: []string{key.Fingerprint()}}
	d := &OneshotData{Format: OneshotFormat, InstanceURL: f.srv.URL, Language: LangEN, ConfirmErase: []string{"serial.restow-e2e-target0"},
		Passphrase: testPassphrase, SSHKeys: []string{key.Line()}, Network: json.RawMessage(oneshotNetworkJSON)}
	d.Session.ID, d.Session.Secret = f.sessionID, secret
	if edit != nil {
		edit(f, d)
	}
	// What the command wrote is what recover reads.
	b, _ := json.Marshal(d)
	loaded, err := LoadOneshotData(b, true)
	if err != nil {
		t.Fatal(err)
	}
	exe := newFakeExec()
	run := &oneshotRun{f: f, exe: exe, env: &testEnv{t: t, hw: hardwareFor(m), repo: repo, resticB: bin, target: t.TempDir(), exec: exe,
		iso: &fakeIsolator{exec: exe, reply: initramfsListing}, ops: &fakeOps{exec: exe, mounted: map[string]bool{}}}}
	r := &Recover{UI: &UI{In: strings.NewReader(""), Out: &run.out, Lang: LangEN}, Env: run.env, Answers: loaded.Answers(), Oneshot: loaded,
		Version: "0.5.1", Log: &LogBuffer{}, Poll: 20 * time.Millisecond, Countdown: 10 * time.Millisecond, RebootWait: 10 * time.Millisecond}
	run.res, run.err = r.Run(context.Background())
	return run
}

// testKeyLineFor is an ed25519 public key line with all key bytes b.
func testKeyLineFor(b byte) string {
	blob := []byte{0, 0, 0, 11}
	blob = append(blob, "ssh-ed25519"...)
	blob = append(blob, 0, 0, 0, 32)
	blob = append(blob, bytes.Repeat([]byte{b}, 32)...)
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob) + " admin@example"
}

func (o *oneshotRun) actions() string {
	o.env.mu.Lock()
	defer o.env.mu.Unlock()
	return strings.Join(o.env.actions, ",")
}

func (o *oneshotRun) seenIndex(call string) int {
	for i, s := range o.f.seen {
		if strings.HasSuffix(s, call) {
			return i
		}
	}
	return -1
}

func TestOneshotRecoverRestoresAndRestarts(t *testing.T) {
	o := newOneshotRun(t, nil)
	if o.err != nil {
		t.Fatalf("run: %v\n%s\n%s", o.err, o.out.String(), o.exe.lines())
	}
	o.f.mu.Lock()
	defer o.f.mu.Unlock()
	if o.f.finish == nil || o.f.finish.Status != api.RecoverySucceeded {
		t.Fatalf("finish %+v\n%s", o.f.finish, o.out.String())
	}
	// It reported back before it asked for the credentials, with the hardware found here.
	booted, creds := o.seenIndex("/oneshot/booted"), o.seenIndex("/credentials")
	if booted < 0 || creds < booted || len(o.f.booted) != 1 || len(o.f.booted[0].Disks) != 1 {
		t.Errorf("booted at %d, credentials at %d, reports %+v", booted, creds, o.f.booted)
	}
	// No exchange: the session came with the data.
	if o.seenIndex(SessionsPath) >= 0 && strings.HasSuffix(o.f.seen[o.seenIndex(SessionsPath)], SessionsPath) {
		t.Error("recover exchanged a code")
	}
	acts := o.actions()
	for _, want := range []string{"network files 1", "remote keys 1", "forget oneshot", "reboot"} {
		if !strings.Contains(acts, want) {
			t.Errorf("actions %s lack %q", acts, want)
		}
	}
	if len(o.env.netFiles) != 1 || !strings.Contains(o.env.netFiles[0].Content, "MACAddress=52:54:00:12:34:56") ||
		!strings.Contains(o.env.netFiles[0].Content, "GatewayOnLink=yes") {
		t.Errorf("network files %+v", o.env.netFiles)
	}
	if !strings.Contains(o.exe.lines(), "luksFormat") {
		t.Error("the plan did not run")
	}
	var phases []string
	for _, p := range o.f.progress {
		phases = append(phases, p.Phase)
	}
	if !strings.Contains(strings.Join(phases, ","), "booted,connected") {
		t.Errorf("phases %v", phases)
	}
	if strings.Contains(o.out.String(), testPassphrase) {
		t.Error("the passphrase is on the console")
	}
}

func TestOneshotRecoverRefusals(t *testing.T) {
	t.Run("other hardware ends the session, nothing is erased, the old system starts again", func(t *testing.T) {
		o := newOneshotRun(t, func(f *fakeRecovery, d *OneshotData) { f.bootedProblem = ProblemSessionEnded })
		if o.f.credsCalls != 0 || strings.Contains(o.exe.lines(), "luksFormat") || strings.Contains(o.exe.lines(), "wipefs") {
			t.Fatalf("credentials %d, calls:\n%s", o.f.credsCalls, o.exe.lines())
		}
		if !strings.Contains(o.out.String(), T(LangEN, "oneshot.session_ended")) || !strings.Contains(o.actions(), "reboot") {
			t.Errorf("actions %s\n%s", o.actions(), o.out.String())
		}
	})
	t.Run("a released session without decisions", func(t *testing.T) {
		o := newOneshotRun(t, func(f *fakeRecovery, d *OneshotData) { f.oneshot.Decided = nil })
		if o.f.credsCalls != 0 || strings.Contains(o.exe.lines(), "luksFormat") {
			t.Fatalf("credentials %d", o.f.credsCalls)
		}
	})
	t.Run("a disk the plan erases that the console did not confirm", func(t *testing.T) {
		o := newOneshotRun(t, func(f *fakeRecovery, d *OneshotData) { d.ConfirmErase = []string{"serial.some-other-disk"} })
		if strings.Contains(o.exe.lines(), "luksFormat") || strings.Contains(o.exe.lines(), "sfdisk") {
			t.Fatalf("a disk was erased:\n%s", o.exe.lines())
		}
		if !strings.Contains(o.out.String(), "serial.restow-e2e-target0") || !strings.Contains(o.actions(), "reboot") {
			t.Errorf("actions %s\n%s", o.actions(), o.out.String())
		}
	})
	t.Run("keys that were not shown with the release", func(t *testing.T) {
		o := newOneshotRun(t, func(f *fakeRecovery, d *OneshotData) {
			other, _ := ParseAuthorizedKey(testKeyLineFor(9))
			d.SSHKeys = append(d.SSHKeys, other.Line())
		})
		if strings.Contains(o.actions(), "remote keys") || !strings.Contains(o.out.String(), T(LangEN, "oneshot.keys_mismatch")) {
			t.Errorf("actions %s", o.actions())
		}
		if o.f.finish == nil || o.f.finish.Status != api.RecoverySucceeded {
			t.Errorf("the restore itself goes on: %+v", o.f.finish)
		}
	})
	t.Run("no remote access without the release's word", func(t *testing.T) {
		o := newOneshotRun(t, func(f *fakeRecovery, d *OneshotData) { f.oneshot.Decided.RemoteAccess = false })
		if strings.Contains(o.actions(), "remote keys") {
			t.Errorf("actions %s", o.actions())
		}
	})
}

func TestOneshotRecoverEndsWithoutRestartAfterTheFirstWrite(t *testing.T) {
	o := newOneshotRun(t, func(f *fakeRecovery, d *OneshotData) { f.refuseSuccess = "verification_failed" })
	_ = fmt.Sprint(o.res)
	if strings.Contains(o.actions(), "reboot") {
		t.Errorf("a failed restore after the first write restarted: %s", o.actions())
	}
	if !strings.Contains(o.out.String(), T(LangEN, "oneshot.failed_written")) {
		t.Errorf("console:\n%s", o.out.String())
	}
}
