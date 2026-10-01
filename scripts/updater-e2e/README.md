# Updater end-to-end proof

`run.mjs` proves the Restow updater (`apps/api/src/updater`) against a real Docker
daemon. The updater process itself runs unchanged; it applies updates to a scratch
compose project through its own HTTP API, exactly the way the api drives it. Nothing
in the updater is faked: real `docker pull`, real `pg_dump`, real `docker compose up`,
real rollback. What is stubbed is the application inside the images (`stub/`), not the
updater and not Docker.

```sh
node scripts/updater-e2e/run.mjs                    # updater as a host process, docker CLI
node scripts/updater-e2e/run.mjs --mode container   # updater as a container, helper containers
node scripts/updater-e2e/run.mjs --only success,cancel\ and\ busy
node scripts/updater-e2e/run.mjs --keep             # leave everything in place for inspection
node scripts/updater-e2e/run.mjs --cleanup          # remove what a crashed run left behind
```

Requirements: `docker` with the Compose plugin and a running daemon, the repository's
`pnpm install` (the updater runs through `tsx`), network access the first time (the
images `postgres:16-alpine`, `alpine:3`, `node:22-slim` and `registry:2` are pulled when
missing; `--mode container` also pulls `docker:27-cli` by the digest the updater pins, and
the signature scenario pulls the pinned `ghcr.io/sigstore/cosign/cosign:v3.1.3`).

## What the harness builds

| Piece | Purpose |
| --- | --- |
| A local registry (`registry:2`, `localhost:55501`) | The updater really pulls, and the release digests are the registry's real manifest digests. |
| A compose project `restow-updater-e2e` | Real `postgres:16-alpine`, and `api`, `worker`, `scheduler`, `caddy` services built from the stubs, wired like the real `docker-compose.yml` (`RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` in `.env`, `env_file: .env`). |
| Stub app images `e2e-app:<version>` | `/healthz` and `/readyz` like the api. `/readyz` reports the version only to a caller that presents the updater's shared secret. A version can migrate (insert a row into `drizzle.__drizzle_migrations`), never become ready, or crash on start. |
| Stub web images `e2e-web:<version>` | A trivial edge. The release 2.3.0 deliberately has no web image. |
| The updater | `local`: `tsx apps/api/src/updater/main.ts` on the host with the docker CLI. `container`: the updater's own compiled sources on `node:22-slim` (no docker CLI), with the Docker socket, the project directory and a state volume mounted, running commands in `docker:27-cli` helper containers. |

Everything the script writes to disk lives in `~/.restow-e2e/updater-e2e/` (colima only
shares `/Users` into its VM, so bind mounts must live there). Ports: 55501 registry,
55512 api, 55513 edge, 55514 updater. Names carry the prefix `restow-updater-e2e`. The
script never touches a container, volume, network or image it did not create, and removes
all of them at the end (also when a scenario fails). Images it pulled that were not on the
machine before (`registry:2`, `docker:27-cli`) are removed again.

## Scenarios

1. `authentication and public status`: every `/v1` route refuses a missing or wrong secret, `/public/status` and `/healthz` answer without one, no response contains the secret, the capabilities say the project can be updated and which runner is used.
2. `an unsigned release or one without digest is not installed`: a request without an application digest is refused with 422; then the updater is restarted with the signature check on (the default) and a release whose images carry no signature of the release workflow ends `unchanged` with `fetch.signature_invalid`, the signer it expected in the detail, nothing pulled and nothing changed. (cosign runs in its own container and cannot reach the local registry on `localhost`, so here it fails before it looks for a signature; it fails closed either way. The positive path, a real keyless signature with the exact certificate identity, cannot be produced offline; it was checked by hand against a GitHub-Actions-signed public image with the same container flags.)
3. `cancel and busy`: a scheduled update shows in the public status without naming a version, a second schedule is refused with 409, cancel returns to idle and lands in the history.
4. `success` (1.0.0 to 2.0.0, digests published): pull, digest verified against the registry, signature check recorded as switched off, `pg_dump`, stop, `.env` rewritten (only the two image lines change), `up -d --no-deps`, health through the authenticated `/readyz`, worker, scheduler and edge recreated, services recreated while postgres keeps its container. The dump is restored into a scratch database and holds the canary rows and the state before the migration.
5. `digest mismatch`: a wrong digest fails in `fetch` with `fetch.digest_mismatch`; container ids, `.env` and the database are unchanged.
6. `pull failure`: a tag that does not exist fails with `fetch.pull_failed`; nothing changed and no dump was taken.
7. `health failure before migrations`: the new api never becomes ready; the updater rolls back: `.env` restored byte for byte, previous images running again, the previous version answers, no migration ran, the dump of the attempt is kept.
8. `api crash loop`: the new api crashes on start; the run fails fast (`health.crashed`, well before the health timeout) and rolls back.
9. `web image not published` (the release publishes no web digest): no web image is pulled, the current one stays, `RESTOW_WEB_IMAGE` is left alone, the step records `web: not_published`.
10. `failure after migrations` (3.0.0 migrates, then never becomes ready): outcome `needs_attention`, api, worker and scheduler stopped, the edge untouched, `.env` keeps the new references (nothing is rolled back over migrated data), the recovery data names the dump and the previous images. The script then performs the recovery an operator would (restore the dump into the database, put the previous image back into `.env`, `compose up`) and checks the previous version answers again.
11. `the updater is killed during a run`: `SIGKILL` (or `docker kill`) while the run is in the health step; after the restart the run is recorded as failed with `interrupted`, outcome `needs_attention`, and names the dump.
12. `final state`: idle, at most three dumps plus the one the newest `needs_attention` run needs, no response carries the secret.

The health timeout is set to 30 seconds for the run (`RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS`).
The stub images carry no signature of the release workflow, so every scenario but the
signature one runs with `RESTOW_UPDATER_VERIFY_SIGNATURES=false`; the digests are required
and checked throughout. Every release the harness schedules publishes the registry digest
of its images.

## The genuine image (`genuine.mjs`)

`genuine.mjs` runs the updater from the genuine Restow image and the repository's real
`docker-compose.yml`:

```sh
docker build --target runtime --build-arg RESTOW_VERSION=0.1.0-test1 -t restow:0.1.0-test1 .
node scripts/updater-e2e/genuine.mjs
```

It builds `0.1.0-test2` from the same sources (only the `RESTOW_VERSION` build argument
differs), builds the web images, pushes the release to a local registry, starts the real
compose project as `restow-updater-genuine` (ports remapped through a
`docker-compose.override.yml`, which also proves that an override file is honoured) and
starts the compose `updater` service of the real file: `ROLE=updater` of the genuine image
(pinned through `RESTOW_UPDATER_IMAGE`, as the real file requires), which runs
`node /prod/api/dist/apps/api/src/updater/main.js` and works through helper containers. The
override switches the signature check off (`RESTOW_UPDATER_VERIFY_SIGNATURES=false`): the
locally built test releases are not signed by the release workflow. Then:

1. the genuine api answers the updater: `/readyz` carries the version only for the shared secret;
2. update `0.1.0-test1` to `0.1.0-test2`: digest verified, real `pg_dump` of the real schema (restored into a scratch database), real migrations state read from `drizzle.__drizzle_migrations`, `.env` rewritten, api, worker, scheduler and the real Caddy edge recreated, postgres and the updater itself untouched, the new api reports `0.1.0-test2`;
3. a release whose api exits at once (`0.1.0-test3`): `health.crashed`, rolled back, `.env` restored byte for byte, `0.1.0-test2` answers again.

The two tags `restow:0.1.0-test1` and `restow:0.1.0-test2` (and the web images, registry
tags and the compose project) are removed at the end; `restow:local` and every other image
of the machine are left alone.

## What this does not prove

* `run.mjs` does not run the genuine Restow images: the stubs answer the same two endpoints
  but contain no application. `genuine.mjs` does, but both of its versions are built from
  the same sources, so no schema change is applied, and the failure after migrations is
  covered only with the stubs.
* The registry is local and anonymous. GHCR, registry authentication, rate limits and
  multi-architecture manifests are not exercised, and neither is a successful keyless
  signature verification (see scenario 2).
* `source` mode (download a tagged archive and build) is covered by unit tests with a fake
  HTTP server, not here.
* The edge is a stub: the maintenance page and the `/_maintenance/status` proxy are not
  exercised.
* The Docker daemon is colima on macOS. A Linux host, Docker Desktop, rootless Docker and
  SELinux volume labels are not exercised.
* The updater does not update itself; its own container keeps running the image it was
  started with until the operator recreates it.
