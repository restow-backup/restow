# Restow endpoint agent

The Restow agent backs up servers and client machines to a Restow instance. It is a
small Go program (standard library only, no third-party Go dependencies) that drives
[restic](https://restic.net) and talks to the instance over HTTPS.

- **One agent, two profiles.** `server` (daily backup, default 22:00) and `client`
  (back up when the Restow instance becomes reachable, at most once per 4 hours).
- **File-based backups with restic.** Deduplicated, compressed, encrypted with a
  repository password that is unique per endpoint. No disk images, no bare-metal
  restore (see [Known limits](#known-limits)).
- **Outbound only.** The agent opens no port. It connects to the instance over HTTPS
  and to nothing else.
- **Append-only.** The agent writes to a restic repository that the instance exposes in
  append-only mode: it can add backups but never delete or overwrite them. Retention,
  pruning and integrity checks run on the Restow server only.
- **Restores never overwrite.** They go into a new folder on the machine (or are
  downloaded from the UI).
- **Restore tests.** After every backup the agent records the SHA-256 of up to 20 random
  files. The server later asks the agent to restore those files from the snapshot and
  compares the hashes.

Supported in 0.1.0: **Linux** (systemd, x86_64 and aarch64) and **macOS** (13 Ventura or
newer, Intel and Apple Silicon). **Windows is planned for a later release**; the code
keeps the platform specifics behind small per-OS files so it can be added, but nothing
Windows-specific ships in 0.1.0.

## Installing

The Restow UI (Endpoints > New server / New client) shows the command and, apart from
it, a one-time token that is valid for 24 hours:

```sh
# Linux
curl -fsSL 'https://<your instance>/install/linux.sh' | sudo sh
# macOS
curl -fsSL 'https://<your instance>/install/macos.sh' | sudo sh
```

The script asks for the token and reads it with hidden input, so the token appears in
neither the command line, the process list nor the shell history. For unattended
installs (RMM, scripts) put the token into a file only root can read and pass its path:

```sh
curl -fsSL 'https://<your instance>/install/linux.sh' | sudo RESTOW_TOKEN_FILE=/root/restow-enrollment.token sh
```

(On macOS root's home is `/var/root`; the UI shows the path for the system.) Delete the
file afterwards; the installer warns when other users can read it.

(`RESTOW_TOKEN` in the environment still works, for example in a root shell; avoid it
with `sudo VAR=value`, which puts the value into the process list.)

The script (served by your instance with its own URL, the agent version and the
release signing key filled in):

1. detects the CPU architecture and downloads `SHA256SUMS`, its signature
   `SHA256SUMS.sig`, `restow-agent`, `restic` and `THIRD_PARTY_NOTICES.txt` from
   `<instance>/install/agent/<version>/`,
2. checks the maintainer's signature over `SHA256SUMS` (see
   [Release signing](#release-signing)) and the SHA-256 of both binaries and of the
   notices before it executes anything; an unsigned or changed release is refused,
3. checks that every folder of the install location belongs to root and is not
   writable by group or others, and installs `restow-agent` and `restic` into
   `/opt/restow-agent/bin` (Linux) or `/Library/Application Support/Restow/bin`
   (macOS), staged under random names (`mktemp`) and renamed into place, and the license
   notices, readable for all, one level up (`/opt/restow-agent/THIRD_PARTY_NOTICES.txt`,
   `/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt`),
4. installs and enables the service (systemd unit `restow-agent.service`, LaunchDaemon
   `com.restowbackup.agent`) and links `/usr/local/bin/restow-agent` to the agent where
   that folder belongs to root,
5. runs `restow-agent enroll` (exchanges the token for credentials, checks that the
   instance and the backup repository accept them),
6. starts the service and prints the status.

It is safe to run again: it repairs or upgrades in place, keeps an existing enrollment
and never installs twice. An installation below `/usr/local`, left by a pre-release build,
is moved to the new location; its binary is never executed in the process.

**Signature check on the machine.** The script uses `ssh-keygen -Y verify` (OpenSSH 8.1
or newer: every supported macOS, Debian 11+, Ubuntu 20.04+, RHEL 9) or, on Linux, OpenSSL 3
(the same signature). Systems with neither (RHEL, Rocky and Alma Linux 8, Amazon Linux 2)
are refused with an explanation; there, check the signature on another machine
([by hand](#checking-a-release-by-hand)) and give the script the SHA-256 of the checked
`SHA256SUMS`: `... | sudo RESTOW_SHA256SUMS_SHA256=<sha256> sh`. The agent itself checks
signatures without any tool, so self-updates work on these systems.

The script prints the fingerprint of the release key it checked against
(`signature: OK (release key SHA256:...)`). The release key's fingerprint is

```
SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o (ED25519, restow-agent-release)
```

and it is also published in the release notes (the Security section of `CHANGELOG.md` and
the GitHub release). Compare the printed one with it: the first installation trusts the
script your instance serves, and this comparison is how you rule out a compromised
instance. `ssh-keygen -l -f agent/release-signing.pub` prints the same value from the key in
the repository.

**Hooks** (commands before and after a backup) are off on a new machine. Allow them with
`--hooks=scripts` or `--hooks=any` (see [Hooks](#hooks)):

```sh
curl -fsSL 'https://<your instance>/install/linux.sh' | sudo sh -s -- --hooks=scripts
```

Remove the agent:

```sh
sudo /opt/restow-agent/bin/restow-agent uninstall      # macOS: sudo '/Library/Application Support/Restow/bin/restow-agent' uninstall
curl -fsSL 'https://<your instance>/install/linux.sh' | sudo sh -s -- --uninstall
```

This removes the service, the stored credentials, the working data, the license notices and the binaries
(also those of a pre-release installation below `/usr/local`). Backups already stored on
the instance are kept;
revoke the endpoint in the Restow UI to finish the removal there. (The UI can also send
an `uninstall` task.)

**macOS: grant Full Disk Access.** macOS protects Desktop, Documents, Downloads, iCloud
Drive and other folders. Add `/Library/Application Support/Restow/bin/restow-agent`
under System Settings > Privacy & Security > Full Disk Access (on managed Macs: a Privacy
Preferences Policy Control profile through the MDM; in the file dialog, Cmd+Shift+G opens
the path). Without it those files are skipped, the backup finishes as `partial` and the
run log says so. If protected folders are still reported after that, also add
`/Library/Application Support/Restow/bin/restic`.

## Command line

```
restow-agent enroll        Enroll this machine (RESTOW_TOKEN and RESTOW_URL from the environment)
restow-agent run           The service main loop (what systemd / launchd execute)
restow-agent status        Local state, no root needed (--json for scripts)
restow-agent backup-now    Run one backup in the foreground (exit 0 ok, 3 partial, 1 failed)
restow-agent service ...   install | start | stop | restart | status
restow-agent hooks ...     status | off | scripts | any: whether hooks from the server run here
restow-agent uninstall     Remove the agent (--yes, --keep-logs)
restow-agent version       Version, commit, build date (--short for the number only)
```

`--debug` (or `RESTOW_DEBUG=1`) turns on verbose logging. `enroll --force` enrolls again
with a new token (the old endpoint stays on the server until you revoke it).
`enroll --hooks=off|scripts|any` sets the hook policy of a new enrollment (default off;
a new enrollment of an enrolled machine keeps its policy).
`enroll --allow-insecure-http` exists for local development only and is refused by the
install scripts unless `RESTOW_ALLOW_INSECURE_HTTP=1` is set; it makes the agent accept
`http://` URLs and prints a warning every time.

## What the agent does

**Service loop.** At start, and then every 5 minutes (plus or minus 60 seconds), the agent
sends a heartbeat and receives tasks. While the instance is unreachable it retries after
30 seconds, doubling up to 5 minutes, so a laptop that just got network is noticed
quickly; a system suspend (clock jump) triggers an immediate check. The configuration is
fetched at start, hourly, on an `update_config` task and before every backup.

**Schedule.**

| Kind | Behavior |
| --- | --- |
| `daily` | Runs at `timeOfDay` in `timeZone` (DST-correct). A missed slot (machine off) is caught up once when the machine is back. A fresh enrollment waits for the next slot. Each endpoint starts 0 to 10 minutes late, derived from its id, so many servers do not hit the instance in the same second. |
| `interval` | Every `intervalMinutes` (minimum 5). The first run starts right after enrollment. |
| `on_connect` | Starts as soon as the instance is reachable, at most once per 4 hours (`intervalMinutes`, if the server sends it, overrides the 4 hours). |
| `none` | Server 0.2.1 and later: the machine is in no backup job. Nothing starts on its own (no slot, no retry, no resumption); a backup request from the server is ignored and `restow-agent backup-now` refuses. Heartbeats, restores and self-updates go on. `restow-agent status` shows "waiting for a backup job". The server sends no paths and no hooks with it, so an older agent, which does not know the kind and falls back to its profile's default, stops such a run with `no_paths` before restic or a hook starts. |

A backup that was interrupted (agent stopped, machine slept, connection lost) resumes as
soon as the instance is reachable, without waiting for the next slot. After a failed run
the agent retries after 5, 15, 30, 60 and 60 minutes, then waits for the next regular
slot. A failure that is caused by a lost connection counts as an interruption, not as a
failure.

**Backup run.** Pre hook, `restic backup`, sample of up to 20 files, post hook, report.
Configured paths that do not exist are skipped and logged; if none exists the run fails
with an explanation. A path that is a symbolic link is backed up through its target
(restic would otherwise store the link itself; on macOS `/etc` and `/var` are links). The
agent always excludes its own cache and temporary folders and every folder named
`Restow-Restore-*`, so earlier restores are not backed up again. Snapshots carry the
host name recorded at enrollment and the tag `restow-agent`.

- `bandwidthKbps` is read as **kilobits per second** (as the name says) and converted to
  restic's `--limit-upload` in KiB/s, rounded up. Null or 0 means unlimited. The server
  works out which time window of the machine's job is active when the agent asks for its
  configuration, so `bandwidthKbps` is already the limit that applies at that moment and
  the agent knows nothing about windows. A backup reads the configuration again when it
  starts and keeps the limit it found for its whole run; a window that begins or ends
  during the run changes nothing for it.
- `excludeLargerThanBytes` (optional, sent only when the machine's job sets a size limit)
  is passed to restic as `--exclude-larger-than <bytes>`; files above it are not backed up
  and the run's log says so. Absent or 0 means no limit (restic would read a literal 0 as
  "skip every file with content", so the agent never passes it). Agents older than 0.2.0
  ignore the field.
- `hooks.pre` / `hooks.post` run only as far as the machine allows (see [Hooks](#hooks)).
- `onlyOnAcPower` is checked before a scheduled start and, if the device is on battery,
  the backup waits (see the limits below). An administrator's "Back up now" is not held
  back. A running backup is not stopped when the charger is unplugged.
- `useVss` is a Windows option and has no effect on Linux and macOS (it is logged).
- A backup is limited to 72 hours; a wedged restic is then stopped and the run fails.

**Restore task.** Restores into `targetDir`, or by default into
`<first backed-up folder>/Restow-Restore-<yyyyMMdd-HHmmss>` (the first backed-up folder
that only root can change; else `/` on Linux, `/Users` on macOS). The target must be a
plain absolute path (no `..`, `.`, double or trailing slash; code `invalid_task`), its
parent must exist and, like every folder above it, be changeable by root only (a
world-writable folder with the sticky bit such as `/tmp` is fine; code `target_unusable`):
a user who owns a folder on the way could swap the new folder for a link while root
restores into it. The target must not exist or must be an empty folder owned by root,
otherwise the run fails with code `target_not_empty` and nothing is touched. A new target
is created with mode 0700 (the restored files keep their own modes and owners). restic is
additionally told `--overwrite never` and `--verify`. Selected paths are escaped so that
file names with `*`, `?` or `[` match exactly.

**verify_sample task.** Restores the listed files into a temporary folder below the
agent's data directory, compares SHA-256, deletes the copy and reports per file
(`hash_mismatch`, `missing`, ...).

**Sample rule.** Up to 20 random regular, non-empty files of the snapshot, none larger
than 256 MiB, at most 1 GiB in total. The hash is taken from the file on disk, but only
for files that are provably unchanged since the snapshot (same size and modification time
before and after hashing). A later mismatch therefore points at the backup, not at an edit
made afterwards.

**Run reporting.** `POST /agent/v1/runs` at start, progress every 5 seconds (best effort;
restic is asked for a status message every 2 seconds, `RESTIC_PROGRESS_FPS=0.5`, so each
report is fresh; 0.1.x agents reported every 10 seconds), and a finish report with status (`succeeded`, `partial`, `failed`),
snapshot id, statistics, errors (at most 100), the sample and the last 200 log lines with
secrets masked. If the instance cannot be reached when a run ends, the report is kept in
an outbox on disk and delivered with a later heartbeat. A run that was in progress when
the agent or machine died is reported as `failed` with code `interrupted` at the next
start.

**Self-update.** Every 6 hours (and one minute after start) the agent asks
`GET /agent/v1/update`. For a newer version it first downloads the release's
`SHA256SUMS` and `SHA256SUMS.sig` from the instance and checks the signature against the
key compiled into the agent; nothing of an unsigned or wrongly signed release is used.
Then it downloads the agent (and restic, when the release pins another one) and the
release's license notices from the same host, checks each file against its signed SHA-256
(the notices are installed first, mode 0644; a release without them updates as before), stages it with
`O_CREATE|O_EXCL|O_NOFOLLOW` under a random name in the root-owned bin folder, runs the
new agent's `version` (only after the checks) and renames it over the current binary
(the old one stays as `restow-agent.prev`). The service manager then restarts the agent.
Updates are only applied while no run is active. Development builds (`0.0.0-dev`) and
builds without a release key (a checkout whose `release-signing.pub` is only a
placeholder, such as a fork before its own key ceremony) never update. An administrator can pause automatic agent
updates for a whole tenant (Servers & endpoints › Inventory; `PUT /api/v1/endpoints/agent-updates`).

**Start-up check.** The service only works from the root-owned location: before anything
else the agent checks that its binary, restic and every folder above them belong to root
and are not writable by group or others. An agent that starts from `/usr/local/bin`,
where pre-release builds installed it, installs its own signature-checked release into
the root-owned location, points the systemd unit or LaunchDaemon at it (launchd is
reloaded by a one-shot job, `com.restowbackup.agent.reload`, outside the agent's own job)
and lets the service manager start it from there; that process removes the old files. While the installation is not safe the agent runs no backup, no
task and no hook and says why in its log, every 30 minutes; re-running the install
command repairs it. The service definition is rewritten when it differs from what the
running version installs (location, hardening).

## Hooks

Hooks are commands the Restow server asks the agent to run before and after a backup, for
example a database dump. They run as root, so **the machine decides** whether it runs them,
and only root on the machine can change that. The policy is stored in `state.json`; the
server cannot write it, it only sees it in the heartbeat and refuses hook settings the
machine would not run.

| Policy | Set with | What runs |
| --- | --- | --- |
| `off` (default) | `restow-agent hooks off` | Nothing. A configured hook is skipped; the backup runs and is `partial` with code `hooks_not_allowed`. |
| `scripts` | `restow-agent hooks scripts`, installer `--hooks=scripts` | Only a script named in the hook (for example `db-dump`) in `/etc/restow-agent/hooks.d`: a regular executable file owned by root, not writable by others, in a folder only root can change. It runs directly, without a shell and without arguments. |
| `any` | `restow-agent hooks any`, installer `--hooks=any` | Any command, through `/bin/sh -c`. Whoever can change the endpoint's settings in Restow (and signed in within the last ten minutes) can then run commands as root on the machine. |

Hooks run in a reduced environment (plus `RESTOW_ENDPOINT_ID`, `RESTOW_RUN_ID`,
`RESTOW_HOOK`, and `RESTOW_BACKUP_STATUS` for the post hook). Timeouts: 60 minutes (pre)
and 30 minutes (post); on a timeout the whole process group is stopped. Their output goes
into the run log. A failing pre hook stops the backup (the data may be inconsistent); the
post hook still runs. A failing post hook turns a successful backup into `partial`. Hooks
must not print secrets: the agent masks its own secrets and common secret patterns,
nothing more. The policy is read at every backup, so a change applies without a restart;
the server learns it with the next heartbeat (within five minutes).

**Networking.** HTTPS only (TLS 1.2 or newer, system trust store, redirects to `http://`
refused). Calls have timeouts and retry with exponential backoff and jitter, honoring
`Retry-After`; requests that are not safe to repeat are only retried when they cannot
have reached the server. Errors say what to do: expired or used token ("create a new one
in the UI"), revoked endpoint, untrusted certificate, DNS and firewall problems. Proxy
settings (`HTTPS_PROXY`, `NO_PROXY`) and a private CA bundle (`SSL_CERT_FILE` on Linux)
are passed on when they are set in the service environment, for example with
`systemctl edit restow-agent`.

## Security model

- **Outbound only.** No listening socket. The instance never connects to the endpoint;
  tasks travel in the answer to the agent's heartbeat.
- **Append-only is enforced by the instance**, not by the agent: the agent authenticates
  to the restic REST endpoint with its own secret, and that endpoint refuses deletes and
  overwrites (except for lock files). The agent also never calls `forget`, `prune` or any
  delete operation. The integration tests run the real agent against restic's
  `rest-server --append-only` and assert that `restic forget --prune` with the agent's
  credentials fails and leaves the snapshots in place.
- **The agent never holds credentials of the storage target.** It only knows its agent
  secret and the repository password of its own repository.
- **One repository and one password per endpoint.** The password is generated by the
  server, stored there encrypted with the tenant's key (so an administrator can restore
  even if the endpoint is gone) and given to the agent at enrollment.
- **Secrets at rest.** `/etc/restow-agent/state.json` (mode 0600, directory 0700, owner
  root) holds the agent secret and the repository password in plain text; the agent
  corrects looser permissions and refuses a file owned by someone else. Nothing else
  secret is stored. `status.json` is world-readable and contains no secrets.
- **Secrets in use.** The enrollment token is read from the environment, never from a
  flag or URL, and removed from the environment at once. restic receives the repository
  password and the REST credentials only through environment variables, never on a
  command line. Child processes (restic, hooks) inherit only an allowlist of variables.
- **Secrets in logs.** Everything the agent logs, the run log tail sent to the server and
  error messages pass a redactor: exact secret values (and their URL-encoded forms),
  `rsea_`/`rset_` tokens, `Authorization` headers, credentials inside URLs and
  `NAME=value` pairs whose name suggests a secret. The integration tests check the
  agent log, the command output and the log tail for the real secrets.
- **Signed releases.** Every agent release is signed by the maintainer with an Ed25519
  key that never leaves the maintainer's machine (see [Release signing](#release-signing)).
  The signature covers the release's `SHA256SUMS`, which lists the SHA-256 of every agent
  and restic binary and of the license notices installed with them. The public key is compiled into the agent and written into the
  install scripts, so a compromised Restow instance cannot make an installed agent run a
  binary of its own: the self-update refuses anything that is not signed with that key.
  Limit: the first installation trusts the install script the instance serves (as any
  `curl | sh`); to rule out a compromised instance there, compare the key fingerprint the
  script prints with the published one, or check the release by hand. restic itself is
  pinned in `tools.env` with checksums that were verified against the GPG-signed
  `SHA256SUMS` of the official release.
- **Root-owned installation.** The binaries live in `/opt/restow-agent/bin` (Linux) or
  `/Library/Application Support/Restow/bin` (macOS). The installer and the agent refuse a
  location that a user other than root could change (owner root, no group or other write
  permission, along the whole path). That is why the agent does not live below
  `/usr/local`, which belongs to a user on Intel Macs with Homebrew.
- **Hooks need the machine's consent** (see [Hooks](#hooks)). With the policy `any`,
  whoever can change the endpoint's configuration in Restow can run commands as root on
  that machine; with `off` (default) or `scripts` they cannot.
- **The repository is on the instance.** The agent sends its secret to the restic
  repository, so it only accepts a repository URL on the instance's own host (scheme and
  host name), whatever the enrollment answer or `state.json` says.
- **The enrollment token** never appears in a command line, URL or log: the installer
  reads it with hidden input or from a root-only file and hands it to `enroll` in the
  environment of that one process.
- **Service hardening.** The agent runs as root and must read everything and restore
  anywhere, so the file system stays fully visible and writable. The systemd unit adds
  what that still allows: `NoNewPrivileges`, `ProtectKernelTunables`,
  `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectHostname`, no kernel module loading
  (`CapabilityBoundingSet=~CAP_SYS_MODULE`, `SystemCallFilter=~@module`),
  `RestrictNamespaces`, `RestrictRealtime`, `LockPersonality`,
  `SystemCallArchitectures=native` and `UMask=0077` (launchd: `Umask` 077). Not used, on
  purpose: `ProtectSystem`, `ProtectHome`, `PrivateTmp` (backups of arbitrary paths and
  restores into them), `ProtectKernelModules` (hides `/usr/lib/modules` from a backup of
  `/`), `PrivateDevices` and `ProtectClock` (device access for LVM or fsfreeze hooks and
  restores of device nodes). Hooks inherit the hardening: a hook that needs namespaces
  (rootless containers) does not work.
- The service runs with low CPU and I/O priority and is restarted by systemd / launchd if
  it stops.

## Files

| Path | Content |
| --- | --- |
| `/opt/restow-agent/bin/{restow-agent,restic}` (macOS: `/Library/Application Support/Restow/bin/`) | Binaries, owned by root (`restow-agent.prev`: previous agent after an update) |
| `/opt/restow-agent/THIRD_PARTY_NOTICES.txt` (macOS: `/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt`) | License notices of the agent, Go, restic and the modules in restic (mode 0644) |
| `/usr/local/bin/restow-agent` | Link to the agent for administrators, only where `/usr/local/bin` belongs to root |
| `/etc/restow-agent/hooks.d/` | Hook scripts root allowed for the `scripts` policy |
| `/etc/restow-agent/state.json` | Enrollment: instance URL, endpoint id, agent secret, repository URL and password, hook policy (0600) |
| `/var/lib/restow-agent/status.json` | Runtime status for `restow-agent status` (no secrets) |
| `/var/lib/restow-agent/cache` | restic cache (metadata of the repository; can grow to a few GB for large repositories and can be deleted) |
| `/var/lib/restow-agent/{tmp,restic-tmp,outbox}` | Temporary restore copies, restic option files, undelivered run reports |
| `/var/log/restow-agent/agent.log` | Agent log, rotated at 5 MB, 3 files kept (Linux: also in the journal; macOS: `launchd.log` for crash traces) |
| `/etc/systemd/system/restow-agent.service` | systemd unit (Linux) |
| `/Library/LaunchDaemons/com.restowbackup.agent.plist` | LaunchDaemon (macOS) |

## Build

Go is not required on the host; the scripts use the pinned `golang` image (`GO_IMAGE` in
`tools.env`) when no `go` is on the PATH. The Go version is 1.26 or newer (`go.mod`).

```sh
./build.sh                          # development build 0.0.0-dev, all four targets into dist/<os>-<arch>/
./build.sh --version 0.1.0          # a release build (needs the release key in release-signing.pub; signed separately)
```

`build.sh` cross-compiles `linux/amd64`, `linux/arm64`, `darwin/amd64` and `darwin/arm64`
with `CGO_ENABLED=0 -trimpath -buildvcs=false` and the version injected through
`-ldflags`, downloads the pinned restic release for every target and verifies its SHA-256
against `tools.env` before unpacking, and writes checksums:

```
dist/<os>-<arch>/restow-agent
dist/<os>-<arch>/restic
dist/<os>-<arch>/SHA256SUMS
dist/SHA256SUMS                  <- all files, relative paths: the file the maintainer signs
dist/SHA256SUMS.sig              <- added by the release (see Release signing)
dist/VERSION  dist/RESTIC_VERSION
```

Options: `--version X.Y.Z` (or `RESTOW_VERSION`), `--out DIR`, `--targets "linux-amd64 ..."`,
`--no-restic`. `RESTOW_COMMIT` and `SOURCE_DATE_EPOCH` make the embedded commit and date
explicit. The restic version and all checksums live in `tools.env`;
`scripts/pin-tools.sh restic <version>` prints updated lines after verifying the release
signature.

The Restow server serves `dist/` as `/install/agent/<version>/...` (`SHA256SUMS` and
`SHA256SUMS.sig` byte for byte) and the files in `install/` as `/install/linux.sh` and
`/install/macos.sh`, replacing the placeholders `__RESTOW_URL__` (the public URL of the
instance), `__RESTOW_VERSION__` and `__RESTOW_RELEASE_KEY__` (the key line of
`release-signing.pub`, empty for the placeholder). It offers only signed releases as
updates.

## Release signing

Agent releases are signed with an Ed25519 key that only the maintainer holds, in the
OpenSSH signature format (`ssh-keygen -Y sign`, namespace `restow-agent-release`) over
the release's `SHA256SUMS`. Why this format: the stock `ssh-keygen` of every supported
macOS and of current Linux distributions creates and checks it, so neither the maintainer
nor an operator needs extra tools (macOS's LibreSSL cannot do Ed25519; minisign or
signify are not installed anywhere by default); OpenSSL 3 can check the same signature on
Linux; and the agent checks it with the Go standard library. The signature covers the
checksum list, which in turn covers every binary of the release.

The public key lives in `release-signing.pub` at the root of this folder (fingerprint
`SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o`, ED25519, `restow-agent-release`). It is
compiled into the agent (`go:embed`) and written into the install scripts by the server. The
file in this repository has held that key since 0.1.0. In a checkout where it is only a
placeholder (a fork before its own key ceremony), release builds fail (`build.sh` refuses
any version but a development build, `*-dev`), agents install no updates and the install
scripts only install development builds (and only with `RESTOW_ALLOW_UNSIGNED_DEV=1`, which
a release version ignores).

### Key ceremony (once)

Done for 0.1.0: the key with the fingerprint above was created this way, its public half is
committed as `release-signing.pub` and the fingerprint is in the release notes. The steps
stay here for a key replacement (see below) and for forks with their own key.

On the maintainer's own machine, not on a server or CI runner:

```sh
scripts/release/sign-agent.sh --keygen ~/restow-keys/restow-agent-release
# the same by hand:
ssh-keygen -t ed25519 -a 100 -C restow-agent-release -f ~/restow-keys/restow-agent-release
```

1. Choose a long passphrase and keep it in the password manager.
2. Copy `~/restow-keys/restow-agent-release.pub` over `agent/release-signing.pub` (one
   line, `ssh-ed25519 AAAA... restow-agent-release`), commit it and publish its
   fingerprint (`ssh-keygen -l -f agent/release-signing.pub`) in the release notes.
3. Back up the private key file offline, at least twice (for example an encrypted USB
   stick in a safe and a password-manager attachment); never into a repository, a cloud
   drive without end-to-end encryption or CI. Without it no further agent update can be
   installed by the agents in the field, only by re-running the installer with a new key.
4. Test once: `scripts/release/sign-agent.sh` signs nothing without a draft, so sign a
   scratch file: `ssh-keygen -Y sign -f <key> -n restow-agent-release <file>` and check it
   with `scripts/release/verify-agent-signature.sh <file> <file>.sig agent/release-signing.pub`.

If the key is lost or leaks: create a new one, commit the new public key and release a
new version. Agents in the field only accept the key compiled into them, so after a
**leak** every machine must be re-installed with the install command (the old key could
sign a malicious update); after a **loss** the same is needed to move them to the new key.

### Signing a release

The release workflow (`.github/workflows/release.yml`) builds the agent for every target,
puts its `SHA256SUMS` on the draft GitHub release as `agent-SHA256SUMS` and waits in the
environment `agent-release-signing` (configure it with the maintainer as required
reviewer). On the signing machine:

```sh
scripts/release/sign-agent.sh v0.1.0 --key ~/restow-keys/restow-agent-release
```

The script downloads `agent-SHA256SUMS` with `gh`, shows it (repository, release with the
short commit, the fingerprint of the release key and the checksum list), signs it with
`ssh-keygen` (asks for the passphrase), verifies the signature against
`agent/release-signing.pub` as committed at the tag, uploads `agent-SHA256SUMS.sig` to the
draft and lets the workflow continue (approves the waiting job, or re-runs it when the
environment is not set up). The workflow checks that the signature covers exactly its
build, builds the images with the signed agent (the Dockerfile checks the signature
again), runs the release smoke, checks the signature once more and only then publishes
the draft. The private key never enters the repository or CI.

The script runs from any directory and needs no clone of the repository with the tag. The
repository is `--repo <owner/name>`; without it the script uses the GitHub repository of the
clone it lives in (as `gh repo view` reports it) and otherwise `restow-backup/restow`.
It reads the tag, its commit and `agent/release-signing.pub` at the tag from that clone
when the clone belongs to the repository and has the tag (after a `git fetch --tags`
that it tries first). In every other case (a clone without the tag, a copy of the
source tree without a GitHub remote, no repository at all) it reads them from GitHub
with `gh api`: the tag is resolved to its commit (an annotated tag is dereferenced)
and the public key is read at that commit. The new signature is always checked against the
key committed at the tag, never against a key file from the working directory, and `gh`
needs to be logged in with push rights to the repository either way.

```sh
# from anywhere, for a release of another repository (a fork with its own key)
scripts/release/sign-agent.sh v0.2.0 --repo my-org/restow --key ~/restow-keys/restow-agent-release
```

### Checking a release by hand

```sh
scripts/release/verify-agent-signature.sh SHA256SUMS SHA256SUMS.sig agent/release-signing.pub
# or with ssh-keygen alone:
printf 'restow-agent-release %s\n' "$(cut -d ' ' -f 1-2 agent/release-signing.pub)" > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I restow-agent-release -n restow-agent-release -s SHA256SUMS.sig < SHA256SUMS
```

`SHA256SUMS` and `SHA256SUMS.sig` of a release are on the GitHub release
(`agent-SHA256SUMS`, `agent-SHA256SUMS.sig`) and on every instance at
`/install/agent/<version>/`. For a machine without `ssh-keygen` 8.1+ or OpenSSL 3, check
on another machine and pass the SHA-256 of the checked `SHA256SUMS` to the installer
(`RESTOW_SHA256SUMS_SHA256`).

## Tests

```sh
scripts/test.sh                 # gofmt, go vet for all four targets, unit tests with the race detector, build.sh test, ShellCheck
scripts/test-build.sh           # build.sh with a stand-in go (layout, checksums, --no-restic); no Go, Docker or network
scripts/integration.sh          # real restic + rest-server (append-only) on Linux, in Docker
scripts/integration.sh --native # the same natively on this machine (macOS or Linux)
scripts/test-install.sh         # install/linux.sh end to end in a container (fake systemd)
scripts/test-install-macos.sh   # install/macos.sh on a Mac, unprivileged, relocated root
scripts/test-systemd.sh         # real systemd (privileged container): hardening and the move of an older installation (RESTOW_TEST_OLD_REF)
scripts/lint.sh                 # ShellCheck only
```

The install test builds a release from a copy of the checkout with a throwaway signing
key and checks: the signature (ssh-keygen and OpenSSL 3), a re-hashed `SHA256SUMS`, an
unsigned release, systems without a verifier and the manual pin, the root-owned layout
and its refusal of a folder others can write to, `--hooks`, the token file, and the move
of an installation below `/usr/local` without running its binary. `test-systemd.sh` runs the
integration tests as a transient service with exactly the unit's hardening, checks that
the hardening holds (no privileges from setuid binaries, no kernel modules, no namespaces,
`/proc/sys` read-only, umask 077) while a backup and restore of `/etc` and `/usr/lib` stays
complete, and lets an older agent (built from `RESTOW_TEST_OLD_REF`, installed by its own
installer below `/usr/local`) self-update to a signed build of the checkout and move
itself to `/opt/restow-agent`.

The integration tests download restic and rest-server with the pinned checksums. They
prove: backup with exclusions and hooks, an incremental backup, restore of a folder and of
a whole snapshot into new folders (hash comparison, symlinks, unicode and glob characters
in names), refusal to restore into a non-empty folder, `verify_sample` with matching and
wrong hashes, the append-only guarantee, interruption and automatic resume, and the
shipped binary through `enroll`, `status`, `backup-now`, `run` and `uninstall`.

What was and was not exercised for 0.1.0, as limits you should know before you roll the
agent out:

- The unit and integration tests ran on Linux (Debian, arm64, in Docker) and natively on
  macOS 26 (Apple Silicon) with restic 0.19.1 and rest-server 0.14.0.
- `scripts/test-install.sh` ran `install/linux.sh` end to end in a Linux container,
  `scripts/test-install-macos.sh` ran `install/macos.sh` natively on macOS 26 as a normal
  user in a relocated root (signature check with the stock `ssh-keygen`, paths with
  spaces, the move of a `/usr/local` layout), and the release smoke (check 10) runs the
  real install script through the instance's Caddy edge.
- `scripts/test-systemd.sh` ran under a real systemd 252 (Debian 12, privileged
  container): the integration tests inside the unit's hardening, and an older
  installation below `/usr/local` that self-updated to a signed build and moved itself
  to `/opt/restow-agent`.
- Not exercised: a real launchd (the LaunchDaemon, its reload job and the `launchctl`
  sequences are tested with recorders), the amd64 binaries (cross-compiled and vetted,
  not run), and RHEL-family systems with OpenSSH 8.0 (simulated with stand-in tools).
  Treat the first installation on each platform as a pilot:
  one test machine (on macOS, if you have one, an Intel Mac with Homebrew), then
  `restow-agent status`, `restow-agent backup-now` and a restore of a folder before you roll
  it out.

## Dependencies

The agent uses the Go standard library only (BSD-3-Clause, part of the Go toolchain).
There is no `go.sum` because there is nothing to fetch.

| Component | License | How it is used |
| --- | --- | --- |
| [restic](https://github.com/restic/restic) 0.19.1 | BSD-2-Clause; the 79 Go modules compiled into it are Apache-2.0, MIT, BSD-3-Clause, BSD-2-Clause and, for `github.com/hashicorp/golang-lru/v2`, MPL-2.0 (used unmodified) | External binary shipped next to the agent and executed with `RESTIC_*` environment variables |
| [rest-server](https://github.com/restic/rest-server) 0.14.0 | BSD-2-Clause | Integration tests only, not shipped |
| Go toolchain (`golang` image) | BSD-3-Clause | Build and tests only |
| [ShellCheck](https://www.shellcheck.net) | GPL-3.0 | Linting only, run from its Docker image, not part of any build output |

restic and every Go module compiled into it are listed in `THIRD_PARTY_NOTICES.md` (section
"Go modules compiled into the restic binary"; the license and NOTICE files, taken from each
module at the version in the binary, are in `licenses/restic-deps/`, checked against the pinned
binaries by `scripts/restic-licenses.mjs check` in CI). Their texts ship in the Restow image and on
every machine: each release target carries `THIRD_PARTY_NOTICES.txt` (built by `build.sh` from
`agent/THIRD_PARTY_NOTICES.txt`: the agent's own license with the copyright line of `NOTICE`,
Go's, restic's and those of the modules in restic), listed in the signed `SHA256SUMS`, installed
readable for all at `/opt/restow-agent/THIRD_PARTY_NOTICES.txt` or
`/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt`, replaced by every self-update and
removed by the uninstall. The GitHub release attaches it as
`restow-agent-THIRD_PARTY_NOTICES.txt`.

## License

The agent is part of the Restow core and is licensed under the Apache License,
Version 2.0 (SPDX: `Apache-2.0`); the license text is `LICENSE` and the
attributions are `NOTICE`, both in the repository root. It has no third-party
Go modules, which CI checks on every change (`scripts/ci/check-go-deps.mjs`).
restic, which the agent drives, keeps its own license, and so do the modules compiled
into it (see Dependencies); `THIRD_PARTY_NOTICES.txt` next to the installed binaries
carries all of them.

## Known limits

- **No mTLS yet.** v1 authenticates each agent with a per-agent secret over HTTPS. A
  stolen secret (root on the endpoint) allows writing new backups to that endpoint's
  repository and reading it; it does not allow deleting anything.
- **No LVM, ZFS or btrfs snapshots yet.** Consistency on Linux and macOS comes from the
  optional pre/post hooks (database dumps, `fsfreeze`, and so on). Files that change while
  they are read can end up inconsistent in the snapshot. On macOS there is no APFS
  snapshot integration either.
- **File-based only.** No disk images, no bare-metal restore. Restoring a whole machine
  means reinstalling the operating system and restoring the files.
- **Windows is not part of 0.1.0** (planned): no Windows build, installer or service, and
  therefore no VSS.
- **Power detection is best effort.** Linux reads `/sys/class/power_supply`; macOS reads
  `pmset -g batt` (a UPS counts as battery). When the state cannot be determined the agent
  assumes AC power so that a detection failure never blocks backups, and logs that once a
  day. The check happens before a scheduled start; a running backup is not interrupted.
  Systems without battery information count as AC.
- **Private CAs** must be in the operating system's trust store (or `SSL_CERT_FILE` on
  Linux); the agent has no setting of its own. The machine's clock must be correct.
- **Linux without systemd** is not supported by the installer and `service` commands; you
  can still run `restow-agent run` under another supervisor.
- **The first installation trusts the instance's install script** (see the security
  model); signatures protect the self-update and the binaries.
- **Signature tools on old systems.** RHEL, Rocky and Alma Linux 8 and Amazon Linux 2 have
  neither OpenSSH 8.1+ nor OpenSSL 3: the installer needs the manual pin there.
- **Hooks with the `any` policy** run any command the endpoint's settings in Restow name,
  as root; prefer `scripts`.
- **No second run at the same time.** A machine runs one backup, restore or restore test
  at a time; tasks queue.
- The Linux binaries are static and run on any distribution; the macOS binaries declare
  macOS 13 as the minimum (restic itself declares 12).

## Protocol notes for the server implementation

The agent implements the shared endpoint specification. Where the specification left room
the agent does this, and the server should expect it:

- Request bodies are JSON; identifiers (`endpointId`, `taskId`, `runId`, `configVersion`)
  are accepted as JSON strings or numbers and echoed in the form they arrived.
- `nextRunAt` in the heartbeat is an RFC 3339 time or `null` (for `on_connect` and when
  unknown). `configVersion` is `0` until the first configuration was fetched.
- `finish.errors` is always an array. `sample[].path` is the path as stored in the
  snapshot (an absolute path on Linux and macOS); send it back unchanged in
  `verify_sample.files[].path`. Finishing an already finished run (HTTP 409) counts as
  success for the agent.
- Runs of kind `verify_sample` report `failed` when any file is missing or differs, with
  one error per file (`code`: `hash_mismatch`, `missing`, `not_regular`, `read_error`).
- `update_config` and `uninstall` tasks have no run (the specification has no run kind
  for them). The agent fetches the configuration on `update_config`; after `uninstall` it
  removes itself and sends nothing further.
- `GET /agent/v1/update` is called without parameters; the answer may carry a relative
  `url`, which must resolve to the instance's own host. The agent installs only what
  `/install/agent/<version>/SHA256SUMS` and its signature `SHA256SUMS.sig` cover.
- The agent sends `hooks` (`off`, `scripts` or `any`, the machine's hook policy) with the
  enrollment and `hooks` plus `hookScripts` (the script names in
  `/etc/restow-agent/hooks.d`, scripts policy) with every heartbeat. The server treats an
  agent that reports no policy (a pre-release build) like `off` and refuses hooks for it.
- A task id that was already handled is ignored (the last 100 ids are remembered).
