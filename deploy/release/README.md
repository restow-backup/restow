# Restow release stack

`docker-compose.yml` runs a published Restow release: PostgreSQL, the api,
worker and scheduler roles from the application image, and the Caddy edge from the
web image. It builds nothing. Both images carry the same tag, the release version
without the leading `v`; `RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` in `.env` name them.

Every release comes in two builds. Pick one and use both of its images:

| Build | `RESTOW_IMAGE` | `RESTOW_WEB_IMAGE` | Contains |
| --- | --- | --- | --- |
| full | `ghcr.io/restow-backup/restow:0.2.1` | `ghcr.io/restow-backup/restow-web:0.2.1` | the Apache-2.0 core plus the Business and Service Provider modules (Restow Enterprise License), which stay locked until a license key is installed |
| Community | `ghcr.io/restow-backup/restow-community:0.2.1` | `ghcr.io/restow-backup/restow-web-community:0.2.1` | the Apache-2.0 core only: every backup source and every restore, for one tenant |

Take the full build if you may want the Business or Service Provider features later: a
license key unlocks them without changing images. Take the Community build if you want the
Apache-2.0 core and nothing else. Both use the same database schema, so you can switch
later by changing the two image lines and running `docker compose up -d`.

On a dedicated Linux VM (Debian 12 or 13, Ubuntu 22.04, 24.04 or 26.04, amd64 or arm64) the
release's `install.sh` (source: [deploy/install/install.sh](../install/install.sh)) does the
steps below for you in `/opt/restow`: it installs Docker from Docker's signed apt repository
if needed, checks these two files against the release's signed `SHA256SUMS`, generates the
secrets into `.env` (mode 0600), checks the images' cosign signatures and starts the stack. See
[Install with the script](../../README.md#install-with-the-script-recommended) and the
[requirements](../../README.md#requirements). By hand:

```sh
cp env.example .env      # a repository checkout calls it .env.example; fill in the required values
docker compose up -d
curl -fsS http://127.0.0.1:3000/healthz
```

(The release assets carry the same two files as `docker-compose.yml` and `env.example`, and
the install script as `install.sh` with `install.sh.sha256`; all of them are listed in the
signed `SHA256SUMS`.)
`RESTOW_APP_DOMAIN` is required. Open `RESTOW_PUBLIC_URL` to run the setup wizard; it asks for
the language first, then for the one-time setup token the api prints to its log until the setup is complete
(`docker compose logs api | grep 'SETUP TOKEN'`), or the value of `RESTOW_SETUP_TOKEN` when you
set one in `.env`. Back up `RESTOW_MASTER_KEY` offline before the first real backup. If the
last owner loses their passkey, authenticator app or password, recover the access with
`docker compose exec api restow admin recover --email <owner>` (see the
[README](../../README.md#recovering-administrator-access)). For a local evaluation set
`RESTOW_APP_DOMAIN=localhost` and `RESTOW_PUBLIC_URL=https://localhost`; Caddy then uses a
certificate from its own local authority, which your browser will not trust until you accept it.
Behind a reverse proxy that holds the name and the certificate (from 0.2.0), set
`RESTOW_APP_DOMAIN=<name>`, `RESTOW_EDGE_TLS=internal` and `RESTOW_EDGE_TRUSTED_PROXIES=<proxy address>/32`
(and `RESTOW_HTTP_PORT=127.0.0.1:` to leave port 80 alone) and let the proxy forward to
`https://<this host>:443`; the install script's `--behind-proxy` does this, see the
[README](../../README.md#behind-a-reverse-proxy).

The archive's Exchange Online journal receiver (Business and Service Provider) is off until
`JOURNAL_SMTP_PORT` is set (25 for Exchange Online, with `JOURNAL_SMTP_BIND=0.0.0.0` so that it is
reachable from the internet), and it needs `JOURNAL_HOSTNAME` and a TLS certificate for that host
name: Exchange Online requires TLS, so without one the receiver does not start. Put `fullchain.pem`
and `privkey.pem` into `./journal-tls` (mounted read-only into the api; `JOURNAL_TLS_DIR` changes
the directory) and set `JOURNAL_TLS_CERT_PATH` and `JOURNAL_TLS_KEY_PATH` in `.env` as described in
`.env.example`. A renewed certificate in those files is picked up within minutes, without a
restart. Details: the [Exchange journaling guide](https://docs.restowbackup.com/administrators/exchange-journaling/).

Update by hand by changing the two image lines in `.env` and running
`docker compose pull && docker compose up -d`; read [docs/UPDATING.md](../../docs/UPDATING.md)
and the release notes first. Or start the opt-in updater once, in this directory, with
`docker compose --profile updater up -d`: nothing has to be set in `.env` for it, and from
then on updates are installed from the web interface (Installation, Updates) and the updater
rewrites the image lines itself. There is no separate updater image: the updater is the
application image of `RESTOW_IMAGE` started with `ROLE=updater`. On its first start it pins
that image by digest in `RESTOW_UPDATER_IMAGE` (optional, leave it empty), so later rewrites
of `RESTOW_IMAGE` do not reach it, and after each update whose images passed the signature
check of the release workflow it moves itself to that release's image, by digest
(`RESTOW_UPDATER_SELF_UPDATE=false` switches that off). It installs only release images
signed by the release workflow, and only those of the build it runs from, which is the build
of `RESTOW_IMAGE` when it pinned itself. Building an update from a source repository instead is off until you name that
repository in `RESTOW_UPDATER_SOURCE_HOSTS`; changing the update source and announcing an update
need a sign-in from the last ten minutes.

A Community installation switches to the full build under Installation, Edition: with the
updater it is done for you (the full images of the same version, signature-checked, with a
database backup and a rollback); without it the section shows the two `.env` lines. A
license key entered there is checked and applied by the full build after the switch. The
switch goes one way only (docs/UPDATING.md, "Switching to the full build").

Every image of a release is signed with cosign (keyless, GitHub OIDC). For the Community
build, verify `restow-community` and `restow-web-community` the same way:

```sh
cosign verify ghcr.io/restow-backup/restow:0.2.1 \
  --certificate-identity-regexp '^https://github.com/restow-backup/restow/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Every release also carries the SBOMs of the four images and `SHA256SUMS`, the checksums of
the release files, signed with cosign (`SHA256SUMS.sigstore.json`). The endpoint agent has its own
signature, made by the maintainer: `agent-SHA256SUMS` and `agent-SHA256SUMS.sig` on the release,
checked by the install scripts and the agent itself ([agent/README.md](../../agent/README.md),
"Release signing").

Plan memory for the api and worker containers beyond the services themselves: mail files,
previews and journal reports are parsed in separate helper processes of up to 512 MB each (a
process of up to 3 GB for a single large message), `IMPORT_PARSE_WORKERS` in the worker and
`PREVIEW_PARSE_WORKERS` in the api at a time (2 each by default; set 1 on a small host).

The release pipeline runs its smoke checks against exactly this compose file, for both
builds (`scripts/smoke`, [docs/CI.md](../../docs/CI.md)).
