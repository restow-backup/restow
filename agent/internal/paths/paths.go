// Package paths defines where the agent keeps its files. The layout is fixed
// per operating system so that the install scripts, the service unit and the
// documentation agree on it. RESTOW_AGENT_DIR relocates the working files
// under one directory; it exists for development and tests only.
//
// The binaries live below a prefix that only root can change
// (/opt/restow-agent on Linux, /Library/Application Support/Restow on macOS):
// the service runs them as root, so whoever could replace them would be root.
// Earlier pre-release installations put them below /usr/local, which belongs to
// a user on Macs with Homebrew (Intel); see Legacy* and the move in
// cmd/restow-agent.
package paths

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// Layout is the set of directories the agent uses.
type Layout struct {
	// StateDir holds state.json with the agent secret and the repository
	// password. Mode 0700, owned by root.
	StateDir string
	// DataDir holds status.json (no secrets), the restic cache, temporary
	// restore folders and the outbox of unsent run reports.
	DataDir string
	// LogDir holds the rotating agent log.
	LogDir string
}

const (
	// EnvAgentDir relocates the whole layout (development and tests).
	EnvAgentDir = "RESTOW_AGENT_DIR"
	// EnvResticPath overrides the restic binary location (development and tests).
	EnvResticPath = "RESTOW_RESTIC_PATH"

	// LinuxInstallDir is the root-owned prefix of the binaries on Linux.
	LinuxInstallDir = "/opt/restow-agent"
	// DarwinInstallDir is the root-owned prefix of the binaries on macOS.
	DarwinInstallDir = "/Library/Application Support/Restow"

	// CommandLink is the convenience link for administrators (`sudo
	// restow-agent status`). It is only created where /usr/local/bin is
	// owned by root; nothing executes it on its own.
	CommandLink = "/usr/local/bin/restow-agent"

	// LegacyAgentBinary is where an earlier pre-release installation put the agent.
	LegacyAgentBinary = "/usr/local/bin/restow-agent"
	// LegacyLibDir is where an earlier pre-release installation put restic.
	LegacyLibDir = "/usr/local/lib/restow-agent"
	// LegacyResticBinary is the restic of an earlier pre-release installation.
	LegacyResticBinary = LegacyLibDir + "/restic"
)

// InstallDirFor returns the root-owned install prefix for an operating system.
func InstallDirFor(goos string) string {
	if goos == "darwin" {
		return DarwinInstallDir
	}
	return LinuxInstallDir
}

// InstallDir is the install prefix on this machine.
func InstallDir() string { return InstallDirFor(runtime.GOOS) }

// BinDir holds the agent and restic.
func BinDir() string { return filepath.Join(InstallDir(), "bin") }

// InstalledAgentBinary is where the install script and the self-update put the agent.
func InstalledAgentBinary() string { return filepath.Join(BinDir(), "restow-agent") }

// InstalledResticBinary is where the install script and the self-update put restic.
func InstalledResticBinary() string { return filepath.Join(BinDir(), "restic") }

// NoticesFile is the name of the license notices of the agent, restic and the
// Go modules in restic, in a release and on the machine.
const NoticesFile = "THIRD_PARTY_NOTICES.txt"

// InstalledNotices is where the install script and the self-update put the
// license notices: in the install prefix, next to the bin folder.
func InstalledNotices() string { return filepath.Join(InstallDir(), NoticesFile) }

// DevLayout reports whether RESTOW_AGENT_DIR relocates the layout
// (development and tests: no service, no ownership checks).
func DevLayout() bool { return os.Getenv(EnvAgentDir) != "" }

// Default returns the layout for this machine.
func Default() Layout {
	if dir := os.Getenv(EnvAgentDir); dir != "" {
		return Layout{
			StateDir: filepath.Join(dir, "state"),
			DataDir:  filepath.Join(dir, "data"),
			LogDir:   filepath.Join(dir, "logs"),
		}
	}
	return Layout{
		StateDir: "/etc/restow-agent",
		DataDir:  "/var/lib/restow-agent",
		LogDir:   "/var/log/restow-agent",
	}
}

// StateFile is the secret-bearing state file.
func (l Layout) StateFile() string { return filepath.Join(l.StateDir, "state.json") }

// HooksDir holds the hook scripts root allowed for the scripts-only hook mode
// (/etc/restow-agent/hooks.d).
func (l Layout) HooksDir() string { return filepath.Join(l.StateDir, "hooks.d") }

// StatusFile is the world-readable runtime status (no secrets).
func (l Layout) StatusFile() string { return filepath.Join(l.DataDir, "status.json") }

// LockFile serialises runs between the service and `backup-now`.
func (l Layout) LockFile() string { return filepath.Join(l.DataDir, "run.lock") }

// CacheDir is restic's cache directory.
func (l Layout) CacheDir() string { return filepath.Join(l.DataDir, "cache") }

// TmpDir holds temporary folders (verify_sample restores).
func (l Layout) TmpDir() string { return filepath.Join(l.DataDir, "tmp") }

// OutboxDir holds run reports that could not be delivered yet.
func (l Layout) OutboxDir() string { return filepath.Join(l.DataDir, "outbox") }

// LogFile is the rotating agent log.
func (l Layout) LogFile() string { return filepath.Join(l.LogDir, "agent.log") }

// Ensure creates the data and log directories with their intended modes.
// The data directory stays world-traversable (status.json carries no secrets,
// so `restow-agent status` works without root); the restic cache below it is
// private. The state directory is created by the state package (0700).
func (l Layout) Ensure() error {
	if err := os.MkdirAll(l.DataDir, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(l.DataDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(l.LogDir, 0o750); err != nil {
		return err
	}
	return nil
}

// ResticBinary locates the restic executable: the RESTOW_RESTIC_PATH override
// (development and tests), else the installed location. It never searches
// PATH and never takes a restic lying next to the agent, because the agent
// runs as root. Callers check the result with TrustedFile before running it.
func ResticBinary() (string, error) {
	if p := os.Getenv(EnvResticPath); p != "" {
		return p, nil
	}
	installed := InstalledResticBinary()
	if st, err := os.Stat(installed); err == nil && !st.IsDir() {
		return installed, nil
	}
	return "", errors.New("restic binary not found at " + installed +
		"; re-run the install script to repair the installation")
}

// TrustedRestic locates restic and, outside development layouts, refuses one
// that a user other than root could have replaced.
func TrustedRestic() (string, error) {
	bin, err := ResticBinary()
	if err != nil {
		return "", err
	}
	if DevLayout() {
		return bin, nil
	}
	return TrustedFile(bin)
}
