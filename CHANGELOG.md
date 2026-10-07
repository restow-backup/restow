# Changelog

All notable changes to Restow are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Restow uses SemVer
from 1.0.0; before that, this file starts fresh at 0.1.0, the first public
release. Earlier internal iterations (0.300.0 to 0.304.0) built the features
this release describes but were never published and cannot be upgraded to this
release (see Breaking Changes); their history stays in the maintainer's
private repository.

## [0.3.0] - Unreleased

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.0 backs up Proxmox VE virtual machines and containers (preview), mounts
NFS shares from the web interface, lets Community run several administrators, and
sends notifications to Discord, Slack and Teams and through Microsoft 365 or Google
Workspace. The overview, the backup jobs and the archive now say plainly what is and
is not protected. Five database migrations run on update; read the Upgrade Notes.

### Breaking Changes

- Machines that are in no backup job no longer count as protected anywhere
  (overview, provider view, readiness, reports). Installations that relied on the
  old count will see more yellow; add the machines to a backup job.
- Overview › Statistics shows the active tenant only. The statistics of every tenant
  moved to their own page (Installation section of the menu, Service Provider); old
  links with `scope=provider` lead there.
- A provider member limited to some tenants can no longer read the statistics totals
  of all tenants (403).
- Integration API contract 1.3.0 (additive): webhooks carry `format`.

### Added

#### Proxmox VE (preview)

- Backup of VMs and containers on Proxmox VE 8.4 and newer through the Backup
  Provider API: VM disks over NBD with dirty bitmaps, only changed 4 MiB blocks are
  uploaded; containers through restic; restore as a new VMID into the pool
  `restow-restore`. Servers & endpoints › VMs & containers. See docs/PVE.md.
- The node side is a storage plugin shim (a separate work under AGPL-3.0-or-later)
  and the helper `restow-pve` (Apache-2.0), installed with `/install/pve.sh`.

#### Storage

- Network shares (NFS) from the web interface (Installation › Network shares), through
  the opt-in mounter container (`docker compose --profile mounts up -d mounter`). The
  mounter checks a share before it writes `docker-compose.override.yml`, restarts api
  and worker and rolls back on failure. The updater moves it along with every signed
  update. Installer option `--with-mounter`. See docs/MOUNTS.md.

#### Administration

- Several provider administrators with roles in every edition (Members); limiting a
  member to chosen tenants stays Service Provider. Owners can reset a member's access.
- Before a change of the public URL or the operating mode makes passkeys unusable,
  the settings name the affected accounts and refuse a self-lockout. Moving the
  authenticator app to a new phone keeps the old one until the new one is confirmed.
- Notification mail through Microsoft 365 (own app with Mail.Send, or the backup app)
  or Google Workspace (service account with gmail.send), with guides and plain error
  messages.

#### Alerts and overview

- Webhook formats Discord, Slack and Microsoft Teams, chosen from the URL.
- New event `backup.overdue` for mailboxes, OneDrives, IMAP accounts and machines,
  aware of the job schedules.
- Warnings: the reasons why single items were not backed up (folder, subject, date,
  cause, what to do), and acknowledging warnings with a note (/warnings).
- The bell leads to the cause; a Notifications page keeps the history; under All
  tenants the bell and the alerts cover every tenant.
- Exports: audit log (CSV, JSON with hashes, Business), delivery logs (CSV).

#### Archive

- Archive per mail job, journal reports assigned to the mailboxes they name (#36).
- The chain check verifies every link, the daily anchors (now written every night)
  and optionally a sample of message contents. Archived messages can be read and
  downloaded as .eml.

### Changed

- The directory, backup jobs and machines say which job backs up an object, and name
  objects in paused or unscheduled jobs; job states storage error, overdue, manual.
- History "Run now" backs up only the run's own object and words waiting and running
  apart. New machine jobs start from the chosen machines' operating systems.
- Deleting a job or a storage location says what becomes of the backups and asks for
  the name; shortening the retention asks first.
- The guide for an own Graph app lists every permission with a copy button and says
  that no redirect URI is needed.
- Disabled controls say why. Locked features name their edition and link only where
  the viewer may go. German texts follow one glossary (docs/GLOSSARY.md).

### Fixed

- `MAIL_TRANSPORT`, `SMTP_*` and `GRAPH_MAIL_*` from the environment were read but
  never used for sending; they apply again when nothing is saved in the web interface.
- The own-app guide named read-only permissions (Mail.Read, Files.Read.All), with which
  every restore fails.
- Discord answered 400 to webhooks in Restow's own format; chat services' 4xx answers
  now end a delivery at once instead of retrying.
- Webhook alerts were logged as sent when they were only queued.
- "Chain intact" checked only stored hashes, so deleting the newest entries passed.
- Overview › Statistics kept showing all tenants after switching into a tenant.

### Security

- A provider member limited to some tenants could read the statistics totals and the
  tenant table of all tenants (Service Provider with tenant-limited members, up to
  0.2.2). Fixed; nothing to do beyond updating.

### Upgrade Notes

New image; migrations run on start. Five migrations: `0026_webhook_format`,
`0027_job_archive`, `0028_pve`, `0029_warning_acknowledgements`,
`0030_mail_transport_google` (duration on the verification installation: to be
filled in).

- New optional environment variables: `RESTOW_MOUNTER_IMAGE` (the mounter pins it on
  its first start; leave empty) and `RESTOW_MOUNTER_URL` (default
  `http://mounter:8091`).
- `docker-compose.yml` gains the `mounter` service in the profile `mounts`; replace
  your compose file with the one of this release (the updater does this for you).
- Rollback: restore the database dump taken before the update and start the 0.2.2
  images; migrations are not reversible.

### Known Issues

- Proxmox VE was tested against real qemu-nbd, qemu-img and restic, but not yet on a
  Proxmox VE host; treat it as a preview.
- NFS mounts, Microsoft 365 and Google notification mail and the chat webhooks were
  tested against fakes only.
- Archive immutability on local and NFS storage is enforced by the application only.

### Verification

To be filled in by the release run.

## [0.2.2] - 2026-10-06

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.2.2 lets every Microsoft 365 source connect either through the consent
invitation or through a Graph app of its own, connects the tenant the backup app lives
in without a consent link, fixes the Hetzner Object Storage preset and the Object Lock
detection, and adds an alpha channel for test builds to the updater tab. Updating needs
no migration and no manual step; read the Upgrade Notes if you want to test alpha builds.

### Breaking Changes

None.

### Added

#### Microsoft 365

- **A Graph app of your own for a source (all editions).** Besides the consent
  invitation with the shared backup app, a source can be connected through an app the
  customer created by hand in their own tenant (tenant ID, application ID, client secret
  or certificate). A token for exactly that tenant is the proof; the credential is sealed in the
  organisation's secret store and never shown again, and entering new values replaces it.
  The worker, the group picker of the directory and the permission check use the source's
  own app. Sources with their own app have no consent link. The connection card names the
  organisation the source belongs to before anything is connected.
  See docs/ENTRA-SETUP.md ("Alternative: eine eigene App pro Quelle").
- **The tenant the backup app lives in connects without a consent link.** "Connect own
  tenant directly" on the source page (provider owners only) uses a working app token
  for the home tenant as proof, so the consent round trip, which failed with
  AADSTS700016 there, is skipped. It needs the directory (tenant) ID (a GUID) of the app
  under Settings, Microsoft 365.

#### Updates

- **Alpha channel for test builds.** Builds of the `alpha/*` branches
  (`.github/workflows/alpha.yml`) push unsigned images to
  `ghcr.io/restow-backup/restow-alpha` and announce themselves as pre-releases of the alpha
  repository. On Installation, Updates, "Use the alpha channel" selects that source in one
  click. The tab warns while the alpha source is selected and while the updater does not
  verify signatures (the updater now reports this as `signatureChecks`).

### Changed

- The Installation section of the menu is pinned to the bottom, set apart and labelled as
  applying to every organisation of the installation, so installation-wide settings are
  told apart from those of the active organisation.
- The Hetzner Object Storage preset has a location selector (Falkenstein, Nuremberg,
  Helsinki) that sets endpoint and region together.

### Fixed

- A source for the tenant of the backup app could not be connected: the page only knew the
  consent link, which Entra refuses for an app that is not installed in that tenant (AADSTS700016).
- A bucket with a dot in its name could not be reached with the Hetzner preset, because the
  provider's wildcard certificate does not cover the extra label; such buckets are now always
  addressed by path.
- A bucket created with Object Lock was shown as "not active": S3-compatible services such as
  Hetzner answer in another case or send only the default rule, which the detection did not
  accept.

### Security

- The dependency audit failed on new advisories in the test tooling (`tinypool` below
  2.1.2 and `source-map-js` below 1.2.2, both reached only through `vitest`). Neither is part
  of a shipped image; both are overridden to the patched versions.
- The images apply the Debian security updates of the base image when they are built. The
  release smoke refused the first 0.2.2 build because the base image still carried
  `perl-base` 5.36.0-7+deb12u3, which has three critical vulnerabilities fixed in
  5.36.0-7+deb12u4. No release image ever contained the unpatched package.
- Connecting the tenant of the backup app without consent is restricted to provider owners,
  to the home tenant set by the provider (a GUID), and to a source that is not connected yet, so
  no organisation can bind a foreign tenant this way.
- The credentials of a source's own Graph app are sealed with the organisation's key, are never
  returned by the API and are not written to the audit log.

### Upgrade Notes

Kind of update: new image, no manual steps. Follow [Updating](docs/UPDATING.md): in the
updater tab, or `docker compose pull && docker compose up -d`.

- Database migrations: none.
- New or changed environment variables: none. To test alpha builds, set
  `RESTOW_UPDATER_IMAGE_REPOSITORY`, `RESTOW_UPDATER_WEB_IMAGE_REPOSITORY` and
  `RESTOW_UPDATER_VERIFY_SIGNATURES=false` once on a test installation (docs/UPDATING.md,
  "Alpha builds"). Do not do this on an installation with production data.
- Expected downtime: the containers restart once.
- Rollback: the previous tag plus `docker compose up -d`; no migration ran, so no database
  restore is needed.

### Known Issues

- Connecting through a Graph app of your own and connecting the home tenant directly were
  tested with unit tests and the CI suites only, not against a real Microsoft 365 tenant. The
  Postgres-backed paths of the new routes have no tests of their own yet.
- The Hetzner preset and the Object Lock detection were not tested against a real Hetzner bucket.
- A source connected by consent cannot be switched to a Graph app of its own in the interface.
- The alpha channel needs a repository secret (`ALPHA_RELEASE_TOKEN`) and a first commit in the
  alpha repository before builds are announced to the updater.
- A tag signature is reported by the release workflow but not required for this release.

### Verification

Verified by the continuous integration of the release commit: lint, type check, build of all
packages and of the web bundle, unit and Postgres test suites, installer tests, dependency
audit and licenses, secret scan, workflow lint, the Go agent, and the build of the full and
Community images.

Run locally before the release: unit tests of core (1930 tests), api (2150), worker (248) and
web (the storage, sources, updates and layout suites, all passing).

Not run: any check against a real Microsoft 365 or Hetzner account. The release smoke checks
of the pipeline are added below by the release workflow.

## [0.2.1] - 2026-10-03

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.2.1 backs up a machine only once it is in a backup job and shows every
machine without one, lets you assign a machine to a person of the directory, adds
context menus to the tables, puts machines and mailboxes on one restore-point
timeline, makes the installation's default storage configurable in the web
interface and lets the opt-in updater start with one command and update itself.
Updating runs one additive migration; read the Upgrade Notes if you enabled the
updater on 0.2.0 or run agents older than 0.2.1.

### Breaking Changes

- **A machine in no backup job is not backed up.** A newly enrolled machine gets
  the schedule `none` and starts backing up once it is a member of a job. A machine
  that leaves its job (removed as a member, left out of a replaced scope, or its job
  deleted) goes back to `none` with a new configuration version, and a backup
  request that has not started yet is dropped. Machines that are in no job at the
  time of the update keep running their own configuration; only newly enrolled
  machines and machines leaving a job wait. To keep a machine backed up, put it
  into a job (Servers & endpoints > Jobs, or "Create a job" / "Add to job..." in
  the machine table).
- **API: backups of a machine need a job.** `POST /api/v1/endpoints/:id/tasks`
  with `backup_now`, and `PATCH /api/v1/endpoints/:id` with a schedule other than
  `none`, answer 409 `urn:restow:problem:endpoint-no-job` for a machine in no job.
  The machine list marks such a machine with the attention reason `no_job`.
  Scripts that trigger machine backups must add the machine to a job first.

### Added

#### Machines and backup jobs

- **Machines without backup are visible** (all editions, Servers & endpoints >
  Machines). The inventory has a "Backup job" column with the job as a link or a
  "Without backup" warning badge, a filter "Without backup / In a job", and a
  banner counting the machines without backup. Job administrators get "Create a
  job" (the job editor with the machine preselected) and "Add to job..." (moves the
  machine after a confirmation when it is in another job) on each row and on the
  machine page. "Back up now" is disabled for a machine in no job, and the enroll
  dialog says that a new machine is backed up only in a job.
- **The 0.2.1 agent waits for a job.** Under the schedule `none` it starts no
  scheduled backup, ignores a backup request, and `restow-agent status` says it is
  waiting for a backup job.
- **Assign a machine to a person** (all editions). A machine can be assigned to a
  person of the tenant's protection directory (a user of the directory, not a login
  account): an "Assigned to" column in the machine table (sortable, filterable by
  person and by nobody, found by the search), an "Assign to..." dialog that
  searches the directory and removes an assignment, and the same on the machine's
  overview and General settings. The assignment is audited as `endpoint.assigned`
  and cleared when the person leaves the directory. API: `PATCH
  /api/v1/endpoints/:id` takes `assignedUserId` (422
  `endpoint-assignee-unknown` for anyone not in the tenant's directory), list and
  detail carry `assignedTo`, and `GET /api/v1/directory/people?search=` feeds the
  picker.
- **"Run now" on a machine job shows what happens.** The agent starts a requested
  backup at its next check-in (about every 5 minutes); until then the job and its
  members show "Queued" with the expected check-in, and the toasts say that the
  backup was requested or is already waiting.

#### Tables and restore

- **Context menus on table rows** (all editions). Right click, the context menu
  key, Shift+F10 or a long press on a touch screen open the row's actions in the
  machine, jobs, job members, protected objects (mailboxes) and the other tables
  with row actions; the "..." menu offers the same entries. Links, fields, selected
  text and Shift with a right click keep the browser's menu. Selectable tables get
  checkboxes, a selection bar and "New job from selection" on the context menu of a
  selected row. The jobs table gains Open and Open history; protected objects offer
  their restore points, a restore in the explorer, a new job with the object and
  the protection decisions.
- **File restore with machines and mailboxes on one timeline** (all editions).
  File restore lists the tenant's machines and mailboxes in one searchable list.
  Restore points are shown newest first, grouped by day under sticky separators
  (Today, Yesterday, weekday and date), with a jump to a date that lands on that
  day or the nearest earlier one; the Snapshots tab of a machine uses the same
  timeline. A mailbox's chosen restore point opens in the restore explorer. The
  machine table links to file restore for a machine.

#### Installation

- **Configurable installation default storage** (Installation > Default storage).
  The installation owner can save a local path or an S3-compatible bucket as the
  default storage in the web interface, with a recent sign-in. It is stored sealed
  with the master key and, once saved, wins over the `STORAGE_*` / `S3_*`
  environment; removing it brings the environment back. The page shows where the
  default comes from and the probe the server ran before saving. A change that moves
  the location is refused (409, tenants named) while any tenant keeps data on the
  current default, has it attached as a retired target, is migrating off it or has a
  storage job queued or running. A tenant's storage page always shows the
  installation default as a choice, with "Use installation default" while the
  tenant's own primary holds no data. API: `PUT` and `DELETE
  /api/v1/settings/default-storage`, audited.
- **The opt-in updater starts with one command.** `docker compose --profile updater
  up -d` is enough: `RESTOW_PROJECT_DIR` and `RESTOW_UPDATER_IMAGE` are optional.
  The project directory is mounted at `/project`, and on its first start the
  updater pins its own image by digest into `RESTOW_UPDATER_IMAGE`, so later
  rewrites of `RESTOW_IMAGE` do not reach it. The install script no longer writes
  `RESTOW_UPDATER_IMAGE`. See docs/UPDATING.md.
- **The updater updates itself.** After an image-mode update whose images passed
  the signature check, the updater pins `RESTOW_UPDATER_IMAGE` to the verified
  application image by digest and recreates itself through a short-lived helper
  container. Never after a source-mode update or with the signature check off;
  `RESTOW_UPDATER_SELF_UPDATE=false` switches it off. A failed self-update leaves
  the application update successful, and the Updates tab shows the command that
  finishes it.
- **Switch a Community installation to the full build** (Community build,
  Installation > Edition). The section names the build, lists what Business and
  Service Provider add and offers a one-way switch to the full build of the same
  version: with the updater (owner role, recent sign-in, audited as
  `update.build_switch.scheduled`; the full images are verified against the
  release signature of the tag, with database dump, health check and rollback), or
  by hand with the two `.env` lines it shows. A license key can be stored on the
  Community build; it is kept sealed until the full build verifies and installs it,
  and a rejected key is dropped and audited. There is no switch back to Community.
- **"Hide Start"** in the popover of the sidebar's setup guide removes the Start
  entry in every tenant for that user (remembered in the browser, with an undo
  toast); the setup steps stay on each tenant's page under "Show setup steps".

#### Public demo

- **Simulated live runs.** The demo's agent sidecar plays backups of the two
  simulated machines through the real agent API with live progress, about one in
  ten finishing partial. Configurable with `RESTOW_DEMO_SIM_RUNS`,
  `RESTOW_DEMO_SIM_INTERVAL_SECONDS`, `RESTOW_DEMO_SIM_MIN_DURATION_SECONDS`,
  `RESTOW_DEMO_SIM_MAX_DURATION_SECONDS` and `RESTOW_DEMO_SIM_PROGRESS_SECONDS`
  (deploy/demo/README.md, "Simulated live runs"). The seed puts the demo machines
  into a daily machine job, since a machine in no job is not backed up.

### Changed

- **Linux servers back up application data by default.** The server profile's
  default paths add `/opt`, `/usr/local`, `/var/lib` and `/var/backups` to `/etc`,
  `/home`, `/root`, `/srv` and `/var/www`, and exclude `/var/lib/docker`,
  `/var/lib/containerd` and `/var/lib/apt/lists`. These are the defaults a newly
  enrolled server starts with; the client profile is unchanged. Databases under
  `/var/lib` are backed up as files: for a consistent copy, add a dump command as a
  hook before the backup.
- **IMAP sources lead to the mailbox passwords.** In "one password per mailbox"
  mode, editing a source offers "Manage mailboxes and passwords" (the directory
  filtered to that source), and a new source says where the passwords go after
  saving. Entering `outlook.office365.com` or another Microsoft IMAP host shows that
  Microsoft has disabled password sign-in there and points to the Microsoft 365
  connection.
- **Adding mailboxes** shows the source's login mode with a link to change it, a
  password (and optional username) field per mailbox on a source with one password
  per mailbox, and afterwards a list of each mailbox as new or already listed and
  whether a password is set. Pasted CSV keeps working.
- **Removing a mailbox that has backups** explains that backups are never deleted
  as a side effect, stay restorable and expire with retention, and offers "Exclude
  from protection"; under a legal hold it says so, also when a delete is refused.
- **Machine settings use the full width** in two columns from the xl breakpoint,
  with a sticky column of jump links from the lg breakpoint.
- **File restore without the machine dropdown:** the machines are a searchable list
  beside their restore points; with a single machine it is chosen right away.
- **SMB/CIFS is no longer named as a supported storage mount.** Network storage for
  local targets is NFS only in the interface, the API description and the docs.
  Existing mounted paths keep working.
- **The Updates tab explains the updater:** choosing an update source does not
  start it, the one command that does, that the updater is the application image,
  and the self-update state.
- **A switch from Community to the full build is worded as a switch** ("switch to
  the full build (0.2.1)") in the run card, maintenance banner, modal and toasts,
  not as an update.
- **Dependencies** (Dependabot #14, patch and minor): hono 4.13.11, mailparser
  3.9.31 (linear quoted-printable decoding), nodemailer 10.0.12, smtp-server
  3.19.15, react-resizable-panels 4.14.1, recharts 3.10.1 and @aws-sdk/client-s3
  3.1143.0. No configuration, API or database change; THIRD_PARTY_NOTICES.md is
  regenerated.

### Fixed

- **A new Linux server backed up almost nothing** (about 2 MB): the default paths
  left out `/opt`, `/usr/local` and `/var/lib`, where servers and LXC containers
  keep their application data (see Changed).
- **"Run now" on a machine job looked as if nothing happened.** The request stayed
  invisible until the agent's next check-in and the toast said nothing started; the
  open request is now read and shown as queued.
- **The IMAP password column was a dead end** in "one password per mailbox" mode; it
  now leads to where the passwords are set.
- **Long webhook URLs pushed the delete dialog wider than the screen** (a Discord
  webhook URL is one unbreakable word); the description wraps now.
- **A long press on a touch screen opened an empty row menu**, because no context
  menu event fires there; the entries are read when the menu opens.
- **Listing the tenants that keep data on the default storage scanned every pack**;
  it uses an indexed probe per tenant now.

### Security

No Restow advisory or CVE is fixed in this release. Two points concern the parser
update and the updater's trust model.

- **mailparser 3.9.31 fixes quadratic quoted-printable decoding** (a crafted
  message made decoding slow). Restow up to 0.2.0 already contained it by parsing
  mail in isolated processes with time limits, so it could not stall the service;
  the update is defence in depth and needs no action.
- **The updater now changes its own image.** After a successful image-mode update,
  the release signature, verified by cosign against the release workflow identity
  of the tag and Sigstore, is what lets the updater (which holds the Docker socket)
  replace itself with the new application image, pinned by digest. Before, the
  updater's image changed only by hand. Set `RESTOW_UPDATER_SELF_UPDATE=false` to
  keep it that way.
- **`pnpm audit --prod`:** no high or critical findings; 4 moderate ones in
  transitive dependencies that are not reachable at runtime: esbuild 0.18 (through
  drizzle-kit, its development server only), vitest and @vitest/mocker 3.2 (a peer
  of better-auth, not loaded in production) and uuid 8.3 (through @azure/msal-node
  v3, v5 and v6; the affected buffer API is not used).

### Upgrade Notes

Kind of update: new images, plus manual steps if you enabled the updater on
0.2.0. Order: back up (docs/UPDATING.md), replace `docker-compose.yml` if you use
the updater, pull the 0.2.1 images, start. Migrations run automatically at start.

- **Database: one additive migration, `0025_endpoint_assigned_user`.** It adds the
  nullable column `endpoints.assigned_user_id` with an index, a unique index over
  `users (tenant_id, id)` and a composite foreign key so that a machine's person
  always belongs to the machine's tenant. Nothing is deleted. Its duration was not
  measured on an installation with real metadata.
- **Machines without a job.** Machines that are in no job at the update keep
  running their own configuration. Newly enrolled machines and machines that leave
  a job wait for a job (see Breaking Changes).
- **Agents older than 0.2.1** do not know the schedule `none`. Until they update
  themselves (every 6 hours, or when a machine is next online), a machine with the
  schedule `none` gets no paths and no hooks from the server and reports one failed
  `no_paths` run per slot of its profile's default schedule, with a `backup.failed`
  alert each time; nothing is read or written. The agent's self-update ends it. If
  you paused agent updates (Tenant page > Agents), resume them or put the machine
  into a job.
- **If you enabled the updater on 0.2.0:** before or with the update, replace
  `/opt/restow/docker-compose.yml` with the one of the 0.2.1 release assets (the
  `updater` service now falls back to `RESTOW_IMAGE` when `RESTOW_UPDATER_IMAGE` is
  empty and mounts the project directory at `/project`). Install 0.2.1 from
  Installation > Updates, then delete the `RESTOW_UPDATER_IMAGE` line from `.env`
  (or set it to the 0.2.1 application image) and run
  `docker compose --profile updater up -d updater` once. From then on the updater
  follows signed updates itself.
- **Environment variables:** new `RESTOW_UPDATER_SELF_UPDATE` (optional, default
  `true`: the updater moves itself to a verified release after an image-mode
  update); new `RESTOW_DEMO_SIM_*` (public demo only). `RESTOW_UPDATER_IMAGE` and
  `RESTOW_PROJECT_DIR` become optional.
- **Default storage:** once a default storage is saved under Installation > Default
  storage, it overrides `STORAGE_*` / `S3_*` from the environment; removing it there
  brings the environment back. Nothing changes until you save one.
- **Downtime:** the containers restart and the migration runs at start.
- **Rollback:** the previous tag (the 0.2.0 images) plus `docker compose up -d`, and
  restore the database dump taken before the update, because a migration ran and
  migrations are not reversible.

### Known Issues

- **No migration back to the installation default:** a tenant whose own primary
  storage already holds data cannot move back to the installation default.
- **Staged uploads and exports are not counted as data on the default storage**
  when the server decides whether the default may move.
- **A default-storage change made by another API process is picked up within 30
  seconds**, not at once.
- **The switch to the full build and the updater's self-update were not exercised
  end to end with a real Docker daemon**; they are covered by unit and PostgreSQL
  tests only.
- **The integration API does not expose `assignedTo` yet.**
- **Demo only:** simulated runs report made-up sizes while reusing a snapshot of
  about 1 MB.
- **Not part of this release:** the Windows agent and Proxmox.
- Microsoft 365 backup and restore have still never run against a real Microsoft 365
  tenant; they are covered by tests against a simulated Graph API.

### Verification

Local runs on 2026-10-03 in a Linux container, on the release candidate before
the version commit; the release pipeline repeats CI and runs the smoke on the
tag. No Microsoft 365 development tenant was used.

- **Lint and typecheck** over every workspace passed.
- **Unit suites** passed: packages/core 1919, apps/api 2161, apps/worker 248, ee
  174, apps/web 3461, packages/i18n 244, demo seed 204, packages/db 143 (including
  its PostgreSQL tests).
- **PostgreSQL suites** against a local PostgreSQL 16 with restic 0.19.1 passed:
  apps/api 762 (including the endpoint suites), apps/worker 96, ee 66.
- **Endpoint agent:** `go vet` and `go test` passed.
- **Installer:** `deploy/install/test.sh`, 601 checks passed.
- **Not run here, and so not claimed:** the Docker image build, the release smoke
  (`scripts/smoke`), the updater end-to-end test, and runs against real Microsoft
  365, IMAP or S3 services. They run in CI and the release pipeline; this section
  is completed with the smoke reports of the pipeline run.

## [0.2.0] - 2026-10-03

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.2.0 reorganises the web interface around three levels (the installation,
a tenant, all tenants), adds backup jobs that replace per-object schedules, and
shows running backups live with throughput charts and a History page. Updating
from 0.1.0 runs three additive database migrations and, on the first start, moves
your backup and restore-check schedules and your machines into jobs without
deleting anything; plan a few minutes for it and read the Upgrade Notes first. The
install script now covers installations behind a reverse proxy with an encrypted
hop, which needs the new `docker-compose.yml` of this release.

### Breaking Changes

Three things behave differently for scripts and integrations that talk to the
API. Nothing changes for the data in your repositories or for the agent API
that installed agents use.

- **`POST /api/v1/setup` requires `providerName`.** The setup wizard asks for the
  name of your own organisation, and the call that sets up an installation now
  needs it. A script that sets up an installation without a browser has to add
  the field; without it the call is refused with 422.
- **Backup and restore-check schedules are created through jobs.**
  `POST /api/v1/schedules` with kind `backup` or `verify` answers 422
  (`kind_replaced_by_jobs`). Maintenance schedules (retention run, storage check,
  directory sync, archive sync) are unchanged. Create a backup job instead
  (`POST /api/v1/backup-jobs`, or Mail & SaaS > Jobs in the web interface).
  Schedules that existed before the update keep their rows and are shown with
  `supersededByJobId`.
- **A machine that belongs to a job is configured from the job.**
  `PATCH /api/v1/endpoints/:id` answers 409 `endpoint-config-managed-by-job` when
  it would change folders, exclusions, hooks, bandwidth or the schedule. Change
  them on the job, or take the machine out of the job first. Display name, the
  power switch and the storage budget stay editable on the machine.

Web addresses did not break: every old address (`/settings`, `/sources`,
`/schedules`, `/backup`, `/jobs/<run id>`, `/audit` and more) redirects to its new
place and keeps its query, so bookmarks and links in mails keep working.
`/api/v1/jobs` keeps its meaning and its shape; `/api/v1/runs` is the new,
documented name for the same list.

### Added

#### Backup jobs

- **Jobs.** A job is the definition of what is backed up, when, where and for how
  long, over many mailboxes, OneDrives, IMAP accounts or machines at once.
  - **Mail jobs** (Mail & SaaS > Jobs) have a backup schedule, an optional
    restore-check schedule, a retention policy (or the tenant default) and a
    scope: the objects you pick, or "every object that is in no other job", which
    also catches objects added later (one such job per tenant). An object belongs
    to at most one job.
  - **Machine jobs** (Servers & endpoints > Jobs) cover servers and clients with an
    agent: a schedule (every N hours, daily at a time, or when the machine
    connects), folders, exclusions, a bandwidth limit, optional hooks and how many
    daily, weekly and monthly restore points to keep.
  - **Per-member overrides.** One mailbox can run on its own schedule, one machine
    can have other folders, exclusions, bandwidth, hooks or retention. An override
    replaces the job's value for that member.
- **The job pages and the editor.** `/jobs?type=mail` and `/jobs?type=endpoint`
  list the jobs with scope, schedule, repository, last and next run, status and
  the result of the last restore check (green only for a passed restore check). A
  job opens in tabs (Overview, Scope, Settings, Runs). The editor is a side sheet
  that works with the keyboard; for machine jobs it shows the folders as a tree
  read from the latest backup, offers exclusions as chips (videos, disk images,
  temporary files, installers, music, trash and caches, your own patterns, "skip
  files larger than X GB") and takes a bandwidth limit and hooks.
- **Run now**, per job or for selected members.
- **A default mail job for new tenants.** The first active source of a tenant
  creates one mail job over all objects (backup every 8 hours, restore check every
  Sunday at 03:00).
- **Bandwidth time windows.** A machine job keeps its upload limit in kbit/s as the
  default and can add windows that set another limit for certain days and hours
  (for example Monday to Friday 08:00 to 18:00: 1000 kbit/s; 0 means unlimited). A
  window may cross midnight, windows must not overlap (the editor and the API name
  the later one), the times are read in the time zone of the job's schedule, and
  the limit that applies when a run starts is used for the whole run. Up to 24
  windows per job; per machine they are overridden together with the limit. No
  agent update is needed: the server picks the limit when the agent asks for its
  configuration.
- **The size limit works.** Agent 0.2.0 passes "skip files larger than X GB" to
  restic (`--exclude-larger-than`); the run log says so.

#### Live runs, History and the run drawer

- **Live runs.** One event stream per browser tab (`GET /api/v1/live`) carries
  running backups with their progress, the jobs' state with last and next run and
  the machines' connection; pages stop polling while it is open. The top bar says
  "Live, updated 4 s ago", "Connecting" or "Not connected, retrying", and the pages
  fall back to polling when the stream is lost.
- **Throughput and sparklines.** Running backups record what was read and what was
  written to the repository (up to 300 points per run) and show progress, speed, a
  sparkline and the time left in the job list and in History.
- **The run drawer.** A click on a job row or a History row opens the run in a
  panel from the right: state, progress, summary, two charts on one time axis (one
  crosshair, keyboard operable), the objects of the same backup run, the timeline
  and the actions (cancel, retry, edit the job). The address carries `?run=<id>`.
  The transfer chart shows an average over 15 seconds, because data reaches the
  repository in packs.
- **History** (`/history`) lists every run of the tenant, the server's and the
  agents', in tabs (all, backup, restore, restore check, export, import,
  maintenance) with a filter per job and paging. A retried restore check is one row
  ("attempt 3 of 6").
- **Progress every 5 seconds (agent 0.2.0)** instead of every 10, so the charts get
  twice the resolution.

#### Interface structure, tenants and branding

- **Three levels.** The menu is organised as Daily, Mail & SaaS, Servers &
  endpoints, Tenants and Installation. The tenant switcher moved to the top of the
  sidebar, with a gear for the active tenant's settings; the page header names the
  level ("Installation", "Own organisation", "Tenant: ...", "All tenants").
- **The installation page** (`/installation/<section>`): Server, Notification mail,
  Microsoft multi-tenant app, Journal receiving (Business), Default storage (with a
  test that belongs to no tenant), Provider API (Service Provider), Updates,
  License and About. Sections your edition does not include stay visible with a
  lock. Provider roles that may look but not change see the forms closed with a
  sentence.
- **The tenant page** (`/tenants/<tenant>/<section>`): Overview, Connections,
  Protection, Jobs & schedules, Backup retention, Storage, Agents, Archive,
  Notifications, Integrations, Members, Audit log and Master data. A tenant's own
  administrator sees their tenant's page and no other. "Connect Proxmox" is
  announced on the Inventory page as "Soon" and starts nothing.
- **Your own organisation.** Every installation can mark one tenant as the
  operator's own (`kind` internal), listed first, protected from deletion and not
  counted as a customer in provider figures. The setup wizard asks for its name and
  creates it with its own key and two alert rules.
- **"All tenants" scope** for provider administrators: the overview sums the
  recovery readiness over every tenant and lists "Tenants by need for action"; pages
  that exist only per tenant ask you to choose one. The entry that lists tenants is
  now "Manage tenants".
- **"Start" in the menu** replaces the setup card: it shows how many of the seven
  steps are done and opens a popover with the steps. The notification mail is the
  one optional step; an installation that skipped it sees "Start" disappear once
  the other six are done.
- **Recovery readiness is linked.** Every row of the readiness tile opens
  `/verify?state=<state>`, with chips and counts for the five states.
- **Brand colours and a second colour scheme.** The interface uses the Restow brand
  colours (Limestone, Nile, Lapis); "Neutral" is the black-and-white look of 0.1.0,
  chosen per browser in the user menu, in the command palette and on the sign-in and
  setup pages. Inter Tight and IBM Plex Mono are bundled into the web image as
  `woff2` files (about 320 KB) and served from `/assets`; nothing is fetched from
  outside and the Content-Security-Policy is unchanged.
- **Wide tables scroll inside their own frame** with the first column pinned
  (two for the audit log), reachable with the keyboard; data views use the full
  width of the content area.

#### Installation and setup

- **The install script explains itself and asks how Restow is reached**: public
  with its own certificate, behind a reverse proxy you run, or local evaluation.
  Every existing option still works; `--non-interactive` asks nothing.
- **Behind a reverse proxy: `--behind-proxy`** (`--domain`, `--proxy-ip`). Restow
  then needs no public DNS record, no certificate of its own and no inbound port
  from the internet. The hop to the proxy is encrypted by default (new setting
  `RESTOW_EDGE_TLS=internal`; the edge shows a certificate from Caddy's own
  authority and the script copies its root certificate to
  `/opt/restow/edge-root-ca.crt`). `--proxy-hop http` selects the unencrypted hop,
  only for a proxy on the same host or in an isolated network; the script says so.
  `RESTOW_HTTP_PORT` and `RESTOW_HTTPS_PORT` now accept an address such as
  `192.168.1.50:443`.
- **The end of the installation shows the address and the setup token**, and where
  a proxy must forward to. The token goes to the terminal only, never to
  `/var/log/restow-install.log`.
- **The setup wizard starts with the language** (English or Deutsch, also the
  language of your own organisation) and has seven steps. The notification mail can
  be skipped ("Skip for now"); `POST /api/v1/setup` accepts `language` and an absent
  `mail`.

#### Tenants and notifications

- **Agent updates are paused once per tenant** (Tenant page > Agents), which also
  covers machines enrolled later. A machine with a pause of its own (the old way)
  stays paused and is listed as an override with "Resume this machine" and "Resume
  all".
- **Tenant administrators may read their tenant and edit its notification
  recipients** (`GET /api/v1/tenants/:id`, `PUT
  /api/v1/tenants/:id/notification-recipients`), and have an Audit log section on
  their tenant page.
- **`GET /api/v1/history`, `GET /api/v1/history/:id`, `GET /api/v1/live`,
  `/api/v1/backup-jobs`** (session API of the web app), `kind` and `customerNumber`
  on tenants (`GET /api/v1/me`, `GET /api/v1/tenants`, `GET
  /api/v1/provider/tenants`), `widgets` and `provider` parameters on `GET
  /api/v1/dashboard`, and `PUT /api/v1/settings/mail/not-needed`. The integration
  API is contract 1.2.0 (additive): the runs are also available as `/runs`,
  `/runs/{id}`, `/runs/backup` and `/runs/{id}/events`.
- New audit actions: `backup_job.created`, `.updated`, `.deleted`, `.scope.changed`,
  `.run_requested`, `.migrated` (written by the system), `tenant.internal.marked`,
  `tenant.internal.unmarked`, `settings.mail.not_needed`,
  `setup.internal_tenant_failed`.

### Changed

- **Schedules now hold only maintenance** and the schedules of an older release
  that no job could take over. A restore check after every backup follows the job;
  retention follows the job that names a policy (a policy scoped to one object still
  wins), and a retention policy that a job names cannot be deleted (409).
- **Saving the notification recipients now changes who is mailed.** Each category
  (failed jobs, readiness turning red, weekly report) is carried by one rule of the
  tenant, kept up to date from the next alert on. Before, the recipients were used
  once to create rules and later edits changed nothing. The recipients field of such
  a rule is read-only in the alert editor.
- **The default storage counts as tested once the installation tested it**, whether
  the tenant or the installation ran the test; a newer failed test shows the step
  as failing.
- **Provider figures no longer count your own organisation as a customer.** Its
  objects, failures, mailboxes and storage are still part of the sums; the license
  audit entries count customers only.
- **Texts follow the level.** Community and Business pages say "your organisation",
  never "tenant".
- **Error text and destructive buttons are easier to read in light mode** (red text
  contrast now at least 4.5:1, amber of the "Soon" badge a hair darker).
- **Green means proof only.** A backup that merely completed is Lapis in the PDF
  statistics report, as in the web charts.
- **Small headings and badges are in sentence case**, the wordmark reads "restow
  backup suite" (your own `RESTOW_PRODUCT_NAME` is shown as written), and PDF
  reports follow the brand palette with the standard PDF fonts.
- **Capacity planning** (Installation, formerly "Resources") announces 0.5.0.
- **Where things moved.** Settings > General, Mail, Microsoft 365, Updates, About,
  Danger zone and Integrations > Provider keys are sections of Installation; Sources,
  Imports, Protected objects, Schedules, Retention, Repositories, Alert rules,
  Integrations, Members and the tenant detail page are sections of the tenant page;
  `/backup` leads to `/jobs?type=mail`.
- **`docker-compose.yml` of the release passes `RESTOW_EDGE_TLS` to the edge** and
  documents that the two published host ports accept an address;
  `RESTOW_EDGE_TLS` is empty in `env.example`.
- **Dependabot groups its updates** and no longer runs CI twice for its branches;
  Hono 4.13.10, better-auth and its passkey plugin 1.7.6, TanStack Router 1.170.40
  and Query 5.104.0 and react-hook-form 7.89.0 were updated (patch and minor, no
  configuration, API or database change). The build stage `agent-dist` starts from
  Alpine 3.24; Alpine is not part of the shipped image.
- **`scripts/release/sign-agent.sh` runs from any directory** and the release
  workflow explains why a tag signature is not verified (and refuses it when the
  repository variable `REQUIRE_SIGNED_TAGS` is `true`). Release tooling; operators
  are not affected.

### Fixed

- **Saving a migrated job reset its timer.** The schedule before and after an edit
  was compared by how its JSON was ordered and spelled, not by its meaning; it is
  compared by meaning now, so saving a job without changing its schedule keeps the
  next run.
- **Editing notification recipients later changed nothing.** Recipients were only
  used when the tenant was created; saving them now updates the rules (see
  Changed).
- **A tenant that tested the default storage kept the setup reason "the server's
  default storage has not been tested".** The test was recorded for the installation
  and the tenant only read its own; the newest test counts now.
- **A tenant administrator who opened another tenant's address saw "All tenants" in
  the header.** The header named the wrong level; it names the administrator's own
  level and the page belongs to Tenant settings in the menu.
- **Tenant page > Storage showed two "Repositories" headings.** The list is a
  region of that name with its explanation.
- **The mail preview tests failed on slow CI runners** (they gave the plain-text
  fallback half of a short time limit, which a loaded runner spent starting the
  parser process; this failed the v0.1.0 release CI three times). Each phase has
  its own limit now. The product's behaviour and its default limits are unchanged.

### Security

No advisory or CVE affects 0.1.0 and is fixed here. Two points concern the update
of the sign-in library and the new proxy mode.

- **Over-long passwords are refused before they are processed.** better-auth 1.7.6
  rejects a password longer than its configured maximum on sign-in and on the other
  password endpoints before it is hashed or compared. Restow accepted passwords of
  up to 256 characters before and now sets the maximum to 256 explicitly:
  **operators whose password is between 129 and 256 characters long are
  unaffected**. The limits are at least 12 and at most 256 characters, as before.
- **The hop between a reverse proxy and Restow is encrypted by default** with
  `--behind-proxy`. The plain HTTP hop (`--proxy-hop http`) sends session cookies
  and passwords unencrypted between the proxy and Restow, and port 80 is open to the
  network; use it only on the same host or in an isolated network. Docker publishes
  ports past `ufw`: behind a proxy, publish the edge's port on one address
  (`RESTOW_HTTPS_PORT=192.168.1.50:443`) or add a rule to Docker's `DOCKER-USER`
  chain.
- Typefaces are served by your installation; nothing is requested from Google Fonts
  or any other host.

### Upgrade Notes

Order: back up (docs/UPDATING.md), replace the compose file if you want the
encrypted proxy hop, pull the 0.2.0 images, start. Migrations run automatically at
start.

- **Database: five additive migrations, `0020_tenant_kind`,
  `0021_tenant_page_settings`, `0022_setup_mail_not_needed`, `0023_backup_jobs` and
  `0024_run_samples`.** They add
  columns and tables (with Row Level Security) and delete nothing; each is safe to
  run twice and needs no downtime. 0020 adds `tenants.kind`, 0021
  `tenants.agent_updates_paused` and `report_rules.recipient_category`, 0022
  `settings.mail_not_needed`, 0023 the tables `backup_jobs` and
  `backup_job_members`, `schedules.superseded_by_job_id` and
  `tenants.backup_jobs_migrated_at`, and 0024 the table `run_samples` and two byte
  columns on `job_progress`. Existing runs have no samples; their charts say "No
  measurements were kept".
- **Your schedules and machines become jobs when the API starts, once per tenant.**
  The step runs in the API process before it serves requests, one transaction per
  tenant. Nothing is deleted, and a second start finds nothing to do.
  - *Mail.* A tenant's enabled backup and verify schedules become one mail job
    ("Mail backup" or "Mail-Sicherung" after the tenant's language). A tenant-wide
    schedule becomes the job's schedule and the job covers every object, so mailboxes
    added later are backed up. A schedule of one object becomes that object's
    override only when it protects the object at least as well as the job's schedule
    at every time of day and week; otherwise it stays exactly as it was and keeps
    running next to the job, so no object is ever backed up less often than before
    (nights, weekends, monthly schedules and the further schedules of an object stay
    as they were). The next run times are carried over, so nothing runs early or is
    skipped.
  - *A tenant that already has a mail job* (the step failed at an earlier start and an
    administrator created a job by hand) keeps all its schedules; they run next to
    that job. The tenant's audit entry lists them (reason `mail_job_exists`); switch
    them off under Tenant settings > Jobs & schedules once the job covers the same
    objects.
  - *Replaced schedules stay on record* with `superseded_by_job_id`; the scheduler no
    longer plans them and the API refuses to change them.
  - *Machines.* Active machines with the same profile, operating system and schedule
    become one job (for example "Linux servers · daily 02:00"); what most machines of
    a group share is the job's, a machine that differs gets an override with just the
    differences. Revoked machines are left out. The step checks that the job
    reproduces every machine's configuration exactly: nothing is rewritten and no
    machine gets a new configuration version.
  - *Audit.* Every tenant gets a `backup_job.migrated` entry written by the system
    with the numbers; the API log carries the totals at start.
  - *Failure.* If the step fails for a tenant, the API still starts, nothing of that
    tenant is changed, its old schedules keep running and the step is tried again at
    the next start. The API log names the tenant ("a tenant could not be moved to
    backup jobs and keeps its schedules"). Do not create a mail job by hand for such
    a tenant, or its old schedules and the new job both run.
- **Machines in a job are configured from the job.** Tenants created after the update
  do not get their machines grouped automatically: put a new machine into a job, or
  leave it with the configuration it enrolled with.
- **Encrypted proxy hop: replace `docker-compose.yml`.** The 0.1.0 compose file does
  not pass `RESTOW_EDGE_TLS` to the edge, and changing the image lines in `.env` does
  not replace it. To switch an installation behind a reverse proxy from the plain
  HTTP hop to the encrypted one: replace `/opt/restow/docker-compose.yml` with the one
  of the 0.2.0 release assets, set `RESTOW_APP_DOMAIN=<name>` (without `http://`),
  `RESTOW_EDGE_TLS=internal` and `RESTOW_HTTP_PORT=127.0.0.1:` in `.env`, run
  `docker compose up -d`, and set the proxy to scheme `https`, port `443`. In Nginx
  Proxy Manager add under Advanced `proxy_ssl_server_name on;`,
  `proxy_ssl_name $host;` and `proxy_buffering off;`. Without these steps an
  installation made with 0.1.0 keeps working unchanged: the edge behaves as before
  while `RESTOW_EDGE_TLS` is unset or `acme`, and the script never changes an
  existing `.env`. `--behind-proxy` itself needs release 0.2.0 or newer;
  `--proxy-hop http` works with any release.
- **Reverse proxies must not buffer `text/event-stream` for `/api/v1/live`.** The
  stream answers with `cache-control: no-cache` and `x-accel-buffering: no`, which
  nginx honours; switch response buffering off for that path on other proxies. If the
  stream cannot be held open, the indicator says so and the pages poll. One stream is
  held per open tab, and only while the tab is in front. A proxy must also pass
  `/assets/*` through unchanged, as it already does.
- **Agents update themselves.** An agent asks the server every 6 hours for a newer,
  signed agent (the 0.2.0 agent ships in the 0.2.0 image), checks the signature
  against the key compiled into it, replaces itself and its restic where the release
  pins another one and restarts its service. Machines that are off update when they
  are next online. The size limit and the 5 second progress need agent 0.2.0. If you
  paused automatic updates (Tenant page > Agents) or paused one machine, that machine
  keeps its old agent until you resume or install it again with the install command.
- **Service Provider installations: mark your own organisation once.** Sign in as an
  owner or administrator of the provider team; the overview asks you to choose the
  tenant that holds your own data or to create a new one. Until then everything works
  as before. A Community or Business installation with exactly one tenant marks it at
  the first start (audit entry, actor "system"); an installation with several tenants
  and no Service Provider key is asked the same question.
- **Automation:** every `POST /api/v1/setup` call needs `providerName`; the tenant
  lists are ordered own organisation first, then by name; scripts that created
  backup or verify schedules must create jobs. A script that runs the installer
  behind a proxy passes `--behind-proxy --domain <name> --proxy-ip <address>
  --non-interactive`; the setup token is not printed in a run without a terminal,
  read it from the API's log.
- **Rolling back to 0.1.x.** Migrations stay applied; 0.1.x ignores the new columns
  and tables and backups keep running, with these effects:
  - 0.1.x does not know `superseded_by_job_id` and plans every backup and verify
    schedule again, the replaced ones included. Their next run times stayed where
    they were at the upgrade, so right after the rollback every replaced schedule is
    overdue and runs once (a backup and a restore check of every covered object at
    once), then on its old cadence.
  - 0.1.x does not know jobs. A tenant whose first source was connected after the
    update has only its default mail job and no backup or verify schedule: nothing
    backs it up on 0.1.x until you choose "Apply recommended schedules" for it.
    Changes made to a job after the update do not exist on 0.1.x.
  - Machines keep the configuration last written to them, a job's later change
    included; the agent ignores `excludeLargerThanBytes`, and 0.1.x lets you change a
    machine's settings on its page again. A 0.1.x server sends the stored default
    bandwidth limit and never the size limit or time windows; windows stay in the job
    and apply again after the next update.
  - A pause of agent updates set on the tenant after the update is not honoured by
    0.1.x, which only knows the pause stored on the machines.
  - Updating to 0.2.0 again does not move a tenant twice. Schedules created on 0.1.x
    run next to the jobs (backups twice), changes made on 0.1.x to replaced schedules
    are ignored, and machine settings changed on 0.1.x are overwritten the next time
    their job is changed. Check each tenant's jobs and its "Jobs & schedules" section
    after updating again.
  - Run one scheduler version at a time. A 0.1.x and a 0.2.0 scheduler share the
    leader lock, so only one plans at a time, but each change of leader between them
    runs what the other left overdue.
- **Where to look afterwards:** the tenant's mail job under Mail & SaaS > Jobs, its
  machine jobs under Servers & endpoints > Jobs, and `backup_job.migrated` in the
  audit log.

### Known Issues

- Microsoft 365 backup and restore have still never run against a real Microsoft 365
  tenant; they are covered by tests against a simulated Graph API. Run Restow next to
  your existing backups and restore a test mailbox before you rely on it.
- **Jobs write to the tenant's primary storage target.** The editor shows it and the
  API refuses another; a repository per job comes later. A machine job cannot be
  paused (the agent decides when to back up; taking machines out of the job ends the
  management, not the backups), and restore checks of machines follow every backup
  with no cadence to set.
- **Schedules the migration could not take over** stay old-style schedules in Tenant
  settings > Jobs & schedules and keep running next to the job: an object's own
  schedule that pauses longer than the job's, the further schedules of an object
  that had several of one kind, a second tenant-wide schedule with another cadence
  and a cadence the scheduler cannot plan. Move such an object into a job with the
  schedule you want and then switch the old schedule off. A tenant without a
  tenant-wide schedule gets a job over exactly the objects that had one of their
  own; an object that had only one kind of schedule now also gets the other kind
  (more runs, never fewer).
- **A run keeps the bandwidth limit of its start**, and time windows apply to
  backups only, not to restores or restore tests. Throughput of an agent run is
  derived from the growth of the repository, so another machine writing to the same
  repository adds to it; runs started before the update and agents that report no
  progress have no throughput line.
- **Under "All tenants" there is no cross-tenant history, alert list or object
  list**; those pages ask for a tenant. The notifications bell, the Statistics tab
  and the command palette have no "All tenants" scope, and "Start" is hidden there.
- **The archive retention period cannot be changed yet** (8 years, not settable); the
  tenant page shows what applies. Google Workspace and Proxmox are announced, not
  built. Leaving an installation or tenant section with unsaved changes drops them.
- **Not looked at in a browser:** the layout of the seven-step wizard on a narrow
  screen was checked in code and tests, not by eye. `--behind-proxy` was verified
  against stub commands and a real Caddy edge, not on a VM with a real Nginx Proxy
  Manager since the encrypted hop was added; the plain HTTP hop is the configuration
  verified by hand on a Proxmox VM.
- **Deferred to 0.2.1:** context menus, the "assigned to" column and owner of a machine
  in the machine table, file restore from the machine table with the shared
  timeline, and simulated runs in the public demo.
- The checks listed as not run under Verification were not repeated for this
  entry; the release pipeline runs the smoke checks.

### Verification

Measured on 2026-10-03 on the release candidate (revision `9272693` plus the
uncommitted 0.2.0 changes; the tag commit differs and the release pipeline repeats
the smoke on it). Host: Apple M4 MacBook Air, macOS 26.5.2; Node 25.9.0, pnpm 9.15.9,
Go 1.27.1, restic 0.19.1 (the pinned binary of `agent/dist`), PostgreSQL 16.14
(local). No Microsoft 365 development tenant was used. Heavy steps ran one after
another with `VITEST_MAX_FORKS=3`.

- **Lint, typecheck, build:** `pnpm lint` (Biome over 2461 files, the `ee/` import
  boundary, the former-name and package-file guards), `pnpm build:libs` and
  `typecheck` over every workspace passed.
- **Test suites:** Vitest over 13 workspaces with the PostgreSQL suites and
  `RESTIC_BINARY` set: 770 test files, 9600 tests, all passed (apps/web 3352,
  apps/api 2825, packages/core 1914, apps/worker 379, packages/i18n 244, ee/api 238,
  demo seed 172, ee/web 177, packages/db 139, apps/scheduler 65, ee/licensing 59,
  packages/cli 32, ee/worker 4). The same run without `RESTIC_BINARY` passed 9463
  tests and skipped 137 (the restic-dependent ones). `deploy/install/test.sh`: 601
  checks passed under bash 3.2 (macOS).
- **Endpoint agent:** `gofmt -l` clean, `go vet ./...` and `go test -race ./...` passed
  for all packages.
- **Migrations:** 25 (0000 to 0024); the PostgreSQL suites ran against them.
- **Not run in this pass, and so not claimed:** the release smoke and image builds,
  Trivy, `pnpm audit`, the license check, gitleaks, ShellCheck, the updater
  end-to-end test, the installer on VMs and the upgrade path from a 0.1.0 database
  with the schedule migration (the migration is covered by its own PostgreSQL
  tests). The release pipeline runs the smoke for both builds on amd64 and arm64 and
  attaches the smoke reports; this section is completed with their result.

## [0.1.0] - 2026-10-02

Beta release. First public release of Restow. Run it alongside your existing
backups, not as your only one, until you have verified restores against your
own data.

### Summary

Restow 0.1.0 is the first public release of a self-hosted backup for Microsoft
365 (Exchange mail, calendar, contacts and OneDrive), IMAP mailboxes and, with
an agent, Linux and macOS servers and clients, written to encrypted,
deduplicated storage that you run and restored without ever overwriting an
original. It checks every week that a sample of each backup can be read back,
imports legacy mail files, keeps imported mail and, with Business or Service
Provider, Exchange Online journal mail in a hash-chained archive, and comes as
two builds: the full images, whose Business and Service Provider modules stay
locked until a license key is installed, and the Community images with the
Apache-2.0 core alone. It is a fresh installation only, because internal builds
before 0.1.0 cannot be upgraded, and Microsoft 365 backup and restore have been
tested against a simulated Graph API only, never against a real Microsoft 365
tenant (see Known Issues).

### Breaking Changes

None for operators of a public release: there is no earlier public release.

Internal builds 0.300 to 0.304 were never published, cannot be upgraded to
0.1.0 and are not migrated: 0.1.0 is a clean break. Environment variable
prefix, storage and key formats, key-derivation labels, license key prefix, API
key prefix and database names all differ from those builds, so nothing is
carried over. Whoever ran one of them installs 0.1.0 as a new installation (a
new database, a new `RESTOW_MASTER_KEY` and `BETTER_AUTH_SECRET`, an empty
storage location) and sets it up again, including new license and API keys and
new passkey and authenticator registrations. Data written by those builds can
only be read by the build that wrote it, with its master key.

### Added

#### Backup and restore

- Microsoft 365 backup: Exchange mailboxes (mail, calendar, contacts) and
  OneDrive, incremental via Microsoft Graph delta queries. Graph is the only
  Microsoft interface Restow uses; Exchange Web Services, which Microsoft
  switched off for Exchange Online on 1 October 2026, are not used.
- IMAP backup for arbitrary IMAP mailboxes over TLS with password
  authentication, restored by IMAP append. An IMAP source uses one of three
  login modes: one shared login for all its mailboxes, a separate login per
  mailbox (for hosters that give every mailbox its own password, with CSV
  import), or a master user (Dovecot separator or SASL authorization id).
  IMAP carries no calendar or contacts.
- Granular and complete restore: a single mail, a folder, a file, a file
  version or a whole account, into the original or another mailbox, OneDrive
  or IMAP account, or as a ZIP download. A restore always lands next to the
  original, never over it. The restore explorer previews and prints mail and
  shows the restore points in a timeline at the bottom edge. A message whose
  formatted view would take too long is shown as text, marked "Simplified
  view"; a message that cannot be read within the preview's time and memory
  limits shows its header data and can still be downloaded and restored.
- Self-service restore: a tenant member with the role "user" signs in and sees
  and restores only their own mailbox and OneDrive (matched by e-mail address).
  An administrator who restores someone else's data gives a reason, and the
  audit log records it as done on behalf of that person.
- Restore checks: every week (Sunday 03:00, Europe/Berlin, in the recommended
  schedule) and, while that schedule is enabled, after every backup, a random
  sample of the latest snapshot (20 mails and 20 files, plus a few calendar and
  contact items) is read back through the restore path and compared with the
  recorded hashes. Every protected mailbox, OneDrive, server and client shows
  its result on Daily › Recovery readiness (Ready, Attention, Not restorable,
  Not verified or No backup yet), all in one table. A check rates red only with
  evidence: data that is missing (a chunk the index does not know, or a data
  file every storage target says it does not have), data that does not match
  (hash or size, a chunk that is not the one its id names) or stored data that
  does not decode. A check the storage could not serve (a network error, a
  timeout, a 5xx answer, throttling, an error nobody recognises, a manifest the
  storage does not return) is "not completed": it rates nothing, changes no
  last check, sends no notification, `verify.completed` or `job.failed`, stops
  at the first such read and is repeated with the queue's backoff (three more
  attempts from two minutes); the last attempt ends without a rating and the
  next scheduled check tries again. A copy target that answers still serves the
  check. History shows such a check as "Not completed, will be retried" with
  its cause.
- Entra directory sync: users, mailboxes and OneDrives of a Microsoft 365
  tenant come in from Entra ID. Protection rules decide what is backed up
  (everyone, members of a group, or a selection), and single mailboxes can be
  included or excluded. Recommended schedules are applied once a tenant has an
  active source: backup every 8 hours, directory sync every 6 hours (full
  enumeration every `DIRECTORY_FULL_SYNC_HOURS`, default 24), restore check
  weekly, sampled storage check weekly, full storage check monthly, retention
  daily.
- Backup retention (Setup › Retention): how long restore points are kept, as a
  tenant-wide default or for chosen objects, from presets or custom tiers.
  Without a policy every restore point is kept.
- Standalone restore: `restow-restore` restores and verifies a snapshot from
  the storage and the key material alone, without a running Restow server or
  database, and detects a damaged byte. `restow-restore endpoint-password`
  opens the repository password of a server or client the same way (see
  Endpoint backup).

#### Storage

- Storage targets: local disk (the default, a Docker volume), S3-compatible
  object storage (Hetzner Object Storage, Garage, Wasabi, B2, AWS) and NFS or
  SMB shares mounted into the containers. Content-defined chunking,
  deduplication within a tenant, AES-256-GCM encryption with a key per tenant
  before anything is written.
- Several targets per tenant: a copy target that receives every new backup,
  promotion of a copy to primary, and replacing the primary either by moving
  all existing backups (copied and verified by SHA-256 before the switch) or by
  keeping them where they are. Admin › Repositories shows each target's health and
  whether an S3 bucket enforces Object Lock; it marks filesystem targets as
  "No hardware WORM". See Known Issues for what that means for the archive.
- Storage checks (scrub): a weekly sampled and a monthly full check of pack
  integrity.

#### Archive, import and export

- Exchange Online journal archive (Business and Service Provider): the
  receiver is part of the `api` role and takes journal reports over SMTP with
  mandatory STARTTLS. Each tenant has its own address
  (`journal+<token>@<journal host>`). The archive page shows the address with a
  copy button, whether the receiver runs and why not, the last report and the
  reports of the last 24 hours and 7 days, what DNS, port 25 and TLS need, and
  a step-by-step guide for the Exchange Online connector and journal rule.
  Rotating the address asks first and stops the old address at once; issuing
  and rotating are audited. It needs `JOURNAL_SMTP_PORT`, `JOURNAL_HOSTNAME` and
  a TLS certificate (`JOURNAL_TLS_CERT_PATH`, `JOURNAL_TLS_KEY_PATH`). An
  installation that does not use journaling (`JOURNAL_SMTP_PORT` unset) sees a
  neutral "Not set up" state with one sentence on what is needed and the guide
  folded away; red and amber are kept for a configured receiver that is down or
  misconfigured. Reports are parsed in the api's isolated parser processes (see
  Security). A report that cannot be read within their limits is still
  archived byte for byte as received, without its details, and marked
  `report-parse-timeout` or `report-parse-memory-limit` (`report-unparseable`
  for other parser failures); the details list at most 100,000 envelope
  recipients (`recipients-truncated`, the archived report keeps all). While all
  parser processes are busy and 16 tasks are waiting, a report is answered with
  SMTP 451 and Exchange Online delivers it again later.
- The archive store: each item is kept byte for byte and encrypted, linked to
  its predecessor in a SHA-256 hash chain. The archive page verifies the chain
  and searches archived mail (administrators). Search covers subject,
  extracted body text and the envelope addresses; it does not search
  attachments. The list and the detail show how each item was captured
  (Exchange Online journal, Graph sync, IMAP sync or mail file import), and the
  search API returns it as `source`. The archive keeps items for 8 years,
  counted to the end of the year of receipt (a fixed default in this release,
  see Known Issues). The daily deletion run that enforces retention, and legal
  holds that block it for a whole tenant or for one mailbox, are Business and
  Service Provider.
- Archive evidence report: a JSON report for a period of up to 366 days with
  item counts, capture channels, hash chain state, retention and legal holds,
  through the integration API (`GET /api/v1/archive/report`, scope
  `archive:read`, audited). There is no PDF and no screen for it yet.
- Mail file import: bring a legacy mailbox that no longer exists as a mailbox
  into Restow from EML, MSG, MBOX, ZIP archives or a MailStore export (an EML
  or MSG folder tree, or a ZIP of it; MailStore's internal archive format cannot
  be read). Files arrive through a chunked, resumable browser upload that is
  sealed with the tenant key from the first byte (no plaintext copy on any disk,
  multi-gigabyte files, size limit, progress, cancel) or from a read-only
  server-side import folder (one subfolder per tenant). The type of every file
  is decided by its content. The import runs as a worker job with progress and
  checkpoints (a restarted worker continues where it stopped) and skips exact
  repeats (same Message-ID and SHA-256 within the same folder). A damaged,
  hostile or too expensive file or message is listed as unreadable with its
  reason and the import goes on; a message whose subject, sender and text
  cannot be read within the limits is imported byte for byte without them
  (noted as "metadata unavailable"). The import ends with a report of messages,
  folders, attachments, duplicates, failures and bytes. The result is an
  imported mailbox in the IMAP backup's storage format with the original folder
  structure, so it appears in the restore explorer (browse, preview, print,
  restore into an IMAP account or a Microsoft 365 mailbox, download). The
  administrator can archive it at the same time; the retention period then
  starts at the import date and search uses the mail's own date.
- Mail export: backed-up, imported or archived mail as EML in a ZIP (folder
  structure, `MANIFEST.csv`, `SHA256SUMS`) or as MBOX (one file per folder in a
  ZIP, or one `.mbox` for a single folder), built by a worker job, sealed in the
  tenant's storage, downloadable for 24 hours (`EXPORT_TTL_HOURS`) and audited.
  PST and OST files are recognised and refused with an explanation; PST export
  is shown as planned.
- Storage budgets for import staging and export files, per tenant: uploads that
  still hold staged files may declare 100 GiB together
  (`IMPORT_MAX_STAGING_BYTES`); a new upload that does not fit is refused before
  its first byte (422 `urn:restow:problem:import-staging-full`), and the upload
  dialog says what to do. Unexpired export files may take 50 GiB together
  (`EXPORT_MAX_TENANT_BYTES`); a new request beyond it is refused (422
  `urn:restow:problem:export-quota-exceeded`), and an export that grows beyond
  it stops, removes what it wrote and fails with "export storage full" and the
  next steps. The daily retention run removes the leftovers of failed or
  cancelled exports and of uploads and exports whose job is gone.

#### Endpoint backup

- Server and client backup with the Restow agent and restic (Community; Linux
  and macOS, Windows is planned). Servers & endpoints › Inventory lists every
  machine (filters All, Servers, Clients) and shows the install command
  and, apart from it, a one-time token (valid 24 hours, single use) that the
  installer asks for with hidden input; unattended installs (RMM) read it from a
  root-only file named by `RESTOW_TOKEN_FILE`. The instance serves the install
  script and the agent binaries. The agent and restic are installed owned by
  root in `/opt/restow-agent/bin` (Linux) or
  `/Library/Application Support/Restow/bin` (macOS). Each machine gets its own
  repository with its own password, sealed with the tenant key. The write path
  is append-only, enforced by the instance: an agent can add backups but never
  delete or overwrite one, and attempts to are audited, at most one entry per
  machine and kind of attempt every ten minutes.
- Signed agent releases: every agent release (the agent and restic, for every
  platform) is signed by the maintainer, and the installer and the agent's
  self-update install nothing that does not carry a valid signature (see
  Security). "Automatic agent updates" can be paused and resumed per tenant on
  the Inventory page. Each release target also carries `THIRD_PARTY_NOTICES.txt`
  (the agent's license, Go's, restic's and those of the 79 Go modules compiled
  into restic), covered by the signed `SHA256SUMS`, installed readable for all
  at `/opt/restow-agent/THIRD_PARTY_NOTICES.txt` or
  `/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt`, replaced by
  every self-update and removed by the uninstall; the GitHub release attaches it
  as `restow-agent-THIRD_PARTY_NOTICES.txt`.
- Hooks (commands before and after a backup, for example a database dump) run
  only on machines whose root allowed them: `sudo restow-agent hooks scripts`
  runs only named scripts that root put into `/etc/restow-agent/hooks.d`,
  without a shell; `sudo restow-agent hooks any` runs any command; the
  installer takes `--hooks=scripts` or `--hooks=any`. Hooks are off on a new
  machine, and the server cannot change the setting. The endpoint settings
  show each machine's policy with the command that changes it, accept only
  script names on a machine that runs only its own scripts, and refuse hooks a
  machine would not run (409 `urn:restow:problem:endpoint-hooks-not-allowed`). A
  backup whose hook was skipped is partial, with the reason "the machine does
  not allow hooks". Only those who may change the endpoint's settings see the
  hook text; everyone else sees whether a hook is set and a short fingerprint.
- Retention (daily 30, weekly 12, monthly 12 by default, in the tenant's time
  zone), repository checks and restore tests run on the server. The server
  decides what retention deletes from its own records: it keeps only snapshots
  that a backup run reported, dates them by when the storage received them, and
  passes exactly the chosen snapshot ids to restic. Snapshots no run reported,
  and snapshots dated in the future, are never deleted, are marked in the
  snapshot list and are announced once (alert `endpoint.suspicious_snapshot`).
  A machine counts as recoverable only after sampled files were read back with
  matching hashes: the server reads the samples with `restic dump` (the smallest
  file first and alone, so restic sets up its cache once), and the agent then
  restores the same files once on the machine and reports per file what it
  found; the server judges both. Red needs proof (a hash that differs, a file the
  snapshot does not contain, or restic reporting that the data the files need is
  missing or damaged). A test that could not complete (the repository busy or
  unreachable, restic unable to start, a full disk on the machine, an agent
  stopped or silent for six hours) rates nothing and sends no alert or
  `job.failed`: the server's test is offered again every hour, the machine's
  test after 1, 2, 4, 8, 16 and 24 hours while its backup is the machine's
  newest, and the interface shows it as "Not completed, will be retried". Sample
  paths are kept exactly as restic names the file. Browse a snapshot, download
  files as ZIP (up to 10,000 selected paths, started as a second, single-use
  step), or restore into a new folder on the machine, never over existing files,
  from the machine's page or from Servers & endpoints › File restore (pick a
  machine, then a restore point); a restore target must be a folder that only
  root can change. A partial backup names each file restic could not read with
  its reason (above 100 files the first 99 and how many more), and a failed
  restore names the first file and its cause. A run that only lost its agent to a
  restart is shown as interrupted, not as failed.
- Storage budgets: each machine's repository may take 2 TiB
  (`RESTOW_ENDPOINT_QUOTA_GIB`, default 2048, and a "Storage budget" per machine
  in its settings) and all machines of a tenant 20 TiB together
  (`RESTOW_ENDPOINT_TENANT_QUOTA_GIB`, default 20480); `0` switches a budget off.
  An upload that does not fit is refused (403
  `urn:restow:problem:endpoint-quota-exceeded`) and restic stops; restores keep
  working. The machine's "Repository" card shows the usage against both
  budgets, and the alert `endpoint.storage_quota` warns at 90 percent and when
  uploads are refused.
- Repository maintenance on the server never overlaps on one machine:
  retention and the repository check take the repository exclusively, restore
  tests, browsing, snapshot lists and downloads share it. A job that finds it
  busy waits up to a minute and is otherwise retried later without rating
  anything; a browse or download request answers "repository busy" (503
  `urn:restow:problem:endpoint-repository-locked`). Lock files older than 30
  minutes are removed before retention and checks; six locked attempts in a row
  over at least twelve hours raise the alert `endpoint.repository_locked`.
- Restore without Restow: the repository password of every machine is also
  stored next to its repository, sealed with the tenant key. The master key and
  the storage are enough to open it with
  `restow-restore endpoint-password --storage <dir> --key <file|env> --endpoint <id> [--out <file>]`,
  after which plain restic restores the machine. In the web interface,
  "Restore without Restow" on the machine's page shows the password after
  confirmation, audited.
- Silent servers, clients without a recent backup, failed runs and restore
  tests rated red raise the usual alerts and the `job.failed` webhook. Machines
  appear in `GET /api/v1/endpoints`, in the recovery readiness table and on the
  Overview (tabs Status and Statistics). A storage change that would leave active
  machines behind (replacing or promoting the primary) is refused with a clear
  message; the repositories are not moved by a storage migration yet.

#### Alerts, reports, dashboard and statistics

- Alert rules per tenant (every edition, Daily › Alerts) say who is told what, and when: by
  e-mail and, optionally, a signed webhook, for a failed backup, restore or
  directory sync, a completed restore, a restore check that did not pass or
  needs attention (and its recovery), damaged or repaired storage, a silent
  endpoint, a suspicious endpoint snapshot, an endpoint storage budget that is
  nearly or fully used, an endpoint repository that stays locked, and an
  available update. A red rating caused only by a backup that is 7 days or older
  reads "Backup too old: <name>" in the bell and as the subject of the alert
  mail, apart from "Restore check failed" for missing or damaged data
  (notifications carry `details.redReason`). Repeats for the same mailbox are
  held back for a chosen time. Every event also appears in the bell in the top bar, whose badge is red
  only while an unread entry is a warning or an error. A delivery log shows
  each mail, bell entry and webhook with its outcome; failed mails are retried
  four times over about 80 minutes. "Send test now" tries a rule on all its
  channels. The notification recipients chosen in the tenant wizard become
  rules.
- Report rules (Business and Service Provider) send a summary of the last day,
  week, month or quarter at a fixed time (daily, weekly, monthly or a cron
  expression in a time zone): backup success rate, failed items, the share
  proven restorable, the most frequent failure causes, protected and stored
  data, restores.
- Overview (Daily), tab Status: widgets for setup progress, the last backup,
  recovery readiness, recent runs, retention, storage, protected objects, protected mailboxes,
  backup success and trend, storage growth, verification history and protected
  machines. Service Provider adds a provider dashboard that rolls tenants up.
- Overview, tab Statistics: backups, restores, storage growth and checks over a period,
  compared with the previous period, with a CSV export per dataset and a PDF
  report. Service Provider adds the cross-tenant scope.
- Failure explanations: every failed or partly failed job, failed item, broken
  source, failed directory sync, failed IMAP login test and red restore check
  says what happened, why and what to do, in German and English. Errors are
  classified into stable cause codes (for example `graph.consent_missing`,
  `graph.permission_missing` with the permission named, `graph.throttled` with
  the wait Microsoft asked for, `imap.auth_failed`, `storage.full`,
  `crypto.key_missing`, `verify.hash_mismatch`, `export.quota_exceeded`), each
  with concrete next steps that link to the right settings page, a "Retry now"
  where a retry makes sense, and a link to the troubleshooting guide
  (`RESTOW_DOCS_TROUBLESHOOTING_URL` points it at your own runbook). The raw
  detail stays available under "Technical details" (HTTP status, Graph error
  code, request ID, client request ID, server time), with secrets removed. The
  cause is also part of the job objects, item failures and verification
  reasons of the integration API and of the `job.failed` webhook payload.

#### Setup, accounts, sign-in and teams

- Interface: React, full German and English translation, dark mode, passkey-first
  sign-in for provider and tenant administrators (with a password-plus-TOTP
  fallback while a domain is not yet verified for passkeys; the authenticator
  entry is named "Name (host)" so installations stay apart), and a guided
  first-run setup wizard.
- Setup token: the first step of the setup wizard asks for a one-time setup
  token that only someone with access to the server can read. The `api`
  container prints it to its log at every start until the setup is complete
  (`docker compose logs api | grep 'SETUP TOKEN'`); a restart issues a new one,
  and the wizard then asks for it again with your entries kept. Set
  `RESTOW_SETUP_TOKEN` (at least 16 characters, for example
  `openssl rand -hex 16`) to know it in advance for unattended installations or
  when container logs are shipped elsewhere; it is then never logged. Scripted
  setups send it as `X-Restow-Setup-Token`.
- Operator responsibility notice: the second step of the setup wizard is a
  short notice that Restow is a backup and archive tool and that the hardware
  and storage layer (redundancy, immutability, encryption key custody, network
  and access security, restore tests) is the operator's responsibility. It is
  accepted inside the wizard and saved together with the setup: the text
  version, time and client address are stored in the installation settings and
  written to the audit log with the new administrator as the one who accepted.
  The server refuses the setup without it.
- Administrator recovery on the command line: if the last owner has lost their
  passkey, authenticator app or password,
  `docker compose exec api restow admin recover --email <owner>` sets a new
  password (asked for at a hidden prompt, or `--password-stdin --yes` for
  scripts), removes the owner's authenticator app and passkeys and ends all
  their sessions; the owner then signs in and sets up an authenticator app
  before anything else. `restow admin list` lists the administrators. It works
  for owners only (an owner resets every other administrator in the web
  interface), needs no running api and is recorded in the audit log.
- Confirming it is you: changing the update source or its access token,
  announcing an update, setting or changing an endpoint hook and showing an
  endpoint's repository password need a sign-in from the last 10 minutes. With
  a passkey the confirmation happens in place and the action continues; with
  the password and authenticator code you sign in again and repeat it.
- Settings, Microsoft 365: the Microsoft app registration for backup (client ID,
  tenant ID, certificate or secret, with a connection test that compares the
  granted permissions) is entered in the interface, stored encrypted and
  effective without a restart; `ENTRA_CLIENT_*` variables take precedence when
  set. Settings, Mail: the notification transport, SMTP or Microsoft Graph, with
  a test mail.
- Tenant members: tenant administrators add people to their tenant as tenant
  administrator or user. Someone without an account receives a single-use
  sign-in link to choose a password (valid 72 hours; mailed when a mail
  transport is configured, otherwise shown once to copy). Community covers one
  organisation with its members.
- Team (Business and Service Provider): several provider administrators, each
  with a fixed role (owner, administrator, technician, read only) and either
  every tenant or a chosen set of tenants (with Business, which has one tenant,
  the scope only matters for Service Provider). Owners invite members by a
  single-use set-password link (72 hours), change roles and tenants, and remove
  members; the team always keeps at least one owner. Every API route carries a
  rule for the least role it needs, checked centrally for every provider
  administrator request. Read only members see status, reports and the audit
  log but no backed-up or archived content. Every team change is in the audit
  log. The provider administrator created by the setup wizard is an owner.
  Community has one provider administrator and no team.
- Audit log viewer (Business and Service Provider): list, filter, entry detail
  and verification of the audit chain. Recording happens in every edition;
  daily seals of each chain (see Security) make a cut-off chain visible.
- Editions: Community (free, no license key), Business and Service Provider
  (perpetual, an offline-verified Ed25519 license key, no phone-home, no
  shutdown). No edition limits the number of mailboxes or restores; mailbox and
  tenant counts are an honour rule of the license terms, never counted against
  a limit in the software. Community and Business run one organisation; Service
  Provider adds more tenants, tenant switching, a cross-tenant provider API for
  RMM and PSA integration and tenant-scoped team members. How the editions are
  delivered (two builds) and licensed is described under Changed.
  Contributions need the Contributor License Agreement and a DCO sign-off on
  every commit.
- Product name: `RESTOW_PRODUCT_NAME` sets the name that the web app, mails,
  reports, the PDF report headers and the API documentation show (default
  "Restow"). Technical identifiers keep their names: `RESTOW_*` variables,
  `restow-agent`, `restow-restore` and `restow`, `X-Restow-*` headers, `rsk_`
  keys and image names. The static maintenance page is written when the web
  image is built and carries the name given as build argument
  `RESTOW_PRODUCT_NAME`.

#### Integration

- Integration API (REST, documented with OpenAPI, every edition): API keys per
  tenant with scopes, backup, restore and verify status, jobs, storage, the
  archive status and evidence report, webhooks, and a directory export for PSA
  and billing. Reads of user and backup data through an API key are written to
  the audit log. `GET /api/v1/status` and `GET /api/v1/me` report the version
  and its commit (`version.commit`); `GET /api/v1/usage` (provider
  administrators) reports the protected mailboxes in total and per tenant;
  `GET /api/v1/notifications` reports `unreadAttention` next to `unread`.

#### Operation and updates

- Operation: one application image with the roles api, worker, scheduler and
  the optional updater, plus the web image (Caddy serving the interface), in
  two builds (see Changed), run with Docker Compose next to PostgreSQL 16;
  migrations run automatically when the api starts. A release stack that runs
  the published images (`deploy/release/`, also attached to each release as
  `docker-compose.yml` and `env.example`) and the source stack at the
  repository root are both provided. The `restow` command in the api container
  holds the server-side maintenance commands (`docker compose exec api restow
  help`).
- Install script for a dedicated Linux VM (new in 0.1.0): `install.sh`, attached
  to every release with `install.sh.sha256` and listed in the signed
  `SHA256SUMS` (source `deploy/install/install.sh`). On Debian 12 or 13 or
  Ubuntu 22.04, 24.04 or 26.04, amd64 or arm64, it checks the machine
  (operating system, architecture, virtualization, memory, disk, ports 80 and
  443, outbound HTTPS, clock, the domain's DNS record, an earlier
  installation), installs Docker Engine and the Compose plugin from Docker's
  signed apt repository when Docker is missing, downloads `docker-compose.yml`
  and `env.example` of the release and checks them against `SHA256SUMS` and its
  cosign signature, writes `/opt/restow/.env` (mode 0600) with secrets from the
  kernel's random generator, pulls the two images of the chosen build (full or
  Community), checks their cosign signatures against the release workflow of
  exactly that version and starts the stack. It shows `RESTOW_MASTER_KEY` once,
  on the terminal and never in its log (`/var/log/restow-install.log`), and asks
  you to confirm that it is stored offline. Options for an unattended run
  (`--non-interactive --domain ... --edition ...`), a dry run (`--dry-run`), an
  evaluation without a public domain (`--local`) and the opt-in updater
  (`--with-updater`, off by default); `bash install.sh --help` lists them with
  the exit codes. Running it again never changes `.env`, a secret or data: it
  checks the images and makes sure the stack runs. It does not update
  (`docs/UPDATING.md`) and has no uninstall (the README's "Removing Restow" has
  the manual steps). The manual Docker Compose installation stays fully
  supported; the README's Quickstart starts with platform recommendations (a
  dedicated VM on other hardware than the systems it backs up, backups
  off-site, preferably S3 with Object Lock; LXC best effort only; no native
  installation without Docker).
- Health endpoints: `/healthz` answers whether the api process is up.
  `/readyz` answers 503 `not_ready` unless the database answers and the worker
  and the scheduler have reported in within the last two minutes (they report
  every 30 seconds), so a backup product without a worker is not ready.
- Release images: the four images of a release (`restow`, `restow-web`,
  `restow-community`, `restow-web-community` on `ghcr.io/restow-backup`) are
  built for amd64 and arm64, signed with cosign (keyless, GitHub OIDC) and carry
  an SPDX SBOM as attestation; the SBOMs and `SHA256SUMS`, the checksums of the
  release files signed with cosign, are attached to the release. Tags are the
  version and `beta`. Both builds pass a smoke run before a release is
  published; the reports are attached to the release (see `docs/CI.md`).
- The application images carry only compiled code and production dependencies:
  the build fails on any first-party test file, test folder or TypeScript
  source, so none is left in the api, worker, scheduler and restore tool trees
  (leaving them out took the application image from 875 MB to 852 MB on
  linux/arm64). The build context leaves out test results and local work
  folders (`.dockerignore`; `.gitignore` keeps `/work` out of the repository).
- Updates (Admin › Settings, Updates): an update check that is off until a provider
  administrator turns it on. It reads only the release list of the chosen
  source once a day or on "Check now" (the public releases of the project by
  default; another GitHub, Forgejo or Gitea repository, with an optional access
  token kept encrypted for a private one; stable or beta channel) and shows the
  running and newest version, the release notes and why a check failed. A new
  version raises one "Update available" alert. Viewing needs a provider
  administrator; changing anything, including "Check now", needs the provider
  owner role. `RESTOW_UPDATE_CHECK_URL` is an environment override and takes
  precedence.
- Optional updater (`docker compose --profile updater up -d`, opt-in, mounts
  the Docker socket, which is root on the host; read `docs/UPDATING.md` first):
  announces an update with a lead time to everyone who is signed in, verifies
  the signature of the release images and pulls them by digest, dumps the
  database (the last three dumps are kept), replaces the services, checks that
  the new version answers and rolls back by itself when it does not. If the new
  version fails after its database migrations ran, the updater does not start
  the old version on the migrated database: it stops the application, keeps the
  dump and says how to restore it. It runs its own image, set as
  `RESTOW_UPDATER_IMAGE` in `.env`, which an update never replaces. Building an
  update from a source repository instead of installing release images is off
  unless the repository is named in `RESTOW_UPDATER_SOURCE_HOSTS`; the Updates
  tab then shows the exact `.env` line and offers no install button until it is
  set. While the api restarts, the edge shows a static maintenance page that
  names no version. The audit log records update checks, scheduling,
  cancellation, start, success and failure (`update.*`), not every step.
- Daily audit anchors: once a UTC day is over, a seal of each audit chain's
  last entry is stored (and written to the worker log), so a chain that was cut
  off at the end or recomputed becomes detectable.

### Changed

There is no earlier public release. The points below differ from what the
website, the documentation and the public demo described before this release;
each says how 0.1.0 behaves.

- Licenses: the Restow core, everything outside `ee/` including the endpoint
  agent, is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`). The
  Business and Service Provider modules in `ee/` are licensed under `ee/LICENSE`:
  the source is available, and production use needs a valid Restow license key
  under the Restow license terms on restowbackup.com. Every package declares its
  license, and CI checks the licenses of all dependencies against an allowlist
  (no copyleft at all in the dependencies of `ee/`) on every change. The images
  carry `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md` in
  `/usr/share/doc/restow/`, and the web image serves the third-party notices at
  `/licenses/THIRD_PARTY_NOTICES.txt`. The notices also cover the restic binary
  Restow ships and everything compiled into it: a section "Go modules compiled
  into the restic binary" lists each of the 79 modules of restic 0.19.1 with its
  license, copyright lines, license texts and NOTICE files (minio-go, grpc-go
  and go-yaml have one), taken from each module at exactly the version in the
  binary and kept in `licenses/restic-deps/`. 26 modules are Apache-2.0, 18 MIT,
  15 BSD-3-Clause, 7 BSD-2-Clause, 12 carry more than one license, and one,
  `github.com/hashicorp/golang-lru/v2`, is MPL-2.0: it is used unmodified, and
  its entry says where its source code is (MPL 2.0, section 3.2). CI checks these
  modules one by one (`scripts/ci/license-policy.json`, section
  `redistributedBinaries`, with MPL-2.0 for that one module as the only named
  exception, which allows nothing for Restow's own dependencies and nothing in
  `ee/`) and that the vendored list matches the pinned restic binaries.
- Two builds of every release instead of one image for every edition. The full
  images, `ghcr.io/restow-backup/restow` and `ghcr.io/restow-backup/restow-web`,
  contain the core and the Business and Service Provider modules; without a
  license key they run as Community, and the paid functions stay visible in the
  menu but locked (greyed out, lock icon, leading to Settings › About) while their
  API routes answer 403 `urn:restow:problem:edition-required`. The Community
  images, `ghcr.io/restow-backup/restow-community` and
  `ghcr.io/restow-backup/restow-web-community`, contain the Apache-2.0 core alone,
  without any `ee/` code: no license key screen, no locked menu entries, and the
  core routes that need a paid edition (a second tenant, provider API keys, the
  cross-tenant statistics and dashboard, time-triggered summary reports) answer
  403 `urn:restow:problem:feature-unavailable`. Both builds use the same database
  schema; switching is a change of `RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` in
  `.env` and `docker compose up -d`, and the updater stays on the build it runs
  from.
- The core knows no license: license key verification, the edition switch,
  unlocking, the license API and the license screen live only in the modules
  under `ee/` (`ee/licensing`, `ee/api`, `ee/web`). Keys are issued only by the
  vendor's private license service; the images contain no signing tool and only
  verify. `RESTOW_LICENSE_PUBLIC_KEY` overrides the verification key for
  development and tests of the full build.
- Settings › About instead of a license page (in the full images the menu entry
  Admin › License opens it): product name, version, commit, the
  core license with a link to its text, the source code at the running
  release's tag and the third-party licenses. In the full images the license key
  is installed and removed in the same tab (edition, licensee, key id, a link to
  the Restow license terms in the interface language). The dashboard shows
  "Protected mailboxes" (tenant administrators their tenant's, provider
  administrators the installation's), not a license card. The core's API
  responses carry no `edition` field: `GET /api/v1/me` reports the enabled
  gated functions as `features` and, in the full images only, the edition as
  `extensions.edition`.
- `RESTOW_EDITION` only for the public demo: it has an effect only together with
  `RESTOW_DEMO=true`. Any other installation runs the edition of its installed
  license key, or Community without one.
- The menu has its final form, so it does not have to be rebuilt later. Daily:
  Overview (tabs Status and Statistics), History (every run: backup, restore,
  restore check, maintenance; formerly "Jobs"), Recovery readiness, Alerts
  (formerly "Alerts & reports"). Mail & SaaS: Jobs (marked "Soon", job
  definitions come with 0.2.0), Restore explorer (tab Recent restores, formerly
  "Restore jobs"), Archive, Exports. Servers & endpoints: Jobs ("Soon", 0.2.0),
  Inventory (one list of every machine with the filters All, Servers and
  Clients, instead of Agents, Servers and Clients), File restore (new: pick a
  machine, then a restore point, browse and restore or download). Tenants: All
  tenants (Service Provider) or Setup (Community and Business), which gathers
  Protection (with "Back up now" for all protected objects), Sources,
  Schedules, Retention and Imports in one tab bar; a service provider opens the
  same area for a tenant with "Open tenant page". Admin: Repositories (formerly
  "Storage"; the interface says "repository" instead of "storage target", the
  API keeps `storage`), Audit log, Integrations, License, Team (Members for
  tenant administrators), Settings, Resources ("Soon", 0.2.1); Audit log, License
  and Team come with the Business and Service Provider modules of the full
  images. Sign-in security
  is in the user menu at the top right. "Soon" entries carry an amber badge, are
  announced to screen readers as coming soon and open a page that says what the
  feature will do and which release brings it. Breadcrumbs open a menu of their
  section, and the command palette lists every entry and the setup tabs. Old
  addresses lead to the new place with their query kept (for example `/stats`,
  `/jobs`, `/jobs/<id>`, `/restore/jobs`, `/reports`, `/storage`,
  `/endpoints/...`), so links in mails, alerts and bookmarks keep working; the
  public API and the webhooks keep their names (`/api/v1/jobs` lists runs,
  `job.failed` is unchanged).
- Drop-down lists, dialogs and charts fit the screen, also on 1920x1080 and at
  125 percent scaling (reported against the public demo): every select opens
  below its field (above when there is no room), is at most 24rem or the
  available height high, scrolls inside and is as wide as its longest entry;
  long values wrap instead of being cut off. The audit log's "Action" filter is
  a searchable list grouped by category that works with the keyboard alone.
  Every dialog and confirmation is at most the screen height, scrolls inside
  and keeps its title and buttons in view. The storage chart names itself once,
  and charts no longer fill Firefox's console with dropped declarations.
- Green means proof: a badge, bar, icon or figure is green only for a passed
  restore check, a completed restore or an integrity check that came back
  intact (storage check "Intact", audit log "Chain intact"). States that are
  merely fine ("Protected", "Active", "Online", "Connected", "Completed") are a
  neutral outline, running work and information are blue. A test in each web
  package keeps it that way.

### Fixed

None (first public release).

### Security

This is the first public release; no earlier public version exists that
could be affected. The security-relevant behaviour of 0.1.0, most important
first:

- Encryption and key custody: every chunk and every manifest is encrypted with
  AES-256-GCM under a key per tenant. One master key (`RESTOW_MASTER_KEY`, the
  key-encryption key) wraps every tenant key. Whoever holds the master key and
  can read a storage target can decrypt every tenant's data; the provider has no
  plaintext access through Restow outside the audited restore and browse paths.
  Keep the master key offline and apart from the storage; without it nothing can
  be read.
- Setup and administrator access: completing the setup wizard needs the
  one-time setup token from the api's log (or `RESTOW_SETUP_TOKEN`), so neither
  a web page the operator happens to open nor someone who finds a fresh
  installation through the certificate-transparency logs can set it up first.
  Once the setup is complete the setup routes are closed for good; a lost owner
  is recovered only on the server's command line (`restow admin recover`), never
  through a public route. The setup, set-password links and agent enrollment,
  the routes that change state without a session, refuse requests from another
  site (403 `urn:restow:problem:cross-site-request`) and bodies that are not
  JSON (415 `urn:restow:problem:unsupported-media-type`), like every signed-in
  route.
- Install script: `install.sh` refuses release files whose `SHA256SUMS` is not
  signed by the release workflow of the requested version, files that do not
  match it, and images without a valid cosign signature of that workflow run
  (an unsigned image is removed again; nothing is started).
  `--skip-signature-check` switches the signature checks off for tests and
  unsigned mirrors only and says so loudly; the checksums are still checked.
  Docker's apt key is accepted only with its published fingerprint. cosign runs
  from its official image pinned by digest, the same one the opt-in updater
  uses, read-only and without capabilities.
- Updater: the optional updater mounts the Docker socket, which is root on the
  host, and holds no application credential. It installs a release image only
  after verifying its keyless cosign signature by digest before the pull: the
  certificate must be issued by `https://token.actions.githubusercontent.com`
  for exactly
  `https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v<version>`
  of the version being installed, and the signature must be in Sigstore's
  transparency log; the pulled image must carry the verified digest. A release
  without a published application digest is not installed (409
  `urn:restow:problem:update-not-verifiable`). cosign and the Docker command
  line helper run from images pinned by digest
  (`RESTOW_UPDATER_COSIGN_IMAGE`, `RESTOW_UPDATER_CLI_IMAGE`).
  `RESTOW_UPDATER_VERIFY_SIGNATURES=false` exists for test installations and
  unsigned mirrors only, set in a Compose override; the digest stays required
  and the run records that the signature was not checked. Building from a
  source repository is possible only for repositories the operator names in
  `RESTOW_UPDATER_SOURCE_HOSTS` on the server, which the updater enforces itself
  (409 `urn:restow:problem:update-source-not-allowed` otherwise). The updater
  runs its own image (`RESTOW_UPDATER_IMAGE`), never the image it installs, and
  refuses to update while the Compose file takes its image from `RESTOW_IMAGE`.
  The update check connects to public addresses only, judged on every resolved
  address at connect time, unless the operator lists the host, and gives up on
  answers larger than 8 MiB. The public maintenance status names no version.
- Recent sign-in for actions that hand someone the host or a machine: changing
  the update source or its access token, announcing an update, setting or
  changing an endpoint hook and showing an endpoint's repository password need a
  session opened in the last 10 minutes with a passkey, the password together
  with the authenticator code, or an OIDC sign-in; an older session gets 403
  `urn:restow:problem:recent-sign-in-required` and is asked to confirm. Removing
  all hooks of a machine needs no new sign-in.
- Endpoint agent: the agent and restic are installed in folders only root can
  change (`/opt/restow-agent/bin`, `/Library/Application Support/Restow/bin`);
  the installer and the agent check owner and permissions of every folder on
  the way and refuse a location another user could change, and they stage files
  under random names. Every agent release is signed by the maintainer with an
  Ed25519 key that never leaves the maintainer's machine, in the OpenSSH
  signature format (`ssh-keygen -Y sign`, namespace `restow-agent-release`) over
  the release's `SHA256SUMS`; the public key is compiled into the agent and
  written into the install scripts. The installer (with `ssh-keygen` 8.1 or
  newer, or OpenSSL 3) and the agent's self-update check the signature and the
  SHA-256 of every binary and of the license notices before they run or install anything, and refuse
  unsigned or wrongly signed releases. The release carries `agent-SHA256SUMS`
  and `agent-SHA256SUMS.sig`; every instance serves them at
  `/install/agent/<version>/`. Release key fingerprint, printed by the installer:
  `SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o` (ED25519, `restow-agent-release`). Hooks
  run as root and therefore only with the consent of root on the machine (see
  Added); the setting is stored on the machine. The enrollment token never
  appears on a command line, in a URL or in a log. The agent sends its
  credentials only to a backup repository on the instance's own host. The
  systemd service runs with `NoNewPrivileges`, protected kernel tunables, kernel
  log and control groups, no kernel module loading, no namespaces,
  `LockPersonality`, `RestrictRealtime`, native system calls only and
  `UMask=0077` (launchd: umask 077). Restore targets must be plain absolute
  paths below folders only root can change, and the agent creates the target
  folder itself (mode 0700).
- Endpoint repositories on the server: a machine cannot make the server delete
  its genuine backups. Retention is decided from the server's records (snapshots
  that a backup run reported, dated by the earlier of the time the storage
  received them and the end of the reporting run), never from the time an agent
  writes into a snapshot, and only the chosen snapshot ids are passed to
  `restic forget`. A machine cannot fill the storage target either: storage
  budgets per machine and per tenant (see Added). An agent can delete only the
  lock files it wrote (other attempts are refused and audited as `foreign_lock`),
  lock files older than 30 minutes are removed before maintenance, and the
  server's own jobs on one repository never overlap. Error messages and the log
  tail a machine sends with a run are redacted before they are stored, including
  bare `rset_` enrollment tokens, `rsea_` agent secrets, `rsk_` API keys and
  credential-named variables such as `PGPASSWORD=`. Names in snapshot ZIP
  downloads have backslashes, colons and control characters replaced and
  dot-only segments dropped, so a Windows extractor cannot read them as paths.
- Untrusted mail content is parsed outside the worker and the api process: the
  MSG reader and the metadata parser of the mail import, the mail preview and
  attachment download, and the journal receiver's report parser run in separate
  child processes with a memory limit and a time limit. A process that runs over
  a limit is killed, the item is reported as unreadable (or archived without
  details) and the work goes on, so a hostile file costs one helper process, not
  the worker or the api of every tenant. The structure of an MSG file is checked
  before the reader sees it; a file that stops the worker twice is not tried a
  third time; the parsers avoid conversions that create huge strings, and the
  steps that took time quadratic in the input are linear. Under load the api
  answers 503 `urn:restow:problem:preview-busy` rather than growing its memory.
  The per-tenant budgets for import staging and export files (see Added) keep
  one tenant from filling the storage target of all.
- Request bodies are limited to 1 MiB unless a route needs more (16 MiB for
  restore and export selections, import requests, IMAP account lists, directory
  rules and an agent's run report; 4 MiB for endpoint download selections; the
  restic data path and import upload segments keep their own caps). A larger
  body is refused with 413 `urn:restow:problem:payload-too-large`, before it is
  read when its size is declared. The Caddy edge applies the same limits as an
  outer bound. A malformed or oversized agent enrollment counts as a failed
  attempt, so 20 of them block the address like 20 wrong tokens.
- Client addresses: the api applies `RESTOW_EDGE_TRUSTED_PROXIES` itself (the
  same default and `private_ranges` shorthand as Caddy) and takes the
  right-most `X-Forwarded-For` address that is not a trusted proxy, so a client
  cannot write a forged address into audit entries, the operator notice record,
  the agent lockout or the sign-in rate limit.
- The journal receiver never serves the test certificate that ships with its
  SMTP library (its private key is public, so a session "encrypted" with it
  protects nothing). It starts only with the certificate and key you configure
  (`JOURNAL_TLS_CERT_PATH`, `JOURNAL_TLS_KEY_PATH`), checked at start (readable
  PEM, key matches, not expired); otherwise it does not open port 25 and the
  archive page says why. Sessions without STARTTLS are refused with 530 before
  `MAIL FROM`, because Exchange Online always uses TLS, and a renewed
  certificate is picked up within minutes without a restart. The release stack
  mounts `JOURNAL_TLS_DIR` read-only for the files. `JOURNAL_ALLOW_INSECURE=true`
  starts the receiver without STARTTLS for local development only, never for a
  production installation.
- Audit log: every read and restore of user data, and every administrative
  change such as a license, team, update or tenant change, is recorded in a
  hash-chained, tamper-evident audit log in every edition (who, when, what, for
  whom, from which IP). The application database roles cannot change or delete
  entries, each entry carries the hash of its predecessor, and a daily seal of
  each chain makes cutting it off or recomputing it detectable. The log lives in
  the installation's database, so it is tamper-evident, not tamper-proof against
  someone with database owner access. Viewing, filtering and verifying it in the
  interface is Business and Service Provider; its CSV and PDF export is planned.
- Refused actions are recorded as well: when a signed-in user is turned away (a
  role that may not do it, a tenant outside their scope), the audit log gets an
  "Action refused" entry with the route and the reason, at most one per user,
  tenant, route and reason every ten minutes.
- Secrets: tokens, client secrets and passwords that Restow has to keep are
  stored encrypted in the database; log output is redacted. No secret is
  committed to the repository (checked by gitleaks in CI).
- Image and dependency scans (Trivy, `pnpm audit`) run on the release images;
  their results are under Verification.

### Upgrade Notes

None (first public release): there is no earlier public release to upgrade
from. Internal builds 0.300 to 0.304 are not upgraded but replaced by a fresh
installation, as described under Breaking Changes.

### Known Issues

- Microsoft 365 backup and restore have never run against a real Microsoft 365
  tenant. They are covered by unit and integration tests against a simulated
  Graph API, and the release smoke check for Microsoft 365 is skipped while no
  development tenant credentials are configured. Expect to meet differences
  between the simulation and the real service. Run Restow next to your existing
  backups and restore a test mailbox before you rely on it.
- Restore checks read a sample back through the restore path and compare it with
  the recorded hashes. They do not restore into a Microsoft 365 mailbox, OneDrive
  or IMAP account: the optional test restore into a target is not wired up in
  this release. The page of a check whose last attempt ended without a rating
  shows the neutral "Not completed" state but no longer its cause (the attempts
  before it do). A storage target that loses its mount in the middle of a check,
  after the manifest was read, answers "not found" for data files and rates the
  object red; a target that is unmounted before the check is "not completed".
- Immutability is not guaranteed by the storage. On local disk, NFS and SMB
  targets Restow enforces the archive's immutability in application code only
  (no code path changes or deletes an archived item before its retention period
  ends); anyone with access to the files or the server can change or delete
  them. On S3 with Object Lock, 0.1.0 sets retention only on the archive item
  records, not on the packs that hold the message content, and backup data
  carries no Object Lock retention at all. Admin › Repositories shows whether a
  bucket enforces Object Lock. Protect the storage against deletion and
  ransomware yourself; the setup wizard's operator notice says so.
- The archive is written by two routes only: the Exchange Online journal
  receiver (Business and Service Provider; it needs a TLS certificate and port
  25 reachable from the internet) and mail file import with "archive at the same
  time". Continuous IMAP and Graph archive sync do not exist in this release,
  and no archive schedule is offered.
- Archive search, retention and legal holds are narrower than the design:
  search covers subject, extracted body text (very long bodies may be truncated)
  and envelope addresses, uses the PostgreSQL `simple` configuration (no
  stemming) and does not read attachments. Mail captured by the journal
  receiver is stored without extracted body text, so it is found by subject
  and addresses only, and a journal report that was archived without its
  details (see Added) is not found at all, although it is complete in the
  archive and in exports. Only administrators can search, and there is no
  self-service archive search for end users. No screen or API sets an archive
  retention policy, so the fixed default of 8 years applies; the deletion run
  and legal holds are Business and Service Provider. A legal hold covers a whole
  tenant or one mailbox, not a search result, and a mailbox hold protects only
  archive items that belong to a mailbox (imported mail archived at import):
  items captured by the journal receiver carry no mailbox assignment in this
  release, so only a tenant-wide hold protects them. Daily archive anchors and
  external timestamps are not implemented.
- The journal receiver does not verify that journal reports come from Microsoft
  (SPF or Microsoft address ranges); it accepts mail only for known journal
  addresses, with a per-sender-IP rate limit and a size limit
  (`JOURNAL_MAX_SIZE_MB`, default 150). It reads its license capability once at
  start: installing a key that adds it needs an `api` restart to open the SMTP
  listener.
- The api, worker and scheduler run as root inside their containers. They parse
  untrusted files and run restic on repositories that agents write to; the
  isolation described under Security limits what a hostile file can do, but not
  the user it runs as. Running them as an unprivileged user is planned for 0.2.0
  and will be announced as a breaking change, with the ownership steps for
  local volumes, NFS and SMB.
- Endpoint backup limits: Linux and macOS only, the Windows agent is planned.
  Agents authenticate with a per-agent secret over HTTPS (mTLS is planned), and
  consistency snapshots (LVM, ZFS, btrfs) are not used; use pre and post hooks
  for databases. A compromised agent can add index or snapshot files that restic
  cannot read: retention and the repository check then stop and the check rates
  the repository damaged, but nothing is deleted that the server did not choose.
  Snapshots that no backup run reported are kept for good, and the web interface
  has no action to delete one (remove them with restic and the repository
  password). The first installation trusts the install script the instance
  serves, as any `curl | sh` does: compare the release key fingerprint the
  installer prints with the one under Security. With the hook policy `any`,
  whoever may change a machine's settings in Restow and signed in recently can
  run commands as root on it; prefer `scripts`. Hooks that need namespaces
  (rootless containers) or module loading do not run under the hardened systemd
  service, and restore targets inside a user's home folder are refused. Uploads
  in flight at the same time can exceed a storage budget by a few packs, and a
  machine whose clock runs more than an hour ahead gets its snapshots flagged as
  dated in the future. While endpoints exist, the primary storage target of a
  tenant cannot be replaced (the change is refused with an explanation).
- Endpoint test coverage: the installers ran in a Linux container and, for
  macOS, natively on macOS as a normal user in a relocated root; the systemd
  unit ran under a real systemd only in a privileged container, the LaunchDaemon
  has never run under a real launchd, and the amd64 agent binaries are
  cross-compiled and were not run. Treat the first installation on each platform
  as a pilot.
- Mail files: PST and OST import, PST export and MSG export are planned (MSG
  export needs a writer with a clear permissive license). Calendar and contact
  items in MSG files are not imported. An imported mailbox cannot be deleted
  yet, and neither can the import source while it holds data. The MSG structure
  check protects the reader but is not a full validator: an unusual but harmless
  MSG file it refuses is reported as unreadable (convert it to EML). The parser
  processes need memory of their own (up to 512 MB each for messages up to
  8 MiB, a process of up to 3 GB for a larger one, `IMPORT_PARSE_WORKERS` and
  `PREVIEW_PARSE_WORKERS` of them at a time): a container memory limit below that
  makes large messages unreadable, and if the operating system stops the whole
  container for lack of memory, nothing inside it can help.
- Updater: building from a source repository checks only that the repository
  is on the operator's allowlist and is fetched over https; its code and tags
  are not verified, so allow only repositories you trust as much as the release.
  The signature check runs cosign in a container on the default Docker bridge
  network: a Docker daemon without outbound access for containers, or a registry
  reachable only from the host, makes every image update fail closed
  (`fetch.signature_invalid`); updating by hand still works. The check trusts
  what the project's release workflow signed; a compromise of that workflow or
  of the GitHub repository is outside what it can detect.
- Confirming it is you works in place with a passkey only. With the password
  and authenticator code you sign in again on the sign-in page and repeat the
  change; settings typed but not saved are not kept.
- The setup token is written to the api's container log until the setup is
  complete, so anyone who can read the container logs can complete the setup.
  If container logs are shipped to a central system, set `RESTOW_SETUP_TOKEN`
  instead; it is never logged.
- Sign in with Microsoft (Entra ID) is not available in this release. The
  sign-in side exists, but there is no way yet to link a Restow account to a
  Microsoft identity, so the login page does not offer the button. Leave
  `ENTRA_SSO_CLIENT_ID` and `ENTRA_SSO_CLIENT_SECRET` empty; account linking is
  planned. Everyone signs in with a passkey, or with the password link and an
  authenticator app.
- Deleting a tenant revokes every sign-in to it and marks it as being deleted,
  but no job removes its data in this release: its database rows and its backup
  data on the storage target stay until you delete them yourself.
- The audit log viewer is a Business and Service Provider feature, and the CSV
  and PDF export of the audit log is planned. The archive evidence report exists
  as JSON through the API only. Its `objectLocked` count (also in the archive
  status) counts items that have a retention date, not items whose storage
  enforces Object Lock; do not read it as a statement about WORM.
- The first backup of a large Microsoft 365 tenant can take days because
  Microsoft throttles Graph. Restow shows the wait it is asked to observe
  instead of hiding it.
- The bell's read state belongs to the tenant, not to a person: marking a
  notification read marks it read for everyone in that tenant.
- OAuth2 sign-in for IMAP sources is not implemented yet.
- Menu: the "Soon" entries are placeholders: Jobs in Mail & SaaS and in Servers &
  endpoints come with 0.2.0, Resources with 0.2.1, and pinned entries with 0.2.0.
  Setup is a light wrapper around the existing pages; the tenant page with its
  own tabs (including agent defaults and modules) comes with 0.2.0, and end users
  read the schedules at `/schedules` without a menu entry. "Schedules" keeps its
  name until jobs exist. A machine's page still calls the restic password the
  "repository password" and says "storage target" in that context; it becomes
  the "machine recovery key" in 0.2.0.
- Interface: Firefox ESR 128 and 140 and Safari were not tested (Firefox 155 and
  Chromium 151 were). The focus ring of inputs, selects and buttons has a
  contrast of about 2.6:1 against white in the light theme, below the 3:1 WCAG
  asks for; it changes with the design work of 0.2.0.
- Install script: Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04 only (the
  releases Docker's apt repository serves for amd64 and arm64); on any other
  system install with Docker Compose by hand. In an LXC container it warns and
  runs on a best-effort basis (Docker needs nesting and keyctl there); Docker
  from snap is refused. `--local` serves `https://localhost` or an internal name
  (`*.internal`, `*.home.arpa`, `*.localhost`) with a certificate of Caddy's own
  authority, and passkeys are not offered there.
- Not in scope: SharePoint, Teams, Google Workspace, public folders, eDiscovery
  case management, a mobile app, image or bare-metal backups.

### Verification

Measured on 2026-10-01 on the release candidate (revision `9272693` plus the uncommitted
release changes; the tag commit differs and the release pipeline repeats the smoke on it).
Host: Apple M4, Docker 29.5.2 in a Colima VM (arm64, 4 CPUs, 6 GiB); Node 22.23.3, pnpm
9.15.9, Go 1.27.1, restic 0.19.1, PostgreSQL 16. Images built locally as `0.1.0-dev` for
linux/arm64 only. No Microsoft 365 development tenant was used.

- **Release smoke, full build** (`restow`, `restow-web`, linux/arm64): PASS with gaps, 9 of
  11 checks passed in full. Check 1 partly: install, migrations and image checks passed, the
  upgrade path was not run because no earlier release exists. Check 4 (Microsoft 365)
  skipped: no development tenant credentials. Passed: health, passkey E2E with tenant and
  i18n (26 screens per language), IMAP backup and restore (27 messages equal by SHA-256),
  journal receipt, chain and export, standalone restore (29/29 verified, a damaged copy
  refused), storage targets (S3 with Garage, local path, mounted directory), Trivy and
  `pnpm audit`, endpoint backup (agent install, enroll, backup, restore; 14 files equal by
  SHA-256), mail import and export.
- **Release smoke, Community build** (`restow-community`, `restow-web-community`,
  linux/arm64): PASS with gaps, 7 of 11 in full; check 1 partly (as above); checks 4
  (no tenant credentials), 6 (journal, a Business module) and 8 (needs one tenant per
  target) skipped by design; no license API and a second tenant refused with 403.
- **Test suites:** lint (Biome over 2192 files, the `ee/` import boundary, the former-name
  and package-file guards), typecheck (13 workspaces) and build passed. Vitest: 664 test
  files, 8103 tests, all passed (apps/api 2564, apps/web 2349, packages/core 1822,
  apps/worker 374, ee/api 226, packages/i18n 216, demo seed 169, ee/web 128, packages/db
  111, ee/licensing 59, apps/scheduler 49, packages/cli 32, ee/worker 4); 81 PostgreSQL test
  files with 1001 tests ran, none skipped. Script self-tests 200 and 22 passed.
- **Endpoint agent:** gofmt and `go vet` for linux and darwin on amd64 and arm64, `go test
  -race` (20 packages), the integration tests with restic 0.19.1 and rest-server 0.14.0
  (7), the install tests on Linux (18 checks) and macOS (7) and the systemd test under the
  service's hardening (4) passed. The restic license check matches the 79 vendored Go
  modules to all four restic binaries.
- **Agent release signing:** `agent/release-signing.pub` holds the release key
  (`SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o`). The signed image path was checked
  with a throwaway key: a release signed with the committed key passes; another key, no
  signature, a version mismatch and a release without the license notices are refused.
  The real signature is made offline by the maintainer during the release.
- **Images and dependencies:** no test files or TypeScript sources in any image, `ee/` code
  only in the full images, license files in `/usr/share/doc/restow/`, the license notices
  next to every agent binary. Trivy: 0 critical findings with a fix; 4 critical findings
  without a fix in the Debian base image (perl-base CVE-2026-13221, CVE-2026-42496,
  CVE-2026-8376; zlib1g CVE-2023-45853), 112 high, not gating. `pnpm audit --prod`: no high
  or critical advisory (4 moderate). Licenses: 555 packages allowed, `ee/` 53 without
  copyleft, restic's 79 Go modules with one named exception (golang-lru/v2, MPL-2.0,
  unmodified). gitleaks over a single-commit copy of the tree: no leaks.
- **Migrations:** 20 (0000 to 0019), journal and snapshot chain consistent, no schema drift;
  a second run on a populated database changes nothing (62 tables, 47 with row level
  security).
- **Server install script:** `deploy/install/test.sh` 227 checks passed under bash 3.2
  (macOS) and 226 under bash 5.2/5.3 in the VMs; ShellCheck over 26 scripts and actionlint
  clean. Real installations on arm64 VMs (Lima, 2 vCPU, 4 GiB) with locally built images and
  a simulated release: Debian 12 (interactive install, re-run, non-interactive, every refusal
  and signature-failure case), Debian 13, Ubuntu 24.04 (including the one-liner and the
  distribution's docker.io) and Ubuntu 26.04 (Rust coreutils and sudo-rs) passed; the master
  key shows once and only in the terminal, a re-run changes nothing, a tampered release file
  or an unsigned image is refused and nothing starts, and the setup page answers. One fix came
  out of it: the installer now waits for the apt lock that unattended upgrades hold on a fresh
  VM instead of stopping.
- **Opt-in updater:** the end-to-end test passed 12 of 12 scenarios as a host process and 12
  of 12 in a container (real pull, digest check, dump, rollback, crash loop, failure after
  migrations, killed updater).
- **Not covered:** linux/amd64 (the release pipeline builds and smokes both
  architectures), Microsoft 365 against a real tenant, the upgrade path from an earlier
  release, the agent signed with the real key (done by the maintainer in the release run),
  the updater against two builds of the real published image, and the install script on
  amd64, on Ubuntu 22.04, in a real Proxmox LXC and against the real signed release (checked
  on release day before the announcement).

The release pipeline repeats the smoke run for both builds on amd64 and arm64
from the tagged commit before it publishes, and attaches the smoke reports
(`smoke-report.md`, `smoke-report-arm64.md`, `smoke-report-community.md`,
`smoke-report-community-arm64.md`) to the release.
