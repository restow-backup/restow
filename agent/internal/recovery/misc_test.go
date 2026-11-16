package recovery

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/restic"
)

func TestMarker(t *testing.T) {
	r := newMemRootfs()
	if m, err := FindResumable(r, "s", "l"); m != nil || err != nil {
		t.Fatalf("no marker: %v %v", m, err)
	}
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	if err := WriteMarker(r, Marker{SnapshotID: "s", LayoutSHA256: "l", PlanSHA256: "p", StartedAt: now, UpdatedAt: now, LastStep: 7, Phase: "restore"}); err != nil {
		t.Fatal(err)
	}
	b, _ := r.ReadFile(MarkerPath, 0)
	if !strings.Contains(string(b), `"format":"restow-recovery-marker-v1"`) || strings.Contains(string(b), "pass") {
		t.Errorf("marker %s", b)
	}
	if st, _ := r.Lstat(MarkerPath); st.Mode().Perm() != 0o600 {
		t.Errorf("marker mode %o", st.Mode().Perm())
	}
	m, err := FindResumable(r, "s", "l")
	if err != nil || m == nil || m.LastStep != 7 || ResumeMode(m) != baremetal.ResumeUnclean {
		t.Errorf("%+v %v", m, err)
	}
	if m, _ := FindResumable(r, "other", "l"); m != nil {
		t.Error("a marker of another snapshot")
	}
	m.CleanStop = true
	_ = WriteMarker(r, *m)
	m, _ = FindResumable(r, "s", "l")
	if ResumeMode(m) != baremetal.ResumeClean {
		t.Error("clean stop")
	}
	if err := RemoveMarker(r); err != nil {
		t.Fatal(err)
	}
	if err := RemoveMarker(r); err != nil {
		t.Errorf("removing twice: %v", err)
	}
}

func TestListTools(t *testing.T) {
	var buf bytes.Buffer
	if err := ListTools(&buf); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if !sort.StringsAreSorted(lines) || len(lines) != len(Tools) {
		t.Error("not sorted or incomplete")
	}
	for _, l := range lines {
		if f := strings.Fields(l); len(f) != 2 {
			t.Errorf("line %q", l)
		}
	}
	// Every program of every golden plan is a tool (or an operation, or
	// restic, which is bundled).
	files, _ := filepath.Glob("../baremetal/testdata/plans/*.json")
	if len(files) == 0 {
		t.Fatal("no golden plans")
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		var p baremetal.RestorePlan
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		for _, s := range p.Steps {
			prog := s.Args[0]
			if Operations[prog] || prog == "restic" {
				continue
			}
			if !KnownTool(prog) {
				t.Errorf("%s step %d: %s is not in the tool table", filepath.Base(f), s.N, prog)
			}
		}
	}
	for _, prog := range []string{"blkid", "cryptsetup", "mdadm", "sfdisk", "mkfs.xfs", "ckbcomp", "loadkeys", "sshd", "mokutil", "dumpe2fs", "udevadm"} {
		if !KnownTool(prog) {
			t.Errorf("%s missing", prog)
		}
	}
	if _, err := Resolve("not-a-tool"); err == nil {
		t.Error("an unknown program resolved")
	}
}

func TestRestoreSizeCounter(t *testing.T) {
	mt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := NewRestoreSizeCounter([]string{"/", "/boot", "/home/"}, 3)
	for _, n := range []restic.Node{
		{Path: "/etc/a", Type: "file", Size: 100, Inode: 10, ModTime: mt},
		{Path: "/etc/a-link", Type: "file", Size: 100, Inode: 10, ModTime: mt}, // hard link: once
		{Path: "/boot/vmlinuz", Type: "file", Size: 1000, Inode: 10, ModTime: mt},
		{Path: "/home/u/x", Type: "file", Size: 5, Inode: 0, ModTime: mt},
		{Path: "/home/u/x2", Type: "file", Size: 5, Inode: 0, ModTime: mt},
		{Path: "/home/u", Type: "dir"},
		{Path: "/home/u/y", Type: "file", Size: 7, Inode: 11, ModTime: mt},
		{Path: "/home/u/y2", Type: "file", Size: 7, Inode: 12, ModTime: mt}, // after the key bound: counted, the target is an upper bound
	} {
		c.Add(n)
	}
	got := c.Result()
	if got["/"].Bytes != 100 || got["/"].Files != 1 || got["/"].Inodes != 1 {
		t.Errorf("/ %+v", got["/"])
	}
	if got["/boot"].Bytes != 1000 {
		t.Errorf("/boot %+v (a key per target)", got["/boot"])
	}
	if got["/home"].Bytes != 24 || got["/home"].Files != 4 || got["/home"].Inodes != 5 {
		t.Errorf("/home %+v", got["/home"])
	}
	if ub := c.UpperBounds(); len(ub) != 1 || ub[0] != "/home" {
		t.Errorf("upper bounds %v", ub)
	}
}

type fakeReader struct {
	files map[string][]byte
	nodes []restic.Node
}

func (f fakeReader) Dump(ctx context.Context, snapshot, p string, max int64) ([]byte, error) {
	if b, ok := f.files[p]; ok {
		return b, nil
	}
	return nil, os.ErrNotExist
}

func (f fakeReader) Ls(ctx context.Context, snapshot string, fn func(restic.Node) error) error {
	for _, n := range f.nodes {
		if err := fn(n); err != nil {
			return err
		}
	}
	return nil
}

func TestReadManifestAndFacts(t *testing.T) {
	raw, err := os.ReadFile("../baremetal/testdata/manifests/debian12-uefi-luks-lvm.json")
	if err != nil {
		t.Fatal(err)
	}
	shaRaw, _ := os.ReadFile("../baremetal/testdata/manifests/debian12-uefi-luks-lvm.sha256")
	sha := strings.TrimSpace(string(shaRaw))
	rr := fakeReader{files: map[string][]byte{SnapshotLayoutPath: raw,
		"/lib/modules/6.1.0-27-amd64/modules.alias":   []byte("alias pci:v00008086d*sv*sd*bc01sc06i01* ahci\n"),
		"/lib/modules/6.1.0-27-amd64/modules.builtin": []byte("kernel/drivers/nvme/host/nvme.ko\n"),
		"/etc/lvm/lvm.conf":                           []byte("devices {\n filter = [\n \"a|/dev/sda|\" ]\n}\n")},
		nodes: []restic.Node{{Path: "/etc/x", Type: "file", Size: 9}}}
	m, _, err := ReadManifest(context.Background(), rr, "snap", sha)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if _, _, err := ReadManifest(context.Background(), rr, "snap", strings.Repeat("0", 64)); ProblemCode(err) != ProblemManifestMismatch {
		t.Errorf("mismatch: %v", err)
	}
	bad := fakeReader{files: map[string][]byte{SnapshotLayoutPath: []byte(`{"format":"restow-layout-v9"}`)}}
	if _, _, err := ReadManifest(context.Background(), bad, "snap", sha256Hex(`{"format":"restow-layout-v9"}`)); ProblemCode(err) != ProblemManifestFormatUnknown {
		t.Errorf("format: %v", err)
	}
	f, multi, err := GatherFacts(context.Background(), rr, m, "snap", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Kernels) == 0 || !strings.Contains(f.Kernels[0].ModulesAlias, "ahci") || f.RestoreSizes["/"].Bytes != 9 {
		t.Errorf("facts %+v", f)
	}
	if !multi {
		t.Error("multiline LVM filter not seen")
	}
	if _, err := baremetal.ParseFacts(mustJSON(t, f)); err != nil {
		t.Errorf("facts invalid: %v", err)
	}
	f2, _, _ := GatherFacts(context.Background(), rr, m, "snap", map[string]api.RecoveryRestoreSize{"/": {Bytes: 1, Files: 2, Inodes: 3}})
	if f2.RestoreSizes["/"].Inodes != 3 {
		t.Error("server sizes not used")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestBuildVerificationBounds(t *testing.T) {
	c := NewCheck(CheckFstab)
	for i := 0; i < 80; i++ {
		c.Fail(ProblemVerifyFailed, "x", strings.Repeat("y", 400)+"\x1b", nil)
	}
	c.Set("long", strings.Repeat("z", 500)).Set("n", 5).Set("b", true)
	v := BuildVerification("s", "p", time.Now(), time.Now(), 0, []*Check{c}, []api.RecoveryHint{{Code: HintMokEnroll}, {Code: HintMokEnroll}}, nil, nil)
	if len(v.Checks) != 10 || v.Result != api.VerifyFailed {
		t.Fatalf("%d checks, %s", len(v.Checks), v.Result)
	}
	if len(v.Checks[2].Findings) != 50 {
		t.Errorf("%d findings", len(v.Checks[2].Findings))
	}
	if strings.Contains(v.Checks[2].Findings[0].Message, "\x1b") || len([]rune(v.Checks[2].Findings[0].Message)) > 300 {
		t.Error("finding not cleaned")
	}
	if len(v.Hints) != 1 {
		t.Error("hints not deduplicated")
	}
	if b := VerificationJSON(v); len(b) > api.RecoveryMaxVerification {
		t.Errorf("report of %d bytes", len(b))
	}
	if v.Checks[0].Result != api.VerifyWarning {
		t.Error("a check that did not run is a warning")
	}
	if Judge([]api.RecoveryCheck{{Result: "ok"}, {Result: "warning"}}) != "warning" || Judge(nil) != "ok" {
		t.Error("judge")
	}
	if FailedChecks(v) != CheckFstab {
		t.Errorf("failed checks %q", FailedChecks(v))
	}
}

func TestPassphraseAndPassword(t *testing.T) {
	p, err := GeneratePassphrase()
	if err != nil {
		t.Fatal(err)
	}
	groups := strings.Split(p, "-")
	if len(groups) != 6 || len(groups[0]) != 5 || strings.ContainsAny(p, "YZyz") {
		t.Errorf("passphrase %q", p)
	}
	for _, r := range strings.ReplaceAll(p, "-", "") {
		if !strings.ContainsRune(Alphabet, r) {
			t.Errorf("character %q outside the code alphabet", r)
		}
	}
	if tooOld("0.4.9", "0.5.0") != true || tooOld("0.5.0", "0.5.0") || tooOld("0.0.0-dev", "0.5.0") {
		t.Error("version check")
	}
}

func TestKeymapForInitramfs(t *testing.T) {
	m := loadManifestFile(t, "debian12-uefi-luks-lvm")
	de, variant := "de-latin1-nodeadkeys", ""
	m.Linux.Initramfs.Keymap = baremetal.Keymap{Layout: &de, Variant: &variant, InInitramfs: true}
	if l, v, g := KeymapForInitramfs(m); l != "de" || v != "nodeadkeys" || g {
		t.Errorf("initramfs keymap: %s %s %v", l, v, g)
	}
	m.Linux.Initramfs.Keymap.InInitramfs = false
	if l, _, _ := KeymapForInitramfs(m); l != "us" {
		t.Error("an initramfs without a keymap types us")
	}
	m.Linux.Initramfs.Keymap = baremetal.Keymap{Layout: &de, InInitramfs: true, GrubCryptodisk: true}
	if l, _, g := KeymapForInitramfs(m); l != "us" || !g {
		t.Error("GRUB cryptodisk types us")
	}
}
