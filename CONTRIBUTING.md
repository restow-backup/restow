# Contributing to Restow

Thank you for your interest in Restow. This file explains how to build it
from source, how contributions work and what we ask of them.

## Where the code lives

- The public repository is https://github.com/restow-backup/restow. Issues,
  discussions and pull requests go there.
- Please use the issue templates: a bug report needs the Restow version, a
  log excerpt and the storage target, or it cannot be reproduced.

## Licenses

- Everything outside `ee/` (the core) is licensed under the Apache License,
  Version 2.0 (`LICENSE`, with attributions in `NOTICE`). The endpoint agent in
  `agent/` is part of the core.
- Everything inside `ee/` (the Business and Service Provider modules) is
  source-available under the Restow license terms (`ee/LICENSE`).
- Third-party dependencies must carry a license on the allowlist in
  `scripts/ci/license-policy.json`; CI fails on anything else. Run
  `node scripts/ci/check-licenses.mjs` after you change dependencies, and add the
  new dependency to `docs/STACK.md` (purpose, license, alternative).
- Do not copy code from other projects. If a contribution contains
  third-party material, say so in the pull request, with its source and
  license (CLA, section 5).

## Building from source

Requirements: Node 22+, pnpm 9 and Docker (for PostgreSQL). Install once with
`pnpm install`. The agent in `agent/` is Go and builds without a local Go
toolchain (`agent/build.sh` runs in a pinned Docker image when `go` is not on
the `PATH`).

### Run the development servers

```sh
docker run -d --name restow-pg -e POSTGRES_USER=restow -e POSTGRES_PASSWORD=restow \
  -e POSTGRES_DB=restow -p 5432:5432 postgres:16-alpine
# The owner runs the migrations; the app uses two roles the migration creates:
# one subject to Row Level Security, one for installation-wide lookups (BYPASSRLS).
export DATABASE_MIGRATION_URL=postgres://restow:restow@localhost:5432/restow
export DATABASE_URL=postgres://restow_app:$(openssl rand -hex 16)@localhost:5432/restow
export DATABASE_PROVIDER_URL=postgres://restow_provider:$(openssl rand -hex 16)@localhost:5432/restow
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)

pnpm --filter @restow/db migrate    # migrations, RLS policies, audit triggers and the two roles

pnpm dev:api    # Hono API on :3000  (/healthz, /readyz, /api/v1/setup/state)
pnpm dev:web    # React UI on :5173
```

`/readyz` is ready only when the worker and the scheduler are running as well
(they report in to the database every 30 seconds); start them with
`pnpm --filter @restow/worker dev` and `pnpm --filter @restow/scheduler dev`
for a full stack. `/healthz` needs neither.

### Build and run the Docker images

Check out the tag (or your branch) and use the stack at the repository root,
which builds the images instead of pulling them:

```sh
git clone --branch v0.2.0 https://github.com/restow-backup/restow.git
cd restow
cp .env.example .env     # fill it in as described in the README; leave RESTOW_IMAGE and RESTOW_WEB_IMAGE empty
docker compose up -d --build
```

This stack also publishes PostgreSQL on `127.0.0.1:5432`; set `POSTGRES_PORT`
in `.env` if that port is taken.

### The Community variant (without `ee/`)

The full images (Dockerfile targets `runtime` and `web`) contain the Business
and Service Provider modules from `ee/`; a license key unlocks them at run
time. The Community variant is the core alone: the Dockerfile targets
`runtime-community` and `web-community` run `scripts/docker/strip-ee.mjs`, which
removes `ee/` before anything is compiled, and the build stops if any `ee/`
code reaches the image. Each release publishes them as
`ghcr.io/restow-backup/restow-community` and
`ghcr.io/restow-backup/restow-web-community`. To build them locally:

```sh
docker buildx build --target runtime-community -t restow-community:local --load .
docker buildx build --target web-community -t restow-web-community:local --load .
```

Then set `RESTOW_IMAGE=restow-community:local` and
`RESTOW_WEB_IMAGE=restow-web-community:local` in `.env` and run
`docker compose up -d` without `--build`. The details, including the checks
on the image contents, are in [docs/CI.md](docs/CI.md) ("Two build targets").

### Checks

The checks CI runs:

```sh
pnpm lint                              # biome, the ee/ import direction, the former-name guard,
                                       # no test files in the shipped packages
pnpm -r typecheck
pnpm test                              # set RESTOW_TEST_DATABASE_URL to a PostgreSQL superuser URL
                                       # to include the database suites
pnpm -r build
node --test scripts/ci/*.test.mjs      # the CI tooling's own tests
node scripts/ci/check-licenses.mjs     # dependency licenses against scripts/ci/license-policy.json
node scripts/third-party-notices.mjs   # after changing dependencies: regenerates THIRD_PARTY_NOTICES.md
                                       # (CI fails when the committed file is out of date)
sh agent/scripts/test.sh               # the Go agent: gofmt, go vet, unit tests, ShellCheck
```

## Before your first pull request

1. **Contributor License Agreement.** Read `CLA.md`. When you open your
   first pull request, the CLA check asks you to agree by commenting with
   the sentence given there; it records the agreement once for all your
   later contributions. The CLA lets the Maintainer use a contribution in the
   core and in `ee/`; you keep the copyright.
2. **Developer Certificate of Origin.** Sign off every commit with
   `git commit -s`. The sign-off certifies the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/);
   a check on every pull request refuses commits without it. To add the
   sign-off to commits you already made, run
   `git rebase --signoff origin/main` and push again.

## What a good contribution looks like

- One topic per pull request, described in plain words: what changes for
  the operator and why.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- Code, comments, commit messages and documentation are in English. User
  interface text lives only in the translation files, always with both `en`
  and `de`.
- A feature is complete with migration, service, API, user interface
  (en/de) and tests. A feature that touches backup data is only complete
  once its restore is covered by an automated test.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- No secrets in commits, not even for testing.
- Code outside `ee/` never imports from `ee/` (checked by `pnpm lint`).

## Security issues

Please do not open a public issue for security problems. Report them
privately as described in SECURITY.md.
