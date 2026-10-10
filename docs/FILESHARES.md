# File shares (SMB and NFS): design

Status: binding design for the release that introduces file share backup, written 2026-10-10.
The infrastructure part of Phase A and Phase B (database, core, scheduler, worker) are
implemented (section 17 says what, what moved and where the build deviates); Phases C and D are
not yet. It is the blueprint the four build phases (section 17) follow;
a deviation is recorded here first, the way docs/PROXMOX.md records its own. Once a phase ships,
the operator documentation of what exists goes into this file's "How it works" sections, in the
style of [PVE.md](PVE.md).
The maintainer's answers to the open questions of the first draft (2026-10-10) are folded in;
section 18 lists them.
Audience: Restow maintainers. Edition: Community (core). Nothing of it lives in `ee/`, nothing is
behind a license feature.

A **file share** (German UI: **Freigabe**) is an SMB share (Windows server, Samba, a NAS) or an NFS
export that Restow backs up from the server side, without an agent on the file server: Restow
mounts the share read-only for the duration of one run, runs restic over it into a restic
repository of its own, and can restore into the same share, another share, or a ZIP download.
Everything is configured in the web interface.

How this document marks evidence:

- **[V]** verified in this repository (file and line cited).
- **[K]** known behaviour of the Linux kernel, Docker or restic, from their documentation or
  source as the author knows it; not re-checked in this session.
- **[I]** inferred. Phase A checks it on a real host before anything depends on it; section 16.3
  lists every such check.

---

## 0. Summary of the decisions

1. **No restart, ever.** Adding, changing, testing, browsing, backing up or restoring a share never
   restarts the api or the worker. The mounter (`apps/api/src/mounter`, it holds the Docker
   socket) gets a second operation family, the **runner**: per run it creates a temporary Docker
   volume of the `local` driver (type `cifs` or `nfs`, the credentials only in that volume's
   driver options) and a short-lived container from the running Restow image that executes a new
   Go binary, `restow-share`, with the share at a fixed path. Both are removed when the run ends
   and garbage-collected by label when the mounter starts. The existing path (compose override,
   api and worker restarted) stays exactly as it is, for NFS **storage targets** only.
2. **Tenant self-service.** Because nothing restarts, tenant admins add and manage their own
   shares. Shares on loopback or private addresses need a provider admin's approval (the IMAP rule,
   `apps/api/src/features/sources/imap-host.ts` [V]) or the installation switch that allows them.
3. **One restic repository per share** under `file-shares/<shareId>/` of the tenant's primary
   storage target, password sealed in the secret store (kind `file_share_repository`, like
   `pve_ct_repository`, `packages/db/src/schema/secrets.ts` [V]). The runner writes through a
   restic REST endpoint **served by the api on the internal network only**
   (`/internal/file-shares/restic/:shareId/*`), with a per-run credential that is append-only (or
   read-only for a restore) and expires with the run: the PVE container path
   (`apps/api/src/features/pve/restic-route.ts` [V]) generalised into one run-scoped route builder.
   Retention, check, restore check, browsing and ZIP download stay server-side through the existing
   loopback stack (`packages/core/src/endpoints/loopback.ts`, `restic-cli.ts`, `zip.ts`,
   `restore-test.ts` [V]), generalised from "an endpoint" to "a repository prefix plus a secret".
4. **NTFS permissions are backed up and restored.** `restow-share` reads the security descriptor of
   every file and folder through the cifs xattrs (`system.cifs_ntsd_full`, falling back to
   `system.cifs_ntsd` and `system.cifs_acl`) and stores them in a sidecar inside the same restic
   snapshot (`/.restow/acls.jsonl.gz`, format in 4.6). A restore writes them back where the target
   allows it, file by file, with warnings where it cannot. NFSv4 ACLs (`system.nfs4_acl`) and
   POSIX ACLs on NFSv3 go the same way, best effort. Section 6 says exactly what is and is not
   preserved.
5. **Restore** is always possible as a ZIP download and into another share that allows restores.
   Into the share itself only when that share has **Allow restore to this share** switched on (off
   by default): to the original location with a conflict policy (overwrite, keep both, skip) or
   into a new folder `Restow-Restore-<timestamp>`.
6. **Jobs are `backup_jobs` of a new kind `share`**, members point to the share
   (`backup_job_members.file_share_id`). The scheduler plans them; a dispatcher in the worker
   starts the runs within a global limit of runner containers. Retention is restic's keep
   daily/weekly/monthly, as for machines.
7. **Scheduled copy jobs** (`backup_jobs` kind `copy`): on a schedule, the newest *verified*
   restore point of share A is restored into a folder of share B (which must allow restores), in
   mode `overwrite` or `mirror`. A copy run is a restore run; the UI labels the job "Not a backup:
   no versions on the target". `mirror` deletes, inside the target folder only, what the restore
   point does not have, and is refused for a share root, for the source share itself and for a
   non-empty folder Restow did not create unless the admin confirmed it (section 4.10).
8. **Shares are not `protected_objects`.** They get their own tables (like `pve_guests`) and are
   counted side by side with mailboxes, machines and guests in every overview (section 13).
9. **Guards.** The runner checks that its mount is the expected file system type and refuses to
   back up an empty root when the previous restore point was not empty (an empty snapshot would let
   retention prune the good ones). SMB1 and `sec=ntlm` are refused. Passwords exist in plaintext only
   in memory of the api or worker and in the one run's volume options; they are redacted from every
   error and never stored outside the sealed secret.
10. **Concurrency.** One run per share at a time (a backup of it or a restore or copy into it); a
   global limit of concurrent runner containers (setting, default 2); memory limit per runner
   container with `GOMEMLIMIT` for restic.
11. **Budgets** for file share repositories are off by default and can be set per share in the web
   interface (and for all shares of a tenant). At 80 % the share warns, at 100 % new backups are
   refused, with the machine budget code (`packages/core/src/endpoints/quota.ts`) as the model.
12. **The mounter is on by default for new installations** (`deploy/install/install.sh`, opt-out
   `--no-mounter`/`--without-mounter`). Existing installations enable it from the web interface
   when the opt-in updater runs (**Enable network shares**, provider owner, through the updater's
   compose helper), otherwise the page shows the one command (section 3.9).

---

## 1. Terms

Phase C adds these rows to [GLOSSARY.md](GLOSSARY.md) before any UI string uses them, and moves
"Freigabe" out of the "Not" column of the "network share" row (the mounter's storage mount stays
"Netzlaufwerk"; "Freigabe" now means a file share and nothing else).

| Thing | English | Deutsch | Not |
| --- | --- | --- | --- |
| An SMB share or NFS export Restow backs up and restores into | file share | Freigabe | Netzlaufwerk (that is the storage mount), Share, Dateifreigabe (alone is fine in prose) |
| The short-lived container that mounts a file share for one run | runner (operators only) | Runner (nur Betrieb) | Agent, Helfer |
| The NTFS or NFS permissions of files and folders | permissions | Berechtigungen | ACLs (in the UI), Rechte |
| Restoring into the share the data came from | original location | ursprünglicher Ort | Quelle |

"Restore point", "run", "backup job", "restore check", "warning" keep their glossary meaning.

---

## 2. Architecture

```
Browser                 api (apps/api)                     mounter (ROLE=mounter, Docker socket)
  /api/v1/file-shares --> service, access rules  --exec--> POST /v1/runner/exec   (test, list: sync)
                          internal routes (runners net)     POST /v1/runner/runs   (backup, restore: async)
                          /internal/file-shares/v1/*  <--+  GET/DELETE /v1/runner/runs/:runId
                          /internal/file-shares/restic/* |      |
                                ^                        |      | docker volume create (local, cifs|nfs, o=...)
worker (apps/worker)            |                        |      | docker create/start (image of the api container)
  file-shares/dispatch.ts ------+--- POST /v1/runner/runs |      v
  monitor, retention, check,    |                        |  +---------------------------------------------+
  verify, catalog, purge        |                        +--| runner container (network: <project>_runners) |
  loopback restic (maintenance) |                           |   /usr/local/bin/restow-share run           |
scheduler                       |   restic REST (append-only|   /share   <- temp volume (ro; rw on restore)|
  file-shares.ts: due jobs ---> pg-boss file-share-backup   |   /.restow <- per-run scratch volume         |
                                |   per-run credential)     |   /cache   <- per-share restic cache volume  |
                                +---------------------------|   restic (from the image)                   |
                                                            +---------------------------------------------+
storage target: tenants' primary   file-shares/<shareId>/{config,data,index,keys,locks,snapshots}
```

### 2.1 Why a runner container

- **No restart.** The storage-target path (docs/MOUNTS.md) mounts a share into the api and the
  worker through the compose override and must recreate both [V `apps/api/src/mounter/engine.ts`].
  That is acceptable for a storage target the operator adds once, not for a tenant admin adding a
  file server on a Tuesday afternoon while restores run. A volume that only one short-lived
  container uses can be created and removed at any time.
- **Isolation.** The share's content (file names, xattrs, file data, all controlled by whoever
  controls the file server) is processed in a container that holds no application credential: no
  database URL, no master key, no Docker socket. What it holds is one run's credential (its own
  repository only) and that repository's password. Section 10.
- **xattrs need native code.** Node has no `getxattr`/`setxattr`; Go's `syscall.Getxattr` and
  `syscall.Setxattr` are in the standard library. `restow-share` lives in `agent/` next to
  `restow-pve` and uses only the standard library and `agent/internal/{restic,redact,buildinfo}` [V].
- **The probe pattern exists.** The mounter already creates a temporary volume with share options
  and a short-lived container to test a share (`DockerMountOps.probe`,
  `apps/api/src/mounter/ops.ts` [V]). The runner is that probe grown up: same Engine API client
  (`apps/api/src/updater/engine-api.ts` [V]), same labels-based cleanup (`removeStaleProbes`).

### 2.2 Why not `protected_objects`

`protected_objects.source_id` is `NOT NULL` and points to a mail source
(`packages/db/src/schema/sources.ts:198` [V]); a protected object's backups are chunk-store
snapshots with manifests, verified by the mail verify engine and restored by
`packages/core/src/restore/*` [V]. A share has none of these: no source, a restic repository, its
own runs. Forcing it into that table would mean a fake source per share and a second code path in
every consumer of `protected_objects` that branches on "is it really a mailbox". Machines
(`endpoints`) and guests (`pve_guests`) made the same choice and are counted side by side
(`apps/api/src/features/stats/guest-facts.ts`, `apps/api/src/features/dashboard/dto.ts` [V]);
shares follow them.

### 2.3 Why the api serves the runner's restic endpoint (and not a per-run worker listener)

Considered: the worker opens a per-run restic REST listener on its compose-network address
(a variant of `serveMaintenanceRepository`, `packages/core/src/endpoints/loopback.ts:86` [V]) with a
random Basic credential. Rejected because:

- the run would die with the worker process (every worker restart, every update) although the
  runner container itself keeps running; with the api the run survives a worker restart, and the
  monitor (8.3) picks it up again;
- the worker would have to listen on a non-loopback interface, a second network-facing server
  next to the api, with its own rate limiting, audit of denied requests and lock registry, all of
  which the api already has for `/agent/restic` and `/agent/pve/restic` [V];
- the append-only principal, the persisted lock registry and the quota hook are api code today
  (`apps/api/src/features/endpoints/*`, `restic-route.ts` [V]).

The api answers the runner on a path Caddy never forwards (`/internal/...`; Caddy forwards only
`/healthz`, `/readyz`, `/api/*`, `/agent/*`, `/install/*` and the maintenance status,
`Caddyfile:250-306` [V]; Phase A adds an explicit `handle /internal/* { respond 404 }` as a second
fence) and refuses any request that carries `X-Forwarded-For`, `Forwarded` or `Via` (it came
through a proxy).

### 2.4 Components

| Part | Where | Notes |
| --- | --- | --- |
| Runner operations of the mounter | `apps/api/src/mounter/runner-protocol.ts`, `runner-ops.ts`, `runner-engine.ts`, routes in `server.ts` | Same boundary rules as the rest of the mounter (`boundary.test.ts` [V]): no database, no config, no `@restow/*`. |
| `restow-share` | `agent/cmd/restow-share`, `agent/internal/share` (`mount.go`, `walk.go`, `acl.go`, `sidecar.go`, `backup.go`, `restore.go`, `api.go`) | Go, standard library only; built for `linux-amd64` and `linux-arm64` by `agent/build.sh`, copied to `/usr/local/bin/restow-share` in the runtime image (Dockerfile `agent-dist` stage [V]). Not offered as a download. |
| Run-scoped restic route | `apps/api/src/lib/restic-run-route.ts` (new), used by `features/pve/restic-route.ts` and `features/file-shares/restic-route.ts` | One builder: credential lookup, principal, prefix, lock registry, quota, audit of denials. |
| Runner API | `apps/api/src/features/file-shares/runner-routes.ts` | `/internal/file-shares/v1/*`, section 5. |
| Tenant API | `apps/api/src/features/file-shares/{routes,service,schemas,dto,audit,meta}.ts` | Section 9. |
| Core | `packages/core/src/file-shares/` (`model.ts`, `validate.ts`, `mount-options.ts` (shared test vectors only), `queues.ts`, `protection.ts`, `readiness.ts`, `sidecar.ts` (reader for ZIP and browse), `catalog.ts`, `failures.ts`) | Pure functions where possible. |
| Generalised restic stack | `packages/core/src/endpoints/{restic-cli,loopback,restic-authz,restic-rest,repository-key}.ts` | `RepositoryAccess.endpointId` becomes `repositoryKey` (cache folder); a third principal `reader`; password document format per repository kind. |
| Worker | `apps/worker/src/file-shares/` (`dispatch.ts`, `monitor.ts`, `maintenance.ts`, `catalog.ts`, `purge.ts`, `mounter-client.ts`, `register.ts`) | Section 8. |
| Scheduler | `apps/scheduler/src/file-shares.ts` | Section 8.1. |
| Database | `packages/db/src/schema/file-shares.ts`, migrations 0033-0035, `packages/db/sql/rls.sql` | Section 7. |
| Web | `apps/web/src/features/file-shares/`, generalised restore components from `apps/web/src/features/endpoints/` and `features/restore/explorer/` | Section 12. |
| i18n | `packages/i18n/resources/{en,de}/fileshares.json`, entries in `failures.json`, `backupjobs.json`, `dashboard.json`, `stats.json`, `installation.json` | |
| Smoke | `scripts/smoke/checks/12-file-shares.mjs`, a Samba container pinned in `scripts/smoke/images.json` | Section 16.4. |
| Installer, updater | `deploy/install/install.sh`, `deploy/install/test.sh`; `apps/api/src/updater/{server,mounter-enable}.ts`, `apps/api/src/features/mounts/routes.ts` | Mounter on by default, enabling from the web interface (3.9). |

### 2.5 What stays as it is

- **Storage targets on SMB stay out.** The storage mount (docs/MOUNTS.md) remains NFS only. A
  storage target must be mounted in the api and the worker permanently, which is the restart path;
  adding SMB there is not "trivial" (credentials in the compose override file, `$` escaping,
  `docker compose config` echoing them) and nobody asked for it. The mounter's
  `mountSpecSchema` keeps its single NFS member [V `apps/api/src/mounter/protocol.ts`].
- Restic repositories of machines and guests are untouched; only the shared helpers are
  generalised, with the endpoint and PVE tests as the regression net.
- Like `endpoints/` and `pve-guests/`, `file-shares/` lives on the **primary** storage target only:
  the copy mirror and the storage migration cover the chunk store (`packages/core/src/storage/copy.ts`
  [V]), not restic repositories. Section 15 lists this limit.

---

## 3. Mounter: runner operations

### 3.1 HTTP API (added to `apps/api/src/mounter/server.ts`)

All under `/v1`, bearer secret as today. Bodies up to 16 KiB as today (`MAX_BODY_BYTES` [V]).

| Route | Purpose |
| --- | --- |
| `POST /v1/runner/exec` | Synchronous, short: `{ op: "probe" \| "list", share: ShareSpec, path?: string, limit?: number }`. Creates the volume (read-only) and a container **without network** that runs `restow-share probe` or `restow-share list`, waits (at most `RESTOW_MOUNTER_RUNNER_EXEC_TIMEOUT_SECONDS`, default 60), returns `{ ok, code, detail, output }` where `output` is the runner's JSON stdout (at most 1 MiB, parsed and re-serialised by the mounter, never logged). |
| `POST /v1/runner/runs` | Asynchronous: `{ runId, kind: "backup" \| "restore", mounts: RunnerMount[], token, limits }`. Creates the volumes, the container and starts it. Returns 202 `{ runId, startedAt }` once the container started, which is when Docker mounts the share: mount failures come back here, classified (3.6). |
| `GET /v1/runner/runs` | The runner containers the mounter knows: `[{ runId, kind, state, startedAt, deadline, exitCode, finishedAt }]`. No spec, no option string, no token. |
| `GET /v1/runner/runs/:runId` | One of them, plus `stderrTail` (redacted, at most 4 KiB) once it exited. |
| `DELETE /v1/runner/runs/:runId` | Stop (SIGTERM, 30 s, SIGKILL) and clean up. Idempotent. |

`GET /healthz` keeps `busy` for share **mount** operations only. Runs do not make the mounter busy:
a backup may take hours and must not hold up an update (docs/MOUNTS.md "Updates" [V]). A mounter
recreated during a run adopts the running containers again (3.5).

`GET /v1/state` gains `runner: { ready, blockers, protocols: ["smb","nfs"], running, limit,
image }`. New blocker codes: `runner_network_missing` (the compose project has no `runners`
network: the compose file predates this release), `runner_image_unknown` (no api container of the
project to take the image from).

### 3.2 Request schemas (`runner-protocol.ts`, zod, strict)

```ts
type ShareSpec =
  | { protocol: "smb"; server: string; address: string; share: string; subfolder: string;
      username: string; password: string; domain: string | null;
      smbVersion: "3.1.1" | "3.0" | "2.1"; seal: boolean }
  | { protocol: "nfs"; server: string; address: string; export: string; subfolder: string;
      nfsVersion: "3" | "4" | "4.1" | "4.2" };

type RunnerMount = { role: "source" | "target"; share: ShareSpec; readOnly: boolean };
// backup: exactly one source (readOnly true). restore: exactly one target; readOnly false.

type RunnerLimits = { memoryMiB: number; goMemLimitMiB: number; deadline: string /* ISO */;
                      cacheKey: string /* share id of the cache volume */ };
```

Validation (shared regexes in `runner-protocol.ts`, test vectors mirrored in
`packages/core/src/file-shares/validate.ts`, a contract test checks both against
`packages/core/src/file-shares/testdata/specs.json`):

- `server`: as `normalizeNfsServer` today [V `protocol.ts`] (host name, IPv4 or IPv6, no `,`, `=`,
  `%`, whitespace). `address`: an IP literal only. The api or the worker resolved `server`,
  judged the address (10.1) and pins it; the mounter never resolves names. The kernel connects to
  `address`; `server` is only the UNC name (SMB) or the display.
- `share` (SMB): 1-80 characters, no `\ / : * ? " < > |`, no control characters, not `.`/`..`.
  Spaces are allowed (they are common); the share name goes into the volume's `device`, never into
  `o=`.
- `export` (NFS): `normalizeExportPath` [V].
- `subfolder`: relative, `/`-separated segments, each 1-255 characters, no `\`, `..`, `.`,
  control characters; at most 1024 characters in all; `""` for the root. It becomes part of the
  device (`//server/share/sub/folder` for cifs, which mounts a prefix path [K];
  `address:/export/sub/folder` for NFS), so the container only ever sees that folder.
- `username`: 1-104 characters, no `,` `=` `\` `/` control characters (a UPN `user@domain` is
  fine; `DOMAIN\user` is split by the api into `domain` and `username`). `domain`: a NetBIOS or DNS
  name, `^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$`.
- `password`: 1-256 bytes UTF-8, no control characters (U+0000-U+001F, U+007F). Commas are doubled
  when the option string is built (the kernel's escape for a literal comma in `password=` [K]);
  `$` needs no escape because no compose file is involved. Docker's local driver takes the mount
  flags (`ro`, `nosuid`, `bind`, ...) out of `o=` before the rest reaches the kernel
  (moby/sys/mount `parseOptions` [K]); a password with a comma-separated piece that equals one
  of them would lose that piece, so such a password is refused (host check 2 confirms the rest). A test covers `,` `,,` `$` `%` `=` `"`
  `'` space, backslash and non-ASCII.
- `smbVersion`: `3.1.1` (default), `3.0`, `2.1`. `1.0` and `2.0` are rejected by the schema.
  `seal` requires `3.0` or newer.
- `runId`: UUID. `token`: 43 characters base64url. `limits` within the mounter's own bounds
  (3.8), which win over the request.

### 3.3 Volume options

Built only in the mounter (`runner-ops.ts`), never accepted as text from a request.

SMB (`type=cifs`, `device=//<server>/<share>[/<subfolder>]`):

```
addr=<address>,vers=<smbVersion>,sec=ntlmssp,username=<u>,password=<p doubled commas>[,domain=<d>]
[,seal],ro|rw,soft,echo_interval=30,actimeo=1,nodfs,noperm,backupuid=0,
uid=0,gid=0,file_mode=0644,dir_mode=0755,nobrl,nostrictsync
```

- `sec=ntlmssp` is fixed: NTLMv2 inside NTLMSSP. `sec=ntlm`/`ntlmv2` (raw NTLM) and `krb5` are
  never generated (10.4). `vers=1.0` is impossible by schema.
- `addr=` pins the address the api or the worker judged. Whether Docker's local driver passes it
  through for cifs untouched (it resolves names itself for some types) is [I], checked in Phase A.
- `noperm`: the client does not check modes; the server enforces access with the account's
  rights. `backupuid=0`: files are opened with backup intent for uid 0 (the runner runs as root), so
  an account with *Back up files and directories* (`SeBackupPrivilege`, e.g. a member of Backup
  Operators) reads files whose ACL would deny it [K, verify on Windows Server 2022 and Samba: I].
- **No `cifsacl`.** It would map modes and owners from the ACL and needs the host's idmap upcall
  (`cifs.idmap`, winbind or sssd), which a Docker host does not have. The ACL xattrs this design
  reads do not need it [I]. Modes are therefore synthetic (`file_mode`/`dir_mode`), owners are 0.
- `nodfs`: DFS referrals would make the kernel connect to servers the address check never saw.
  A DFS namespace is backed up by adding its target shares directly (section 15).
- `soft`: a dead server returns errors instead of hanging the runner in D state.
- `actimeo=1` keeps metadata fresh enough for the change detection of two walks a few minutes
  apart without hammering the server.
- `nobrl`: no byte-range lock requests; a backup never locks.

NFS (`type=nfs`, `device=:<export>[/<subfolder>]`):

```
addr=<address>,vers=<nfsVersion>,ro|rw,soft,timeo=600,retrans=3,noatime[,nolock for vers=3]
```

`soft,timeo=600,retrans=3` for backups and restores: a server that goes away produces I/O errors
after about three minutes instead of a process stuck in D state that no `docker kill` frees [K].
For a restore, data written under `soft` could be lost silently on a timeout; the runner therefore
restores with restic's `--verify` on NFS targets (4.8).

SELinux: on a host with SELinux enforcing, a container cannot read a cifs or nfs mount without a
`context=` mount option [K]. The mounter adds `context="system_u:object_r:container_file_t:s0"`
when `RESTOW_MOUNTER_SELINUX_CONTEXT=true` (default false; the troubleshooting section names it
when a probe fails with "Permission denied" after a successful mount).

### 3.4 Container specification

```
Image:        the image ID of the project's running `api` container (compose labels
              com.docker.compose.project=<project>, com.docker.compose.service=api)
Entrypoint:   ["/usr/local/bin/restow-share"]
Cmd:          ["run"] | ["probe", "--expect", "<smb|nfs>"] | ["list", "--path", <p>, "--limit", <n>]
User:         0:0
Env:          RESTOW_SHARE_API_URL=<RESTOW_MOUNTER_RUNNER_API_URL>, RESTOW_SHARE_RUN_ID, RESTOW_SHARE_RUN_TOKEN,
              RESTOW_SHARE_EXPECT=<smb|nfs>, GOMEMLIMIT=<goMemLimitMiB>MiB, TMPDIR=/cache/tmp,
              RESTIC_CACHE_DIR=/cache/restic, HOME=/tmp, PATH=/usr/local/bin:/usr/bin:/bin
              (exec ops: only RESTOW_SHARE_EXPECT, HOME, PATH)
Binds:        <run volume>:/share[:ro]                  (backup and exec ops: ro; restore target: rw)
              restow-share-scratch-<runId>:/.restow     (run ops only; empty local volume)
              restow-share-cache-<shareId>:/cache       (run ops only; local volume kept per share)
HostConfig:   NetworkMode "<project>_runners" (run ops) | "none" (exec ops)
              ReadonlyRootfs true, Tmpfs {"/tmp": "size=64m,mode=1777"}
              CapDrop ["ALL"], CapAdd backup: ["DAC_READ_SEARCH","DAC_OVERRIDE"]
                                       restore: + ["CHOWN","FOWNER","FSETID"]
              SecurityOpt ["no-new-privileges:true"], Privileged false
              Memory/MemorySwap = memoryMiB, PidsLimit 256
              LogConfig json-file, max-size 1m, max-file 1
Labels:       com.restow.mounter.runner=<runId>, com.restow.mounter.runner.kind=<kind>,
              com.restow.mounter.runner.deadline=<ISO>, com.restow.mounter.runner.share=<shareId>
```

- **Image from the api container**, never from the request: the runner talks to that api, so it
  must be the same version. The mounter's own pinned image (`RESTOW_MOUNTER_IMAGE`) may lag behind
  without the updater (docs/MOUNTS.md "Updates" [V]).
- **The `runners` network** is a new compose network with `internal: true` (no route out); the api
  joins it besides `default`. A runner reaches `api:3000` and nothing else: not the database, not
  the internet, not the file server (the share is mounted by the host kernel, not from inside the
  container). Added to `docker-compose.yml` and `deploy/release/docker-compose.yml`; the mounter
  finds it by the compose labels and reports `runner_network_missing` without it.
- **The scratch volume** holds the ACL sidecar and the manifest (`/.restow`); it is on disk because
  the sidecar of a share with millions of files is hundreds of megabytes and a tmpfs counts against
  the memory limit.
- **The cache volume** keeps restic's local cache per share between runs (index and tree packs,
  encrypted with the repository key), so an incremental run does not download the index again.
  It is removed when the share is deleted (`DELETE /v1/runner/caches/:shareId`, added for the
  purge, 8.6). `TMPDIR` on it keeps restic's temporary pack files off the tmpfs.

### 3.5 Lifecycle and cleanup

1. `POST /v1/runner/runs`: refuse when `running >= RESTOW_MOUNTER_MAX_RUNNERS` (`limit`), when a
   container for `runId` exists (`exists`), or when the runner is not ready (`blocked`).
2. Create the share volume `restow-share-<runId8>-<role>` (labels as above plus
   `com.restow.mounter.runner.volume=1`), the scratch volume, the cache volume if missing.
3. Create and start the container. A start error is a mount error: classify (3.6), remove
   everything, answer 422 with `{ code, detail }`.
4. A watcher per container (`waitContainer`) records the exit code and the redacted stderr tail
   in memory and in `runner-runs.json` in the state volume (run id, kind, exit code, times; no
   spec, no secret), then removes the container, the share volume and the scratch volume **at
   once**: the password lives in the volume's options for exactly as long as the container
   runs. Finished entries are kept for 24 hours for `GET`.
5. Every minute: kill containers past their deadline label (exit recorded as `deadline`).
6. **On start** (`main.ts`): list containers with `com.restow.mounter.runner`; running ones whose
   deadline is ahead are adopted (a watcher is attached again); exited ones and those past the
   deadline are removed. Then remove every volume labelled `com.restow.mounter.runner.volume` that
   no remaining container uses. The probe cleanup (`removeStaleProbes` [V]) also removes leftover
   exec containers (they carry `com.restow.mounter.probe=1`).

`docker volume inspect` shows a volume's options in plain text to whoever can talk to the Docker
socket. That is root on the host already (docs/MOUNTS.md "Security" [V]); the short lifetime of
the volume is what limits it.

### 3.6 Failure codes of runner operations

Added to `MOUNT_FAILURE_CODES`'s sibling `RUNNER_FAILURE_CODES` in `runner-protocol.ts`. The
mounter classifies Docker's start error by the errno text in it (Docker answers "failed to mount
local volume: mount ...: <strerror>" [K]); the worker and the api map them to share failure causes
(section 11).

| Code | Errno text / situation | Cause |
| --- | --- | --- |
| `mount.auth_failed` | `permission denied` (EACCES), `key has expired` (EKEYEXPIRED) at mount | `share.auth_failed` (param `expired` for EKEYEXPIRED) |
| `mount.unreachable` | `no route to host`, `host is down`, `connection refused`, `connection timed out`, `network is unreachable` | `share.unreachable` |
| `mount.not_found` | `no such file or directory` (ENOENT), `no such device or address` (ENXIO) | `share.not_found` |
| `mount.version` | `operation not supported` (EOPNOTSUPP), `protocol not supported`, `invalid argument` (EINVAL) with a `vers=` set | `share.version_mismatch` |
| `mount.client_missing` | `unknown filesystem type 'cifs'` / `'nfs'`, `no such device` (ENODEV) | `share.client_missing` |
| `mount.failed` | anything else | `share.mount_failed` |
| `runner.limit` / `runner.blocked` / `runner.image` / `runner.network` | 3.5 step 1, image or network missing | `share.mounter_unavailable` |
| `runner.timeout` | exec op past its timeout, run past its deadline | `share.timeout` |
| `runner.failed` | non-zero exit without a finish report | `share.runner_failed` |

The errno mapping for SMB is [I]: Windows, Samba and NAS firmware report a logon failure and a
share-level "access denied" both as EACCES to the client [I]; the cause is therefore phrased
"the server refused the account (password, account locked, or no access to this share)", and only
an EACCES *after* a successful mount (listing the root) is `share.permission_denied`.

### 3.7 Redaction

The mounter builds a `Redactor` per request (`apps/api/src/updater/redact.ts` [V]) that knows the
password, its comma-doubled form, the username and the whole option string, and additionally
replaces `password=[^,\s]*` and `pass=[^,\s]*` and everything after `data: ` up to the end of a
Docker error line. Every `detail`, `stderrTail`, log line and HTTP error passes through it. A test
feeds Docker's real error format with a password containing `,`, `=` and spaces and asserts that
no fragment of it survives. Runner requests are never written to the operation history (that
history is for share mount operations, `store.ts` [V]) and never logged.

### 3.8 Settings (mounter environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESTOW_MOUNTER_MAX_RUNNERS` | 8 | Hard cap of concurrent runner containers; the application setting (7.4) is the normal limit and may not exceed it. |
| `RESTOW_MOUNTER_RUNNER_API_URL` | `http://api:3000` | What the runner calls (on the `runners` network). |
| `RESTOW_MOUNTER_RUNNER_NETWORK` | `runners` | Compose network key; the Docker name is `<project>_runners`. |
| `RESTOW_MOUNTER_RUNNER_EXEC_TIMEOUT_SECONDS` | 60 | Test and list. |
| `RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB` | 16384 | Upper bound for `limits.memoryMiB`. |
| `RESTOW_MOUNTER_SELINUX_CONTEXT` | false | Adds the `context=` option (3.3). |

### 3.9 Turning the mounter on

The mounter is still a separate service in the compose profile `mounts` (docs/MOUNTS.md [V]), so
that an operator can keep the Docker-socket container off. What changes is the default and the way
to switch it on.

**New installations: on by default.** `deploy/install/install.sh` today leaves it off unless
`--with-mounter` is given (`--no-mounter` is the documented default, `install.sh:206-209` and the
parser at `:992-996` [V]). From this release:

- the mounter starts with the stack by default (`start_stack ... mounter=1`, `install.sh:2172` [V]),
  whenever the chosen release has it (`MOUNTER_MIN_VERSION`, `install.sh:87` [V]);
- `--no-mounter` stays the opt-out, `--without-mounter` is accepted as its alias, `--with-mounter`
  stays accepted (now the default, kept for scripts);
- for an explicitly chosen release older than `MOUNTER_MIN_VERSION` the default quietly stays off
  (the plan says "off: this release has no mounter"); only an explicit `--with-mounter` is still
  refused there (`mounter_version_problem`, `install.sh:2618` [V]);
- the summary line reads "Mounter on: ... (mounts the Docker socket; turn off with --no-mounter)".

`deploy/install/test.sh` changes with it: "the mounter is off by default" (`test.sh:108` [V])
becomes "on by default", the dry run without flags expects `--profile mounts` and "Mounter on"
(`test.sh:871-872` [V]), new cases cover `--without-mounter`, `--no-mounter` last wins, and a
default install of a release before `MOUNTER_MIN_VERSION` (off, exit 0). Re-running the installer
on an existing installation keeps that installation's choice.

**Existing installations: from the web interface.** `GET /api/v1/mounts` gains
`enable: { running: boolean, via: "updater" | "command" | null, command: string, lastAttempt }`.

- With the opt-in updater running, provider owners see **Enable network shares** (Installation >
  Network shares, and on the File shares page). It calls `POST /api/v1/mounts/enable` (owner only,
  recent sign-in, `own()` in `provider-access.ts`; installation audit log `mounter.enable_requested`
  and the outcome). The api forwards it to a new updater route `POST /v1/mounter/enable` with the
  updater's shared secret (`apps/api/src/features/updates/updater-client.ts` [V]).
- The updater does what it already does when it moves the mounter after an update
  (`apps/api/src/updater/self-update.ts:44-52`, `MounterFollowDeps` [V]): it checks that the
  project's compose file has the `mounter` service in the profile `mounts` taking its image from
  `RESTOW_MOUNTER_IMAGE`, leaves `RESTOW_MOUNTER_IMAGE` empty (the mounter pins the image it runs on
  its first start, docs/MOUNTS.md "Enabling it" [V]) or, when the updater itself runs a signed,
  digest-pinned image, writes that image there, and starts its helper container (the launcher of
  `self-recreate.ts` [V], Docker CLI image pinned by digest, no network) with
  `docker compose --profile mounts up -d --no-deps --no-build --pull missing mounter`. It refuses
  while an update is scheduled or running. The result (`started`, `failed` with a redacted
  detail) is kept in the updater's state and shown in the section.
- Without the updater the section shows the one command, as today:
  `docker compose --profile mounts up -d mounter` in the directory with `docker-compose.yml`.
- Switching it off stays a command (`docker compose --profile mounts stop mounter`); the page says
  so. Runs in progress then end as `share.runner_lost`.

---

## 4. `restow-share`

### 4.1 Commands

```
restow-share probe --expect smb|nfs     check the mount, list the top level, check ACL access (JSON on stdout)
restow-share list  --path <rel> --limit <n>   one folder level of the live share (JSON on stdout)
restow-share run                        a backup or restore run; reads its session from the api
restow-share version
```

The binary takes no secret from its arguments. `run` reads `RESTOW_SHARE_RUN_ID` and
`RESTOW_SHARE_RUN_TOKEN` from the environment, fetches its session (5.2) and passes restic its
credentials only through the child's environment (`RESTIC_REST_USERNAME`, `RESTIC_REST_PASSWORD`
and `RESTIC_PASSWORD`, never on its command line), the way `agent/internal/restic/runner.go:59-68`
builds it [V].

### 4.2 Mount guard (every command)

Before it reads anything:

1. `statfs("/share")`: `f_type` must be `0xFF534D42` (CIFS) or `0xFE534D42` (SMB2) for `smb`, and
   `0x6969` (NFS) for `nfs` [K]. Otherwise exit 10, code `wrong_filesystem`: the share is not
   mounted and the runner would back up an empty directory of the container.
2. `/proc/self/mountinfo`: the entry for `/share` has the type `cifs`/`smb3` or `nfs`/`nfs4` and,
   for backup, probe and list, the `ro` flag. A read-write mount where a read-only one was asked
   for is exit 10 as well.
3. For a backup: readdir of `/share` (and of every include folder) must succeed; EACCES is
   `permission_denied`, EIO/ETIMEDOUT `unreachable`.

### 4.3 Backup run, step by step

| Step | What happens | Progress phase |
| --- | --- | --- |
| Session | `GET /internal/file-shares/v1/session` (5.2). Moves the run to `running`. | `prepare` |
| Guard | 4.2. | `prepare` |
| Empty-root guard | If the root (or every include folder) is empty and the previous restore point of this share recorded more than 0 files (`session.backup.previous.fileCount`), exit 10, `empty_source`. Missing include folder: exit 10, `include_missing` (with the folder). An admin who emptied the share on purpose clicks **Back up the empty share once** on the failed run, which sets `allowEmptyOnce` for the next run. | `prepare` |
| Walk | One walk over the include folders (`walk.go`, 8 parallel directory readers): `lstat`, file count and bytes (the progress totals), the ACL (4.5) unless permissions are off, DOS attributes, offline files (4.4), the excluded subtrees skipped with the same patterns restic gets. Writes `/.restow/acls.jsonl.gz` and collects the sample candidates. | `scan` |
| Drop check | Fewer than half the files of the previous restore point: not refused (people do clean up), but the finish report carries `share.files_dropped` as a warning item and the run ends "with warnings". | `scan` |
| restic backup | 4.4. Progress lines are forwarded every 5 seconds. | `backup` |
| Samples | Up to 20 random regular files from the walk whose modification time is older than the run start minus one hour and whose size and mtime are unchanged before and after hashing; SHA-256 posted with the snapshot id (`POST .../samples`). The restore check reads exactly these back (8.4). | `finalize` |
| Finish | `POST .../finish` with status, stats and the restic snapshot id; then exit. | `finalize` |

The walk and restic each read the metadata of every file once: two metadata passes per run. The
walk is what makes the ACLs, the totals for the progress bar, the offline-file exclusion and the
empty guard possible; restic needs its own pass for change detection. For a share with millions
of files the walk dominates on high-latency links. Two mitigations are part of Phase A:

- **ACL reuse by change time.** On SMB, a file's change time (`ChangeTime`, exposed as `ctime` by
  the cifs client [K]) moves when its security descriptor changes [K for NTFS; I for Samba and NAS
  file systems]. The walk keeps the previous sidecar's descriptor of a path whose `ctime` and size
  did not change instead of asking the server again. The previous sidecar is read at the start with
  `restic dump <parent> /.restow/acls.jsonl.gz`. A share setting **Read all permissions every run**
  turns the reuse off; every 30th run reads them all anyway (the dispatcher sets the session's
  `rereadPermissions` for it; the runner keeps no counter).
- **Permissions off per share** for shares where nobody needs them (a scanner inbox).

### 4.4 restic flags (backup)

```
restic backup --json --host restow-share --tag restow-share --tag share=<id> --tag run=<runId>
  [--parent <previous snapshot id>] --no-scan --read-concurrency <n> --retry-lock 1h
  --exclude-file /tmp/excludes [--iexclude-file /tmp/iexcludes] [--exclude-larger-than <n>]
  [--limit-upload <KiB/s>] [--ignore-inode --ignore-ctime]   (SMB)
  /share[/<include> ...] /.restow
```

- **Paths are stable:** `/share` (or the include folders below it) and `/.restow`. Restore and
  browse map `/share` to the root of the share and hide `/.restow`.
- **Parent:** passed explicitly from the newest successful restore point of the share
  (`file_share_snapshots`), so a change of the include list or the host field never forces a full
  re-read of unchanged files; restic matches the trees by path [K].
- **Change detection on SMB:** `--ignore-inode` because the inode numbers the cifs client shows
  are not stable when the server provides none (`noserverino` behaviour, some NAS) [K];
  `--ignore-ctime` because `ChangeTime` moves on permission changes (which the sidecar captures)
  and on some servers on access. A file is re-read when its size or mtime changed. NFS keeps
  restic's defaults (inode and ctime are reliable there).
- **Excludes:** the job's patterns plus the presets (7.5). On SMB they go to `--iexclude-file`
  (case-insensitive, like the server), on NFS to `--exclude-file`. File-type filters become
  `*.<ext>` lines. Offline files found by the walk (DOS attribute `OFFLINE` 0x1000 or
  `RECALL_ON_DATA_ACCESS` 0x400000: tiered by Azure File Sync, HSM, cloud placeholders) are added
  as escaped literal paths (`agent/internal/restic/pattern.go` `EscapeIncludePath` [V]) unless the
  job says **Back up offline files (recalls them)**; their count is reported.
- **No `--skip-if-unchanged`:** every run makes a restore point, so retention and the readiness see
  every successful run.
- **Exit codes:** 0 success; 3 "snapshot created, some files could not be read" [K] means a run
  with warnings; 1, 10, 11, 12 and others failure, classified from restic's JSON error lines
  (`agent/internal/restic/errors.go` [V] as the model).
- **Locked files:** SMB sharing violations surface as EBUSY or EACCES on open [I]. Each becomes an
  item `share.locked_file` with the path; the run ends with warnings ("23 files were open on the
  server and were not backed up"). There is no VSS over SMB; section 15.

### 4.5 Permissions capture

SMB, per file and folder, the first xattr that works for this share (decided at the root, kept for
the run, recorded in the sidecar header):

| xattr | Contains | Needs |
| --- | --- | --- |
| `system.cifs_ntsd_full` | owner, group, DACL, SACL | `SeSecurityPrivilege` on the server for the SACL (Administrators by default) |
| `system.cifs_ntsd` | owner, group, DACL | read-control on the object |
| `system.cifs_acl` | DACL | read-control |

[K for the names and contents; I for the exact privilege errors.] Plus, best effort, the DOS
attributes (`user.cifs.dosattrib`, a 32-bit value) and the creation time (`user.cifs.creationtime`,
100 ns units since 1601) [K that the cifs client answers both as pseudo-xattrs; I which servers].
A failure on one file is an item `share.acl_unreadable` (warning), not a failed run.

NFS: `system.nfs4_acl` on NFSv4 [K]; on NFSv3 `system.posix_acl_access` and
`system.posix_acl_default` [I that the client exposes them over NFSACL]. `EOPNOTSUPP` at the root
means "the server has none": mode `none`, no warning.

restic itself stores the POSIX owner, group, mode, times and the xattrs it can list (on cifs the
SMB extended attributes appear as `user.*`) [K]. The sidecar is authoritative for permissions;
restores run restic with `--exclude-xattr 'system.*' --exclude-xattr 'security.*'` (restic 0.17+
[I for the flag names; restic 0.19.1 is pinned, `packages/core/src/endpoints/restic-cli.ts:27` [V]])
so restic never writes a stale or foreign ACL itself.

### 4.6 Sidecar format (`/.restow/acls.jsonl.gz`, version 1)

gzip of JSON Lines. Every line is an object with a `t` (type) field. Paths are relative to the
share root (`/share`), `/`-separated, `""` for the root; a path that is not valid UTF-8 is written
as `pb` (base64 of the raw bytes) instead of `p`.

```jsonl
{"t":"h","format":"restow-share-permissions","v":1,"protocol":"smb","xattr":"system.cifs_ntsd_full","created":"2026-10-10T22:00:03Z","runner":"0.4.0","reused":118003}
{"t":"d","id":"3f9a1c0e5b7d2a44","b":"AQAEhBQAAAAwAAAAAAAAAEwAAAABBQAAAAAABRUAAAD..."}
{"t":"e","p":"","d":"3f9a1c0e5b7d2a44","a":16}
{"t":"e","p":"Finance/2026/Q3.xlsx","d":"8c01d2e94f30aa17","a":32,"c":"133701234567890000"}
{"t":"x","p":"HR/locked","err":"EACCES"}
{"t":"z","entries":245117,"descriptors":312,"errors":1}
```

| `t` | Meaning |
| --- | --- |
| `h` | Header, first line. `xattr` names what `b` holds. `protocol` is `smb` or `nfs`. |
| `d` | A descriptor, written once before its first use: `id` = first 16 hex characters of the SHA-256 of the raw bytes, `b` = base64 of the raw xattr value (self-relative `SECURITY_DESCRIPTOR` for SMB, the raw `nfs4_acl` XDR for NFSv4, a JSON object `{ "access": b64, "default": b64 }` for POSIX ACLs). Inherited permissions make most files share a handful of descriptors. |
| `e` | An entry: path, descriptor id, optional DOS attributes `a`, optional creation time `c` (decimal string, 64-bit), optional change time `ct` (ns since 1970, decimal string) and size `s`: the next run's ACL reuse (4.3) compares those two, a restore ignores them. A path whose descriptor could not be read has an `x` line and an `e` line without `d` (its DOS attributes may still be there). |
| `x` | A path whose permissions could not be read, with the errno name. |
| `z` | Trailer, last line, with the counts. A sidecar without a trailer is incomplete: a restore applies what it has and says so. |

Rules: a reader accepts `v` 1 and ignores unknown `t` values and unknown fields (forward
compatible additions keep `v`); a change of the meaning of an existing field increases `v`, and
a reader that meets a higher `v` skips permissions with one warning (`share.acl_format_newer`).
The Go writer and reader (`agent/internal/share/sidecar.go`) and a TypeScript reader
(`packages/core/src/file-shares/sidecar.ts`, used to show "permissions saved" in the browser and to
leave `/.restow` out of ZIPs) share golden files in `agent/internal/share/testdata/sidecar/`.

Next to it, `/.restow/manifest.json`: `{ format: "restow-share-manifest", v: 1, shareId, protocol,
includes, createdAt, files, bytes, permissions: { mode, entries, descriptors, errors } }`, so a
snapshot explains itself without the database (restore without Restow, 15).

### 4.7 Restore run

Session parameters (5.2): `snapshotId`, `paths` (relative to the share root; empty = all),
`destination` (`original`, `new_folder`, `folder` with a relative folder on another share),
`conflict` (`overwrite`, `keep_both`, `skip`; only for `original`), `restorePermissions`, `verify`.

| Step | What happens |
| --- | --- |
| Guard | 4.2 with `rw`. Target folder: `original` = the share root of the same share (same subfolder as the backup); `new_folder` = `Restow-Restore-YYYYMMDD-HHMMSS` in the share root; `folder` = the chosen folder on the target share, default `Restow-Restore-YYYYMMDD-HHMMSS`. The folder is created; it must not exist yet for `new_folder`. |
| restic restore | `restic restore <snap>:/share --target <dest> [--include <path> ...] --no-lock --overwrite <mode> --exclude-xattr 'system.*' --exclude-xattr 'security.*' [--verify] --json -vv` (`-vv`: restic reports every item it restored or updated; the permission write-back touches only those, and in `skip` mode only restored files, never a folder that was there). `overwrite` → `--overwrite if-changed`; `skip` → `--overwrite never`; `new_folder`/`folder` → `--overwrite never` (the folder is new); `keep_both` → restore into the staging folder `<root>/.restow-restore-<runId8>` with `--overwrite never`, then the reconcile step. |
| Reconcile (`keep_both` only) | For every staged file: destination missing → rename into place; destination with the same size and mtime → drop the staged copy (counted as identical); otherwise rename the staged file to `<name> (restored 2026-10-10 2200)<ext>` next to the original. Renames stay on the server (same share). The staging folder is removed at the end; a leftover from a crashed run is removed by the next run into that share (its name carries the old run id). |
| Permissions | When `restorePermissions` and the sidecar's protocol matches the target: stream the sidecar from the snapshot (`restic dump <snap> /.restow/acls.jsonl.gz`), apply top-down for the restored paths. SMB: try `system.cifs_ntsd_full`, then `system.cifs_ntsd`, then `system.cifs_acl`; the level reached per file is counted (owner and SACL need `SeRestorePrivilege`/`SeSecurityPrivilege` on the server [K]). A file that keeps the inherited permissions of the target gets an item `share.acl_not_restored`. DOS attributes and creation time are set last (a read-only attribute would block the rest), best effort [I which servers accept it]. NFS: `system.nfs4_acl` or the POSIX ACL xattrs, best effort. Protocol mismatch (SMB data into an NFS share or the reverse): one warning, no permissions. |
| Finish | Counts: restored, skipped, renamed, identical, failed, permissions applied per level, permissions failed. |

Defaults the dialog proposes: **Restore permissions** on for `original` and `new_folder`, off for
another share (its server may not know the original's accounts; foreign SIDs can lock users out
of the restored files). `verify` off on SMB, on for NFS targets (3.3).

restic's own `chown`/`chmod` errors on an SMB target are expected (owners are synthetic, 3.3) and
are filtered out of the items; on NFS they are kept (`root_squash` prevents owner changes:
`share.owner_not_restored`, with the docs/MOUNTS.md root-squash explanation [V] as the hint).

### 4.8 Exit codes and error classification

| Exit | Meaning |
| --- | --- |
| 0 | Success (finish reported `succeeded`). |
| 3 | Success with warnings (finish reported `warning`). |
| 1 | Failure (finish reported `failed` with a code). |
| 2 | Usage or session error (the api refused the credential, the session was malformed). |
| 10 | A guard refused (finish reported `failed` with `wrong_filesystem`, `empty_source`, `include_missing`). |

Items (per-file problems) carry a code from: `locked_file`, `read_error`, `acl_unreadable`,
`acl_not_restored`, `owner_not_restored`, `offline_skipped`, `name_invalid` (a name the target
cannot hold), `files_dropped`. The worker maps them to failure causes (section 11).

### 4.9 `probe` and `list` output

```json
{ "ok": true, "fsType": "cifs", "readOnly": true,
  "entries": [ { "name": "Finance", "type": "dir", "size": 0, "mtime": "2026-10-09T08:12:00Z" } ],
  "truncated": false, "permissions": { "readable": true, "xattr": "system.cifs_ntsd" },
  "durationMs": 412 }
{ "ok": false, "code": "permission_denied", "detail": "open /share: permission denied" }
```

`list` returns at most `--limit` (default 500, at most 2000) entries of one folder, sorted folders
first, then by name; `truncated` says there are more. Names are returned as they are (the web UI
escapes); a name that is not valid UTF-8 is shown with replacement characters and cannot be picked
as an include folder (the API says why).

### 4.10 Copy runs (scheduled copy jobs)

A copy job (`backup_jobs.kind = 'copy'`, 7.5) is a schedule for one kind of restore: the newest
**verified** restore point of the source share (its restore check is green, 8.4) into
`targetFolder` of the target share, in one of two modes. Each run is an ordinary restore run
(`file_share_runs.kind = 'restore'`, `trigger = 'copy'`, `backup_job_id` set) with
`destination: "folder"`, so everything in 4.7 applies; only these differ:

| | `overwrite` | `mirror` |
| --- | --- | --- |
| restic | `restic restore <snap>:/share --target /share/<targetFolder> --overwrite if-changed` | the same plus `--delete` [K, restic 0.17+]: files and folders in the target folder that the restore point does not have are deleted |
| Files only on the target | stay | deleted, inside `targetFolder` only (`--target` is that folder; nothing above it is touched) |
| Use | a second copy that collects | an exact replica (a standby share, a branch office) |

Which restore point: chosen by the dispatcher when the run starts, not when it is queued. When
it is the restore point the job's last successful run copied already, the run ends at once as
`succeeded` with `stats.upToDate = true` (the job shows "Already up to date"). When the source has
no verified restore point at all, the run fails with `share.copy_no_verified_point`.

Safety rules, checked by the api when the job is saved **and** by the dispatcher and the runner
before every run (a check in one place only is not enough when settings change between them):

1. The target share allows restores (`allow_restore`), else `share.restore_not_allowed`.
2. Source and target are different shares, and not the same location under two names: the same
   protocol, pinned address, share or export and overlapping subfolders count as the same
   (`share.copy_unsafe_target`).
3. `mirror` never into the share root: `targetFolder` must have at least one segment
   (`share.copy_unsafe_target`).
4. `mirror` needs a marker: on its first run the runner writes `<targetFolder>/.restow-copy.json`
   (`{ format: "restow-copy-target", v: 1, jobId, sourceShareId, createdAt }`). A later mirror
   run refuses a target folder that is not empty and has no marker, or has the marker of another
   job, unless the job carries `mirrorConfirmedAt` (the admin confirmed "the folder is not empty;
   everything in it that is not in the source will be deleted" when saving the job; changing the
   target clears the confirmation). The marker is never deleted by `--delete` (it is excluded).
5. `mirror` refuses a restore point with 0 files (`share.copy_empty_source`): an empty source must
   never empty the replica.
6. `mirror` refuses when the restore point holds fewer than half the files of the one copied
   last, unless the admin runs that copy by hand with **Copy anyway** (the same idea as the
   backup's drop check, 4.3).

Permissions: the job's `restorePermissions` (default off, 4.7). The UI labels every copy job,
its runs and its target folder in the share browser "Not a backup: no versions on the target";
a copy job never counts as protection (section 13).

---

## 5. Runner and api

### 5.1 Credential

Created by the dispatcher when it starts a run (8.2): 32 random bytes, base64url; only its SHA-256
is stored (`file_share_runs.token_hash`, compared with `secretMatchesHash` as in
`restic-route.ts` [V]). It authenticates as HTTP Basic `<runId>:<token>` to every runner route and to
the restic route. It is valid while the run is `starting` or `running`, the tenant is active and
`token_expires_at` (= the run's deadline) has not passed. The finish report ends it.

### 5.2 Runner routes (`/internal/file-shares/v1`, `features/file-shares/runner-routes.ts`)

| Route | Body / answer |
| --- | --- |
| `GET /session` | `{ run: { id, kind, shareId, deadline }, expect: { protocol, readOnly }, repository: { url, repositoryPassword }, backup?: {...}, restore?: {...} }`. `url` is `rest:http://api:3000/internal/file-shares/restic/<repoShareId>/`; username and password are the run's own. `backup`: `includes`, `excludes`, `caseInsensitive`, `excludeLargerThanBytes`, `limitUploadKiB`, `readConcurrency`, `parentSnapshotId`, `previous: { snapshotId, fileCount }`, `allowEmptyOnce`, `permissions: "auto" \| "off"`, `rereadPermissions`, `skipOffline`, `samples: 20`. `restore`: 4.7. Moves `starting` to `running`. |
| `POST /progress` | `{ phase, filesDone, bytesDone, totalFiles, totalBytes, currentPath, bytesUploaded, at }`, every 5 s at most. Answer `{ cancel: boolean }`: a cancel requested in the UI reaches the runner here, which stops restic with SIGINT and reports `cancelled`. Feeds `file_share_runs.progress`, `last_progress_at` and `run_samples` (7.3). |
| `POST /items` | `{ items: [{ path, code, message, phase }] }`, at most 500 per request; the server stores the first 10,000 per run and counts the rest. |
| `POST /samples` | `{ snapshotId, files: [{ path, sha256, size }] }`, at most 20. |
| `POST /finish` | `{ status: "succeeded" \| "warning" \| "failed" \| "cancelled", code?, message?, snapshotId?, stats, restore?, logTail }` (log tail redacted by the runner with `agent/internal/redact` [V] and again by the api). Idempotent for the same body; a second, different finish is 409. |

Requests through a proxy are refused (2.3). The routes are listed in `PUBLIC_ROUTES`
(`apps/api/src/lib/provider-access.ts:106` [V]) under a comment like the agent's, since no session
applies. Failed credentials count against the same per-address limiter as the agent
(`authFailures`, `apps/api/src/features/endpoints/agent-auth.ts` [V]).

### 5.3 restic route (`/internal/file-shares/restic/:shareId/*`)

Built with the new `restic-run-route.ts`, which the PVE route moves onto in the same phase:

```ts
buildRunResticRoute({
  basePath,                       // "/internal/file-shares/restic"
  resolve: async (credentials, repoId) => ({ tenantId, prefix, principal, runId } | null),
  locks: (runId, repoId) => ResticLockRegistry,  // PVE: process-local as today; shares: persisted
  remainingBytes?: (tenantId, repoId) => Promise<number | null>,
  audit: (event) => void,
  realm: "restow-share",
})
```

- **Principal by run kind.** A backup run gets `agent` (append-only,
  `packages/core/src/endpoints/restic-authz.ts` [V]) on its own share's repository. A restore run
  gets the new principal **`reader`** on the *source* share's repository: `HEAD`/`GET` and lists
  only, no write of any type including locks (restic restore runs with `--no-lock`). The authz matrix
  test grows a third column.
- **Locks** of a backup run are persisted (`file_share_repository_locks`, like
  `endpoint_repository_locks`, docs/AGENT.md "Sperren" [V]), so a restarted api still lets restic
  release its own locks and maintenance can tell the runner's locks from stale ones.
- **Quota:** `remainingBytes` from the share and tenant budgets (7.4); a refused upload answers 403
  with `urn:restow:problem:file-share-quota-exceeded` (403, not 507, for the reason docs/AGENT.md
  gives [V]).
- Denials are audited as `file_share.repository.denied` (throttled like the endpoint's).

### 5.4 Repository initialisation and password

The dispatcher initialises a share's repository before its first run: a random 32-byte password,
sealed with the tenant DEK as secret kind `file_share_repository`, `restic init` through the
loopback listener (maintenance principal) as `resticInit` does [V], then the sealed password
document is written next to the repository as `file-shares/<id>/restow-repository-password.json`
(generalising `packages/core/src/endpoints/repository-key.ts` [V]: format
`restow-file-share-repository-password-v1`, AAD `tenantId || shareId`), so `restow-restore`
(packages/cli) can open the repository from the storage target and the master key alone.
`file_shares.repository_ready_at` records it.

---

## 6. What is preserved

| Aspect | SMB | NFS |
| --- | --- | --- |
| File content, sizes, folder structure | yes | yes |
| Modification time | yes (restored) | yes |
| Creation time | captured; restored best effort [I] | not applicable |
| Access time | not preserved (`noatime` semantics) | not preserved |
| NTFS permissions (owner, group, DACL) | yes; restore needs the account's privileges for the owner (4.7) | not applicable |
| SACL (auditing entries) | when the account has `SeSecurityPrivilege`; else not captured (header says `cifs_ntsd`) | not applicable |
| Inheritance flags | part of the descriptor, preserved | not applicable |
| DOS attributes (read-only, hidden, system, archive) | captured; restored best effort [I]; offline/recall attributes are never restored | not applicable |
| Alternate data streams (`Zone.Identifier`, Office metadata, macOS resource forks on SMB) | **not preserved**: the Linux cifs client does not expose streams | not applicable |
| SMB extended attributes (EAs) | as `user.*` xattrs through restic, restored best effort | not applicable |
| POSIX owner, group, mode | synthetic on SMB (0, 0644/0755), not restored | yes; owner restore needs `no_root_squash` |
| NFSv4 ACLs | not applicable | best effort via `system.nfs4_acl` |
| POSIX ACLs (NFSv3) | not applicable | best effort [I] |
| Symbolic links | as links (SMB: when the server presents them) | as links |
| Hard links | each link as a file | restic keeps hard links [K] |
| Sparse files | restored dense on SMB [I] | restic restores sparse when `--sparse` [K]; used on NFS |
| Junctions, DFS links | not followed (`nodfs`); a junction appears as whatever the server presents [I] | not applicable |
| Files open with an exclusive lock | not backed up; listed as warnings | usually readable |
| Consistency across files | none: files are read one after another while users work (no VSS over SMB, section 15) | none |

The share page and the restore dialog link to this table.

---

## 7. Data model

### 7.1 Tables (`packages/db/src/schema/file-shares.ts`)

Every table is tenant-scoped with RLS (policies in `packages/db/sql/rls.sql`, the per-table RLS test
in the api's pg suite). State and kind columns are `text` with a TypeScript union, like `pve.ts`
[V], so a new value never needs `ALTER TYPE`; the only enum change is `backup_job_kind`.

**`file_shares`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid fk tenants, cascade | |
| `name` | text not null | unique per tenant on `lower(name)` among rows with `retired_at IS NULL` |
| `protocol` | text `smb` \| `nfs` | |
| `server` | text | host name or IP, as entered (normalised) |
| `share_name` | text null | SMB share |
| `export_path` | text null | NFS export |
| `subfolder` | text not null default `''` | |
| `smb_version` | text null | `3.1.1` \| `3.0` \| `2.1` |
| `smb_encryption` | boolean not null default false | `seal` |
| `smb_domain` | text null | |
| `username` | text null | SMB |
| `credential_secret_id` | uuid fk secrets, set null | kind `file_share_password`, tenant DEK |
| `nfs_version` | text null | `3` \| `4` \| `4.1` \| `4.2` |
| `allow_restore` | boolean not null default false | "Allow restore to this share" |
| `permissions_mode` | text not null default `auto` | `auto` \| `off` |
| `reread_permissions` | boolean not null default false | 4.3 |
| `private_network_approval` | jsonb null | `{ by, at, address }` as `SourceConfig.privateNetworkApproval` [V] plus the approved address range |
| `repository_secret_id` | uuid fk secrets, set null | kind `file_share_repository` |
| `repository_ready_at` | timestamptz null | |
| `repository_bytes`, `repository_measured_at` | bigint, timestamptz | as `endpoints` [V] |
| `quota_gib` | integer null | the share's budget in GiB; null = none (the default); set in the share's settings (9.1) |
| `quota_alert_level`, `quota_alerted_at`, `quota_refused_at` | text, timestamptz | as `endpoints` [V]: `near` from 80 %, `exceeded` at 100 % |
| `last_test` | jsonb null | `{ ok, code, at, durationMs }`, the last connection test |
| `credential_failed_at` | timestamptz null | set by a `share.auth_failed` run or test, cleared by a success |
| `last_backup_at`, `last_success_at` | timestamptz | |
| `last_snapshot_id` | uuid null | `file_share_snapshots.id` |
| `last_retention_at`, `last_check_at`, `last_restore_test_at`, `last_catalog_at` | timestamptz | |
| `maintenance_locked_count`, `maintenance_locked_since`, `locked_alerted_at` | as `endpoints` [V] | |
| `allow_empty_once` | boolean not null default false | 4.3 |
| `retired_at` | timestamptz null | removed from protection; backups kept |
| `created_by` | text fk user, set null | |
| `created_at`, `updated_at` | | `timestamps()` |

Indexes: `(tenant_id)`, the unique name index, `(tenant_id, retired_at)`.

**`file_share_runs`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | also the runner's `runId` |
| `tenant_id`, `file_share_id` | fk, cascade | `file_share_id`: the share backed up, or the source of a restore |
| `kind` | text `backup` \| `restore` | |
| `status` | text `queued` \| `starting` \| `running` \| `succeeded` \| `warning` \| `failed` \| `cancelled` | glossary: queued = "waiting" |
| `trigger` | text `schedule` \| `manual` \| `retry` \| `copy` | `copy`: a run of a copy job (4.10) |
| `backup_job_id` | uuid fk backup_jobs, set null | |
| `lock_share_id` | uuid not null fk file_shares | the share whose mount the run holds: the share itself for a backup, the target for a restore |
| `target_share_id` | uuid null fk file_shares, set null | restore |
| `source_snapshot_id` | uuid null fk file_share_snapshots, set null | restore |
| `params` | jsonb not null default `{}` | restore parameters (4.7), backup overrides of a manual run |
| `token_hash`, `token_expires_at` | text, timestamptz | 5.1 |
| `cancel_requested_at` | timestamptz null | |
| `queued_at`, `started_at`, `finished_at`, `last_progress_at` | timestamptz | |
| `progress` | jsonb null | the last progress report |
| `stats` | jsonb not null default `{}` | finish stats |
| `snapshot_id` | uuid null | the restore point a backup created |
| `item_count`, `items_stored` | integer not null default 0 | |
| `failure` | jsonb null | `FailureRecordJson` [V `_shared.ts`] |
| `error_message`, `log_tail` | text null | redacted |
| `requested_by` | text fk user, set null | |
| `alerted_at` | timestamptz null | |
| `created_at` | timestamptz | |

Indexes: `(file_share_id, created_at)`, `(tenant_id, created_at)` (History),
`(status, queued_at)` (dispatcher), and the singleton:
`UNIQUE (lock_share_id) WHERE status IN ('starting','running')`. A second index
`UNIQUE (file_share_id) WHERE kind = 'backup' AND status = 'queued'` keeps a share from collecting
queued backups while one is late.

**`file_share_run_items`**: `id`, `tenant_id`, `run_id` fk cascade, `path` text, `code` text,
`phase` text, `message` text (at most 500 characters), `created_at`. Index `(run_id, code)`.

**`file_share_snapshots`**: `id`, `tenant_id`, `file_share_id`, `run_id`, `sequence` integer
(per share, increasing), `restic_snapshot_id` text not null, `snapshot_time` timestamptz,
`includes` jsonb, `files` bigint, `dirs` bigint, `bytes` bigint, `bytes_added` bigint,
`permissions` jsonb (`{ mode, xattr, entries, descriptors, errors }`), `status` text `active` \|
`pruned`, `pruned_at`, `created_at`. Unique `(file_share_id, sequence)` and
`(file_share_id, restic_snapshot_id)`.

**`file_share_samples`**: as `endpoint_samples` [V] (`run_id`, `snapshot_id` → restic id, `path`,
`sha256`, `size`).

**`file_share_reports`**: as `endpoint_reports` [V]: `kind` (`restore_test`, `repository_check`,
`retention`), `readiness` (`green`/`yellow`/`red`, null for retention), `snapshot_id`, `summary`,
`run_id`, `alerted_at`, `checked_at`.

**`file_share_repository_locks`**: as `endpoint_repository_locks` [V] (`file_share_id`, `name`).

**`file_share_downloads`**: as `endpoint_downloads` [V] (`file_share_id`, `snapshot_id`,
`selection`, `created_by`, `expires_at`, `started_at`, ...).

**`file_share_catalog`** (search and version history, 8.5):

| Column | Type | Notes |
| --- | --- | --- |
| `tenant_id`, `file_share_id` | uuid | |
| `path` | text | relative to the share root |
| `name` | text | last segment, for search |
| `size` | bigint | |
| `mtime` | timestamptz | |
| `first_seq` | integer | first restore point (sequence) that has this version |
| `end_seq` | integer null | first restore point that no longer has it; null = still present |

Primary key `(file_share_id, path, first_seq)`. Indexes `(file_share_id, lower(name)
text_pattern_ops)` and, when `pg_trgm` is available, a GIN trigram index on `lower(name)`.
A version is "in" restore point `s` when `first_seq <= s.sequence AND (end_seq IS NULL OR end_seq >
s.sequence)`.

### 7.2 Changes to existing tables

- `backup_job_kind` gains `share` and `copy` (`packages/db/src/schema/backup-jobs.ts:37` [V]).
- `backup_jobs.source_file_share_id` and `backup_jobs.target_file_share_id`, uuid, foreign keys to
  `file_shares` with `ON DELETE CASCADE` (a copy job without one of its shares is meaningless), a
  check `(kind = 'copy') = (source_file_share_id IS NOT NULL AND target_file_share_id IS NOT NULL)`
  and `source_file_share_id <> target_file_share_id`. A copy job has no member rows. Columns rather
  than JSON so the database keeps the reference honest when a share is purged. Retiring a share
  disables the copy jobs that read from it or write to it (with a note on the job).
- `backup_job_members.file_share_id` uuid fk `file_shares` cascade; partial unique index
  `backup_job_members_file_share_uq ON (file_share_id) WHERE file_share_id IS NOT NULL`; the check
  `backup_job_members_one_target_ck` becomes
  `num_nonnulls(protected_object_id, endpoint_id, file_share_id) = 1` (today `(a IS NOT NULL) <>
  (b IS NOT NULL)` [V]).
- `run_samples.file_share_run_id` uuid fk `file_share_runs` cascade, partial unique index; its
  check becomes `num_nonnulls(job_id, endpoint_run_id, file_share_run_id) = 1`
  (`packages/db/src/schema/run-samples.ts` [V]).
- `warning_acknowledgements.file_share_id` uuid fk cascade, partial unique index; check
  `num_nonnulls(protected_object_id, endpoint_id, file_share_id) = 1`
  (`packages/db/src/schema/warnings.ts` [V]).
- `settings.file_share_settings` jsonb not null default `{}` (7.4).
- Secret kinds (no migration, plain text column [V]): `file_share_password`,
  `file_share_repository`.

### 7.3 Migrations

The latest migration is `0032_pve_enrollment_pve_token.sql` [V]. Generated with drizzle-kit, then
reviewed by hand:

| File | Content |
| --- | --- |
| `0033_file_shares.sql` | All new tables, indexes and foreign keys; `settings.file_share_settings`; `run_samples.file_share_run_id` and `warning_acknowledgements.file_share_id` with their new checks; a `DO` block that runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` and creates the trigram index, catching `insufficient_privilege` and `undefined_file` (an external Postgres without the extension then searches with the `text_pattern_ops` index and `ILIKE`, slower but correct). |
| `0034_backup_job_kinds_share_copy.sql` | `ALTER TYPE "public"."backup_job_kind" ADD VALUE 'share';` and `... ADD VALUE 'copy';` and nothing else: two new values in one migration are fine, but no statement may use them in the transaction that adds them. |
| `0035_backup_job_file_shares.sql` | `backup_job_members.file_share_id`, its foreign key, the partial unique index and the replaced check constraint; `backup_jobs.source_file_share_id`, `target_file_share_id`, their foreign keys and the copy checks (which name `'copy'`, hence a migration after 0034). |

RLS policies for the new tables go into `packages/db/sql/rls.sql` in 0033's phase (it is applied
on every start, `Dockerfile` entrypoint [V]).

### 7.4 Installation settings (`settings.file_share_settings`)

| Field | Default | Bounds | Who |
| --- | --- | --- | --- |
| `maxConcurrentRunners` | 2 | 1 .. `RESTOW_MOUNTER_MAX_RUNNERS` | provider administrator with every tenant |
| `runnerMemoryMiB` | 2048 | 512 .. `RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB` | same |
| `goMemLimitPercent` | 80 | 50 .. 90 (of `runnerMemoryMiB`, passed as `GOMEMLIMIT`) | same |
| `maxRunHours` | 72 | 1 .. 336 | same |
| `defaultReadConcurrency` | 4 | 1 .. 16 | same |
| `tenantsMayUsePrivateNetworks` | false | | provider owner |
| `defaultShareQuotaGib` | 0 (off) | 0 .. 1048576 | provider administrator; what a new share gets in `quota_gib` (0: none) |
| `tenantShareQuotaGib` | 0 (off) | same | provider administrator; all shares of a tenant together (a tenant-level value in the tenant's settings overrides it) |

**Budgets** work like the machine budgets (`packages/core/src/endpoints/quota.ts` [V]:
`remainingQuotaBytes`, `quotaLevelOf`), with file-share thresholds: a share's repository at 80 %
of its budget (or all shares of the tenant at 80 % of theirs) raises `file_share.storage_quota`
as a warning once, re-armed below 70 %; at 100 % the dispatcher refuses to **start** a backup of
that share (`share.quota_exceeded`, the run fails at once with the usage in its parameters), and a
running backup that crosses the line has its uploads refused by the restic route (5.3), which
ends it as failed with the same cause. Restores, copies into the share (they do not write to its
repository), retention and checks keep working, so space can be freed by tightening retention.
The size is `file_shares.repository_bytes`, measured as for machines (counted on every upload and
deletion, re-measured by every retention run). `quota.ts` gets the ratios as parameters instead
of the constants `QUOTA_NEAR_RATIO`/`QUOTA_CLEAR_RATIO` (0.9/0.8 for machines [V]).
| `catalog` | `{ enabled: true, maxEntriesPerShare: 20000000 }` | | same |

Large shares need memory: restic holds its index in memory, roughly proportional to the number of
blobs [K]. The settings page says so and the run detail shows the peak memory the runner reported;
a run killed by the memory limit (exit 137) fails with `share.out_of_memory`, whose hint names the
setting.

### 7.5 Job settings (`BackupJobShareSettings`)

Extends `BackupJobEndpointSettings` [V `backup-jobs.ts`] in spirit, in its own type:

```ts
type BackupJobShareSettings = {
  excludes?: string[];                 // patterns, one per line, restic syntax
  presets?: { systemFiles?: boolean }; // default true
  fileTypes?: { exclude: string[] };   // extensions without the dot
  excludeLargerThanGib?: number | null;
  bandwidthKbps?: number | null;
  bandwidthWindows?: EndpointBandwidthWindow[];
  readConcurrency?: number;            // default: the installation's
  skipOffline?: boolean;               // default true
  retention?: EndpointRetention;       // default 30 daily, 12 weekly, 12 monthly (DEFAULT_ENDPOINT_RETENTION [V])
};
type BackupJobShareMemberOverrides = BackupJobShareSettings & {
  includes?: string[];                 // folders relative to the share root; empty = everything
  schedule?: BackupJobSchedule;
};
```

A copy job (`kind = 'copy'`, 4.10) has its shares in the two columns of 7.2 and these settings:

```ts
type BackupJobCopySettings = {
  targetFolder: string;                // relative to the target share's root; mirror: not ""
  mode: "overwrite" | "mirror";
  restorePermissions?: boolean;        // default false
  mirrorConfirmedAt?: string | null;   // ISO; set when the admin confirmed a non-empty folder
  verify?: boolean;                    // restic --verify; default as for restores (4.7)
};
```

Its schedule is a `BackupJobSchedule` like a share job's; it has no retention, no members and no
restore-check schedule.

The preset "Skip temporary and system files" is: `~$*`, `*.tmp`, `Thumbs.db`, `desktop.ini`,
`.DS_Store`, `*.lck`, `$RECYCLE.BIN`, `System Volume Information`, `.snapshot`, `~snapshot`,
`#recycle`, `#snapshot`, `@eaDir`, `.@__thumb`. (The snapshot folders of NetApp, Synology and QNAP
would otherwise back up every server-side snapshot again.) Session patterns are patterns, not
exclude-file lines: a leading `#` is a literal character, which the runner writes as `\#` (restic
would read the line as a comment otherwise).

Bandwidth windows are resolved once, when the run starts (restic cannot change its limit while it
runs); a run that crosses into another window keeps its start limit. The job form says so.

Schedules: `interval` (at least 60 minutes), `cron` and `daily`, read in the job's time zone, as for
mail jobs; `on_connect` is not offered. Per-member schedule overrides as for mail members.

---

## 8. Server side

### 8.1 Scheduler (`apps/scheduler/src/file-shares.ts`)

- **Backups.** Due share jobs, the way `store.ts` selects mail jobs today (`WHERE j.kind = 'mail'
  AND j.enabled AND t.status = 'active'`, `apps/scheduler/src/store.ts:446` [V]) and computes the
  next run with `packages/core/src/backup-jobs/schedule.ts` [V]: per member share (not retired,
  job enabled) one pg-boss job `file-share-backup` `{ tenantId, fileShareId, backupJobId,
  trigger: "schedule" }`, singleton key `file-share-backup:<shareId>`. Members with their own
  schedule are planned on their own `next_run_at`.
- **Copies.** Due copy jobs (`kind = 'copy'`, enabled, both shares not retired): one pg-boss job
  `file-share-copy` `{ tenantId, backupJobId }`, singleton key `file-share-copy:<jobId>`.
- **Maintenance**, modelled on `EndpointJobPlanner` (`apps/scheduler/src/endpoints.ts` [V]), from the
  share rows themselves: `file-share-retention` daily, `file-share-check` weekly (5 %),
  `file-share-verify` for every new good restore point with samples and no restore check yet,
  `file-share-catalog` for every restore point not in the catalog yet, `file-share-monitor` every
  minute.
- Queue names and settings live in `packages/core/src/file-shares/queues.ts`, shaped like
  `ENDPOINT_QUEUES`/`ENDPOINT_QUEUE_SETTINGS` [V]; the scheduler imports them from `@restow/core`
  the way `endpoints.ts` does [V].

### 8.2 Worker: queueing and dispatch

- `file-share-backup` handler: inserts a `queued` backup run for the share unless one is queued
  already (the unique index), or one runs (then it inserts it anyway: it waits for the running one;
  a scheduled run that would wait longer than the job's interval is dropped with a note in the run
  list "skipped: the previous run was still running"). Manual runs and restores are inserted by the
  api directly.
- `file-share-copy` handler: inserts a `queued` restore run with `trigger = 'copy'`, the job's
  target as `lock_share_id`, the source as `file_share_id`, the job's settings in `params`, unless
  a run of that job is queued or running. The restore point is picked at dispatch (4.10).
- **Dispatcher** (`dispatch.ts`, a loop every 15 seconds under a session advisory lock, like
  `startPveMaintenance` [V `apps/worker/src/pve/maintenance.ts`]): takes queued runs, restores first,
  then oldest first, while `starting + running < maxConcurrentRunners`, skipping runs whose
  `lock_share_id` is busy. For each, in order:
  1. move to `starting` (the singleton index decides a race);
  2. load the share(s), check: not retired, tenant active, restore target allows restore; for a
     backup the budget (7.4, `share.quota_exceeded`); for a copy run the safety rules of 4.10 and
     the restore point to copy (or end it "already up to date");
  3. resolve the server, judge the address against the stored approval (10.1), else fail
     `share.address_blocked`;
  4. initialise the repository if needed (5.4);
  5. open the share password with the tenant keyring (`PgSecretReader` [V]);
  6. issue the run credential (5.1);
  7. `POST /v1/runner/runs` with the spec, the token and the limits.
  A mounter error fails the run with the mapped cause (3.6); `mounter not reachable` puts the run
  back to `queued` and the share page shows "Waiting for the mounter" after five minutes.
- The worker needs the mounter's address and secret: `RESTOW_MOUNTER_URL` and the volume
  `restow-mounter-shared:/mounter-shared:ro` are added to the worker in both compose files, as the
  api has them today (`docker-compose.yml:59,88` [V]). Its client
  (`apps/worker/src/file-shares/mounter-client.ts`) mirrors the api's
  (`apps/api/src/features/mounts/mounter-client.ts` [V]); the request shapes are pinned by the
  contract fixture of 3.2.

### 8.3 Monitor (`file-share-monitor`, every minute)

- `starting` for more than 5 minutes without a session call: ask the mounter; exited → fail with
  its exit and stderr tail (`share.runner_failed`); still running → kill, fail.
- `running` with `last_progress_at` older than 10 minutes: ask the mounter; exited without a finish
  → fail `share.runner_failed`; unknown to the mounter → fail `share.runner_lost`; alive but silent
  for 30 minutes → kill, fail `share.runner_stalled`.
- Past the deadline → the mounter has killed it or is told to; fail `share.timeout`.
- `cancel_requested_at` older than 2 minutes and still running → kill, `cancelled`.
- Finish processing (also called directly by the api's finish route through a pg-boss job
  `file-share-finish` so the api does not do the heavy part): stats onto the share, the snapshot
  row with its next `sequence`, `last_success_at`, `credential_failed_at` cleared or set, the failure
  record, webhooks and notifications (section 14), `allow_empty_once` reset.
- Overdue backups and silent repositories feed `apps/worker/src/overdue.ts` [V] as a new candidate
  kind `file_share`.

None of this rests on pg-boss' job expiry (`MAX_EXPIRE_HOURS = 23`, `apps/worker/src/queues.ts:56`
[V]): a run is a database row and a container, not a pg-boss job, so a 40-hour first backup of a
large share is ordinary.

### 8.4 Retention, check, restore check

`apps/worker/src/file-shares/maintenance.ts`, on the generalised `RepositoryAccess` (`prefix`
`file-shares/<id>/`, `repositoryKey` `file-share-<id>` for the cache folder, the opened
`file_share_repository` secret):

- **Retention** (`file-share-retention`): the job's keep rules applied with
  `applyRetentionPolicy` and `auditSnapshots` (`packages/core/src/endpoints/retention-policy.ts`
  [V]): snapshots no run recorded or dated in the future are left alone and flagged. The newest
  restore point whose `files > 0` is never removed, whatever the rules say. `restic forget <ids>`
  then `restic prune` (`resticForget`, `resticPrune` [V]); stale locks first, as for endpoints
  (`apps/worker/src/endpoints/maintenance.ts` [V]). A retired share keeps all its restore points
  until it is purged.
- **Check** (`file-share-check`): `restic check --read-data-subset 5%` weekly.
- **Restore check** (`file-share-verify`): `restoreTestSamples` over the samples of the newest
  restore point (`packages/core/src/endpoints/restore-test.ts` [V]), same green/red rules; readiness
  through a thin `packages/core/src/file-shares/readiness.ts` over `endpointReadiness` [V]
  (green, yellow, red, unverified, no backup; overdue after 8 days as `ENDPOINT_VERIFY_OVERDUE_DAYS`
  [V]).
- Locked-repository counting and the alert as for endpoints (docs/AGENT.md "Sperren" [V]).

### 8.5 Catalog (`file-share-catalog`)

After each successful backup: `restic diff --json <previous> <new>` [K] through the loopback; `+`
inserts a version with `first_seq = new`, `-` closes the open version (`end_seq = new`), `M` does
both. The first backup, or one whose previous restore point is no longer in the catalog, reads
`restic ls --json <new>` instead. `/.restow` is left out. Only files are catalogued (folders are
derived from paths). After retention, versions whose range no longer contains an active restore
point are deleted. A share above `maxEntriesPerShare` gets no catalog (`last_catalog_at` stays null,
the UI says "Search is not available for this share: too many files"); browsing restore points
works without it.

### 8.6 Purge (`file-share-purge`)

Deleting a share's backups (an explicit action, 9.1): delete every object under
`file-shares/<id>/` on the primary target, the cache volume through the mounter, then the rows
(cascade). Audited. Removing a share from a job, or retiring it, never deletes backups.

---

## 9. API

### 9.1 Tenant routes (`/api/v1/file-shares`, `features/file-shares/routes.ts`)

Tenant side: everything needs `tenant_admin` (`requireTenant("tenant_admin")`, as the PVE routes
[V `apps/api/src/features/pve/routes.ts:53`]); tenant users have no access in this release. Provider
side: the rule column, added to `PROVIDER_ROUTE_RULES` (`apps/api/src/lib/provider-access.ts` [V];
`app.provider-access.test.ts` fails for an unclassified route). Reading the content of the live
share or of a backup needs a technician, as for machines ("a read-only member sees that backups
happened, not their content" [V]).

| Route | Provider rule | Notes |
| --- | --- | --- |
| `GET /` | view | shares with status, readiness, last run, next run, job |
| `POST /` | configure | create; body 10.1; recent sign-in not needed (nothing restarts) |
| `GET /settings` | view | the installation settings that concern tenants (limits, whether private networks are allowed) |
| `GET /restore-targets` | operate | shares of the tenant that allow restores |
| `POST /test` | configure | test unsaved settings (runner `probe`) |
| `GET /:id` | view | detail; never the password (`hasPassword: true`) |
| `PATCH /:id` | configure | any field; `password` replaces the secret (no re-adding); changing server, share, export or subfolder of a share with restore points asks `confirmNewLocation: true` (the next backup reads everything again) |
| `POST /:id/test` | operate | test the stored settings; updates `last_test`, clears or sets `credential_failed_at` |
| `GET /:id/source?path=` | operate | live listing of one folder (runner `list`), for picking include folders |
| `POST /:id/backup` | operate | back up now (optional `allowEmptyOnce`) |
| `POST /:id/retire` | configure | stop protecting, keep backups |
| `POST /:id/reactivate` | configure | |
| `DELETE /:id` | configure + recent sign-in (`assertRecentSignIn` [V]) | purge backups; body `{ confirmName }` |
| `GET /:id/runs`, `GET /:id/runs/:runId` | view | run detail with items (paged) |
| `POST /:id/runs/:runId/cancel` | operate | |
| `GET /:id/snapshots` | view | |
| `GET /:id/browse?snapshot=&path=` | operate | restic listing via loopback (`resticListDirectory` [V]), `/share` mapped to `/`, `/.restow` hidden, permissions summary from the sidecar header |
| `GET /:id/search?q=&snapshot=` | operate | catalog |
| `GET /:id/versions?path=` | operate | catalog |
| `POST /:id/downloads`, `GET /:id/downloads/:downloadId` | operate | ZIP via `streamSnapshotZip` [V], `/.restow` left out |
| `POST /:id/restores` | operate | 4.7 parameters plus `targetShareId` |
| `POST /:id/verify` | operate | restore check now |
| `PUT /:id/quota` | configure, provider admins only (a tenant admin sees the budget, does not set it) | `{ quotaGib: number \| null }` (7.4) |
| `POST /:id/repository-password` | configure | the repository password for a restore without Restow, as for machines (`POST /api/v1/endpoints/:id/repository-password` [V]); audited |
| `PUT /:id/private-network-approval` | provider admin only (configure) | approve or withdraw (10.1) |
| `GET /installation-settings`, `PUT /installation-settings` | view(PROVIDER) / configure(PROVIDER); `tenantsMayUsePrivateNetworks` owner only | 7.4; under `/api/v1/file-shares/installation-settings` |

Backup jobs: the existing routes take `kind: "share"` and `kind: "copy"` (`jobKindSchema`,
`apps/api/src/features/backup-jobs/schemas.ts:46` [V]; `JobKindName` in `dto.ts`, `JobKind` in
`packages/core/src/backup-jobs/schedule.ts` [V]); candidates list shares; member targets accept
`fileShareId`. A copy job is created and changed with `sourceFileShareId`, `targetFileShareId` and
`BackupJobCopySettings`; the api applies the safety rules of 4.10 (problem type
`file-share-copy-unsafe-target`, with the rule that failed) and, for `mirror` into a folder that
exists and is not empty, answers 409 `file-share-copy-confirm` with the folder's entry count until
the request carries `confirmMirror: true`. Same rules as the other kinds (`configure` to change,
`operate` to run); `POST /api/v1/backup-jobs/:id/run` with `force: true` is **Copy anyway** (4.10
rule 6).

Mounter (`/api/v1/mounts`, `features/mounts/routes.ts` [V]): `POST /api/v1/mounts/enable`, rule
`own()`, recent sign-in (3.9). `GET /api/v1/mounts` gains the `enable` block for every provider
admin who may read it today.

Problem types: `urn:restow:problem:file-share-name-taken`, `file-share-host-not-allowed`
(with `reason`: `private_network` or `forbidden_address`), `file-share-restore-not-allowed`,
`file-share-busy`, `file-share-mounter-unavailable` (with the command to start it, or that the
provider owner can enable it), `file-share-quota-exceeded`, `file-share-copy-unsafe-target`,
`file-share-copy-confirm`.

### 9.2 Audit

Tenant audit log, actions `file_share.created`, `.updated` (changed field names only),
`.password_changed`, `.tested` (code only), `.retired`, `.reactivated`, `.purged`,
`.backup_requested`, `.restore_requested` (source, target, destination mode, counts of paths),
`.quota_changed`, `backup_job.*` for copy jobs as for every job (with `mode` and the mirror
confirmation),
`.download_created`, `.repository_password_shown`, `.private_network_approved` /
`.private_network_withdrawn`, `.repository.denied`. Details never contain the password, the token,
an option string or a mount detail that was not redacted; the username and server are fine.

---

## 10. Security model

### 10.1 Who may point Restow at which server

The host kernel mounts the share from the Docker host's network, inside the provider's network.
A tenant admin who could enter any address could make Restow read an internal file server of the
provider (or of another customer on the same LAN) into their own backups. Hence the IMAP rule
(`decideImapHost`, `apps/api/src/features/sources/imap-host.ts` [V]), with the address policy of
`packages/core/src/net/address-policy.ts` [V]:

- public addresses: everyone;
- link-local, multicast, reserved, unspecified (cloud metadata): nobody;
- loopback and private addresses (RFC 1918, 100.64/10, ULA, and a name that resolves to one):
  provider admins always may; their saving the share approves it (`private_network_approval`
  records who, when and the address). A tenant admin may only when a provider admin approved
  that share, **or** when the provider owner switched on **Tenants may use private networks**
  (`tenantsMayUsePrivateNetworks`, Installation > File shares, off by default; the self-hosted
  case: one organisation, its own LAN). Maintainer decision, section 18.
- Judged when saved **and on every run and test**: the worker and the api resolve the name, judge
  every address, pin one (`addr=`). An approval covers the approved address and its /24 (IPv4) or
  /64 (IPv6), so a DHCP renewal does not break backups; a name that suddenly resolves elsewhere
  fails with `share.address_blocked` until an admin saves the share again.

In a typical MSP installation the customer's file server is not reachable from the Restow host at
all; that needs a site-to-site VPN the provider runs, and the provider admin approves the share.
The add dialog says so when a tenant admin enters a private address.

### 10.2 What each process holds

| Process | Holds | Can |
| --- | --- | --- |
| api | master key, database, mounter secret | everything it does today; resolves, tests and lists shares through the mounter |
| worker | master key, database, mounter secret (new) | opens share passwords, starts runs |
| mounter | Docker socket, mounter secret; per request: one share password, one run token | root on the host (as today); never stores either secret |
| runner | one run token (its repository, append-only or read-only, until the run ends), that repository's password, the share's content | read its share (write it for a restore), add to its own repository |

A compromised runner (a malicious file server exploiting restic or `restow-share` through file
names, xattrs or content) can add garbage to its own repository, read the backups of that share
(the tenant's own data), and reach `api:3000` on the internal network with that token. It cannot
reach the database, the internet, other repositories, the Docker socket or the master key. It runs
without privileges, with `no-new-privileges`, all capabilities dropped but the file ones a backup or
restore needs, a read-only root file system and a pid limit.

### 10.3 Credentials

- The share password: sealed with the tenant DEK (`secrets`, kind `file_share_password`,
  tenant-scoped, re-wrapped with the tenant key, `packages/db/src/schema/secrets.ts` [V]). It is
  opened in the api (test, list) or the worker (runs) right before the mounter call, sent only in
  that request body over the internal network, and exists then only in the volume's options for the
  run's lifetime. It is never returned by the API (`hasPassword`), never in the audit log, the
  mounter history, a log line, a failure record or an error text (3.7, and the api passes every
  runner-derived text through `packages/core/src/failures/redact.ts` [V] with the password added).
- The run token: only its SHA-256 stored; expires with the run (5.1).
- The repository password: sealed (`file_share_repository`); sent to the runner in the session
  answer over the internal network; also in the sealed password document next to the repository
  (5.4).

### 10.4 Protocol hardening

- SMB1 cannot be configured (schema), `vers=2.0` neither. 2.1 is allowed for old NAS devices; the
  form marks it "not recommended", and the share list shows a warning badge.
- `sec=ntlmssp` only; no raw NTLM or LANMAN. Kerberos is not supported in this release (no keytab
  or ticket cache in a short-lived container; section 15).
- **Encryption (`seal`)**: offered for 3.0 and 3.1.1; off by default because many NAS devices are
  slow with it; the form recommends it when traffic leaves the local network.
- Signing: SMB 3.1.1 signs by default and negotiates it [K]; nothing to configure.
- NFS is `AUTH_SYS` (host-based), as for the storage mount; Kerberos (`sec=krb5`) is not supported.

### 10.5 Restore safety

- A restore never deletes (`--delete` is never passed) and never writes outside its folder. The
  only deleting run is a `mirror` copy, inside its target folder only, under the six rules of
  4.10.
- Writes into a share only when that share allows restores; the switch is audited.
- `keep_both` never overwrites; `skip` never touches an existing file.
- A restore of share A's data into share B reads A's repository with the `reader` principal; it
  cannot write to A's repository.

---

## 11. Failure catalog

New category `share` in `FailureCategory`; every code gets an entry in
`packages/core/src/failures/catalog.ts` and texts in `packages/i18n/resources/{en,de}/failures.json`
(the test that requires all three exists [V `packages/core/src/failures/types.ts` header]).

| Code | Transient | Meaning and first step |
| --- | --- | --- |
| `share.auth_failed` | no | The server refused the account: wrong password, expired (`expired` param), locked, or no access to this share. → Check the account, enter the new password (no re-adding needed). |
| `share.unreachable` | yes | No answer from the server (address, firewall, port 445 or 2049, VPN). |
| `share.not_found` | no | Share, export or subfolder does not exist. |
| `share.version_mismatch` | no | The server does not speak the selected SMB or NFS version, or refused encryption. → Try 3.0, or switch encryption off. |
| `share.permission_denied` | no | Mounted, but the account may not read the folder. → Give the account read rights, ideally Backup Operators. |
| `share.client_missing` | no | The Docker host's kernel has no `cifs` or `nfs` client. → `modprobe cifs`; on some cloud kernels `linux-modules-extra-$(uname -r)`; for NFS `nfs-common`/`nfs-utils`. |
| `share.mount_failed` | no | Another mount error; the redacted detail is shown. |
| `share.address_blocked` | no | The address is private or reserved and not approved (10.1). |
| `share.wrong_filesystem` | no | The runner did not find the share mounted (4.2). Support case. |
| `share.empty_source` | no | The share or its include folders are empty although the last restore point was not. Nothing was backed up, nothing will be pruned. → Check the share; **Back up the empty share once** if intended. |
| `share.include_missing` | no | An include folder no longer exists. |
| `share.locked_files` | no (warning) | Files open on the server were skipped; list in the run. |
| `share.read_errors` | no (warning) | Other per-file read errors. |
| `share.files_dropped` | no (warning) | Fewer than half the files of the previous restore point. |
| `share.acl_partial` | no (warning) | Permissions of some files could not be read or restored; the account lacks the privilege (Backup Operators; SeSecurityPrivilege for auditing entries). |
| `share.offline_skipped` | no (info) | Offline (tiered) files were skipped, as configured. |
| `share.restore_not_allowed` | no | The target share does not allow restores. |
| `share.copy_no_verified_point` | no | The copy job's source has no restore point with a passed restore check yet. → Wait for the restore check, or run it now on the source. |
| `share.copy_unsafe_target` | no | The copy target breaks a safety rule (same share, share root for mirror, foreign or unconfirmed folder). The parameter names the rule. |
| `share.copy_empty_source` | no | Mirror refused: the restore point is empty or has fewer than half the files of the last copy. → Check the source; **Copy anyway** if intended. |
| `share.restore_partial` | no (warning) | Some files could not be written (names, rights, space). |
| `share.repository_locked` | yes | The repository stayed locked. |
| `share.repository_damaged` | no | restic reported damage; run a check, see docs. |
| `share.quota_exceeded` | no | The share's or tenant's budget for file share backups is used up; new backups are refused. → Raise the budget or tighten retention. |
| `share.out_of_memory` | no | The runner exceeded its memory limit; raise it (Installation > File shares). |
| `share.timeout` | no | The run exceeded `maxRunHours`. |
| `share.mounter_unavailable` | yes | The mounter is not running, or its runner is not ready (network, image, limit). |
| `share.runner_failed`, `share.runner_lost`, `share.runner_stalled` | yes | The runner ended without a result, disappeared, or stopped reporting. |

Run classification (`packages/core/src/file-shares/failures.ts`): a run's cause is the finish code;
items are grouped by code into the warning causes above, the way `classifyRunError` and
`failureOfRun` work for agent runs (`packages/core/src/endpoints/run-failures.ts` [V]).

---

## 12. UI

### 12.1 Where

- Navigation: group "Servers & clients" (`apps/web/src/features/registry.ts`, group `endpoints`
  [V]) gets **File shares** / **Freigaben** at order 27, between "VMs & containers" (25) and
  "File restore" (30).
- The **File restore** page lists machines and file shares as sources (12.4).
- **Backup jobs** gets the kinds "File shares" and "File share copies" next to mail and machines.
- **Installation > Network shares** gets a section **File share runners** (status, limits, 7.4).

### 12.2 Adding a share

A dialog in four steps, everything checked live:

1. **Protocol**: SMB (Windows, Samba, NAS) or NFS.
2. **Connection**. SMB: server, share, subfolder (optional), user (accepts `DOMAIN\user`,
   `user@domain` or a plain name with a separate domain field), password, SMB version (3.1.1
   default, 3.0, 2.1 "not recommended"), encryption switch. NFS: server, export, subfolder, version
   (4.1 default). A private address shows the approval notice (10.1); a tenant admin without the
   installation switch cannot continue and is told whom to ask.
3. **Test connection**: runs the probe; shows the top level of the share, whether permissions are
   readable and through which level ("Owner and permissions" / "Permissions only" / "Not readable:
   add the account to Backup Operators to back up NTFS permissions"), or the classified error with
   its first step. Saving without a successful test is possible (a server that is down tonight)
   but asks once.
4. **Options**: name, **Back up permissions** (on), **Allow restore to this share** (off, with the
   explanation that restores could then overwrite files there), then **Save** and the offer **Add to
   a backup job** (an existing share job or a new one).

When the mounter is not running, provider owners see **Enable network shares** when the opt-in
updater runs, else the one command (`docker compose --profile mounts up -d mounter`, docs/MOUNTS.md
[V]); other provider admins see the state and that an owner can enable it (3.9). Tenant admins see
"File share backup is not enabled in this installation; ask your provider".

### 12.3 Share page

Tabs, following the guest and machine pages (`apps/web/src/features/pve/guest-page.tsx`,
`apps/web/src/features/endpoints/endpoint-detail-page.tsx` [V]):

- **Overview**: protection state, readiness row, last and next run, live progress of a running run
  (phase, files and bytes with totals from the walk, current path, throughput sparkline from
  `run_samples`), repository size against the budget, connection status with the last test,
  credential warning when `credential_failed_at` is set ("The server refused the password on
  …; enter the new one").
- **Restore points**: the generalised snapshots tab (12.4).
- **Runs**: run list with status, duration, files, data added, warnings; the run sheet
  (`run-sheet.tsx` [V] generalised) with the per-file items grouped by cause, the failure
  explanation from the catalog, and the action **Back up the empty share once** for
  `share.empty_source`.
- **Settings**: connection (password change field "leave empty to keep"), permissions options,
  allow restore, private network approval (badge; provider admins can withdraw), job membership with
  include folders, **Storage budget** (GiB or "No limit"; editable by provider admins, shown to
  tenant admins with the usage bar and the 80 % warning), copy jobs that read from or write to
  this share.
- **Danger zone**: retire, delete backups (type the name, recent sign-in).

### 12.4 Restore

The endpoint restore components are generalised behind a source adapter
(`apps/web/src/features/endpoints/file-restore-page.tsx`, `components/file-browser.tsx`,
`restore-dialog.tsx`, `snapshots-tab.tsx`, `browser-download.ts` [V] move to
`apps/web/src/features/restore/files/` with `adapter.ts`: list restore points, browse, search,
versions, download, restore, capabilities). The explorer's search field and version history
(`apps/web/src/features/restore/explorer/search-field.tsx`, `version-history.tsx` [V]) are used
for shares when the catalog exists.

Restore dialog for a share:

1. Selection (files and folders from the browser or the search).
2. **Where to**: "Download as ZIP"; "Original location" and "New folder in this share" (disabled
   with the reason when the share does not allow restores, linking to the setting for those who
   may change it); "Another file share" (the list from `GET /restore-targets`, with a folder field
   defaulting to `Restow-Restore-<timestamp>`). Under "Another file share" a link **Repeat on a
   schedule** opens the copy job editor with source, target and folder filled in.
3. For "Original location": **If a file exists**: overwrite / keep both (the restored copy gets
   "(restored <date>)") / skip.
4. **Restore permissions** (defaults 4.7), **Verify written files** (NFS on, SMB off).
5. Summary and confirm. The run appears in Runs with live progress; the result lists the counts
   and any items.

### 12.5 Backup job editor (kind `share`)

Members: pick shares; per member **Folders** ("Everything" or picked folders from a live browser
of the share, `GET /:id/source`). Job: schedule, retention (keep daily, weekly, monthly), excludes
(text area with the preset switch "Skip temporary and system files" and its list shown),
file types to skip (chips), skip files larger than, bandwidth limit and windows, read concurrency,
"Back up offline (tiered) files" (off), restore check (always on, weekly sample).

### 12.6 Copy job editor (kind `copy`)

Header badge "Not a backup: no versions on the target". Fields: source share, target share (only
shares that allow restores, the source excluded), target folder (picked from a live browser of the
target share or typed; mirror requires a folder below the root), mode (**Overwrite**: "files are
added and updated, nothing is deleted"; **Mirror**: "the folder becomes an exact copy; files that
are not in the source are deleted"), restore permissions, verify, schedule. Saving a mirror into a
non-empty folder shows its entry count and asks to confirm by typing the folder name. The job page
shows the restore point copied last, "Already up to date" runs collapsed, and the run list with
the same run sheet as restores.

### 12.7 i18n

New namespace `fileshares`; failure texts in `failures`; job texts in `backupjobs`; overview
labels in `dashboard` and `stats`; installation settings in `installation`. The i18n scan of the
smoke (`scripts/smoke/lib/i18n-scan.mjs` [V]) covers the new pages; German follows the glossary
(Freigabe, Sicherungsstand, Lauf, Restore-Prüfung, Berechtigungen, ursprünglicher Ort).

---

## 13. Overviews, readiness, statistics, history

One rule (`packages/core/src/file-shares/protection.ts`, mirrored by
`apps/api/src/features/file-shares/protection.ts` for SQL, like the PVE pair [V]):

- **Protected** while not retired and a member of an enabled share job. A share in no enabled job
  counts as "in no backup job".
- **Readiness**: the restore check of the newest restore point (8.4).
- **Failed**: the newest finished backup run of a protected share failed.
- **Warnings**: the newest run ended with warnings and no acknowledgement covers its causes
  (`warning_acknowledgements.file_share_id`, 7.2).
- **Overdue**: no successful backup for longer than the enabled jobs' schedules allow
  (`apps/worker/src/overdue.ts` [V], `backup.overdue`).

Counted side by side with mailboxes, machines and guests everywhere they are counted today: the
Status tab and `GET /status` (`fileShares`), Recovery readiness (a row per share), the dashboard DTO
(`apps/api/src/features/dashboard/dto.ts` [V]: `fileShares: { protected, withoutJob,
lastSuccessAt }`, `staleAfterHours.fileShares`), the provider view (`fileShares`,
`fileSharesWithoutJob`, `fileSharesFailed`, alerts `file_share_backup_failed` and
`file_shares_without_job`), the warnings page, the statistics (`apps/api/src/features/stats/`:
`file-share-facts.ts` and `file-share-timeline.ts` next to `guest-facts.ts` and
`guest-timeline.ts` [V]; readiness series and backup outcomes; volume from `bytes_added`), and
History (`apps/api/src/features/history/read.ts` [V] gains `file_share_runs` as a third source in
its keyset union, `RunSource` `"file_share"`, live updates through `live.ts`). "Nothing protected"
is said only when a tenant has no object, machine, guest and share. Copy jobs are not protection:
they appear in History and in the run counts as restores, never in the protected counts or the
readiness.

---

## 14. Notifications, webhooks, reports

- Report events reuse the existing ones (`packages/core/src/reports/catalog.ts` [V]):
  `backup.failed` (including `share.auth_failed`, so a changed password reaches someone the same
  night), `backup.overdue`, `restore.failed`, `restore.completed`, `verify.red`, `verify.yellow`,
  `verify.recovered`. The subject is the share; the in-app notification links to it. Copy runs
  raise `restore.failed` and (only when something was copied) `restore.completed`, with the copy
  job as the subject. New:
  `file_share.repository_locked` (as `endpoint.repository_locked`) and
  `file_share.storage_quota` (as `endpoint.storage_quota`, at 80 % and at 100 %, 7.4).
- Webhooks (`apps/worker/src/handlers/webhooks.ts` [V]): `job.completed` / `job.failed` with
  `data.job.queue` `"file-share-backup"`, `"file-share-restore"` or `"file-share-copy"`,
  `protectedObjectId: null` and a
  new `data.fileShare: { id, name, protocol }`, plus `failure`; `verify.completed` for restore
  checks. The chat formats (`webhook-formats.ts` [V]) name the share.
- Scheduled reports include a "File shares" block (protected, failed, warnings, readiness) where
  they list machines.

---

## 15. Limits of this release

- **No VSS over SMB.** Files are read one after another while people work; a file open with an
  exclusive lock is skipped (warning). Server-side snapshots as a consistent source (Windows
  "Previous Versions" via the cifs `snapshot=` mount option, NetApp/Synology/QNAP snapshot folders)
  are a later option: the Linux client cannot list the available shadow copies, so the runner
  would have to guess a time, and a wrong guess fails the mount [I]. Recommended today: back up at
  night; for databases and PST files use an agent with VSS on the server.
- No alternate data streams (6), no DFS namespaces (`nodfs`), no Kerberos, no SMB1.
- A copy job copies the newest *verified* restore point, so the target lags the source by at
  least one backup and one restore check; it keeps no versions (that is what the source's
  backups are for).
- Repositories live on the primary storage target only; no copy target, no storage migration of
  `file-shares/` (as for machines and guests).
- One mounter per installation; runners on the Docker host only (no remote runner near the file
  server). A file server reachable only through a slow link is backed up over that link.
- Tenant users (not admins) have no self-service restore for shares.
- Restore of a single file's permissions only together with the file.
- arm64 hosts: supported as far as the image is; the kernel must have the `cifs` module.

---

## 16. Tests

### 16.1 Automated, no network share

- **Mounter** (`apps/api/src/mounter/*.test.ts`): runner protocol validation (every field, the
  password vectors), option strings (golden: SMB ro/rw, seal, domain, NFS v3/v4.x), redaction of
  real Docker error formats, errno classification table, container spec (no network for exec,
  labels, caps by kind, image from the api container), lifecycle with a fake Engine client (start
  failure cleans up, exit removes volumes at once, deadline kill, adoption and GC on start),
  boundary test extended to the new files.
- **restow-share** (Go, `agent/internal/share/*_test.go`): sidecar writer and reader against golden
  files (dedupe, non-UTF-8 paths, trailer missing, unknown types, higher version), the walk with a
  fake xattr layer (fallback chain, per-file errors, ctime reuse), guards (fs type via an injectable
  `statfs`, mountinfo parsing, empty root, missing include), exclude-file generation and escaping,
  restic argument vectors per protocol, keep-both reconcile on a temp directory, permission
  application order and fallback with a fake setter, exit codes, redaction of logs. `go vet` and the
  stdlib-only check that `restow-pve` already passes.
- **Core**: validation vectors shared with the mounter, readiness, protection, failure
  classification, catalog diff application, sidecar reader against the Go golden files, queues.
- **restic authz**: the matrix with the `reader` column.
- **Copy rules** (`packages/core/src/file-shares/copy.ts`): every safety rule of 4.10 as a table
  test (same share by id and by location, root, marker missing, foreign marker, confirmation
  cleared by a target change, empty and halved restore points); restic argument vectors for both
  modes; the marker excluded from `--delete`.
- **Quota**: thresholds 80/70/100 with the parametrised `quota.ts`; machine thresholds unchanged.
- **Installer** (`deploy/install/test.sh`): the cases of 3.9.
- **Updater** (`apps/api/src/updater/*.test.ts`): `POST /v1/mounter/enable` with a fake launcher:
  compose file without a mounter service refused, refused during an update, image written only
  when the updater runs a pinned signed image, helper failure recorded and redacted.

### 16.2 Postgres suites (`*.pg.test.ts`)

- `apps/api/src/features/file-shares/file-shares.pg.test.ts`: CRUD, RLS (tenant A never sees B's
  shares, runs, items, snapshots, catalog), private-network decisions, provider-access rules, the
  password never in a response or the audit log, restore-target rules, problem types.
- `file-shares.restic.pg.test.ts` (needs `RESTIC_BINARY`, like `endpoints.restic.pg.test.ts` [V]):
  a fake runner (the test process) with a run credential backs up a temp folder through
  `/internal/file-shares/restic`, append-only enforced, credential dead after finish and after
  expiry, `reader` cannot write, persisted locks, quota refusal, maintenance prune via loopback,
  ZIP without `/.restow`, restore check green and red.
- `apps/worker/src/file-shares/*.pg.test.ts`: dispatcher (limit, singleton per lock share, restore
  priority, mounter unavailable → back to queued), monitor (every stale state), finish processing,
  retention never removing the newest non-empty restore point, catalog from `restic diff`, budget
  refusal at dispatch and the 80 % alert once, copy dispatch (newest verified point, "already up to
  date", no verified point, rules re-checked at dispatch).
- `apps/scheduler/src/file-shares.pg.test.ts`: planning of share and copy jobs, member schedules,
  maintenance due rules.
- Migrations: 0033-0035 apply on a database at 0032 with existing jobs, members, samples and
  acknowledgements; the replaced checks accept the old rows; deleting a share cascades to its
  copy jobs.

### 16.3 Phase A host checks ([I] items)

Run on Ubuntu 24.04 (generic and cloud kernel), Debian 12 and a RHEL 9 host with SELinux
enforcing, against Windows Server 2022 (NTFS), Samba 4.x with `vfs_acl_xattr`, and one Synology
and one TrueNAS share; NFS against Linux knfsd v3 and v4.2 and a NAS:

1. Docker local driver passes `addr=` for cifs unchanged; mount error texts and errno mapping of
   logon failure, share access denied, missing share, wrong version, refused encryption,
   unreachable host, missing module.
2. Comma doubling in `password=` through Docker's `o=`.
3. `system.cifs_ntsd_full`/`ntsd`/`acl` readable without `cifsacl`; privileges needed for each;
   setting them back; `backupuid=0` with an account in Backup Operators reads a file it has no ACL
   for.
4. `user.cifs.dosattrib` and `user.cifs.creationtime` read and set per server.
5. `ctime` moves on an ACL change (NTFS, Samba, NAS) for the ACL reuse.
6. Sharing violation errno for a file open exclusively in Excel.
7. NFSv3 POSIX ACL xattrs and NFSv4 `system.nfs4_acl` through the client.
8. restic 0.19.1 flags used here (`--exclude-xattr`, `--overwrite`, `--read-concurrency`,
   `--retry-lock`, `diff --json`) and its exit code 3.
9. SELinux `context=` option.
10. Memory of restic at 1, 5 and 10 million files with `GOMEMLIMIT`, and walk time over SMB at 1 ms
    and 20 ms latency; the numbers go into this document.

### 16.4 Smoke (`scripts/smoke/checks/12-file-shares.mjs`)

A Samba container (image pinned by digest in `scripts/smoke/images.json` [V]) with `vfs objects =
acl_xattr`, a share with a few hundred files in folders, one file with an explicit ACL set by
`smbcacls`, one file name with non-ASCII characters. The CI step loads the `cifs` module (installs
`linux-modules-extra-$(uname -r)` when needed). Steps: the mounter runs (the new installer
default); add the share as
provider admin (private address approved); a tenant admin's attempt with the same address refused
until **Tenants may use private networks** is on; test; job with a schedule and one excluded pattern; back
up now; assert the restore point, sample count, permissions entries; change and delete a file; back
up again; browse; search; ZIP download and compare; restore one folder to a new folder with
permissions and compare the content byte for byte and the ACL with `smbcacls`; restore with
"keep both" to the original location and check the renamed copy; empty the share and assert
`share.empty_source` with the previous restore points untouched; a second Samba share as copy
target: a `mirror` copy job into a folder, run it, delete a file on the source, back up, restore
check, copy again and assert the file is gone in the target folder and nothing outside it changed;
a mirror into the share root refused; wrong password → `share.auth_failed`
and the credential warning; no api or worker restart happened during the whole check (container
start times unchanged). NFS is covered by the pg suites and the Phase A host checks: an NFS server
container needs a privileged kernel server that CI runners do not provide reliably.

### 16.5 E2E

The add dialog, the restore dialog's destinations and their disabled states, the job editor's
folder picker, the copy job editor with the mirror confirmation, the budget field, **Enable network
shares** with a fake updater, in both languages without missing keys.

---

## 17. Phases

All four phases are in this release; they are the build order, each ends green in CI.

**Phase A: infrastructure.**
Mounter runner operations (3), compose `runners` network and worker mounter access, Caddy
`/internal` fence, `restow-share` with probe, list, backup, restore, sidecar (4), built into the
image; generalised restic route with the `reader` principal and persisted locks, PVE moved onto it
(5.3); runner routes with a test-only share model; mirror mode and the copy marker in
`restow-share`; installer default and `--without-mounter` (3.9) with `test.sh`; the updater's
`POST /v1/mounter/enable`; the host checks of 16.3 with results recorded here. Exit: a backup and a restore of a Samba share driven from a test script through the api's
internal routes, permissions round-trip, no restart.

*Phase A as built (2026-10-10, infrastructure part).* Done: the mounter's runner operations
(`runner-protocol.ts`, `runner-ops.ts`, `runner-engine.ts`, routes in `server.ts`, settings of
3.8, adoption and label GC on start, deadline sweep, `runner-runs.json` without secrets; a test or
list is capped at 4 at a time and 256 MiB); `restow-share` (`agent/cmd/restow-share`,
`agent/internal/share`) with probe, list, backup, restore, keep both, mirror with the marker, the
sidecar (golden file `agent/internal/share/testdata/sidecar/v1-basic.jsonl`), built by
`agent/build.sh` into `dist/server/linux-<arch>/` (in no SHA256SUMS: it is not a download) and
installed as `/usr/local/bin/restow-share` by the Dockerfile, which compiles it from source when a
signed prebuilt release lacks it; `lib/restic-run-route.ts` with the `reader` principal, the PVE
route on it, `/internal/file-shares/restic` with the credential lookup behind an interface;
Caddy's `/internal/*` 404; the `runners` network and the worker's mounter access in both compose
files; the core's runner types, validation mirror and HTTP client
(`packages/core/src/file-shares/`), the worker's `file-shares/mounter-client.ts`. Moved to Phase B
because they need its tables: the runner routes `/internal/file-shares/v1/*` (restow-share
implements their client side, 5.2), the persisted run credentials (until then
`MemoryRunCredentials`, so the restic route answers 401 to every real runner), the persisted lock
registry and the budgets of the restic route, and the audit entry `file_share.repository.denied`
(it needs its labels, Phase C; denials are logged until then). Not in this part: the installer
default and the updater's `POST /v1/mounter/enable` (3.9), and the host checks of 16.3, which need
real file servers. The session of a restore (5.2) carries `restore.targetShareId` and, for a copy
run, `restore.copy` (`jobId`, `sourceShareId`, `mode`, `mirrorConfirmed`, `lastCopiedFileCount`,
`force`), which the runner checks again (4.10 rules 2-6).

**Phase B: database, core, scheduler, worker.**
Schema and migrations 0033-0035, RLS (7); core modules (validation, queues, protection, readiness,
failures, sidecar reader, catalog); generalised `RepositoryAccess` and repository key document;
scheduler planning of share and copy jobs (8.1); worker dispatcher with budget and copy rules,
monitor, finish, retention, check, restore check, catalog, purge (8.2-8.6); parametrised
`quota.ts`; failure catalog entries (11); overdue, webhooks, report events (14).
Exit: the pg suites of 16.2 green; a scheduled backup runs end to end without UI.

*Phase B as built (2026-10-10).* Done, in the places section 2.4 names:

- **Database.** `packages/db/src/schema/file-shares.ts` with the tables of 7.1; migrations
  `0033_file_shares` (tables, `settings.file_share_settings`, `run_samples.file_share_run_id`,
  `warning_acknowledgements.file_share_id` with their `num_nonnulls` checks, the `pg_trgm` block),
  `0034_backup_job_kinds_share_copy` (the two enum values only) and
  `0035_backup_job_file_shares` (member column, copy job columns and checks); RLS for the nine
  tables in `sql/rls.sql`; secret kinds `file_share_password`, `file_share_repository`;
  `recordRunSample` takes a `fileShareRunId`. Tests: `packages/db/src/file-shares.pg.test.ts`
  (isolation of every table, the run singletons, the name rule, the cascade) and an upgrade case
  in `migrate.pg.test.ts` (0033-0035 on a 0032 database with jobs, members, samples and
  acknowledgements; the new checks; a deleted share takes its copy jobs along).
- **Core** (`packages/core/src/file-shares/`): `model.ts` (repository prefix and cache key, the
  snapshot paths, the settings of 7.4 with their bounds and the mounter's caps, the exclude list
  of 7.5), `queues.ts`, `budget.ts` (on `quota.ts`, whose thresholds are now a parameter;
  machines keep 90/80, shares use 80/70), `failures.ts`, `readiness.ts`, `protection.ts`,
  `sidecar.ts` (reads the Go golden file), `catalog.ts`, `copy.ts` (rules 1-3, 5, 6 and the
  restore point a copy takes), `session.ts` (the run credential and the backup half of the
  session), `address.ts` (the address rule of 10.1 with the /24 and /64 approval range),
  `restic.ts` (streaming `restic diff --json` and `ls --json`). `RepositoryAccess.endpointId` is
  now `repositoryKey`; `endpoints/repository-key.ts` is one document with a
  `RepositoryPasswordKind` per kind of repository, the endpoint functions unchanged on top. The
  failure catalog has the category `share` with the 30 codes of section 11 and 15 new steps,
  texts in `en` and `de`; the report events `file_share.storage_quota` and
  `file_share.repository_locked` with their texts; alerts about a share use the subject key
  `file_share:<id>`.
- **api.** The runner routes `/internal/file-shares/v1/{session,progress,items,samples,finish}`
  (`features/file-shares/runner-routes.ts`, public routes classified in `provider-access.ts` and
  the public-routes test); the restic route now looks credentials up in `file_share_runs`
  (`PgRunCredentials`), keeps the backup runners' locks in `file_share_repository_locks`, counts
  uploads into `file_shares.repository_bytes`, refuses uploads over the share's or tenant's
  budget (and notes `quota_refused_at`) and audits denials as `file_share.repository.denied`
  (labelled in `audit.json`, like the worker's `file_share.purged`; the feature's constants are
  in `features/file-shares/constants.ts`, since a `meta.ts` there would declare the tenant
  routes of Phase C).
  `features/backup-jobs` leaves `share` and `copy` jobs out of every list and answers 409
  `urn:restow:problem:backup-job-kind-unsupported` on any route that names one, until Phase C.
- **Scheduler.** `apps/scheduler/src/file-shares.ts`: due share jobs, members with their own
  schedule, copy jobs, and the maintenance of 8.1 from the share rows; the queues are created
  with the shared settings.
- **Worker** (`apps/worker/src/file-shares/`): `queue.ts` (the two queueing handlers),
  `dispatch.ts` (the loop of 8.2, repository initialisation of 5.4, the address rule, the
  budget, the copy rules), `finish.ts` (8.3 finish processing, alerts and webhooks), `monitor.ts`,
  `maintenance.ts` (retention, check, restore check, lock counting), `catalog.ts`, `purge.ts`,
  `register.ts`; `overdue.ts` knows the candidate kind `file_share`. The endpoints' lock
  clearing is now the shared `clearClientLocks` (`apps/worker/src/endpoints/maintenance.ts`).
- **Tests.** Besides the unit tests of every core module: `apps/api/.../file-shares.pg.test.ts`,
  `apps/worker/src/file-shares/file-shares.pg.test.ts` (queueing, dispatcher, monitor, finish,
  budget alerts, overdue, retention against restic), `apps/scheduler/src/file-shares.pg.test.ts`,
  and the exit test `apps/worker/src/file-shares/e2e.pg.test.ts`: the dispatcher starts a run
  through a stand-in mounter that runs the real `restow-share` on a folder, the runner talks to
  the api's real runner and restic routes in a child process
  (`apps/api/src/features/file-shares/testing/runner-server.ts`), restic 0.19.1 writes the
  repository; then the restore point is recorded, checked green, catalogued from `restic diff`,
  retention prunes the older point, and a restore run writes the newest one into a new folder,
  compared byte for byte. The runner build for it is `go build -tags sharetest`
  (`agent/cmd/restow-share/testmount.go`: a plain folder stands in for the mount; release builds
  do not contain the file).

Deviations from the design above, decided while building:

1. **0035 compares `kind::text = 'copy'`.** Drizzle's migrator applies every pending migration in
   one transaction, and a value `ALTER TYPE ... ADD VALUE` added cannot be used as an enum value
   before that transaction commits. On an installation at 0032, 0034 and 0035 run together, so
   the checks compare the text. The copy checks are one `CASE` (a copy job has both shares, any
   other job neither) and `source <> target`.
2. **`file_share_catalog` has an `id` and `created_at`** (the schema's convention, checked by
   `schema.test.ts`); the doc's primary key is the unique index
   `(file_share_id, path, first_seq)`, and an index on `(file_share_id, end_seq)` finds the open
   versions. Paths longer than 2,000 bytes are not catalogued (a btree entry must fit a page).
3. **Two columns more:** `file_share_runs.finish_processed_at` (the worker processes a finish
   once; the monitor processes finishes nobody queued) and `file_share_snapshots.cataloged_at`
   (what the catalog planner looks at). Reports and samples carry the restic snapshot id as text,
   as for endpoints; `file_shares.last_snapshot_id` is the restore point row.
4. **A tenant's own budget for all its shares** is `tenantShareQuotaGibByTenant` in the
   installation settings (the tenants table has no settings column); Phase C writes it.
5. **No separate cancel route.** A cancel reaches the runner in the answer of `POST /progress`
   (5.2); the monitor stops a run that did not honour it within two minutes, and a queued run
   with a cancel request ends without starting.
6. **The repeated finish** is recognised by its status, restic snapshot id and code (no body
   digest is stored), and accepted for 15 minutes after the run ended; a different one is 409.
7. **The session's repository URL** is built from the `Host` the runner used to reach the api
   (the mounter's `RESTOW_MOUNTER_RUNNER_API_URL`), so no second setting can disagree with it.
8. **A scheduled tick while the share's backup is still queued** is recorded as a cancelled run
   with the note "Skipped: the previous run was still running", rather than measured against the
   job's interval.
9. **The empty-source guard has a second line on the server:** a backup that reports success with
   0 files after a restore point with files, without "back up the empty share once", is recorded
   as failed (`share.empty_source`); its restic snapshot is then one no run recorded, which
   retention never deletes. Retention also never removes the newest restore point with files.
10. **The check reads a rotating twentieth** of the data (`checkSubset` of the endpoints, 5 % a
    week, the whole repository in five months) instead of a random 5 %.
11. **Suspicious snapshots** (not recorded, dated in the future) are counted in the retention
    report only; shares have no table like `endpoint_snapshot_flags` and raise no alert for them.
12. **Shares share the endpoints' advisory lock space** (`withEndpointRepositoryLock` with the key
    `file-share:<id>`) for retention, check, restore check and catalog.
13. **The runner limit** is counted from the database (`starting` and `running` runs); the
    mounter's own `runner.limit` refusal puts the run back into the queue like an unreachable
    mounter. A name that does not resolve fails the run as `share.unreachable`.
14. **The catalog after a gap** (the first backup, a previous restore point that is gone, a share
    that had no catalog) closes every open version and opens the listed ones from `restic ls`;
    a restore point with more files than `maxEntriesPerShare` removes the share's catalog.

Deferred to Phase C: the tenant routes of 9.1 (nothing queues `file-share-purge` yet, and manual
backups, restores and copies are not requested by any route), copy and share jobs in the
backup-job routes (refused until then), the quota, private-network-approval, settings and
repository-password routes, downloads and browsing (the tables and the sidecar reader exist),
the SQL mirror of `protection.ts`, the labels of the audit actions of 9.2 and the name lookup
of the target type `file_share` (`ee/api/src/audit-log/labels.ts`), the web's copy of the report
event list (`apps/web/src/features/reports/api.ts`, `presenters.ts`) with
the two new events, the targets of the new failure steps in the UI, the chat formats of
`webhook-formats.ts` naming the share. Deferred to Phase D: overviews, statistics, history,
dashboard counts, the smoke check, the operator documentation. The worker reads the mounter's
caps from `RESTOW_MOUNTER_MAX_RUNNERS` and `RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB` in its own
environment, which the compose files do not set yet (the defaults 8 and 16384 match the
mounter's).

**Phase C: api, web, i18n.**
Tenant routes and provider rules (9), copy jobs in the backup-job routes, the quota route,
`POST /api/v1/mounts/enable`, problem types, audit; web pages, dialogs, share and copy job editors,
budget field, **Enable network shares**, restore generalisation (12); overviews, statistics, history (13); i18n in both languages; GLOSSARY.md
rows (1). Exit: E2E of 16.5; every route classified; no missing keys.

**Phase D: integration and documentation.**
Smoke check 12 (16.4); operator documentation: the "how it works" sections of this file in the
style of PVE.md (requirements: mounter, kernel modules, the account and its rights, firewall ports
445/2049, private networks, budgets, copy jobs; troubleshooting per failure code),
docs/MOUNTS.md ("Enabling it": on by default for new installations, the button for existing ones)
and docs/ARCHITECTURE.md updated, the installer's `--help` and README, CHANGELOG entry, THIRD_PARTY_NOTICES unchanged (stdlib only),
release notes. Exit: release smoke green.

---

## 18. Maintainer decisions (2026-10-10)

The first draft ended with open questions; the maintainer answered them, and the design above
follows the answers:

1. **Scheduled copy jobs are in this build** (`backup_jobs` kind `copy`, 4.10, 7.2, 7.5, 8.1,
   8.2, 12.6): the newest verified restore point of share A into a folder of share B, `overwrite`
   or `mirror`, as a restore run; labelled "Not a backup: no versions on the target"; mirror only
   inside the target folder, never into a share root or the source share, with a confirmation for
   a non-empty folder.
2. **Private networks:** tenant admins need a provider admin's approval per share (the IMAP rule)
   or the installation switch **Tenants may use private networks** (provider owner, off by
   default). Provider admins always may (10.1).
3. **Mounter:** on by default for new installations (`install.sh`, opt-out `--no-mounter` /
   `--without-mounter`); existing installations enable it from the web interface through the
   opt-in updater, or with the one command shown (3.9). Enabling from the web interface is in
   scope.
4. **Budgets:** off by default, settable per share in the web interface; warning at 80 %, new
   backups refused at 100 %, like the machine budgets (7.4).
5. **Glossary:** "Freigabe" moves to the new "file share" row; Phase C edits GLOSSARY.md
   (section 1).

Still deferred, with the reason in section 15: server-side snapshots as the source (the cifs
`snapshot=` option) as a VSS substitute.

---

## 19. Code references (this repository)

| Area | Files |
| --- | --- |
| Mounter today | `apps/api/src/mounter/{protocol,ops,engine,server,store,config,main,override}.ts`, `boundary.test.ts`; api side `apps/api/src/features/mounts/{routes,service,mounter-client}.ts` |
| Engine API, redaction | `apps/api/src/updater/engine-api.ts`, `apps/api/src/updater/redact.ts` |
| PVE container repositories | `apps/api/src/features/pve/restic-route.ts`, `apps/worker/src/pve/maintenance.ts`, `packages/db/src/schema/pve.ts` |
| restic stack | `packages/core/src/endpoints/{loopback,restic-cli,restic-rest,restic-authz,repository-key,repository-storage,retention-policy,restore-test,zip,readiness,run-failures,queues,quota}.ts` |
| Agent Go packages | `agent/cmd/restow-pve`, `agent/internal/{restic,redact,buildinfo}`, `agent/build.sh`, `Dockerfile` (`agent-build`, `agent-dist`) |
| Jobs | `packages/db/src/schema/backup-jobs.ts`, `packages/core/src/backup-jobs/*`, `apps/api/src/features/backup-jobs/*`, `apps/scheduler/src/{store,planning,endpoints}.ts` |
| Access | `apps/api/src/lib/provider-access.ts`, `apps/api/src/middleware/{session,rbac}.ts`, `apps/api/src/features/sources/imap-host.ts`, `packages/core/src/net/address-policy.ts` |
| Secrets | `packages/db/src/schema/secrets.ts` |
| Overviews | `apps/api/src/features/{dashboard,stats,history,warnings}/*`, `apps/worker/src/overdue.ts` |
| Failures, reports, webhooks | `packages/core/src/failures/{types,catalog}.ts`, `packages/core/src/reports/catalog.ts`, `apps/worker/src/handlers/webhooks.ts` |
| Web | `apps/web/src/features/{endpoints,pve,restore,backup-jobs,installation}/`, `apps/web/src/features/registry.ts` |
| Compose, edge | `docker-compose.yml`, `deploy/release/docker-compose.yml`, `Caddyfile` |
| Smoke | `scripts/smoke/{run.mjs,checks/,images.json}` |
