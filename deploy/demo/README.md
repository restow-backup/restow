# Restow public demo (demo.restowbackup.com)

A separate, self-resetting Restow installation for a public live demo. It is
**not** the product's own Docker Compose stack (the repository root
`docker-compose.yml`): it is a smaller, isolated compose project that only
ever talks to a synthetic Dovecot mailbox, never to Microsoft 365, never to
the internet beyond its own public web port, and never keeps anything a
visitor does past the next nightly reset.

Read this file fully before running anything here, especially "Isolation"
and "Resource limits".

## What it is

- `RESTOW_DEMO=true` (apps/api `middleware/demo-guard.ts`) makes the
  installation read-only for everyone but the seed process: browsing,
  search, downloads, exports, the audit log, "Back up now", "Verify now",
  restoring a snapshot as a **download**, and browsing a simulated machine's
  snapshots and downloading its files as a ZIP all work; creating or changing a
  source, an IMAP host, the Microsoft 365 app registration, storage
  targets, mail transport, webhooks, API keys, the licence, users, members,
  invitations, tenants, settings, restoring back into the mailbox itself,
  and everything that would change a simulated machine (enrolling one,
  restoring onto it, its settings, a restore test, revealing its repository
  password), do not, whoever asks (a restore into the mailbox would grow what
  the next backup picks up, without bound — download is the only target
  demo mode offers).
- The demo account (`RESTOW_DEMO_EMAIL` / `RESTOW_DEMO_PASSWORD`) signs in
  with email and password alone, no TOTP enrolment, no passkey — the one
  exception to Restow's otherwise mandatory second factor
  (apps/api `lib/session-assurance.ts`). The login page shows the
  credentials and offers a one-click sign-in. That exception is strictly
  scoped: it applies only to that one account, only while `RESTOW_DEMO=true`
  (the server refuses to start if the credentials are set without it,
  config.ts `demoConfigConflict`), and every other account keeps full
  enforcement.
- The interface starts in English for every visitor, whatever language the
  browser prefers, so nobody has to find the language switcher first; a
  language the visitor picks in the language menu sticks from then on
  (apps/web `i18n.ts`, `applyDemoLanguage`).
- Two fictional tenants ("Example Trading Ltd", "Birchwood Consulting Ltd")
  each own one or two IMAP sources pointing at the demo's own Dovecot
  container, seeded with a few hundred synthetic invoices, orders,
  newsletters, calendar invites and everyday mail spread over the last ten
  years (`deploy/demo/seed`). No Microsoft 365 access exists in this
  deployment at all.
- Two **simulated machines** with real backups (see "Simulated machines"):
  a Linux file server (`fileserver-01`, Example Trading Ltd) and a MacBook
  (`laptop-jdoe`, Birchwood Consulting Ltd). No agent runs and no machine
  exists: the seed plays the Restow agent, writes made-up files and backs them
  up with real restic through the real agent API, one snapshot per simulated
  day for the last month. Everything about them is synthetic: the machines,
  their files, their names and the history.
- A **mail archive** with synthetic mail for one mailbox per tenant
  (`accounting@` and `sales@`), filled through the mail file import with
  archiving switched on, not by a sync (see "The mail archive").
- The demo shows the Service Provider edition without a license key: the
  demo runs the full images (the Business and Service Provider modules under
  `ee/` included) with `RESTOW_EDITION=service_provider` (see "Edition").
- Everything resets every night at 03:00 Europe/Berlin
  (`deploy/demo/systemd`, `deploy/demo/reset.sh`): the whole compose
  project, including its volumes, is torn down and rebuilt from scratch,
  reseeded, and only then republished (see "Reset").
- No visitor IP address is ever stored: demo mode disables better-auth's own
  IP tracking outright (`apps/api auth.ts`, `advanced.ipAddress.
  disableIpTracking`) and `lib/request.ts` `clientIp`/`clientIpOf` — the one
  place every audited action's IP comes from — always answers null while
  `RESTOW_DEMO=true`. The one place visitor IPs are visible to each other at
  all, better-auth's session list/revoke endpoints, is refused outright by
  the demo guard, in demo mode, regardless of method (security review
  finding 2).

## Isolation

This is the part that must not be gotten wrong.

- `api`, `worker`, `scheduler`, `postgres` and `dovecot` sit on `internal`,
  a Docker network created with `internal: true` — no default route to the
  internet, and not reachable from any other compose project on the host.
- Only `web` (Caddy: the built SPA plus the `/api` reverse proxy) is
  reachable, and even `web` publishes **only on the Docker bridge gateway
  address by default** (`172.17.0.1:8081`, `RESTOW_DEMO_BIND_ADDRESS` /
  `RESTOW_DEMO_BIND_PORT`; security review finding 7): an address the host
  itself and its containers use, not a public interface, so it is safe to
  bring up on any host, including a shared/production one. It is never
  bound to `0.0.0.0` — `reset.sh` refuses a wildcard address. Publishing
  80/443 publicly is an explicit opt-in for a dedicated demo VM
  (`docker-compose.override.public.yml`, "Option A" below); the co-hosted
  variant ("Option B") uses the safe default as-is. Caddy itself keeps a
  route out only for ACME (automatic HTTPS) on its own VM; the co-hosted
  variant does not even need that (`RESTOW_DEMO_APP_DOMAIN=:80`, no
  certificate, no egress required for TLS at all).
- Nothing is ever built on the host that runs the demo. Every image comes
  prebuilt from `deploy/demo/build-images.sh` (see "Images"); the compose
  file has no `build:` section, and `reset.sh` only starts what is already
  loaded.
- The demo guard (`apps/api middleware/demo-guard.ts`) is the single place
  that decides what a request may change; see its own doc comment and
  `apps/api/src/lib/demo.ts` for the exact allowlist and denylist.
- The seed process (`deploy/demo/seed`) is the only thing that may create
  the demo tenants, sources and schedules. Its bootstrap calls carry
  `X-Restow-Demo-Seed-Token` (`RESTOW_DEMO_SEED_TOKEN`), a secret only the
  seed container and the api container know; a public visitor never sees or
  can reach it (it never crosses the `web` container). `POST /api/v1/setup`
  is not on the public allowlist even with that token (security review
  finding 1): `routes/setup.ts` additionally refuses any admin but the one
  matching `RESTOW_DEMO_EMAIL`/`RESTOW_DEMO_PASSWORD`, so the token alone
  could never be used to install a different account.
- The agent API (`/agent/v1/*`) and the restic REST backend
  (`/agent/restic/*`) are writes like any other for the demo guard: only a
  request that carries the seed token passes, a visitor is refused (the
  Caddy edge forwards the paths, the guard answers `demo-read-only`;
  `middleware/demo-guard.test.ts` and `app.demo-guard.test.ts` pin it). The
  seed reaches them directly on `http://api:3000`, never through `web`.
  The only other thing that holds the token is the `agent-sim` sidecar.
- Webhook delivery and outbound notification mail are no-ops in demo mode
  (`apps/worker handlers/webhooks.ts`, `apps/api notify.ts`) — a second,
  independent line of defence on top of the demo guard already refusing to
  create a webhook or change the mail transport.
- No Microsoft 365 / Entra credentials are configured anywhere in this
  compose project. `ENTRA_*` variables are simply absent from
  `deploy/demo/.env.example`.

## Resource limits (security review finding 3)

A public demo must not be a way to fill a shared host's disk or starve its
CPU/memory, whether co-hosted or not:

- **One job at a time per tenant.** Demo mode refuses a second queued or
  running backup, verification or restore for a tenant that already has one
  in flight (`apps/api lib/demo-limits.ts`). The automatic first backup
  Restow queues the moment a mailbox becomes protected
  (`apps/api features/jobs/service.ts` `enqueueFirstBackups`) follows the
  same rule: while another backup of the tenant is queued or running it
  queues nothing and logs why, instead of failing the change that protected
  the mailbox. Only the seed ever reaches that path here, since the demo
  guard refuses every protection change and account import from a visitor.
- **Restore is download-only** (see "What it is" above) — the only way a
  restore could grow the mailbox, and so the next backup, is closed off
  entirely.
- **A per-request and a daily restore cap.** A single restore is capped at
  500 MB; the installation as a whole is capped at 2 GB and 20,000 items per
  UTC day (in-memory counters — they reset with the nightly restart anyway).
- **A per-visitor-IP rate limit** on "Back up now" / "Verify now" / restore
  (10 requests/minute per IP, in memory only — that IP is never written to
  the database or logs, unlike `clientIp`, which stays null throughout; see
  `apps/api lib/demo-rate-limit.ts`).
- **A hard, enforced disk cap**, not just a soft quota: `demo-data` (the
  chunk store) and `demo-mail` (Dovecot's Maildir) are tmpfs volumes with a
  `size=` cap (4 GB / 1 GB respectively, `docker-compose.yml`) — a write
  past the cap fails cleanly (ENOSPC) instead of filling the host. Both are
  fully reproducible by the seed and reset nightly anyway, so RAM-backed,
  capped storage is a better fit here than a host-filesystem quota. Postgres
  stays on a real (disk-backed) volume; if you also want a filesystem-level
  quota under it, put `demo-pgdata`'s Docker data root on its own sized
  partition or LVM volume — outside the scope of this compose file.
- **CPU/memory limits on every container** (`deploy.resources.limits` in
  `docker-compose.yml`), sized for the demo's small, fixed workload.

## Images

`deploy/demo/build-images.sh` runs on a workstation or CI runner, never on
the demo host. It builds, with `docker buildx build --platform linux/amd64
--load`:

| Image (default tag) | Built from | Used by |
| --- | --- | --- |
| `restow-demo-app:local` | repository `Dockerfile`, target `runtime` | `api`, `worker`, `scheduler` |
| `restow-demo-web:local` | repository `Dockerfile`, target `web` | `web` |
| `restow-demo-seed:local` | repository `Dockerfile`, target `demo-seed` | `seed`, `agent-sim` |
| `restow-demo-dovecot:local` | `deploy/demo/dovecot` | `dovecot` |

and saves all four to one gzipped tarball in `deploy/demo/images/`
(gitignored), named after the version, the git commit (with `-dirty` when
built from uncommitted changes) and the platform, next to a `.sha256` file
in `sha256sum -c` format. `postgres:16-alpine` is the only image the host
pulls itself (`docker pull postgres:16-alpine`; a production host already
has it).

The seed image is the repository's `build` stage (the workspace, so the seed
runs from its compiled TypeScript) plus the very restic the product ships: the
`demo-seed` target copies the binary the agent build stage fetched at the
version pinned in `agent/tools.env`, after checking its SHA-256 for the
image's architecture, the same file the `runtime` image links as
`/usr/local/bin/restic`. Nothing is downloaded when the seed runs: the demo's
internal network has no route out.

The first two are built from the same repository `Dockerfile` targets as
the product images (`runtime`/`web`), but default to their own, demo-only
tags — deliberately **not** `restow:local`/`restow-web:local`, the tags the
repository root `docker-compose.yml` runs (security review finding M2): on
a host that also runs production, `docker load` of this tarball must never
re-tag, and so on its next `docker compose up -d`, silently recreate, that
host's production containers from a demo build, which may be from an
unreleased commit or a `-dirty` working tree, and whose api image runs
migrations automatically on start. Reusing the exact production images is
an explicit opt-in, not the default: set `RESTOW_DEMO_APP_IMAGE=restow:local`
and `RESTOW_DEMO_WEB_IMAGE=restow-web:local` (both when running
`build-images.sh` and in `deploy/demo/.env` on the host) only when they are
built from the exact release production runs. `RESTOW_DEMO_SEED_IMAGE` and
`RESTOW_DEMO_DOVECOT_IMAGE` can be renamed the same way if their defaults
ever collide with something else on the host. When the host already has the
product images of the right release, `build-images.sh --skip-app-images`
builds and ships only the seed and Dovecot images.

On the host, in the directory the two files were copied to:

```sh
sha256sum -c restow-demo-images-<version>-<commit>-linux-amd64.tar.gz.sha256
docker load -i restow-demo-images-<version>-<commit>-linux-amd64.tar.gz
/opt/restow-demo/deploy/demo/reset.sh
```

`reset.sh` checks that every image the compose project needs is present
before it stops anything, so an incomplete image transfer never takes a
running demo offline.

## Running it

### Option A — its own small VM (recommended)

Sizing: 2 vCPU, 4 GB RAM, 20 GB disk is comfortable for the demo's data
volume (a handful of mailboxes, a few hundred small messages, one small
Postgres database). A single European or US region close to your visitors
is fine; nothing here needs to scale.

Firewall:

- inbound 22 (SSH) from your admin IP(s) only;
- inbound 80/443 from anywhere (Caddy's automatic HTTPS and the demo
  itself);
- outbound: only what Caddy needs for ACME (Let's Encrypt) and what apt/apk
  need for OS and image updates. Nothing else needs to leave this host —
  the demo never calls Microsoft 365, never sends real mail, never delivers
  a webhook.

DNS: point `demo.restowbackup.com` (or whatever hostname you choose) at the
VM's public IP (A/AAAA record). Caddy obtains its own certificate on first
start once DNS resolves and 80/443 are reachable.

Setup:

```sh
git clone <this repository> /opt/restow-demo
cd /opt/restow-demo/deploy/demo
cp .env.example .env
"$EDITOR" .env
# RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml:docker-compose.override.public.yml
./reset.sh
```

Load the images first (see "Images"). `reset.sh` brings up everything
except `web` from them, runs the seed, and only then publishes `web` (see
"Reset"). Then install the nightly schedule (see "Reset" below).

### Option B — co-hosted on the production host, temporarily

Only when a dedicated VM is not yet available. The demo compose project
keeps its own isolated `internal` Docker network (never the production
stack's network). Its `web` container publishes on the Docker bridge
gateway address only (`172.17.0.1:8081` by default, the
`docker-compose.yml` default — no override needed for this variant), and
the production Caddy reverse-proxies to it through `host.docker.internal`,
without any Docker network shared between the two projects.

```sh
cd /opt/restow-demo/deploy/demo   # a checkout of this repository
cp .env.example .env
"$EDITOR" .env
# RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml   (the default — no public override)
# RESTOW_DEMO_APP_DOMAIN=:80          (plain HTTP inside the container; no ACME, no TLS here at all)
# RESTOW_PUBLIC_URL=https://demo.restowbackup.com   (still the real public URL)
# RESTOW_DEMO_BIND_ADDRESS=172.17.0.1 (the host's docker0 gateway; the default)
# RESTOW_DEMO_BIND_PORT=8081          (the default; must match demo.caddy below)
./reset.sh                          # after loading the images, see "Images"
```

`172.17.0.1` is the gateway of Docker's default `bridge` network (`docker0`)
on a standard Linux host. If the daemon uses a different subnet, take the
address from
`docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'`.
It must also be what `host-gateway` resolves to, which is the default
unless the daemon sets `host-gateway-ip`.

On the **production** side, everything needed is in the repository and off
by default (it needs the production `restow-web` image of this release or
later, whose built-in Caddyfile has the import line):

- the root `Caddyfile` imports `/etc/caddy/sites/*.caddy`, and the root
  `docker-compose.yml` mounts `deploy/caddy-sites/` there (read-only). That
  directory ships without any `*.caddy` file, so nothing is served until an
  operator adds one (`deploy/caddy-sites/README.md`);
- the production `caddy` service maps `host.docker.internal` to the host
  gateway (`extra_hosts: host.docker.internal:host-gateway`);
- `deploy/caddy-sites/demo.caddy.example` is the demo's site block:
  `reverse_proxy host.docker.internal:8081` with
  `header_up X-Forwarded-For {remote_host}`.

Enabling the demo on the production edge is one deliberate, reviewed step,
never a side effect of a demo change:

```sh
cd /opt/restow   # the production checkout
cp deploy/caddy-sites/demo.caddy.example deploy/caddy-sites/demo.caddy
"$EDITOR" deploy/caddy-sites/demo.caddy   # hostname, and the port if RESTOW_DEMO_BIND_PORT is not 8081
docker compose up -d caddy                # once, so the new mount and extra_hosts apply
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Delete `deploy/caddy-sites/demo.caddy` and reload to take the demo off the
edge again. Real TLS for `demo.restowbackup.com` is terminated by the
**production** Caddy; the demo's own Caddy never attempts a certificate in
this variant (`RESTOW_DEMO_APP_DOMAIN=:80`).

#### Visitor addresses

The production Caddy sets `X-Forwarded-For` to the visitor's address
(`header_up X-Forwarded-For {remote_host}`; a client-supplied value never
passes). The demo's own Caddy keeps that header instead of replacing it
with the address it sees the connection from, because its web service sets
`RESTOW_EDGE_TRUSTED_PROXIES=private_ranges` (the root `Caddyfile` reads it;
it defaults to loopback only, so production is unaffected). That is safe
here: in this variant the demo's port is published only on the Docker
bridge, which the host and its own containers use, and on a dedicated VM
public clients connect directly and are never trusted. (A machine that
could route private addresses to this host, such as a neighbour on the same
private network, could also connect from a private address and set its own
header; at worst that gives it a fresh rate-limit budget, which the
per-tenant one-job-at-a-time limit still caps.) The demo guard's per-visitor rate limit on "Back up
now", "Verify now", restore and signing in keys on the first address of
that header, in memory only, so each visitor gets their own budget instead
of all of them sharing the production Caddy's (security review findings 3
and M1).

Signing in is rate-limited by the demo guard itself, not by better-auth
(security review finding M1): demo mode turns off better-auth's IP handling
altogether (`disableIpTracking`, `apps/api auth.ts`), which as a side
effect also disables better-auth's *own* rate limiter for every endpoint —
it cannot run without a resolved IP either. There is deliberately no
trusted-proxies setting for better-auth here, since it would never be
consulted while `disableIpTracking` is on. None of this ever stores a
visitor's IP: `clientIp`/`clientIpOf` stay null in demo mode (see "What it
is").

Move to Option A as soon as a dedicated VM is available: co-hosting is a
stop-gap, not because it leaks isolation (it does not — no shared network,
no shared volume, the demo's containers have no route to the production
stack, and `web` is published on the Docker bridge gateway only, not on any
public interface) but because a demo VM going down for the night's reset,
or hitting its resource limits, should never be a production host's
problem.

## Environment variables

See `deploy/demo/.env.example` for the full, commented list (compose files,
database roles, secrets, the demo account, visitor-IP handling, the
synthetic mailboxes, co-hosting). It carries empty placeholders only,
exactly like the repository root's `.env.example`; real values live only in
`deploy/demo/.env`, which is gitignored. Never commit it.

## Edition

The demo shows the Business and Service Provider functions without a license
key. It runs the full images (Dockerfile targets `runtime` and `web`, the
modules under `ee/` included; the Community images have no such functions)
and sets `RESTOW_EDITION=service_provider` in `deploy/demo/.env`.

The license module (`ee/licensing`) honours `RESTOW_EDITION`
**only together with `RESTOW_DEMO=true`**, which this compose project sets for
every Restow service. On any other installation the variable has no effect: a
full build without a key runs as Community, with the paid menu entries shown
locked, and only an installed license key unlocks them. So a value copied from
here into a production `.env` unlocks nothing, and the demo needs no key on its
host. The demo guard keeps the license key routes read-only like every other
write, so a visitor cannot install or remove a key either.

## Reset

`deploy/demo/reset.sh` is idempotent:

1. checks, before touching anything, that every image the project needs is
   loaded (it never builds; see "Images") and that `web` is not about to be
   published on a wildcard address;
2. `docker compose down --volumes` (the database, the mail volume, the
   chunk store and Caddy's TLS state all go);
3. `up -d --no-build --wait` **every service except `web`**;
4. `docker compose run --rm seed` (synthetic mail, tenants, sources,
   schedules, first backups + verification, the simulated machines, the mail
   archive);
5. only if the seed succeeded, `up -d agent-sim` (the heartbeat sidecar of
   the simulated machines) and then `up -d --no-build --wait web` — the one
   container anything outside this compose project can reach. If the seed
   failed, `web` stays down and the run exits non-zero: an unconfigured or
   half-seeded installation is never published (security review finding 1).
   The seed fails, for one, when a simulated machine is not proven
   restorable at the end, or the archive's hash chain does not verify.

It reads which compose files to use from `RESTOW_DEMO_COMPOSE_FILES` in
`.env` (colon-separated, default just `docker-compose.yml`; see "Running
it"), and logs to `/var/log/restow-demo-reset.log` (override with
`RESTOW_DEMO_RESET_LOG`). `RESTOW_DEMO_ENV_FILE` points the variables of the
compose file itself at another file for a test run (the services still read
`env_file: .env` next to the compose file).

Install the nightly schedule with systemd:

```sh
cp deploy/demo/systemd/restow-demo-reset.service /etc/systemd/system/
cp deploy/demo/systemd/restow-demo-reset.timer /etc/systemd/system/
"$EDITOR" /etc/systemd/system/restow-demo-reset.service   # set WorkingDirectory
systemctl daemon-reload
systemctl enable --now restow-demo-reset.timer
systemctl start restow-demo-reset.service   # run it once by hand first
journalctl -u restow-demo-reset.service -f
```

The timer fires at 03:00 Europe/Berlin, matching the banner shown in the
app shell ("Demo — all data resets every night at 03:00 …",
`packages/i18n/resources/*/auth.json`, key `demo.banner`). Change both
together if the time is ever moved. It also runs two minutes after every
boot: the chunk store is a tmpfs volume, empty after a reboot, while
Postgres still lists the old restore points.

## The seed and the synthetic mail

`deploy/demo/seed` (a small pnpm workspace package, `@restow/demo-seed`) is
plain TypeScript, tested with vitest like the rest of the repository:

- `generate-mail.ts` plans a deterministic corpus of synthetic mail (a fixed
  seed always plans the exact same messages — `generate-mail.test.ts`) and
  writes it straight into Dovecot's Maildir storage (`maildir.ts`), no IMAP
  connection needed. `company.ts` names the fictional company, domain
  (`example.org`, IANA-reserved for documentation) and mailboxes;
  `content.ts` holds the templates (the demo writes English only; German
  templates stay for tests); `mime.ts`, `ics.ts` and
  `pdf.ts` build the RFC 5322 message, the calendar invite and the PDF
  attachment by hand (no new dependency).
- `api-seed.ts` drives the real API exactly like an operator would (with the
  seed token, since `POST /api/v1/setup` is not on the public allowlist —
  see "Isolation"): waits for `/healthz`, runs the setup wizard's own
  request (the operator responsibility notice needs no step of its own: in
  demo mode the api treats it as accepted, since the demo has no operator and
  a visitor cannot write), signs in, creates the two demo tenants, adds their IMAP sources
  and protected mailboxes, waits for the first backup Restow queues on its
  own for every new mailbox and starts, one object at a time, any that the
  one-backup-at-a-time rule above skipped, then triggers and waits for the
  verification of each tenant — so the demo shows real green verification,
  not a faked status — and only then applies the recommended schedules.
  That order matters: once a "verify" schedule exists, the worker follows
  every completed backup with its own sampled verify
  (`apps/worker/src/handlers/backup.ts`), which would otherwise race the
  seed's own explicit verify call and lose to demo mode's one-job-per-queue
  guard (security review finding 3) with a 409.
- `history.ts` and `backdate.ts` give the statistics and readiness charts
  weeks of history instead of a single day (`RESTOW_DEMO_HISTORY_DAYS`,
  default 30; 0 switches it off). The base corpus stops that many days
  back; then, one round per simulated day, that day's new mail
  (`planWave`: a few messages per mailbox on a working day, at most one at
  the weekend, during office hours) lands in the mailboxes, every mailbox is
  backed up for real, every tenant verified, and every sixth day one inbox
  is restored as a ZIP download. Nothing is faked: every round runs through
  the real API and worker, so every snapshot of the history has its
  manifest and packs and can be browsed and restored. Afterwards
  `backdate.ts` moves each round's rows (jobs, job progress, snapshots,
  packs, chunks, verify reports, restores, item failures; for the first
  round also the sources and protected objects it created) back to the day
  it stands for, in one transaction, as the installation role
  (`DATABASE_PROVIDER_URL`, BYPASSRLS; the seed needs no superuser). The
  newest round stays where it ran. The append-only audit log is not
  touched: it keeps the true time of every seed action. Rounds run one job
  at a time and within the demo's own job-trigger rate limit (the seed
  waits out a 429), so a history of 30 days adds roughly 30 backup rounds
  to the reset; lower `RESTOW_DEMO_HISTORY_DAYS` if the nightly reset has
  to be shorter.

## Simulated machines

Servers & endpoints › Inventory (filters All, Servers and Clients) shows two
machines, simulated, with real backups:

| Machine | Tenant | System | Folders in the backup |
| --- | --- | --- | --- |
| `fileserver-01` ("Main file server", server profile) | Example Trading Ltd | Linux (Debian 12), amd64 | `/srv/share`, `/etc/samba`, `/var/log/samba` |
| `laptop-jdoe` ("J. Doe's MacBook Pro", client profile) | Birchwood Consulting Ltd | macOS 15, arm64 | `/Users/jdoe` |

How it works (`seed/src/endpoint-files.ts`, `endpoint-agent.ts`,
`endpoint-history.ts`, `restic.ts`, `restic-proxy.ts`, `agent-api.ts`):

- **Files.** English, made-up documents on reserved example domains and
  documentation addresses (192.0.2.0/24): invoices, monthly reports,
  contracts and proposals as PDF (the seed's own `pdf.ts`, the generator the
  demo mail uses), meeting notes, plans and to-do lists as text and Markdown,
  a Samba configuration and a growing, rotated Samba log, dotfiles, and PNG
  screenshots (the screenshots of this demo in `docs/images/screenshots`, and
  tiny generated charts). The seeded random source makes the whole history
  deterministic. The files live in tmpfs mounts of the seed container, one per
  backed-up folder (`docker-compose.yml`, service `seed`), so the snapshots
  carry the machines' real paths and nothing of the container; the seed refuses
  a folder that already holds files.
- **The agent, played by the seed.** For each machine the seed creates an
  enrollment token through the admin API, enrolls with `POST /agent/v1/enroll`
  reporting `os` (`linux` or `darwin`), architecture and OS version (that is what
  makes the UI show Linux and macOS), sets the folders to back up the way an
  administrator does in the settings, sends heartbeats, fetches the
  configuration, and runs the same restic the product ships (pinned, in the seed
  image) with the agent's own command line (`--host <hostname> --tag
  restow-agent`, exclude patterns, `--retry-lock`) against the api's restic REST
  endpoint with the agent's credentials; the server enforces append-only for
  them exactly as for a real machine. Each run is reported like the Go agent
  does: start, finish with statistics, the SHA-256 of sample files for the
  restore test (taken from files provably unchanged since the snapshot), the
  errors and the last lines of the run log. restic cannot add a header of its
  own, and the demo guard refuses every write without the seed token, so the
  seed runs a small loopback proxy that only forwards `/agent/restic/...` to the
  api and adds the token. Inside the demo's network the agent API is plain
  http (`http://api:3000`); the repository URL the server hands out (the public
  one) is swapped for the proxy's, and the public demo is unaffected (an
  enrollment never checks the transport; only the install command shown in the
  UI warns about plain http).
- **History.** One snapshot per simulated day for the last
  `RESTOW_DEMO_HISTORY_DAYS` days (default 30), stamped with the moment it
  stands for (`restic backup --time`): the server nightly at 22:00 Berlin time,
  the laptop on working days in the late afternoon, now and then a day missed.
  Between two snapshots files are added, changed and removed: new invoices and
  notes, ticked-off plan tasks, a log that grows and is rotated, a changed
  Samba configuration, drafts that disappear, screenshots that move from the
  Desktop to the pictures folder. At most one snapshot per day and machine, so
  the retention (daily 30, weekly 12, monthly 12) never thins the history.
- **Proven restorable.** After every backup the seed asks the server for the
  restore test of that backup (`POST /api/v1/endpoints/:id/restore-test`),
  waits for its verdict (the server reads the sample files back with `restic
  dump` and compares the hashes), requires it to be green, and answers the
  restore test the server hands back to the agent (`verify_sample`: the files
  restored on the machine and hashed again). The machines show as proven
  restorable only because those tests passed, as in the product; the seed fails
  otherwise. A test that comes out red while the scheduler's first retention and
  repository check of a new machine hold the repository (all three start at once)
  is asked for again, at most twice; the red report stays in the machine's
  history, a repository that is really damaged fails every time. The scheduler also runs each machine's first retention and
  repository check right after its first backup (the seed gives them a moment
  and moves on), and the next ones at its normal pace.
- **Backdating.** Afterwards `backdate.ts` moves everything the server wrote for
  a backup (the run, its samples, the reports, the tasks, the machine's own rows,
  the enrollment for the first one) to the backup's simulated moment, in one
  transaction, like the mail history. The audit log keeps the true times.
- **Online between resets.** The seed backs the machines up once, during the
  nightly reset. A real agent also sends a heartbeat every five minutes, and a
  server that is silent for two hours counts as down, so a small sidecar
  (`agent-sim`, `seed/src/heartbeat.ts`, 96 MB, no other duty) keeps sending
  heartbeats with the logins the seed leaves on the `demo-agents` volume.
  It never starts a backup or a restore.
- **What a visitor can do.** Browse the snapshots and folders of both
  machines, search the reports, and download files or folders as a ZIP (the demo
  guard allows `POST /api/v1/endpoints/:id/downloads`, rate-limited per
  visitor, the one endpoint action that is a POST but only reads). Restoring
  onto a machine, asking for a restore test, "Back up now", enrolling a machine,
  changing its settings and revealing its repository password are refused.

Honest limits of the simulation: a restore test samples 6 files per backup (the
agent takes up to 20) to keep the nightly reset short; runs last seconds, so no
live progress is reported; Windows is not part of Restow 0.1.0 and not
simulated. The first retention and repository check of each machine ran early
in the history, so right after a reset the machine page shows them as weeks old
and the repository size as "not measured yet"; the scheduler repeats both at
its next hourly pass (its jobs are spaced by the hour) and the page fills in. The
machines' repositories (about a megabyte each) live in the capped `demo-data`
volume with everything else.

## The mail archive

Restow 0.1.0 has **no continuous IMAP (or Graph) archive sync**: the worker has
no handler for the archive queue and the schedule kind is not offered (the
README and the changelog say so too). An archive item in 0.1.0 is written by
the journal receiver (Exchange Online journaling, Business edition, needs a TLS
certificate) or by a mail file import with "also archive" (`docs/IMPORT.md`,
`docs/ARCHIVE.md`). The demo has no Exchange, so its archive is filled by the
import (`seed/src/archive-seed.ts`):

- For `accounting@` (Example Trading Ltd) and `sales@` (Birchwood Consulting
  Ltd) the seed uploads the synthetic mail of the mailbox, the same messages the
  Dovecot mailbox holds, as one mbox file per folder through the import API's
  upload protocol, and creates an import with `archive: true`. The result is an
  imported mailbox ("Accounting (mail archive)", "Sales (mail archive)", shown
  under Sources as the import source), and for each message an archive item:
  stored byte-exact, chained into the tenant's hash chain, indexed for full text
  search, with the retention date of the archive's fixed default policy (8 years
  from the end of the year of capture; Restow 0.1.0 has no API or screen to set
  another archive policy, so the seed does not invent one).
- The archive page shows the items, search finds them, and the chain
  verification is green. One example **legal hold** is placed on the Example
  Trading mailbox (the demo's edition, `RESTOW_EDITION=service_provider`, see
  "Edition", includes legal holds and the other Business archive capabilities; the
  demo does not run the journal receiver, which needs `JOURNAL_*` settings and a
  certificate).
- The items are labelled as captured by an import, not by a journal or a sync.
  Because the demo does not run the journal receiver, the archive page's
  Exchange journaling section shows the neutral "Not set up" state, not an
  error.
- **Archive rows are not backdated.** The table is append-only (a database
  trigger refuses an update) and each item's chain hash covers the moment of
  capture, so moving it would break the chain. Every item is therefore captured
  "today", at the seed; the messages' own dates (spread over ten years) are kept
  in `sent_at`, which is what the archive shows and searches by. The
  jobs and snapshots of the import itself are not backdated either: the archive
  step runs after the history has been moved.
- Everything is synthetic, like the mail itself; switch the step off with
  `RESTOW_DEMO_ARCHIVE=false`.

Run the seed by hand against a running demo (useful while developing):

```sh
cd deploy/demo/seed
pnpm build
RESTOW_API_URL=http://localhost:3000 \
RESTOW_PUBLIC_URL=https://demo.restowbackup.com \
RESTOW_DEMO_EMAIL=demo@example.org \
RESTOW_DEMO_PASSWORD=... \
RESTOW_DEMO_SEED_TOKEN=... \
RESTOW_DEMO_IMAP_PASSWORD=... \
RESTOW_DEMO_IMAP_HOST=localhost \
RESTOW_DEMO_IMAP_PORT=143 \
RESTOW_DEMO_MAIL_ROOT=/tmp/restow-demo-mail \
RESTOW_DEMO_HISTORY_DAYS=0 \
node dist/index.js
```

The simulated machines only run when `RESTOW_DEMO_ENDPOINT_ROOT` is set
(`/` in the compose project, where each folder is a fresh tmpfs; set it to a
scratch directory for a run by hand, then the snapshots carry that prefix) and
need a restic binary (`RESTIC_BINARY`, default `restic`). Never point it at `/`
on a machine that has data at `/srv/share`, `/etc/samba`, `/var/log/samba` or
`/Users/jdoe`: the seed refuses a folder that is not empty, but it is not meant
for a real machine.

## No real data, ever

Every name, company, address, machine, file and mailbox the demo shows is fictional
(`deploy/demo/seed/src/company.ts`, `content.ts`): the domain is
`example.org` (IANA-reserved for documentation, never a real registration),
the correspondents are placeholders (`Jane Doe`, `John Sample`), the
companies are invented ("Sample & Sons Ltd", "Placeholder Inc."). Everything
the demo shows is in English. If this ever
needs to change, keep it that way: no real person, company, email address or
document may appear in the public demo.
