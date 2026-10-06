# Updating Restow

Every release says in its notes (see [the release notes template](releases/TEMPLATE.md))
how much work the update is. This page explains what each answer means and
the steps behind it.

There are two ways to update:

- **By hand**, with `docker compose`. This is the default and always works;
  the rest of this page starts there.
- **From the web interface**, under Installation, Updates: Restow tells you when
  a newer version exists and, if you opt in to the updater service, applies
  it for you, with a countdown for everyone who is signed in, a database
  backup first, and an automatic rollback when the new version does not start
  (not once its database migrations have run: then it stops, keeps the backup
  and tells you what to do, see "When something goes wrong").

Nothing on this page happens unless you switch it on. A fresh installation
does not look for updates, does not contact any server for that purpose, and
does not run the updater.

An installation made with the install script (`install.sh`, README.md) lives in
`/opt/restow` unless you chose another `--dir`; run the commands below there. The
script itself never updates: run again, it only checks the images named in `.env`
and makes sure the stack runs. It sets `RESTOW_PROJECT_DIR`; with `--with-updater`
it also starts the updater, which needs nothing else in `.env`.

## Before every update

1. **Read the release notes** of every version between yours and the new one,
   especially *Breaking Changes* and *Upgrade Notes*.
2. **Back up the database** (it holds metadata, the job queue and the audit
   log; backed-up content lives in the chunk store and is not touched by an
   update):

   ```sh
   docker compose exec -T postgres pg_dump -U restow -Fc restow > restow-$(date +%F).dump
   ```

   The updater does this itself (see below).
3. **Check that `RESTOW_MASTER_KEY` is backed up offline.** An update never
   changes it, but without it no backup can be read.

## The three kinds of update

Each release states one of these at the top of its *Upgrade Notes*.

### 1. Configuration only

Only values in `.env` change (a new optional variable, a changed setting).

```sh
docker compose up -d
```

`up -d` recreates the containers whose configuration changed. Note that
`docker compose restart` is **not** enough: it restarts the running
containers with their old environment and never picks up a new image.

### 2. New image, no or automatic migrations

The usual case. Restow applies database migrations itself: the `api`
container runs them as the database owner (`DATABASE_MIGRATION_URL`) before
it serves any request, and refuses to start if one fails. The release notes
say whether there are migrations and roughly how long they take.

Built from source (the `docker-compose.yml` at the repository root):

```sh
git fetch --tags
git checkout vX.Y.Z
docker compose up -d --build
```

With the published images (`ghcr.io/restow-backup/restow` and
`ghcr.io/restow-backup/restow-web`, the release stack in `deploy/release/`), name the
version in `.env` and pull:

```sh
# .env
RESTOW_IMAGE=ghcr.io/restow-backup/restow:X.Y.Z
RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:X.Y.Z
```

The Community build (the Apache-2.0 core without the Business and Service Provider
modules) has images of its own, `ghcr.io/restow-backup/restow-community` and
`ghcr.io/restow-backup/restow-web-community`, with the same tags; an installation
that runs them updates the same way with those two names.

```sh
docker compose pull
docker compose up -d
```

If the updater ever wrote `RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` into `.env`,
those two lines decide which images the services run. Change them, or remove
them to go back to building from the source checkout. `RESTOW_UPDATER_IMAGE`
names the updater's own image; the updater writes it only pinned by digest
(see [The updater updates itself](#the-updater-updates-itself)).

Watch the migrations and the start:

```sh
docker compose logs -f api
```

The log shows `restow: applying database migrations`, then
`restow: starting role 'api'`.

### 3. Manual steps

A release that needs anything beyond the commands above (a new required
variable, a changed Compose file, a one-off command) lists every step, in
order, under *Upgrade Notes* and *Breaking Changes*. Do them in that order,
before or after `docker compose up -d` exactly as written. The updater
cannot know about such steps: it applies the image and restarts the
services. Read the notes first, and update by hand when they list anything
else.

## The Updates tab

Installation, Updates (provider administrators; changing anything, including
*Check now*, needs the provider team's owner role). It shows the running version, the release
channel, the newest version with its tag and release date, a link to the
release notes (and the notes themselves, rendered safely, collapsed), the
status of the last check and whether an update is available.

### Turning the check on

The check is **off** until an administrator turns it on. When it is on, Restow
reads the release list of the update source once a day and whenever you press
*Check now*. It only reads that list: no request carries any data about your
installation, and the result is cached. If the check fails, the tab says why
and keeps showing the last good result:

| Reason                    | Meaning                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| Rate limited              | The source refused more requests for now; the tab shows when it lifts.         |
| Token rejected            | The access token is wrong, expired or revoked.                                 |
| Not found                 | The repository does not exist, or it is private and no token is stored.        |
| Access forbidden          | The token may not read the releases of that repository.                        |
| Source error / no answer  | The source answered with a server error, timed out or could not be reached.    |
| Not a release list        | The address answered, but not with releases.                                   |
| No release published      | The repository has no release yet.                                             |
| Redirect refused          | The source redirected to another host; Restow does not follow it.              |

### Source, channel and token

- **Source.** The default is the public releases of
  `https://github.com/restow-backup/restow`. You can point it at another repository:
  a GitHub repository or a Forgejo or Gitea repository (their releases API is
  compatible), for example `https://git.example.com/acme/restow`. Only `https`
  addresses are accepted, without credentials in the URL. The check connects to
  public addresses only: an address in a loopback, private or link-local network
  (for example a Forgejo on your LAN, or a host name that resolves there) is
  refused, unless the operator names its host in `RESTOW_UPDATER_SOURCE_HOSTS`
  (see [Two modes](#two-modes)). Every resolved address is checked when the
  connection is made, and a refused address reads the same as one that does not
  answer. Installing from another repository than the default is a separate
  decision of the operator; see [Two modes](#two-modes).
- **Channel.** *Stable* offers stable releases only. *Beta* also offers
  pre-releases (`0.3.0-rc.1`). Versions are compared as Semantic Versions, so
  a pre-release precedes its release.
- **Access token.** For a private repository, store a read-only access token.
  It is kept encrypted in the database (the same way as other installation
  secrets), used only as an `Authorization` header to the source's own host,
  never shown again (the tab only says whether one is stored, and lets you
  replace or remove it), and never written to a log or the audit log. If you
  point the source at another host, the stored token is removed instead of
  following you there. A private repository is built from source (see below).

Changing the source or the access token needs a recent sign-in, see
[Confirming it is you](#confirming-it-is-you).

`RESTOW_UPDATE_CHECK_URL` is an environment override that predates the tab and
keeps working. Precedence, from strongest to weakest:

1. `RESTOW_UPDATE_CHECK_URL`, when set to an `https` address. The check is on,
   the source is that address, and the tab shows it read-only. No stored token
   is sent to it. Being the operator's own setting, it may point at an internal
   address. Accepted: a GitHub `https://api.github.com/repos/<owner>/<repo>/releases`
   (or `.../releases/latest`), a Forgejo or Gitea `.../api/v1/repos/<owner>/<repo>/releases`,
   or any other `https` address that returns the same JSON. The channel can
   still be changed in the tab.
2. The settings of the tab (switch, source, channel, token).
3. The defaults: off, the public project releases, stable.

### The alert for a new version

Once per new version, Restow raises an "Update available" alert: an entry in
the notification bell of the provider administrators, and the alert rules (on each
tenant's page, Notifications) that list the event *Update available* (e-mail, webhook), in
every tenant. A rule for this event can be created by provider administrators
only; a tenant's own administrators are not told about your updates. The same
version never raises it twice.

The integration API (`GET /api/v1/status`, `VersionInfo`) reports the same
state: `running`, `latest`, `updateAvailable`, `updateCheck`, and the fields
`channel`, `latestTag`, `publishedAt`, `checkError` and `maintenance` (an
announced or running update).

## The opt-in updater

The Updates tab shows an **Install** button only when the updater service is
running. Without it, the tab shows the manual steps of this page instead.

### Security note: read this before you enable it

The updater mounts the **Docker socket**. Access to the Docker socket is
root-equivalent access to the host: whoever can make the updater do
something can start any container with any mount, read any file and change
anything on the machine. That is why it is a Compose profile that does
nothing until you start it, and why it is built as small as it can be:

- It is a separate process and container (`ROLE=updater`): the same application
  image, there is no separate updater image, but its own pinned copy of it
  (`RESTOW_UPDATER_IMAGE`, pinned by digest, see below). It
  has no database access and no application secret: it does not get `.env` as
  an environment, so no database password and not `RESTOW_MASTER_KEY`. (It does
  read and rewrite the `.env` file in the mounted project directory, because it
  has to change the image lines; it takes the database user and name from
  it for the backup, and registers every credential-like value in it so that
  none can reach a log.)
- It listens only on the internal Docker network. No port is published.
- The api authenticates to it with a secret the updater generates on its
  first start into a Docker volume (`restow-updater-shared`, mounted read-only
  into the api). The secret is never in the repository, `.env` or any log.
- The read-only status the maintenance page shows (phase, step, progress, a
  failure code) is the only thing the public edge forwards to it. It names no
  version and nothing about the installation; signed-in users see the versions
  in the web interface.
- Its own image never follows `RESTOW_IMAGE`, the line every update rewrites. It
  runs `RESTOW_UPDATER_IMAGE`, pinned by digest, and moves to a new image only
  after an update in image mode succeeded whose images passed the signature
  check below: then it pins that release's verified application image, by
  digest, and recreates itself. No person checks that image; the release
  workflow's signature does ([The updater updates itself](#the-updater-updates-itself)).
  It never runs an image it built from source. It refuses to update while
  `RESTOW_UPDATER_IMAGE` is empty and the Compose file would take the updater's
  image from `RESTOW_IMAGE` (the blocker "updater image not pinned").
- In image mode it installs only release images signed by the project's
  release workflow (see [What is verified](#what-is-verified)).
- `source` mode, which builds an image from a repository, is off unless the
  operator names that repository in `RESTOW_UPDATER_SOURCE_HOSTS` on the host.
  Nobody can switch it on from the web interface.
- Changing the update source or token and announcing an update need a sign-in
  from the last ten minutes, on top of the provider team's owner role
  ([Confirming it is you](#confirming-it-is-you)).

If you would rather not have this on your host, do not enable it: updating by
hand is fully supported and takes a few commands.

### Enabling it

Run this once, on the server, in the directory that holds `docker-compose.yml`
and `.env` (`/opt/restow` for an installation made with the install script):

```sh
docker compose --profile updater up -d
```

Nothing has to be set in `.env` for it, and choosing an update source under
Installation, Updates does not start it: only this command does.

- **There is no separate updater image.** The updater is the application image
  (the one in `RESTOW_IMAGE`, for example
  `ghcr.io/restow-backup/restow-community:0.2.1`) started with `ROLE=updater`;
  every release image since 0.2.0 contains it. `RESTOW_UPDATER_IMAGE` is
  optional. While it is empty, the release stack's Compose file starts the
  updater from `RESTOW_IMAGE`, and on that first start the updater writes
  `RESTOW_UPDATER_IMAGE` into `.env` itself, pinned by digest to the image it
  runs (`ghcr.io/restow-backup/restow:0.2.1@sha256:...`). Pinning changes
  nothing that runs; it only makes sure that the next rewrite of `RESTOW_IMAGE`
  does not reach the updater. If it cannot pin (a locally built image has no
  registry digest, `.env` is not writable), the tab shows the blocker "updater
  image not pinned" and no update starts.
- **The project directory.** The Compose file mounts the directory at
  `/project`, and the updater reads its path on the host from that mount.
  `RESTOW_PROJECT_DIR` (the absolute path, which the install script sets) is
  optional: when it is set, the directory is mounted at the same path instead.
- **The build.** The updater installs the images of the build it runs from: the
  full build updates to `restow` and `restow-web`, the Community build to
  `restow-community` and `restow-web-community` (the image says which,
  `RESTOW_IMAGE_VARIANT`). Starting it from `RESTOW_IMAGE` keeps it on the
  build of the installation. If you set `RESTOW_UPDATER_IMAGE` yourself, use an
  image of the same build: an updater of the other build refuses every update,
  because the digests the api reads from the release notes are those of the
  api's own build. The one exception is the explicit switch of a Community
  installation to the full build ([Switching to the full build](#switching-to-the-full-build)).

To check the image's signature before you give it the Docker socket (the
install script already did this for the images it installed):

```sh
cosign verify ghcr.io/restow-backup/restow:X.Y.Z \
  --certificate-identity https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Then open Installation, Updates. The Install card says whether the updater is
ready or what blocks it (Docker not reachable, Docker command line image not
pulled yet, Compose file not found, project directory not matching
`RESTOW_PROJECT_DIR`, `.env` not writable, not enough free space, the updater's
image not pinned). The first start pulls the Docker command line image (see
below), which needs access to Docker Hub; until then the card says it is
preparing.

To remove it again: `docker compose --profile updater rm -sf updater`. The
updater's volume (`restow-updater`, holding the database dumps) stays until you
remove it with `docker volume rm`.

### The updater updates itself

After an update in **image** mode succeeded, and only when the release's images
passed the signature check of [What is verified](#what-is-verified) in that
run, the updater moves itself to the same release:

1. It asks Compose which image the `updater` service would run with
   `RESTOW_UPDATER_IMAGE` set to the release's application image by the
   verified digest (`<repository>:<version>@sha256:<digest>`). If the Compose
   file does not take the updater's image from that variable, nothing is
   written.
2. It writes that reference into `RESTOW_UPDATER_IMAGE`: a digest, never a tag,
   so what runs next is exactly the content whose signature was checked.
3. A short-lived helper container (the pinned Docker command line image, no
   network of its own) runs
   `docker compose --profile updater up -d --no-deps updater` in the project
   directory: a process cannot recreate its own container from inside.
4. The new updater reports in with the new version, and the tab shows it.

It never moves itself after an update built from source (nothing is signed
there), when the signature check is switched off
(`RESTOW_UPDATER_VERIFY_SIGNATURES=false`) or when you switch it off with
`RESTOW_UPDATER_SELF_UPDATE=false` in `.env` (then recreate the updater). In
those cases the tab says that the updater runs an older version and shows what
to do by hand: set `RESTOW_UPDATER_IMAGE` to the image in `RESTOW_IMAGE` and run
`docker compose --profile updater up -d updater`.

If the self-update fails, the application update stays successful. The tab
shows a warning with the reason and the command that finishes it:
`docker compose --profile updater up -d updater` (`.env` already names the
verified image). If a new updater does not start at all, put the previous value
back into `RESTOW_UPDATER_IMAGE` (the updater's log names it) and run the same
command.

**The trust model.** The container that holds the Docker socket is root on the
host, so its image matters more than any other. Up to 0.2.0 a person decided
when it changed. Now the release workflow's keyless signature decides: the
updater moves only to an image that Sigstore's transparency log records as
signed by `release.yml` of exactly the tag being installed, and only by the
digest that signature covers. Whoever can make the project's release workflow
sign an image can therefore replace the updater, as they could already replace
the application with it. If that is not acceptable for you, set
`RESTOW_UPDATER_SELF_UPDATE=false` and move the updater by hand.

### Switching to the full build

A Community installation (`restow-community`, `restow-web-community`) has a section
Installation, Edition. It says which build runs, what the Business and Service Provider
modules add, and switches to the full build of the version it runs now:

- **With the updater** (ready, published images): *Switch to the full build* announces
  the switch like an update, with a lead time and a countdown for everyone, and needs
  the provider team's owner role and a recent sign-in. The api reads the release of the
  running version once from the update source (also when the daily check is off) and
  takes the digests of the full images from its notes (`restow:` and `restow-web:`).
  The updater then runs the normal pipeline: it verifies both full images against the
  release workflow's signature of that tag, dumps the database, writes
  `RESTOW_IMAGE=ghcr.io/restow-backup/restow:<version>` and
  `RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:<version>` into `.env`, recreates
  the services and rolls back to the Community images if the full build does not
  start (both builds share one migration set, so nothing is migrated). A mirror is
  respected: `.../restow-community` becomes `.../restow` in the same registry. When the
  switch succeeded the updater moves itself to the full image too, by the verified
  digest ([The updater updates itself](#the-updater-updates-itself)), so later updates
  stay on the full build. If that self-update is off or fails, move the updater by
  hand, as the tab says: until then it refuses further updates, because it would
  install Community images on a full installation.
- **Without the updater**, the section shows the two `.env` lines to copy and
  `docker compose pull && docker compose up -d`.

Only this one direction exists: the updater refuses a switch on a full installation,
and the protocol has no switch to Community (data of licensed features may need
modules the Community build does not have).

A license key can be entered in the same section before the switch. The Community
build keeps it, unread and unverified, in the encrypted secret store (kind
`pending_license_key`); it unlocks nothing there. When the full build starts, and
whenever its License page is opened, it verifies the key exactly like one entered on
that page and installs it, then removes the stored text; a key that does not verify is
removed and the rejection audited (`license.pending_key.rejected`).

### Two modes

Restow picks the mode from the update source and shows it in the tab:

- **Image** (the default source, the project's public releases): verifies and
  pulls `ghcr.io/restow-backup/restow:<version>` for the application and
  `ghcr.io/restow-backup/restow-web:<version>` for the web edge
  (`restow-community` and `restow-web-community` on a Community installation; see
  [What is verified](#what-is-verified)), writes the two image references into
  `.env` (`RESTOW_IMAGE`, `RESTOW_WEB_IMAGE`) and recreates the services. If a
  release publishes no web image digest, the web edge stays as it is and the
  run says so.
- **Source** (any other repository, for example your private Forgejo): downloads
  the tagged archive of the repository, with the stored token in an
  `Authorization` header (never in a URL, a command line or a log), builds the
  application and web images locally with `docker build` (the Dockerfile targets
  `runtime` and `web`, or `runtime-community` and `web-community` on a Community
  installation), then recreates the services the same way.

  What is built there runs as the application, with the database and the
  master key. Source mode is therefore **off** unless the operator names the
  repository in `.env` and recreates the updater:

  ```sh
  # One repository (recommended), several separated by commas, or a whole host:
  RESTOW_UPDATER_SOURCE_HOSTS=git.example.com/acme/restow
  ```

  ```sh
  docker compose --profile updater up -d updater
  ```

  An entry is `host/owner/repository` (only that repository) or `host` (every
  repository on that host). GitHub repositories are named `github.com/owner/repo`;
  a bare `github.com` would allow every repository on GitHub, so do not use it.
  Until the repository is listed, the tab says so and offers no install button;
  the updater refuses the request as well (it does not take the api's word for
  it). The api reads the same variable to let the update check reach the listed
  host on a private network.

### Alpha builds

For testing a fix before it is released, the project publishes **unsigned alpha builds**:
every build of the `alpha/*` branches (`.github/workflows/alpha.yml`) pushes the images to
`ghcr.io/restow-backup/restow-alpha` and `ghcr.io/restow-backup/restow-alpha-web` and announces
itself as a pre-release of `https://github.com/restow-backup/restow-alpha`, with the image
digests in the notes like a release. They are not signed, not smoke-tested and not meant for
production data.

Once, on a test installation, in `.env`:

```sh
RESTOW_UPDATER_IMAGE_REPOSITORY=ghcr.io/restow-backup/restow-alpha
RESTOW_UPDATER_WEB_IMAGE_REPOSITORY=ghcr.io/restow-backup/restow-alpha-web
RESTOW_UPDATER_VERIFY_SIGNATURES=false
```

then `docker compose --profile updater up -d updater`. From then on, on this tab: *Use the alpha
channel* (sets the source to the alpha repository and the channel to Beta), save, check, install.
The tab warns while the updater does not verify signatures and while the alpha repository is the
source; each run records `signatureVerified: false`. The digest the alpha release published is
still required and the pulled image must carry it. To go back to the signed releases, remove the
three lines, recreate the updater and use the default source again.

### What is verified

In **image** mode, before anything is stopped:

1. The release must publish the digest of the application image (the release
   notes carry `restow: sha256:...`, or `restow-community: sha256:...` for the
   Community build, see below). A release without one is refused: the tab does
   not offer it, and the updater ends the run as *unchanged* with
   `fetch.digest_missing`. The web edge changes only when the release also
   publishes `restow-web: sha256:...` (`restow-web-community: sha256:...`).
2. Each image is checked in the registry, by that digest, with
   [cosign](https://docs.sigstore.dev/cosign/) (keyless): it must carry a
   signature whose certificate was issued by
   `https://token.actions.githubusercontent.com` for exactly
   `https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v<version>`,
   the release workflow run of the version being installed, and the signature
   must be in Sigstore's transparency log. A digest someone typed into release
   notes, an image built anywhere else and the image of another release all
   fail this (`fetch.signature_invalid`, *unchanged*, nothing pulled).
3. Only then is the tag pulled, and the local image must carry the verified
   digest (`fetch.digest_mismatch` otherwise).

cosign runs in a short-lived container of
`ghcr.io/sigstore/cosign/cosign:v3.1.3` pinned by digest (the version the
release workflow signs with), without capabilities, read-only, through the same
Docker daemon. It needs outbound HTTPS to the registry (`ghcr.io`) and to
Sigstore's trust root (`tuf-repo-cdn.sigstore.dev`). The run records
`signatureVerified` and the tab shows it.

If you mirror the images (`RESTOW_UPDATER_IMAGE_REPOSITORY`), copy the
signatures with them (`cosign copy`); otherwise every update fails the check. A
test installation without signed images can switch the check off with
`RESTOW_UPDATER_VERIFY_SIGNATURES=false` in a Compose override of the updater
service (it is deliberately not in `docker-compose.yml`); the digest is still
required and checked, and every run says that the signature was not checked.

In **source** mode nothing is signed: the archive is fetched over https from a
repository on the operator's allowlist, with the stored token if there is one,
and built as it is. The updater checks the host and repository against the
allowlist, the size of the archive and that it holds a `Dockerfile`; it does
not check who wrote the code, a signature of the tag, or what the `Dockerfile`
does. Trust in that repository is the whole protection, which is why only the
operator can allow it.

The two helper images run with pinned digests too: the Docker command line
image (`docker:27-cli`, see below) and cosign. `RESTOW_UPDATER_CLI_IMAGE` and
`RESTOW_UPDATER_COSIGN_IMAGE` accept only references with a digest.

### Confirming it is you

Changing the update source, storing, replacing or removing the access token,
and announcing an update (also with a lead time of zero) need, besides the
provider team's owner role, a sign-in from the last ten minutes: with a
passkey, or the password together with the authenticator code (or an OIDC
sign-in). An older session gets a "Confirm it is you" dialog. With a passkey
you confirm in place and the change is made right away; otherwise you sign in
again and come back to the tab to repeat it. Switching the check on or off, the
channel, *Check now*, cancelling and dismissing need no fresh sign-in. The API
answers such a request from an older session with `403`
`urn:restow:problem:recent-sign-in-required`.

### What an update does

The administrator picks the version and a lead time (immediately, 1, 5, 15, 30
minutes or 1 hour) and confirms. From then on **every signed-in person**, not
only administrators, sees a banner with a live countdown, and a toast when it
is announced. Cancelling is possible until the update starts. At the start,
everyone sees a full-screen notice with the steps and the progress.

1. **Prepare.** Checks that Docker answers, the Compose file is there, `.env`
   is writable, there is free space, the target is newer than the running
   version, that the Compose file takes the image of api, worker,
   scheduler and web edge from `RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` (so a
   mixed-version installation cannot result), and that it does not take the
   updater's own image from them.
2. **Verify and download, or build.** Image mode verifies the signatures first
   ([What is verified](#what-is-verified)). Nothing is stopped yet: a failure
   here changes nothing.
3. **Database backup.** `pg_dump -Fc` of the database into the updater's
   volume, checked for readability; the last three are kept (plus the one a
   run that needs attention depends on, so never fewer than you need).
4. **Stop worker and scheduler.** Jobs in the queue resume after the restart.
5. **Start the new version.** The api is recreated with the new image and
   applies its database migrations as it starts.
6. **Health check.** Waits until the api reports ready and the new version
   (it gives up at once when the api container keeps restarting); then starts
   worker and scheduler, then recreates the web edge last.
7. **Done.**

While the api restarts, the edge answers browsers with a static maintenance
page (in the browser's language, light or dark) and answers API calls with a
`503`; the web interface treats that as "the server is restarting" and reloads
by itself once the new version answers.

State lives in the updater's volume (`status.json`), so it survives the api
restarting. The audit log records checks, scheduling, cancellation, start,
success and failure of an update (`update.check`, `update.scheduled`,
`update.cancelled`, `update.started`, `update.succeeded`, `update.failed`); the
individual steps are in the updater's status and log, not in the audit log.

### When something goes wrong

The updater never guesses. It ends a failed run in exactly one of three states:

- **Unchanged.** It failed before anything was stopped (Docker unreachable, the
  release published no digest, the signature did not verify, the image could
  not be pulled or did not match its digest, the build failed, the backup
  failed). The old version never stopped.
- **Rolled back.** The new version did not come up and the database migrations
  had not run (the updater stops the new api first, then compares the number
  of applied migrations with the one before the update). The previous images
  are running again, `.env` is restored byte for byte, and the tab says which
  step failed and why.
- **Needs attention.** The new api failed *after* its migrations ran. Migrations
  cannot be undone, so the updater does not start the old version on top of a
  migrated database. It stops api, worker and scheduler, keeps the database
  dump and tells you what to do. The web edge keeps showing the maintenance
  page.

If the updater itself is restarted or killed in the middle of a run, the run
is recorded as *interrupted* (unchanged when it had not stopped anything yet,
otherwise needs attention) and nothing is started on its own.

For *needs attention*, restore the dump taken before the update (the tab shows
the exact file name and the previous image references):

```sh
# copy the dump out of the updater's volume
docker compose --profile updater cp updater:/state/dumps/<file> ./<file>
# stop the application and restore
docker compose stop api worker scheduler
docker compose exec -T postgres pg_restore -U restow -d restow --clean --if-exists < <file>
# put the previous images back into .env (RESTOW_IMAGE, RESTOW_WEB_IMAGE), then
docker compose up -d
```

Backups made after the update are in the chunk store but not in the restored
database; run a backup after the rollback. Then report the failure with the
log tail the tab shows.

### Settings of the updater

The compose service sets what it needs. These variables are read by the
updater only (`ROLE=updater`):

| Variable                                 | Default                          | Meaning                                                       |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `RESTOW_UPDATER_PROJECT_DIR`             | (empty: the mount at `/project`; set from `RESTOW_PROJECT_DIR`) | Absolute host path of the Compose project, mounted at the same path. Empty: the project is mounted at `/project` and its host path is read from the mount. |
| `RESTOW_UPDATER_IMAGE_REPOSITORY`        | `ghcr.io/restow-backup/restow` (Community build: `ghcr.io/restow-backup/restow-community`) | Application image repository for `image` mode (a mirror needs the signatures too). Passed from `.env`. |
| `RESTOW_UPDATER_WEB_IMAGE_REPOSITORY`    | `ghcr.io/restow-backup/restow-web` (Community build: `ghcr.io/restow-backup/restow-web-community`) | Web image repository for `image` mode. Passed from `.env`.    |
| `RESTOW_IMAGE_VARIANT`                   | set by the image (`full` or `community`) | The build the updater belongs to; picks the two defaults above and the targets of `source` mode. Never set it yourself: an unknown value stops the updater. |
| `RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS`  | `600`                            | How long to wait for the new api (migrations can take a while). |
| `RESTOW_UPDATER_MIN_FREE_MB`             | `1024`                           | Free space required in the updater's volume.                  |
| `RESTOW_UPDATER_CLI_IMAGE`               | `docker:27-cli@sha256:851f91d2…` | Image used to run `docker` and `docker compose` (see below); must carry a digest. |
| `RESTOW_UPDATER_COSIGN_IMAGE`            | `ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2e…` | The cosign image that verifies signatures; must carry a digest. |
| `RESTOW_UPDATER_VERIFY_SIGNATURES`       | `true`                           | `false` skips the signature check (test installations, unsigned mirrors); digests stay required. Set it in a Compose override only. It also stops the updater from updating itself. |
| `RESTOW_UPDATER_SELF_UPDATE`             | `true`                           | `false`: the updater does not move itself to a release it installed ([The updater updates itself](#the-updater-updates-itself)). Passed from `.env`. |
| `RESTOW_UPDATER_SOURCE_HOSTS`            | (empty: `source` mode off)       | Repositories (`host/owner/repo`) or hosts `source` mode may build from, comma-separated. Passed from `.env`. |

The Compose file itself reads `RESTOW_UPDATER_IMAGE` from `.env` for the updater
service's image (default `restow:local` in `docker-compose.yml`; in the release
stack's file `RESTOW_IMAGE` until the updater has pinned it on its first start).

The published image contains no Docker command line. The updater therefore runs
each `docker` and `docker compose` command in a short-lived helper container of
`RESTOW_UPDATER_CLI_IMAGE` (pulled in the background when the updater starts;
the updater cannot install anything before that, and says so), through the
mounted socket, without network access and with the project directory and the
updater's state volume mounted. If a `docker` binary is present in the
updater's own image, it is used directly instead. The helper containers carry
no registry credentials: the images of the project's public releases need
none; a private registry is not supported in this mode.

The api reaches the updater at `RESTOW_UPDATER_URL` (default
`http://updater:8090`); nothing answers there unless the updater profile runs.
The demo installation never uses it.

### For release maintainers: digests and signatures

The release workflow (`.github/workflows/release.yml`, job `publish`) does both
things the updater requires: it signs the multi-arch index of each image
keylessly with cosign, from the workflow run of the tag, and it writes one line
per image digest into the release notes:

```
restow: sha256:<64 hex digits>
restow-web: sha256:<64 hex digits>
restow-community: sha256:<64 hex digits>
restow-web-community: sha256:<64 hex digits>
```

An installation reads only the two lines of its own build (the first two for the
full build, the `-community` lines for the Community build). A release without
the `restow:` line (`restow-community:` for the Community build) cannot be
installed from the web interface, and a release whose images were not signed by
`release.yml` for its own tag fails the check. Do not publish digests by hand, and do not move a tag
to another commit: the signature names the tag. Image tags are the release
version without the `v` (tag `v0.2.0` is pulled as
`ghcr.io/restow-backup/restow:0.2.0` and `ghcr.io/restow-backup/restow-web:0.2.0`);
a release without a web digest keeps the web edge as it is, and the run says so.

## After the update

```sh
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
docker compose ps
```

`/readyz` answers 503 `not_ready` until the database answers and the worker and the
scheduler have reported in (their first report comes within seconds of starting, and an entry
counts for two minutes); its body names the check that is missing. `/healthz` only says the api
process is up.

Then check the version in the sidebar footer of the web interface, and run
**Verify now** for one tenant: a restore check that passes proves the new
version can still read what the old one wrote.

## Rollback

- **No migrations in the release:** check out (or pull) the previous version
  and run `docker compose up -d` again; with the release stack, put the previous
  tags back into `RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` first. The updater does
  this by itself when a new version does not start and its database migrations
  had not run (it moves itself only after a successful update, so a rolled
  back update leaves the updater where it was). After rolling back by hand,
  the updater may run a newer version than the application; that is harmless,
  and the next update aligns them again.
- **With migrations:** migrations are not reversible. Stop the stack, restore
  the database dump taken before the update, then start the previous version:

  ```sh
  docker compose stop api worker scheduler
  docker compose exec -T postgres pg_restore -U restow -d restow --clean --if-exists < restow-YYYY-MM-DD.dump
  git checkout vPREVIOUS
  docker compose up -d --build
  ```

  With the release stack, put the previous tags back into `RESTOW_IMAGE` and
  `RESTOW_WEB_IMAGE` instead of checking out a tag, then run
  `docker compose up -d`.

  Backups taken after the update are in the chunk store but not in the
  restored database; run a backup after the rollback.

## Versions and channels

Restow uses Semantic Versioning. Before 1.0.0, a minor version (0.**2**.0)
adds features and may carry migrations; a patch version (0.1.**1**) fixes
problems and carries migrations only when a fix needs one. Tags are
`vMAJOR.MINOR.PATCH`; pre-releases are marked `-rc.N`. The *stable* channel
offers releases only; the *beta* channel also offers the pre-releases.
