# Restow `ee/`: Business and Service Provider modules

Everything under `ee/` lives in the same repository as the Apache-2.0 core
(`apps/`, `packages/`) and is released together with it. There are two
builds (docs/CI.md):

- the **full build** (images `restow` and `restow-web`) compiles `ee/` into
  the apps. What is *active* is decided at runtime by the license module
  (`ee/licensing`): an installed, offline-verified Ed25519 license key
  unlocks the capabilities of its edition; without a key the installation
  runs as Community and the paid menu entries are shown locked;
- the **Community build** (images `restow-community` and
  `restow-web-community`) leaves `ee/` out entirely: the three loaders below
  are replaced by empty modules and the core runs with exactly its own
  features.

The core knows no license, no edition and no capability. It offers extension
points; everything that decides on a license lives here.

## License

Everything under `ee/` is licensed under the Restow Enterprise License
(`ee/LICENSE`). The rest of the repository is licensed under Apache-2.0
(`LICENSE`, `NOTICE`). Contributions are accepted under the Contributor
License Agreement (`CLA.md`).

## Dependency direction

`ee/` may import the core, including internal modules of `apps/*` by relative
path; the core never imports `ee/`. The only exceptions are the three
loaders, which import the `ee/` entry of their app and hand it to the core's
extension registries:

| App | Loader | Registry | `ee/` entry |
| --- | --- | --- | --- |
| api | `apps/api/src/ee.ts` | `apps/api/src/extensions.ts` | `ee/api/src/auth.ts`, `ee/api/src/index.ts` |
| worker | `apps/worker/src/ee.ts` | `apps/worker/src/extensions.ts` | `ee/worker/src/index.ts` |
| web | `apps/web/src/features/ee.ts` | `apps/web/src/lib/extensions.tsx` | `ee/web/src/index.ts` |

`scripts/ci/check-ee-boundary.mjs` (part of `pnpm lint`) fails the build when
any other file under `apps/` or `packages/` imports from `ee/`, tests
included. Tests of `ee/` modules live next to them and register the module
through the same registry the loader uses; tests of the core that need a
gated function register a test feature gate instead of a license.

`ee/licensing` is shared by `ee/api` and `ee/worker` (relative imports,
compiled into the app that loads them); it has no entry of its own.

## The license module

| Part | Where |
| --- | --- |
| Editions, `RESTOW_EDITION` (demo only, see below) | `licensing/src/editions.ts` |
| Capability table (`CAPABILITIES`, `CAPABILITY_MIN_EDITION`, `hasCapability`) | `licensing/src/capabilities.ts` |
| Key format `restow-license-v1`, offline verification, key id | `licensing/src/token.ts` |
| Embedded verification key, `RESTOW_LICENSE_PUBLIC_KEY` override, fingerprint | `licensing/src/public-key.ts` |
| The installed license (active row of the `license` table) | `licensing/src/store.ts` |
| License gate of the API modules, the core's feature gate, `edition-required` problem | `api/src/license/gate.ts` |
| `/api/v1/license` (state, install, remove; provider admins, owners change it) | `api/src/license/routes.ts`, `service.ts` |
| `extensions.edition` of `GET /api/v1/me` | `api/src/license/session.ts` |
| License UI (Installation → License, `/installation/license`, also reached through the menu entry Installation › License: edition, licensee, key id, license terms link, key install and removal), locked menu entries and locked sections of the installation page | `web/src/license` |

This repository only verifies keys. Issuing them is the business of the
private restow-license repository; its signing key never enters this one.
Tests sign with a throwaway key from `licensing/testing/test-signer.mjs`
(test code only, imported by no app, never part of a build; the release
smoke uses it too). `api/src/license/testing.ts` writes an active `license`
row directly for the Postgres suites.

`RESTOW_EDITION` is honoured only together with `RESTOW_DEMO=true`: the
read-only public demo shows the Service Provider functions without a key
(deploy/demo/README.md, "Edition"). Anywhere else it has no effect and an
installation without a key runs as Community.

## What lives where

| Feature | Capability (edition) | `ee/` | Extension point in the core |
| --- | --- | --- | --- |
| License key management and the edition | all editions of the full build | `licensing`, `api/src/license`, `web/src/license` | session routes, feature gate, session fields, provider route rules, web slots and nav locks |
| Legal holds | `archive.legalHold` (Business) | `api/src/legal-holds`, `web/src/legal-holds` | session routes (guarded), `archive.sections` slot |
| SMTP journal receiver, its per-tenant setup page (address, status, rotation, Exchange Online guide) and its installation page (Installation → Journal receiving: listening or not and why, port, TLS, host, size limit) | `archive.journalReceiver` (Business) | `api/src/journal`, `web/src/journal` | background service, session routes (guarded), `archive.sections` slot, `installationSections` |
| Archive deletion runs | `archive.retentionEnforcement` (Business) | `worker/src/archive-retention` | retention tasks |
| Audit log viewer (search, details, chain verification) | `audit.log` (Business) | `api/src/audit-log`, `web/src/audit-log` | session routes (guarded), routes and a locked nav entry |
| Microsoft (Entra ID) sign-in for end users | `auth.microsoftSso` (Business) | `api/src/sso` | better-auth plugin, auth route guard, sign-in provider |
| Provider team (roles, tenant scopes) | `provider.team` (Business) | `api/src/provider-team`, `web/src/provider-team` | session routes (guarded), routes and a locked nav entry |
| Scheduled summary reports | `reports.scheduled` (Business) | `api/src/reports` | `reportSummary` feature hook, feature gate `reports.timed` |
| Further tenants beyond the installation's first | `provider.tenantManagement` (Service Provider) | `api/src/license/gate.ts`, nav lock of the core's tenants entry in `web/src/license` | feature gate `tenants.additional`, nav locks |
| Cross-tenant provider API (`/provider/*`) and provider API keys (Installation → Provider API) | `provider.crossTenantApi` (Service Provider) | `api/src/provider-api`, `web/src/provider-api` | integration routes, feature gate `apiKeys.provider`, `installationSections` |
| Provider view of the dashboard (tenant matrix, alerts) and statistics across tenants | `provider.tenantReporting` (Service Provider) | `api/src/provider-dashboard`, `web/src/provider-dashboard` | `providerDashboard` feature hook, `dashboard.provider` slot, feature gates `dashboard.allTenants` and `stats.allTenants` |

### Extension points of the core

API (`apps/api/src/extensions.ts`, `ApiExtension`):

- `sessionRoutes`: a route group under `/api/v1<path>` with an optional
  `guard`, a middleware the core runs ahead of the group. `ee/` passes its
  license guard (`capabilityGuard`), so a locked group answers 404 exactly
  like an unknown path.
- `featureGate`: decides the core functions that exist only when an extension
  enables them (`apps/api/src/lib/features.ts`, `GATED_FEATURES`:
  `tenants.additional`, `apiKeys.provider`, `stats.allTenants`,
  `dashboard.allTenants`, `reports.timed`). With no gate registered all are
  off and the core answers 403 `urn:restow:problem:feature-unavailable`.
  `ee/` maps each to a capability (`FEATURE_CAPABILITIES`) and answers 403
  `urn:restow:problem:edition-required` (with `requiredEdition`, `edition`,
  `capability`) while it is off.
- `sessionFields`: fields of `GET /api/v1/me` under `extensions.<key>`,
  passed through by the core unread (`ee/` adds `edition`). `/me` also lists
  the gated functions that are on (`features`).
- `providerRouteRules`: provider team rules for an extension's own routes
  (`apps/api/src/lib/provider-access.ts`, `providerRule` builders); the
  core's table covers only core routes.
- `authRouteGuards`, `signInProviders`, `integrationRoutes`, `services`,
  `hooks` (`reportSummary`, `providerDashboard`).

Worker (`apps/worker/src/extensions.ts`): `retentionTasks`, `handlers`. Each
task decides itself whether it runs (`installationHasCapability` from
`ee/licensing`).

Web (`apps/web/src/lib/extensions.tsx`, `WebExtension`):

- `routes`, `navItems`: pages and menu entries. A nav entry may carry a
  `lock` (`apps/web/src/lib/navigation.ts`, `NavLock`: `isLocked(ctx)`, `to`,
  `search`, `hintKey`); the context holds the session's `features` and
  `extensions` (both null while `/me` loads). The sidebar renders a locked
  entry greyed out with a lock and sends it to `to`; it knows nothing else.
- `navLocks`: locks for the core's own entries, by nav item id (`ee/web`
  locks `tenants` below Service Provider).
- `installationSections`: sections of the installation page
  (`/installation/<id>`, `InstallationSectionSpec`): an id, label and
  description keys, an icon, an `order` between the core's sections, the
  component (props `{ requires }` from `?requires=`), an optional `lock` (a
  locked section stays in the sub-navigation greyed out with a lock and leads to
  `lock.to`, exactly like a locked menu entry) and an optional
  `legacySettingsSection` (the old `/settings?section=<name>` address that now
  leads here). `ee/web` adds Journal receiving (Business), Provider API
  (Service Provider) and License.
- `slots` (one component per slot; `ExtensionSlot` may render a `fallback`):
  `shell.sidebarFooter` (the edition
  badge), `tenants.creationLocked` (why no further tenant can be created; the
  core's neutral note is the fallback), `archive.sections`,
  `dashboard.provider`.
- The session (`apps/web/src/lib/session.tsx`) exposes `features` (the gated
  core functions that are on, `hasFeature`) and `extensions` (what `/me`
  carries under `extensions`); `ee/web/src/license/edition.ts` reads the
  edition from `extensions.edition`. The `license` translations live in
  `ee/web/src/license/i18n` and are registered by the module itself.

### Deliberately in the core

- **Recording the audit log.** Every read and every restore is written to the
  hash-chained audit log by the core (`apps/api/src/lib/audit.ts`,
  `packages/core/src/audit-chain.ts`). Only viewing, searching and verifying
  it is Business.
- **The archive format and its journal parser** (`packages/core/src/archive`).
  The storage format stays open and readable without a server, including
  items captured by the journal receiver.
- **Tenants.** `tenant_id` is part of the core data model and the core always
  creates the installation's first tenant. Whether a further one may be
  created is the feature gate's decision (`tenants.additional`); the core
  only checks whether a tenant exists, it counts nothing.
- **Usage figures.** The rule for counting protected mailboxes
  (`packages/core/src/usage/mailboxes.ts`) and `GET /api/v1/usage` are the
  core's: dashboards, tenant pages and the integration API show them, and
  nothing limits or enforces them.
- **Settings for archive retention.** Setting the periods is part of the
  archive; enforcing them with deletion runs is Business.
- **Database schema and migrations** (`packages/db`), including the tables
  of Business features and the `license` table with the `edition` enum. Both
  builds share one schema and one migration set, so installing or removing a
  key never needs a migration; only `ee/` reads or writes `license`.

## Locked features

Without the capability, a feature's session routes answer 404 exactly like an
unknown path (`api/src/license/gate.ts`, `capabilityGuard`), the
Microsoft sign-in paths answer 404 before better-auth sees them, and its menu
entry (or section of the installation page) is shown greyed out with a lock
that leads to Installation → License
(`/installation/license?requires=<edition>`), where the license key is
installed. The lock is registered by `ee/web` (`ee/web/src/license/nav-lock.ts`,
`editionLock`; its own nav entries carry it, and it locks the core's tenants
entry by id); the core sidebar only renders what the registry gives it. No banners, pop-ups or
counters. Operations of the integration API that need the Service Provider
edition answer 403 `urn:restow:problem:edition-required`, which tells an
integration clearly why a key cannot use them.

The journal receiver is a long-lived SMTP listener: its capability is read
when the api starts, so installing a key that adds it needs an api restart.
Every other gate reads the license per request.

The receiver also needs a TLS certificate (`JOURNAL_TLS_CERT_PATH` and
`JOURNAL_TLS_KEY_PATH`): Exchange Online requires TLS, and without a usable
certificate the listener is not started and the setup page says why
(`tls_not_configured`, `tls_invalid`, `tls_expired`). It never serves
smtp-server's built-in test certificate, and with a certificate it refuses
plain-text sessions before `MAIL FROM`. Renewed certificate files are picked
up while it runs. `JOURNAL_ALLOW_INSECURE=true` starts it without STARTTLS for
local development only ([Exchange journaling guide](https://docs.restowbackup.com/administrators/exchange-journaling/)).

## Extending `ee/`

1. Add the capability to `CAPABILITIES` and `CAPABILITY_MIN_EDITION` in
   `ee/licensing/src/capabilities.ts`.
2. Put the feature under `ee/api`, `ee/worker` or `ee/web`, importing what it
   needs from the core, and guard it with the license gate (`capabilityGuard`
   for a route group, `requireCapability` or `hasCapability` inside a handler,
   `installationHasCapability` in a worker task, the web lock for a menu
   entry).
3. Register it in the `ee/` entry of its app, with the provider team rules of
   its routes (`api/src/provider-rules.ts`). If the core has no extension
   point for it yet, add one to the app's registry first (a new session
   route group, slot, hook, task type or gated function), never an import of
   `ee/` in the core and never a capability name in the core. A slot renders
   one component, so sections that share a slot are composed into that one
   component (`ee/web/src/archive-sections.tsx` for `archive.sections`)
   instead of registering a second one.
