//go:build unix

package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/release"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.1.0", "0.1.0", 0}, {"0.2.0", "0.1.9", 1}, {"0.1.0", "0.2.0", -1}, {"1.0.0", "0.9.9", 1},
		{"v0.1.1", "0.1.0", 1}, {"0.2.0-rc.1", "0.2.0", -1}, {"0.2.0", "0.2.0-rc.1", 1},
		{"0.2.0-rc.2", "0.2.0-rc.1", 1}, {"0.2.0-rc.10", "0.2.0-rc.2", 1}, {"0.2.0-alpha", "0.2.0-beta", -1},
		{"0.1.0+build5", "0.1.0", 0},
	}
	for _, c := range cases {
		a, err1 := ParseVersion(c.a)
		b, err2 := ParseVersion(c.b)
		if err1 != nil || err2 != nil {
			t.Fatalf("parse %s / %s: %v %v", c.a, c.b, err1, err2)
		}
		if got := Compare(a, b); got != c.want {
			t.Errorf("Compare(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	for _, bad := range []string{"", "1.2", "a.b.c", "1.2.3.4", "-1.0.0"} {
		if _, err := ParseVersion(bad); err == nil {
			t.Errorf("ParseVersion(%q) must fail", bad)
		}
	}
	if v, _ := ParseVersion("0.0.0-dev"); !v.IsDev() {
		t.Error("0.0.0-dev must be a dev build")
	}
}

func fakeBinary(version string) []byte {
	return []byte("#!/bin/sh\necho \"restow-agent " + version + "\"\n")
}

var target = runtime.GOOS + "-" + runtime.GOARCH

// trustedDir returns an empty folder whose whole chain no other user can
// change (the update refuses anything else): below /root when the tests run
// as root, else below the package folder.
func trustedDir(t *testing.T) string {
	t.Helper()
	parent := "/root"
	if os.Geteuid() != 0 {
		wd, _ := os.Getwd()
		if _, err := paths.TrustedDir(wd, false); err != nil {
			t.Skipf("no trusted folder for the test: %v", err)
		}
		parent = wd
	}
	dir, err := os.MkdirTemp(parent, "bin-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	_ = os.Chmod(dir, 0o755)
	return dir
}

type fixture struct {
	srv    *fakeserver.Server
	client *api.Client
	priv   ed25519.PrivateKey
	key    *release.PublicKey
	bin    string
}

func (f *fixture) opts(current string) Options {
	return Options{CurrentVersion: current, Client: f.client, Key: f.key, BinDir: f.bin, Info: derefInfo(f.srv.Update)}
}

func derefInfo(i *api.UpdateInfo) api.UpdateInfo {
	if i == nil {
		return api.UpdateInfo{}
	}
	return *i
}

// setup serves a signed release `announced` with the given agent binary and
// restic, and installs agent 0.1.0 plus an old restic in a trusted folder.
func setup(t *testing.T, announced string, binary []byte) *fixture {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := fakeserver.New(true)
	t.Cleanup(s.Close)
	s.SetRelease(announced, map[string][]byte{
		target + "/restow-agent": binary,
		target + "/restic":       []byte("restic " + announced),
	}, priv)
	s.SetUpdate(announced, target, binary)
	c, err := api.New(api.Options{BaseURL: s.URL, EndpointID: s.EndpointID, AgentSecret: s.AgentSecret, HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	bin := trustedDir(t)
	if err := os.WriteFile(filepath.Join(bin, "restow-agent"), fakeBinary("0.1.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "restic"), []byte("restic old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &fixture{srv: s, client: c, priv: priv, key: release.NewPublicKey(pub, "test"), bin: bin}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, _ := os.ReadFile(p)
	return string(b)
}

func noStagedFiles(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".new-") {
			t.Fatalf("staged file left behind: %s", e.Name())
		}
	}
}

func TestApplyInstallsASignedRelease(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	res, err := Apply(context.Background(), f.opts("0.1.0"))
	if err != nil || res.Version != "0.2.0" || !res.AgentChanged || !res.ResticChanged {
		t.Fatalf("Apply: %+v %v", res, err)
	}
	exe := filepath.Join(f.bin, "restow-agent")
	if !strings.Contains(readFile(t, exe), "0.2.0") || readFile(t, filepath.Join(f.bin, "restic")) != "restic 0.2.0" {
		t.Fatal("agent or restic not replaced")
	}
	if st, _ := os.Stat(exe); st.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %#o", st.Mode().Perm())
	}
	if !strings.Contains(readFile(t, exe+".prev"), "0.1.0") {
		t.Fatal("previous binary not kept for rollback")
	}
	noStagedFiles(t, f.bin)
	// The signature was fetched before any binary.
	gets := strings.Join(f.srv.ReleaseGets, ",")
	if !strings.HasPrefix(gets, "0.2.0/SHA256SUMS,0.2.0/SHA256SUMS.sig,") {
		t.Fatalf("download order: %s", gets)
	}
}

// The license notices travel with a release: checked against the signed
// SHA-256 like the binaries, written before them into the install prefix next
// to the bin folder, readable by all.
func TestApplyInstallsTheLicenseNotices(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	prefix := trustedDir(t)
	bin := filepath.Join(prefix, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "restow-agent"), fakeBinary("0.1.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	notices := []byte("Restow agent: license and third-party notices\n")
	f.srv.SetRelease("0.2.0", map[string][]byte{
		target + "/restow-agent":         fakeBinary("0.2.0"),
		target + "/restic":               []byte("restic 0.2.0"),
		target + "/" + paths.NoticesFile: notices,
	}, f.priv)
	o := f.opts("0.1.0")
	o.BinDir = bin

	// A notices file that is not the signed one stops the update before any binary changes.
	f.srv.Releases["0.2.0"][target+"/"+paths.NoticesFile] = []byte("changed after signing\n")
	if _, err := Apply(context.Background(), o); err == nil || !strings.Contains(err.Error(), "license notices: SHA-256 mismatch") {
		t.Fatalf("tampered notices: %v", err)
	}
	if !strings.Contains(readFile(t, filepath.Join(bin, "restow-agent")), "0.1.0") {
		t.Fatal("the agent was replaced although the notices did not verify")
	}
	f.srv.Releases["0.2.0"][target+"/"+paths.NoticesFile] = notices

	before := len(f.srv.ReleaseGets)
	res, err := Apply(context.Background(), o)
	if err != nil || !res.NoticesChanged || !res.ResticChanged || !res.AgentChanged {
		t.Fatalf("Apply: %+v %v", res, err)
	}
	dest := filepath.Join(prefix, paths.NoticesFile)
	if readFile(t, dest) != string(notices) {
		t.Fatalf("notices: %q", readFile(t, dest))
	}
	if st, _ := os.Stat(dest); st.Mode().Perm() != 0o644 {
		t.Fatalf("notices mode = %#o", st.Mode().Perm())
	}
	noStagedFiles(t, prefix)
	gets := strings.Join(f.srv.ReleaseGets[before:], ",")
	if !strings.Contains(gets, paths.NoticesFile+",0.2.0/"+target+"/restic,0.2.0/"+target+"/restow-agent") {
		t.Fatalf("download order: %s", gets)
	}
}

// A release from before the notices existed updates the binaries all the same.
func TestApplyWithoutNoticesInTheRelease(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	res, err := Apply(context.Background(), f.opts("0.1.0"))
	if err != nil || res.NoticesChanged || !res.AgentChanged {
		t.Fatalf("Apply: %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(f.bin), paths.NoticesFile)); !os.IsNotExist(err) {
		t.Fatalf("a notices file appeared: %v", err)
	}
}

func TestApplyRefusesUnsignedAndWronglySignedReleases(t *testing.T) {
	ctx := context.Background()

	// No signature at all.
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	delete(f.srv.Releases["0.2.0"], "SHA256SUMS.sig")
	if _, err := Apply(ctx, f.opts("0.1.0")); err == nil || !strings.Contains(err.Error(), "not signed") {
		t.Fatalf("unsigned: %v", err)
	}

	// Signed with another key (a compromised instance re-signing).
	f = setup(t, "0.2.0", fakeBinary("0.2.0"))
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	f.srv.SetRelease("0.2.0", map[string][]byte{target + "/restow-agent": fakeBinary("0.2.0"), target + "/restic": []byte("x")}, other)
	if _, err := Apply(ctx, f.opts("0.1.0")); !errors.Is(err, release.ErrBadSignature) {
		t.Fatalf("other key: %v", err)
	}

	// SHA256SUMS changed after signing.
	f = setup(t, "0.2.0", fakeBinary("0.2.0"))
	f.srv.Releases["0.2.0"]["SHA256SUMS"] = append(f.srv.Releases["0.2.0"]["SHA256SUMS"], []byte("0000000000000000000000000000000000000000000000000000000000000000  x/y\n")...)
	if _, err := Apply(ctx, f.opts("0.1.0")); !errors.Is(err, release.ErrBadSignature) {
		t.Fatalf("changed sums: %v", err)
	}

	// The binary does not match its signed hash.
	f = setup(t, "0.2.0", fakeBinary("0.2.0"))
	f.srv.Releases["0.2.0"][target+"/restow-agent"] = fakeBinary("0.6.6")
	if _, err := Apply(ctx, f.opts("0.1.0")); err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("tampered binary: %v", err)
	}
	if !strings.Contains(readFile(t, filepath.Join(f.bin, "restow-agent")), "0.1.0") {
		t.Fatal("the installed binary changed although verification failed")
	}
	noStagedFiles(t, f.bin)

	// The placeholder build has no key and installs nothing.
	f = setup(t, "0.2.0", fakeBinary("0.2.0"))
	o := f.opts("0.1.0")
	o.Key = nil
	if _, err := release.TrustedKey(); errors.Is(err, release.ErrNoKey) {
		if _, err := Apply(ctx, o); !errors.Is(err, ErrNoKey) {
			t.Fatalf("placeholder key: %v", err)
		}
	}
}

func TestApplyNeverRunsAnUnverifiedBinary(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	f.srv.Releases["0.2.0"][target+"/restow-agent"] = fakeBinary("0.6.6")
	ran := false
	o := f.opts("0.1.0")
	o.Verify = func(ctx context.Context, p string) (string, error) { ran = true; return RunVersion(ctx, p) }
	if _, err := Apply(context.Background(), o); err == nil {
		t.Fatal("tampered binary accepted")
	}
	if ran {
		t.Fatal("a binary that failed verification was executed")
	}
}

func TestApplyRejectsAnnouncementThatDisagreesWithTheSignedRelease(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	o := f.opts("0.1.0")
	o.Info.SHA256 = strings.Repeat("ab", 32)
	if _, err := Apply(context.Background(), o); err == nil || !strings.Contains(err.Error(), "signed release says") {
		t.Fatalf("err = %v", err)
	}
}

func TestApplyRejectsBadVersions(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	ctx := context.Background()
	if _, err := Apply(ctx, f.opts("0.2.0")); err != ErrNotNewer {
		t.Fatalf("same version: %v", err)
	}
	if _, err := Apply(ctx, f.opts("0.3.0")); err != ErrNotNewer {
		t.Fatalf("downgrade must be refused: %v", err)
	}
	if _, err := Apply(ctx, f.opts("0.0.0-dev")); err != ErrDevBuild {
		t.Fatalf("dev build: %v", err)
	}
}

func TestApplyRejectsWrongReportedVersionAndBrokenBinary(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.9.9"))
	if _, err := Apply(context.Background(), f.opts("0.1.0")); err == nil || !strings.Contains(err.Error(), "reports version") {
		t.Fatalf("err = %v", err)
	}
	f2 := setup(t, "0.2.0", []byte("not an executable"))
	if _, err := Apply(context.Background(), f2.opts("0.1.0")); err == nil || !strings.Contains(err.Error(), "does not run") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(readFile(t, filepath.Join(f2.bin, "restow-agent")), "0.1.0") {
		t.Fatal("running binary must stay untouched")
	}
	noStagedFiles(t, f2.bin)
}

func TestApplyRefusesAnUntrustedInstallFolder(t *testing.T) {
	f := setup(t, "0.2.0", fakeBinary("0.2.0"))
	if err := os.Chmod(f.bin, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(context.Background(), f.opts("0.1.0")); err == nil || !strings.Contains(err.Error(), "not safe") {
		t.Fatalf("err = %v", err)
	}
}

func TestStagingNeverFollowsAPlantedLink(t *testing.T) {
	dir := trustedDir(t)
	victim := filepath.Join(dir, "victim")
	if err := os.WriteFile(victim, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, name, err := createStaged(dir, "restow-agent")
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	_ = os.Remove(name)
	// A link planted under the exact staged name makes the create fail instead of writing through it.
	if err := os.Symlink(victim, name); err != nil {
		t.Fatal(err)
	}
	if _, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
		t.Fatal("O_EXCL must refuse an existing link")
	}
	if readFile(t, victim) != "keep" {
		t.Fatal("the link target was written")
	}
	CleanupStaged(dir)
}

func TestReinstallMovesTheRunningVersionIntoPlace(t *testing.T) {
	f := setup(t, "0.1.1", fakeBinary("0.1.1"))
	empty := trustedDir(t)
	o := f.opts("0.1.1")
	o.BinDir = empty
	res, err := Reinstall(context.Background(), o)
	if err != nil || !res.AgentChanged || !res.ResticChanged || res.AgentPath != filepath.Join(empty, "restow-agent") {
		t.Fatalf("Reinstall: %+v %v", res, err)
	}
	// Idempotent: a second run downloads no binary again.
	before := len(f.srv.ReleaseGets)
	res, err = Reinstall(context.Background(), o)
	if err != nil || res.AgentChanged || res.ResticChanged {
		t.Fatalf("second Reinstall: %+v %v", res, err)
	}
	if got := f.srv.ReleaseGets[before:]; len(got) != 2 {
		t.Fatalf("second run fetched %v", got)
	}
	if _, err := Reinstall(context.Background(), f.opts("0.0.0-dev")); err != ErrDevBuild {
		t.Fatalf("dev: %v", err)
	}
}
