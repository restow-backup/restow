# Changelog

All notable changes to Restow are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Restow uses SemVer
from 1.0.0; before that, this file starts fresh at 0.1.0, the first public
release. Earlier internal iterations (0.300.0 to 0.304.0) built the features
this release describes but were never published and cannot be upgraded to this
release (see Breaking Changes); their history stays in the maintainer's
private repository.

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
