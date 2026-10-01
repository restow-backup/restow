# Restow

**Restow. Backup you can prove is restorable.**

Self-hosted backup and archive for Microsoft 365 and IMAP, with endpoint backup
for Linux and macOS. Restow backs up Exchange Online mail, calendars and
contacts, OneDrive, any IMAP mailbox and your servers and clients to storage you
control, and every week reads a sample of each backup back through the restore
path and compares it with the recorded hashes. A backup only counts as
restorable once it has been read back.

**Status: beta (0.1.0), the first public release.** Run it alongside your
existing backups, not as your only one, until you have verified restores
against your own data. Microsoft 365 backup and restore have been tested
against a simulated Graph API, never against a real Microsoft 365 tenant. What
works and what does not yet is in [CHANGELOG.md](CHANGELOG.md), especially its
Known Issues.

[Website](https://restowbackup.com) · [Documentation](https://docs.restowbackup.com) ·
[Live demo](https://demo.restowbackup.com) · [Changelog](CHANGELOG.md) ·
[Updating](docs/UPDATING.md)

![Overview across all tenants](docs/images/screenshots/overview.png)

## What it does

- **Backup** of Exchange Online (mail, calendar, contacts) and OneDrive through
  Microsoft Graph, incremental via delta queries, and of any IMAP mailbox.
  Graph is the only Microsoft interface Restow uses; Exchange Web Services, which
  Microsoft switched off for Exchange Online on 1 October 2026, are not.
- **Endpoint backup** of servers and clients with the Restow agent and restic:
  Linux and macOS agents (Windows is planned), installed root-owned and updated
  only with releases the maintainer signed, append-only so an agent can add
  backups but never delete or overwrite one, with retention decided by the
  server and a storage budget per machine and per tenant. Hooks run only where
  root on the machine allowed them. Restores go into a new folder, never over
  existing files. Included in the Community edition.
- **Restore** of a single mail, a folder, a file, a file version or a whole
  account, next to the original, never over it; or as a ZIP download. People
  with the role "user" restore only their own mailbox and OneDrive.
- **Restore checks:** every week a sample of every backup is read back through
  the restore path and compared with the recorded hashes; the result is shown
  per mailbox, OneDrive and machine as recovery readiness. The checks do not
  restore into a Microsoft 365 or IMAP target.
- **Archive:** Exchange Online journal mail (Business and Service Provider) and
  imported mail files go into an append-only store with a SHA-256 hash chain,
  chain verification and search over subject, extracted text and addresses (not
  attachments). Business adds enforced retention (fixed at 8 years in 0.1.0) and
  legal hold, designed for GoBD-compliant use (not certified). Continuous
  IMAP and Graph archive sync are not part of 0.1.0. On local, NFS and SMB
  targets the archive's immutability is enforced by the application only, and on
  S3 with Object Lock 0.1.0 locks the archive item records but not the packs
  that hold the message content; see Known Issues in the changelog.
- **Import and export of mail files:** bring a legacy mailbox in from EML, MSG, MBOX,
  ZIP or a MailStore export folder (chunked, resumable, encrypted upload or a
  server-side import folder), browse and restore it like any mailbox, and optionally
  archive it. Export backed-up, imported or archived mail as EML in a ZIP or as MBOX,
  with checksums and an expiring download link.
- **Encryption:** AES-256-GCM per chunk with a separate key per tenant, before
  anything leaves the server. Deduplication stays within a tenant. One master key
  (`RESTOW_MASTER_KEY`) wraps every tenant key: whoever holds it and can read the
  storage can decrypt it, so keep it offline and apart from the storage.
- **Storage you choose:** local disk, S3-compatible object storage, NFS or SMB,
  with a copy target next to the primary, promotion of a copy and replacement of
  the primary without losing access to existing backups.
- **Multi-tenant** for IT service providers (Service Provider edition), with a
  REST API (OpenAPI) and webhooks for RMM and PSA tools. The other editions run
  one organisation.
- **Alerts and reports:** rules that send an e-mail, a bell entry or a signed
  webhook when a backup fails or a restore check does not pass, and (Business)
  a daily, weekly or monthly summary report, with a delivery log. The Overview,
  with its tabs Status and Statistics (CSV and PDF), shows the state at a
  glance.
- **Audit log:** reads and restores of user data and administrative changes are
  recorded in a hash-chained, tamper-evident log in every edition and sealed
  daily. The viewer, with filter and chain verification, is a Business feature.
- **Standalone restore:** `restow-restore` restores from the chunk store and the
  keys alone, without a running Restow server or database.

Not included in 0.1.0: PST and OST import, PST and MSG export, a Windows agent,
continuous IMAP and Graph archive sync, SharePoint, Teams, Google Workspace and
public folders. The first backup of a large tenant can take days because
Microsoft throttles Graph; Restow shows that wait instead of hiding it.

## Screenshots

From the public demo, which runs the Service Provider edition with synthetic data
(the audit log viewer and the team page are Business and Service Provider
features), unretouched.

| | |
| --- | --- |
| ![Restore explorer](docs/images/screenshots/restore-explorer.png) | ![Recovery readiness](docs/images/screenshots/recovery-readiness.png) |
| Restore explorer: browse a restore point, preview a mail, restore or download. | Recovery readiness: the latest restore check per mailbox and OneDrive. |
| ![Statistics](docs/images/screenshots/statistics.png) | ![Audit log](docs/images/screenshots/audit-log.png) |
| Overview, Statistics tab: backups, restores, storage growth and checks over 30 days. | Audit log (Business and Service Provider): who did what, when, for whom; the chain is verifiable. |
| ![Alerts](docs/images/screenshots/alerts-and-reports.png) | ![Team](docs/images/screenshots/team.png) |
| Alerts: who is told what, and when, by e-mail, bell or webhook, and scheduled reports. | Team (Business and Service Provider): several administrators with roles and, with Service Provider, chosen tenants. |

## How Restow is built

Restow is built by Lucas Flores, an IT systems engineer with 15 years of
experience in IT and the owner of a small managed service provider in
Bergisch Gladbach, Germany. He is an engineer, not a professional software
developer.

A large part of the code is written with AI assistance (Claude Code), steered
by that technical background: Exchange, Microsoft Graph, storage and running
backups for customers every day. For a backup product that is a real risk,
and it is treated as one:

- A feature is not done until its restore is tested automatically. The
  repository has more than 7,000 automated tests (Vitest across all packages and
  Go tests for the agent), including suites that run against a real PostgreSQL
  with Row Level Security, and restore tests that compare byte for byte. None of
  them has run against a real Microsoft 365 tenant yet.
- The release checklist requires a smoke check before a version is tagged (image build,
  migrations on a fresh and an upgraded database, backup and restore against a
  test tenant and a test IMAP server, standalone restore, image and dependency
  scans). The report is attached to every release; where a check was skipped, it
  says so.
- The storage format is open and documented ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  in German), so your data never depends on Restow or its author.

## Tech stack

| Part | Technology |
| --- | --- |
| Language | TypeScript on Node.js 22, one pnpm monorepo |
| API | Hono, OpenAPI for the integration API |
| Authentication | better-auth: passkeys (WebAuthn), authenticator app (TOTP), organizations for tenants (sign-in with Microsoft is planned) |
| Web interface | React 19, Vite, TanStack Router and Query, shadcn/ui, Tailwind CSS v4, i18next (German and English) |
| Jobs | Separate worker and scheduler processes on pg-boss (queue in PostgreSQL, no Redis) |
| Database | PostgreSQL 16 with Row Level Security per tenant, Drizzle ORM and migrations |
| Microsoft 365 | Microsoft Graph only (delta queries, own throttling layer), MSAL for app authentication |
| IMAP and SMTP | imapflow, mailparser, smtp-server for journal receipt |
| Endpoint agent | Go with the standard library only, driving restic; Linux and macOS |
| Storage | Own chunk store: content-defined chunking, SHA-256, AES-256-GCM, pack files; local disk, S3-compatible, NFS, SMB |
| Delivery | Two builds of every release (full and Community), each an application image with the roles api, worker and scheduler (plus the optional, opt-in updater) and a web image with Caddy for TLS and the web interface; Docker Compose |
| Tests and checks | Vitest, Playwright, Go tests, Biome, TypeScript strict, gitleaks, `pnpm audit`, Trivy |

## Quickstart

### Platform recommendations

Run Restow on a **dedicated Linux VM**: Debian 12 or 13, or Ubuntu 22.04, 24.04
or 26.04, on amd64 or arm64, with at least 4 GiB of memory (8 GiB recommended)
and at least 10 GiB free for Docker. Put that VM on **other hardware than the
systems it backs up**: a backup that fails together with the host it protects
is no backup. Keep the backups **off-site** as well, preferably on
S3-compatible object storage with Object Lock; the default target, a Docker
volume on the VM itself, is meant for a first test. LXC containers work on a
best-effort basis only (Docker needs nesting and keyctl there, and some hosts
still break it). Running Restow natively, without Docker, is not supported.

For a public installation you need a domain whose A/AAAA record points at the
server, with ports 80 and 443 reachable from the internet; Caddy obtains the
TLS certificate from Let's Encrypt.

### Install with the script (recommended)

Every release carries `install.sh`, which sets up the release stack on such a
VM in `/opt/restow`. It checks the machine (operating system, architecture,
virtualization, memory, disk, ports 80 and 443, outbound HTTPS, clock, the
domain's DNS record, an earlier installation), installs Docker Engine and the
Compose plugin from Docker's signed apt repository if Docker is missing,
downloads `docker-compose.yml` and `env.example` of the release and checks them
against the release's signed `SHA256SUMS`, writes `.env` (mode 0600) with
freshly generated secrets, checks the cosign signatures of the two images and
starts the stack. Download it, check it, then run it:

```sh
curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.1.0/install.sh
curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.1.0/install.sh.sha256
sha256sum -c install.sh.sha256
sudo bash install.sh
```

It asks for the domain and the build (full or Community, see step 2 below),
shows its plan, and before it starts the stack shows `RESTOW_MASTER_KEY` once:
**store it offline then**, it is never shown again and not written to the log.
At the end it prints the setup URL; the setup wizard asks for the one-time
setup token, which you read on the server with
`cd /opt/restow && sudo docker compose logs api | grep 'SETUP TOKEN'`.

`install.sh.sha256` only proves that the download is complete. To check that
the script is the one the release workflow published, verify the signed
checksum list with [cosign](https://docs.sigstore.dev/cosign/) first:

```sh
curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.1.0/SHA256SUMS
curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.1.0/SHA256SUMS.sigstore.json
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum -c --ignore-missing SHA256SUMS
```

For an unattended installation pass the answers as options; the master key is
then not shown, so copy it from `/opt/restow/.env` to an offline place right
away:

```sh
sudo bash install.sh --non-interactive --domain backup.example.com --edition community
```

`bash install.sh --help` lists every option and the exit codes: `--domain`,
`--edition full|community` (default full), `--version`, `--dir` (default
`/opt/restow`), `--yes` or `--non-interactive`, `--with-updater` (the opt-in
updater stays off unless you ask for it, see [docs/UPDATING.md](docs/UPDATING.md)),
`--local` (an evaluation without a public domain: the edge serves
`https://localhost` or an internal name such as `restow.internal` over HTTPS
with a certificate from Caddy's own authority, browsers warn about it and
passkeys are not offered; `--http-local` is a deprecated name for it),
`--dry-run` (checks only, prints what it would do) and `--skip-signature-check`
(for tests and unsigned mirrors only, never for production). Its log is
`/var/log/restow-install.log`, without secrets.

Running the script again is safe: it finds the installation, never changes
`.env`, a secret or data, checks the images named in `.env` and makes sure the
stack runs. It refuses to start when Docker holds data of an earlier
installation without its `.env`. It never updates an installation (see
[Updating](#updating)) and has no uninstall (see
[Removing Restow](#removing-restow)).

As a shortcut, the script also runs straight from the download:

```sh
curl -fsSL https://github.com/restow-backup/restow/releases/download/v0.1.0/install.sh | sudo bash
```

That runs whatever arrives without your own check of the script first. It still
checks the signatures of everything it downloads afterwards, but prefer the
steps above on a production server.

### Install by hand with Docker Compose

On any Linux host with Docker and Docker Compose v2 (the steps the script
automates). For a local evaluation on your own machine, see the note after
step 2.

1. **Get the release stack.** It runs the published, signed images and builds
   nothing. Download `docker-compose.yml` and `env.example` from the
   [release assets](https://github.com/restow-backup/restow/releases/tag/v0.1.0)
   into an empty directory and run `cp env.example .env`, or clone the tag and
   work in `deploy/release/`:

   ```sh
   git clone --branch v0.1.0 https://github.com/restow-backup/restow.git
   cd restow/deploy/release
   cp .env.example .env
   ```

2. **Fill in `.env`.** The comments in the file say how; the sections marked
   optional can stay empty. At minimum the two images of one build, either the
   full build (`RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0`,
   `RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.1.0`; Business and
   Service Provider stay locked until a license key is installed) or the
   Community build (`ghcr.io/restow-backup/restow-community:0.1.0`,
   `ghcr.io/restow-backup/restow-web-community:0.1.0`; the Apache-2.0 core
   alone), then `POSTGRES_PASSWORD`, the three database connection strings
   (`DATABASE_MIGRATION_URL`, `DATABASE_URL`, `DATABASE_PROVIDER_URL`),
   `RESTOW_MASTER_KEY`, `BETTER_AUTH_SECRET`, `RESTOW_PUBLIC_URL` and
   `RESTOW_APP_DOMAIN` (the compose file refuses to start without it). Generate
   secrets with:

   ```sh
   openssl rand -base64 32   # RESTOW_MASTER_KEY, BETTER_AUTH_SECRET
   openssl rand -hex 16      # each database password
   ```

   **Back up `RESTOW_MASTER_KEY` offline before the first real backup.** It
   wraps every tenant's key; without it no backup can ever be read again.

   *Local evaluation:* set `RESTOW_APP_DOMAIN=localhost` and
   `RESTOW_PUBLIC_URL=https://localhost`. Caddy then serves `https://localhost`
   with a certificate from its own local certificate authority, so your browser
   shows a warning until you trust it, and ports 80 and 443 on the machine must
   be free. Choose the local operating mode in the setup wizard; passkeys are
   not offered there, so the first administrator signs in with a password and
   an authenticator app.

3. **Start the stack**

   ```sh
   docker compose up -d
   ```

   This pulls the images and starts PostgreSQL, the three Restow roles and
   Caddy. The `api` container applies the database migrations before it serves.

4. **Check it and open the setup wizard**

   ```sh
   curl -fsS http://127.0.0.1:3000/healthz
   ```

   Open `RESTOW_PUBLIC_URL` in a browser. The setup wizard first asks for the
   one-time setup token, which only someone with access to the server can
   read: the `api` container prints it to its log at every start until the
   setup is complete.

   ```sh
   docker compose logs api | grep 'SETUP TOKEN'
   ```

   Then it shows the operator notice, chooses the operating mode, creates the
   first administrator (passkey first) and sets up notification mail. Then add
   a Microsoft 365 tenant or an IMAP mailbox as a source. For an unattended
   installation, set `RESTOW_SETUP_TOKEN` in `.env` instead (see
   `.env.example`).

To build the images from source instead of pulling them, see
[CONTRIBUTING.md](CONTRIBUTING.md). The release images can be verified with
cosign; see [deploy/release](deploy/release/README.md). The operator guides, including the
Entra app registration for Microsoft 365, are in the
[documentation](https://docs.restowbackup.com/administrators/get-started/); the
release pipeline and its smoke checks are described in [docs/CI.md](docs/CI.md).

## Removing Restow

The install script has no uninstall on purpose: removing an installation can
destroy backups. To remove one by hand, in its directory (`/opt/restow` for an
installation made by the script):

```sh
cd /opt/restow
sudo docker compose --profile updater down
```

This stops and removes the containers. The database, the local chunk store,
Caddy's certificates and the updater's database dumps stay in their Docker
volumes (`restow_pgdata`, `restow_restow-data`, `restow_caddy-data`, ...), and
`.env` stays in place. Only when you are sure that no backup in them is still
needed:

```sh
sudo docker compose --profile updater down --volumes   # deletes the database and the local chunk store
cd / && sudo rm -r /opt/restow                          # .env holds RESTOW_MASTER_KEY
```

Keep an offline copy of `RESTOW_MASTER_KEY` as long as backups on other
storage (S3, NFS, SMB) may still be needed: `restow-restore` reads them with the
key alone. Those backups are not deleted by the steps above; remove them in the
storage itself. Docker stays installed.

## Updating

The Upgrade Notes of every release state whether the update needs only a new
image, runs database migrations (automatically, at start) or needs manual steps,
how long it takes and how to roll back. The steps, the backup before the update
and the rollback are in [docs/UPDATING.md](docs/UPDATING.md); release notes
follow [docs/releases/TEMPLATE.md](docs/releases/TEMPLATE.md). Internal builds
before 0.1.0 cannot be upgraded; see Breaking Changes in the changelog.

## Recovering administrator access

If the last owner of an installation has lost their passkey, authenticator app
or password, recover the access on the server, in the `api` container:

```sh
docker compose exec api restow admin list
docker compose exec api restow admin recover --email owner@example.com
```

`admin recover` asks for confirmation and for a new password, then removes the
owner's authenticator app and passkeys and ends all their sessions. The owner
signs in with the new password and sets up an authenticator app again before
anything else. The recovery is recorded in the audit log. It works for owners
only; an owner resets every other administrator in the web interface.
`docker compose exec api restow help` lists the options.

## Editions

All editions are self-hosted, have no mailbox limit and never limit restore.

| Edition | For | Price |
| --- | --- | --- |
| **Community** | One organisation: every backup source and restore function, endpoint backup, mail import and export, the archive (search, hash chain), alerts, dashboard and statistics, the REST API, tenant members with self-service restore. One provider administrator. Apache-2.0, no license key. | Free |
| **Business** | Adds the provider team (several administrators with roles), the archive's GoBD layer (journal receiver, enforced retention, legal hold), scheduled summary reports and the audit log viewer. CSV and PDF export of the audit log is planned. Still one organisation. | One-time purchase |
| **Service Provider** | Adds multiple tenants, team members limited to chosen tenants, the cross-tenant API and the provider dashboard. | One-time purchase |

Every release comes in two builds. The full images (`restow`, `restow-web`)
contain the Business and Service Provider modules, which an offline-verified
license key (Ed25519, no phone-home) unlocks at runtime under Admin › License;
without a key they run as Community. The Community images (`restow-community`,
`restow-web-community`) contain the Apache-2.0 core alone and no license
screen. Both use the same database, so you can switch by changing the two image
lines in `.env`. Mailbox and tenant counts are an honour rule of the license
terms, not a limit in the software. Prices and terms:
[restowbackup.com](https://restowbackup.com).

## Development

Building from source, running the development servers and the checks are
described in [CONTRIBUTING.md](CONTRIBUTING.md).

Documentation lives in two places. The operator guides are at
[docs.restowbackup.com](https://docs.restowbackup.com). The files in [docs/](docs/)
are for maintainers and contributors: the design documents
[ARCHITECTURE](docs/ARCHITECTURE.md), [STACK](docs/STACK.md),
[MICROSOFT](docs/MICROSOFT.md), [IMAP](docs/IMAP.md), [ARCHIVE](docs/ARCHIVE.md),
[IMPORT](docs/IMPORT.md), [AGENT](docs/AGENT.md), [ENTRA-SETUP](docs/ENTRA-SETUP.md)
and [TESTING](docs/TESTING.md) are written in German; [STORAGE](docs/STORAGE.md),
[UPDATING](docs/UPDATING.md) and [CI](docs/CI.md) are in English. Code, commits,
this README, the changelog and the public documentation are in English.

## Contributing and security

- Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md).
  A contributor license agreement ([CLA.md](CLA.md)) is required before the
  first pull request is merged.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
  never in a public issue.

## License

The Restow core is published on GitHub under the [Apache License 2.0](LICENSE).
The Business and Service Provider modules in `ee/` are licensed under the
[Restow license terms](https://restowbackup.com/en/license-terms/).

Made by [IT Systeme Flores UG (haftungsbeschränkt)](https://it-flores.de),
Bergisch Gladbach, Germany.
