# CI, release pipeline and release smoke

What runs on GitHub, what it needs, and how to run the release smoke on your own
machine. The pipeline uses `GITHUB_TOKEN` only: no personal access token, no
long-lived signing key. The one long-lived key, the endpoint agent's release signing
key, stays on the maintainer's machine: the release waits until it is used there
(agent/README.md, "Release signing").

## Workflows

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` | every push to a branch, every pull request, and as part of the release | lint (biome), the `ee/` import guard, the former-name guard (no tracked file or path may name the product before its rename) and the package file guard (`check-package-files.mjs`: no test file or test data folder in what a workspace package ships into the images), all in `scripts/ci`, typecheck, unit and Postgres tests (with the pinned restic installed, the endpoint suites run it) and the guard that no Postgres suite was skipped, i18n completeness (every key of `en` in `de` and the other way round), full build, Docker build of all four images, full and Community (no push, see "Two build targets"), with a look inside (the self-test of `scripts/docker`, restic, `restow-restore`, the agent checksums, the license texts, no `@tutao/oxmsg` in the production trees, the OCI labels with each build's license, the variant marker, no `ee/` code in the Community images and no license signing code in any image), `pnpm audit` for high and critical advisories, dependency licenses (see "Dependency licenses and Dependabot"), gitleaks over the history (over the commits of a pull request), the Go agent in `agent/` (its own scripts: `agent/scripts/test.sh` with gofmt, go vet for the four targets, `go test -race` and ShellCheck; `integration.sh` against the real restic and an append-only REST server; `test-install.sh` for the install script; then `agent/build.sh` for linux and darwin on amd64 and arm64; passes with a notice on a commit that has no `agent/`), shellcheck for every `*.sh` and the tests of the server install script (`deploy/install/test.sh`, see "Server install script"), actionlint for the workflows. The job **CI passed** is the one to require in branch protection. |
| `release.yml` | a tag `v*` | see "Releasing" |
| `smoke.yml` | nightly on `main`, and on demand | builds the images of both builds from the checkout and runs every smoke check, once per build; nothing is published |
| `contributor-checks.yml` | pull requests | CLA and DCO sign-off; the DCO job skips Dependabot's pull requests (its commits carry no sign-off; the CLA job allowlists it for the same reason) |

Every third-party action is pinned to a full commit SHA with its version in a
comment; every container image a step runs is pinned by digest. To update a pin,
look the SHA of the new tag up (`gh api repos/<owner>/<action>/git/ref/tags/<tag>`)
and change both the SHA and the comment.

## Dependency licenses and Dependabot

The job **Dependency licenses** of `ci.yml` installs the workspace and runs
`scripts/ci/check-licenses.mjs`: every production dependency against the allowlist in
`scripts/ci/license-policy.json`. It fails on GPL, LGPL, AGPL, SSPL, EUPL and on any
license the policy does not know, and names the packages. The dependencies of the `ee/`
workspaces must in addition be free of any copyleft (MPL is not allowed there either),
and the `license` field of every `package.json` is checked (`Apache-2.0` for the core,
`SEE LICENSE IN ../LICENSE` for `ee/`). The same job runs `scripts/ci/check-go-deps.mjs`
(the Go agent may not depend on any third-party Go module: `go list` over the module
graph and the packages of all four targets) and fails when `THIRD_PARTY_NOTICES.md` or
`agent/THIRD_PARTY_NOTICES.txt` (the notices that ship with the agent to every machine) is
not what `scripts/third-party-notices.mjs` generates.

The restic binary Restow redistributes is a statically linked Go program with 79
third-party modules (restic 0.19.1). Their licenses are checked one by one through the
section `redistributedBinaries` of the policy: each needs a license of the allowlist without
copyleft, or a named exception for that binary. The only exception is MPL-2.0 for
`github.com/hashicorp/golang-lru/v2` (unmodified; its notices entry says where its source
is); it allows nothing for Restow's own dependencies and nothing in `ee/`, and an exception
no module needs any more fails the check. The license and NOTICE files of these modules are
vendored in `licenses/restic-deps/`: `node scripts/restic-licenses.mjs vendor
agent/dist/*/restic` (maintainer, once per restic pin: reads the module list from the
binaries' build information, fetches each module through the Go module proxy, checks it
against the hash in the binary) and `... check` (CI, in the agent job against the four
freshly fetched binaries: the vendored list is exactly their modules, versions and hashes;
no Go, no network). A new restic pin therefore needs `vendor`, a review of the diff in
`licenses/restic-deps/`, then `node scripts/third-party-notices.mjs`; CI fails until both
are done.

Dependabot (`.github/dependabot.yml`) opens version updates weekly (Monday 06:00
Europe/Berlin), one pull request per update, for the pnpm workspace, the Go module of
the agent, the GitHub Actions and every Dockerfile (the product image, the demo's
Dovecot image, the updater test stubs). Major versions of Node and PostgreSQL (and of
`@types/node`) are ignored: they are decisions, not updates. Every Dependabot pull
request runs the normal CI, including the license check and the audit, so an update
that brings in a license outside the policy cannot be merged. Updated by hand: the
images pinned by digest in `ci.yml` (gitleaks, actionlint), the Go and restic pins in
`agent/tools.env`, and `scripts/smoke/e2e` (playwright-core must match the pinned
Playwright image).

## Two build targets

Every release has two builds of the same commit, each with an application image and a
web image:

| Build | Images | Dockerfile targets | Contains | `org.opencontainers.image.licenses` |
| --- | --- | --- | --- | --- |
| full | `ghcr.io/restow-backup/restow`, `ghcr.io/restow-backup/restow-web` | `runtime`, `web` | the core plus the Business and Service Provider modules under `ee/`, locked until a license key is installed | `Apache-2.0 AND LicenseRef-Restow-Enterprise` |
| Community | `ghcr.io/restow-backup/restow-community`, `ghcr.io/restow-backup/restow-web-community` | `runtime-community`, `web-community` | the Apache-2.0 core only, no `ee/` code at all | `Apache-2.0` |

Why these names: the full build keeps the names it always had, so existing
installations, the defaults of the opt-in updater (`RESTOW_UPDATER_IMAGE_REPOSITORY`),
the release compose file and every guide keep working unchanged. The Community build
gets the suffix `-community`, which says in the image name itself that it is the
Apache-2.0-only variant; nobody pulls it by accident, and nobody has to read labels to
know what is inside. Both builds carry the same tags (`:<version>`, `:beta`, from 1.0
also `:MAJOR.MINOR`, `:MAJOR`, `:latest`).

How the Dockerfile builds them without copying stages: `install` (the whole workspace
and `pnpm install --frozen-lockfile`) is shared; `build` compiles it as it is,
`build-community` first runs `scripts/docker/strip-ee.mjs` and then compiles. `deploy`
and `deploy-community` both run `scripts/docker/deploy-prod.sh` (the `pnpm deploy` of
each role, the pruning of what never runs in production, the checks below);
`runtime-base` and `web-base` hold everything the final images share, and the four
final stages differ only in where `/prod` or the web bundle comes from, their labels
and their environment. `web` stays the last stage, so a build without `--target`
builds what it always did.

`scripts/docker/strip-ee.mjs` turns the workspace into the Community build: every
designated loader (`ALLOWED_LOADERS` of `scripts/ci/check-ee-boundary.mjs`:
`apps/api/src/ee.ts`, `apps/worker/src/ee.ts`, `apps/web/src/features/ee.ts`) becomes an
empty module (`export {};` with a comment), the Tailwind `@source` line for `ee/` leaves
`apps/web/src/index.css`, and `ee/` is deleted. It checks everything before it changes
anything and stops, leaving the tree as it was, when a loader is missing (a renamed
loader must be renamed in `ALLOWED_LOADERS` too, so it can never ship `ee/` code
unnoticed), when any other file of `apps/` or `packages/` imports from `ee/`, or when a
stylesheet reaches `ee/` in a way it cannot remove (an `@import`). Afterwards it checks
the result again. It runs after `pnpm install`, which therefore stays shared; a frozen
install of the workspace without `ee/` works as well (pnpm ignores the lockfile entries
of the missing `ee/*` workspaces), and nothing of the core depends on an `ee/` package,
so `pnpm deploy` of the core apps never takes one along. Its tests, and a run against
the real workspace that fails when a loader moves, are `scripts/docker/strip-ee.test.mjs`.

The application image carries `RESTOW_REVISION` (the commit; `GET /api/v1/status`
reports it) and `RESTOW_IMAGE_VARIANT` (`full` or `community`). The update check reads
the image digests of its own build from the release notes, and the opt-in updater,
which runs from an image of the same build, pulls the images of that build (or, in
source mode, builds its two targets) unless `RESTOW_UPDATER_IMAGE_REPOSITORY` and
`RESTOW_UPDATER_WEB_IMAGE_REPOSITORY` name other repositories (docs/UPDATING.md). Every
image carries `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` and `licenses/*` in
`/usr/share/doc/restow/`, the full images also `ee/LICENSE` as `ee-LICENSE`; both web
images serve the third-party notices as text at `/licenses/THIRD_PARTY_NOTICES.txt`.

Build them locally, for this machine's architecture:

```sh
docker buildx build --target runtime -t restow:local --load .
docker buildx build --target web -t restow-web:local --load .
docker buildx build --target runtime-community -t restow-community:local --load .
docker buildx build --target web-community -t restow-web-community:local --load .
```

### Image assertions

`scripts/docker/check-image-tree.mjs` looks into the built trees. The Dockerfile runs it
on `/prod` in both deploy stages and on the web bundle in both build stages, so an image
that breaks a rule is never built; CI (`docker` job) and smoke check 1 run it again on
the finished images (inside the application image, on the copied `/srv` of the web
image).

- **No license signing code in any image.** The product only verifies license keys;
  keys are issued elsewhere, and the private key never enters this repository (the
  former issuer, `packages/core/src/license/cli.ts` and `issue.ts`, is gone). Flagged
  in first-party code (everything outside `node_modules` plus the workspace packages
  `@restow/*` in it): the names `signLicenseToken`, `issueLicenseToken`,
  `generateLicenseSigningKeyPair`, `runLicenseCli`, `LICENSE_CLI_USAGE` (the former
  issuer), `createTestLicenseSigner` (the test signer's export), `license-signing.key`,
  the generation of an Ed25519 key pair (the key type of license keys), and files named
  like a key generator
  (`*keygen*`), `license/cli.js`, `license/issue.js` or `test-signer.*`. Third-party
  packages are not searched for these names (React lists the HTML element `<keygen>`,
  TLS libraries create key pairs), and neither `createPrivateKey` nor key pair
  generation in general is flagged: the product reads the Entra certificate and the
  journal receiver's TLS key with the first, and comments of `ee/licensing` name the
  test signer's file, which is why file names are matched, not mentions.
- **No `ee/` code in the Community images**: no first-party directory named `ee` (the
  api and the worker compile `ee/` into `dist/ee`), no `@restow/ee-*` package, no
  relative import or source map path into `ee/`. The Community web bundle is built from
  a tree without `ee/` and is checked the same way.
- **The `ee/` modules in the full images**: `/prod/api` and `/prod/worker` must hold
  them (`--require-ee`), so a full image can never ship without them unnoticed.
- **No tests and no sources in any image**: the image runs the compiled `dist` of each
  package, so first-party test files (`*.test.*`, compiled ones and their source maps
  included), test folders (`testing`, `testdata`, `fixtures`, `__tests__`,
  `__snapshots__`, `test-results`) and TypeScript sources (`*.ts`, `*.tsx`) fail the
  check; `*.d.ts` declarations are allowed. A failing check prints at most 50 findings
  and the number of the others. The `files` list of each deployed package keeps these
  files out in the first place, and `scripts/ci/check-package-files.mjs` (part of
  `pnpm lint`) checks those lists for `apps/api`, `apps/worker`, `apps/scheduler`,
  `packages/core`, `packages/cli` and `packages/i18n`; `.dockerignore` keeps local
  `test-results` folders out of the build context.

## Releasing

1. On `main`: set the version in `package.json` (and the workspace packages) and
   `DEFAULT_VERSION` in `deploy/install/install.sh`, write
   the `CHANGELOG.md` section `## [X.Y.Z] - YYYY-MM-DD` with every section of
   `docs/releases/TEMPLATE.md` and a real date. Optionally run the smoke first:
   `pnpm smoke` locally, or **Actions > Smoke > Run workflow**, and summarise it in
   the Verification section.
2. Tag the commit on `main`, annotated and signed, and push the tag:
   `git tag -s vX.Y.Z -m "Restow X.Y.Z" && git push origin vX.Y.Z`.
3. `release.yml` then runs, in this order:
   - **verify**: the tag is annotated, its commit is on `main`, `package.json` has the
     same version, `CHANGELOG.md` has that version with a real date and all required
     sections (`scripts/ci/check-release.mjs`), `deploy/install/install.sh` installs that
     version by default (`DEFAULT_VERSION`), and `agent/` exists. A signature GitHub
     cannot verify is a warning, not an error.
   - **ci**: the whole of `ci.yml` on the tagged commit.
   - **agent**: builds the endpoint agent for every target as the release version
     (`agent/build.sh` allows that because `agent/release-signing.pub` holds the
     maintainer's release key, fingerprint
     `SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o`; it refuses a checkout where
     the file is only a placeholder) and puts its checksum list on a **draft** release
     as `agent-SHA256SUMS`.
   - **agent-signature** (environment `agent-release-signing`): waits until the
     maintainer ran `scripts/release/sign-agent.sh vX.Y.Z --key <private key>` on the
     signing machine (it signs `agent-SHA256SUMS`, checks the signature against the
     committed public key, uploads `agent-SHA256SUMS.sig` and approves this job); then
     checks that the signature covers exactly this build.
   - **build** (amd64 and arm64, each on a native runner): all four images, with the
     signed agent (the Dockerfile checks the signature once more):
     `ghcr.io/<owner>/restow` (api, worker, scheduler, restic, agent downloads,
     `restow-restore`) and `ghcr.io/<owner>/restow-web` (Caddy edge and web interface)
     of the full build, `ghcr.io/<owner>/restow-community` and
     `ghcr.io/<owner>/restow-web-community` of the Community build ("Two build
     targets"), pushed **by digest and untagged**.
   - **release-smoke** (amd64 and arm64, full and Community): the smoke checks against
     exactly those digests, `--variant community` for the Community images. It gates
     the release: nothing below runs unless all four runs pass.
   - **publish**: checks the agent signature on the draft once more, then the tags (one
     multi-arch manifest per image), the cosign signatures of all four images, an SBOM
     per image and architecture, and publishes the draft release.
4. Docker tags (`scripts/ci/release-lib.mjs`): `0.x.y` gets
   `:<version>` and `:beta`; from 1.0.0 a stable release gets `:<version>`, `:MAJOR.MINOR`,
   `:MAJOR` and `:latest`; a pre-release (`-rc.N`) gets only `:<version>`. A 0.x release is
   a normal GitHub release (not marked "pre-release"), so `releases/latest` and the opt-in
   update check find it.
5. The GitHub release carries the notes (the `CHANGELOG.md` section, with the Verification
   section completed from the full build's smoke report and a line with the verdicts of
   the Community runs; then the four images, their four digest lines
   `restow:`, `restow-web:`, `restow-community:`, `restow-web-community:`, which the
   update check and the opt-in updater read, and the cosign commands), and these files:
   `smoke-report.md` (amd64) and `smoke-report-arm64.md`, `smoke-report-community.md`
   and `smoke-report-community-arm64.md`, `SHA256SUMS` (every file the publish job attaches;
   `agent-SHA256SUMS` and its signature are on the draft already and not listed) with
   `SHA256SUMS.sigstore.json` (keyless cosign signature of that file), the agent binaries
   `restow-agent_<version>_<os>-<arch>` for linux and darwin on amd64 and arm64 with their
   license notices `restow-agent-THIRD_PARTY_NOTICES.txt`,
   `agent-SHA256SUMS` with the maintainer's signature `agent-SHA256SUMS.sig`, the SBOMs
   (`<image>-<version>-linux-<arch>.spdx.json` for `restow`, `restow-web`,
   `restow-community` and `restow-web-community`, SPDX, also attached to the images as
   cosign attestations), `docker-compose.yml` and `env.example` of the release stack
   (`deploy/release/`), and the server install script `install.sh`
   (`deploy/install/install.sh`) with `install.sh.sha256`.

Verify an image (the same command for `restow-web`, `restow-community` and
`restow-web-community`):

```sh
cosign verify ghcr.io/restow-backup/restow:0.1.0 \
  --certificate-identity-regexp '^https://github.com/restow-backup/restow/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A failed run leaves untagged digests in the registry and a draft release at most; fix the cause and
run it again (re-run the workflow, or delete and push the tag again; a published tag is
never moved: a hotfix is a new PATCH release with its own smoke run).

## Server install script

`deploy/install/install.sh` installs the release stack on a dedicated Linux VM (README.md,
"Install with the script"). It is published unchanged as a release asset, listed in the
signed `SHA256SUMS`, and installs the version in its `DEFAULT_VERSION` line unless told
otherwise; the **verify** job refuses a tag whose version differs from that line. The
script checks the release files against `SHA256SUMS` and that file's signature
(`SHA256SUMS.sigstore.json`), and each image's cosign signature by the digest it pulled,
both for the identity of the release workflow run of exactly that version; cosign runs from
the same image, pinned by digest, as the opt-in updater's (`DEFAULT_COSIGN_IMAGE` in
`apps/api/src/updater/signature.ts`; the tests compare the two).

CI runs ShellCheck over it and `deploy/install/test.sh`: the options, the preflight
decisions, the generated `.env` (secret formats, mode 0600, never overwritten, no secret in
the log or the output) and whole dry runs of the script against stub commands that fail on
anything that would change the host. No root, Docker or network is needed, and the tests
run with bash 3.2 (macOS) as well as bash 5. The installation itself (Docker from Docker's
apt repository, the signatures, the start, a repeated run) is tested by hand on VMs before
a release that changes the script: Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04, amd64 and
arm64 (the releases Docker's apt repository serves for both architectures; the script refuses
any other).

## What the maintainer sets up on GitHub

- **Environment `agent-release-signing`** (Settings > Environments): required reviewer
  the maintainer, no secrets. The release waits there for the agent signature;
  `scripts/release/sign-agent.sh` approves it after uploading the signature. Without
  the environment the signature job fails until the signature is there, and the script
  re-runs it.

- **Package visibility.** After the first release run, open the packages `restow`,
  `restow-web`, `restow-community` and `restow-web-community` (your profile or
  organisation > Packages) and set the visibility to **public**, so operators can pull
  without a login. New packages start private.
  Link them to the repository so the workflow's `GITHUB_TOKEN` keeps write access.
- **Branch protection** for `main`: require a pull request, and the status check
  **CI passed**; allow only the maintainer to push.
- **Tag protection** (Settings > Rules > Rulesets): only the maintainer may create `v*` tags.
- **Actions**: enabled; the arm64 hosted runner `ubuntu-24.04-arm` available (free for
  public repositories). Workflow permissions can stay at "read": every job asks for what it
  needs.
- **Secrets** (all optional, used by the smoke only): see the next section. Without them the
  release still runs, and the report says "skipped: no dev tenant credentials".
- Private vulnerability reporting (SECURITY.md) and the Discussions category for
  announcements, if you want them.

## Secrets

Only one check needs any: **check 4, Microsoft 365 against the dev tenant**, which runs
only when all five repository secrets are set. They belong to the Microsoft 365 developer
tenant (never a customer tenant, docs/TESTING.md) and to an app registration with the
permissions of docs/ENTRA-SETUP.md plus the read access the comparison needs:

| Secret | What |
| --- | --- |
| `M365_TEST_TENANT_ID` | directory (tenant) id of the dev tenant |
| `M365_TEST_CLIENT_ID`, `M365_TEST_CLIENT_SECRET` | the Restow app registration in that tenant, admin consent granted beforehand |
| `M365_TEST_MAILBOX` | UPN of the test user whose mailbox (mail, calendar, contacts) and OneDrive are backed up |
| `M365_TEST_RESTORE_MAILBOX` | UPN of a second test account that receives the restore |

The interactive admin-consent sign-in of a human cannot run in CI. The check records the
tenant id on the source in the database, the way the consent callback does after that
sign-in, and then lets Restow verify the permissions for real (token, permission diff,
first Graph call). Everything after that is the product's normal path. The Microsoft check
has not been run against a real tenant yet: see "What the smoke does not do".

## The release smoke

`scripts/smoke/run.mjs`, one command, the same script locally and in CI:

```sh
pnpm smoke                      # builds both images from this checkout, runs every check
node scripts/smoke/run.mjs --variant community             # the same for the Community build
node scripts/smoke/run.mjs --image REF --web-image REF     # test images that already exist
node scripts/smoke/run.mjs --only 5,7                      # some checks and what they need
node scripts/smoke/run.mjs --help
```

`--variant full` (the default) builds the targets `runtime` and `web`, `--variant
community` the targets `runtime-community` and `web-community` (or tests the images
given with `--image`/`--web-image`; check 1 fails when they are not the build the
variant names). `agent/release-signing.pub` holds the maintainer's release key
(fingerprint `SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o`, see agent/README.md,
"Release signing"), so a build from this checkout carries the version as given; its agent
is built from source and not signed (only the release workflow signs, and the release
builds take the signed agent from `agent/prebuilt`). In a checkout where the file is only a
placeholder (a fork before its own key ceremony), `agent/build.sh` builds only development
versions: the smoke then builds `<version>-dev`, and images built by hand for `--image`
need the same suffix and `--version <version>-dev`. The Community run uses its own defaults (project
`restow-smoke-community`, ports from 38500, `smoke-report-community.md`,
`smoke-out/run-community`), so both runs can go side by side.

**The license key of the full build.** The Business and Service Provider checks need a
real key: `RESTOW_EDITION` is honoured only in demo mode (`RESTOW_DEMO=true`). The smoke
makes a throwaway Ed25519 key pair per run with the test-only signer
`ee/licensing/testing/test-signer.mjs` (never part of an image, see "Image assertions"),
puts its public key into the stack's `.env` as `RESTOW_LICENSE_PUBLIC_KEY` (the release
compose file hands `.env` to the api), and right after the setup in check 3 installs a
Service Provider key for the installation the way an operator does it (`GET
/api/v1/license` for the installation id, `POST /api/v1/license` with the key). Then the
api is restarted, because the journal receiver reads its capability at start. The
private key exists only in the memory of the smoke process.

**The Community build** has no license API and exactly one tenant. Check 3 asserts both
(`GET /api/v1/license` is 404; after the wizard created the first tenant, a second one is
refused with 403 `urn:restow:problem:feature-unavailable`), and every later check works in
that one tenant instead of creating its own. Check 6 (the journal receiver, a Business
module) and check 8 (it needs one tenant per storage target; the targets are core code,
checked in the full run) are reported as skipped with that reason.

It needs Docker with compose and buildx, Node 22 and, for check 9, `pnpm` (or corepack). It
copies `deploy/release/docker-compose.yml` into `smoke-out/run/stack`, generates every
secret of that stack fresh, adds the overlay `scripts/smoke/docker-compose.smoke.yml`
(Dovecot, Garage, a bind-mounted directory standing in for an NFS or SMB share), starts it
as the compose project `restow-smoke` on the ports from 38300 (`--port-base`), runs the
checks and removes the stack and its volumes again. Output: `smoke-report.md` (check,
result, duration, detail and the date of each), the service logs in `smoke-out/logs`, the
browser results and screenshots in `smoke-out/run/e2e`. Exit code 1 when a check failed.
On a Mac with Colima keep the repository below your home directory (the bind mounts need
it) and give the VM 4 CPUs and 6 GB; the browser container runs on the host network so
that `https://localhost:<port>` is the passkey origin.

The checks:

1. **Install**: image metadata (OCI labels, version, revision, platform), the build the
   images are (the licenses label, `RESTOW_IMAGE_VARIANT`, `RESTOW_REVISION`), the image
   assertions (no license signing code in either image, no `ee/` code in the Community
   images, the `ee/` modules in the full one), restic, `restow-restore`, the license texts
   and the agent downloads in the image with their checksums, the release compose file, `docker compose up` on an empty database with every migration applied, the
   upgrade from the previous release (a stack of the previous images with a tenant and a
   backup, switched to the new images; needs `--previous-image`, which the release workflow
   passes when an earlier release exists), and at the end a restart of the api on the
   populated database (the migrations change nothing).
2. **Health**: `/healthz`, `/readyz` (ready only once the worker and the scheduler have
   written a heartbeat, so the check waits up to two minutes for it), the edge over https, the
   third-party notices as text at `/licenses/THIRD_PARTY_NOTICES.txt`, the
   `service_heartbeats` rows of the worker and the scheduler, no container restarting.
3. **Passkey E2E**: first-run setup; the full build then installs the Service Provider key
   and restarts the api, the Community build shows that it has no license API. Then in a
   real browser (Playwright in a container): the emergency sign-in, registering a passkey on
   a virtual authenticator, signing out, signing in with the passkey, creating a tenant in
   the wizard, every screen in English and German without a missing translation key. The
   Community build then refuses a second tenant.
4. **Microsoft 365** against the dev tenant (secrets above; otherwise skipped, in plain words).
5. **IMAP**: a mailbox with 24 messages in two folders on Dovecot, backup, three more
   messages and an incremental backup, restore next to the originals, every restored message
   compared by SHA-256, the restore check green.
6. **Journal**: the tenant's journal address read from the API (`GET /api/v1/archive/journal`,
   on the stack's `JOURNAL_HOSTNAME`), the receiver refusing plain text with 530 and
   presenting the stack's certificate after STARTTLS (a throwaway self-signed certificate for
   the journal host, generated per run and mounted through `JOURNAL_TLS_DIR`; the SMTP
   client trusts exactly that certificate and checks the host name, and the insecure opt-out
   is not used), rotated once so the first address is refused, a
   synthetic Exchange journal report (with a Bcc recipient) over SMTP with STARTTLS, the archive item
   present, the journal setup showing the reports, the hash chain verified and continued by a
   second report, an unknown journal address refused, and the archive export (EML ZIP with
   `MANIFEST.csv` and `SHA256SUMS`) holding the originals byte for byte. The Business
   capability comes from the license key check 3 installed. Full build only.
7. **Standalone restore**: `restow-restore` from the image, with the server stopped and no
   network in its container, restores the storage of check 5 and every file matches; a copy
   with one damaged byte is refused.
8. **Storage targets**: S3 (Garage), a local path and a bind-mounted directory; each one gets
   a write (a backup), a read (the restore check) and a scrub. Full build only.
9. **Scans**: Trivy on the image and `pnpm audit --audit-level high`.
10. **Endpoint backup**: the real install script installs the agent in a Linux container
    from the running stack (through the Caddy edge, which the container trusts by its local
    CA), enrolls it with a one-time token, backs up a folder, and a restore task puts it into a
    new directory; every file matches by SHA-256.
11. **Mail import and export**: EML files and an MBOX in the server-side import folder and an
    MBOX uploaded in segments become one imported mailbox; it is exported as an EML ZIP and as
    MBOX files; the EML files come back byte for byte, every message by Message-ID, and both
    checksum lists agree with the files.

### What the smoke does not do

The report states each of these; none is ever shown as a pass.

- Check 4 needs the secrets above, and it has never run against a real Microsoft 365
  tenant: without the secrets it is reported as skipped, and its code path is
  implemented from the API and the documented Graph behaviour. Microsoft 365 backup and
  restore are covered by tests against a simulated Graph API only; expect differences
  on the first real run.
- Upgrade path: there is no earlier public release for 0.1.0, so check 1 reports that step
  as not run. It runs from the next release on (the workflow finds the previous release),
  for each build from its own previous images.
- The Community run skips check 6 and check 8 (above) and says so in its report; the
  same code is checked in the full run.
- Check 6 does not compare the stored bytes of a journal item with the report it came from:
  no API serves an archived item's raw bytes; the export is the witness.
- Check 9 counts critical Trivy findings **that have a fix**. Criticals the distribution has
  not fixed (the Debian base image) cannot be acted on; they are listed in the report.
  `--trivy-strict` counts them too.
- Windows and the Windows agent are not part of 0.1.0; the endpoint check is Linux only.
  It runs the real install script in a Linux container, never on a real macOS host and
  never under a real systemd or launchd service.

## Tooling that is not part of the product image

Listed with purpose, license and alternative in `docs/STACK.md`: Playwright (passkey E2E),
Garage, Dovecot, Trivy, syft, cosign, actionlint, gitleaks, shellcheck.
