package oneshot

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/oneshot/payload"
	"github.com/restow-backup/restow/agent/internal/oneshot/payload/isotest"
	"github.com/restow-backup/restow/agent/internal/recovery"
	"github.com/restow-backup/restow/agent/internal/release"
)

// The fakes of the command's tests: a machine (fakeEnv) and an instance
// (fakeInstance) that speaks the session routes of a oneshot restore.

const (
	testCode    = "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS"
	testVersion = "0.5.1"
	testISOName = "restow-recovery_0.5.1_amd64.iso"
	testSPKI    = "5d1f6c6e1c9b0b6f3f4f6a0e2c1d9b8a7f6e5d4c3b2a19081726354453627180"
)

// testKeyLine is an authorized_keys line of root on the fresh machine.
var testKeyLine = func() string {
	var blob []byte
	for _, s := range [][]byte{[]byte("ssh-ed25519"), bytes.Repeat([]byte{7}, 32)} {
		blob = binary.BigEndian.AppendUint32(blob, uint32(len(s)))
		blob = append(blob, s...)
	}
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob) + " admin@example"
}()

var (
	testKernel = bytes.Repeat([]byte("K"), 5000)
	testInitrd = bytes.Repeat([]byte("I"), 3001)
	testSquash = bytes.Repeat([]byte("S"), 9000)
)

func sumHex(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// testISO is a recovery ISO with the three live files and live-build's list.
func testISO(edit func(map[string][]byte)) []byte {
	files := map[string][]byte{
		payload.KernelPath: testKernel, payload.InitrdPath: testInitrd, payload.SquashfsPath: testSquash,
		"/isolinux/isolinux.cfg": []byte("timeout 100"),
	}
	files[payload.SumsPath] = []byte(fmt.Sprintf("%s  ./live/vmlinuz\n%s  ./live/initrd.img\n%s  ./live/filesystem.squashfs\n",
		sumHex(testKernel), sumHex(testInitrd), sumHex(testSquash)))
	if edit != nil {
		edit(files)
	}
	return isotest.Build(files, isotest.Options{})
}

// release is a signed checksum list for an ISO.
type testRelease struct {
	key  *release.PublicKey
	iso  []byte
	sums []byte
	sig  []byte
}

func newRelease(t *testing.T, iso []byte) *testRelease {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	sums := []byte(fmt.Sprintf("%s  linux-amd64/restow-agent\n%s  recovery/%s\n", strings.Repeat("ab", 32), sumHex(iso), testISOName))
	return &testRelease{key: release.NewPublicKey(pub, "test"), iso: iso, sums: sums, sig: release.Sign(priv, sums)}
}

// fakeInstance is the instance's side of a oneshot session.
type fakeInstance struct {
	t   *testing.T
	srv *httptest.Server
	rel *testRelease

	mu           sync.Mutex
	secretSHA    string
	exchanges    int
	exchangeBody []byte
	exchangeReq  api.RecoveryOneshotExchangeRequest
	problem      string
	extras       api.OneshotExchangeExtras
	phases       []string
	checks       []api.OneshotChecks
	credentials  int
	isoDownloads int
	served       []byte // the image as served (default rel.iso)
	states       []api.RecoverySessionState
	currentCalls int
	unauthorized int
}

func newInstance(t *testing.T, rel *testRelease) *fakeInstance {
	f := &fakeInstance{t: t, rel: rel, served: rel.iso}
	f.extras.ISO = &api.OneshotISO{Version: testVersion, FileName: testISOName, SHA256: sumHex(rel.iso), SizeBytes: int64(len(rel.iso))}
	f.extras.Needs.RAMBytes = 2 << 30
	decided := &api.OneshotDecided{NetworkMode: "takeover"}
	f.states = []api.RecoverySessionState{
		{SessionID: "rs_1", Status: api.RecoveryPendingApproval},
		{SessionID: "rs_1", Status: api.RecoveryActive, Approved: true, Oneshot: &api.OneshotCurrent{Decided: decided}},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeInstance) problemJSON(w http.ResponseWriter, status int, name string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"type":"urn:restow:problem:%s","title":"%s","status":%d}`, name, name, status)
}

func (f *fakeInstance) authorized(r *http.Request) bool {
	id, secret, ok := r.BasicAuth()
	return ok && id == "rs_1" && recovery.SessionSecretSHA256(secret) == f.secretSHA
}

func (f *fakeInstance) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	p := r.URL.Path
	if p == recovery.OneshotExchangePath && r.Method == http.MethodPost {
		f.exchanges++
		f.exchangeBody = body
		if f.problem != "" {
			f.problemJSON(w, http.StatusConflict, f.problem)
			return
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&f.exchangeReq); err != nil {
			f.t.Errorf("exchange body: %v", err)
		}
		norm, _ := recovery.NormalizeOneshotCode(testCode)
		if f.exchangeReq.CodeProof != recovery.OneshotCodeProof(f.srv.URL, norm) {
			f.problemJSON(w, http.StatusUnauthorized, recovery.ProblemCodeInvalid)
			return
		}
		f.secretSHA = f.exchangeReq.SessionSecretSHA256
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.RecoveryExchangeResponse{SessionID: "rs_1", Status: api.RecoveryPendingApproval,
			MatchCode: recovery.MatchCode(f.secretSHA), Endpoint: api.RecoveryEndpoint{DisplayName: "web01", Hostname: "web01"},
			Oneshot: &f.extras})
		return
	}
	if !strings.HasPrefix(p, recovery.CurrentPath) {
		http.NotFound(w, r)
		return
	}
	if !f.authorized(r) {
		f.unauthorized++
		f.problemJSON(w, http.StatusUnauthorized, recovery.ProblemSessionEnded)
		return
	}
	switch strings.TrimPrefix(p, recovery.CurrentPath) {
	case "":
		st := f.states[min(f.currentCalls, len(f.states)-1)]
		f.currentCalls++
		_ = json.NewEncoder(w).Encode(st)
	case "/progress":
		var pr api.RecoveryProgress
		_ = json.Unmarshal(body, &pr)
		f.phases = append(f.phases, pr.Phase)
		w.WriteHeader(http.StatusNoContent)
	case "/oneshot/checks":
		var c api.OneshotChecks
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			f.t.Errorf("checks body: %v", err)
		}
		f.checks = append(f.checks, c)
		w.WriteHeader(http.StatusNoContent)
	case "/iso/sums":
		_, _ = w.Write(f.rel.sums)
	case "/iso/signature":
		_, _ = w.Write(f.rel.sig)
	case "/iso":
		f.isoDownloads++
		w.Header().Set("Content-Length", strconv.Itoa(len(f.served)))
		_, _ = w.Write(f.served)
	case "/credentials":
		f.credentials++
		f.t.Error("the command asked for the credentials")
		w.WriteHeader(http.StatusConflict)
	default:
		http.NotFound(w, r)
	}
}

// memISO is the downloaded image in memory.
type memISO struct {
	b      []byte
	closed bool
}

func (m *memISO) Write(p []byte) (int, error) { m.b = append(m.b, p...); return len(p), nil }
func (m *memISO) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(m.b)) {
		return 0, io.EOF
	}
	n := copy(p, m.b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
func (m *memISO) Close() error { m.closed = true; return nil }

type kexecLoad struct {
	kernel, initrd []byte
	cmdline        string
}

// fakeEnv is a fresh cloud machine with one disk.
type fakeEnv struct {
	files    map[string]string
	dirs     map[string][]string
	outputs  map[string]string
	missing  map[string]bool
	hw       recovery.HardwareInput
	used     int64
	iso      *memISO
	loads    []kexecLoad
	loadErrs []error
	unloads  int
	loaded   bool
	noLoaded bool
	kexecs   int
	kexecErr error
	cleaned  bool
	// afterTestLoad changes the image on the disk after the check.
	afterTestLoad func(*memISO)
	// cancelOn cancels the run at a step: test-memfd, test-load,
	// final-memfd, final-load, loaded, kexec.
	cancelOn string
	cancel   context.CancelFunc
	// hookISOFile changes the image before the first copy into memory.
	hookISOFile func(*memISO)
}

const (
	addrJSON = `[{"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP"],"mtu":65536,"link_type":"loopback","address":"00:00:00:00:00:00",` +
		`"addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8,"scope":"host"}]},` +
		`{"ifindex":2,"ifname":"eth0","flags":["BROADCAST","UP"],"mtu":1500,"link_type":"ether","address":"96:00:01:02:03:04",` +
		`"addr_info":[{"family":"inet","local":"203.0.113.7","prefixlen":32,"scope":"global","dynamic":true},` +
		`{"family":"inet6","local":"2001:db8:1::7","prefixlen":64,"scope":"global"},` +
		`{"family":"inet6","local":"fe80::9400:1ff:fe02:304","prefixlen":64,"scope":"link"}]}]`
	route4JSON = `[{"dst":"default","gateway":"172.31.1.1","dev":"eth0","protocol":"dhcp","metric":100,"flags":[]}]`
	route6JSON = `[{"dst":"default","gateway":"fe80::1","dev":"eth0","metric":1024,"flags":[],"pref":"medium"}]`
	rulesJSON  = `[{"priority":0,"src":"all","table":"local"},{"priority":32766,"src":"all","table":"main"},{"priority":32767,"src":"all","table":"default"}]`
)

func newEnv() *fakeEnv {
	return &fakeEnv{
		files: map[string]string{
			"/proc/meminfo":                        "MemTotal:        3880000 kB\nMemFree: 100 kB\nMemAvailable:    3500000 kB\n",
			"/proc/sys/kernel/kexec_load_disabled": "0\n",
			"/proc/sys/kernel/hostname":            "debian-4gb-fsn1-1\n",
			"/proc/cmdline":                        "BOOT_IMAGE=/boot/vmlinuz root=UUID=x ro console=tty1 console=ttyS0,115200n8\n",
			"/proc/uptime":                         "312.5 600.1\n",
			"/sys/class/dmi/id/sys_vendor":         "Hetzner\n",
			"/sys/class/dmi/id/product_name":       "vServer\n",
			"/sys/class/net/eth0/device/uevent":    "DRIVER=virtio_net\nPCI_ID=1AF4:1000\n",
			"/etc/resolv.conf":                     "nameserver 127.0.0.53\noptions edns0\n",
			"/run/systemd/resolve/resolv.conf":     "nameserver 185.12.64.1\nnameserver 2a01:4ff:ff00::add:1\nsearch .\n",
			instanceDataPath:                       `{"v1":{"cloud_name":"hetzner","platform":"hetzner","instance_id":"12345","region":"fsn1"}}`,
			authorizedKeys:                         testKeyLine + "\ncommand=\"/bin/false\" " + testKeyLine + "\n# comment\n",
		},
		dirs: map[string][]string{"/home": {"debian"}},
		outputs: map[string]string{
			"ip -j -d addr show":          addrJSON,
			"ip -j -4 route show default": route4JSON,
			"ip -j -6 route show default": route6JSON,
			"ip -j -4 rule show":          rulesJSON,
			"ip -j -6 rule show":          rulesJSON,
		},
		missing: map[string]bool{},
		hw: recovery.HardwareInput{Firmware: baremetal.TargetFirmware{Mode: "bios"}, RAMBytes: 3880000 * 1024,
			Blocks: []recovery.BlockInfo{{KName: "sda", SizeBytes: 40 << 30, Logical: 512, Physical: 512, Model: "QEMU HARDDISK", Serial: "QM00001", Transport: "ata"}}},
		used: 2 << 30,
	}
}

func (e *fakeEnv) ReadFile(path string) ([]byte, error) {
	if s, ok := e.files[path]; ok {
		return []byte(s), nil
	}
	return nil, errors.New("no such file")
}

func (e *fakeEnv) ReadDir(path string) ([]string, error) {
	if d, ok := e.dirs[path]; ok {
		return d, nil
	}
	return nil, errors.New("no such folder")
}

func (e *fakeEnv) Exists(path string) bool { _, ok := e.files[path]; return ok }

func (e *fakeEnv) Output(_ context.Context, argv ...string) ([]byte, error) {
	if e.missing[argv[0]] {
		return nil, errors.New(argv[0] + ": not found")
	}
	key := strings.Join(argv, " ")
	if s, ok := e.outputs[key]; ok {
		return []byte(s), nil
	}
	switch argv[0] {
	case "ip", "lsblk", "blkid":
		if len(argv) == 2 {
			return []byte("version 1"), nil
		}
	case "systemctl":
		return []byte(strings.Repeat("inactive\n", len(argv)-2)), errors.New("exit status 3")
	}
	return nil, fmt.Errorf("%s: unexpected", key)
}

func (e *fakeEnv) Hardware(context.Context) (recovery.HardwareInput, error) { return e.hw, nil }
func (e *fakeEnv) UsedBytes() int64                                         { return e.used }
func (e *fakeEnv) ISOFile() (ISOFile, error)                                { e.iso = &memISO{}; return e.iso, nil }

type fakeBlob struct {
	name string
	b    []byte
}

func (*fakeBlob) Close() error { return nil }

func (e *fakeEnv) phase() string {
	if len(e.loads) == 0 {
		return "test"
	}
	return "final"
}

func (e *fakeEnv) Memfd(name string, fill func(io.Writer) error) (Blob, error) {
	if e.hookISOFile != nil {
		e.hookISOFile(e.iso)
		e.hookISOFile = nil
	}
	if name == "restow-initrd" && e.cancelOn == e.phase()+"-memfd" {
		e.cancel()
	}
	var buf bytes.Buffer
	if err := fill(&buf); err != nil {
		return nil, err
	}
	return &fakeBlob{name: name, b: buf.Bytes()}, nil
}

func (e *fakeEnv) KexecFileLoad(kernel, initrd Blob, cmdline string) error {
	phase := e.phase()
	e.loads = append(e.loads, kexecLoad{kernel: kernel.(*fakeBlob).b, initrd: initrd.(*fakeBlob).b, cmdline: cmdline})
	if n := len(e.loads) - 1; n < len(e.loadErrs) && e.loadErrs[n] != nil {
		return e.loadErrs[n]
	}
	e.loaded = true
	if e.cancelOn == phase+"-load" {
		e.cancel()
	}
	if len(e.loads) == 1 && e.afterTestLoad != nil {
		e.afterTestLoad(e.iso)
	}
	return nil
}

func (e *fakeEnv) KexecUnload() error { e.unloads++; e.loaded = false; return nil }
func (e *fakeEnv) KexecLoaded() bool {
	if e.cancelOn == "loaded" {
		e.cancel()
	}
	return e.loaded && !e.noLoaded
}
func (e *fakeEnv) Kexec(ctx context.Context) error {
	if e.cancelOn == "kexec" {
		e.cancel()
		return ErrCancelled
	}
	e.kexecs++
	return e.kexecErr
}
func (e *fakeEnv) Cleanup() { e.cleaned = true }

// run runs the command against the fakes with the console input.
type runResult struct {
	code int
	out  string
}

func runCommand(t *testing.T, env *fakeEnv, inst *fakeInstance, input string, edit func(*Options)) runResult {
	t.Helper()
	var out bytes.Buffer
	ui := &recovery.UI{In: strings.NewReader(input), Out: &out, Lang: recovery.LangEN, Serial: true}
	opts := Options{Instance: inst.srv.URL, Code: testCode, AllowHTTP: true, HTTP: inst.srv.Client(),
		Trust: ISOTrust{Key: inst.rel.key, AgentVersion: testVersion}, SPKI: func() string { return testSPKI },
		Lang: recovery.LangEN, Version: testVersion, Poll: 1}
	if edit != nil {
		edit(&opts)
	}
	ui.Lang = opts.Lang
	c := &Command{UI: ui, Env: env, Opts: opts}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	env.cancel = cancel
	code := c.Run(ctx)
	return runResult{code: code, out: out.String()}
}

// sessionData takes the session data out of the initrd of a load.
func sessionData(t *testing.T, initrd []byte) *recovery.OneshotData {
	t.Helper()
	name := []byte(payload.DataPath + "\x00")
	i := bytes.Index(initrd, name)
	if i < 110 || string(initrd[i-110:i-104]) != "070701" {
		t.Fatalf("no %s in the initrd", payload.DataPath)
	}
	hdr := initrd[i-110:]
	size, _ := strconv.ParseUint(string(hdr[54:62]), 16, 32)
	mode, _ := strconv.ParseUint(string(hdr[14:22]), 16, 32)
	if mode&0o777 != 0o600 {
		t.Errorf("the session data has mode %o", mode&0o777)
	}
	start := i + len(name)
	start = (start + 3) &^ 3
	b := initrd[start : start+int(size)]
	d, err := recovery.LoadOneshotData(b, true)
	if err != nil {
		t.Fatalf("recover would refuse the session data: %v\n%s", err, b)
	}
	return d
}
