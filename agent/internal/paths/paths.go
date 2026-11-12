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

// Paths of the recovery ISO (restow-agent recover, docs/BAREMETAL.md 10).
const (
	// RecoveryTargetRoot is where recover mounts the restored system.
	RecoveryTargetRoot = "/mnt/restow-target"
	// RecoveryRunDir holds recover's files on tmpfs (tmp, tls, log, media).
	RecoveryRunDir = "/run/restow-recovery"
	// RecoveryLibDir holds the agent, restic and the notices on the ISO.
	RecoveryLibDir = "/usr/lib/restow-recovery"
)

// WindowsInstallDir is the install prefix on Windows in the normal case. The
// real one comes from the known folder FOLDERID_ProgramFiles (paths_windows.go).
const WindowsInstallDir = `C:\Program Files\Restow`

// InstallDirFor returns the root-owned install prefix for an operating system.
func InstallDirFor(goos string) string {
	switch goos {
	case "darwin":
		return DarwinInstallDir
	case "windows":
		return WindowsInstallDir
	}
	return LinuxInstallDir
}

// InstallDir is the install prefix on this machine.
func InstallDir() string { return installDir() }

// BinDir holds the agent and restic.
func BinDir() string { return filepath.Join(InstallDir(), "bin") }

// ExeName appends the executable suffix of this system (.exe on Windows).
func ExeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// InstalledAgentBinary is where the install script and the self-update put the agent.
func InstalledAgentBinary() string { return filepath.Join(BinDir(), ExeName("restow-agent")) }

// InstalledResticBinary is where the install script and the self-update put restic.
func InstalledResticBinary() string { return filepath.Join(BinDir(), ExeName("restic")) }

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
	return systemLayout()
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

// BaremetalDir holds the layout manifest and its raw files of the last
// whole-machine backup (docs/BAREMETAL.md, 4.3). It lies in the root file
// system (or /var), so it is in the same snapshot as the system it
// describes.
func (l Layout) BaremetalDir() string { return filepath.Join(l.DataDir, "baremetal") }

// Folders of the snapshot helper on Linux (docs/BAREMETAL.md, 6.3); they
// exist only inside its private mount namespace.
const (
	SnapTreeDir = "/run/restow-agent/snaptree"
	BtrfsTopDir = "/run/restow-agent/btrfs"
)

// OutboxDir holds run reports that could not be delivered yet.
func (l Layout) OutboxDir() string { return filepath.Join(l.DataDir, "outbox") }

// SQLStagingDir is the default staging folder of the native SQL Server
// backup (Windows): SQL Server writes its backup files below it, one folder
// per instance, and restic backs them up from there.
func (l Layout) SQLStagingDir() string { return filepath.Join(l.DataDir, "staging", "sql") }

// SQLRestoreStagingDir holds the backup files fetched from the repository for
// a restore under a new name or a check (one folder per run).
func (l Layout) SQLRestoreStagingDir() string {
	return filepath.Join(l.DataDir, "staging", "sql-restore")
}

// SQLVerifyJournal lists the check copies the agent is about to restore, so
// that a copy left behind by a crash is dropped before the next check (and
// only such a copy).
func (l Layout) SQLVerifyJournal() string { return filepath.Join(l.DataDir, "sql-verify-journal.json") }

// LogFile is the rotating agent log.
func (l Layout) LogFile() string { return filepath.Join(l.LogDir, "agent.log") }

// Ensure creates the data and log directories with their intended modes
// (Unix) or DACLs (Windows). The data directory stays readable for everyone
// (status.json carries no secrets, so `restow-agent status` works without
// privileges); the restic cache below it is private. The state directory is
// created by the state package.
func (l Layout) Ensure() error { return ensureLayout(l) }

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
