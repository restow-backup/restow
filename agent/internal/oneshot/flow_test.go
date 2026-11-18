package oneshot

import (
	"bytes"
	"errors"
	"net/http"
	"strings"
	"syscall"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/oneshot/payload"
	"github.com/restow-backup/restow/agent/internal/recovery"
)

// confirmInput confirms the one disk of newEnv: the last four characters
// of its identity (serial.QM00001), then the erase word.
const confirmInput = "0001\nERASE\n"

func TestOneshotSwitchesAfterTheRelease(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitOK {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	if env.kexecs != 1 || len(env.loads) != 2 || env.unloads != 1 {
		t.Fatalf("kexec %d, loads %d, unloads %d", env.kexecs, len(env.loads), env.unloads)
	}
	// The test load: the kernel and the ISO's initrd alone.
	test, final := env.loads[0], env.loads[1]
	if !bytes.Equal(test.kernel, testKernel) || !bytes.Equal(test.initrd, testInitrd) {
		t.Errorf("the test load is not the ISO's kernel and initrd (%d, %d bytes)", len(test.kernel), len(test.initrd))
	}
	// The switch: the ISO's initrd, then the archive with the medium and the session data.
	if !bytes.Equal(final.kernel, testKernel) || !bytes.HasPrefix(final.initrd, testInitrd) || !bytes.Contains(final.initrd, testSquash) {
		t.Error("the initrd of the switch does not carry the ISO's initrd and its live file system")
	}
	for _, want := range []string{"boot=live", "live-media=/restow/medium", "restow.oneshot=1", "console=ttyS0,115200n8", "console=tty1", "restow.keymap=us"} {
		if !strings.Contains(final.cmdline, want) {
			t.Errorf("command line %q lacks %q", final.cmdline, want)
		}
	}
	d := sessionData(t, final.initrd)
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if d.Session.ID != "rs_1" || recovery.SessionSecretSHA256(d.Session.Secret) != inst.secretSHA {
		t.Errorf("the session data names another session: %+v", d.Session.ID)
	}
	if strings.Contains(final.cmdline, d.Session.Secret) {
		t.Error("the session secret is on the command line")
	}
	if len(d.ConfirmErase) != 1 || d.ConfirmErase[0] != "serial.QM00001" || d.SPKISHA256 != testSPKI || d.InstanceURL != inst.srv.URL {
		t.Errorf("session data: confirm %v, spki %q, instance %q", d.ConfirmErase, d.SPKISHA256, d.InstanceURL)
	}
	if len(d.SSHKeys) != 1 || !strings.HasPrefix(d.SSHKeys[0], "ssh-ed25519 ") {
		t.Errorf("the keys of root: %v (the line with options must be left out)", d.SSHKeys)
	}
	if len(d.Consoles) != 2 || !strings.Contains(string(d.Network), `"172.31.1.1"`) || !strings.Contains(string(d.Network), `"185.12.64.1"`) {
		t.Errorf("consoles %v, network %s", d.Consoles, d.Network)
	}
	// What the instance saw.
	if inst.credentials != 0 {
		t.Error("the command asked for the credentials")
	}
	if inst.isoDownloads != 1 || inst.exchanges != 1 {
		t.Errorf("iso downloads %d, exchanges %d", inst.isoDownloads, inst.exchanges)
	}
	if got := strings.Join(inst.phases, ","); got != "registered,downloading,waiting_approval,kexec" {
		t.Errorf("phases %s", got)
	}
	if len(inst.checks) != 1 || inst.checks[0].Kexec != api.OneshotKexecOK || inst.checks[0].Mode != api.OneshotModeKexec {
		t.Errorf("checks %+v", inst.checks)
	}
	for _, never := range []string{d.Session.Secret, "serial.QM00001\"", "confirmErase", "passphrase", testCode, "7K3QXM9P2DH4TNV8WRBCJ6FAS"} {
		if bytes.Contains(inst.exchangeBody, []byte(never)) {
			t.Errorf("the exchange carries %q", never)
		}
	}
	tg := inst.exchangeReq.Target
	if tg.Hostname != "debian-4gb-fsn1-1" || len(tg.Interfaces) != 1 || tg.Interfaces[0].Driver != "virtio_net" || !tg.Interfaces[0].DHCP4 ||
		len(tg.Routes) != 2 || !tg.Routes[0].OnLink || tg.Cloud == nil || tg.Cloud.Name != "hetzner" || len(tg.DNS) != 2 {
		t.Errorf("target %+v", tg)
	}
	if len(inst.exchangeReq.SSHKeys) != 1 || !strings.HasPrefix(inst.exchangeReq.SSHKeys[0].Fingerprint, "SHA256:") {
		t.Errorf("ssh keys %+v", inst.exchangeReq.SSHKeys)
	}
	if !hasString(inst.exchangeReq.Checks.Warnings, "ram_low") || inst.exchangeReq.Hardware.Firmware != api.FirmwareBIOS || len(inst.exchangeReq.Hardware.Disks) != 1 {
		t.Errorf("checks %+v, hardware %+v", inst.exchangeReq.Checks, inst.exchangeReq.Hardware)
	}
	if !env.cleaned || !env.iso.closed {
		t.Error("the work files are not cleaned up")
	}
	for _, want := range []string{"Match code:", "web01", "203.0.113.7/32", "172.31.1.1 (on-link)", "/dev/sda", "serial.QM00001", "Test load of the recovery kernel: OK", "connection breaks off"} {
		if !strings.Contains(res.out, want) {
			t.Errorf("the console lacks %q:\n%s", want, res.out)
		}
	}
}

func TestOneshotPassphraseStaysOnTheMachine(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	inst.extras.Needs.Passphrase = true
	res := runCommand(t, env, inst, confirmInput+"pass phrase 1\npass phrase 1\n", nil)
	if res.code != ExitOK {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	d := sessionData(t, env.loads[1].initrd)
	if d.Passphrase != "pass phrase 1" {
		t.Errorf("passphrase %q", d.Passphrase)
	}
	if strings.Contains(res.out, "pass phrase") || bytes.Contains(inst.exchangeBody, []byte("pass phrase")) || strings.Contains(env.loads[1].cmdline, "pass") {
		t.Error("the passphrase left the session data")
	}
}

func TestOneshotUnattendedAnswers(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	inst.extras.Needs.Passphrase = true
	res := runCommand(t, env, inst, "", func(o *Options) {
		o.Answers = &Answers{Format: AnswersFormat, ConfirmErase: []string{"serial.QM00001"}, Passphrase: "secret words"}
		o.Keymap = "de"
	})
	if res.code != ExitOK {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	if d := sessionData(t, env.loads[1].initrd); d.Passphrase != "secret words" || d.ConfirmErase[0] != "serial.QM00001" {
		t.Errorf("session data %+v", d.ConfirmErase)
	}
	if !strings.Contains(env.loads[1].cmdline, "restow.keymap=de") {
		t.Errorf("cmdline %q", env.loads[1].cmdline)
	}
}

// noSwitch checks that the machine was not switched: no load of the
// recovery environment beyond the test load, no kexec.
func noSwitch(t *testing.T, env *fakeEnv, maxLoads int) {
	t.Helper()
	if env.kexecs != 0 || len(env.loads) > maxLoads {
		t.Errorf("the machine switched: kexec %d, loads %d", env.kexecs, len(env.loads))
	}
	if !env.cleaned {
		t.Error("the work files are not cleaned up")
	}
}

// Refused before the exchange: the code stays unused.
func TestOneshotRefusesBeforeTheExchange(t *testing.T) {
	cases := map[string]struct {
		edit func(*fakeEnv)
		opts func(*Options)
		want string
		code int
	}{
		"enrolled agent":      {edit: func(e *fakeEnv) { e.files["/etc/restow-agent/state.json"] = "{}" }, want: "this is not a fresh machine", code: ExitRefused},
		"enrolled pve helper": {edit: func(e *fakeEnv) { e.files["/etc/restow-pve/state.json"] = "{}" }, want: "this is not a fresh machine", code: ExitRefused},
		"too little memory": {edit: func(e *fakeEnv) {
			e.files["/proc/meminfo"] = "MemTotal: 1900000 kB\nMemAvailable: 1000000 kB\n"
		}, want: "at least 2 GiB", code: ExitRefused},
		"kexec disabled": {edit: func(e *fakeEnv) { e.files["/proc/sys/kernel/kexec_load_disabled"] = "1\n" }, want: "kexec_load_disabled", code: ExitRefused},
		"xen pv": {edit: func(e *fakeEnv) {
			e.files["/sys/hypervisor/type"] = "xen"
			e.files["/sys/hypervisor/guest_type"] = "PV"
		}, want: "Xen PV", code: ExitRefused},
		"vlan": {edit: func(e *fakeEnv) {
			e.outputs["ip -j -d addr show"] = strings.Replace(addrJSON, `"link_type":"ether",`, `"link_type":"ether","linkinfo":{"info_kind":"vlan"},`, 1)
		}, want: "vlan interface", code: ExitRefused},
		"policy routing": {edit: func(e *fakeEnv) {
			e.outputs["ip -j -4 rule show"] = `[{"priority":0,"table":"local"},{"priority":100,"table":"42"},{"priority":32766,"table":"main"}]`
		}, want: "table 42", code: ExitRefused},
		"no disk":       {edit: func(e *fakeEnv) { e.hw.Blocks = nil }, want: "no disk", code: ExitRefused},
		"lsblk missing": {edit: func(e *fakeEnv) { e.missing["lsblk"] = true }, want: "lsblk is missing", code: ExitRefused},
		"no code":       {opts: func(o *Options) { o.Code = "RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS" }, want: "not a oneshot code", code: ExitUsage},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
			if tc.edit != nil {
				tc.edit(env)
			}
			res := runCommand(t, env, inst, confirmInput, tc.opts)
			if res.code != tc.code || !strings.Contains(res.out, tc.want) {
				t.Fatalf("exit %d, want %d and %q:\n%s", res.code, tc.code, tc.want, res.out)
			}
			if inst.exchanges != 0 {
				t.Error("the code was redeemed")
			}
			noSwitch(t, env, 0)
		})
	}
}

// Refused after the exchange, before the test load: the ISO.
func TestOneshotRefusesAnUncheckedISO(t *testing.T) {
	iso := testISO(nil)
	cases := map[string]struct {
		edit      func(*fakeInstance)
		opts      func(*Options)
		want      string
		downloads int
	}{
		"other signing key": {edit: func(f *fakeInstance) { f.rel.sig = newRelease(t, iso).sig }, want: "signature"},
		"changed list": {edit: func(f *fakeInstance) {
			f.rel.sums = append([]byte(nil), f.rel.sums...)
			f.rel.sums[0] ^= 1
		}, want: "signature"},
		"no signature": {edit: func(f *fakeInstance) { f.rel.sig = nil }, want: "signature"},
		"no key":       {opts: func(o *Options) { o.Trust.Key = nil }, want: "no release key"},
		"trusted list with another hash": {opts: func(o *Options) {
			o.Trust = ISOTrust{TrustedSumsSHA256: strings.Repeat("0", 64), AgentVersion: testVersion}
		}, want: "RESTOW_SHA256SUMS_SHA256"},
		"other release":        {opts: func(o *Options) { o.Trust.AgentVersion = "0.5.2" }, want: "this command is 0.5.2"},
		"announced other hash": {edit: func(f *fakeInstance) { f.extras.ISO.SHA256 = strings.Repeat("1", 64) }, want: "the signed list says"},
		"not an iso name":      {edit: func(f *fakeInstance) { f.extras.ISO.FileName = "../../etc/passwd" }, want: "not the name of a recovery ISO"},
		"name of other version": {edit: func(f *fakeInstance) {
			f.extras.ISO.Version = "0.5.2"
		}, opts: func(o *Options) { o.Trust.AgentVersion = "0.5.2-dev" }, want: "no ISO of release 0.5.2"},
		"image changed": {edit: func(f *fakeInstance) {
			f.served = append([]byte(nil), iso...)
			f.served[len(f.served)-1] ^= 1
		}, want: "the image has SHA-256", downloads: 1},
		"image too long": {edit: func(f *fakeInstance) { f.served = append(append([]byte(nil), iso...), 0) }, want: "more than", downloads: 1},
		"no iso here":    {edit: func(f *fakeInstance) { f.extras.ISO = nil }, want: "no checked copy"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			env, inst := newEnv(), newInstance(t, newRelease(t, iso))
			if tc.edit != nil {
				tc.edit(inst)
			}
			res := runCommand(t, env, inst, confirmInput, tc.opts)
			if res.code != ExitRefused || !strings.Contains(res.out, tc.want) {
				t.Fatalf("exit %d, want %q:\n%s", res.code, tc.want, res.out)
			}
			if inst.isoDownloads != tc.downloads {
				t.Errorf("image downloaded %d times, want %d", inst.isoDownloads, tc.downloads)
			}
			noSwitch(t, env, 0)
			if inst.credentials != 0 || len(inst.checks) != 0 {
				t.Errorf("credentials %d, checks %d", inst.credentials, len(inst.checks))
			}
		})
	}
}

func TestOneshotRefusesAnISOWhoseOwnListDisagrees(t *testing.T) {
	// Signed correctly, but the live files do not match live-build's list
	// inside the image: a mistake of the reader or a broken build.
	bad := testISO(func(f map[string][]byte) { f[payload.SquashfsPath] = bytes.Repeat([]byte("X"), 9000) })
	env, inst := newEnv(), newInstance(t, newRelease(t, bad))
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitRefused || !strings.Contains(res.out, "filesystem.squashfs has SHA-256") {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	noSwitch(t, env, 0)
}

func TestOneshotAcceptsTheListTheAdminChecked(t *testing.T) {
	rel := newRelease(t, testISO(nil))
	env, inst := newEnv(), newInstance(t, rel)
	inst.rel.sig = nil
	res := runCommand(t, env, inst, confirmInput, func(o *Options) {
		o.Trust = ISOTrust{TrustedSumsSHA256: sumHex(rel.sums), AgentVersion: testVersion}
	})
	if res.code != ExitOK {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
}

func TestOneshotTestLoadRefused(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	env.loadErrs = []error{errors.New("kexec_file_load: " + syscall.Errno(129).Error())}
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitRefused || !strings.Contains(res.out, "refuses to load the recovery kernel") {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	noSwitch(t, env, 1)
	if len(inst.checks) != 1 || inst.checks[0].Kexec != api.OneshotKexecFailed || !strings.Contains(inst.checks[0].KexecError, "kexec_file_load") {
		t.Errorf("checks %+v", inst.checks)
	}
	if strings.Contains(res.out, "ERASE") || inst.currentCalls != 0 {
		t.Error("the command asked to confirm or waited for the release after a failed test load")
	}
}

func TestOneshotEndsWithoutTheRelease(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state api.RecoverySessionState
		want  string
	}{
		{"rejected", api.RecoverySessionState{Status: "rejected"}, "(rejected)"},
		{"expired", api.RecoverySessionState{Status: "expired"}, "(expired)"},
		{"cancelled", api.RecoverySessionState{Status: api.RecoveryPendingApproval, CancelRequested: true}, "(cancelled)"},
		{"released without decisions", api.RecoverySessionState{Status: api.RecoveryActive}, "without the decisions"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
			inst.states = []api.RecoverySessionState{{Status: api.RecoveryPendingApproval}, tc.state}
			res := runCommand(t, env, inst, confirmInput, nil)
			if res.code == ExitOK || !strings.Contains(res.out, tc.want) {
				t.Fatalf("exit %d:\n%s", res.code, res.out)
			}
			noSwitch(t, env, 1)
			if inst.credentials != 0 {
				t.Error("credentials asked")
			}
		})
	}
}

func TestOneshotNotConfirmed(t *testing.T) {
	for name, input := range map[string]string{
		"wrong tail":       "abcd\nabcd\nabcd\n",
		"wrong erase word": "0001\nyes\n",
		"input ends":       "0001\n",
	} {
		t.Run(name, func(t *testing.T) {
			env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
			res := runCommand(t, env, inst, input, nil)
			if res.code != ExitEnded || !strings.Contains(res.out, "Not confirmed") {
				t.Fatalf("exit %d:\n%s", res.code, res.out)
			}
			noSwitch(t, env, 1)
			if inst.currentCalls != 0 {
				t.Error("the command waited for the release without a confirmation")
			}
		})
	}
}

func TestOneshotAnswersMustNameDisksOfThisMachine(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	res := runCommand(t, env, inst, "", func(o *Options) {
		o.Answers = &Answers{Format: AnswersFormat, ConfirmErase: []string{"serial.OTHER"}}
	})
	if res.code != ExitRefused || !strings.Contains(res.out, "serial.OTHER") {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	noSwitch(t, env, 1)
}

func TestOneshotCodeProblems(t *testing.T) {
	for _, p := range []string{recovery.ProblemCodeUsed, recovery.ProblemCodeExpired, recovery.ProblemCodeRevoked} {
		env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
		inst.problem = p
		res := runCommand(t, env, inst, confirmInput, nil)
		if res.code != ExitEnded {
			t.Errorf("%s: exit %d:\n%s", p, res.code, res.out)
		}
		noSwitch(t, env, 0)
	}
	// A proof for another origin: the instance does not know the code.
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	res := runCommand(t, env, inst, confirmInput, func(o *Options) { o.Code = "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAT" })
	if res.code != ExitEnded || !strings.Contains(res.out, recovery.T(recovery.LangEN, "code.invalid")) {
		t.Errorf("exit %d:\n%s", res.code, res.out)
	}
}

func TestOneshotSwitchFailures(t *testing.T) {
	t.Run("the image changed on the disk", func(t *testing.T) {
		env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
		env.afterTestLoad = func(m *memISO) {
			i := bytes.Index(m.b, testSquash)
			m.b[i] = 'X'
		}
		res := runCommand(t, env, inst, confirmInput, nil)
		if res.code != ExitError || !strings.Contains(res.out, "could not be loaded") {
			t.Fatalf("exit %d:\n%s", res.code, res.out)
		}
		noSwitch(t, env, 1)
	})
	t.Run("the load fails", func(t *testing.T) {
		env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
		env.loadErrs = []error{nil, errors.New("kexec_file_load: cannot allocate memory")}
		res := runCommand(t, env, inst, confirmInput, nil)
		if res.code != ExitError || !strings.Contains(res.out, "cannot allocate memory") {
			t.Fatalf("exit %d:\n%s", res.code, res.out)
		}
		noSwitch(t, env, 2)
	})
	t.Run("nothing loaded", func(t *testing.T) {
		env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
		env.noLoaded = true
		res := runCommand(t, env, inst, confirmInput, nil)
		if res.code != ExitError || env.kexecs != 0 || env.unloads != 2 {
			t.Fatalf("exit %d, kexec %d, unloads %d:\n%s", res.code, env.kexecs, env.unloads, res.out)
		}
	})
	t.Run("the switch fails", func(t *testing.T) {
		env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
		env.kexecErr = errors.New("permission denied")
		res := runCommand(t, env, inst, confirmInput, nil)
		if res.code != ExitError || env.unloads != 2 || !strings.Contains(res.out, "switch into the recovery environment failed") {
			t.Fatalf("exit %d, unloads %d:\n%s", res.code, env.unloads, res.out)
		}
	})
}

func TestOneshotGermanConsole(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	res := runCommand(t, env, inst, "0001\nLÖSCHEN\n", func(o *Options) { o.Lang = recovery.LangDE })
	if res.code != ExitOK || !strings.Contains(res.out, "Prüfzahl") || !strings.Contains(res.out, "wird gelöscht") {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	if d := sessionData(t, env.loads[1].initrd); d.Language != recovery.LangDE {
		t.Errorf("language %q", d.Language)
	}
}

func TestOneshotWarnsOfAMachineInUse(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	env.files["/proc/uptime"] = "200000.0 1.0\n"
	env.dirs["/home"] = []string{"anna", "ben"}
	env.outputs["systemctl is-active "+strings.Join(ServicesOfConcern, " ")] = "inactive\nactive\n"
	env.used = 9e9
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitOK || !strings.Contains(res.out, "WARNING: this machine looks like it is in use") || !strings.Contains(res.out, "database or web services") {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	got := strings.Join(inst.exchangeReq.Checks.InUse, ",")
	if got != "data,services,uptime,users" {
		t.Errorf("in use %s", got)
	}
}

func TestOneshotWaitsOutAShortBreakOfTheNetwork(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	// Two polls without an answer (the connection is cut), then the release.
	breaks := 2
	next := inst.srv.Config.Handler
	inst.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == recovery.CurrentPath && breaks > 0 {
			breaks--
			if hj, ok := w.(http.Hijacker); ok {
				conn, _, _ := hj.Hijack()
				conn.Close()
				return
			}
		}
		next.ServeHTTP(w, r)
	})
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitOK || breaks != 0 {
		t.Fatalf("exit %d, breaks left %d:\n%s", res.code, breaks, res.out)
	}
	// A problem answer is no break: the command stops.
	env, inst = newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	next2 := inst.srv.Config.Handler
	inst.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == recovery.CurrentPath {
			inst.problemJSON(w, http.StatusConflict, recovery.ProblemStateConflict)
			return
		}
		next2.ServeHTTP(w, r)
	})
	res = runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitError {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	noSwitch(t, env, 1)
}

// Up to the point of no return a cancel (Ctrl+C, a hangup, SIGTERM) leaves
// the machine as it was: what was loaded is unloaded, the exit is 4, the
// switch never starts (docs/BAREMETAL-ONESHOT.md 5.3).
func TestOneshotCancelBeforeThePointOfNoReturn(t *testing.T) {
	for _, tc := range []struct {
		step    string
		loads   int
		unloads int
		checks  int
	}{
		{"test-memfd", 0, 0, 0},
		{"test-load", 1, 1, 0},
		{"final-memfd", 1, 2, 1},
		{"final-load", 2, 2, 1},
		{"loaded", 2, 2, 1},
		{"kexec", 2, 2, 1},
	} {
		t.Run(tc.step, func(t *testing.T) {
			env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
			env.cancelOn = tc.step
			res := runCommand(t, env, inst, confirmInput, nil)
			if res.code != ExitEnded || !strings.Contains(res.out, "Aborted. Nothing was changed") {
				t.Fatalf("exit %d:\n%s", res.code, res.out)
			}
			if env.kexecs != 0 || env.loaded || len(env.loads) != tc.loads || env.unloads < tc.unloads || len(inst.checks) != tc.checks {
				t.Errorf("kexec %d, loaded %v, loads %d, unloads %d, checks %d", env.kexecs, env.loaded, len(env.loads), env.unloads, len(inst.checks))
			}
			if strings.Contains(res.out, "connection breaks off") && tc.step != "kexec" {
				t.Error("the switch was announced")
			}
		})
	}
}

func TestOneshotChecksTheKernelAfterItLeftTheDisk(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	env.afterTestLoad = func(m *memISO) {
		i := bytes.Index(m.b, testKernel)
		m.b[i+10] = 'X'
	}
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitError || !strings.Contains(res.out, "/live/vmlinuz changed on the disk") {
		t.Fatalf("exit %d:\n%s", res.code, res.out)
	}
	noSwitch(t, env, 1)
}

func TestOneshotTestLoadChecksWhatItLoads(t *testing.T) {
	// The image is changed right after the check of the download: the test
	// load already reads other bytes, refuses them and loads nothing.
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	env.hookISOFile = func(m *memISO) {
		i := bytes.Index(m.b, testInitrd)
		m.b[i] = 'X'
	}
	res := runCommand(t, env, inst, confirmInput, nil)
	if res.code != ExitRefused || len(env.loads) != 0 || !strings.Contains(res.out, "/live/initrd.img changed on the disk") {
		t.Fatalf("exit %d, loads %d:\n%s", res.code, len(env.loads), res.out)
	}
	if len(inst.checks) != 1 || inst.checks[0].Kexec != api.OneshotKexecFailed {
		t.Errorf("checks %+v", inst.checks)
	}
}

// The direct mode in the provider's rescue system (docs/BAREMETAL-ONESHOT.md
// 17.1): no ISO, no kexec; after the release recover runs here with the
// session data, which is removed afterwards.
func TestOneshotDirectMode(t *testing.T) {
	direct := func(o *Options) { o.Direct, o.ResticBin = true, "/run/restow-oneshot.x/restic" }
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	env.files["/proc/sys/kernel/kexec_load_disabled"] = "1\n" // no matter here
	env.recoverExit = 0
	res := runCommand(t, env, inst, confirmInput, direct)
	if res.code != ExitOK || len(env.recoverRuns) != 1 || !strings.Contains(res.out, "rescue system") {
		t.Fatalf("exit %d, runs %v:\n%s", res.code, env.recoverRuns, res.out)
	}
	if len(env.loads) != 0 || env.kexecs != 0 || inst.isoDownloads != 0 || len(inst.checks) != 0 {
		t.Errorf("loads %d, kexec %d, iso %d, checks %d", len(env.loads), env.kexecs, inst.isoDownloads, len(inst.checks))
	}
	if inst.exchangeReq.Checks.Mode != api.OneshotModeDirect || !inst.exchangeReq.Target.Rescue {
		t.Errorf("checks %+v, rescue %v", inst.exchangeReq.Checks, inst.exchangeReq.Target.Rescue)
	}
	d, err := recovery.LoadOneshotData(env.sessionData, true)
	if err != nil || d.Session.ID != "rs_1" || d.ConfirmErase[0] != "serial.QM00001" {
		t.Fatalf("session data %+v %v", d, err)
	}
	if len(env.removed) != 1 || !strings.Contains(env.recoverRuns[0], "/run/restow-oneshot.x/restic") {
		t.Errorf("removed %v, runs %v", env.removed, env.recoverRuns)
	}
	// recover's exit code is the command's.
	env, inst = newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	env.recoverExit = 4
	if res := runCommand(t, env, inst, confirmInput, direct); res.code != 4 || len(env.removed) != 1 {
		t.Errorf("exit %d, removed %v", res.code, env.removed)
	}
}

func TestOneshotDirectModeRefusals(t *testing.T) {
	direct := func(o *Options) { o.Direct, o.ResticBin = true, "/x/restic" }
	cases := map[string]struct {
		edit func(*fakeEnv)
		opts func(*Options)
		want string
	}{
		"a program missing": {edit: func(e *fakeEnv) { e.missing["sgdisk"] = true }, want: "lacks: sgdisk"},
		"no restic":         {opts: func(o *Options) { o.Direct, o.ResticBin = true, "" }, want: "checked restic"},
		"a mounted partition": {edit: func(e *fakeEnv) {
			e.files["/proc/self/mounts"] = "/dev/sda1 /mnt ext4 rw 0 0\nproc /proc proc rw 0 0\n"
		}, want: "in use (/dev/sda1)"},
		"swap on the disk": {edit: func(e *fakeEnv) {
			e.files["/proc/swaps"] = "Filename Type Size Used Priority\n/dev/sda2 partition 1 0 -2\n"
		}, want: "in use (/dev/sda2)"},
		"a volume group on a partition": {edit: func(e *fakeEnv) {
			e.dirs["/sys/block/sda"] = []string{"sda1", "sda2", "queue"}
			e.dirs["/sys/block/sda/sda2/holders"] = []string{"dm-0"}
		}, want: "in use (/dev/sda2)"},
		"md on the disk": {edit: func(e *fakeEnv) { e.dirs["/sys/block/sda/holders"] = []string{"md0"} }, want: "in use (/dev/sda)"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
			if tc.edit != nil {
				tc.edit(env)
			}
			o := direct
			if tc.opts != nil {
				o = tc.opts
			}
			res := runCommand(t, env, inst, confirmInput, o)
			if res.code != ExitRefused || !strings.Contains(res.out, tc.want) {
				t.Fatalf("exit %d, want %q:\n%s", res.code, tc.want, res.out)
			}
			if inst.exchanges != 0 || len(env.recoverRuns) != 0 || env.sessionData != nil {
				t.Errorf("exchanges %d, runs %v", inst.exchanges, env.recoverRuns)
			}
		})
	}
	// A partition of another disk is no problem; sdb1 is no partition of sda.
	if onDisk("/dev/sdb1", "/dev/sda") || onDisk("/dev/sdab", "/dev/sda") || !onDisk("/dev/nvme0n1p3", "/dev/nvme0n1") || !onDisk("/dev/sda", "/dev/sda") {
		t.Error("onDisk")
	}
}

func TestOneshotDirectModeEndsWithoutTheRelease(t *testing.T) {
	env, inst := newEnv(), newInstance(t, newRelease(t, testISO(nil)))
	inst.states = []api.RecoverySessionState{{Status: "rejected"}}
	res := runCommand(t, env, inst, confirmInput, func(o *Options) { o.Direct, o.ResticBin = true, "/x/restic" })
	if res.code != ExitEnded || len(env.recoverRuns) != 0 || env.sessionData != nil {
		t.Fatalf("exit %d, runs %v:\n%s", res.code, env.recoverRuns, res.out)
	}
}
