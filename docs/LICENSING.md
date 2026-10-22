# Licence keys and updates

The full build (images `restow` and `restow-web`) contains the Business and Service
Provider modules; a signed licence key unlocks those of its edition. Without a key, the
installation runs as Community. The Community build (`restow-community`) has no such
modules and needs no key. This page describes what a key covers over time and what
happens when a version is installed that a key does not cover. The modules, the key
format and the code are described in [ee/README.md](../ee/README.md); the exact key
format, the contract with the licence server, in
[ee/licensing/KEY-FORMAT.md](../ee/licensing/KEY-FORMAT.md).

## In short

- Keys are verified **offline**. Restow never contacts a licence server, never reports
  anything, and nothing stops while it runs: no key expires.
- A key covers a set of **releases**. A covered release works with all modules of the
  key's edition **forever**.
- Whether a release is covered is checked only when it is **installed** (by the updater)
  and when it **starts** (before it touches the database), never at runtime.

## What a key covers

| Key | Covers |
| --- | --- |
| **Beta licence**: every key bought before 1.0 (and every key installed before 0.4.5) | Every release of the 1.x series and every 0.x release, permanently. |
| **Key bought from 1.0 on**: twelve months of updates | Every release **made** up to the last day of its update period (`updates_until`, the end of that day in UTC), whatever its version. |
| **Renewal**: a yearly update package, one fixed price per edition | One more year: a new key of the same edition whose update period ends one year after the previous one. |

"Made" means the release date the release's images carry: the commit date of its release
tag. Restow reads it as `RESTOW_RELEASED_AT` (written into the image at build time from the
build argument `RESTOW_CREATED`); `GET /api/v1/status` reports it as `releasedAt`, and the
release notes publish the same date in a `released:` line next to the image digests, which
is how the update check knows it before installing anything. A build without a release date
(a local or development build, an image built from source) counts as covered.

When the update period has ended, the installed version keeps working with every module.
So does every version released up to the end of the period: you can still install those.
Versions released later cannot run the Business or Service Provider modules with this key.

The licence page (Installation, License) shows which updates the installed key includes,
for example "Updates: all 1.x (beta license)" or "Updates: until Nov 30, 2027". From 30 days
before the end of the period, and after it, the same page says so in a short notice. No
mail is sent.

## Installing a key

- A new key always replaces the active one, of the same edition or another, whether the
  active key is still in force or not. A renewal is installed the same way as the first
  key. Earlier keys stay in the installation's history (the `license` table) and every
  install, replacement and removal is written to the audit log with the key's update terms
  and whether they cover the running version.
- A key that does not cover the running version is refused (`outside_update_period`): its
  modules would stay off on it.
- A key signed with a vendor signing key this version does not know yet is refused
  (`unknown_signing_key`): update first, then install it.

## Updating

The update check (Settings, Updates) marks each offered release the installed key does not
cover and says so calmly: the version lies outside the update period, the installed version
keeps working, and the newest version within the period, if one is offered, installs as
usual. The updater installs only covered releases (announcing or planning another one is
refused with 409 `urn:restow:problem:update-not-covered`). Releases from before 0.4.5
publish no `released:` line; for them the update check uses their publication date, which is
never earlier than the date their images carry.

## When a version starts that the key does not cover

Updating by hand (`docker compose pull`, a new `RESTOW_IMAGE`) bypasses the update check.
Then the api of the new version checks the installed key **before it applies any database
migration** (the container entrypoint runs `ee/api/src/license/startup-check.ts` ahead of
the migrations). If a Business or Service Provider key is installed and does not cover the
version, the api does not start, writes nothing to the database, and its log names the
version, its release date, the end of the update period and the last release date the key
covers, for example:

```
{"level":"error","component":"license","message":"Version 1.8.0 (released 2028-03-01T09:00:00.000Z) is not covered by the installed Business licence key; its update period ended on 2027-11-30: releases made up to 2027-11-30T23:59:59.999Z are covered. The api does not start and has not touched the database (no migration ran). ..."}
```

Nothing needs to be restored: no migration ran. Either

- go back to the version you ran before (put the previous tags back into `RESTOW_IMAGE` and
  `RESTOW_WEB_IMAGE`, `docker compose up -d`), or any version the key covers, and install a
  renewed key there; or
- start this version as **Community**: set `RESTOW_RUN_AS_COMMUNITY=1` in `.env` and run
  `docker compose up -d`. The Business and Service Provider modules stay off, nothing is
  changed or deleted (archives, legal holds and further tenants stay in the database,
  untouched), and the licence page says why. Installing a key that covers the version turns
  the modules on again at once; the variable then has no effect and can be removed.

The opt-in updater sees the api not start and puts the previous version back by itself
(docs/UPDATING.md, "When something goes wrong"); since no migration ran, no dump is needed.

The check never stops:

- an installation without a key, or the public demo;
- a key without update period (every beta licence, every key installed before 0.4.5) on any
  0.x or 1.x release;
- a development build (no release date or version in the image);
- a start whose database cannot be read (the migrations that follow report that).

`RESTOW_RUN_AS_COMMUNITY` has no effect while the installed key covers the running version.

## What does not change

- A key's `mailbox_limit` member keeps its meaning: none (reserved, issued as `null`).
- Restow never reads the clock to decide what works. The licence page uses it only to
  decide when to mention the end of the update period.
