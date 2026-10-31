// Package update installs agent releases served by the Restow instance: the
// self-update to a newer version and the move of an earlier pre-release
// installation to the root-owned prefix (Reinstall).
//
// Nothing is trusted because of where it comes from. The instance serves the
// release's SHA256SUMS and the maintainer's signature over it
// (`/install/agent/<version>/SHA256SUMS` and `.sig`); the signature is checked
// against the key compiled into this binary before anything else is looked
// at, every downloaded file must match its signed SHA-256, and only then is a
// file made executable, run (`version`) or moved into place. Files are staged
// with O_CREATE|O_EXCL|O_NOFOLLOW under random names in the root-owned bin
// folder and renamed over the old ones, so a crash never leaves a half file
// in place and nobody can plant a link to redirect the write.
//
// Every file of a release is staged and checked before any of them replaces
// an installed one (restic first, the agent last): the signature covers the
// file list, not the version number, so a hostile server could announce a new
// version and deliver the validly signed list of an older release; the agent's
// version check then fails before anything was replaced. On Windows the
// running restow-agent.exe cannot be overwritten, but it can be renamed:
// swap_windows.go moves it to restow-agent.exe.prev first
// (docs/WINDOWS-AGENT.md, section 13).
package update

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/procenv"
	"github.com/restow-backup/restow/agent/internal/release"
)

const (
	// maxBinaryBytes is a sanity limit for a downloaded binary.
	maxBinaryBytes = 200 << 20
	maxSumsBytes   = 1 << 20
	maxSigBytes    = 16 << 10

	agentBase  = "restow-agent"
	resticBase = "restic"
)

// fileName is the name of a binary in the release folder of a target
// (restow-agent.exe and restic.exe on Windows).
func fileName(target, base string) string {
	if strings.HasPrefix(target, "windows-") {
		return base + ".exe"
	}
	return base
}

// Downloader is the part of api.Client that this package needs.
type Downloader interface {
	Download(ctx context.Context, rawURL string, w io.Writer, maxBytes int64) (string, error)
}

// Options configures Apply and Reinstall.
type Options struct {
	CurrentVersion string
	// Info is the update announcement (Apply only).
	Info   api.UpdateInfo
	Client Downloader
	// Key verifies the release signature; nil selects the key compiled into
	// this binary (ErrNoKey for a build with the placeholder).
	Key *release.PublicKey
	// BinDir is where the agent and restic are installed; empty selects the
	// root-owned bin folder of this platform (created when missing).
	BinDir string
	// Target is `<os>-<arch>`; empty selects this machine.
	Target string
	// Verify runs a downloaded agent and returns the version it reports.
	// nil selects RunVersion.
	Verify func(ctx context.Context, path string) (string, error)
}

// ErrNotNewer means the announced version is not newer than the running one.
var ErrNotNewer = errors.New("the announced version is not newer than the installed one")

// ErrDevBuild means a development build refuses to self-update.
var ErrDevBuild = errors.New("development builds do not self-update")

// ErrNoKey is release.ErrNoKey: this build cannot verify anything.
var ErrNoKey = release.ErrNoKey

// Result says what an installation changed.
type Result struct {
	Version       string
	AgentPath     string
	AgentChanged  bool
	ResticChanged bool
	// NoticesChanged: the license notices (paths.NoticesFile, in the install
	// prefix next to the bin folder) were written. A release without them
	// leaves the file as it is.
	NoticesChanged bool
}

// Apply installs the announced newer release (agent and, when the release
// pins another one, restic). The caller restarts the process afterwards.
func Apply(ctx context.Context, o Options) (Result, error) {
	cur, err := ParseVersion(o.CurrentVersion)
	if err != nil {
		return Result{}, fmt.Errorf("current version: %w", err)
	}
	if cur.IsDev() {
		return Result{}, ErrDevBuild
	}
	next, err := ParseVersion(o.Info.Version)
	if err != nil {
		return Result{}, fmt.Errorf("announced version: %w", err)
	}
	if Compare(next, cur) <= 0 {
		return Result{}, ErrNotNewer
	}
	if next.IsDev() {
		return Result{}, errors.New("a development build is never installed as an update")
	}
	return install(ctx, o, strings.TrimPrefix(strings.TrimSpace(o.Info.Version), "v"), true)
}

// Reinstall installs the release of the running version into the root-owned
// prefix (the move of an earlier pre-release installation). Files that are already there and
// match the signed hashes stay as they are.
func Reinstall(ctx context.Context, o Options) (Result, error) {
	cur, err := ParseVersion(o.CurrentVersion)
	if err != nil {
		return Result{}, fmt.Errorf("current version: %w", err)
	}
	if cur.IsDev() {
		return Result{}, ErrDevBuild
	}
	return install(ctx, o, strings.TrimPrefix(strings.TrimSpace(o.CurrentVersion), "v"), false)
}

func install(ctx context.Context, o Options, version string, isUpdate bool) (Result, error) {
	key := o.Key
	if key == nil {
		k, err := release.TrustedKey()
		if err != nil {
			return Result{}, err
		}
		key = k
	}
	target := o.Target
	if target == "" {
		target = runtime.GOOS + "-" + runtime.GOARCH
	}
	sums, err := FetchSums(ctx, o.Client, key, version)
	if err != nil {
		return Result{}, err
	}
	agentFile, resticFile := fileName(target, agentBase), fileName(target, resticBase)
	agentSum, err := sums.Lookup(target, agentFile)
	if err != nil {
		return Result{}, err
	}
	resticSum, err := sums.Lookup(target, resticFile)
	if err != nil {
		return Result{}, err
	}
	if isUpdate && o.Info.SHA256 != "" && !strings.EqualFold(strings.TrimSpace(o.Info.SHA256), agentSum) {
		return Result{}, fmt.Errorf("the update announcement names SHA-256 %s for the agent, but the signed release says %s; not installing",
			o.Info.SHA256, agentSum)
	}

	binDir := o.BinDir
	if binDir == "" {
		if binDir, err = paths.EnsureBinDir(); err != nil {
			return Result{}, fmt.Errorf("the install folder is not safe: %w", err)
		}
	} else if _, err := paths.TrustedDir(binDir, false); err != nil {
		return Result{}, fmt.Errorf("the install folder is not safe: %w", err)
	}
	CleanupStaged(binDir)

	base := "/install/agent/" + version + "/" + target + "/"
	res := Result{Version: version, AgentPath: filepath.Join(binDir, agentFile)}

	// Stage and check everything first; nothing installed changes before all
	// files passed.
	var staged []stagedFile
	discard := func() {
		for _, f := range staged {
			_ = os.Remove(f.staged)
		}
	}
	// The license notices: they describe the restic and the agent that follow.
	// Releases from before the notices existed do not list them.
	if noticesSum, err := sums.Lookup(target, paths.NoticesFile); err == nil {
		dest := filepath.Join(filepath.Dir(binDir), paths.NoticesFile)
		f, err := stageFile(ctx, o.Client, base+paths.NoticesFile, dest, noticesSum, nil, 0o644)
		if err != nil {
			discard()
			return res, fmt.Errorf("license notices: %w", err)
		}
		staged = appendStaged(staged, f)
	}
	rf, err := stageFile(ctx, o.Client, base+resticFile, filepath.Join(binDir, resticFile), resticSum, nil, 0o755)
	if err != nil {
		discard()
		return res, fmt.Errorf("restic: %w", err)
	}
	staged = appendStaged(staged, rf)
	verify := o.Verify
	if verify == nil {
		verify = RunVersion
	}
	check := func(ctx context.Context, staged string) error {
		reported, err := verify(ctx, staged)
		if err != nil {
			return fmt.Errorf("the downloaded agent does not run: %w", err)
		}
		if !strings.Contains(reported, version) {
			return fmt.Errorf("the downloaded agent reports version %q, expected %s; not installing", strings.TrimSpace(reported), version)
		}
		return nil
	}
	af, err := stageFile(ctx, o.Client, base+agentFile, res.AgentPath, agentSum, check, 0o755)
	if err != nil {
		discard()
		return res, err
	}
	af.keepPrev = true
	staged = appendStaged(staged, af)

	// Now replace, in this order: notices, restic, the agent last. A failure
	// of a later swap (the agent's, in practice) puts the earlier files back.
	if err := commitAll(staged); err != nil {
		return res, err
	}
	for _, f := range staged {
		switch f.dest {
		case res.AgentPath:
			res.AgentChanged = true
		case rf.dest:
			res.ResticChanged = true
		default:
			res.NoticesChanged = true
		}
	}
	return res, nil
}

// commit is commitFile; the tests replace it to make one swap fail.
var commit = commitFile

// swap is a file that commitFile has put in place. undo puts the previous
// content back (or removes the file when there was none); done drops what
// undo would have needed, once every file of the release is in place.
type swap struct {
	undo, done func()
}

// commitAll puts every staged file in place, in order. When one fails, the
// files already replaced get their previous content back, so the installed
// agent never runs with a restic or notices its release did not ship, and
// the staged files that are left are deleted.
func commitAll(staged []stagedFile) error {
	var swaps []swap
	for i, f := range staged {
		sw, err := commit(f.staged, f.dest, f.keepPrev)
		if err != nil {
			for j := len(swaps) - 1; j >= 0; j-- {
				swaps[j].undo()
			}
			for _, rest := range staged[i:] {
				_ = os.Remove(rest.staged)
			}
			return fmt.Errorf("cannot replace %s: %w", f.dest, err)
		}
		swaps = append(swaps, sw)
	}
	for _, sw := range swaps {
		sw.done()
	}
	return nil
}

// randomSuffix returns 16 hex characters for the name of a file kept aside.
func randomSuffix() string {
	var rnd [8]byte
	_, _ = rand.Read(rnd[:])
	return hex.EncodeToString(rnd[:])
}

// stagedFile is a downloaded and checked file waiting to replace dest. An
// empty staged path means dest already has the signed content.
type stagedFile struct {
	dest, staged string
	keepPrev     bool
}

func appendStaged(list []stagedFile, f stagedFile) []stagedFile {
	if f.staged == "" {
		return list
	}
	return append(list, f)
}

// FetchSums downloads the SHA256SUMS of a release and its signature from the
// instance and returns the parsed file only when the signature is good.
func FetchSums(ctx context.Context, c Downloader, key *release.PublicKey, version string) (release.Sums, error) {
	base := "/install/agent/" + version + "/SHA256SUMS"
	var sums, sig bytes.Buffer
	if _, err := c.Download(ctx, base, &sums, maxSumsBytes); err != nil {
		return nil, fmt.Errorf("cannot download the checksums of agent %s: %w", version, err)
	}
	if _, err := c.Download(ctx, base+".sig", &sig, maxSigBytes); err != nil {
		var ae *api.APIError
		if errors.As(err, &ae) && ae.Status == 404 {
			return nil, fmt.Errorf("agent %s on this instance is not signed (no SHA256SUMS.sig); unsigned releases are never installed", version)
		}
		return nil, fmt.Errorf("cannot download the signature of agent %s: %w", version, err)
	}
	parsed, err := release.VerifiedSums(key, sums.Bytes(), sig.Bytes())
	if err != nil {
		return nil, fmt.Errorf("agent %s: %w", version, err)
	}
	return parsed, nil
}

// stageFile downloads the file with the signed SHA-256 want next to dest,
// checks it and returns the staged copy. It stages nothing when dest already
// has that content.
func stageFile(ctx context.Context, c Downloader, url, dest, want string, check func(context.Context, string) error, mode os.FileMode) (stagedFile, error) {
	out := stagedFile{dest: dest}
	if have, err := fileSHA256(dest); err == nil && strings.EqualFold(have, want) {
		return out, nil
	}
	wantRaw, err := hex.DecodeString(want)
	if err != nil || len(wantRaw) != 32 {
		return out, fmt.Errorf("invalid signed SHA-256 %q", want)
	}
	f, staged, err := createStaged(filepath.Dir(dest), filepath.Base(dest))
	if err != nil {
		return out, fmt.Errorf("cannot stage the download in %s: %w", filepath.Dir(dest), err)
	}
	cleanup := func() { _ = os.Remove(staged) }
	got, err := c.Download(ctx, url, f, maxBinaryBytes)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		cleanup()
		return out, fmt.Errorf("download failed: %w", err)
	}
	gotRaw, _ := hex.DecodeString(got)
	if subtle.ConstantTimeCompare(gotRaw, wantRaw) != 1 {
		cleanup()
		return out, fmt.Errorf("SHA-256 mismatch: the signed release says %s but the download hashes to %s; not installing", want, got)
	}
	// Only now, with a verified file, does it become executable (a binary) or readable by all.
	if err := os.Chmod(staged, mode); err != nil {
		cleanup()
		return out, err
	}
	if check != nil {
		if err := check(ctx, staged); err != nil {
			cleanup()
			return out, err
		}
	}
	out.staged = staged
	return out, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// RunVersion executes `<path> version` and returns its output. It is only
// called for a binary whose signed SHA-256 matched.
func RunVersion(ctx context.Context, path string) (string, error) {
	vctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(vctx, path, "version")
	cmd.Env = procenv.Base()
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// CleanupStaged removes half-downloaded files left by a crash in dir, and old
// binaries a Windows update could not delete right away.
func CleanupStaged(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if IsLeftover(e.Name()) && e.Type().IsRegular() {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// IsLeftover reports whether a file name in the bin folder is a staged
// download (.restic.new-<hex>, .restow-agent.new-<hex>.exe) or a previous
// file kept until the agent's swap succeeded (restic.exe.old-<hex>, under Unix
// the hard link restic.old-<hex>) that a crash left behind.
func IsLeftover(name string) bool {
	return (strings.HasPrefix(name, ".") && strings.Contains(name, ".new-")) || strings.Contains(name, ".old-")
}
