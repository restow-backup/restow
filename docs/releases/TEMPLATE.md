<!--
Release notes template. Copy the section below to the top of CHANGELOG.md, under
the introduction and above the previous release, and fill in every part. The
CHANGELOG.md section is the single source: the release workflow checks it
(scripts/ci/check-release.mjs: the heading with a real date and every required
section, in this order) and builds the GitHub release text from it, completing
the Verification section with the smoke report of the pipeline run. Write for
the people who run Restow, not for developers: what changes for them, what they
have to do, what could go wrong. English, Keep a Changelog format, no emojis.

Rules:
- Every section stays, even when empty: write "None." rather than deleting it,
  so a reader can tell "nothing" from "forgotten". A section for a first release
  or a release without that kind of change says "None (first public release)."
  or "None." and nothing else.
- Inside Security, Added and Fixed: most important first. Group a long Added
  section with "####" headings (Backup, Archive, ...). Name the edition a
  feature belongs to (Community, Business, Service Provider) and where to find it.
- No one-liners like "misc fixes".
- A fix names its cause in one sentence and the issue number, if there is one.
- Security entries name the affected versions and link the advisory or CVE.
- Breaking Changes lists everything that behaves differently for an existing
  installation or its integrations (API, webhooks, CLI) with a migration guide.
- Upgrade Notes must match reality: if a migration runs, say so and how long it
  took on the verification installation.
- Known Issues states plainly what was not tested and what does not work yet,
  including anything the verification did not cover.
- Verification names every smoke check that ran and its result, the Microsoft
  365 development tenant it ran against (or that none was used), the date, and
  what was skipped and why. Never describe a skipped check as passed.
-->

## [X.Y.Z] - YYYY-MM-DD

Beta release. (Delete this line for a stable release.)

### Summary

Three sentences at most: what changes for the operator, and whether anything
needs their attention.

### Breaking Changes

Anything that behaves differently for an existing installation or its
integrations, with the migration path: what to change, in which order, and what
happens if it is not done. Otherwise: None.

### Added

New capabilities, with the edition they belong to and where to find them.
Otherwise: None.

### Changed

Changed behaviour that is not a bug fix: wording, layout, defaults, translations.
Otherwise: None.

### Fixed

What was wrong and why, in one sentence each, with the issue number if there is
one. Otherwise: None.

### Security

Fixed vulnerabilities and security-relevant changes. For each: what was
possible, who could do it, the affected versions, the advisory or CVE link, and
whether anything must be done beyond updating (rotate a secret, review the audit
log). Otherwise: None.

### Upgrade Notes

Kind of update (see [Updating](../UPDATING.md)): configuration only, new image,
or manual steps. Then, as far as they apply:

- The order of the steps, with the exact commands for manual steps.
- Database migrations: how many, and how long they took on how much metadata on
  the verification installation.
- New or changed environment variables (`NAME`: what it does, default, required
  or optional) and changes to `docker-compose.yml`.
- Expected downtime (containers restart, migrations run).
- Rollback: the previous tag plus `docker compose up -d`, or, when migrations
  ran, restoring the database dump taken before the update (migrations are not
  reversible).

### Known Issues

What does not work yet, what is limited, and what was not tested. Otherwise:
None.

### Verification

Which release smoke checks ran, against which installation and Microsoft 365
development tenant, on which date and platform: image build, migrations on a
fresh and on an upgraded database, health endpoints, passkey login, Microsoft
365 and IMAP backup and restore, journal receipt and chain verification,
standalone restore, storage targets, endpoint backup, mail import and export,
image and dependency scans. State the test suite counts and every check that was
skipped, partial or not run, with the reason.
