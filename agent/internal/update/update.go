//go:build unix

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
	"syscall"
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

	agentFile  = "restow-agent"
	resticFile = "restic"
)

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

	// The license notices first: they describe the restic and the agent that follow.
	// Releases from before the notices existed do not list them.
	if noticesSum, err := sums.Lookup(target, paths.NoticesFile); err == nil {
		dest := filepath.Join(filepath.Dir(binDir), paths.NoticesFile)
		res.NoticesChanged, err = installFile(ctx, o.Client, base+paths.NoticesFile, dest, noticesSum, nil, false, 0o644)
		if err != nil {
			return res, fmt.Errorf("license notices: %w", err)
		}
	}

	// restic first: the new agent starts with the restic its release pins.
	res.ResticChanged, err = installFile(ctx, o.Client, base+resticFile, filepath.Join(binDir, resticFile), resticSum, nil, false, 0o755)
	if err != nil {
		return res, fmt.Errorf("restic: %w", err)
	}
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
	res.AgentChanged, err = installFile(ctx, o.Client, base+agentFile, res.AgentPath, agentSum, check, true, 0o755)
	if err != nil {
		return res, err
	}
	return res, nil
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

// installFile puts the file with the signed SHA-256 want at dest, with the
// given mode. It returns false when dest already has that content.
func installFile(ctx context.Context, c Downloader, url, dest, want string, check func(context.Context, string) error, keepPrev bool, mode os.FileMode) (bool, error) {
	if have, err := fileSHA256(dest); err == nil && strings.EqualFold(have, want) {
		return false, nil
	}
	wantRaw, err := hex.DecodeString(want)
	if err != nil || len(wantRaw) != 32 {
		return false, fmt.Errorf("invalid signed SHA-256 %q", want)
	}
	f, staged, err := createStaged(filepath.Dir(dest), filepath.Base(dest))
	if err != nil {
		return false, fmt.Errorf("cannot stage the download in %s: %w", filepath.Dir(dest), err)
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
		return false, fmt.Errorf("download failed: %w", err)
	}
	gotRaw, _ := hex.DecodeString(got)
	if subtle.ConstantTimeCompare(gotRaw, wantRaw) != 1 {
		cleanup()
		return false, fmt.Errorf("SHA-256 mismatch: the signed release says %s but the download hashes to %s; not installing", want, got)
	}
	// Only now, with a verified file, does it become executable (a binary) or readable by all.
	if err := os.Chmod(staged, mode); err != nil {
		cleanup()
		return false, err
	}
	if check != nil {
		if err := check(ctx, staged); err != nil {
			cleanup()
			return false, err
		}
	}
	if keepPrev {
		// The current binary stays for a manual rollback (hard link: same file
		// system, no copy). Failure to keep it is not fatal.
		prev := dest + ".prev"
		_ = os.Remove(prev)
		if st, err := os.Lstat(dest); err == nil && st.Mode().IsRegular() {
			_ = os.Link(dest, prev)
		}
	}
	if err := os.Rename(staged, dest); err != nil {
		cleanup()
		return false, fmt.Errorf("cannot replace %s: %w", dest, err)
	}
	return true, nil
}

// createStaged creates a new file with a random name next to dest. O_EXCL and
// O_NOFOLLOW make sure it is a fresh file and not something prepared in its
// place; the folder itself is root-owned (checked by the caller).
func createStaged(dir, base string) (*os.File, string, error) {
	for i := 0; i < 10; i++ {
		var rnd [8]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			return nil, "", err
		}
		name := filepath.Join(dir, "."+base+".new-"+hex.EncodeToString(rnd[:]))
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
		if err == nil {
			return f, name, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("cannot find a free name for the staged file")
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

// CleanupStaged removes half-downloaded files left by a crash in dir.
func CleanupStaged(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") && strings.Contains(name, ".new-") && e.Type().IsRegular() {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}
