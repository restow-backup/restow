# Changelog

All notable changes to Restow are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Restow uses SemVer
from 1.0.0; before that, this file starts fresh at 0.1.0, the first public
release. Earlier internal iterations (0.300.0 to 0.304.0) built the features
this release describes but were never published and cannot be upgraded to this
release (see Breaking Changes); their history stays in the maintainer's
private repository.

## [Unreleased]

## [0.4.9] - 2026-10-31

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.9 is a patch release of 0.4.8: bug fixes and one security fix, no new feature and no
database migration. The security fix closes a leak in the audit log, where a tenant's
administrator could read the prices the provider had set for their tenant (Security). The other
fixes are about screens that said "nothing here" when they had only failed to load, the Recovery
readiness table that built every row at once on a large tenant, and the currency field of the
price settings.

### Breaking Changes

None. The integration API contract stays at 1.9.0. The one difference to see is the audit log:
anyone who is not a provider admin gets the entry `tenant.pricing.updated` with `details` set
to `null`, and no `mailboxPrice` or `storagePrice` in the details of any other entry (Security).

### Added

Nothing.

### Changed

Nothing beyond the fixes below.

### Fixed

- Recovery readiness: the table listed every object at once, so a tenant with thousands of
  mailboxes built thousands of rows, and its last row ran into the edge of the card. It shows 50
  rows, then "Load more" under the table (with the count shown); changing the state filter
  starts on the first page again.
- A card that fails to load no longer leaves a gap that reads as "nothing to report": the sum
  over all tenants on the start page of a provider admin and the pending enrollments of the
  machines page now say that they could not be loaded and offer a retry. The same holds for the
  account list of the restore explorer, the bell and the last runs in the panel of a job: a
  failed read no longer reads as "No matching account", "Nothing new" or "No run yet".
- Prices: the currency field sits under its label, not beside it (the label is a block of its
  own now).
- The price settings section asks for nothing and shows nothing when it is mounted for anyone
  who is not a provider admin.

### Security

- Audit log, prices: the audit entry of a changed tenant price (`tenant.pricing.updated`,
  written since 0.4.8, when per-tenant prices came in) carries the tenant's stored mailbox and
  storage price before and after the change. The entries of a tenant's chain are readable by
  that tenant's administrator, and nothing took the details out: they were shown in the audit
  log viewer, in `GET /api/v1/audit` and `GET /api/v1/audit/:id`, and in the JSON and CSV
  export. So a tenant's administrator could read the prices the provider had set for their own
  tenant, which are the provider's business figures and meant for the provider team only. Only
  the prices of the reader's own tenant were exposed: no other tenant's prices, and not the
  installation's prices (their entry, `settings.pricing.updated`, is in the provider's chain).
  Only 0.4.8 is affected, and only where an owner had given a tenant prices of its own (Service
  Provider edition); 0.4.7 has no per-tenant prices.
- Anyone but a provider admin now gets that entry without its details, and no price figure
  (`mailboxPrice`, `storagePrice`) in the details of any other entry, in the viewer, both
  endpoints and both export formats. The entry itself and its hash check stay: the hash is
  checked against the stored entry before the details are taken out, so the chain still reads as
  valid, and the stored entries are not changed. Provider admins see everything as before. Tests
  state it for a provider admin, a tenant's administrator and a tenant's end user, and the other
  routes that serve a price (settings, estimate, a tenant's own prices, usage) are tested to
  refuse everybody but the provider team.

### Upgrade Notes

New images; no database migration, no new or changed environment variable, and the
`docker-compose.yml` of 0.4.0 stays. Pull the images of 0.4.9 and restart as for any update.

- restow-pve and the agents need no update in this release (no change to the agents or the
  Proxmox VE plugin).
- Nothing has to be rotated or rewritten: the fix changes what the api hands out, not what is
  stored. If you gave tenants prices of their own under 0.4.8 and want to treat them as seen by
  that tenant's administrators until now, that is the extent of the exposure (Security).

### Known Issues

- The known issues of 0.4.8 still apply.

### Verification

Before the tag, on the release branch (0.4.8 plus the fixes above, taken from the 0.5.0 work):
lint, build of the libraries and typecheck of all workspaces; the unit tests of the audit log's
price redaction and the Postgres test through the real application (a tenant's administrator,
its end user and the provider admin on `/audit`, `/audit/:id` and the JSON and CSV export,
including the hash check; the Postgres test fails with the fix taken out); the route test and
the Postgres test of who may read or change a price; the web DOM tests of the price cards and
settings, the bell, the restore explorer's account list, the job panel, the pending enrollments
and the Recovery readiness paging; the i18n tests; the install script's test
(`deploy/install/test.sh`, 679 checks), the release check (`scripts/ci/check-release.mjs --tag
v0.4.9`) and the third-party notices (unchanged). The full suites of every package were not
rerun for the patch.

## [0.4.8] - 2026-10-30

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.8 shows on the start page what runs right now and what each tenant comes to. The new
widget "Running now" lists every backup, restore and restore check of the moment with its speed,
live, for one tenant and across all tenants. A provider admin sees the monthly price beside the
last successful backup and the total over all tenants, and with the Service Provider edition the
owner can give a tenant prices of its own. An IMAP account whose login keeps being refused no
longer fails every night without a word: it asks the admin whether it was shut down, and once
the admin says so it is no longer backed up, its login is tried once a week and it resumes by
itself when a login works again. Mailboxes, OneDrives, sites, groups and IMAP accounts that no
enabled job covers any more read "In no backup job" instead of "The latest backup is too old".
The protected objects get "Back up now" in the row menu, a "Backup" column, a panel for the
checked objects and the end of a scroll bug. zod 4 closes the last advisory the dependency audit
ignored, and a sizing guide with adjustable database pools helps with large installations. Two
database migrations (Upgrade Notes).

### Breaking Changes

`withoutJob` in the readiness summary (`readiness` of `GET /api/v1/status`, and
`GET /api/v1/verify/latest`) changes its meaning: it counted servers and clients in no backup
job, and now also counts the mailboxes, OneDrives, SharePoint sites, groups and IMAP accounts
that no enabled backup job covers any more but that keep a backup. The new `objectsWithoutJob`
says how many of them it holds. An integration that reads `withoutJob` as machines only should
subtract `objectsWithoutJob`. Such objects are no longer rated by the age of their last backup,
are never overdue and raise no `backup.overdue` alert. The new `inJob` on an object's readiness
(`GET /api/v1/objects`, `/users`, `/verify/latest`) is false for every active object that no
enabled job covers; `withoutJob` counts only those of them that keep a backup, while one without
any backup stays `no_backup` and can still turn overdue.

Nothing else changes in a breaking way. The integration API contract moves from 1.7.0 to 1.9.0,
otherwise additively: `statusReason` of `GET /api/v1/objects`, `/users` and `/jobs` can also be
`login_refused`, and `GET /api/v1/objects` carries `loginQuestionAt`; clients that handle
`statusReason` exhaustively should accept the new value. `objects.orphaned` of `GET
/api/v1/status` includes the IMAP accounts confirmed as shut down. The events `object.inactive`
and `object.inactive_many` can carry `details.question = "login"`, and provider alerts know
`objects_without_job` and `login_question`. With zod 4 the api accepts identifiers only as RFC
9562 UUIDs (version 1 to 8): an id of another shape, which no Restow object has, is refused as
an invalid request instead of not being found. The problem answers and the generated OpenAPI
document of `/api/v1` are not changed by zod 4; the document changes only by the additions
above.

### Added

- Protected objects: the "..." menu of a row has "Back up now". It backs up exactly that object,
  the same way as on the backup page, and gives the same notices (queued, already queued,
  failed). It is closed with the reason for an IMAP account without a password, a source that is
  disabled or not connected yet, and an object that is already queued or running; objects that
  are excluded or no longer backed up do not offer it (a shut-down IMAP account does, see
  below). Who may use it is decided by the server, as on the backup page.
- Protected objects: a "Backup" column says for each object whether it is included in or
  excluded from the backup, and below it whether the source's rules decided that ("by rule") or
  an admin did ("manual": "Always included" or "Always excluded", and every IMAP account). It
  replaces the small override badge under the name. An object that is no longer backed up shows
  a dash: its status says why.
- IMAP: an account whose password login keeps being refused no longer fails every night without
  a word. After 3 counted refusals over at least 24 hours (at least 6 hours apart for backup
  runs, so retries count as one, and at least 20 hours apart for archive capture passes, which
  would otherwise outrun the nightly backup) the account asks "Login refused since <date>. Was
  this account shut down?" (docs/IMAP.md "Anmeldung abgelehnt: Konto abgeschaltet?"). The
  account stays active and red until an admin answers. "Yes, shut down" turns it grey
  "Intentionally no longer backed up" (never overdue, no `backup.failed`, no `job.failed`,
  backups kept); "No, fix the login" keeps it protected, opens the password dialog (or points at
  the source) and is not asked again until a login works, a password or the source's login
  changes, or 90 days pass. Only the answer sets the state: a database check allows the new
  reason `login_refused` for an IMAP account that is orphaned and confirmed, and nowhere else.
  Counted are refused password logins of active accounts only, from backups and archive capture
  (a refused weekly probe of a shut-down account only sets the next probe); server limits,
  network errors, a missing password and OAuth2 sources (Microsoft, Google) are not. The
  question appears at the account, in a banner and under the filter "Login refused: answer
  needed" (`?status=login_question`), as the events `object.inactive` and `object.inactive_many`
  with `details.question = "login"` (one mass warning instead of many notices above 10 accounts
  or 20% a day) and, for providers, as the alert `login_question` ("answer needed") per tenant
  while questions are open. A bulk "Yes" in the list shows the sources and warns when the login
  fails for almost the whole source (check its password first). Audit:
  `directory.login.question_raised`, `directory.login.dismissed` and `directory.login.restored`;
  the answer "Yes" is the existing `directory.inactive.confirmed` with `details.via =
  "login_question"`.
- IMAP: a shut-down account resumes by itself. The scheduler checks its login once a week,
  independent of the job schedules (also for accounts only in an archive job or in no job). The
  probe is a normal backup run that logs in first: it ends neutral when the login is still
  refused, and carries on into the backup, with the account active again, when it works. A new
  password (single, CSV import or the source's), "Test login", "Back up now" and "Include"
  resume the account at once (while the source awaits its test or is paused, the scheduler's
  check follows as soon as it is usable, so no job is refused); "Exclude" stops the probes.
- Start page: the new widget "Running now" ("Läuft gerade") shows what is being copied or
  backed up this moment: every run that goes on (Microsoft 365 mailboxes, OneDrives,
  SharePoint sites, groups, IMAP accounts, machines with the agent, Proxmox VE guests and file
  shares, and their restores and restore checks) with its object, its kind, how long it has
  gone on, the items and bytes so far, its speed and a small line of that speed over the last
  five minutes. One graph above the runs adds the speeds up (the graphs have a text for screen
  readers: the figures now, on average and at most). The widget moves with the live channel,
  without a request of its own: the channel now also carries the runs of Proxmox VE guests
  (the event `pve_run`, in the snapshot as `pveRuns`, read every second poll with the node's
  last progress report). The graphs are buffered in the browser: a run that carries no
  measurements adds one point for each new report, dated by the report, not one for every look
  of the page. A Proxmox VE node that stops reporting loses its speed after 20 seconds in the
  row, the total and the graph, though its run stays listed; with no speed reported at all the
  graph says "No throughput reported yet" instead of drawing a flat line. The widget lists 50
  runs per tenant and says when more go on, in the live view too (only backups, restores and
  restore checks count: an active export or maintenance job neither uses up the limit nor
  makes a tenant look busy). While the live connection is off or lost the widget keeps the
  last known state and says so; before the channel has spoken it shows the state of the page's
  own request. With nothing running it says "Nothing is running right now" and when the next
  planned backup starts. Only administrators see it (`running` in `GET /api/v1/dashboard`).
- Start page, "All tenants": the same widget lists what runs in every tenant, with the tenant of
  each run (a click switches into it) and the next planned start over all of them. It asks the
  new `GET /api/v1/tenant-running` every 10 seconds while the tab is in front; the server reads
  each tenant in its own transaction, a few at a time, and keeps an answer for 8 seconds for all
  viewers. Provider admins only; a member of the provider team limited to some tenants sees
  those only.
- Dashboard › Status: for a provider admin whose installation has a price (the tenant's own
  counts), the row of "Readiness" and "Last successful backup" gets a third card, "Price per
  month", always beside the last backup, never below it. On a wide page all three stand in one
  row; where the last backup's list would not fit a third of it, readiness takes the row above
  and the two cards share the row below; on a phone they stack. It shows the total per
  month, one line per price (quantity × price = amount), "Custom price" where the tenant has its
  own, the way to the prices and, for the owner, to this tenant's prices. Figures that are not
  available yet read "Figures not available yet" instead of the card disappearing. Without a
  price, and for everybody else, the row is unchanged.
- Dashboard under "All tenants": a card above "Running now" with the monthly total over all
  customers at their prices, the five tenants with the highest amounts (a click switches into
  the tenant), "+N more", and a note when the figures of some tenants are not available. The
  own organisation is not counted. Only for provider admins, only once a price is set.
- Prices per tenant (Service Provider): the owner can give a tenant its own price per mailbox,
  its own price per GB or TB, or both, in a dialog opened from the tenant's price card ("Prices
  for this tenant"). A field left empty ("Use installation price") takes the installation's
  price again; the currency and the unit stay the installation's. Without a key for several
  tenants (the feature `tenants.additional`) the dialog is not offered, the change is refused
  with the feature-unavailable problem and stored prices are ignored, so the installation's
  prices apply everywhere; they apply again when the feature is back. `GET` (provider admins
  within their tenants) and `PUT` (owner only; body `mailboxPrice` and `storagePrice`, a number
  from 0 to 1,000,000 with at most four decimals, or `null` to remove) on
  `/api/v1/tenants/:id/pricing` answer the stored prices, the installation's and the ones that
  apply. Every accepted change is audited as `tenant.pricing.updated` in the tenant's chain with
  the stored prices before and after. Installation › Prices lists the tenants with their own
  prices, with a link to each, and says where to set them.
- `GET /api/v1/settings/pricing/estimate` (every provider admin; one with only some tenants
  gets those) is the one source of every price card: per tenant the protected mailboxes (the
  counting rule of `GET /api/v1/usage`), the stored bytes (the dashboard storage widget's
  figure, chunk store plus repositories), the price that applies, the amounts and the total,
  and over all customer tenants a total and the number of tenants whose figures could not be
  read. `?tenant=<id>` answers for one tenant. A tenant without any price is not read at all;
  the figures are kept for 30 seconds, prices are always read fresh. Tenants being deleted are
  left out. Amounts are not rounded.
- Database pools: the size of the Postgres pools is set by `RESTOW_DB_POOL_MAX` (application
  pool of api, worker and scheduler), `RESTOW_DB_PROVIDER_POOL_MAX` (installation pool) and
  `RESTOW_DB_BOSS_POOL_MAX` (pg-boss's own pool in worker and scheduler). Each defaults to
  10, the old fixed value, so nothing changes for an installation that sets nothing. A value
  that is not a whole number from 1 to 500 stops the process at start with a message naming
  the variable (the api reports it and exits instead of failing with a stack trace). The
  worker warns at start when `RESTOW_DB_POOL_MAX` is smaller than
  `WORKER_CONCURRENCY` + 2, because its jobs would then wait for a connection. Listed in both
  `.env.example` files.
- docs/SIZING.md: a sizing guide for large installations. It covers the backup concurrency
  settings, Microsoft Graph throttling per tenant, the database pools, Postgres settings
  (`max_connections` above the sum of all pools), CPU, RAM, disk and bandwidth, first-backup
  estimates and a worked example for 2,000 seats, with recommended server sizes. It says
  what comes from the code and what is estimated: nothing in it was load-tested.

### Changed

- Protected objects: the actions for checked objects no longer sit in a bar above the table.
  From the large breakpoint on they appear in a panel in the free space at the bottom of the
  tenant's section column, as soon as one object is checked; on smaller screens in a bar at
  the bottom of the screen. The panel offers the same actions with the same confirmations
  (include, exclude, follow the rules again, "Yes, intended", a new job or an existing job with
  the selection, select all matching), announces the count to screen readers, and Escape clears
  the selection. Row checkboxes are named "Select <name>" instead of "Actions for <name>".
- The api and the web UI validate with zod 4 (Dependabot #86). Nothing changes for clients: the
  problem answers keep their `issues` (codes, fields and messages as before), and the generated
  OpenAPI document of `/api/v1` is identical. Identifiers must now be RFC 9562 UUIDs (version 1
  to 8), which every id Restow creates is.
- Recovery readiness: a mailbox, OneDrive, SharePoint site, group or IMAP account that no
  enabled backup job covers any more (taken out of a job that names its objects, or named by a
  disabled job only) is no longer rated red with "The latest backup is too old". Like a VM or a
  file share in no job it reads "In no backup job" in the readiness table, the protected
  objects, the dashboard and the reports: it is rated by whether its newest backup restores, not
  by that backup's age, it is never overdue (no `backup.overdue` alert), and it keeps the tenant
  from green (yellow, red when that backup does not restore). Its last backup still gets one
  restore check if it never had one, planned from the job-level restore check schedule of an
  enabled mail job (a mailbox's own schedule does not count); a tenant whose enabled mail jobs
  have none, or that has no enabled mail job, keeps the object "unverified" until a check is
  started by hand. An object without any backup keeps "No backup yet" (red), and no
  `backup.overdue` alert is raised for it. The dashboard and the provider view count these
  objects apart from the machines. The integration API contract moves to 1.8.0: new are `inJob`
  on the readiness of an object (`GET /api/v1/objects`, `/users`, `/verify/latest`) and
  `objectsWithoutJob` in the readiness summary. The value of `withoutJob` in the readiness
  summary changes: it counted servers and clients only, and now counts these objects too
  (`objectsWithoutJob` says how many of them they are).
- The integration API contract moves to 1.9.0, additively: `statusReason` of `GET
  /api/v1/objects`, `/users` and `/jobs` can also be `login_refused` (an IMAP account whose
  login is refused and that an admin confirmed as shut down; clients that handle `statusReason`
  exhaustively should accept it), and `GET /api/v1/objects` carries `loginQuestionAt` (null
  while no question is open). `objects.orphaned` of `GET /api/v1/status` includes such accounts,
  `readiness.toConfirm` does not (they are confirmed). No API key can answer the question.
- "Back up now" (the row menu and the backup page) is allowed for a shut-down IMAP account: the
  run probes the login and backs the account up when it works. Restoring "to the original
  account" says the account is shut down; restoring into another account or downloading works as
  before.
- The price card of the tenant's overview takes its figures from the server's estimate instead
  of adding them up in the browser, so it shows what the dashboard shows. It marks a price of
  the tenant's own ("Custom price"), reads "Figures not available yet" instead of disappearing
  while a figure is missing, and gives the owner the way to this tenant's prices. Where tenants
  may have prices of their own, the owner also sees the card on a tenant without any price, to
  set the first one.

### Fixed

- Protected objects: after checking a row near the end of the list, the first swipe up over the
  table did nothing. The pinned name column's shadow reached 1px below the table, which let the
  table scroll 1px vertically and swallow the gesture; this affected every table with a pinned
  column. Checking a row also no longer moves the rows under the pointer (the actions bar used
  to appear above the table), and no longer rebuilds every cell of the table, which dropped
  keyboard focus and closed open tooltips and menus on each check.
- Tables with a pinned column on the page background (protected objects among them) no longer
  look two-toned: the pinned name column was white while the other cells let the page show
  through. The table takes the pinned column's surface.

### Security

- zod 4.6.7 (from 3.25) validates the requests of the api and the web UI. It resolves
  GHSA-mrhx-c7xc-m3w5 (memory use when validating a large array) for Restow's own code too, so
  the audit of CI no longer ignores any advisory: `pnpm.auditConfig` and the zod override are
  gone from the root `package.json`.

### Upgrade Notes

New images and two database migrations; no new required environment variable, and the
`docker-compose.yml` of 0.4.0 stays.

- Two database migrations run at the api's start; neither rewrites a table:
  - 0070 adds six columns to `protected_objects` (`login_failed_runs`, default 0, and five
    nullable timestamps) and three check constraints (among them the one that allows the reason
    `login_refused` only for an IMAP account an admin confirmed as shut down, orphaned and with
    a next probe date), widens the reason check of 0069 by `login_refused` and replaces the
    trigger function of 0069. The checks are validated against every row of `protected_objects`,
    which reads the table a few times under its lock on a large installation; nothing is
    rewritten.
  - 0071 adds the column `tenants.pricing` (`jsonb`, default `{}`: no price of its own); every
    tenant keeps the installation's prices until the owner sets its own.
- Nothing is asked right after the update, and refusals from before it are not counted: an IMAP
  account asks whether it was shut down after 3 counted login refusals over at least 24 hours,
  so on the third night of failing logins with a nightly job, about a day after the first one
  with a job that runs several times a day. Expect one `object.inactive` notice per account (or
  one `object.inactive_many` warning for many) for accounts whose password has really stopped
  working, and answer them under protected objects. Webhooks and recipients get these notices
  only where the events are ticked in the notification matrix, as in 0.4.7.
- Mailboxes, OneDrives, sites, groups and IMAP accounts that no enabled job covers any more
  (taken out of a job that names its objects, or named only by a disabled job) and that keep a
  backup read "In no backup job" instead of red "The latest backup is too old" from the update
  on. They are rated by whether their newest backup restores (green or red), never by its age;
  one whose newest backup was never checked reads "unverified" until a restore check runs
  (Changed). The tenant stays yellow while any of them keeps a backup. To clear it, put the
  object back into an enabled job, enable its job, or exclude it. `withoutJob` of the readiness
  summary grows by these objects (Breaking Changes).
- New optional environment variables `RESTOW_DB_POOL_MAX`, `RESTOW_DB_PROVIDER_POOL_MAX` and
  `RESTOW_DB_BOSS_POOL_MAX` (default 10, as before; a whole number from 1 to 500). Raise them
  only together with Postgres' `max_connections` (docs/SIZING.md); a value out of range stops
  the process at start with a message naming it. The worker warns at start when
  `RESTOW_DB_POOL_MAX` is smaller than `WORKER_CONCURRENCY` + 2.
- Integrations: the contract moves from 1.7.0 to 1.9.0 (Breaking Changes). The weekly login
  probe of a shut-down IMAP account, and "Back up now" while its login is still refused, appear
  in `GET /api/v1/jobs` as `failed` with `failure.code` `config.object_inactive` (the object's
  `statusReason` is `login_refused`); they raise no `backup.failed` alert and no `job.failed`
  webhook. Treat them like the object's state, not as a failure.
- Providers: the provider view can show two new tenant alerts without any action:
  `objects_without_job` at once for each tenant with objects in no enabled job, and
  `login_question` while IMAP login questions wait for an answer.
- Prices per tenant need the Service Provider edition (`tenants.additional`); without it the
  dialog is not offered and the installation's prices apply everywhere.
- restow-pve and the agents need no update in this release (no change to the agents or the
  Proxmox VE plugin).
- Rollback to 0.4.7 after the migrations was not tested: take a database backup before the
  update and restore it to go back.

### Known Issues

- docs/SIZING.md was not load-tested: its figures come from the code's limits and from
  estimates, and it says which is which.
- "Running now" names as the next planned start the earliest start of any enabled job, a copy
  job's included, so it can name a copy job instead of a backup.
- For a provider admin on an installation with a price, the status row of the start page grows
  from two cards to three on the first load of a session once the prices are read. A later
  switch of tenant keeps the row, except where the installation has no price and only some
  tenants have their own: then the price card comes and goes with the tenant.
- Protected objects on a phone: the "Backup" column is reached by scrolling the table sideways,
  and at the very end of the page the bar for checked objects stops a little above the bottom
  edge.
- The question "Was this account shut down?" was tested against a test IMAP server, not against
  the login refusals of real mail providers: a refusal a server words as a temporary error is
  not counted. OAuth2 IMAP sources are never asked.
- The rating of objects in no backup job also applies to earlier days: only the current job
  coverage is stored, so the readiness history rates such an object as "In no backup job" for
  days when a job still covered it. On the Recovery readiness reports list a filter on the
  rating matches the stored rating, which counted the backup's age, so a report of such an
  object can be listed under red while it reads green (as in 0.4.7 for objects removed from
  their source).
- The known issues of 0.4.7 still apply.

### Verification

Before the tag, on the release branch (0.4.7 plus the 0.4.8 work): lint and typecheck of all
workspaces, the unit and Postgres suites of every package on Postgres 16 (with the Postgres
guard), among them migrations 0070 and 0071, the login-refusal counting, question, probe and
resume of IMAP accounts, the readiness of objects in no job, the running widget's api and live
channel, the price estimate and the prices per tenant with their audit, owner and edition rules;
restic-backed tests with restic 0.19, the web DOM tests, the v1 OpenAPI test (the document
generated under zod 4 was also compared once with the one before it: identical), the tests of
the CI scripts and the third-party notices. The start page widgets, the price cards and the
protected objects were checked in a browser against mocked answers (light and dark, desktop and
phone). The IMAP question was not run against a real mail provider before the tag, and the
sizing guide was not load-tested.

## [0.4.7] - 2026-10-29

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.7 makes Microsoft 365 backups steadier. Mailboxes of disabled or unlicensed accounts
and OneDrives and sites that Microsoft locked are marked "Not backed up" with the reason instead
of failing every night, and every object Restow stops backing up waits amber for an admin's
confirmation. Backups that Microsoft Graph or the storage held back no longer count as failed, a
permission granted to the app takes effect without a new client secret, and one queued backup
can no longer block the backup queue of every tenant. Reminders go out before the client secret
or certificate of an app registration expires, and many errors of mailbox, OneDrive,
SharePoint and IMAP backups and restores now cost an area or an item instead of the whole run.
Proxmox VE VMs and containers can be excluded from backup on purpose, and the inventory shows
what a guest's first and follow-up backups store as text (#58). The recommended job can switch
the mail archive on, and the owner of the installation can enter monthly prices that each
tenant's overview turns into an estimate for the provider. Four database migrations (Upgrade
Notes).

### Breaking Changes

`status: "orphaned"` now also covers objects that are still at the source but are no longer
backed up (account disabled, no licence, or locked by Microsoft): before, it meant removed from
the source. This applies in `GET /api/v1/objects`, `GET /api/v1/users`, the `object.status` of
`GET /api/v1/jobs` and `objects.orphaned` of `GET /api/v1/status`. The new `statusReason`
(`account_disabled`, `no_license`, `locked`, null for an object removed from the source) of
`GET /api/v1/objects`, of the `object` of `GET /api/v1/jobs` and of the objects of
`GET /api/v1/users` tells them apart. An integration that treats `orphaned` as a deleted
account should check `statusReason` before it acts.

Nothing else changes in a breaking way. The integration API contract moves to 1.7.0, additively.
In `GET /api/v1/users` the objects also carry `inactiveSince` and `statusConfirmedAt`, and a
user's `recoveryReadiness` reads at least yellow (never green) while one of its objects waits
for a confirmation (yellow instead of null when such an object has no backup to rate). The
readiness summary of `GET /api/v1/status` and `GET /api/v1/verify/latest` reports `toConfirm`;
`GET /api/v1/status` leaves excluded Proxmox VE guests out of `guests.total` and
`guests.withoutJob` and reports them as `guests.excluded`. `POST /api/v1/jobs/backup` can skip
an object with the reason `inactive`, the `job.completed` and `job.failed` webhooks of a
completed restore carry `data.job.result`, and alerts (`report.alert`) can name the new events
`object.inactive`, `object.inactive_many`, `source.app_secret_expiring` and
`installation.app_secret_expiring`; clients that handle skip reasons or event names exhaustively
should accept the new values. Some values follow new rules: backups held back by a service and
objects no longer backed up raise no `job.failed`, objects removed from their source are rated
without the age of their last backup, and `objects.failed` of `GET /api/v1/status` leaves out
objects whose latest backup was held back by a service or ended neutral for an object no longer
backed up; the run before it counts instead (Changed, Fixed, Upgrade Notes).

### Added

- Microsoft 365: objects that are no longer backed up because the source says they are gone,
  disabled, unlicensed or locked first read amber "Not backed up any more, please confirm" with
  reason and date (docs/MICROSOFT.md "Nicht mehr gesichert: Bestätigung"). No failure, no red,
  not overdue, but they keep the warnings, the dashboard and the tenant's readiness at least at
  yellow (never green), are counted in the integration API's `readiness.toConfirm`, and
  providers see `inactive_to_confirm` among a tenant's alerts, until an admin confirms "Yes,
  intended": per object, or for several in the list by selection or by the list's filter (at
  most 1000). Through the API (`POST /api/v1/directory/objects/:id/inactive/confirm`,
  `POST /api/v1/directory/objects/inactive/confirm`) a confirmation can carry an optional note
  (up to 1000 characters) for the audit log; the interface does not ask for one. Tenant
  administrators and provider teams with configure rights may confirm; each
  confirmation is audited (`directory.inactive.confirmed`, `directory.inactive.bulk_confirmed`).
  Confirmed objects read grey "Intentionally no longer backed up", with who confirmed it and
  when. When the object becomes active again, the confirmation is dropped and backups resume;
  if it stops again later, Restow asks again. An excluded object that disappears from the
  source was never backed up and counts as confirmed. The list of protected objects filters by
  `to_confirm` and `confirmed`. Migration 0069 stores the state.
- Notification events `object.inactive` (a notice, once per object and transition, in the bell
  by default) and `object.inactive_many` (one warning per tenant and day instead of the
  notices, when more than 10 objects, or more than 20% of the tenant's objects backed up before
  and at least two, stop being backed up within a day; part of the "Errors and warnings"
  choice). Both link to the protected objects waiting for a confirmation. Neither has an event
  of its own in the webhook stream (`job.*`); a webhook gets them as `report.alert` once they
  are ticked in the matrix.
- Microsoft 365: reminders before the client secret or certificate of the central app
  registration expires (docs/ENTRA-SETUP.md, Teil 3, "Ablauf und Erinnerungen"): 30 days
  before, again 7 days before and once it has expired, each stage once per expiry date. A new
  date or another registration starts over; a date first seen late raises only the stage it is
  in, not the earlier ones. The api checks every 15 minutes (the first time two minutes after it
  starts; not in the public demo) and raises the new installation event
  `installation.app_secret_expiring` (a warning, an error once expired) for the provider
  administrators: in the bell, and in the mails and webhooks of every rule that lists it. The
  date is the one entered under Installation › Microsoft multi-tenant app,
  `ENTRA_CLIENT_SECRET_EXPIRES_AT` for a secret from the environment, or the certificate's own
  end (`notAfter`). Restow does not read it from Microsoft Graph, which would need
  `Application.Read.All`. The last reminder is kept in `settings.app_secret_alerts` (migration
  0068) and claimed under a row lock, so neither a restart nor a second api replica repeats it.
- Microsoft 365: the same reminders for a source connected through its own app registration
  (docs/ENTRA-SETUP.md "Alternative: eine eigene App pro Quelle"), as the new event
  `source.app_secret_expiring` among the job events, so tenant administrators can choose it as
  well. The worker checks every Microsoft 365 source of an active tenant that is not disabled
  (also one in error) every five minutes; a certificate counts by its own end, a client secret
  by the date noted for it. "Own Graph app" takes the secret's expiry date ("Secret expires
  on", optional, as Entra shows it under Certificates & secrets), and the source's connection
  card shows "Expires" with the expiry badge and, within 30 days or once expired, what to do.
  For a secret the date can be noted, changed or removed there without entering the secret
  again ("Note expiry date", "Change expiry date"; `PATCH /api/v1/sources/:id/own-app/expiry`,
  audited as `source.own_app.expiry_updated`, for tenant administrators and provider roles that
  may configure). A new secret, a new certificate or a changed date starts the reminders over;
  saving the same date again does not.
- Both expiry events name their stage in the bell ("expires in 5 days", "Renew it now", "has
  expired") and lead to the source's page or to Installation › Microsoft multi-tenant app. The
  alert mail lists the expiry date, the days left, the kind of credential, the application
  (client) ID and how to renew it without a gap (create the new secret, enter it with its new
  date, only then delete the old one in Entra); chat webhooks of `source.app_secret_expiring`
  link to the source's page. Both events are part of the "Errors and warnings" choice and of
  the bell's default, and each stage passes a rule's throttle on its own.
- Restores that did not restore anything: a completed restore with failed items and none
  restored reads "Nothing restored" (red) and raises `restore.failed` and the `job.failed`
  webhook, with "Nothing was restored: N items failed." as its error; one that skipped every
  item reads "Everything skipped" (amber) and stays `restore.completed`, saying so instead of
  claiming it restored something (info, not success, in chat channels). The `job.completed`
  and `job.failed` webhooks of a completed restore carry its counters in `data.job.result`
  (`restored`, `skipped`, `failures`, `unverified`).
- Proxmox VE: an admin can exclude a VM or container from backup on purpose (docs/PVE.md
  "Excluding a guest"), for test VMs or guests backed up elsewhere: "Exclude from backup" on
  the guest's page, or for a selection of a node's guests in the inventory; "Include again" on
  the page and in the guest's inventory row takes it back. Tenant administrators and the
  administrators of the provider team may do so. No job backs an excluded guest up, not even
  the job for all guests, and the recommended job leaves it out; its own job stays recorded,
  so including it again restores what it had. Excluding withdraws its queued backups (one
  already handed to the node gets a cancel request, a running one ends as it would); a backup
  queued in the same moment is withdrawn at the node's next heartbeat, before the node gets it,
  and shows in History as a cancelled run with "The guest was excluded from backup before it
  started." "Back up now" and putting the guest into a job are refused (409
  `urn:restow:problem:pve-guest-excluded`) until it is included again; taking it out of its
  job stays possible. Its restore points stay restorable, retention treats them as before and
  the weekly restore check of its newest restore point goes on; the job's monthly restore test
  and boot tests no longer cover it. New route `PUT /api/v1/pve/guests/:id/excluded`
  (`{ "excluded": true }` or `false`), audited as `pve.guest.excluded` with the number of queued
  backups withdrawn before reaching the node (one already handed to the node is not counted);
  excluding a guest twice changes nothing. `GET /api/v1/pve` reports `excludedAt` and
  `excludedBy` per guest (migration 0066).
- Proxmox VE: excluded guests count nowhere as unprotected: not in the overviews, the recovery
  readiness, the warnings, `backup.overdue`, the statistics, the job counts of the all-tenants
  view or the provider view, and they never keep a tenant from green. The guest counts report
  them as `excluded`; their restore points stay in the count of restore points and their
  earlier runs in the history. In VMs & containers an excluded guest reads "Excluded" (grey,
  never a problem, whatever its earlier runs said), matches only the new state filter
  "Excluded" and sorts after every problem. The inventory shows "Excluded: N" per node, the
  guest's detail panel says "Excluded from backup" under its job, which cannot be changed
  there, and the job dialog no longer offers excluded guests.
- Recommended job with the mail archive (docs/ARCHIVE.md "Archiv im Mail-Job"): while the
  installation offers capture from the mailbox (`archive.mailboxCapture`) and the tenant has
  mailboxes or accounts an archive can capture, "Create recommended job" and "Protect
  everything without a job" make the new mail job over all objects back up and archive. A mail
  job over all objects that exists and does not archive yet is switched to archiving instead
  ("Switch archiving on in …"); its schedules stay, and the change is audited as
  `backup_job.updated` with `changes.archive`, like an edit in the job editor. The click uses
  the default capture ways, which need nothing set up in the tenant: Microsoft Graph for
  Microsoft 365 mailboxes, IMAP sync for the other accounts. Journaling and forwarding stay a
  choice in the editor. Without the capture the recommended job is made as before.
- The recommended job never changes a mail job over selected objects; its preview names them
  ("Archiving stays as it is in …"). A mail job over all objects whose capture ways were
  chosen by hand (Microsoft Graph or the IMAP sync switched off, for example journaling only)
  is left as it is, and the preview says so. A new job over all objects is made only when it
  covers something that is in no job yet. The dialog says when the job over all objects archives
  already, the confirmation names the jobs in which archiving was switched on apart from the
  jobs set up, and the preview of a paused job names no schedule.
- The list of mail jobs shows "Switch archiving on" while the installation offers the capture
  and the recommendation would switch an archive on in the mail job over all objects (not for
  tenants with only OneDrives, SharePoint sites or groups, nor for jobs whose capture ways were
  chosen by hand).
- Installation › Prices: a monthly price per mailbox and per GB or TB of stored backups, in
  EUR, CHF, USD or GBP (docs/ARCHITECTURE.md "Mandantenmodell"). Mailboxes are counted as in
  the mailbox usage (a OneDrive does not count twice); storage is the tenant's stored backups,
  deduplicated and compressed, in decimal units (1 GB = 10^9 bytes, 1 TB = 10^12 bytes). Prices
  take at most four decimals; a price left empty is not shown. Provider admins with every
  tenant read them, only the owner changes them, audited as `settings.pricing.updated` with the
  values before and after (`GET` and `PUT /api/v1/settings/pricing`). Tenant users never see
  them.
- Each tenant's overview shows provider admins with every tenant a card "Price per month": what
  the tenant comes to at these prices, one line for the mailboxes and one for the storage, with
  a link to the prices. It appears once a price is set. Restow bills nothing and limits nothing.

### Changed

- Backups that Microsoft Graph or the storage held back no longer count as failed. A Mail &
  SaaS backup that ends, after all its retries, with `graph.throttled`,
  `graph.service_unavailable` or `storage.rate_limited` reads "Held back by the service,
  retried" in amber instead of "Failed" in red (in the objects list "Held back by the service")
  in every view: History, the all-tenants job
  overview, the objects list, the runs of a job, the job page, the recent jobs on the dashboard
  and the run details. It is left out of the failed counts of the statistics and the
  dashboard, does not make the job failing (the run before it stands), does not make a warning
  red or end its acknowledgement, and raises no `backup.failed` alert and no `job.failed`
  webhook. The next scheduled run tries again; an object held back for longer is caught by the
  overdue and readiness rules, which look at the age of the newest backup. A restore, export,
  import or check that a service held back has no next run and stays a failure, with
  `restore.failed` and the like.
- Microsoft Graph: a background job honours a Retry-After of up to 5 minutes (before, waits
  were capped at about a minute, and Exchange refuses a retry before its mailbox concurrency
  penalty is over); a cancelled or expired job still stops at once. Requests from the
  interface keep the one-minute cap.
- Overdue backups (`backup.overdue`): a mailbox member with a schedule of its own is judged by
  that schedule or by the tenant's mail jobs (the most relaxed one), whichever allows longer,
  for that member only; a weekly member
  of a daily job is no longer overdue two days after its backup. An object whose backup has
  started and is still running (up to 21 days, a large first backup) is not overdue; a backup
  that only waits in the queue does not hold the alert back.
- The expiry badge of the central app (Installation › Microsoft multi-tenant app) turns amber
  30 days before the end instead of 60 and red from 7 days, counted in whole calendar days
  (UTC); a source's own app shows the same badge. For a secret from the environment without
  `ENTRA_CLIENT_SECRET_EXPIRES_AT` the page says how to set it. The setup texts and
  docs/MICROSOFT.md say 30 days, 7 days and expired instead of 60 days.
- The job page names the phases of a SharePoint site backup ("Reading the site", "Lists") and
  of the discovery of sites and group mailboxes. The retention notes read "the newest restore
  point of each object is always kept" in the singular.
- Proxmox VE inventory (#58): the size of a guest's first backup ("First backup on <date>:
  <size> stored") and what a follow-up backup adds on average ("Average per follow-up backup:
  +<size> (last N backups)") are shown as text in the guest's row, not only in its tooltip, so
  they can be read and copied.
- Dependencies: better-auth 1.7.14, mailparser 3.14.1, nodemailer 10.3.1, smtp-server 3.21.3,
  msgreader 1.29.0, Biome 2.6.4, Vitest 5.0.5, Vite 8.3.5, React 19.3.1 and, in the release
  pipelines, docker/login-action 4.7.0 (Dependabot #82 to #85). pg-boss 10.4.2 carries a patch
  of Restow's (Fixed, Upgrade Notes). zod 4 (Dependabot #86) is not part of this release.

### Fixed

- Microsoft 365: a mailbox whose account is disabled or has no Exchange Online licence
  (mailbox not provisioned, licence removed, inactive mailbox) no longer fails its backup until
  the next directory sync ("Microsoft rejected the request"). The backup confirms with
  Microsoft that the user exists but has no mailbox, marks the mailbox "Not backed up: account
  disabled" or "Not backed up: no licence" and ends neutral (`graph.mailbox_inactive`): no
  failed count, no red readiness because of age, not overdue, no `backup.failed` alert or
  `job.failed` webhook, existing backups kept. The directory sync sets the same state from its
  mailbox probe. Only Exchange's answer counts: a disabled account whose mailbox Microsoft
  still serves (a shared mailbox, a former employee) is backed up as before. A 401 or 403 is
  never read this way; those stay permission failures. Backups resume right after the
  directory sync that finds the account enabled or licensed again, and the mailbox is not
  reported overdue because of its old backup. A restore into the original mailbox is refused
  with the reason (docs/MICROSOFT.md "Deaktivierte und unlizenzierte Konten").
- Microsoft 365: a OneDrive or SharePoint site that Microsoft locked (HTTP 423
  `resourceLocked`, "Access to this site has been blocked"; Microsoft does this to the OneDrive
  of an unlicensed account) no longer fails every night as "Microsoft rejected the request".
  The backup confirms the lock with one cheap read, marks the object "Not backed up: locked"
  (`graph.object_locked`, neutral, no retries) and the scheduler stops planning it. The
  directory sync's drive probe recognises the same lock and marks a known OneDrive "Not backed
  up: locked" at once, before a backup meets it. A 423 that
  this read does not confirm stays a counted failure with its `backup.failed` alert. A site
  whose libraries all answer 423 ends without a restore point instead of carrying old copies
  forward. The directory sync never turns a locked object active again just because it is
  still listed: it reads each locked drive or site once more and resumes the backup only when
  that read succeeds; otherwise it keeps the lock and reports that the check failed. A 423 on a
  single file stays an item problem (docs/MICROSOFT.md "OneDrive: Sichern und
  Wiederherstellen").
- Job queue: one queued backup of an object whose backup was still running (the next
  scheduled run, "Back up now") blocked the backup queue of every tenant until that backup
  ended, because pg-boss kept offering it first and handed out nothing. Such a job now waits
  for its object's running backup and lets every other backup pass (pg-boss 10.4.2 with
  patches/pg-boss@10.4.2.patch).
- Microsoft 365: a permission an administrator grants to the app after Restow fetched its
  token now takes effect without a new client secret. A token carries the app's permissions as
  they were when it was issued, and Restow kept it until shortly before it expired (up to about
  an hour), so a permission granted in between was refused until then or until a new secret
  was entered. When Graph answers 401 or 403, Restow now fetches a new token once and sends the
  request again, at most once a minute per tenant or source, so a run of refusals (an item the
  app may not read) does not fetch a token each time. Every request refused with the same old
  token is sent again with the new one, not only the first, and refused sub-requests of a
  `$batch` are sent again once as well; a wall clock that stepped back (NTP, VM resume) no
  longer holds back the refresh. A request refused again with the new token fails as before.
  This applies to backups, restores, the directory sync, the archive capture, the group search,
  the connection test and the consent check. A token endpoint that cannot be reached is asked
  twice more (after 1 and 4 seconds, 60 seconds per request) and then fails the run, which
  resumes from its checkpoint, instead of recording every item as failed; the test of an app
  registration still reports it at once.
- Microsoft 365: every `$batch` now sends an identical read only once and gives the answer to
  every caller, also in the retries after 429 and a new token, on top of the unique request
  ids of 0.3.2, so a delta page or a retry that names the same message twice can never repeat
  an id ("Request Id ... has to be unique in a batch"). Writes are never merged.
- Microsoft Graph: a connection broken before Graph answered (reset, refused, a temporary DNS
  failure, a timeout) is retried with backoff for requests that only read, `$batch` of reads
  included, and is not reported as throttling.
- Mailbox backup: a 403 for calendars or contacts (permission missing, an access policy that
  covers mail only) fails that area and keeps the mail of the run, instead of discarding the
  snapshot. A 401 in the middle of a run checkpoints and resumes, instead of abandoning a
  partial first backup. A well-known folder Graph refuses to resolve (400, 403) is treated as
  absent and logged, instead of failing the mailbox before a single folder was read. A stored
  delta link Graph rejects as an invalid sync state (400) leads to a full resync, instead of
  failing on every run. A message Exchange cannot convert to MIME (conversion error, or a
  plain 500 after one more try) is stored as JSON with its attachments, like an oversized one.
  A subfolder deleted while its parent was listed no longer fails the run; it is recorded as a
  failure of the parent, and what the snapshot holds below the parent stays until the parent
  is gone.
- SharePoint: a library or list Graph will not give (400, 501, or a lasting 500 for a list
  template or a library's permissions) is reported as an item failure and keeps its last copy;
  the rest of the site gets its snapshot, instead of the whole site failing; a 500 or 502 for
  a library's contents still fails the job, which resumes from its checkpoint. A resumed site
  counts the item failures of the libraries an earlier attempt finished. A library that is
  gone no longer reads "this user has no OneDrive".
- OneDrive and SharePoint: an item that failed and came through later in the same run (listed
  twice in a delta feed, retried) no longer stays among the failures. Files a host sends
  compressed are no longer taken for truncated downloads. A OneDrive whose drive Graph no
  longer finds (user deleted, retention over) fails as "OneDrive unavailable"
  (`graph.onedrive_unavailable`), permanent and not retried, instead of as an item. Cancelling
  a job during a throttling wait no longer records items as failed.
- Recovery readiness: an object removed from its source (a mailbox deleted in Microsoft 365,
  for example) no longer turns red because its last backup grows old. Nothing backs it up any
  more, and retention always keeps its newest restore point, so it is rated by whether that
  backup restores, without the age reasons ("The latest backup is N days old"), and is never
  overdue. A kept backup that does not restore stays red. The same rating applies in the
  statistics, the objects list, the tenant's overall readiness, the integration API
  (`GET /api/v1/status`, `/objects`, `/users`, `/verify/latest`, where `report.reasons` leaves
  the age out), the `verify.completed` notification and the rating a new check stores. The
  table says "Removed from source, backups kept" instead of "Removed from source"; the report
  page opens with a note "Removed from the source" and lists the age of the kept backup as "Not
  counted: ..." instead of among the findings. An object whose newest backup was never checked
  gets one more check from the weekly verify planner and from a job's verify; after that
  nothing is planned for it.
- IMAP backup: a login the server refuses for now (too many connections for the account, an
  authentication backend that is down, [UNAVAILABLE], [INUSE] or [LIMIT]) is the new transient
  cause `imap.server_limit`, retried by itself, instead of a wrong password; the connection
  test of an IMAP source says "The server temporarily refused the login". [LIMIT], [OVERQUOTA]
  or a quota text on a read is no longer reported as a full mailbox but as `imap.server_limit`
  too: such a download cap fails the folder as a whole and the next run resumes, instead of one
  failure per message (a cap the server reports on a read without such a code or text still
  costs one failure per message). Messages deleted or moved during the backup are not counted as
  failures. A run whose connection dropped too often fails as `imap.connection_lost`
  (transient) instead of "cause not identified".
- IMAP archive capture: a message the server refuses or does not deliver no longer holds back
  its folder or the whole pass; the other messages are captured, and after three passes the
  capture gives up on it. A refused folder costs only that folder for this pass. Folders a
  pass did not reach keep their state, so older mail is no longer skipped after an interrupted
  pass. A limit of the account stops the pass with its state kept. A watch refused with a NO
  on EXAMINE or IDLE is retried after minutes (doubling up to an hour), instead of being taken
  for a server without IDLE for a day.
- Restore: an IMAP restore whose connection drops fails and is retried on a fresh connection,
  where the Message-ID check skips what was already appended, instead of ending "completed"
  with every remaining item failed. A retried SharePoint list restore in "keep both" mode no
  longer adds the items the interrupted attempt added, and a retried contacts restore in that
  mode no longer creates contacts twice. A restore into a mailbox given by address resolves
  the same mailbox the API accepted (through the directory user's address, never an orphaned
  or imported mailbox), so a duplicate address no longer picks another one.
- Jobs: the time limit of a job counts from when the queue handed it out, also while it waits
  for a free slot of its tenant; a job that waited out its time stops before it starts, so no
  retry runs beside a late attempt. A cancel that lands while the attempt starts or fails is
  kept (it was overwritten by "active" or "failed" and retried). A job the reconciler ends for
  good raises the `job.failed` webhook, the bell and the notification rules like any other,
  and its checkpoint is cleared.
- Public demo: the seed no longer fails when Restow queued an object's first backup itself
  after the seed had listed the objects. "Back up now" then answered `already_queued`, the
  seed counted the object as failed, the nightly reset left `web` down and the demo kept
  showing its "being reset" page. The seed now waits for the backup that is already queued.
- "Remove from Restow" no longer says file restore stops offering the backups of a removed
  machine: since 0.4.6 its page offers their restore until they are deleted.
- The licence page no longer lists sign-in with Microsoft among what Business unlocks; it is
  still experimental and off by default.

### Security

- ip-address 10.7.5 (from 10.7.2), a transitive dependency through socks, resolves a moderate
  advisory reported by Dependabot. socks comes with the IMAP library imapflow and is used only
  for connections through a SOCKS proxy, which Restow does not configure.
- seroval 1.7.5 (from 1.6.7, through the TanStack router) resolves GHSA-7rv5-mrxv-xcr9,
  GHSA-wp97-x4hv-qvhp and further advisories of its deserializer; zod 4.6.7 (from 4.6.5, an
  override for the copy better-auth uses) resolves GHSA-mrhx-c7xc-m3w5 there.
- GHSA-mrhx-c7xc-m3w5 (memory use when validating a large array) also names zod 3, which
  Restow's own request validation uses and for which no fixed 3.x exists. The audit of CI
  ignores this one advisory (`pnpm.auditConfig` in package.json) until 0.4.8 moves Restow to
  zod 4. The request body limit of the api (1 MB on most routes,
  `apps/api/src/middleware/body-limit.ts`) bounds it: a 1 MB array that fails element by
  element costs about 150 MB and a second of the api for that request.

### Upgrade Notes

New images and four database migrations; no new required environment variable, and the
`docker-compose.yml` of 0.4.0 stays.

- Four database migrations run at the api's start; none of them rewrites a table:
  - 0066 adds two nullable columns to `pve_guests` (`excluded_at`, `excluded_by`).
  - 0067 adds the column `settings.pricing` (`jsonb`, default `{}`, no price set).
  - 0068 adds the column `settings.app_secret_alerts` (`jsonb`, default `{}`).
  - 0069 adds five nullable columns to `protected_objects` (`status_reason`, `inactive_since`,
    `inactive_notified_at`, `status_confirmed_at`, `status_confirmed_by`), two check
    constraints and a trigger that keeps them in step with the object's status; it updates
    only the orphaned rows.
- New optional environment variable `ENTRA_CLIENT_SECRET_EXPIRES_AT` (`YYYY-MM-DD`, as Entra
  shows it): a central app whose secret comes from the environment gets expiry reminders only
  with it in `.env` and the api restarted. A certificate needs none; an unreadable value counts
  as unknown.
- Sources connected through their own app before 0.4.7 have no expiry date, so no reminder:
  for a client secret, note the date on the source's page under "Expires"; a certificate gets
  its date when it is entered again.
- Webhooks and notification recipients get the new events (`object.inactive`,
  `object.inactive_many`, `source.app_secret_expiring`, `installation.app_secret_expiring`)
  only once they are ticked in the notification matrix (docs/ARCHITECTURE.md
  "Benachrichtigungsmatrix: welcher Kanal welches Ereignis bekommt"); a bell column that was
  never changed shows them.
- Objects already orphaned before the update count as confirmed (`migration`) and raise no
  notice, so no long amber list appears. Disabled and unlicensed mailboxes, and OneDrives and
  sites that Microsoft locked, that failed every night are recognised by the first directory
  sync or backup after the update (a locked site by its first backup): expect one
  `object.inactive` notice for each object (an unlicensed user often has two, mailbox and
  OneDrive), or one `object.inactive_many` warning for a tenant with many, and confirm them
  under protected objects once they are intended.
- Webhooks and alerts: a backup that Graph or the storage held back (`graph.throttled`,
  `graph.service_unavailable`, `storage.rate_limited`) and a backup that ends neutral for an
  object no longer backed up (`graph.mailbox_inactive`, `graph.object_locked`,
  `config.object_inactive`) raise no `backup.failed` alert and no `job.failed` webhook; the
  overdue rules speak up when no backup gets through. A restore that completed without
  restoring anything while items failed now raises `restore.failed` and `job.failed`, with
  `data.job.status` still `completed`. A job the reconciler ends for good raises `job.failed`.
- Integrations: `GET /api/v1/jobs` keeps the status `failed` for these held-back and neutral
  backups; read `failure.code` (and the object's `statusReason`) and treat them like the
  object's state, not as a failure.
- The counting reads the cause stored with each run, so earlier runs that ended with
  `graph.throttled`, `graph.service_unavailable` or `storage.rate_limited` also read "Held back
  by the service, retried" after the update and leave the failed counts of past periods in the
  statistics and the dashboard. Objects removed from their source are rated without the age of
  their last backup from the update on, without a new check; those whose newest backup was
  never checked are checked once by the next planned check.
- Proxmox VE: no guest is excluded by the update; guests in no job keep counting as "in no
  backup job" until an admin excludes them. restow-pve needs no update in this release (no
  change to the agents or the Proxmox VE plugin); the server withdraws the backups of an
  excluded guest before a node gets them.
- Prices are empty after the update; the price card appears only once the owner enters a price
  under Installation › Prices. Existing mail jobs change only when an administrator applies
  the recommended job, and only where the installation offers `archive.mailboxCapture`.
- Building from source: pg-boss 10.4.2 is patched through `pnpm.patchedDependencies`
  (patches/pg-boss@10.4.2.patch), which `pnpm install` applies; keep the `patches` folder. The
  images carry the patch.
- Rollback to 0.4.6 after the migrations was not tested: take a database backup before the
  update and restore it to go back.

### Known Issues

- The detection of disabled, unlicensed and locked objects was tested against a simulated
  Graph API. An answer of Microsoft that Restow does not recognise as "no mailbox" or as a lock
  stays a counted failure, as before.
- `GET /api/v1/jobs` has no field that sets a held-back or neutral backup apart from a failed
  one; integrations that open tickets from it can read `failure.code`.
- Notification mail sent through a Microsoft 365 app registration does not fetch a new token
  after a refusal: a `Mail.Send` permission granted later takes effect once the cached token
  expires.
- The expiry date of a client secret is not read from Microsoft: without a date entered (under
  Installation, in `ENTRA_CLIENT_SECRET_EXPIRES_AT` or on the source) there is no reminder.
  Sources with an older own secret without an own app (shared client ID) have no date in
  Restow; switch them to an own app or the central app (docs/ENTRA-SETUP.md "Alternative: eine
  eigene App pro Quelle").
- On the Recovery readiness reports list, a filter on the rating matches the stored rating. A
  report stored before the update, or while the object was still at its source, counts the
  backup's age, so such a report of an object removed from its source can be listed under red
  while it reads green. Checks from 0.4.7 on store the rating without the age. The readiness
  history of earlier days does not show the yellow of unconfirmed objects: only the current
  confirmation is stored, not when it was given.
- A message the IMAP archive capture gives up on (after three passes), messages the backfill
  could not read and a well-known mail folder Graph refused to resolve are named in the worker
  log only, not in the interface.
- Excluding a selection of Proxmox VE guests in the inventory sends one request per guest
  (there is no bulk route); when one fails, the guests before it stay excluded and the list
  refreshes.
- Group calendars and conversations were tested against a simulated Graph API, never against a
  real Microsoft 365 tenant (as in 0.4.5).
- IMAP sources with OAuth2 still cannot be created in the API or the interface.
- The known issues of 0.4.4 still apply.

### Verification

Before the tag, on the release branch (0.4.6 plus the 0.4.7 work): lint and typecheck of all
workspaces, the unit and Postgres suites of every package on Postgres 16 (with the Postgres
guard), among them migrations 0066 to 0069 with the trigger and backfill of 0069, the directory
sync and backup tests of disabled, unlicensed and locked objects, the `$batch` and token tests,
the job queue with the pg-boss patch, the guest exclusion, the prices and the recommended job
with the archive; restic-backed tests with restic 0.19, the web DOM tests, the v1 OpenAPI test,
the tests of the CI scripts and the third-party notices. The handling of locked OneDrives and
sites and of disabled and unlicensed accounts was not run against a real Microsoft 365 tenant
before the tag, beyond the production error data that led to it; the guest exclusion was not
run against a real Proxmox VE node.

## [0.4.6] - 2026-10-23

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.6 fixes restoring Proxmox VE containers, which failed on current Proxmox VE for
every restore and every boot test of a container, and stops a new backup chain from being
flagged as a ransomware attack. Removed machines keep their backups browsable until they are
deleted, a requested restore check says it is queued until its result is in, and error texts
open in a card that can be copied. No database migration.

### Breaking Changes

None. The integration API contract stays at 1.6.0.

### Added

- Removed machines (#65): until their backups are deleted, the page of a removed machine offers
  their restore (and nothing else), and the restore points, browsing, the ZIP download and the
  repository key keep working for them, audited as before. The list of removed machines links
  "Restore files". Restoring onto the machine and every other action stay refused (404); once
  the backups are deleted the machine is gone for every reader (docs/AGENT.md).

### Changed

- Error texts behind a badge or a cut-off line (the boot test, the restore check of a VM or
  container on its page and in the recovery readiness table) open on hover or keyboard focus in
  a card with the whole text, selectable and with a Copy button, instead of a browser tooltip.
- A boot test that did not boot shows the node's message under its badge, on the guest's page
  and in the recovery readiness table.
- "Check now" of a VM or container: the row says "Check queued" under the last check, and the
  guest's page above the earlier result, until the result is in; both refresh every few seconds
  meanwhile.
- Dependencies: happy-dom 21.0.4 (tests of the web interface only; Dependabot #78).

### Fixed

- Proxmox VE: restoring a container from Restow failed with `Can't use string ("restow") as a
  HASH ref` on current Proxmox VE, which passes the storage ID to the backup provider's
  container restore before the info hash. Boot tests of containers ("Did not boot") and
  "Restore as a new guest" of containers were affected; VMs were not. The plugin of restow-pve
  accepts both forms; it is installed with the restow-pve update, which reloads the PVE daemons.
- Ransomware detection: the first backup of a container's new backup chain (its repository was
  missing, or reset) was judged against the old chain and flagged as suspicious, since every
  file is new in an empty repository. The baseline now begins with the newest chain. A restore
  point flagged that way before the update stays flagged; mark it as a false alarm.
- The first backup of a container's new backup chain is called "First backup", not
  "Incremental".

### Security

None.

### Upgrade Notes

- No database migration and no new setting.
- Update restow-pve on every Proxmox VE node (the server offers it after its own update; nodes
  update themselves when idle) before relying on container restores or boot tests. Until then,
  container restores keep failing as before; VMs are not affected.
- Container restore points whose boot test reads "Did not boot" from before 0.4.6, or whose
  restore check failed before 0.4.3: run "Boot test now" or "Check now" once the node is
  updated.

### Known Issues

- Group calendars and conversations were tested against a simulated Graph API, never against a
  real Microsoft 365 tenant (as in 0.4.5).
- IMAP sources with OAuth2 still cannot be created in the API or the interface.
- The known issues of 0.4.4 still apply. Restoring from machines removed from Restow, a known
  issue of 0.4.5, is fixed in this release.

### Verification

Before the tag, on the release branch (0.4.5 plus the 0.4.6 fixes): lint and typecheck of all
workspaces, the unit and Postgres suites of every package on Postgres 16 (with the Postgres
guard), restic-backed tests with restic 0.19, the web DOM tests, the Perl tests of the Proxmox VE
plugin (the container restore with and without the storage ID) and the third-party notices.
The release smoke runs in the release pipeline; the container restore fix was not run against
a real Proxmox VE node before the tag.

## [0.4.5] - 2026-10-23

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.5 prepares the licence for paid update periods: keys can carry an update period
and a series, the image knows its release date, and an installation is offered, told about and
allowed to install only the releases its Business or Service Provider key covers. Every key
issued so far is a beta licence and keeps covering every 0.x and 1.x release. Revoked machines
can be removed from Restow, with or without their backups; Microsoft 365 group calendars and
conversations are backed up as protected objects of their own (opt-in); both job lists can
start and stop every job and open a detail panel like VMs & containers. The public demo resets
from a saved template in about a minute. Three database migrations (Upgrade Notes).

### Breaking Changes

None. The integration API contract moves to 1.6.0, additively: `ObjectKind` includes
`group` and the status reports `lastSuccess.groups`; clients that handle object kinds
exhaustively should accept the new value. Licence keys with the new optional members verify
only on 0.4.5 and later (ee/licensing/KEY-FORMAT.md).

### Added

- Licence keys carry update terms (docs/LICENSING.md). The key format `restow-license-v1`
  accepts the optional members `series`, `updates_until` and `kid` and ignores members it does
  not know, so keys the licence server issues later keep verifying; the six members of today
  stay required and keep their rules (`mailbox_limit` unchanged). Every key issued so far is a
  beta licence: it covers every 0.x and 1.x release. A key with `updates_until` covers every
  release made up to the end of that day (UTC). `kid` names the vendor signing key, for a
  rotation without breaking issued keys. The contract for the issuer, with examples, is
  ee/licensing/KEY-FORMAT.md.
- The image carries its release date (`RESTOW_RELEASED_AT`, from the build argument
  `RESTOW_CREATED`, the commit date of the release tag); `GET /api/v1/status` reports it as
  `releasedAt`. Release notes publish the same date in a `released:` line next to the digests.
- The update check marks releases the installed Business or Service Provider key does not
  cover, says so calmly on the Updates page (the installed version keeps working; the newest
  covered version installs as usual) and refuses to install or plan them (409
  `urn:restow:problem:update-not-covered`). The bell and the `update.available` alert rules
  announce only the newest covered release.
- Started by hand, a release the installed Business or Service Provider key does not cover
  stops before its database migrations, with a log line naming the version, the end of the
  update period and the last covered release date; nothing needs to be restored to go back.
  With `RESTOW_RUN_AS_COMMUNITY=1` it starts as Community instead (the modules stay off, no
  data is changed). Never for beta licences, development builds, installations without a key
  or the demo.
- The licence page shows which updates the key includes ("all 1.x (beta license)" or the end of
  the update period) and, from 30 days before the end, a short notice on the same page. A new
  key replaces the active one even while it is in force, of the same edition (a renewal) or
  another; earlier keys stay in the history, and every installation or replacement is audited
  with the key's update terms and whether they cover the running version. A key that does not
  cover the running version is refused (`outside_update_period`).
- Public demo, fast nightly reset (deploy/demo/README.md "Fast reset"): after a full seed
  `deploy/demo/reset.sh` saves a template (a `pg_dump` of the demo database, its roles and a tar
  of every volume the seed writes) keyed by the release, the image ids and `.env`, and restores
  it the following nights instead of seeding: the database is restored next to the running one
  and swapped in, so the demo is offline for about 15 to 25 seconds instead of many minutes. The
  restore moves every system time forward by the template's age (`deploy/demo/seed/sql/
  shift-time.sql`), so the history still ends today and "last backup 12 minutes ago" stays true;
  the audit log, the mail archive and restic's own snapshot times keep their real times, sign-ins
  are removed. A template older than `RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS` (default 7), a new
  release, new images, a changed `.env` or a failed restore lead to a full seed. Two templates are
  kept, with a free-space check before saving (`RESTOW_DEMO_TEMPLATE_*` settings,
  `RESTOW_DEMO_TEMPLATES=false` switches it off).
- Machines: a revoked machine can be removed from Restow (#65). "Remove from Restow" in its
  danger zone offers "Remove from the list, keep the backups until they expire" (the newest
  backup plus the longest rule of the machine's retention, read as time) or "Delete the machine
  and its backups", with the hostname typed and a recent sign-in. The machine leaves every list,
  picker, dashboard and count and its backup job; its runs, reports and audit entries stay. The
  worker deletes its restic repository (`endpoints/<id>/`) on every target that holds files of it:
  the primary, its copies and retired primaries. Deleting now is refused while a legal hold over
  the tenant or an unresolved suspicious restore point holds the backups, and the worker waits
  for such a hold when the backups expire. Objects the storage still locks (S3 Object Lock, a
  directory's deletion delay) are deferred until their lock runs out, recorded like a refused
  prune and left out of the lock renewal. The machines page lists the removals still pending,
  with the date, the hold or the lock. Every step is audited. Database migration 0064 adds the
  removal state to `endpoints`.
- Machines: an uninstall that waits for a machine that is off now offers "Revoke now", and a
  machine without contact for longer than a configurable number of days (default 30, under Alerts
  of the machine) suggests revoking it, on its page and among what needs attention (#65). The
  machine's detail panel on Inventory shows the suggestion as a state and offers "Revoke now" and,
  once the machine is revoked, "Remove from Restow" as well.
- Repositories: a warning when a directory repository lies on the system disk of the Restow
  server, the disk under the operating system, Docker and the database (a full system disk stops
  everything, as on 16 October 2026). The api recognises it from inside its container by device
  and block device of the path, the installation default and the mounter's shares included; it
  is shown on the Repositories page, in the "Backups land in" line of the job editors and on the
  dashboard's storage tile, where provider admins also see the free space, its trend over the last
  week and when the disk would be full. The api now also watches the system disk for low disk
  space. Nothing is blocked.
- Microsoft 365 group mailboxes as protected objects of their own kind `group` (docs/MICROSOFT.md
  "Gruppenpostfächer"): the calendar and the conversations of Microsoft 365 groups and of the
  groups behind Teams. The directory sync reads `groups/delta` as a second delta stream next to
  the users (a full enumeration on the first and every full sync, only changes in between, its
  delta link stored with the rows), keeps only Microsoft 365 groups and orphans removed ones.
  Group mailboxes are opt-in: the protection rules get a switch "Protect all Microsoft 365
  groups" (`groups`: `selected` by default, or `all`), and single groups can be included in the
  list of protected objects. A mail job with scope "all" covers every protected group, like
  sites. Group mailboxes never count as protected mailboxes.
- Group mailbox backup: the group calendar through the same calendar code as a user's (series
  masters with their exceptions), falling back to the group's `calendarView` and one read per
  series master when Graph refuses the event listing to the app; a calendar Graph refuses
  entirely is a warning on the run, not a failure. Every post of every conversation is stored as
  an RFC 5322 message under `mail/Conversations` (with its file attachments when Graph hands them
  out, otherwise their absence is recorded); only threads with new posts are read again. A group
  that no longer exists fails with the new cause `graph.group_unavailable`. Migration
  `0065_group_mailboxes` (an enum value only).
- Group mailbox restore: the restore explorer lists groups in the "SharePoint & Teams" section
  with the areas "Group calendar" and "Conversations"; download (EML, JSON) and export (EML,
  MBOX, PST) work as for mailboxes. A restore into a user's mailbox brings back events and
  conversations; a restore into the group brings back calendar events only, because Microsoft
  Graph lets no app post into a group conversation (each post is reported as not restorable,
  with the ways that work). Restoring a group is no impersonation. The integration API reports
  `lastSuccess.groups` and `ObjectKind` includes `group` (integration API contract 1.6.0,
  additive; clients that handle object kinds exhaustively should accept the new value), and the
  dashboard lists group calendars and conversations among the last backups. No new Microsoft permission is needed:
  `Group.Read.All` and `Calendars.ReadWrite` were always required.
- Start now and Stop on every row of both job lists (Servers & clients and Mail & SaaS) and in
  the row's "…" menu: one button of a fixed size that says "Start now", "Stop" while the
  job's backups run or wait, and "Stopping…" once asked. Stopping asks first and says what it
  means for the kind of job. New API routes: `POST /api/v1/backup-jobs/:id/cancel` (every
  queued or running backup of a mail, machine, share or copy job in one set-based request;
  audited as `backup_job.run_cancelled` on the job and per machine),
  `POST /api/v1/pve/jobs/:id/run` (a backup of every guest a Proxmox VE job covers, like its
  schedule would, without moving the schedule; `pve.job.run_requested`) and
  `POST /api/v1/pve/jobs/:id/cancel` (`pve.job.cancelled`). For tenant administrators and
  provider roles that may operate, closed in the public demo.
- Detail panels on Inventory and on the job lists, like the one of VMs & containers: a click on
  a row, its name or its state opens it (`?machine=<id>` on Inventory, `?job=<id>` on the job
  lists, so a link opens it). It lists every state, the full error and warning texts of the
  newest backup or failed run in a copyable monospace block (for a machine also the end of the
  log), what needs attention, the restore checks, the key facts, the newest runs and the
  actions.

### Changed

- Dependencies: major update of the translation libraries, i18next 26 and react-i18next
  17 (updated together). Texts, plurals and number and date formats read exactly as
  before in English and German.
- `@azure/msal-node` is no longer a dependency: nothing used it. The Microsoft 365 app
  tokens, the admin consent and the IMAP OAuth2 sign-in use Restow's own token client,
  unchanged.
- Public demo: the health checks of postgres, Dovecot and the api run every 2 to 5 seconds
  instead of every 10 to 15 (with the same grace period), and the full reset stops the old
  project with a 10 second timeout, so a reset waits less for services that are already ready
  or about to be discarded.
- Inventory and the job lists keep their layout like VMs & containers: fixed column widths,
  one row height (loading rows included), one compact state badge per row (the most urgent of
  what applies; green only for a passed restore check), the progress of a running backup beside
  it, one-line cells without tooltips, and action buttons of one size. Columns that do not fit
  a screen give way from the right; the panel has everything.
- "Run now" of a job is called "Start now".

### Fixed

- Public demo: `reset.sh` now reads `RESTOW_DEMO_COMPOSE_FILES` from `deploy/demo/.env` as the
  README always said, not only from its environment, and logs which compose files a run uses.
  A list from `.env` that would publish `web` on every interface (the own-VM override with
  80/443) is used only together with the new `RESTOW_DEMO_PUBLISH_PUBLIC=true`, so a co-hosted
  host whose `.env` carries that line keeps running as before; entries that are not compose
  files in `deploy/demo/` are refused before anything is stopped.
- Restore explorer: a mail message stored as JSON (too large for a plain message) no longer
  shows an empty `<subject>.attachments` folder next to it. Its attachments are restored with
  the message and were never listed; the folder row the backup records for them is now hidden
  from the listing, the folder tree and search as well.
- The job dialog of Proxmox VE: on a phone (390 px) the three restore-point fields stack, so
  "Monatliche Sicherungsstände" no longer runs over the dialog's edge.

### Security

- The setup wizard accepts the Entra tenant for Graph mail only as a tenant id (GUID) or a
  verified domain, as Settings already did; anything else is refused (422) before it can reach
  the token URL. The URL was never open to another host (the value is URL-encoded, the login
  host is fixed), but a value such as `..` changed its path.
- An IMAP OAuth2 secret is refused unless its `tenantId` is a tenant id, a verified domain,
  `common`, `organizations` or `consumers`, and its `tokenEndpoint` is an https URL. Neither the
  API nor the UI creates such secrets yet; the token request will also need the address policy
  of IMAP connections before XOAUTH2 is offered.

### Upgrade Notes

New images and three database migrations; no new required environment variable, and the
`docker-compose.yml` of 0.4.0 stays.

- Three database migrations run at the api's start: 0063 adds three nullable columns to the
  `license` table, 0064 the removal state of a machine to `endpoints` (three nullable columns
  and a partial index over the removals that are due), 0065 the protected object kind `group`
  (an enum value only). None of them rewrites a table.
- Installed licence keys keep working unchanged: every key issued before 0.4.5 is a beta
  licence and covers every 0.x and 1.x release. From now on, an image started with a key that
  does not cover it stops before the migrations and says so in the log;
  `RESTOW_RUN_AS_COMMUNITY=1` starts it as Community instead (docs/LICENSING.md).
- Group mailboxes are opt-in: after the update no group is backed up until the protection
  rules switch "Protect all Microsoft 365 groups" on or single groups are included. The first
  directory sync after the update reads the groups of every Microsoft 365 source once in full.
- Rollback to 0.4.4 after the migrations was not tested: take a database backup before the
  update and restore it to go back.

### Known Issues

- Group calendars and conversations were tested against a simulated Graph API, never against a
  real Microsoft 365 tenant; which calendar reads Graph allows an app on a group can differ by
  tenant (the backup falls back to `calendarView` and reports what it could not read).
- Machines removed from Restow cannot be restored from in the interface while their backups
  are kept until expiry.
- IMAP sources with OAuth2 still cannot be created in the API or the interface.
- The known issues of 0.4.4 still apply.

### Verification

Before the tag, on the release branch (0.4.4 plus the 0.4.5 workstreams): lint and typecheck
of all workspaces, the unit and Postgres suites of every package on Postgres 16 (with the
Postgres guard), the web DOM tests, the v1 OpenAPI test, drizzle-kit without drift, the Go
tests of the agents, the server installer and demo reset tests and the third-party notices.
The release smoke ran on the release branch; no real Microsoft 365 tenant was used before the
tag.

## [0.4.4] - 2026-10-22

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.4 archives mail beyond Exchange journaling (Business): Microsoft 365 mailboxes by
Graph change notifications, IMAP and Google Workspace accounts by IMAP sync with IDLE, and the
copies a mail provider forwards, each with a one-time takeover of the mail already there and
one archived item per mail however many ways captured it. The job editor offers only the
capture ways that fit each kind of mailbox, the archive page shows the capture, the hold
confirmation, ready-made Exchange Online PowerShell commands and the forwarding addresses, and
alerts say when capture stops. The restore explorer opens large mailboxes and OneDrives in
milliseconds instead of seconds to minutes; four database migrations (Upgrade Notes). Mail jobs
that archived before keep doing exactly that after the update: nothing new starts by itself.

### Breaking Changes

None. The integration API contract stays at 1.5.0: its archive status and report count
forwarded copies in their totals, but do not list them as a channel of their own yet. In the
session API, mail jobs carry `archiveCapture` and their members `captureKind`, and the archive
search hides captures a stronger one superseded unless `includeSuperseded=true`; a job that
archives without any capture way for a kind of its mailboxes is refused with 422
`archive_capture_no_way`, which the defaults never cause. The IMAP and Google ways of a job
from before the update may carry `pending: true` (no way chosen yet): the API accepts such a
job until a way is chosen, keeps the marker only where the job had it, and never sets it.

### Added

- Archive capture foundation for mail beyond Exchange journaling (docs/ARCHIVE.md
  "Erfassungswege"). A mail job's archive keeps its capture ways per kind of mail object
  (`archiveCapture` on create, change and read of a mail job: Microsoft 365 by Graph and/or
  journaling, IMAP and Google Workspace by IMAP sync and/or a forwarded copy; the defaults of a
  new job are Graph and IMAP sync, jobs that archived before keep journaling only, see Upgrade
  Notes). A job that archives needs at least one way for every kind of mailbox it
  covers (422 `archive_capture_no_way`). Members and candidates carry `captureKind` (`m365`,
  `google`, `imap`, `imap_microsoft`), and `GET /api/v1/backup-jobs/defaults?kind=mail` names
  the tenant's `mailSourceKinds`.
- Archive page (Business): a notice that can be put away names the mail jobs where Graph or
  IMAP archiving could be switched on, each with a link to the job, and the capture status
  lists the jobs whose IMAP or Google Workspace accounts wait for a capture way
  (`GET /api/v1/archive/capture` returns them as `jobs`).
- Worker: a capture service keeps one stream per archived mailbox and mailbox way, claimed
  across worker processes with `FOR UPDATE SKIP LOCKED` and a lease, reconciled from the mail
  jobs every two minutes without a job row per mail. Pausing a job stops its scheduled backups only;
  capture goes on until archiving or the way is switched off in the job. It idles while the edition does not include
  capture from the mailbox, stops on shutdown and update drain, and pauses a tenant while its
  storage switches targets. New settings `ARCHIVE_CAPTURE_CONCURRENCY` (16),
  `ARCHIVE_CAPTURE_TENANT_CONCURRENCY` (4) and `ARCHIVE_BACKFILL_CONCURRENCY` (4). The `archive`
  queue has a handler: the one-time takeover of a mailbox's existing mail once its stream is live
  (marked as captured late), and archive schedules of older releases make the named mailboxes
  due. The Graph and IMAP ways plug into this framework.
- `GET /api/v1/archive/capture` (state per capture way: availability, streams, how mail is
  noticed, counts of 24 hours and 7 days, takeover progress), `GET /archive/capture/mailboxes`,
  `POST /archive/capture/mailboxes/:objectId/resync` (audited as
  `archive.capture.resync_requested`) and `GET`/`PUT /archive/capture/holds/:sourceId`, the
  confirmation that a retention policy or litigation hold keeps deleted mail in a Microsoft 365
  tenant (audited as `archive.hold.confirmed` and `archive.hold.unconfirmed`).
- Business: new capability `archive.mailboxCapture`; the gated features
  `archive.mailboxCapture` and `archive.smtpCapture` (API `/me` and the worker's new `features`
  extension point). `archive.journalReceiver` also covers forwarded copies.
- Archive capture of Microsoft 365 mailboxes by Graph (docs/MICROSOFT.md "Archiv-Erfassung per
  Graph"): one change notification subscription per archived mailbox (created and renewed in
  `$batch`, at most 20 per request and one request per second and Microsoft tenant; renewed with
  less than a day left; reauthorized, recreated after removal, after expiry and when the Entra app
  changes), immutable message ids, notified mail fetched within minutes (drafts skipped), a delta
  catch-up over every folder and the recoverable deletions with its own state (every
  `ARCHIVE_GRAPH_CATCHUP_MINUTES`, default 360, and at once after a missed notification), and the
  one-time takeover of the existing mail in resumable pages. No new Microsoft permission is
  needed. Without a public HTTPS URL the mailboxes are polled every `ARCHIVE_GRAPH_POLL_MINUTES`
  (default 15) and the capture status names the reason (`graph.notification_url_unavailable`);
  a subscription Microsoft refuses is retried hourly meanwhile (`graph.subscription_failed`).
- Public hooks `POST /api/v1/hooks/graph/notifications` and `/lifecycle` for Graph: the
  validation token is echoed, everything else answered 202; only notifications whose
  `clientState` matches the subscription's stored SHA-256 count, and they only queue a fetch.
  Bodies are limited to 1 MiB, and the hooks answer 404 while the edition does not include
  capture from the mailbox.
- `GET /api/v1/archive/capture/holds` also returns `checks`: read-only Exchange Online and
  Security & Compliance PowerShell commands to check litigation holds and retention policies
  before confirming a hold. Graph v1.0 offers no way to read them (spike result in
  docs/MICROSOFT.md).
- IMAP archiving (Business; docs/IMAP.md "Archivierung"): the capture way `imap_sync` archives an
  IMAP account continuously. Activation records where every folder stands, the one-time takeover
  brings in the mail that was there (resumable, flagged captured late), and every pass reads only
  new mail: STATUS per folder, metadata first, sources only of mail the archive does not hold for
  the account yet. All folders but Drafts; on Gmail and Google Workspace only All Mail, Spam and
  Trash. A changed UIDVALIDITY reads the folder again without archiving anything twice. Up to
  `ARCHIVE_IMAP_IDLE_MAX` (300) accounts per worker are watched with IMAP IDLE, shared between
  worker processes through Postgres locks, with a STATUS round over the other folders every
  `ARCHIVE_IMAP_POLL_MINUTES` (5); other accounts are polled every
  `ARCHIVE_IMAP_LOGIN_POLL_MINUTES` (10). New source setting `archiveIdle` (`auto`, `off`) for
  providers with a tight connection limit. Why an account is polled is shown as
  `imap.idle_unsupported`, `imap.idle_disabled` or `imap.idle_budget`.
- Forwarded copies into the archive (Business; docs/IMAP.md "Weiterleitung"): the receiver takes
  plain copies a provider forwards (Postfix BCC maps, mailcow, Sieve `redirect :copy`, Google
  Workspace routing) as source `smtp_forward`, next to Exchange journal reports. Every IMAP
  account can have its own archive address `archive+<token>@<journal host>`; a copy to it belongs
  to exactly that account, a copy to the tenant's journal address is assigned by its headers and
  `MAIL FROM`. New routes `GET /api/v1/archive/forwarding` (accounts, addresses, copies of the
  last 7 days; issues nothing), `POST /api/v1/archive/forwarding/:objectId/address` (issued once,
  audited `archive.forward.address_created`) and `POST /api/v1/archive/forwarding/:objectId/rotate`
  (audited `archive.forward.address_rotated`, fingerprints only).
- `GET /api/v1/archive/journal` names `firstReportAt`, the first journal report that arrived.
- Release smoke check 13: IMAP archiving with backfill and IDLE, forwarded copies and their
  dedupe against the synced mail, against the Dovecot of check 5.
- Job editor: the archive's capture ways per kind of mailbox in the job (Microsoft 365: Graph and
  Exchange journaling; IMAP and Google Workspace: IMAP archiving and forwarding), each labelled
  as captured at transport or near-time, locked with the edition that has it, at least one per
  kind; IMAP accounts on a Microsoft host get the hint to connect a Microsoft 365 source instead.
- Archive page: capture from the mailboxes (Graph and IMAP archiving: streams, how mail is
  noticed and why a mailbox is checked at intervals, counts, takeover of existing mail), the
  capture per mailbox with a catch-up, and the hold confirmation of each Microsoft 365 source
  with the Exchange Online PowerShell commands that check it. Search and detail name forwarded
  copies, mail captured afterwards and the other ways that captured the same mail again; a
  capture replaced by a stronger one is hidden unless asked for (`includeSuperseded` on
  `GET /api/v1/archive/search`), and the detail links both (`supersededBy`, `captures`).
- Business: Exchange journaling as ready-made Exchange Online PowerShell commands (connector,
  mailbox for undeliverable journal reports, journal rule) and a wait for the first report that
  checks every 5 seconds. Forwarding to the archive: an address per IMAP account (created,
  copied, renewed after a question), its status, and instructions for Postfix and mailcow BCC
  maps, Sieve `redirect :copy` and Google Workspace routing to the tenant's journal address.
- IMAP source page: the archive setting `archiveIdle`, IMAP IDLE (automatic) or checks at
  intervals only, saved at once and locked without the edition that archives from the mailbox.
- Exporting the current archive search leaves out the captures a stronger one superseded, as
  the search does, so the export holds what the search counted; with superseded captures shown,
  the export includes them (`includeSuperseded` in the export's search filter).
- Alerts of the archive capture as `archive.failed` (bell, rules, mail): a mailbox whose capture
  has been in error for more than an hour, an IMAP account whose forwarded copies stopped for
  24 hours while its job wants them, and a journal address without reports for 24 hours, each
  after it received before and once per stretch. The bell and the mail say which of these it
  is and lead to its section of the archive page.

### Changed

- Every archive writer (journal receiver, file import, capture ways) appends through one shared
  path. The original is uploaded before the tenant's chain lock is taken, so a large report no
  longer holds up the other deliveries of the tenant. Mail captured more than once is recognised
  by Message-ID and content: a capture not stronger than what the archive holds becomes a capture
  row on that item instead of a second item, a stronger one names the item it supersedes, and the
  same Message-ID with another body is kept and flagged `message-id-conflict`. Journal reports and
  imported messages are still stored as items of their own.
- The archive record format gains the optional `bodyHash` and `supersedesItemId` and the source
  `smtp_forward` (packages/core archive/FORMAT.md); records written before stay as they are.
- Journal receiver: one SMTP transaction delivers into one tenant's archive; a recipient of a
  second tenant is answered 452 and delivered by the sender separately. The limit per sending IP
  rises from 60 to 600 connections per minute (`JOURNAL_RATE_PER_IP`), and a new limit per
  archive address (`JOURNAL_RATE_PER_ADDRESS`, 300 per minute) answers 451. Mail to the journal
  address that is not a journal report (no `X-MS-Journal-Report` header and not built like one)
  is archived as a forwarded copy with its own headers' envelope instead of as an incomplete
  report.
- Pausing a mail job stops only its scheduled backups; archiving goes on, and the pause
  question says so. The forwarding page counts the accounts of a paused job as wanting their
  forwarded copy. Switching archiving or a capture way off in the editor asks first: new mail
  of these mailboxes is no longer archived from then on, the archive kept so far stays.
- docs/ARCHIVE.md describes the capture ways of 0.4.4; docs/ARCHITECTURE.md describes the
  Graph throttling as it is built (no shared token bucket per source).
- Restore explorer: the restore points of an account load alongside its owner's entry
  instead of after it, one round trip less before a mailbox or OneDrive shows its folders.
- The Proxmox VE job dialog is twice as wide and lays its settings out in two columns from
  tablet width on (name and schedule with the next runs on the left; scope, restore points,
  restore check, boot test and guests on the right), so a job's settings fit on a desktop screen
  without scrolling; on a phone it stays one column at full width.

### Fixed

- Opening the job editor of a job with only IMAP accounts no longer creates the tenant's
  journal address: it is requested only while Exchange journaling is chosen for Microsoft 365
  mailboxes.
- The archive chain could fork when two writers of one tenant stamped their items with the same
  time: the predecessor was taken by time alone. Writers now take the last item in the order the
  chain check walks (time, then id) and stamp their item strictly later.
- Restore explorer: opening a large mailbox or OneDrive no longer takes seconds to minutes
  before its folders show. Every folder listing read all entries of the restore point (every
  message of the mailbox, every file of the OneDrive, with their metadata), twice per request,
  and matched the folders below against them without an index; a folder whose subfolders
  have no entry of their own (the mailbox root with `mail` and `calendar`, a OneDrive root)
  grew with the square of the entries and could time out. The listing now reads the folder's
  children and the folders below it from two new indexes (migration
  `0061_explorer_parent_index`; on a large `manifest_versions` table the update takes longer,
  docs/UPDATING.md): with 120 000 messages and 200 000 files, the mail folder list went from
  2.5 s to 15 ms, the root of the mailbox and of the OneDrive from over a minute to 15 ms,
  and every OneDrive folder from 1.5–2.5 s to about 10 ms. A folder of 50 000 messages lists
  its first page in about 0.5 s (was 1.9 s). Restore points of 0.3.4 and earlier that the
  worker has not converted yet are listed as before.
- Restore explorer: the versions OneDrive kept of a file and the calendar's month view read
  the same indexes instead of every entry of the restore point (130 ms and 260 ms to under
  50 ms for the sizes above).
- Mail preview, attachment download and calendar series: each chunk of the message is read
  from storage with a byte-range request for exactly its bytes instead of downloading its
  whole pack (up to 64 MiB) for every preview; a chunk damaged on every target is still read
  through its whole pack as before. The archive's content check reads the same way.

### Security

None.

### Upgrade Notes

New images and four database migrations; no new required environment variable, and the
`docker-compose.yml` of 0.4.0 stays.

- Migrations 0059 to 0062 run at the api's start: the capture tables, new columns and five
  indexes on `archive_items` and `backup_jobs`, two indexes on `manifest_versions` for the
  restore explorer, and the capture ways of the mail jobs that already archive (below). The indexes are built inside the migration, where writes to the table
  wait; expect about a minute per ten million rows on SSD storage. Count
  `archive_items` and `manifest_versions` beforehand and plan a large installation's update
  outside the backup window (docs/UPDATING.md).
- Capture from the mailbox needs the capability `archive.mailboxCapture`. Capabilities follow
  the license's edition (ee/licensing), so every Business and Service Provider license
  includes it without a new key; the Community build keeps the capture service idle.
- Mail jobs that archive keep doing exactly what they did before the update: migration 0062
  gives each of them Exchange journaling only for Microsoft 365 mailboxes and no capture way
  yet for IMAP and Google Workspace accounts (marked as waiting for a choice), so no capture
  and no takeover of existing mail starts by itself. An administrator switches Graph or IMAP
  archiving on in the job; the job editor says at the IMAP card that no way is chosen yet, the
  archive page names the jobs where a way could be switched on (with a notice that can be put
  away, Business only), and the capture status lists the jobs waiting for a choice. Edits that
  do not touch the ways (name, schedule) save as before. Jobs created after the update, and a
  job that switches archiving on, start with the defaults: Graph for Microsoft 365 mailboxes,
  IMAP sync for IMAP and Google Workspace accounts, each with a one-time takeover of the mail
  already in the mailbox (marked as captured late).
- Graph capture is notified of new mail only when the installation's public URL is `https://`
  on port 443 and reachable from Microsoft (`/api/v1/hooks/graph/*`; a reverse proxy of your
  own must pass it through, with at most 1 MiB per request). Otherwise every mailbox is polled
  every `ARCHIVE_GRAPH_POLL_MINUTES` (15) and the capture status says why. No new Microsoft
  permission is needed.
- IMAP archiving keeps one connection per account open (IDLE) where the server offers it.
  For providers with a tight connection limit, set the source to "Check at intervals only"
  (`archiveIdle: "off"`).
- New optional settings: the journal receiver's `JOURNAL_RATE_PER_IP` (now 600 per minute,
  was a fixed 60) and `JOURNAL_RATE_PER_ADDRESS` (300), and the capture's
  `ARCHIVE_CAPTURE_CONCURRENCY`, `ARCHIVE_CAPTURE_TENANT_CONCURRENCY`,
  `ARCHIVE_BACKFILL_CONCURRENCY`, `ARCHIVE_GRAPH_CATCHUP_MINUTES`,
  `ARCHIVE_GRAPH_POLL_MINUTES`, `ARCHIVE_IMAP_IDLE_MAX`, `ARCHIVE_IMAP_POLL_MINUTES` and
  `ARCHIVE_IMAP_LOGIN_POLL_MINUTES` (`.env.example`).
- Rollback to 0.4.3 after the migrations was not tested: take a database backup before the
  update and restore it to go back.

### Known Issues

- Graph capture was tested against a simulated Graph API, IMAP archiving against a simulated
  IMAP server and the Dovecot of the release smoke, forwarding against the receiver itself;
  never against a real Microsoft 365 or Google Workspace tenant, Postfix, mailcow or hoster.
- Holds in a Microsoft 365 tenant are not detected: Graph v1.0 offers no way to read them, so
  an administrator confirms them per source. Of the Recoverable Items only the deletions
  folder is read; mail purged before Restow fetched it can be missing. Graph cannot export
  mail over about 150 MB; such mail is logged, not archived.
- The receiver does not check the sender (SPF), and its limits count per api process.
- IMAP sources with OAuth2 still cannot be created in the API or the interface, so a Google
  Workspace account is recognised by its host or folder list only.
- The integration API's archive status and report do not list forwarded copies as a channel
  of their own (see Breaking Changes).
- The known issues of 0.4.3 still apply.

### Verification

Before the tag, on the release branch (0.4.3 plus the 0.4.4 workstreams): lint and typecheck
of all workspaces, the unit and Postgres suites of every package on Postgres 16 (with the
Postgres guard), the web DOM tests on happy-dom including the layout-width and green-is-proof
checks, the v1 OpenAPI test, drizzle-kit without drift, gofmt, go vet and the Go tests of the
agents, the Perl tests of the Proxmox VE plugin, the server installer and demo reset tests,
shellcheck, the CI script tests, the smoke runner's unit tests and the third-party notices.
The release smoke, including the new check of the archive capture against Dovecot, runs in
the release pipeline; no real Microsoft 365 tenant, Google Workspace or mail provider was used
before the tag.

## [0.4.3] - 2026-10-22

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.3 stops a locked repository from failing a Proxmox VE restore check (it is
postponed and, if the lock stays, reads "Could not check" in amber with who holds the lock)
and tidies VMs & containers up into tabs with search, filters, a detail panel and tables
that no longer jump while backups run. Proxmox VE nodes and agents follow a server update
even when its announcement went unanswered, "Update nodes and agents now" starts that step
by hand, and restow-pve restarts the PVE daemons after it updates itself. No database
migration; nodes still on restow-pve 0.4.1 need one update by hand (Upgrade Notes).

### Breaking Changes

None. The integration API contract stays at 1.5.0. In the session API, a Proxmox VE guest's
`lastVerify.state` can be `yellow` (with `notChecked`) and a node carries `offeredVersion`
and `outdated`; both are additive.

### Added

- Updates tab: **Update nodes and agents now** on the card of nodes and agents. When the
  server runs a newer release than its Proxmox VE nodes and agents but no update led into the
  step where they follow it (an update by hand, or one whose announcement went unanswered),
  an administrator with every tenant starts that step: new runs pause for at most 15 minutes,
  reachable nodes and agents install the release when idle, and the pause ends once they are
  done (`POST /api/v1/updates/fleet/update-now`, audited as `update.fleet_started` with
  `manual: true`). Outside an update, nodes and agents that are behind show as "Update
  available".
- Proxmox VE inventory (`GET /api/v1/pve`): every node carries `offeredVersion` (the
  restow-pve release the server offers) and `outdated` next to its `helperVersion`.
- Releases publish the two images of the public demo as well (`restow-demo-seed` and
  `restow-demo-dovecot`, amd64 and arm64, signed, with SBOMs and the release's tags), and
  `deploy/demo/reset.sh` can follow a channel or a fixed version (`RESTOW_DEMO_FOLLOW` in
  `deploy/demo/.env`): the nightly reset pulls the images of one release and stops before it
  changes anything when they do not match or a pull fails (deploy/demo/README.md).

### Changed

- **VMs & containers** is tidied up into three tabs with counts: Guests (the default), Backup
  jobs and Nodes. The note that the Proxmox VE host itself is not backed up is one line on the
  Nodes tab and can be hidden. The Nodes tab shows each node's heartbeat, its restow-pve
  version with "Update to …" when the server offers a newer release (`outdated`), its Proxmox VE version, how many
  guests it has, its queue and its problems; queue control and revoking are in the row menu.
- The guests table has a search over ID and name, filters by node, kind (VM or container),
  backup job (also "No backup job") and state, a "Problems only" button (failed, warnings or
  gaps, a restore check that failed or could not run, waiting for a disconnected or paused
  node, not backed up), sortable columns (ID, name, node, last backup, backup size, state), pages of
  25 to 250 guests and the count of what the filters leave. Tab, search, filters, order,
  page and the open guest live in the address, so a link opens the same view.
- A guest's row shows one state badge, chosen by priority, with a small progress bar while
  its backup runs or "+N" for further problems. Clicking the row (or its name) opens a detail
  panel with every state, the complete error and warnings of the last run in a scrollable,
  copyable block, the restore check with what it found (or, when a locked repository kept it
  out, who holds the lock, amber), the backup sizes, the backup job, the
  newest runs and the actions (back up now, stop, withdraw, check now, open the guest page).
- The Backup column says how large a guest's first (full) backup was and what the last
  follow-up added, for example "First: 32 GB on Oct 3 · Last: +210 MB"; the detail panel
  shows the new data of each of the last 30 backups as small bars (#58).
- The README screenshots show 0.4.2, with two new views (the mail archive and a server).
- Development: the web tests run on happy-dom 21.

### Fixed

- Proxmox VE: right after a container backup, the new restore check often failed with
  `restic check failed (exit code 11) the "unlock" command can be used to remove stale locks`
  and the guest showed a red "Restore check failed", although the check never ran: another
  run (usually the guest's own backup, whose lock a cancel or an API restart had left behind)
  held the repository's lock. A check a lock keeps out is no longer a failed check: it is
  tried again ten minutes later, the previous result standing, and after two hours the
  restore point reads "Could not check: repository locked" (yellow, attention, never red or
  green) with restic's report of who holds the lock. The worker removes stale restic locks
  before the check and before retention, restic waits up to two minutes for a lock during the
  check and up to 15 minutes during the container backup (restow-pve), a guest is not checked
  while a run of it is going or its node took on a backup of it, and a new restore point is
  checked two minutes after its commit at the earliest. A cancelled or ended run may still
  delete its own restic lock (every other request of it is refused and audited). A failed
  check keeps restic's explaining lines, not only its last one. No database migration.
- Updates: announcing an update could report "The updater is not running" although the
  updater accepted it a few seconds later. The api waited 5 seconds for an answer while the
  updater checks Docker, the Compose configuration, the disk space and the running version
  first (5 to 12 seconds on real installations). The update then ran without the pause of new
  runs, without the `update.scheduled` audit entry and without the step in which Proxmox VE
  nodes and agents follow the server, so they stayed on the old release. The api now waits up
  to a minute for the announcement (30 seconds for cancelling, dismissing, restarts and
  deleting a dump); when the answer is still lost it reads the updater's state again and
  treats the update as accepted when the updater shows it. The pause is lifted only on a
  clear refusal or an idle updater, and "Start now" after waiting for runs no longer sends a
  false failure notification. The updater answers faster: it checks once per announcement
  and reuses the measured database and image sizes of the last ten minutes (the run's first
  step measures again). The Updates tab reads the state again after a failed announcement
  and says it is checking whether the update was accepted instead of "not running".
- Updates: the Updates tab could say "The updater is not running" for a few seconds every now
  and then. When the updater's check of the last 30 seconds had expired, it checked again
  before it answered (several short-lived helper containers), which could take longer than
  the 5 seconds the api waits for the state, and the api then remembered "no updater" for
  8 seconds. The updater now answers at once with its last check and checks again in the
  background (an update still checks anew before it starts), and a plain state read that
  times out keeps the updater's last state for up to 30 seconds after its last answer.
- Proxmox VE: after a self-update (automatic, "update now" or `restow-pve update`) the PVE
  daemons kept the old storage plugin loaded until they restarted. restow-pve now restarts
  pvedaemon, pveproxy, pvestatd and pvescheduler like the installer does (`systemctl
  reload-or-restart` on the running ones; a failure is logged and does not undo the update).
  `restow-pve update` also restarts the running restow-pve service, so the node reports the
  new release with its next heartbeat. A node that an older restow-pve updated restarts the
  daemons once by itself (it remembers the plugin files it restarted them for).
- VMs & containers no longer jumps while backups run: the guest and job tables keep fixed
  column widths and one row height (loading rows included), long texts are cut to one line
  instead of wrapping, the progress has a reserved slot, and "Back up now", "Stop",
  "Withdraw" and "Stopping…" share one button size. Error texts no longer appear in red under
  a guest's row, and warnings no longer only in a tooltip.
- Demo: during the nightly reset the demo shows a short page in English and German that
  reloads every minute, instead of a 502. After signing in, the overview opens on a customer
  tenant instead of the empty provider organization, and the simulated machines report the
  running release as their agent version instead of 0.2.1.

### Security

None.

### Upgrade Notes

New image, no database migration, no new required environment variables, and the
`docker-compose.yml` of 0.4.0 stays.

- Proxmox VE nodes should run restow-pve 0.4.3: it waits for the server's repository lock
  during a container backup and restarts the PVE daemons after it updates itself. Nodes on
  restow-pve 0.4.2 install it with the step after the server update (or "Update nodes and
  agents now"). Nodes on restow-pve 0.4.1 ignore "update now" and that step; they update with
  their own check (two minutes after the service starts, then every six hours), or by hand
  once no backup or restore runs on the node:
  `/opt/restow-pve/bin/restow-pve update`, then
  `systemctl restart restow-pve pvedaemon pvestatd pveproxy pvescheduler`. From 0.4.3 on
  restow-pve restarts the daemons itself; a node that an older release updated does it once
  after the new release starts.
- Restore checks that a locked repository failed before the update stay red until the next
  check of the guest ("Check now" on the guest or VMs & containers).
- Demo hosts: the demo images are now published with every release; to let the demo follow
  them, set `RESTOW_DEMO_FOLLOW` as deploy/demo/README.md describes.
- Rollback: 0.4.2 starts on the same database. It shows a restore point that could not be
  checked as unchecked.

### Known Issues

- The new parts were tested against a simulated Proxmox VE API and S3 store only, never
  against a real Proxmox VE cluster or S3 provider.
- The redesigned VMs & containers page was tested with DOM tests, not visually in a browser
  with thousands of guests.
- The known issues of 0.4.2 still apply, except the file share repository healing, which
  comes later.

### Verification

Before the tag, on the release branch (main plus the 0.4.3 workstreams): lint and typecheck
of all workspaces, the unit and Postgres suites of every package on Postgres 16 (with the
Postgres guard), the web DOM tests on happy-dom 21 including the layout-width and
green-is-proof checks, the v1 OpenAPI test, gofmt, go vet and the Go tests of the agents,
the Perl tests of the Proxmox VE plugin, the server installer and demo reset tests, and
shellcheck. The release smoke runs in the release pipeline; no real Proxmox VE cluster or S3
provider was used before the tag.

## [0.4.2] - 2026-10-21

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.2 stops a running backup from the web app (Proxmox VE, servers and clients,
file shares) and lets Proxmox VE nodes and agents follow a server update before new runs
start. A container whose repository went missing after a storage change begins a new
backup chain instead of failing, and a storage "move" now copies the restic repositories
of containers, machines and file shares. Every new Proxmox VE restore point is checked
within minutes of its backup. The storage check tells a pack it could not read for the
moment (a transfer or permission error) from a damaged one. The restore explorer lists one
entry per person and shows a mailbox's calendar by month; the mail job editor asks first
whether a job backs up, archives or both. The installation has a time zone of its own, and
`restow-agent update` installs the offered agent release at once. Six database migrations.

### Breaking Changes

None. The public API's `storageIntegrity.state` has the new value `unreadable` (integration
API contract 1.5.0, additive); clients that handle its values exhaustively should accept
it. "Keep existing backups where they are" is refused while containers or file shares have
restic repositories (see Fixed and Upgrade Notes).

### Added

- Proxmox VE: "Reset repository" for a container (guest page, danger zone): the guest's name
  typed, a recent sign-in, audited (`pve.repository.reset`). Its restore points become
  unavailable at once and the next backup begins a new chain
  (`POST /api/v1/pve/guests/:id/repository/reset`).
- Where backups land: `GET /api/v1/storage/destination` names the tenant's effective primary
  repository. The guest page and its new "Back up now" dialog, the PVE job and connect dialogs,
  a machine's and a file share's page and the job editors show it; the installation default on
  the server's local disk is highlighted. The Repositories section and the dialogs that add PVE
  nodes, machines and file shares warn "Backups land on the server's own disk" when the primary
  is a directory on a disk of the server itself (not a network share).
- Proxmox VE: every new restore point is checked within minutes of its backup, a bounded
  number per pass, besides the weekly check of every guest. Installation › Proxmox VE has the
  setting "Check every new restore point right after the backup" (on by default;
  `GET/PUT /api/v1/settings/pve`). One database migration.
- Proxmox VE in Recovery readiness: "Check now" per guest and "Check all unverified"
  (`POST /api/v1/pve/guests/:id/verify`, `POST /api/v1/pve/verify-unverified`); the footer
  names the Microsoft 365 schedule as such and says how VMs and containers are checked.
- Proxmox VE backup jobs take the cadences of a mail job: every few hours, daily, on chosen
  weekdays, monthly or a cron expression (not more often than hourly).
- The Restow server's own VM: found by its SMBIOS UUID (restow-pve 0.4.2 reports it with the
  inventory) or marked by an admin on the guest's page. It is marked in the lists and the job
  editor, no job backs it up, and "Back up now" and putting it into a job need a confirmation
  that names the self-backup risk (docs/PVE.md, "The Restow server's own VM").
- Stop a backup from the web app, without SSH on the node. Proxmox VE: **Stop** in the VMs &
  containers table, on the guest's page and in the run drawer withdraws a queued backup at once
  and stops a running one: restow-pve now keeps its heartbeat going while a backup runs, gets
  the cancel order with it and stops the vzdump task through the PVE API (a backup started in
  PVE: its provider). The run ends **cancelled**, not failed, and shows "Cancelled by <user>".
  Per node: **Pause queue** (no new backup starts until resumed) and **Cancel all queued**,
  also for the whole tenant. Servers and clients: **Stop backup** on the machine's page and in
  the run drawer; the agent stops restic cleanly with its next heartbeat (every minute while
  it backs up). Runs of file shares can now be cancelled from the run drawer as well (Microsoft
  365 and IMAP runs already could). Every stop asks first and is audited.
- Nodes and agents follow a server update: after the server runs the new release, new runs
  stay paused while Proxmox VE nodes and agents install it (they are idle then), until every
  reachable one reports it or 15 minutes have passed. The Updates tab shows their progress and,
  for the ones not reached, the command for an update by hand. **Update to <version>** on a
  node and on a machine asks for the update at any time.
- Updates can be planned for a chosen date and time (in the installation's time zone) besides
  the lead times from now; nothing pauses before, and everyone sees a notice from a day before.
- `restow-agent update` on a machine, like `restow-pve update` on a node: it installs the
  release the server offers right away, through the same signed download as the automatic
  self-update, restarts the service and says what it did; while a backup runs it refuses and the
  agent updates itself once idle. The Updates tab names it for agents that were not reached
  (and the service restart for agents before 0.4.2).
- The installation has a time zone of its own: chosen in the setup wizard (the browser's zone
  preselected) and changed by an owner under Installation › Server & operation › Server, with
  a searchable list of zones. Planned updates are read in it and a new tenant starts with it.
  Without a choice, `RESTOW_TIME_ZONE`, then `TZ`, then Europe/Berlin apply as before.
- When an update is available, the version in the sidebar becomes a highlighted, gently
  pulsing **Update to <version> available** that leads to Installation › Updates (for those
  who may install updates; no animation with reduced motion).
- Restore explorer: a mailbox's calendar has a month view, day by day across all its calendars
  or one, and a series in the list opens onto its occurrences, derived from the stored pattern
  with the changed occurrences in place (new `GET /api/v1/snapshots/:id/calendar`, audited as
  `snapshot.calendar.read`).
- Restore explorer: one entry per person. A person's mailbox, OneDrive and IMAP account are
  grouped; the second column shows Mail, Calendar, Contacts and OneDrive, each with its own
  restore points. SharePoint and Teams sites have a section of their own, an orphaned OneDrive
  is listed under its owner's name as "Account deleted". The list comes a page at a time from
  the new `GET /api/v1/snapshots/people` (keyset paging, search over names, addresses and
  account ids, type filter, all in the database), so tenants with 10,000+ people never load
  everyone at once. The snapshot objects carry `ownerKey` and `ownerName`.
- Mail job editor: the first question is what the job should do, back up, archive or both
  (both is the default for a new job). While it archives, the editor names the capture
  (Exchange journaling) with the way to its setup and suggests backing up every 8 hours;
  backing up alone names the gap between two runs.

### Changed

- A red restore check of a guest shows the error it found (for example restic's) in the guest
  list, Recovery readiness and on the guest page, instead of only "blocks did not match or
  could not be read".
- /virtualization: the State column keeps its width and height while a backup reports
  progress; long messages are cut, with the whole text in the tooltip.
- Storage integrity: a pack the storage check could not read (a download cut off
  mid-transfer, a reset connection, a timeout, S3 asking to slow down, or denied access) is
  no longer shown or rated as damaged. Recovery readiness › Storage integrity lists it as
  "temporarily unreadable" with the error, how many consecutive checks could not read it,
  and when first and last; every later check reads it first, and "Re-check these packs"
  reads only the flagged packs again. Objects using it are rated "Attention"; they become
  "Not restorable" only when a pack is proven damaged (missing, wrong size or checksum) or
  could not be read in 3 consecutive checks over at least 24 hours. When the packs read
  intact again, the storage finding ends and the object's restore checks rate it again. The
  public API's `storageIntegrity.state` has a new value, `unreadable`.
- A run that was stopped on request is `cancelled` (machines: a new run and task status);
  it raises no failure alert and does not count as the last backup.
- Database: index `protected_objects (tenant_id, user_id)` for a person's objects.
- Restore explorer: calendar events sort by when they start (newest first, or upcoming first)
  instead of by subject, with When, Location and Organizer columns.
- Exchange backup: an event's metadata records its location and the end of a series range.

### Fixed

- Proxmox VE: after the primary repository changed with "keep existing backups where they
  are", every container with an existing repository failed with `repository does not exist`
  (exit 10): the server trusted `repository_ready_at` and never checked the repository was on
  the new primary. Before a backup gets its restic credential the server now checks it (once
  per run). Missing everywhere, a new repository and a new backup chain begin, visible on the
  guest page ("New backup chain started on …: the previous repository was not found at …") and
  in its history, audited as `pve.repository.reinitialized`; the earlier restore points become
  unavailable (no restore, no check, not counted for readiness, skipped by retention). Still on
  a retired target, the backup is refused with a clear message instead. Restores read the
  repository from whichever target holds it. One database migration.
- Storage: "Keep existing backups where they are" and promoting a copy are refused
  (`storage-switch-blocked-by-repositories`; the dialog offers "keep" disabled) while
  containers or file shares have restic repositories, which only "move" takes along.
- Storage: a "move" now copies the restic repositories of containers, machines and file shares
  (from the target that holds each one), verified by size and by SHA-256 like packs, waits for
  running container backups and file share runs before it switches, and retention of
  containers and file shares waits for it. It also copies the manifests of VM and container
  restore points, which it treated as pruned before. A retired location is no longer removable
  while it alone holds a container's or file share's repository.
- Proxmox VE backups ended with "TASK WARNINGS: 1" and restow-pve reported them as failed
  although the restore point was committed: restow-pve asks vzdump for no notes any more, the
  storage plugin takes a notes update as a no-op, and a backup vzdump ends with warnings after
  its restore point was committed counts as "Succeeded with warnings".
- restow-pve's late task result was refused with "404 Task not found" once the server had
  closed the task (by the run's own end, the worker, or its expiry during an outage): the
  server takes it and settles the run (a committed restore point always counts as succeeded),
  a task whose run is still open no longer expires, and restow-pve keeps a result the server
  could not take and sends it again with the next heartbeat instead of losing it.
- The storage check read each pack once: a download that broke off mid-transfer (Node's
  "aborted", which the S3 client does not retry) made a ~65 MB pack "unreadable", the page
  said "2 packs are damaged … No intact copy exists in any repository", and the mailbox was
  rated "Not restorable" although a restore check read 20 of 20 items back byte-exact. The
  check now reads a pack again after a transfer error, whole, up to 3 times (2 s and 8 s
  apart), hashing as it streams into a buffer of the pack's recorded size. Reads from S3
  (restores and restore checks included) resume a body that breaks off from the first
  missing byte, pinned to the object's ETag.
- The maintenance and update banner covered the top of pages that size themselves to the
  window: the layout now accounts for the banner's height, also when it wraps to several
  lines.
- The update progress said "Downloading {image}" (and "{file}", "{services}"): those steps
  now name the version instead of a placeholder the updater never fills.
- Switching the tenant on a job's page opens the jobs of that kind in the new tenant instead of
  saying that the job does not exist; any detail page gives way to its list.

### Security

None.

### Upgrade Notes

New image and six database migrations, which run in seconds whatever the size of the
installation:

- `0053_pve_repository_chains`: a container's new backup chains
  (`pve_guests.repository_chains`) and `pve_snapshots.unavailable_at`.
- `0054_pve_runs_042`: the Restow server's own VM (`pve_guests.restow_server_detected`,
  `restow_server_flagged`, `self_backup_confirmed_at`), `pve_snapshots.verify_requested_at`
  and the installation's Proxmox VE settings (`settings.pve_settings`).
- `0055_pack_read_failures`: a new, empty table. Packs an earlier storage check reported
  unreadable count as temporarily unreadable after the update and are read again first by
  the next check; no full check is needed.
- `0056_cancel_and_fleet_update`: cancel requests and `cancelled` states for tasks and runs, a
  node's paused queue, "update now" for nodes and machines, the phase `fleet` of the job-start
  pause, `settings.planned_update`.
- `0057_explorer_people`: an index on the protected objects of a person in a tenant, for the
  restore explorer's list of people.
- `0058_installation_time_zone`: `settings.time_zone`. An existing installation has no time
  zone of its own after the update: `RESTOW_TIME_ZONE`, else `TZ`, else Europe/Berlin applies
  until an owner chooses one under Installation › Server & operation › Server
  (docs/UPDATING.md, "The installation's time zone").

No new required environment variables, and the `docker-compose.yml` of 0.4.0 stays.

- Proxmox VE nodes should run restow-pve 0.4.2: it reports the Restow server's own VM, keeps
  its heartbeat going while a backup runs (for Stop and the progress) and no longer reports
  backups with "TASK WARNINGS" as failed. The fleet update after the server update installs
  it on every reachable node; the Updates tab names the command for the others.
- Stopping a running backup needs restow-pve 0.4.2 on the node and agent 0.4.2 on the machine;
  an older node ends a cancelled backup at its next upload (the server refuses it), an older
  agent finishes it. Both update themselves with this release.
- "Keep existing backups where they are" (and promoting a copy) is refused while containers
  or file shares have restic repositories; change the primary repository with "move", which
  now takes them along.
- Storage check reports from before 0.4.2 are read again: packs they listed as unreadable
  count as temporarily unreadable, not damaged, and the next check reads them first. An
  object rated "Not restorable" only because of such a pack is rated "Attention" until that
  check.
- Integration API contract 1.5.0 (additive): `storageIntegrity.state` can be `unreadable`.
- Rollback: the migrations only add a table, columns, indexes and enum values and widen a
  check; 0.4.1 starts with them, but runs and tasks in the state `cancelled` are unknown to
  it.

### Known Issues

- A file share whose repository went missing after a storage change is not yet healed the
  way a container's is (a new backup chain); this comes in 0.4.3.
- The fix for the maintenance and update banner covering the top of window-sized pages was
  not verified visually in a browser.
- The new parts were tested against a simulated Proxmox VE API, S3 store and Microsoft
  Graph API only, never against a real Proxmox VE cluster, S3 provider or Microsoft 365
  tenant.
- The restore explorer's list of people groups the tenant's protected objects in the
  database for every page it serves; that is fine up to about 10,000 people per tenant and
  slower beyond.
- The known issues of 0.4.1 still apply.

### Verification

Before the tag, on the release branch (main plus the 0.4.2 workstreams): lint and typecheck
of all workspaces, the i18n tests, the server installer tests, the v1 OpenAPI test, gofmt, go
vet and the Go tests of the agents, the Perl tests of the Proxmox VE plugin, and the unit and
Postgres suites of every changed package on Postgres 16. The release smoke runs in the
release pipeline; no real Proxmox VE cluster, S3 provider or Microsoft 365 tenant was used
before the tag.

## [0.4.1] - 2026-10-16

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.1 counts the restic repositories of machines, file shares and Proxmox VE
containers in the stored bytes, instead of the chunk store alone, and says when a running
container backup shows no progress because its node runs an older restow-pve. One database
migration.

### Breaking Changes

None. `physicalBytes` of `GET /status` and of `usage` in `GET /storage` now include the
restic repositories (see Fixed); the fields and their types stay.

### Added

None.

### Changed

- Repositories › Usage: the chart is called "Chunk store per day", and its note says that
  the restic repositories keep no history and are not part of the growth.

### Fixed

- Repositories › Usage, the Stored tile of the dashboard, the statistics and `GET /status`
  and `GET /storage` of the API counted only the packs of the chunk store: a tenant with
  10 GB of container backups saw "Stored 10.9 kB" and "0 B backed up". Stored now adds the
  restic repositories of machines, file shares and Proxmox VE containers, and the usage card
  shows how much of it is in the chunk store and how much in restic repositories. The
  deduplication saving, the growth and the chart stay figures of the chunk store, and say
  so; "Protected data" names the sources it does not include instead of "No completed
  backup yet". The dashboard tile lists the repositories on a line of their own instead of
  "0 B backed up".
- The size of a container's restic repository was not recorded. The restic route now
  measures it once at the first upload after the update, then counts every upload and
  deletion, and the worker measures it again after a prune. A view never lists a
  repository (it may live on NFS).
- A running container backup on a node with restow-pve before 0.4.0 showed "No progress
  reported yet" for its whole run. It now says that progress needs restow-pve 0.4.0 on that
  node, which version the node runs, and to update the node.
- restow-pve asked for an update only six hours after it started, so a restarted node kept
  an old version for hours. It now asks two minutes after the start, then every six hours;
  the update still waits until no backup or restore runs.

### Security

None.

### Upgrade Notes

New image and one database migration, `0052_pve_guest_repository_bytes`
(`pve_guests.repository_bytes` and `repository_measured_at`), which runs in seconds. No new
required environment variables, and the `docker-compose.yml` of 0.4.0 stays.

- The repository of a container counts under Stored from its next backup on, of a machine
  or file share as before (from its next backup or retention run); until then it counts as
  zero.
- Nodes pick up restow-pve 0.4.1 by themselves, within two minutes of their next start or
  within six hours, while no backup runs.
- Rollback: the migration only adds two columns; 0.4.0 runs with them.

### Known Issues

- A repository's size has no history: the statistics count the current size of a restic
  repository at every moment of a period since its machine, share or container was added,
  so the growth of Stored there comes from the chunk store only.
- Uploads that finish while the first measurement of a repository lists it may be left out
  until the next prune or retention run measures it again.
- "Protected data" still counts the chunk store's sources only; the logical size of
  restic backups is not added up.
- The known issues of 0.4.0 still apply.

### Verification

Before the tag, on the release branch (main plus the 0.4.1 fixes): lint and typecheck of
all workspaces, the server installer tests (679), gofmt, go vet and the Go tests of the
agents, and the full unit and Postgres suites on Postgres 16: packages/db 195, packages/i18n
273, packages/core 2311 (6 skipped), apps/scheduler 73, apps/api 3816 (5 skipped), apps/web
4124, apps/worker 529, ee/api 247, ee/licensing 59, ee/web 176, ee/worker 5, packages/cli
34, the demo seed 208; 141 Postgres test files, none skipped. A container backup with the
real restic binary checked the size the restic route counted against the repository. The
re-measurement after a prune ran in no test with a real repository. The release smoke runs
in the release pipeline; no Microsoft 365 tenant was used before the tag.

## [0.4.0] - 2026-10-15

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.4.0 backs up SMB and NFS file shares from the server, without an agent on the
file server, and restores them with their permissions. It adds a notification matrix per
channel and event, shows the progress of running Proxmox VE backups, lets an update wait
for or cleanly stop the backups in progress, and moves the database to another disk from
the web interface. It adds immutable backups (S3 Object Lock per repository, a deletion
delay for directories), ransomware detection on every new restore point with a retention
hold while a finding is unresolved, boot tests and file restore (Preview) of Proxmox VE VM
restore points, backup and restore of SharePoint Online sites, agent policies, and file
restore for the restore role. S3 endpoints saved from now on must use HTTPS. Seventeen
database migrations run at start; file share backup and the database move need the 0.4.0
`docker-compose.yml` (run the 0.4.0 installer again after the update, see Upgrade Notes).
SharePoint needs an added permission and a new admin consent per tenant.

### Breaking Changes

Nothing stops working on update: existing compose files, webhooks, notification
recipients, API clients and agents keep working as before. What behaves differently:

- **Notifications follow the matrix.** Every channel (the bell, each webhook, each
  notification recipient) now keeps the events it gets, and an alert rule no longer sends
  an event to a channel whose column has it off. Migration 0038 fills every column with
  exactly what the channel received before, so nothing changes on update. Afterwards:
  - The webhook dialog no longer has an event picker. Choose a webhook's events under
    Integrations › Notifications.
  - A webhook created after the update (in the interface, or through the API without
    `events`) starts with the defaults of its format: a Discord, Slack or Teams webhook
    gets errors and warnings, a signed JSON (`restow`) webhook everything. A rule that
    sends other events to it delivers them only once they are switched on in the matrix.
  - The webhook stream keeps its event names (`job.failed`, `job.completed`,
    `verify.completed`) and payloads. `backup.succeeded` is the matrix's name for what the
    stream calls `job.completed` (an alias, not a rename); a webhook subscribed to
    `job.completed` keeps getting it. `events` on create and update still means the
    subscribed stream events; the session API also returns the webhook's column as
    `notifyEvents`.
  - The four flags of a tenant's notification recipients (`notify_job_failures`,
    `notify_weekly_report`, `notify_readiness_red`, `notify_license_updates`) are replaced
    by an event list. The tenant API still accepts and returns `categories`; a recipient
    now also carries `events`. "Licence and update notices" never sent anything and is no
    longer returned. Only scripts that read these columns from the database directly need
    a change.
- **New installations start the mounter.** `install.sh` now starts the mounter (compose
  profile `mounts`, it holds the Docker socket) by default, because file share backup runs
  through it. Scripted installations that do not want it pass `--no-mounter` (or
  `--without-mounter`). Running the installer again on an existing installation keeps that
  installation's choice.
- **Installer guard.** Once the database was moved to another disk, `install.sh` refuses
  (exit code 8, nothing changed) to put in place or start a `docker-compose.yml` that does
  not read `RESTOW_POSTGRES_DATA` from `.env`, so an older release file cannot start the
  stack without its database.
- **Building from source needs Node.js 22.12 or newer** (`engines` in `package.json`;
  commander 15 requires it). The Docker images run on `node:22-slim` as before; nothing
  changes for Docker installations.

### Added

Unless marked otherwise, everything below is part of every edition (the Community core).

#### File shares (SMB and NFS)

- **File share backup**, in the menu next to VMs & containers. Restow mounts an SMB share
  (Windows Server, Samba, a NAS) or an NFS export read-only for the length of one run, in
  a short-lived runner container started by the mounter, and backs it up with restic into
  a repository of its own (`file-shares/<share id>/` on the tenant's primary repository).
  No agent on the file server, and the api and the worker are never restarted. NTFS
  permissions (and NFSv4 or POSIX ACLs, best effort) are kept in each restore point. Open,
  unreadable and offline files are skipped and listed in the run, which then ends "with
  warnings". SMB 2.1 to 3.1.1; SMB1 and NTLMv1 are refused. Requirements (the mounter, the
  `cifs` module or the NFS client on the Docker host, the ports, the account) are in
  docs/FILESHARES.md.
- **Add file share** tests the connection and whether permissions are readable; the
  password is sealed with the tenant key and never shown again. Backup jobs of the kind
  **File shares**: schedule (at most hourly), folders, file types to skip, retention
  (daily, weekly, monthly). Tenant admins manage their own shares; a share on a private or
  loopback address needs a provider admin's approval or the installation switch **Tenants
  may use private networks**.
- **Restore** from a restore point (browse, search, versions): download as ZIP, restore to
  a new folder, to the original location (overwrite, keep both, skip) or into another
  share, with permissions where the target allows it. Restores into a share need **Allow
  restore to this share** on it (off by default).
- **Restore checks**: every new restore point is checked by reading up to 20 sampled
  files back and comparing them, and the repository gets a weekly `restic check` of 5 % of
  its data; Recovery readiness rates a share by its newest restore point. A restore check
  of a restore point without samples (every file changed in the hour before the run) rates
  yellow and says why.
- **Copy jobs**: on a schedule, the newest restore point of share A that passed its restore
  check is written into a folder of share B, in mode `overwrite` or `mirror` (mirror
  deletes only inside that folder; refused into a share root or the source share, and
  stopped when the restore point has fewer than half the files of the last copy). A copy
  job keeps no versions and is labelled as not being a backup.
- **Budgets** per share, per tenant and as a default (off by default; provider admins): a
  warning at 80 %, no new backups at 100 %.
- File shares count in the status tab, the start page, Recovery readiness, warnings,
  History, the statistics and the provider view, with the alerts
  `file_share_backup_failed` and `file_shares_without_job`.
- **Enable network shares** (Installation › Default repository & network shares, and the
  notice on the File shares pages) starts the mounter of an existing installation through
  the opt-in updater, for the provider owner, with a recent sign-in and an audit entry.
  File share runners, on the same page, sets how many runs go at a time and the memory per
  run.

#### Immutable backups

- **Immutability per repository**, on each repository's card (Repositories › **Change
  immutability**), off until an administrator turns it on. What is locked: packs,
  committed manifests and wrapped keys of the chunk store (Microsoft 365, IMAP, Proxmox VE
  disks) and the `data/`, `snapshots/`, `keys/` and `config` objects of every restic
  repository (machines, file shares, Proxmox VE containers). Not locked: checkpoints,
  staging, exports, downloads, restic `locks/` and `index/` files (`restic repair index`
  rebuilds the index from the locked packs). See docs/STORAGE.md, "Immutable backups".
- **S3 Object Lock** (`compliance` or `governance`, 1 to 3650 days): turning it on checks
  the bucket's Object Lock configuration and refuses a bucket without it. Every locked
  object is written with a retain-until date of the period plus 7 days; the daily retention
  job **renews** the lock of every object still in use once the last complete renewal is 6
  days old, so data that new restore points reuse stays locked for at least the period.
  A renewal that was interrupted continues where it stopped. Retention, garbage collection
  and restic prune treat a deletion the storage refuses as "not yet": the restore point
  stays visible and restorable, and space comes back once the lock has run out (up to the
  period plus 7 days later). Restow never sends the governance bypass header.
- **Deletion delay** for directories (the Docker volume, an NFS share): Restow's own code
  refuses to delete or overwrite a locked file until the period has passed since it was
  written. It protects against misuse of Restow (a stolen administrator account, a
  retention policy shortened to delete restore points), not against someone with access to
  the server or the share, and the interface says that it is not immutability.
- **Verification**: the daily retention job and **Verify now** ask the storage for the
  retention of a sample of recent objects; objects without a lock or in a weaker mode, a
  renewal that is overdue or failed and deletions waiting for their lock are shown on the
  repository card, the dashboard's storage tile and, as `immutability_warning`, in the
  provider view. Restore points of the restore explorer and of a machine show "Immutable
  until <date>", green only for a COMPLIANCE retention the storage itself reported.
- **Who may change it**: raising the protection is open to whoever may configure the
  repository; lowering it (fewer days, a weaker mode, off) is for the provider owner with a
  sign-in from the last ten minutes and applies only to data written from then on. Every
  change and verification is audited (`storage.target.immutability_changed`).
- What it protects against: an attacker on the Restow server, someone holding Restow's
  storage key, a stolen administrator account, a shortened retention policy. What not:
  someone who controls Restow can stop new locks and the renewal (what is locked stays
  locked until its date); a GOVERNANCE lock is lifted by any account with
  `s3:BypassGovernanceRetention`; delete markers and newer versions can hide locked data
  (the locked versions stay and can be brought back); the master key is not in the bucket.

#### Ransomware detection

- **Every new restore point is judged** for signs of ransomware from data the backup
  already has, every two minutes, for runs of the last 72 hours: the amount of change
  (new and changed files, bytes added) against the object's own history, mass deletions,
  renamed extensions, known ransomware extensions and ransom notes (versioned lists,
  matched on the server), the entropy of sampled new files, and the compression and
  deduplication ratio of the run's new data. The signals apply per kind of object:
  machines, file shares, Proxmox VE containers and VMs, mailboxes, OneDrives, SharePoint
  sites and IMAP accounts (deletions, renames, names and entropy exist only for machines,
  file shares and OneDrives). A signal without data says "not
  available", never clean. It never reads the data a second time, never blocks a backup
  and is no virus scanner. See docs/RANSOMWARE.md.
- **Suspicious** badge (red) on the restore point and the object in every restore view;
  when the newest restore point is suspicious, the restore views offer the newest one
  without findings. A click shows each finding with its numbers and the state of every
  signal.
- **False alarm**: technicians and administrators mark a finding as a false alarm with a
  note, or take it back (audited, `suspicion.false_alarm`, `suspicion.false_alarm_revoked`);
  the restore point then counts as clean and joins the baseline.
- **Retention hold**: while an object has a suspicious restore point nobody resolved,
  retention, `restic forget` and prune delete no restore point of that object, so clean
  older restore points are not pruned while encrypted ones pile up. Backups go on and
  quotas still apply. Only an administrator ends a hold, never a later clean restore point:
  **Mark as false alarm**, or **Release hold** (administrators, recent sign-in, audited
  `suspicion.hold_released`). The object shows "Retention paused" until then.
- **Notifications**: `backup.suspicious` (error, once per attack episode, says that
  retention is paused) and `backup.suspicious_hold` (warning, when a hold is still open
  after 14 days and every 14 days after), in the bell, the rules and the webhooks.
- **Installation › Ransomware detection**: the thresholds of every signal, each signal's
  switch, the retention hold's switch and its reminder days (`settings.ransomware.updated`;
  the provider owner changes them, every provider admin reads them).
- The activity report (deletions, renames, names, entropy) needs the endpoint agent 0.4.0
  on machines; the compression signal needs the agent 0.4.0 on machines and restow-pve
  0.4.0 for containers. File shares get it with the 0.4.0 runner, VMs and Microsoft 365
  objects with the server.

#### Notifications

- **Notification matrix** under Integrations › Notifications (#76): the events as rows,
  grouped and marked by severity; the bell, every webhook and every notification recipient
  as columns, each with the quick choices "Errors only", "Errors and warnings" and "All".
  Saving is written to the audit log (`report.matrix_updated`). Installation events (an
  update is available, low disk space) are rows for provider admins only.
- New events `backup.succeeded` and `verify.completed` for mail and the bell (off in the
  bell by default), and `installation.disk_low` (see Updates and the database).

#### Proxmox VE

- **Progress of a running backup** (#51): VMs & containers, the inventory and the guest's
  page show a progress bar ("34% · 3.2 GB of 9.4 GB · 85 MB/s"). Needs restow-pve 0.4.0 on
  the node; a backup of an older helper shows "No progress reported yet".
- **The helper's own lines in the run's log** (#61): the run id, what restic added, what it
  could not read and the commit of the restore point now reach the log Restow keeps for the
  run. A backup that succeeded with gaps names the items restic could not read (the first
  20).
- **Proxmox VE jobs in Servers & clients › Jobs** (#53), next to the machine jobs with a
  Type column: guests per job, schedule, last and next run, "2 of 5 guests done" while a
  round runs, and a backup started by hand as a row "Manual backup · <guest>" until it
  ends. **New job** is a menu with one entry per type; the Proxmox VE job form lists the
  VMs and containers to put into the job.
- **Create recommended job** (#52) next to every "no job" notice (jobs, inventory,
  sources, directory, VMs & containers) and "Protect everything without a job" on the
  dashboard's readiness card: a preview of what the click creates or adds to, then one
  job per kind (mail every 8 hours; machines per system and profile; one Proxmox VE job,
  daily at 22:00 in snapshot mode). A second click adds to the same job instead of making
  another. Admins only; recorded in the audit log.
- **Files of a container in Servers & clients › File restore** (#62): every container with
  a restore point is listed in the group "Proxmox VE containers"; browse a restore point
  and download files and folders as one ZIP, read by the server from the container's
  repository. The guest page links each container restore point there (**Browse files**).
  Reads and downloads are in the audit log.
- **Files of a VM in Servers & clients › File restore** (Preview): VMs with a restore
  point are listed in their own group "Proxmox VE VMs", marked **Preview**, and the guest
  page links them (**Browse files**). Each readable file system of the VM's disks is a
  folder (`scsi0-p2`, `vg0-root`): partitions of GPT and MBR disks and linear LVM logical
  volumes with ext2, ext3, ext4 (the journal replayed in memory), XFS, NTFS or FAT12/16/32.
  Browse and download files and folders as one ZIP; files that cannot be read are named in
  `_not-restored.txt` inside it. The server reads the disks from the tenant's chunk store
  with its own user-space readers in a short-lived, restricted child process; nothing is
  mounted, on the server or on the node. Not readable: btrfs, ZFS, ReFS, LVM thin, RAID,
  BitLocker and LUKS, NTFS-compressed and EFS files; the XFS log and NTFS's `$LogFile` are
  not replayed. Same routes, roles and audit actions as for containers (with `kind: "vm"`).
  The volume list asks to compare an important restored file with the original before
  relying on it. See docs/PVE.md, "Files of a VM".
- **Boot tests** of restore points: a Proxmox VE job can boot the newest restore point of
  each guest weekly or after every backup (off by default; a memory limit, default 8 GiB,
  and a wait for the guest agent, default five minutes), and **Boot test now** on a restore
  point asks for one by hand. The guest's node restores it as a new guest in the pool
  `restow-restore`, isolates it before the start (every NIC `link_down=1` or an isolated
  bridge, passthrough devices, serial ports, bind mounts and the hook script removed),
  starts it, waits for the QEMU guest agent (a container: its init) and destroys it in
  every case; leftovers are removed when the service starts. One test per node at a time,
  never beside a backup, and only with enough memory and storage. Green when the guest
  agent answered, yellow when the VM only started, red when the restore, the start or the
  boot failed. Readiness rates the newest restore point by its boot test where there is
  one. New events `boot_test.failed` and `boot_test.unproven`. Needs restow-pve 0.4.0 on
  the node (`restow-pve config --boot-tests`, `--boot-test-storage`, `--boot-test-bridge`);
  the guest's page says when its node cannot. Requesting one is audited
  (`pve.boot_test.requested`). See docs/PVE.md, "Boot test".
- A guest shows the average a follow-up backup adds (over the newest 10 restore points
  after the first backup) (#58).

#### Servers and clients

- **Data folders a job misses** (#59): the endpoint agent 0.4.0 reports which of a fixed
  list of Linux data folders (`/opt`, `/usr/local`, `/srv`, `/var/www`, Docker and Podman
  volumes, the PostgreSQL, MySQL and MongoDB folders under `/var/lib`) exist and hold
  files, names only. The job editor names the folders the job's machines really have and
  leaves out, and a machine's page offers **Add this folder to the job**. With older agents
  the notice of 0.3.5 stays.
- A machine's page says what it runs as (container, virtual machine, physical, with or
  without a desktop) (#59).
- The file browser of a restore point says which folders it contains, with a link to the
  job's folders (#59). A machine's restore points say what they contain and what they
  added, like Proxmox VE guests (#58).
- **Agent policies** for servers and clients, on three levels: the installation
  (Installation › Agent policy), the tenant (tenant page › Agents) and the backup job (the
  job editor). Each level may override a setting unless the installation locks it; every
  view says where a value comes from and whether it is locked. The settings: a **backup
  window** (weekdays and a time range, also across midnight, in the zone of the job's
  schedule) in which scheduled backups, catch-ups and retries may start (a running backup
  continues, **Back up now** ignores it); **catch up missed backups** as soon as the
  machine is on again or in the next backup window, optionally only up to a maximum age;
  the **upload limit** of a job without its own (a job can also choose **Unlimited**,
  which sets a policy's limit aside unless the installation locks it; a job whose limit is
  empty keeps inheriting); **only on AC power**; and the number of **automatic retries**
  (0 to 10). Without a policy agents behave exactly as before. The server writes the
  effective policy into each machine's configuration (a new configuration version) and
  audits every change (`settings.agent_policy.updated`, `tenant.agent_policy.updated`,
  `endpoint.config.changed`). The page of a server or client shows the policy that applies
  to it, each setting with its source (default, installation, tenant, backup job or the
  machine itself) and whether it is locked, read-only (restore operators see it too), and
  why a due backup waits next to the next planned start: for the backup window, for an
  update to finish, for AC power, or to catch up in the next window. The agent 0.4.0 sends
  that reason with its heartbeat (`waiting`); for an older agent the page shows none.
  Window, catch-up, retries and the waiting reason need the agent 0.4.0; the upload limit
  and AC power reach older agents too.
- **Agents respect the update pause** (#46): while an update pauses new runs, the agent
  0.4.0 starts no scheduled backup, retry or catch-up and waits for the pause to end (the
  configuration and the heartbeat say `startsPaused`); the wait does not count as a missed
  or failed backup. A **Back up now** request stays queued on the server until the pause
  is over, also for older agents, and `restow-agent backup-now` on the machine waits with
  a message. `restow-agent status` shows the policy and why a due backup waits.
- **File restore for the restore role**: restore operators (membership role "restore",
  `tenant_restore`) now open Servers & clients › File restore. They list the machines, read
  a machine's restore points and their immutability, browse them, download files as a ZIP
  and restore files onto the machine; for Proxmox VE they read the overview and a guest's
  restore points and browse and download files of container and VM restore points. Settings,
  tokens, jobs, backing up, verify and boot tests, restoring a whole guest, revoking or
  deleting and the repository password stay with the administrators (backing up answers
  403), and the web app leaves out the links to pages they may not open. Every read,
  download and restore is audited with the operator as actor.

#### Jobs, live view and dashboard

- **Running backups in the sidebar** (#57): the Jobs entries and VMs & containers show a
  spinner with the number of running backups and the waiting ones beside it; the tooltip
  lists them, a click opens the run.
- **Live run drawer** (#54): the charts move with time between measurements, the numbers
  count up, the time left counts down, and a line says when the run last reported (or that
  Microsoft Graph throttles it). The browser tab's title shows the percent while the drawer
  is open.
- **All tenants in Jobs** (#63, Service Provider): under "All tenants", Jobs of Mail & SaaS
  and of Servers & clients list every tenant with its jobs per kind, what runs and waits,
  how the newest backups ended and the next run, with filters and sorting; a row opens the
  tenant's jobs read-only.
- **Storage growth** on the dashboard (#64): 1 week, 1 month, 3 months or 1 year, from 3
  months on with the estimate as a band between the slowest and fastest growth, and when
  the repository runs full at this growth where its free space is known.

#### Microsoft 365

- The first backup of a large mailbox shows "First backup: X of Y items" over all
  attempts, with an estimated time left (#47). A OneDrive shows "X items so far" until it
  is fully listed.
- **SharePoint Online sites**: every directory sync finds the tenant's sites
  (`/sites/getAllSites`; sites of Microsoft 365 groups and Teams included, personal sites
  left to their owner's OneDrive), and each site is a protected object of its own, in the
  mail jobs like mailboxes and OneDrives. The protection rules have a sites mode: all sites
  (the default) or only the selected ones. A backup holds every document library (with the
  OneDrive engine: delta per library, optional versions, checkpoints), every list with its
  columns and each list item's field values as JSON, and the site's description; a library
  or list Graph refuses is reported and keeps its last copy. New sites get their first
  backup at once; a deleted site fails with `graph.site_unavailable`.
- **Restore of SharePoint sites** in the explorer (libraries, folders, files, lists, items):
  download as ZIP; files and folders into the original library or another library of a
  backed-up site of the same source ("Keep both", "Overwrite" with SharePoint keeping the old
  file as a version, "Skip existing"); list items into their original list as new items,
  writable fields only. Restore checks sample library files like a OneDrive. Sites appear in
  the status, count as no protected mailbox, and are seen by restore operators and
  administrators only. Not backed up: Teams chats, attachments of list items, site design,
  navigation and workflows; permissions are kept as information and never restored. See
  docs/MICROSOFT.md, "SharePoint Online".

#### Updates and the database

- **Runs in progress during an update** (#46): the install dialog counts what runs and
  waits in every tenant and asks: **Stop them cleanly** (the default: Microsoft 365 and
  mail runs save a checkpoint and stop, runs on agents and of file shares are waited for,
  30 minutes at most), **Wait until they finish** (two hours at most) or **Do not wait**
  (as before). From the confirmation until the update is over no new run starts;
  schedules that fall due meanwhile run afterwards. Everyone signed in sees a banner; the
  Updates tab shows what still runs, **Start now** and **Cancel**.
- **Installation › Database** (#73): where the database keeps its data, its size, the
  free space under it and under the local default repository, and what the next update
  needs. With the opt-in updater, the provider owner moves the database to a directory on
  another disk: checked first (another local file system, ext4, XFS, Btrfs or ZFS, room
  for the data), then copied, compared file by file, test-started and switched, with
  automatic rollback on any failure. The old copy is kept and blocked from starting until
  it is removed. See docs/DATABASE.md.
- **Low disk space warning** (#73): every 15 minutes the api checks the disk under the
  database (through the updater) and under the local default repository; below a tenth
  free, and always below 5 GiB, the provider admins get a notice in the bell, and rules
  that list "Low disk space" send it, once per episode.
- **Kept database dumps** (#73): the Updates tab lists the updater's pre-update dumps; the
  provider owner can download one (one-time link, recent sign-in, audit log) or delete it.

#### API

- Integration API contract 1.4.0 (additive): `GET /api/v1/status` has `fileShares`
  (counts of file shares) and the readiness summary `sharesWithoutJob`, and `events` is
  optional when a webhook is created. Nothing was removed or renamed.

### Changed

- Updates: the updater's preflight now adds up what an update writes (the dump, the
  images, room for the migrations, plus `RESTOW_UPDATER_MIN_FREE_MB` as a margin) and
  refuses an update that does not fit (blocker `disk_space`, with the numbers), instead of
  requiring a fixed 1 GB (#73).
- A Linux machine enrolled with a client token whose agent (0.4.0) reports a container or
  a virtual machine without a desktop gets the server profile, because it runs services;
  the machine's page says why (#59). Existing machines keep their profile.
- Adding a folder to a machine job narrows an exclusion of a parent folder: adding
  Docker's volumes turns `/var/lib/docker` into `/var/lib/docker/*` and
  `!/var/lib/docker/volumes` (#59).
- Notification recipients: the categories in the tenant wizard and on the tenant page add
  or remove their events and leave everything else chosen in the matrix alone.
- The live channel stays open while the tab is in the background (closed after ten
  minutes, or when the browser freezes the tab), so a page no longer reloads when you come
  back (#54).
- Mailboxes and OneDrives are named by their person (display name, else address), not by
  their technical id, which moves to a tooltip (#55).
- The sidebar's Installation section folds away to its header; the choice is remembered in
  the browser (#56).
- A machine's danger zone reads "Stop backing up this machine" and says that nothing is
  deleted; revoked machines are hidden in the inventory until "Show revoked machines" and
  have their own group in File restore (#65).
- The machine job editor says that Proxmox VE VMs and containers are backed up by Proxmox
  VE jobs, with links (#53).
- Proxmox VE: sizes are named ("9 GB allocated"); "Waiting for the node" says since when,
  and turns amber while the node is disconnected.
- Container backups on Proxmox VE (restow-pve 0.4.0) let restic scan before it backs up
  (no more `--no-scan`), so there is a total to show progress against.
- docs/ARCHIVE.md explains what journaling captures and misses compared with the mailbox
  backup, and when to use which (#48).
- Dependencies: major updates of the build and test tooling and of two libraries: vite 8,
  @vitejs/plugin-react 6, vitest 5, lucide-react 1.x, commander 15, archiver 8,
  @biomejs/biome 2.5.
- Performance on large installations: the "All tenants" view of Jobs looks up each
  object's newest backup through an index, reads four tenants at a time and keeps each
  tenant's figures for 30 seconds for every viewer (the page refreshes every 15 seconds
  while something runs, else every minute); the sidebar's Proxmox VE badge asks a slim
  endpoint instead of the whole VMs and containers overview; the ransomware judgement
  reads new restore points through partial indexes, judges batch after batch for up to a
  minute per pass and logs restore points that leave its 72-hour window unjudged; the
  reconciler of left-behind jobs runs in one worker at a time; a heartbeat no longer
  rewrites the machine's settings when its facts did not change.
- The file share search needs at least three characters of the name.
- Performance with the largest workloads; memory now stays bounded whatever the size:
  - File share catalog: the first catalog of a share (or one after a gap) streams
    `restic ls` into the database in batches of 5,000 instead of holding every file in
    memory and writing it in one transaction. An interrupted pass stays pending and
    continues without duplicates.
  - SMB file share runner: the permission reuse streams the previous sidecar into a
    compact index (about 50 bytes per file instead of about 190), so incremental runs of
    shares with millions of files no longer run out of memory. Above a third of the
    runner's memory limit the run reads all permissions instead
    (`RESTOW_SHARE_REUSE_MAX_ENTRIES` overrides the limit).
  - SharePoint: a site run indexes the previous restore point once instead of scanning it
    for every list and library, so sites with thousands of lists and a million items no
    longer take quadratic time.
  - Proxmox VE: the block maps of VM disks being browsed or restored are cached by size
    (256 MiB by default, `PVE_BLOCK_MAP_CACHE_MB`) instead of by count.
  - Object Lock renewal sends 32 requests at a time instead of 8
    (`IMMUTABILITY_RENEWAL_CONCURRENCY`) and continues an interrupted pass where it
    stopped instead of starting over.

### Fixed

- A Proxmox VE backup running while Restow was updated failed: the node helper gave up
  after about 30 seconds, while an update restarts the api and runs migrations. The node
  (restow-pve 0.4.0) now keeps trying for five minutes (#46).
- A Proxmox VE backup run whose end never reached the server stayed "running" for 48 hours.
  It is now closed once the node (restow-pve 0.4.0) no longer lists it in its heartbeat
  (#46).
- restow-pve's own lines never reached the run's log in Restow: vzdump writes a backup
  provider's lines to the PVE task log only, not to the guest's log file (#61).
- Jobs of a worker that was killed (not stopped) stayed "running" until they expired, 23
  hours for a backup, because nothing gave them back. The next worker now returns them to
  the queue two minutes after its start (#46).
- A job stopped by a restart or an update before its first checkpoint used up one of its
  attempts, and on its last attempt the explanation said it would continue although its
  checkpoint was discarded (#46).
- An update could fill the disk with its database dump and stop PostgreSQL midway, because
  the preflight only checked for 1 GB free (#73).
- Adding `/var/lib` to a machine job, as the 0.3.5 notice offered, still left Docker's
  named volumes out, because the default exclusion `/var/lib/docker` covers them (#59).
- The live run drawer's charts shrank to the last 80 seconds and grew back every ten
  seconds, because each live event replaced the run's measurements instead of adding to
  them (#54).
- Notification mail through the backup's app registration from a tenant that never
  consented to it reported "app not found" and asked to check IDs that were right. It now
  says that consent is missing in the sender's tenant and links the admin consent.
- The update dialog's confirm button was enabled while the runs in progress were still
  being read, so a quick click announced the update before the admin saw them. It now
  stays disabled until they were read (or reading them failed).

### Security

No vulnerability was fixed. Security-relevant changes:

- Database dumps can be downloaded from the Updates tab. A dump holds the whole database,
  the encrypted secrets included: provider owner only, with a recent sign-in, through a
  one-time link, recorded in the audit log. Keep a downloaded dump as carefully as the
  master key.
- New installations start the mounter by default, which mounts the Docker socket (root on
  the host); read docs/MOUNTS.md, or install with `--no-mounter`. File share runners have
  no network but an internal one to the api, and write with a credential that is valid for
  one run and append-only.
- Tenant admins can add file shares themselves; shares on private or loopback addresses
  need a provider admin's approval or the installation switch.
- Browsing and downloading files of a Proxmox VE container are recorded in the audit log
  (`pve.snapshot.browsed`, `pve.snapshot.downloaded`); a prepared download can be started
  once, within ten minutes, by the admin who prepared it. The same holds for files of a
  VM (`kind: "vm"`), which a reader in a restricted child process reads without mounting
  anything (threat model in docs/PVE.md).
- **S3 endpoints need HTTPS.** A new or changed S3 endpoint over plain `http://` is refused
  (`endpoint_insecure`), for provider admins and the installation default too, except to
  `localhost`, `127.0.0.1` and `[::1]`. Endpoints saved before and `S3_ENDPOINT` keep
  working; their card, Installation › Default repository and every test say in red that they
  should move to HTTPS. `S3_ALLOW_INSECURE=true` accepts plain HTTP for test and
  development setups only.
- Restore operators can now browse, download and restore files of machines and of Proxmox
  VE guests (see Servers and clients); every read, download and restore is audited.
- Lowering a repository's immutability and releasing a retention hold need a recent
  sign-in and are audited; lowering is for the provider owner only.

### Upgrade Notes

New image, seventeen database migrations (0035 to 0051), and a new `docker-compose.yml` for
file shares and the database move.

1. Update as usual (the opt-in updater, or `docker compose pull && docker compose up -d`).
   The api applies the migrations as it starts. With the updater, the install dialog now
   asks what to do with runs in progress; the default stops them cleanly.
2. Run the 0.4.0 `install.sh` again in the installation directory (README.md). It replaces
   `docker-compose.yml` with the 0.4.0 file (checked against the signed SHA256SUMS), keeps
   the previous one as `docker-compose.yml.bak-<timestamp>` and leaves `.env` as it is.
   Without it everything else works, but file share runs cannot start (the mounter reports
   `runner_network_missing`) and Installation › Database cannot move the database. A
   compose file kept by hand needs the changes of the release file: the database volume
   read from `.env`, the internal `runners` network on the api, and `RESTOW_MOUNTER_URL`,
   the runner limits and the `restow-mounter-shared` volume on the worker.
3. For file shares, start the mounter if it is not running: **Enable network shares** in
   the web interface (with the opt-in updater) or
   `docker compose --profile mounts up -d mounter`. The Docker host needs the `cifs` module
   for SMB and the NFS client for NFS.
4. Proxmox VE nodes: restow-pve 0.4.0 updates itself (it checks every six hours and updates
   while idle), or run `restow-pve update` on the node. Older helpers keep working without
   progress, without the five-minute retry window and without the list of active runs.
5. Servers and clients: the endpoint agent 0.4.0 updates itself unless the tenant paused
   agent updates. Older agents keep working without data folders, machine facts, the
   backup window, catch-up rules and retry count of an agent policy, and do not hold their
   own schedules during an update pause.
6. Plain-HTTP S3 endpoints: a repository or default repository that uses `http://` to a
   host other than the machine itself keeps working, but its card asks in red to move it to
   HTTPS, and changing its location needs `https://` (docs/UPDATING.md). Test setups with
   an object store on the compose network set `S3_ALLOW_INSECURE=true` in `.env` (api and
   worker).
7. SharePoint Online: the backup's app registration needs the application permission
   `Sites.ReadWrite.All` (`Sites.Read.All` is enough to back up, not to restore). Add it to
   the app registration, then the customer's admin opens the source's consent link again
   (docs/ENTRA-SETUP.md). Until then mail and OneDrive keep working, and the directory sync
   warns that sites are neither found nor backed up (`sites_unavailable`).
8. Immutable backups with S3 Object Lock need a bucket created with Object Lock (and
   versioning); it cannot be added to an existing bucket. The access key needs
   `s3:GetBucketObjectLockConfiguration`, `s3:PutObjectRetention`, `s3:GetObjectRetention`,
   `s3:ListBucketVersions` and `s3:DeleteObjectVersion`, and should not have
   `s3:BypassGovernanceRetention`, `s3:PutBucketObjectLockConfiguration` or
   `s3:PutBucketVersioning`. Nothing is locked until an administrator turns it on.
9. Ransomware detection is on after the update and judges backups of the last 72 hours; its
   retention hold is on as well, so a suspicious restore point pauses retention of its
   object until an administrator resolves it. Thresholds and both switches are under
   Installation › Ransomware detection.

- Database migrations, in this order: `0035_file_shares`,
  `0036_backup_job_kinds_share_copy`, `0037_backup_job_file_shares` (file shares),
  `0038_notification_matrix` (it translates the recipient flags and webhook event lists of
  every tenant and drops the four flag columns), `0039_pve_run_progress`,
  `0040_recommended_jobs`, `0041_pve_downloads` (container downloads),
  `0042_job_start_pause` (the update pause), `0043_disk_alerts` (the disk warning state),
  `0044_pve_boot_tests`, `0045_ransomware_detection`, `0046_sharepoint_sites`,
  `0047_immutable_backups`, `0048_suspicion_retention_hold` (the release of a retention
  hold and its reminders, five columns on `restore_point_suspicions`), `0049_perf_indexes`
  `0050_agent_policies` (the installation's and each tenant's agent policy,
  `settings.agent_policy` and `tenants.agent_policy`, both `{}`, which changes no machine's
  configuration) and `0051_agent_waiting` (`endpoints.agent_waiting`, what a due backup
  waits for as the agent reports it; empty until an agent 0.4.0 reports). They change the schema and backfill only the notification recipients and
  webhooks, a few rows per tenant, so they should take seconds on any installation, except
  `0049_perf_indexes` below. They ran on a 0.3.6 schema in the Postgres test suites; they
  were not timed on a production-size database.
- `0049_perf_indexes` adds six partial indexes (`jobs`, `endpoint_runs`,
  `file_share_runs`, `pve_runs`, `pve_tasks`). Each build reads its table once while writes
  to it wait (the migrator cannot build them concurrently): seconds on most installations,
  about a minute per ten million rows on large ones (docs/UPDATING.md).
- 0035 creates the `pg_trgm` extension for the file share search when the database role
  may; an external PostgreSQL without it searches more slowly, with the same results.
- New optional environment variables: `RESTOW_POSTGRES_DATA_TYPE` and
  `RESTOW_POSTGRES_DATA` (where the database lives; empty means the volume `pgdata`; the
  updater writes them when it moves the database), `RESTOW_MOUNTER_MAX_RUNNERS` (hard cap
  of file share runners, default 8) and `RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB` (default
  16384). No new required variables.
- Downtime: the containers restart and the migrations run, as for 0.3.6.
- Rollback: the migrations are not reversible; go back to 0.3.6 only with the database dump
  taken before the update. After a database move, keep a compose file that reads
  `RESTOW_POSTGRES_DATA`: the 0.3.6 file does not, and PostgreSQL then refuses to start on
  the old copy.

### Known Issues

- Not tested against real systems before the tag: a Proxmox VE node (progress, the
  helper's log lines, the five-minute retry window and the closing of dropped runs were
  tested against the simulated node of the test suites), the database move and the
  **Enable network shares** button through a real updater and its Docker helper container,
  and the new pages in a browser by hand (they are covered by component tests).
- File shares were tested against Samba in the release smoke tooling, not against Windows
  Server (NTFS permissions, Backup Operators, a file kept open in Excel), a Synology or
  TrueNAS share, real NFS exports (NFS is not in the smoke check) or a host with SELinux
  enforcing.
- File shares have no VSS over SMB (files open with an exclusive lock are skipped), no
  alternate data streams, DFS namespaces, Kerberos or SMB1; repositories live on the
  primary repository only; tenant users have no self-service restore of shares; scheduled
  reports have no file share block yet.
- While an update waits or runs, agents older than 0.4.0 do not hold their own schedules:
  a backup such a machine starts by itself during that time runs, and may fail if the api
  restarts under it.
- Files of Proxmox VE containers and VMs are downloaded as a ZIP; restoring single files
  into the running guest is not built. VM file restore is a **Preview**: btrfs, ZFS, ReFS,
  LVM thin, RAID, BitLocker and LUKS are not readable, and the XFS and NTFS logs are not
  replayed, so a crash-consistent restore point can lack the last writes; compare an
  important file with the original before relying on it.
- Immutable backups, SharePoint Online, boot tests, VM file restore
  and agent policies were tested against simulated services only (a fake S3 with Object
  Lock, a simulated Microsoft Graph, a simulated Proxmox VE node), not yet against a real
  S3 service with Object Lock, a real Microsoft 365 tenant or a real Proxmox VE cluster.
  The ransomware signals were tested with simulated attacks, not with live ransomware.
- Immutable backups: the installation default repository cannot be made immutable (give
  the tenant a repository of its own or an immutable copy); restic index files are not
  locked; a tenant whose retention schedule was deleted is not renewed; space of deleted
  data comes back only once its lock has run out; a file share whose repository is still
  locked cannot be purged before then.
- SharePoint: attachments of list items, site design, navigation, workflows and
  permissions are not restored; a deleted site or library is not recreated; list items go
  back only into their original list.
- In "This restore point contains", Windows paths are listed but do not open.
- Deleting a revoked machine together with its restore points is not possible yet.
- The known issues of 0.3.6 still apply.

### Verification

Before the tag, on 2026-10-15, on the release branch (main plus the 0.4.0 branches):
lint and typecheck of all workspaces, the build, every unit suite, the Postgres suites on
Postgres 16 (129 test files, 1505 tests), the Go agent tests, the Perl plugin tests of the
Proxmox VE integration, the server installer tests (679) and the CI and smoke tooling
tests (241). Smoke check 12 (file shares: back up, browse, search, ZIP download, restore
with permissions, copy job against Samba) passed in CI on the 040-fileshares branch (run
38668096804). The release smoke runs in the release pipeline; no Microsoft 365 tenant was
used before the tag.

## [0.3.6] - 2026-10-15

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.6 lets you protect Proxmox VE guests straight from the inventory, gives the
disk space of the old backup index back without an api restart, shows a notice with a
button when a service needs a restart, and updates the compose file of older
installations when the installer runs again. One database migration.

### Breaking Changes

None. `docker-compose.yml` and `.env.example` of the release now carry almost no comments;
the reference moved to https://docs.restowbackup.com. Nothing in them changed otherwise.

### Added

- Inventory › Proxmox VE: every VM and container has its backup job as a choice (an
  existing job, none, or a new one) and Back up now. Guests can be ticked one by one, all
  of a node, or all without a job in one click, and then added to a job or backed up
  together; New job opens the job dialog and puts the selection into the new job.
- Installation › Updates: a "Restart required" notice when a service needs a restart, with
  the reason, a Restart now button (through the updater; api, worker or scheduler only,
  never while an update runs, and only after a confirmation) and the command to copy, in
  the installation's directory. Provider admins see a notice on every page. Nothing
  restarts without a click.
- Running `install.sh` again on an existing installation updates `docker-compose.yml` to
  the release in `.env` (checked against the signed SHA256SUMS) and keeps the previous
  file as `docker-compose.yml.bak-<timestamp>`. `.env` stays as it is.

### Changed

- After the 0.3.5 conversion of the backup index has finished, the api gives the old
  table's disk space back by itself within about 15 minutes; the api restart is no longer
  needed.
- Installation › Updates: an available update stands next to the running version, in the
  same size and highlighted, instead of only in the status line.
- Mounts: when the mounter is not running, the command starts with the installation's
  directory; a compose file from before the mounter is named as such, with the installer
  command that updates it.
- Repositories › Add a server path: the dialog is wider and no longer scrolls sideways.
- The inventory's protection column is called Protection (it shared the heading Backup with
  the size column).
- `docker-compose.yml` and `.env.example` keep only the comments a reader must not miss.
- Dependencies: patch and minor updates (among them better-auth 1.7.8, drizzle-orm 0.45.4,
  hono 4.13.13, pg 8.23.1, nodemailer 10.1.1, radix-ui 1.8.1, vite 6.4.4) and the pinned
  GitHub Actions setup-node, upload-artifact and download-artifact.

### Fixed

- Mounting an NFS export that does not exist on the server ended with a bare "no such file
  or directory". The message now names the export path and how to find the right one
  (`showmount -e`, Synology paths start with `/volume1/`, NFSv3).

### Security

None.

### Upgrade Notes

New image and one database migration (0034, a small table for restart notices), which runs
in seconds. No new required environment variables.

- The Restart now button needs the updater of 0.3.6. An updater from before 0.3.6 shows the
  command instead until it runs the 0.3.6 image.
- Installations from before 0.3.0 whose compose file lacks the `mounter` service: run the
  0.3.6 installer again to update it (see docs/MOUNTS.md).
- Still converting the 0.3.5 backup index: nothing to do; the space comes back by itself
  once the conversion has finished. On a production installation with 14 million index
  rows the conversion ran at about 6,000 rows per second after a slow first minutes.
- Rollback: the migration is not reversible; go back to 0.3.5 only with the database dump
  taken before the update.

### Known Issues

- No part of Restow records a restart request yet; the notice and the button are in place
  for updates that need them.
- The Docker error text for a missing NFS export was taken from Docker's documentation, not
  from a real failed mount.
- The known issues of 0.3.5 still apply.

### Verification

Before the tag, on the release branch (main plus the five 0.3.6 branches): lint and
typecheck of all workspaces, the server installer tests (642), the CI and smoke tooling
tests (208), and the full unit and Postgres suites on Postgres 16: packages/db 177,
packages/i18n 259, packages/core 1981, apps/scheduler 65, apps/api 3279 (1 skipped),
apps/web 3839, apps/worker 444, ee/api 243, ee/licensing 59, ee/web 176, ee/worker 5,
packages/cli 34, the demo seed 208; 114 Postgres test files, none skipped. The release
smoke runs in the release pipeline; no Microsoft 365 tenant was used before the tag.

## [0.3.5] - 2026-10-14

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.5 makes long first backups of large mailboxes finish instead of running out
of retries, says plainly how big a Proxmox VE guest's backups are and when a container
backup is incomplete, warns when a machine job leaves out the folders where Linux
services keep their data, and adds a restore operator role. It also stores the backup
index (which items each backup contains) as item versions instead of a full copy per
backup, which shrinks the database of large installations by an order of magnitude, and
gives sign-in a database role of its own. One database migration, run automatically at
start.

### Breaking Changes

None. A Compose file you keep yourself should get `stop_grace_period: 60s` on the
`worker` service (see Changed); without it, Docker stops the worker after 10 seconds as
before.

The first start after the upgrade converts the existing backup index in the background
(see Changed). Backups, browsing and restores keep working meanwhile. Once the worker log
says `manifest index conversion finished`, restart the `api` once
(`cd /opt/restow && docker compose restart api`): only then is the space of the old
index handed back to the file system.

### Added

- A **restore operator** role per tenant: sees and restores every backup of the tenant,
  without administering it (jobs, storage, users). Creating a user or an invitation now
  always needs a role to be chosen; there is no preselected one any more.
- Proxmox VE › VMs & containers and the inventory: a **Backup** column with what the
  newest restore point contains and what its run added ("9.4 GB in the backup, +2.5 MB
  new"), with the first backup on hover. The former "Size" column is now called "Disk".
- Proxmox VE guest page: restore points show their type (first backup, incremental, full
  read), what they contain and what they added. A container backup that restic could not
  read completely shows as "Last backup incomplete" / "Succeeded with gaps" with the
  number of unreadable items, and counts as "Incomplete" in the inventory.
- Machine jobs and File restore (Linux): a notice names the usual data folders (`/opt`,
  `/srv`, `/var/lib`, `/home`, …) that the job's paths leave out, with a button to add
  them.

### Changed

- Installation: "Default repository" and "Network shares" are one page again. Old links
  to the network shares open it.
- A backup that is interrupted by its time limit (23 hours) or by a worker restart, after
  it saved a checkpoint, continues without using up one of its retries, for up to 21
  days after it first started. The run view shows such an interruption as information,
  not as an error.
- Microsoft 365: a Graph request that gets no answer within 5 minutes is retried, instead
  of hanging until the job's time limit. Requests and throttling waits end with the job.
- The worker gets 60 seconds to save checkpoints when it stops (`stop_grace_period` in
  the Compose files, drain time 50 seconds, `WORKER_SHUTDOWN_TIMEOUT_MS`).
- Proxmox VE: "Back up now" and restore say that the node starts the task at its next
  check-in, a second click says a backup is already waiting, and the pages refresh every
  5 seconds while a guest waits for its node or backs up.
- Backup index: a backup no longer copies every item of a mailbox or OneDrive into the
  database. Restow keeps one row per version of an item, so an unchanged item costs
  nothing on later backups. On an installation with 14 million index rows (25 GB), the
  index needs about 0.5 to 1.5 GB afterwards. The worker converts existing backups one at
  a time after the upgrade.
- Database roles: sign-in (sessions, passwords, passkeys, two-factor secrets) runs on a
  third database role of its own, created and kept up to date by the migration. The
  application role keeps to tenant data under Row Level Security and may only add jobs
  to the queue. No `.env` change is needed; `DATABASE_AUTH_URL` is optional for
  installations that manage their database roles themselves (see SECURITY.md).
- File restore: the file list has a fixed height and scrolls inside, so the path bar and
  the actions stay in place.

### Fixed

- A first backup of a large mailbox that needed several days ended as failed after five
  interruptions, and the next run started over.
- "The run was interrupted" said nothing was lost also after the last attempt, when the
  checkpoint is discarded.
- Archive: header, storage-protection notice, search and results had no space between
  them.
- The database of installations with many item backups (Microsoft 365) grew by the full
  item count with every backup, until the disk ran full.
- After an update, the maintenance page kept saying "Restow was updated, this page reloads
  now" whenever the application was down later (for example after a reboot with a full
  disk). After 10 minutes it now says the server is temporarily unavailable.
- The browser console warned on every page load that three preloaded fonts were not used
  within the first seconds. The fonts are no longer preloaded.
- Forms reported no error for a missing field inside a list (for example the role of a
  new user in the setup wizard).

### Security

- Database roles (hardening, no known exploit): up to 0.3.4 the application's database
  role could also read and write the tables outside Row Level Security, among them
  better-auth's sign-in tables, the installation settings, the license and the job
  queue. A flaw in tenant-scoped query code could therefore have reached data beyond
  its tenant. 0.3.5 moves sign-in to a role of its own and leaves the application role
  only tenant data and adding jobs. Affected: up to 0.3.4. Nothing to do beyond
  updating; the migration changes the grants of an existing installation.

### Upgrade Notes

New image and one database migration (0033), which only creates a table and drops two
indexes and takes seconds on any database size. After the start, the worker converts
the existing backup index in the background, one backup at a time (about 19,000 index
rows per second in testing, so roughly 15 minutes for 14 million rows); backups,
browsing and restores keep working meanwhile. When the worker log says
`manifest index conversion finished`, restart the api once
(`docker compose restart api`) to give the old table's space back.

- Free space: the conversion writes the new index before the old one is released, and
  the updater writes a database dump before it updates. On a nearly full disk, free
  space first (see docs/UPDATING.md).
- No new required environment variables. `DATABASE_AUTH_URL` is optional.
- Compose files kept by hand: add `stop_grace_period: 60s` to the `worker` service.
- Rollback: the migration is not reversible; go back to 0.3.4 only with the database
  dump taken before the update.

### Known Issues

- The background conversion of the backup index was tested on generated histories, not
  yet on a production database of 25 GB; how long it takes there is an estimate.
- The known issues of 0.3.4 still apply.

### Verification

Before the tag, on 2026-10-14, on the release branch (main plus #71 and #72): CI green
(lint, typecheck, build, Docker images, Go agent, licenses, secret scan, and the unit
and Postgres suites on Postgres 16 with password authentication). Locally on the
combined branch: packages/db 171, packages/core 1981, apps/worker 444,
apps/scheduler 65, apps/api 3250 (1 skipped), apps/web 3820, ee/api 243. The release
smoke runs in the release pipeline; no Microsoft 365 tenant was used before the tag.

## [0.3.4] - 2026-10-11

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.4 is a hotfix: Proxmox VE container backups no longer fail on the
`lost+found` folder of an unprivileged container, VMs & containers show when a backup
waits for its node or runs, and a short hiccup while the browser re-checks the sign-in
no longer replaces the whole interface with "Restow could not be loaded". No database
migration.

### Breaking Changes

None.

### Added

- Proxmox VE › VMs & containers: the state of a guest says "Waiting for the node" once
  a backup was handed out and "Backup running" while it runs; a container whose last
  backup succeeded says so (a VM says it with its incremental/full-read badge).

### Changed

- Proxmox VE container backups that restic could not read completely (exit code 3: the
  snapshot is written, some files are missing) keep their restore point instead of
  failing. The PVE task log names the unreadable items (the first 20) and the restore
  point records how many there were.

### Fixed

- Container backups of unprivileged containers on ext4 (LVM, LVM-thin, directory
  storage) failed with "open lost+found: permission denied": that folder belongs to the
  host's root, which the container's ID map does not include. The `lost+found` at the
  root of the container and of every mount point is left out, as vzdump does.
- A failed container backup with a long restic error could stay "running" forever: the
  server refused error texts over 4000 characters (422), and the node only logged that.
  The server now keeps the first 4000 characters.
- A backup whose own end the node could not report is closed when the node reports its
  task: succeeded with a restore point, failed without one. A task that failed closes
  every run it left open, not only one.
- A backup still running after 30 minutes was handed to its node a second time.
- The interface fell back to "Restow could not be loaded" whenever a single background
  re-check of the sign-in failed (when the window got the focus again, after the network
  came back, or while the API restarted), although the session was still valid. It now
  stays up and keeps the session; only a failed first load or a 401 changes the screen.
  Errors of the sign-in service name a server or connection problem instead of the
  generic "The action could not be completed".

### Security

None.

### Upgrade Notes

New image and a new `restow-pve` helper for the Proxmox VE nodes; no database
migration. After the server update, run `restow-pve update` on every node so the
container fix applies there; the server part works with older helpers too.

### Known Issues

- The inventory's node rows do not yet show "Waiting for the node" or "Backup running";
  VMs & containers does.
- The known issues of 0.3.3 still apply.

### Verification

Before the tag, on 2026-10-11, on the release candidate (main plus the 0.3.4 changes):
lint, typecheck, the Go tests of the agent and the PVE helper (including new tests for
the container backup's arguments, exit code 3 and other failures), apps/web 3803, and
the Proxmox VE suites of apps/api with Postgres 16 (pve 11, protection 6). The full
suites run in CI on the release pull request.

## [0.3.3] - 2026-10-10

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.3 shows the Proxmox VE nodes with their VMs and containers in the
inventory, mounts an NFS share straight from the path field of a repository, and calls
the place where backups are stored "repository" everywhere. No database migration.

### Breaking Changes

None.

### Added

- Servers & clients › Inventory (All and Servers): every Proxmox VE node as a row you
  can expand, with its online state and counts (protected, failed, no job, not backed
  up yet); expanded, each VM and container with its status, backup job and backup
  state, linked to its page. For administrators, once a cluster is connected.
- Repositories: the path field of a directory repository accepts an NFS address
  (`192.168.1.10:/export/backup`, `nas.local:/volume1/restow`, `nfs://…`). The
  provider owner can test and mount it right there; Restow fills in the path. When
  jobs are running, the mount waits until none runs (and can be cancelled).
- A menu entry "Repositories" under your organisation.

### Changed

- The interface says "repository" (German "Repository", plural "Repositories")
  instead of "storage location" / "Speicherort". The API and the setup notice keep
  their wording.
- Proxmox VE, Connect Proxmox VE: a command made with an existing PVE API token says
  so plainly, and "New command without this token" makes one that lets the installer
  create its own token.
- Proxmox VE: VMs & containers and the inventory show why the last backup of a guest
  failed, not only in a tooltip.

### Fixed

- The Proxmox VE node installer named only the missing privileges when an existing API
  token had privilege separation on (the default when a token is created in the PVE web
  interface); it now says so and shows the `pveum` command that turns it off.
- An agent test could fail when the run report reached the outbox a moment before the
  status recorded the interruption.

### Security

- The Dependabot alerts are cleared: uuid 11.1.1 (through `@azure/msal-node`, which
  only uses v4), esbuild 0.25 (development only) and vitest 4.1.11 (development only).
  None of the vulnerable code paths was reachable in Restow.

### Upgrade Notes

New image; no database migration. Coming from 0.3.0 or older, read the notes of
0.3.2 and 0.3.1 below.

### Known Issues

- Mounting an NFS share from the path field was tested against the mounter's
  stand-ins, not yet against a real NFS server. While a mount waits for running jobs,
  new jobs still start, so on a server that is never idle it keeps waiting.
- The known issues of 0.3.2 still apply.

### Verification

Before the tag, on 2026-10-10, on the release candidate (main plus the 0.3.3 changes):
lint, typecheck and the full test suites with Postgres 16 and restic 0.19.1 (apps/api
3235, apps/web 3794, apps/worker 435, packages/core 1978, packages/i18n 259,
packages/db 144, apps/scheduler 65, ee/api 243, ee/web 176, ee/licensing 59,
ee/worker 5, packages/cli 34), the PVE node installer test, the server installer
tests (624) and `pnpm audit` (no known vulnerabilities).

## [0.3.2] - 2026-10-09

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.2 connects a Proxmox VE node with one command and no input, and fixes
Microsoft 365 mailbox backups that stopped in the folders step with "Microsoft
refused the request" (HTTP 400). One database migration runs on update.

### Breaking Changes

None.

### Added

- Proxmox VE (preview): "Use an existing PVE API token instead" in Connect Proxmox VE.
  Restow keeps the token id and secret encrypted only until the node enrolled with
  them (or the enrollment token expires) and hands them to that node once.

### Changed

- Proxmox VE (preview), Connect Proxmox VE: one command per node, with the enrollment
  token in it. The node installer sets up the user `restow@pve`, the roles and the
  restore pool itself (again on a second run without errors), creates its own API
  token `restow@pve!<node>`, checks its privileges before it installs anything and
  picks the thin storage for fleecing by itself. No more pveum block to paste, no
  prompts. "Command for another node" adds the next node; the dialog is wider and
  no longer scrolls sideways.
- Proxmox VE: the storage plugin reports the storage API of the running PVE (8.4 up
  to 9.1), so PVE 9 no longer warns that it "is implementing an older storage API".
- Servers & endpoints › Inventory: the "Connect Proxmox (soon)" placeholder is now a
  "Proxmox VE" button that opens VMs & containers, for the roles that may open it.

### Fixed

- A Microsoft 365 mailbox backup could fail in the folders step with HTTP 400 "Request
  Id ... has to be unique in a batch": when Microsoft listed a folder twice while the
  folder list was read, Restow asked for that folder's subfolders twice in one batch
  under the same id, and Microsoft refused the whole batch. Every batch now uses ids of
  its own, and each folder is read once.

### Security

None.

### Upgrade Notes

New image; migrations run on start. One migration: `0032_pve_enrollment_pve_token`
(adds one column; instant). Coming from 0.2.x, read the notes of 0.3.1 below first
(six migrations, the new setup notice, the new compose file).

- Proxmox VE nodes connected with 0.3.1 keep working. To get the new storage plugin
  (no more warning on PVE 9), run `restow-pve update` on each node.

### Known Issues

- The new Proxmox VE onboarding was tested against stand-ins for `pveum` and `pvesm`,
  not yet on a Proxmox VE host.
- The known issues of 0.3.1 still apply.

### Verification

Before the tag, on 2026-10-09: the packages/core suite (1978 tests, with restic 0.19.1),
including new tests for repeated batch ids and a folder listed twice that fail without
the fix; apps/api (3220 tests) and apps/web (3726 tests) with Postgres 16, the worker's
PVE and failure tests, the Go agent and `restow-pve`, the Perl shim tests (49), the new
node installer test against stand-ins for pveum and pvesm, typecheck, lint, shellcheck
and the installer tests. The release pipeline adds the full CI, the image builds, the release
smoke checks and the scans below.

## [0.3.1] - 2026-10-08

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.3.1 backs up Proxmox VE virtual machines and containers (preview), mounts
NFS shares from the web interface, lets Community run several administrators, and
sends notifications to Discord, Slack and Teams and through Microsoft 365 or Google
Workspace. The overview, the backup jobs and the archive now say plainly what is and
is not protected. Six database migrations run on update; read the Upgrade Notes.
0.3.0 was tagged but never published: its release smoke checks found the first two
fixes below, so this is the first release of the 0.3 line.

### Breaking Changes

- Machines that are in no backup job no longer count as protected anywhere
  (overview, provider view, readiness, reports). Installations that relied on the
  old count will see more yellow; add the machines to a backup job.
- Overview › Statistics shows the active tenant only. The statistics of every tenant
  moved to their own page (Installation section of the menu, Service Provider); old
  links with `scope=provider` lead there.
- A provider member limited to some tenants can no longer read the statistics totals
  of all tenants (403).
- Integration API contract 1.3.0 (additive): webhooks carry `format`.

### Added

#### Proxmox VE (preview)

- Backup of VMs and containers on Proxmox VE 8.4 and newer through the Backup
  Provider API: VM disks over NBD with dirty bitmaps, only changed 4 MiB blocks are
  uploaded; containers through restic; restore as a new VMID into the pool
  `restow-restore`. Servers & clients › VMs & containers. See docs/PVE.md.
- Guests count in readiness, the Status tab, the provider view, statistics,
  warnings and `backup.overdue`.
- The node side is a storage plugin shim (a separate work under AGPL-3.0-or-later)
  and the helper `restow-pve` (Apache-2.0), installed with `/install/pve.sh`.

#### Storage

- Network shares (NFS) from the web interface (Installation › Network shares), through
  the opt-in mounter container (`docker compose --profile mounts up -d mounter`). The
  mounter checks a share before it writes `docker-compose.override.yml`, restarts api
  and worker and rolls back on failure. The updater moves it along with every signed
  update. Installer option `--with-mounter`. See docs/MOUNTS.md.

#### Administration

- Several provider administrators with roles in every edition (Members); limiting a
  member to chosen tenants stays Service Provider. Owners can reset a member's access.
- Before a change of the public URL or the operating mode makes passkeys unusable,
  the settings name the affected accounts and refuse a self-lockout. Moving the
  authenticator app to a new phone keeps the old one until the new one is confirmed.
- Your account: change your password, see and sign out your sessions. The login page
  offers "Lost access?": a reset link by mail when notification mail is set up (the
  second factor stays), and always the way back through an owner or
  `restow admin recover`.
- Notification mail through Microsoft 365 (own app with Mail.Send, or the backup app)
  or Google Workspace (service account with gmail.send), with guides and plain error
  messages.

#### Alerts and overview

- Webhook formats Discord, Slack and Microsoft Teams, chosen from the URL.
- New event `backup.overdue` for mailboxes, OneDrives, IMAP accounts, machines and
  Proxmox guests, aware of the job schedules; an alert rule can set its own deadline
  (24 to 720 hours).
- Warnings: the reasons why single items were not backed up (folder, subject, date,
  cause, what to do), and acknowledging warnings with a note (menu entry Warnings).
- The bell leads to the cause; a Notifications page keeps the history; under All
  tenants the bell and the alerts cover every tenant.
- Exports: audit log (CSV, JSON with hashes, Business), delivery logs (CSV).

#### Archive

- Archive per mail job, journal reports assigned to the mailboxes they name (#36).
- The chain check verifies every link, the daily anchors (now written every night)
  and optionally a sample of message contents. Archived messages can be read and
  downloaded as .eml; search with paging and sender, date and mailbox filters; a
  notice says how the storage protects archived mail.
- Legal holds: release with a required, audited reason; holds on a single mailbox.

### Changed

- The directory, backup jobs and machines say which job backs up an object, and name
  objects in paused or unscheduled jobs; job states storage error, overdue, manual.
- History "Run now" backs up only the run's own object and words waiting and running
  apart. New machine jobs start from the chosen machines' operating systems.
- Deleting a job or a storage location says what becomes of the backups and asks for
  the name; shortening the retention asks first.
- The guide for an own Graph app lists every permission with a copy button and says
  that no redirect URI is needed.
- Disabled controls say why. Locked features name their edition and link only where
  the viewer may go. German and English texts follow one glossary
  (docs/GLOSSARY.md): Speicherort, Lauf, Restore-Prüfung, Rechner, Mandant.
- Menu names: "Server & Clients" (was "Server & Endpunkte"), "Server & Betrieb" for
  the installation settings, "Ihre Organisation", "Benutzer" on the tenant page.
- Restore and export failures are explained in words, the raw text collapsed; the
  target folder of a machine restore is checked first; file restore gives the files
  half the width.

### Fixed

- After a few minutes of clicking, or with several administrators behind one address,
  the web interface showed "Restow could not be loaded": reading one's own session was
  rate-limited like a sign-in, and the counter only reset after 10 seconds without any
  page load. Reading the session is no longer limited; sign-in, second factor and
  password limits stay.
- Every Proxmox VE page asked the api under a doubled path (`/api/v1/api/v1/pve`)
  and got 404.
- `MAIL_TRANSPORT`, `SMTP_*` and `GRAPH_MAIL_*` from the environment were read but
  never used for sending; they apply again when nothing is saved in the web interface.
- The own-app guide named read-only permissions (Mail.Read, Files.Read.All), with which
  every restore fails.
- Discord answered 400 to webhooks in Restow's own format; chat services' 4xx answers
  now end a delivery at once instead of retrying.
- Webhook alerts were logged as sent when they were only queued.
- "Chain intact" checked only stored hashes, so deleting the newest entries passed.
- Overview › Statistics kept showing all tenants after switching into a tenant.
- Moving the authenticator app to a new phone switched the old one off before the new
  one was confirmed.

### Security

- A provider member limited to some tenants could read the statistics totals and the
  tenant table of all tenants (Service Provider with tenant-limited members, up to
  0.2.2). Fixed; nothing to do beyond updating.

### Upgrade Notes

New image; migrations run on start. Six migrations: `0026_webhook_format`,
`0027_job_archive`, `0028_pve`, `0029_warning_acknowledgements`,
`0030_mail_transport_google`, `0031_report_rule_overdue_deadline` (duration on the verification installation: to be
filled in).

- New optional environment variables: `RESTOW_MOUNTER_IMAGE` (the mounter pins it on
  its first start; leave empty) and `RESTOW_MOUNTER_URL` (default
  `http://mounter:8091`).
- The setup notice changed (storage location, restore check): every installation asks
  its provider admin once to accept it again.
- `docker-compose.yml` gains the `mounter` service in the profile `mounts`; replace
  your compose file with the one of this release (the updater does this for you).
- Rollback: restore the database dump taken before the update and start the 0.2.2
  images; migrations are not reversible.

### Known Issues

- Proxmox VE was tested against real qemu-nbd, qemu-img and restic, but not yet on a
  Proxmox VE host; treat it as a preview.
- NFS mounts, Microsoft 365 and Google notification mail and the chat webhooks were
  tested against fakes only.
- Archive immutability on local and NFS storage is enforced by the application only.

### Verification

Before the tag, on 2026-10-08: lint, typecheck and the full test suites with Postgres 16
and restic 0.19.1 (apps/api 3214, apps/web 3721, apps/worker 434, packages/core 1976,
ee/api 243, ee/web 176, packages/i18n 259, apps/scheduler 65, packages/db 144), the Go
agent and `restow-pve` with `go test -race`, the agent integration tests against real
restic and rest-server, the PVE helper end to end against qemu-nbd, qemu-img and restic,
the Perl shim tests, the installer tests (624) and shellcheck. The release pipeline adds
the image builds, the release smoke checks and the scans below. Not run against a real
Proxmox VE host, NFS server, Microsoft 365 or Google Workspace tenant (see Known Issues).

## [0.2.2] - 2026-10-06

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.2.2 lets every Microsoft 365 source connect either through the consent
invitation or through a Graph app of its own, connects the tenant the backup app lives
in without a consent link, fixes the Hetzner Object Storage preset and the Object Lock
detection, and adds an alpha channel for test builds to the updater tab. Updating needs
no migration and no manual step; read the Upgrade Notes if you want to test alpha builds.

### Breaking Changes

None.

### Added

#### Microsoft 365

- **A Graph app of your own for a source (all editions).** Besides the consent
  invitation with the shared backup app, a source can be connected through an app the
  customer created by hand in their own tenant (tenant ID, application ID, client secret
  or certificate). A token for exactly that tenant is the proof; the credential is sealed in the
  organisation's secret store and never shown again, and entering new values replaces it.
  The worker, the group picker of the directory and the permission check use the source's
  own app. Sources with their own app have no consent link. The connection card names the
  organisation the source belongs to before anything is connected.
  See docs/ENTRA-SETUP.md ("Alternative: eine eigene App pro Quelle").
- **The tenant the backup app lives in connects without a consent link.** "Connect own
  tenant directly" on the source page (provider owners only) uses a working app token
  for the home tenant as proof, so the consent round trip, which failed with
  AADSTS700016 there, is skipped. It needs the directory (tenant) ID (a GUID) of the app
  under Settings, Microsoft 365.

#### Updates

- **Alpha channel for test builds.** Builds of the `alpha/*` branches
  (`.github/workflows/alpha.yml`) push unsigned images to
  `ghcr.io/restow-backup/restow-alpha` and announce themselves as pre-releases of the alpha
  repository. On Installation, Updates, "Use the alpha channel" selects that source in one
  click. The tab warns while the alpha source is selected and while the updater does not
  verify signatures (the updater now reports this as `signatureChecks`).

### Changed

- The Installation section of the menu is pinned to the bottom, set apart and labelled as
  applying to every organisation of the installation, so installation-wide settings are
  told apart from those of the active organisation.
- The Hetzner Object Storage preset has a location selector (Falkenstein, Nuremberg,
  Helsinki) that sets endpoint and region together.

### Fixed

- A source for the tenant of the backup app could not be connected: the page only knew the
  consent link, which Entra refuses for an app that is not installed in that tenant (AADSTS700016).
- A bucket with a dot in its name could not be reached with the Hetzner preset, because the
  provider's wildcard certificate does not cover the extra label; such buckets are now always
  addressed by path.
- A bucket created with Object Lock was shown as "not active": S3-compatible services such as
  Hetzner answer in another case or send only the default rule, which the detection did not
  accept.

### Security

- The dependency audit failed on new advisories in the test tooling (`tinypool` below
  2.1.2 and `source-map-js` below 1.2.2, both reached only through `vitest`). Neither is part
  of a shipped image; both are overridden to the patched versions.
- The images apply the Debian security updates of the base image when they are built. The
  release smoke refused the first 0.2.2 build because the base image still carried
  `perl-base` 5.36.0-7+deb12u3, which has three critical vulnerabilities fixed in
  5.36.0-7+deb12u4. No release image ever contained the unpatched package.
- Connecting the tenant of the backup app without consent is restricted to provider owners,
  to the home tenant set by the provider (a GUID), and to a source that is not connected yet, so
  no organisation can bind a foreign tenant this way.
- The credentials of a source's own Graph app are sealed with the organisation's key, are never
  returned by the API and are not written to the audit log.

### Upgrade Notes

Kind of update: new image, no manual steps. Follow [Updating](docs/UPDATING.md): in the
updater tab, or `docker compose pull && docker compose up -d`.

- Database migrations: none.
- New or changed environment variables: none. To test alpha builds, set
  `RESTOW_UPDATER_IMAGE_REPOSITORY`, `RESTOW_UPDATER_WEB_IMAGE_REPOSITORY` and
  `RESTOW_UPDATER_VERIFY_SIGNATURES=false` once on a test installation (docs/UPDATING.md,
  "Alpha builds"). Do not do this on an installation with production data.
- Expected downtime: the containers restart once.
- Rollback: the previous tag plus `docker compose up -d`; no migration ran, so no database
  restore is needed.

### Known Issues

- Connecting through a Graph app of your own and connecting the home tenant directly were
  tested with unit tests and the CI suites only, not against a real Microsoft 365 tenant. The
  Postgres-backed paths of the new routes have no tests of their own yet.
- The Hetzner preset and the Object Lock detection were not tested against a real Hetzner bucket.
- A source connected by consent cannot be switched to a Graph app of its own in the interface.
- The alpha channel needs a repository secret (`ALPHA_RELEASE_TOKEN`) and a first commit in the
  alpha repository before builds are announced to the updater.
- A tag signature is reported by the release workflow but not required for this release.

### Verification

Verified by the continuous integration of the release commit: lint, type check, build of all
packages and of the web bundle, unit and Postgres test suites, installer tests, dependency
audit and licenses, secret scan, workflow lint, the Go agent, and the build of the full and
Community images.

Run locally before the release: unit tests of core (1930 tests), api (2150), worker (248) and
web (the storage, sources, updates and layout suites, all passing).

Not run: any check against a real Microsoft 365 or Hetzner account. The release smoke checks
of the pipeline are added below by the release workflow.

## [0.2.1] - 2026-10-03

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.2.1 backs up a machine only once it is in a backup job and shows every
machine without one, lets you assign a machine to a person of the directory, adds
context menus to the tables, puts machines and mailboxes on one restore-point
timeline, makes the installation's default storage configurable in the web
interface and lets the opt-in updater start with one command and update itself.
Updating runs one additive migration; read the Upgrade Notes if you enabled the
updater on 0.2.0 or run agents older than 0.2.1.

### Breaking Changes

- **A machine in no backup job is not backed up.** A newly enrolled machine gets
  the schedule `none` and starts backing up once it is a member of a job. A machine
  that leaves its job (removed as a member, left out of a replaced scope, or its job
  deleted) goes back to `none` with a new configuration version, and a backup
  request that has not started yet is dropped. Machines that are in no job at the
  time of the update keep running their own configuration; only newly enrolled
  machines and machines leaving a job wait. To keep a machine backed up, put it
  into a job (Servers & endpoints > Jobs, or "Create a job" / "Add to job..." in
  the machine table).
- **API: backups of a machine need a job.** `POST /api/v1/endpoints/:id/tasks`
  with `backup_now`, and `PATCH /api/v1/endpoints/:id` with a schedule other than
  `none`, answer 409 `urn:restow:problem:endpoint-no-job` for a machine in no job.
  The machine list marks such a machine with the attention reason `no_job`.
  Scripts that trigger machine backups must add the machine to a job first.

### Added

#### Machines and backup jobs

- **Machines without backup are visible** (all editions, Servers & endpoints >
  Machines). The inventory has a "Backup job" column with the job as a link or a
  "Without backup" warning badge, a filter "Without backup / In a job", and a
  banner counting the machines without backup. Job administrators get "Create a
  job" (the job editor with the machine preselected) and "Add to job..." (moves the
  machine after a confirmation when it is in another job) on each row and on the
  machine page. "Back up now" is disabled for a machine in no job, and the enroll
  dialog says that a new machine is backed up only in a job.
- **The 0.2.1 agent waits for a job.** Under the schedule `none` it starts no
  scheduled backup, ignores a backup request, and `restow-agent status` says it is
  waiting for a backup job.
- **Assign a machine to a person** (all editions). A machine can be assigned to a
  person of the tenant's protection directory (a user of the directory, not a login
  account): an "Assigned to" column in the machine table (sortable, filterable by
  person and by nobody, found by the search), an "Assign to..." dialog that
  searches the directory and removes an assignment, and the same on the machine's
  overview and General settings. The assignment is audited as `endpoint.assigned`
  and cleared when the person leaves the directory. API: `PATCH
  /api/v1/endpoints/:id` takes `assignedUserId` (422
  `endpoint-assignee-unknown` for anyone not in the tenant's directory), list and
  detail carry `assignedTo`, and `GET /api/v1/directory/people?search=` feeds the
  picker.
- **"Run now" on a machine job shows what happens.** The agent starts a requested
  backup at its next check-in (about every 5 minutes); until then the job and its
  members show "Queued" with the expected check-in, and the toasts say that the
  backup was requested or is already waiting.

#### Tables and restore

- **Context menus on table rows** (all editions). Right click, the context menu
  key, Shift+F10 or a long press on a touch screen open the row's actions in the
  machine, jobs, job members, protected objects (mailboxes) and the other tables
  with row actions; the "..." menu offers the same entries. Links, fields, selected
  text and Shift with a right click keep the browser's menu. Selectable tables get
  checkboxes, a selection bar and "New job from selection" on the context menu of a
  selected row. The jobs table gains Open and Open history; protected objects offer
  their restore points, a restore in the explorer, a new job with the object and
  the protection decisions.
- **File restore with machines and mailboxes on one timeline** (all editions).
  File restore lists the tenant's machines and mailboxes in one searchable list.
  Restore points are shown newest first, grouped by day under sticky separators
  (Today, Yesterday, weekday and date), with a jump to a date that lands on that
  day or the nearest earlier one; the Snapshots tab of a machine uses the same
  timeline. A mailbox's chosen restore point opens in the restore explorer. The
  machine table links to file restore for a machine.

#### Installation

- **Configurable installation default storage** (Installation > Default storage).
  The installation owner can save a local path or an S3-compatible bucket as the
  default storage in the web interface, with a recent sign-in. It is stored sealed
  with the master key and, once saved, wins over the `STORAGE_*` / `S3_*`
  environment; removing it brings the environment back. The page shows where the
  default comes from and the probe the server ran before saving. A change that moves
  the location is refused (409, tenants named) while any tenant keeps data on the
  current default, has it attached as a retired target, is migrating off it or has a
  storage job queued or running. A tenant's storage page always shows the
  installation default as a choice, with "Use installation default" while the
  tenant's own primary holds no data. API: `PUT` and `DELETE
  /api/v1/settings/default-storage`, audited.
- **The opt-in updater starts with one command.** `docker compose --profile updater
  up -d` is enough: `RESTOW_PROJECT_DIR` and `RESTOW_UPDATER_IMAGE` are optional.
  The project directory is mounted at `/project`, and on its first start the
  updater pins its own image by digest into `RESTOW_UPDATER_IMAGE`, so later
  rewrites of `RESTOW_IMAGE` do not reach it. The install script no longer writes
  `RESTOW_UPDATER_IMAGE`. See docs/UPDATING.md.
- **The updater updates itself.** After an image-mode update whose images passed
  the signature check, the updater pins `RESTOW_UPDATER_IMAGE` to the verified
  application image by digest and recreates itself through a short-lived helper
  container. Never after a source-mode update or with the signature check off;
  `RESTOW_UPDATER_SELF_UPDATE=false` switches it off. A failed self-update leaves
  the application update successful, and the Updates tab shows the command that
  finishes it.
- **Switch a Community installation to the full build** (Community build,
  Installation > Edition). The section names the build, lists what Business and
  Service Provider add and offers a one-way switch to the full build of the same
  version: with the updater (owner role, recent sign-in, audited as
  `update.build_switch.scheduled`; the full images are verified against the
  release signature of the tag, with database dump, health check and rollback), or
  by hand with the two `.env` lines it shows. A license key can be stored on the
  Community build; it is kept sealed until the full build verifies and installs it,
  and a rejected key is dropped and audited. There is no switch back to Community.
- **"Hide Start"** in the popover of the sidebar's setup guide removes the Start
  entry in every tenant for that user (remembered in the browser, with an undo
  toast); the setup steps stay on each tenant's page under "Show setup steps".

#### Public demo

- **Simulated live runs.** The demo's agent sidecar plays backups of the two
  simulated machines through the real agent API with live progress, about one in
  ten finishing partial. Configurable with `RESTOW_DEMO_SIM_RUNS`,
  `RESTOW_DEMO_SIM_INTERVAL_SECONDS`, `RESTOW_DEMO_SIM_MIN_DURATION_SECONDS`,
  `RESTOW_DEMO_SIM_MAX_DURATION_SECONDS` and `RESTOW_DEMO_SIM_PROGRESS_SECONDS`
  (deploy/demo/README.md, "Simulated live runs"). The seed puts the demo machines
  into a daily machine job, since a machine in no job is not backed up.

### Changed

- **Linux servers back up application data by default.** The server profile's
  default paths add `/opt`, `/usr/local`, `/var/lib` and `/var/backups` to `/etc`,
  `/home`, `/root`, `/srv` and `/var/www`, and exclude `/var/lib/docker`,
  `/var/lib/containerd` and `/var/lib/apt/lists`. These are the defaults a newly
  enrolled server starts with; the client profile is unchanged. Databases under
  `/var/lib` are backed up as files: for a consistent copy, add a dump command as a
  hook before the backup.
- **IMAP sources lead to the mailbox passwords.** In "one password per mailbox"
  mode, editing a source offers "Manage mailboxes and passwords" (the directory
  filtered to that source), and a new source says where the passwords go after
  saving. Entering `outlook.office365.com` or another Microsoft IMAP host shows that
  Microsoft has disabled password sign-in there and points to the Microsoft 365
  connection.
- **Adding mailboxes** shows the source's login mode with a link to change it, a
  password (and optional username) field per mailbox on a source with one password
  per mailbox, and afterwards a list of each mailbox as new or already listed and
  whether a password is set. Pasted CSV keeps working.
- **Removing a mailbox that has backups** explains that backups are never deleted
  as a side effect, stay restorable and expire with retention, and offers "Exclude
  from protection"; under a legal hold it says so, also when a delete is refused.
- **Machine settings use the full width** in two columns from the xl breakpoint,
  with a sticky column of jump links from the lg breakpoint.
- **File restore without the machine dropdown:** the machines are a searchable list
  beside their restore points; with a single machine it is chosen right away.
- **SMB/CIFS is no longer named as a supported storage mount.** Network storage for
  local targets is NFS only in the interface, the API description and the docs.
  Existing mounted paths keep working.
- **The Updates tab explains the updater:** choosing an update source does not
  start it, the one command that does, that the updater is the application image,
  and the self-update state.
- **A switch from Community to the full build is worded as a switch** ("switch to
  the full build (0.2.1)") in the run card, maintenance banner, modal and toasts,
  not as an update.
- **Dependencies** (Dependabot #14, patch and minor): hono 4.13.11, mailparser
  3.9.31 (linear quoted-printable decoding), nodemailer 10.0.12, smtp-server
  3.19.15, react-resizable-panels 4.14.1, recharts 3.10.1 and @aws-sdk/client-s3
  3.1143.0. No configuration, API or database change; THIRD_PARTY_NOTICES.md is
  regenerated.

### Fixed

- **A new Linux server backed up almost nothing** (about 2 MB): the default paths
  left out `/opt`, `/usr/local` and `/var/lib`, where servers and LXC containers
  keep their application data (see Changed).
- **"Run now" on a machine job looked as if nothing happened.** The request stayed
  invisible until the agent's next check-in and the toast said nothing started; the
  open request is now read and shown as queued.
- **The IMAP password column was a dead end** in "one password per mailbox" mode; it
  now leads to where the passwords are set.
- **Long webhook URLs pushed the delete dialog wider than the screen** (a Discord
  webhook URL is one unbreakable word); the description wraps now.
- **A long press on a touch screen opened an empty row menu**, because no context
  menu event fires there; the entries are read when the menu opens.
- **Listing the tenants that keep data on the default storage scanned every pack**;
  it uses an indexed probe per tenant now.

### Security

No Restow advisory or CVE is fixed in this release. Two points concern the parser
update and the updater's trust model.

- **mailparser 3.9.31 fixes quadratic quoted-printable decoding** (a crafted
  message made decoding slow). Restow up to 0.2.0 already contained it by parsing
  mail in isolated processes with time limits, so it could not stall the service;
  the update is defence in depth and needs no action.
- **The updater now changes its own image.** After a successful image-mode update,
  the release signature, verified by cosign against the release workflow identity
  of the tag and Sigstore, is what lets the updater (which holds the Docker socket)
  replace itself with the new application image, pinned by digest. Before, the
  updater's image changed only by hand. Set `RESTOW_UPDATER_SELF_UPDATE=false` to
  keep it that way.
- **`pnpm audit --prod`:** no high or critical findings; 4 moderate ones in
  transitive dependencies that are not reachable at runtime: esbuild 0.18 (through
  drizzle-kit, its development server only), vitest and @vitest/mocker 3.2 (a peer
  of better-auth, not loaded in production) and uuid 8.3 (through @azure/msal-node
  v3, v5 and v6; the affected buffer API is not used).

### Upgrade Notes

Kind of update: new images, plus manual steps if you enabled the updater on
0.2.0. Order: back up (docs/UPDATING.md), replace `docker-compose.yml` if you use
the updater, pull the 0.2.1 images, start. Migrations run automatically at start.

- **Database: one additive migration, `0025_endpoint_assigned_user`.** It adds the
  nullable column `endpoints.assigned_user_id` with an index, a unique index over
  `users (tenant_id, id)` and a composite foreign key so that a machine's person
  always belongs to the machine's tenant. Nothing is deleted. Its duration was not
  measured on an installation with real metadata.
- **Machines without a job.** Machines that are in no job at the update keep
  running their own configuration. Newly enrolled machines and machines that leave
  a job wait for a job (see Breaking Changes).
- **Agents older than 0.2.1** do not know the schedule `none`. Until they update
  themselves (every 6 hours, or when a machine is next online), a machine with the
  schedule `none` gets no paths and no hooks from the server and reports one failed
  `no_paths` run per slot of its profile's default schedule, with a `backup.failed`
  alert each time; nothing is read or written. The agent's self-update ends it. If
  you paused agent updates (Tenant page > Agents), resume them or put the machine
  into a job.
- **If you enabled the updater on 0.2.0:** before or with the update, replace
  `/opt/restow/docker-compose.yml` with the one of the 0.2.1 release assets (the
  `updater` service now falls back to `RESTOW_IMAGE` when `RESTOW_UPDATER_IMAGE` is
  empty and mounts the project directory at `/project`). Install 0.2.1 from
  Installation > Updates, then delete the `RESTOW_UPDATER_IMAGE` line from `.env`
  (or set it to the 0.2.1 application image) and run
  `docker compose --profile updater up -d updater` once. From then on the updater
  follows signed updates itself.
- **Environment variables:** new `RESTOW_UPDATER_SELF_UPDATE` (optional, default
  `true`: the updater moves itself to a verified release after an image-mode
  update); new `RESTOW_DEMO_SIM_*` (public demo only). `RESTOW_UPDATER_IMAGE` and
  `RESTOW_PROJECT_DIR` become optional.
- **Default storage:** once a default storage is saved under Installation > Default
  storage, it overrides `STORAGE_*` / `S3_*` from the environment; removing it there
  brings the environment back. Nothing changes until you save one.
- **Downtime:** the containers restart and the migration runs at start.
- **Rollback:** the previous tag (the 0.2.0 images) plus `docker compose up -d`, and
  restore the database dump taken before the update, because a migration ran and
  migrations are not reversible.

### Known Issues

- **No migration back to the installation default:** a tenant whose own primary
  storage already holds data cannot move back to the installation default.
- **Staged uploads and exports are not counted as data on the default storage**
  when the server decides whether the default may move.
- **A default-storage change made by another API process is picked up within 30
  seconds**, not at once.
- **The switch to the full build and the updater's self-update were not exercised
  end to end with a real Docker daemon**; they are covered by unit and PostgreSQL
  tests only.
- **The integration API does not expose `assignedTo` yet.**
- **Demo only:** simulated runs report made-up sizes while reusing a snapshot of
  about 1 MB.
- **Not part of this release:** the Windows agent and Proxmox.
- Microsoft 365 backup and restore have still never run against a real Microsoft 365
  tenant; they are covered by tests against a simulated Graph API.

### Verification

Local runs on 2026-10-03 in a Linux container, on the release candidate before
the version commit; the release pipeline repeats CI and runs the smoke on the
tag. No Microsoft 365 development tenant was used.

- **Lint and typecheck** over every workspace passed.
- **Unit suites** passed: packages/core 1919, apps/api 2161, apps/worker 248, ee
  174, apps/web 3461, packages/i18n 244, demo seed 204, packages/db 143 (including
  its PostgreSQL tests).
- **PostgreSQL suites** against a local PostgreSQL 16 with restic 0.19.1 passed:
  apps/api 762 (including the endpoint suites), apps/worker 96, ee 66.
- **Endpoint agent:** `go vet` and `go test` passed.
- **Installer:** `deploy/install/test.sh`, 601 checks passed.
- **Not run here, and so not claimed:** the Docker image build, the release smoke
  (`scripts/smoke`), the updater end-to-end test, and runs against real Microsoft
  365, IMAP or S3 services. They run in CI and the release pipeline; this section
  is completed with the smoke reports of the pipeline run.

## [0.2.0] - 2026-10-03

Beta release. Run it alongside your existing backups, not as your only one, until
you have verified restores against your own data.

### Summary

Restow 0.2.0 reorganises the web interface around three levels (the installation,
a tenant, all tenants), adds backup jobs that replace per-object schedules, and
shows running backups live with throughput charts and a History page. Updating
from 0.1.0 runs three additive database migrations and, on the first start, moves
your backup and restore-check schedules and your machines into jobs without
deleting anything; plan a few minutes for it and read the Upgrade Notes first. The
install script now covers installations behind a reverse proxy with an encrypted
hop, which needs the new `docker-compose.yml` of this release.

### Breaking Changes

Three things behave differently for scripts and integrations that talk to the
API. Nothing changes for the data in your repositories or for the agent API
that installed agents use.

- **`POST /api/v1/setup` requires `providerName`.** The setup wizard asks for the
  name of your own organisation, and the call that sets up an installation now
  needs it. A script that sets up an installation without a browser has to add
  the field; without it the call is refused with 422.
- **Backup and restore-check schedules are created through jobs.**
  `POST /api/v1/schedules` with kind `backup` or `verify` answers 422
  (`kind_replaced_by_jobs`). Maintenance schedules (retention run, storage check,
  directory sync, archive sync) are unchanged. Create a backup job instead
  (`POST /api/v1/backup-jobs`, or Mail & SaaS > Jobs in the web interface).
  Schedules that existed before the update keep their rows and are shown with
  `supersededByJobId`.
- **A machine that belongs to a job is configured from the job.**
  `PATCH /api/v1/endpoints/:id` answers 409 `endpoint-config-managed-by-job` when
  it would change folders, exclusions, hooks, bandwidth or the schedule. Change
  them on the job, or take the machine out of the job first. Display name, the
  power switch and the storage budget stay editable on the machine.

Web addresses did not break: every old address (`/settings`, `/sources`,
`/schedules`, `/backup`, `/jobs/<run id>`, `/audit` and more) redirects to its new
place and keeps its query, so bookmarks and links in mails keep working.
`/api/v1/jobs` keeps its meaning and its shape; `/api/v1/runs` is the new,
documented name for the same list.

### Added

#### Backup jobs

- **Jobs.** A job is the definition of what is backed up, when, where and for how
  long, over many mailboxes, OneDrives, IMAP accounts or machines at once.
  - **Mail jobs** (Mail & SaaS > Jobs) have a backup schedule, an optional
    restore-check schedule, a retention policy (or the tenant default) and a
    scope: the objects you pick, or "every object that is in no other job", which
    also catches objects added later (one such job per tenant). An object belongs
    to at most one job.
  - **Machine jobs** (Servers & endpoints > Jobs) cover servers and clients with an
    agent: a schedule (every N hours, daily at a time, or when the machine
    connects), folders, exclusions, a bandwidth limit, optional hooks and how many
    daily, weekly and monthly restore points to keep.
  - **Per-member overrides.** One mailbox can run on its own schedule, one machine
    can have other folders, exclusions, bandwidth, hooks or retention. An override
    replaces the job's value for that member.
- **The job pages and the editor.** `/jobs?type=mail` and `/jobs?type=endpoint`
  list the jobs with scope, schedule, repository, last and next run, status and
  the result of the last restore check (green only for a passed restore check). A
  job opens in tabs (Overview, Scope, Settings, Runs). The editor is a side sheet
  that works with the keyboard; for machine jobs it shows the folders as a tree
  read from the latest backup, offers exclusions as chips (videos, disk images,
  temporary files, installers, music, trash and caches, your own patterns, "skip
  files larger than X GB") and takes a bandwidth limit and hooks.
- **Run now**, per job or for selected members.
- **A default mail job for new tenants.** The first active source of a tenant
  creates one mail job over all objects (backup every 8 hours, restore check every
  Sunday at 03:00).
- **Bandwidth time windows.** A machine job keeps its upload limit in kbit/s as the
  default and can add windows that set another limit for certain days and hours
  (for example Monday to Friday 08:00 to 18:00: 1000 kbit/s; 0 means unlimited). A
  window may cross midnight, windows must not overlap (the editor and the API name
  the later one), the times are read in the time zone of the job's schedule, and
  the limit that applies when a run starts is used for the whole run. Up to 24
  windows per job; per machine they are overridden together with the limit. No
  agent update is needed: the server picks the limit when the agent asks for its
  configuration.
- **The size limit works.** Agent 0.2.0 passes "skip files larger than X GB" to
  restic (`--exclude-larger-than`); the run log says so.

#### Live runs, History and the run drawer

- **Live runs.** One event stream per browser tab (`GET /api/v1/live`) carries
  running backups with their progress, the jobs' state with last and next run and
  the machines' connection; pages stop polling while it is open. The top bar says
  "Live, updated 4 s ago", "Connecting" or "Not connected, retrying", and the pages
  fall back to polling when the stream is lost.
- **Throughput and sparklines.** Running backups record what was read and what was
  written to the repository (up to 300 points per run) and show progress, speed, a
  sparkline and the time left in the job list and in History.
- **The run drawer.** A click on a job row or a History row opens the run in a
  panel from the right: state, progress, summary, two charts on one time axis (one
  crosshair, keyboard operable), the objects of the same backup run, the timeline
  and the actions (cancel, retry, edit the job). The address carries `?run=<id>`.
  The transfer chart shows an average over 15 seconds, because data reaches the
  repository in packs.
- **History** (`/history`) lists every run of the tenant, the server's and the
  agents', in tabs (all, backup, restore, restore check, export, import,
  maintenance) with a filter per job and paging. A retried restore check is one row
  ("attempt 3 of 6").
- **Progress every 5 seconds (agent 0.2.0)** instead of every 10, so the charts get
  twice the resolution.

#### Interface structure, tenants and branding

- **Three levels.** The menu is organised as Daily, Mail & SaaS, Servers &
  endpoints, Tenants and Installation. The tenant switcher moved to the top of the
  sidebar, with a gear for the active tenant's settings; the page header names the
  level ("Installation", "Own organisation", "Tenant: ...", "All tenants").
- **The installation page** (`/installation/<section>`): Server, Notification mail,
  Microsoft multi-tenant app, Journal receiving (Business), Default storage (with a
  test that belongs to no tenant), Provider API (Service Provider), Updates,
  License and About. Sections your edition does not include stay visible with a
  lock. Provider roles that may look but not change see the forms closed with a
  sentence.
- **The tenant page** (`/tenants/<tenant>/<section>`): Overview, Connections,
  Protection, Jobs & schedules, Backup retention, Storage, Agents, Archive,
  Notifications, Integrations, Members, Audit log and Master data. A tenant's own
  administrator sees their tenant's page and no other. "Connect Proxmox" is
  announced on the Inventory page as "Soon" and starts nothing.
- **Your own organisation.** Every installation can mark one tenant as the
  operator's own (`kind` internal), listed first, protected from deletion and not
  counted as a customer in provider figures. The setup wizard asks for its name and
  creates it with its own key and two alert rules.
- **"All tenants" scope** for provider administrators: the overview sums the
  recovery readiness over every tenant and lists "Tenants by need for action"; pages
  that exist only per tenant ask you to choose one. The entry that lists tenants is
  now "Manage tenants".
- **"Start" in the menu** replaces the setup card: it shows how many of the seven
  steps are done and opens a popover with the steps. The notification mail is the
  one optional step; an installation that skipped it sees "Start" disappear once
  the other six are done.
- **Recovery readiness is linked.** Every row of the readiness tile opens
  `/verify?state=<state>`, with chips and counts for the five states.
- **Brand colours and a second colour scheme.** The interface uses the Restow brand
  colours (Limestone, Nile, Lapis); "Neutral" is the black-and-white look of 0.1.0,
  chosen per browser in the user menu, in the command palette and on the sign-in and
  setup pages. Inter Tight and IBM Plex Mono are bundled into the web image as
  `woff2` files (about 320 KB) and served from `/assets`; nothing is fetched from
  outside and the Content-Security-Policy is unchanged.
- **Wide tables scroll inside their own frame** with the first column pinned
  (two for the audit log), reachable with the keyboard; data views use the full
  width of the content area.

#### Installation and setup

- **The install script explains itself and asks how Restow is reached**: public
  with its own certificate, behind a reverse proxy you run, or local evaluation.
  Every existing option still works; `--non-interactive` asks nothing.
- **Behind a reverse proxy: `--behind-proxy`** (`--domain`, `--proxy-ip`). Restow
  then needs no public DNS record, no certificate of its own and no inbound port
  from the internet. The hop to the proxy is encrypted by default (new setting
  `RESTOW_EDGE_TLS=internal`; the edge shows a certificate from Caddy's own
  authority and the script copies its root certificate to
  `/opt/restow/edge-root-ca.crt`). `--proxy-hop http` selects the unencrypted hop,
  only for a proxy on the same host or in an isolated network; the script says so.
  `RESTOW_HTTP_PORT` and `RESTOW_HTTPS_PORT` now accept an address such as
  `192.168.1.50:443`.
- **The end of the installation shows the address and the setup token**, and where
  a proxy must forward to. The token goes to the terminal only, never to
  `/var/log/restow-install.log`.
- **The setup wizard starts with the language** (English or Deutsch, also the
  language of your own organisation) and has seven steps. The notification mail can
  be skipped ("Skip for now"); `POST /api/v1/setup` accepts `language` and an absent
  `mail`.

#### Tenants and notifications

- **Agent updates are paused once per tenant** (Tenant page > Agents), which also
  covers machines enrolled later. A machine with a pause of its own (the old way)
  stays paused and is listed as an override with "Resume this machine" and "Resume
  all".
- **Tenant administrators may read their tenant and edit its notification
  recipients** (`GET /api/v1/tenants/:id`, `PUT
  /api/v1/tenants/:id/notification-recipients`), and have an Audit log section on
  their tenant page.
- **`GET /api/v1/history`, `GET /api/v1/history/:id`, `GET /api/v1/live`,
  `/api/v1/backup-jobs`** (session API of the web app), `kind` and `customerNumber`
  on tenants (`GET /api/v1/me`, `GET /api/v1/tenants`, `GET
  /api/v1/provider/tenants`), `widgets` and `provider` parameters on `GET
  /api/v1/dashboard`, and `PUT /api/v1/settings/mail/not-needed`. The integration
  API is contract 1.2.0 (additive): the runs are also available as `/runs`,
  `/runs/{id}`, `/runs/backup` and `/runs/{id}/events`.
- New audit actions: `backup_job.created`, `.updated`, `.deleted`, `.scope.changed`,
  `.run_requested`, `.migrated` (written by the system), `tenant.internal.marked`,
  `tenant.internal.unmarked`, `settings.mail.not_needed`,
  `setup.internal_tenant_failed`.

### Changed

- **Schedules now hold only maintenance** and the schedules of an older release
  that no job could take over. A restore check after every backup follows the job;
  retention follows the job that names a policy (a policy scoped to one object still
  wins), and a retention policy that a job names cannot be deleted (409).
- **Saving the notification recipients now changes who is mailed.** Each category
  (failed jobs, readiness turning red, weekly report) is carried by one rule of the
  tenant, kept up to date from the next alert on. Before, the recipients were used
  once to create rules and later edits changed nothing. The recipients field of such
  a rule is read-only in the alert editor.
- **The default storage counts as tested once the installation tested it**, whether
  the tenant or the installation ran the test; a newer failed test shows the step
  as failing.
- **Provider figures no longer count your own organisation as a customer.** Its
  objects, failures, mailboxes and storage are still part of the sums; the license
  audit entries count customers only.
- **Texts follow the level.** Community and Business pages say "your organisation",
  never "tenant".
- **Error text and destructive buttons are easier to read in light mode** (red text
  contrast now at least 4.5:1, amber of the "Soon" badge a hair darker).
- **Green means proof only.** A backup that merely completed is Lapis in the PDF
  statistics report, as in the web charts.
- **Small headings and badges are in sentence case**, the wordmark reads "restow
  backup suite" (your own `RESTOW_PRODUCT_NAME` is shown as written), and PDF
  reports follow the brand palette with the standard PDF fonts.
- **Capacity planning** (Installation, formerly "Resources") announces 0.5.0.
- **Where things moved.** Settings > General, Mail, Microsoft 365, Updates, About,
  Danger zone and Integrations > Provider keys are sections of Installation; Sources,
  Imports, Protected objects, Schedules, Retention, Repositories, Alert rules,
  Integrations, Members and the tenant detail page are sections of the tenant page;
  `/backup` leads to `/jobs?type=mail`.
- **`docker-compose.yml` of the release passes `RESTOW_EDGE_TLS` to the edge** and
  documents that the two published host ports accept an address;
  `RESTOW_EDGE_TLS` is empty in `env.example`.
- **Dependabot groups its updates** and no longer runs CI twice for its branches;
  Hono 4.13.10, better-auth and its passkey plugin 1.7.6, TanStack Router 1.170.40
  and Query 5.104.0 and react-hook-form 7.89.0 were updated (patch and minor, no
  configuration, API or database change). The build stage `agent-dist` starts from
  Alpine 3.24; Alpine is not part of the shipped image.
- **`scripts/release/sign-agent.sh` runs from any directory** and the release
  workflow explains why a tag signature is not verified (and refuses it when the
  repository variable `REQUIRE_SIGNED_TAGS` is `true`). Release tooling; operators
  are not affected.

### Fixed

- **Saving a migrated job reset its timer.** The schedule before and after an edit
  was compared by how its JSON was ordered and spelled, not by its meaning; it is
  compared by meaning now, so saving a job without changing its schedule keeps the
  next run.
- **Editing notification recipients later changed nothing.** Recipients were only
  used when the tenant was created; saving them now updates the rules (see
  Changed).
- **A tenant that tested the default storage kept the setup reason "the server's
  default storage has not been tested".** The test was recorded for the installation
  and the tenant only read its own; the newest test counts now.
- **A tenant administrator who opened another tenant's address saw "All tenants" in
  the header.** The header named the wrong level; it names the administrator's own
  level and the page belongs to Tenant settings in the menu.
- **Tenant page > Storage showed two "Repositories" headings.** The list is a
  region of that name with its explanation.
- **The mail preview tests failed on slow CI runners** (they gave the plain-text
  fallback half of a short time limit, which a loaded runner spent starting the
  parser process; this failed the v0.1.0 release CI three times). Each phase has
  its own limit now. The product's behaviour and its default limits are unchanged.

### Security

No advisory or CVE affects 0.1.0 and is fixed here. Two points concern the update
of the sign-in library and the new proxy mode.

- **Over-long passwords are refused before they are processed.** better-auth 1.7.6
  rejects a password longer than its configured maximum on sign-in and on the other
  password endpoints before it is hashed or compared. Restow accepted passwords of
  up to 256 characters before and now sets the maximum to 256 explicitly:
  **operators whose password is between 129 and 256 characters long are
  unaffected**. The limits are at least 12 and at most 256 characters, as before.
- **The hop between a reverse proxy and Restow is encrypted by default** with
  `--behind-proxy`. The plain HTTP hop (`--proxy-hop http`) sends session cookies
  and passwords unencrypted between the proxy and Restow, and port 80 is open to the
  network; use it only on the same host or in an isolated network. Docker publishes
  ports past `ufw`: behind a proxy, publish the edge's port on one address
  (`RESTOW_HTTPS_PORT=192.168.1.50:443`) or add a rule to Docker's `DOCKER-USER`
  chain.
- Typefaces are served by your installation; nothing is requested from Google Fonts
  or any other host.

### Upgrade Notes

Order: back up (docs/UPDATING.md), replace the compose file if you want the
encrypted proxy hop, pull the 0.2.0 images, start. Migrations run automatically at
start.

- **Database: five additive migrations, `0020_tenant_kind`,
  `0021_tenant_page_settings`, `0022_setup_mail_not_needed`, `0023_backup_jobs` and
  `0024_run_samples`.** They add
  columns and tables (with Row Level Security) and delete nothing; each is safe to
  run twice and needs no downtime. 0020 adds `tenants.kind`, 0021
  `tenants.agent_updates_paused` and `report_rules.recipient_category`, 0022
  `settings.mail_not_needed`, 0023 the tables `backup_jobs` and
  `backup_job_members`, `schedules.superseded_by_job_id` and
  `tenants.backup_jobs_migrated_at`, and 0024 the table `run_samples` and two byte
  columns on `job_progress`. Existing runs have no samples; their charts say "No
  measurements were kept".
- **Your schedules and machines become jobs when the API starts, once per tenant.**
  The step runs in the API process before it serves requests, one transaction per
  tenant. Nothing is deleted, and a second start finds nothing to do.
  - *Mail.* A tenant's enabled backup and verify schedules become one mail job
    ("Mail backup" or "Mail-Sicherung" after the tenant's language). A tenant-wide
    schedule becomes the job's schedule and the job covers every object, so mailboxes
    added later are backed up. A schedule of one object becomes that object's
    override only when it protects the object at least as well as the job's schedule
    at every time of day and week; otherwise it stays exactly as it was and keeps
    running next to the job, so no object is ever backed up less often than before
    (nights, weekends, monthly schedules and the further schedules of an object stay
    as they were). The next run times are carried over, so nothing runs early or is
    skipped.
  - *A tenant that already has a mail job* (the step failed at an earlier start and an
    administrator created a job by hand) keeps all its schedules; they run next to
    that job. The tenant's audit entry lists them (reason `mail_job_exists`); switch
    them off under Tenant settings > Jobs & schedules once the job covers the same
    objects.
  - *Replaced schedules stay on record* with `superseded_by_job_id`; the scheduler no
    longer plans them and the API refuses to change them.
  - *Machines.* Active machines with the same profile, operating system and schedule
    become one job (for example "Linux servers · daily 02:00"); what most machines of
    a group share is the job's, a machine that differs gets an override with just the
    differences. Revoked machines are left out. The step checks that the job
    reproduces every machine's configuration exactly: nothing is rewritten and no
    machine gets a new configuration version.
  - *Audit.* Every tenant gets a `backup_job.migrated` entry written by the system
    with the numbers; the API log carries the totals at start.
  - *Failure.* If the step fails for a tenant, the API still starts, nothing of that
    tenant is changed, its old schedules keep running and the step is tried again at
    the next start. The API log names the tenant ("a tenant could not be moved to
    backup jobs and keeps its schedules"). Do not create a mail job by hand for such
    a tenant, or its old schedules and the new job both run.
- **Machines in a job are configured from the job.** Tenants created after the update
  do not get their machines grouped automatically: put a new machine into a job, or
  leave it with the configuration it enrolled with.
- **Encrypted proxy hop: replace `docker-compose.yml`.** The 0.1.0 compose file does
  not pass `RESTOW_EDGE_TLS` to the edge, and changing the image lines in `.env` does
  not replace it. To switch an installation behind a reverse proxy from the plain
  HTTP hop to the encrypted one: replace `/opt/restow/docker-compose.yml` with the one
  of the 0.2.0 release assets, set `RESTOW_APP_DOMAIN=<name>` (without `http://`),
  `RESTOW_EDGE_TLS=internal` and `RESTOW_HTTP_PORT=127.0.0.1:` in `.env`, run
  `docker compose up -d`, and set the proxy to scheme `https`, port `443`. In Nginx
  Proxy Manager add under Advanced `proxy_ssl_server_name on;`,
  `proxy_ssl_name $host;` and `proxy_buffering off;`. Without these steps an
  installation made with 0.1.0 keeps working unchanged: the edge behaves as before
  while `RESTOW_EDGE_TLS` is unset or `acme`, and the script never changes an
  existing `.env`. `--behind-proxy` itself needs release 0.2.0 or newer;
  `--proxy-hop http` works with any release.
- **Reverse proxies must not buffer `text/event-stream` for `/api/v1/live`.** The
  stream answers with `cache-control: no-cache` and `x-accel-buffering: no`, which
  nginx honours; switch response buffering off for that path on other proxies. If the
  stream cannot be held open, the indicator says so and the pages poll. One stream is
  held per open tab, and only while the tab is in front. A proxy must also pass
  `/assets/*` through unchanged, as it already does.
- **Agents update themselves.** An agent asks the server every 6 hours for a newer,
  signed agent (the 0.2.0 agent ships in the 0.2.0 image), checks the signature
  against the key compiled into it, replaces itself and its restic where the release
  pins another one and restarts its service. Machines that are off update when they
  are next online. The size limit and the 5 second progress need agent 0.2.0. If you
  paused automatic updates (Tenant page > Agents) or paused one machine, that machine
  keeps its old agent until you resume or install it again with the install command.
- **Service Provider installations: mark your own organisation once.** Sign in as an
  owner or administrator of the provider team; the overview asks you to choose the
  tenant that holds your own data or to create a new one. Until then everything works
  as before. A Community or Business installation with exactly one tenant marks it at
  the first start (audit entry, actor "system"); an installation with several tenants
  and no Service Provider key is asked the same question.
- **Automation:** every `POST /api/v1/setup` call needs `providerName`; the tenant
  lists are ordered own organisation first, then by name; scripts that created
  backup or verify schedules must create jobs. A script that runs the installer
  behind a proxy passes `--behind-proxy --domain <name> --proxy-ip <address>
  --non-interactive`; the setup token is not printed in a run without a terminal,
  read it from the API's log.
- **Rolling back to 0.1.x.** Migrations stay applied; 0.1.x ignores the new columns
  and tables and backups keep running, with these effects:
  - 0.1.x does not know `superseded_by_job_id` and plans every backup and verify
    schedule again, the replaced ones included. Their next run times stayed where
    they were at the upgrade, so right after the rollback every replaced schedule is
    overdue and runs once (a backup and a restore check of every covered object at
    once), then on its old cadence.
  - 0.1.x does not know jobs. A tenant whose first source was connected after the
    update has only its default mail job and no backup or verify schedule: nothing
    backs it up on 0.1.x until you choose "Apply recommended schedules" for it.
    Changes made to a job after the update do not exist on 0.1.x.
  - Machines keep the configuration last written to them, a job's later change
    included; the agent ignores `excludeLargerThanBytes`, and 0.1.x lets you change a
    machine's settings on its page again. A 0.1.x server sends the stored default
    bandwidth limit and never the size limit or time windows; windows stay in the job
    and apply again after the next update.
  - A pause of agent updates set on the tenant after the update is not honoured by
    0.1.x, which only knows the pause stored on the machines.
  - Updating to 0.2.0 again does not move a tenant twice. Schedules created on 0.1.x
    run next to the jobs (backups twice), changes made on 0.1.x to replaced schedules
    are ignored, and machine settings changed on 0.1.x are overwritten the next time
    their job is changed. Check each tenant's jobs and its "Jobs & schedules" section
    after updating again.
  - Run one scheduler version at a time. A 0.1.x and a 0.2.0 scheduler share the
    leader lock, so only one plans at a time, but each change of leader between them
    runs what the other left overdue.
- **Where to look afterwards:** the tenant's mail job under Mail & SaaS > Jobs, its
  machine jobs under Servers & endpoints > Jobs, and `backup_job.migrated` in the
  audit log.

### Known Issues

- Microsoft 365 backup and restore have still never run against a real Microsoft 365
  tenant; they are covered by tests against a simulated Graph API. Run Restow next to
  your existing backups and restore a test mailbox before you rely on it.
- **Jobs write to the tenant's primary storage target.** The editor shows it and the
  API refuses another; a repository per job comes later. A machine job cannot be
  paused (the agent decides when to back up; taking machines out of the job ends the
  management, not the backups), and restore checks of machines follow every backup
  with no cadence to set.
- **Schedules the migration could not take over** stay old-style schedules in Tenant
  settings > Jobs & schedules and keep running next to the job: an object's own
  schedule that pauses longer than the job's, the further schedules of an object
  that had several of one kind, a second tenant-wide schedule with another cadence
  and a cadence the scheduler cannot plan. Move such an object into a job with the
  schedule you want and then switch the old schedule off. A tenant without a
  tenant-wide schedule gets a job over exactly the objects that had one of their
  own; an object that had only one kind of schedule now also gets the other kind
  (more runs, never fewer).
- **A run keeps the bandwidth limit of its start**, and time windows apply to
  backups only, not to restores or restore tests. Throughput of an agent run is
  derived from the growth of the repository, so another machine writing to the same
  repository adds to it; runs started before the update and agents that report no
  progress have no throughput line.
- **Under "All tenants" there is no cross-tenant history, alert list or object
  list**; those pages ask for a tenant. The notifications bell, the Statistics tab
  and the command palette have no "All tenants" scope, and "Start" is hidden there.
- **The archive retention period cannot be changed yet** (8 years, not settable); the
  tenant page shows what applies. Google Workspace and Proxmox are announced, not
  built. Leaving an installation or tenant section with unsaved changes drops them.
- **Not looked at in a browser:** the layout of the seven-step wizard on a narrow
  screen was checked in code and tests, not by eye. `--behind-proxy` was verified
  against stub commands and a real Caddy edge, not on a VM with a real Nginx Proxy
  Manager since the encrypted hop was added; the plain HTTP hop is the configuration
  verified by hand on a Proxmox VM.
- **Deferred to 0.2.1:** context menus, the "assigned to" column and owner of a machine
  in the machine table, file restore from the machine table with the shared
  timeline, and simulated runs in the public demo.
- The checks listed as not run under Verification were not repeated for this
  entry; the release pipeline runs the smoke checks.

### Verification

Measured on 2026-10-03 on the release candidate (revision `9272693` plus the
uncommitted 0.2.0 changes; the tag commit differs and the release pipeline repeats
the smoke on it). Host: Apple M4 MacBook Air, macOS 26.5.2; Node 25.9.0, pnpm 9.15.9,
Go 1.27.1, restic 0.19.1 (the pinned binary of `agent/dist`), PostgreSQL 16.14
(local). No Microsoft 365 development tenant was used. Heavy steps ran one after
another with `VITEST_MAX_FORKS=3`.

- **Lint, typecheck, build:** `pnpm lint` (Biome over 2461 files, the `ee/` import
  boundary, the former-name and package-file guards), `pnpm build:libs` and
  `typecheck` over every workspace passed.
- **Test suites:** Vitest over 13 workspaces with the PostgreSQL suites and
  `RESTIC_BINARY` set: 770 test files, 9600 tests, all passed (apps/web 3352,
  apps/api 2825, packages/core 1914, apps/worker 379, packages/i18n 244, ee/api 238,
  demo seed 172, ee/web 177, packages/db 139, apps/scheduler 65, ee/licensing 59,
  packages/cli 32, ee/worker 4). The same run without `RESTIC_BINARY` passed 9463
  tests and skipped 137 (the restic-dependent ones). `deploy/install/test.sh`: 601
  checks passed under bash 3.2 (macOS).
- **Endpoint agent:** `gofmt -l` clean, `go vet ./...` and `go test -race ./...` passed
  for all packages.
- **Migrations:** 25 (0000 to 0024); the PostgreSQL suites ran against them.
- **Not run in this pass, and so not claimed:** the release smoke and image builds,
  Trivy, `pnpm audit`, the license check, gitleaks, ShellCheck, the updater
  end-to-end test, the installer on VMs and the upgrade path from a 0.1.0 database
  with the schedule migration (the migration is covered by its own PostgreSQL
  tests). The release pipeline runs the smoke for both builds on amd64 and arm64 and
  attaches the smoke reports; this section is completed with their result.

## [0.1.0] - 2026-10-02

Beta release. First public release of Restow. Run it alongside your existing
backups, not as your only one, until you have verified restores against your
own data.

### Summary

Restow 0.1.0 is the first public release of a self-hosted backup for Microsoft
365 (Exchange mail, calendar, contacts and OneDrive), IMAP mailboxes and, with
an agent, Linux and macOS servers and clients, written to encrypted,
deduplicated storage that you run and restored without ever overwriting an
original. It checks every week that a sample of each backup can be read back,
imports legacy mail files, keeps imported mail and, with Business or Service
Provider, Exchange Online journal mail in a hash-chained archive, and comes as
two builds: the full images, whose Business and Service Provider modules stay
locked until a license key is installed, and the Community images with the
Apache-2.0 core alone. It is a fresh installation only, because internal builds
before 0.1.0 cannot be upgraded, and Microsoft 365 backup and restore have been
tested against a simulated Graph API only, never against a real Microsoft 365
tenant (see Known Issues).

### Breaking Changes

None for operators of a public release: there is no earlier public release.

Internal builds 0.300 to 0.304 were never published, cannot be upgraded to
0.1.0 and are not migrated: 0.1.0 is a clean break. Environment variable
prefix, storage and key formats, key-derivation labels, license key prefix, API
key prefix and database names all differ from those builds, so nothing is
carried over. Whoever ran one of them installs 0.1.0 as a new installation (a
new database, a new `RESTOW_MASTER_KEY` and `BETTER_AUTH_SECRET`, an empty
storage location) and sets it up again, including new license and API keys and
new passkey and authenticator registrations. Data written by those builds can
only be read by the build that wrote it, with its master key.

### Added

#### Backup and restore

- Microsoft 365 backup: Exchange mailboxes (mail, calendar, contacts) and
  OneDrive, incremental via Microsoft Graph delta queries. Graph is the only
  Microsoft interface Restow uses; Exchange Web Services, which Microsoft
  switched off for Exchange Online on 1 October 2026, are not used.
- IMAP backup for arbitrary IMAP mailboxes over TLS with password
  authentication, restored by IMAP append. An IMAP source uses one of three
  login modes: one shared login for all its mailboxes, a separate login per
  mailbox (for hosters that give every mailbox its own password, with CSV
  import), or a master user (Dovecot separator or SASL authorization id).
  IMAP carries no calendar or contacts.
- Granular and complete restore: a single mail, a folder, a file, a file
  version or a whole account, into the original or another mailbox, OneDrive
  or IMAP account, or as a ZIP download. A restore always lands next to the
  original, never over it. The restore explorer previews and prints mail and
  shows the restore points in a timeline at the bottom edge. A message whose
  formatted view would take too long is shown as text, marked "Simplified
  view"; a message that cannot be read within the preview's time and memory
  limits shows its header data and can still be downloaded and restored.
- Self-service restore: a tenant member with the role "user" signs in and sees
  and restores only their own mailbox and OneDrive (matched by e-mail address).
  An administrator who restores someone else's data gives a reason, and the
  audit log records it as done on behalf of that person.
- Restore checks: every week (Sunday 03:00, Europe/Berlin, in the recommended
  schedule) and, while that schedule is enabled, after every backup, a random
  sample of the latest snapshot (20 mails and 20 files, plus a few calendar and
  contact items) is read back through the restore path and compared with the
  recorded hashes. Every protected mailbox, OneDrive, server and client shows
  its result on Daily › Recovery readiness (Ready, Attention, Not restorable,
  Not verified or No backup yet), all in one table. A check rates red only with
  evidence: data that is missing (a chunk the index does not know, or a data
  file every storage target says it does not have), data that does not match
  (hash or size, a chunk that is not the one its id names) or stored data that
  does not decode. A check the storage could not serve (a network error, a
  timeout, a 5xx answer, throttling, an error nobody recognises, a manifest the
  storage does not return) is "not completed": it rates nothing, changes no
  last check, sends no notification, `verify.completed` or `job.failed`, stops
  at the first such read and is repeated with the queue's backoff (three more
  attempts from two minutes); the last attempt ends without a rating and the
  next scheduled check tries again. A copy target that answers still serves the
  check. History shows such a check as "Not completed, will be retried" with
  its cause.
- Entra directory sync: users, mailboxes and OneDrives of a Microsoft 365
  tenant come in from Entra ID. Protection rules decide what is backed up
  (everyone, members of a group, or a selection), and single mailboxes can be
  included or excluded. Recommended schedules are applied once a tenant has an
  active source: backup every 8 hours, directory sync every 6 hours (full
  enumeration every `DIRECTORY_FULL_SYNC_HOURS`, default 24), restore check
  weekly, sampled storage check weekly, full storage check monthly, retention
  daily.
- Backup retention (Setup › Retention): how long restore points are kept, as a
  tenant-wide default or for chosen objects, from presets or custom tiers.
  Without a policy every restore point is kept.
- Standalone restore: `restow-restore` restores and verifies a snapshot from
  the storage and the key material alone, without a running Restow server or
  database, and detects a damaged byte. `restow-restore endpoint-password`
  opens the repository password of a server or client the same way (see
  Endpoint backup).

#### Storage

- Storage targets: local disk (the default, a Docker volume), S3-compatible
  object storage (Hetzner Object Storage, Garage, Wasabi, B2, AWS) and NFS or
  SMB shares mounted into the containers. Content-defined chunking,
  deduplication within a tenant, AES-256-GCM encryption with a key per tenant
  before anything is written.
- Several targets per tenant: a copy target that receives every new backup,
  promotion of a copy to primary, and replacing the primary either by moving
  all existing backups (copied and verified by SHA-256 before the switch) or by
  keeping them where they are. Admin › Repositories shows each target's health and
  whether an S3 bucket enforces Object Lock; it marks filesystem targets as
  "No hardware WORM". See Known Issues for what that means for the archive.
- Storage checks (scrub): a weekly sampled and a monthly full check of pack
  integrity.

#### Archive, import and export

- Exchange Online journal archive (Business and Service Provider): the
  receiver is part of the `api` role and takes journal reports over SMTP with
  mandatory STARTTLS. Each tenant has its own address
  (`journal+<token>@<journal host>`). The archive page shows the address with a
  copy button, whether the receiver runs and why not, the last report and the
  reports of the last 24 hours and 7 days, what DNS, port 25 and TLS need, and
  a step-by-step guide for the Exchange Online connector and journal rule.
  Rotating the address asks first and stops the old address at once; issuing
  and rotating are audited. It needs `JOURNAL_SMTP_PORT`, `JOURNAL_HOSTNAME` and
  a TLS certificate (`JOURNAL_TLS_CERT_PATH`, `JOURNAL_TLS_KEY_PATH`). An
  installation that does not use journaling (`JOURNAL_SMTP_PORT` unset) sees a
  neutral "Not set up" state with one sentence on what is needed and the guide
  folded away; red and amber are kept for a configured receiver that is down or
  misconfigured. Reports are parsed in the api's isolated parser processes (see
  Security). A report that cannot be read within their limits is still
  archived byte for byte as received, without its details, and marked
  `report-parse-timeout` or `report-parse-memory-limit` (`report-unparseable`
  for other parser failures); the details list at most 100,000 envelope
  recipients (`recipients-truncated`, the archived report keeps all). While all
  parser processes are busy and 16 tasks are waiting, a report is answered with
  SMTP 451 and Exchange Online delivers it again later.
- The archive store: each item is kept byte for byte and encrypted, linked to
  its predecessor in a SHA-256 hash chain. The archive page verifies the chain
  and searches archived mail (administrators). Search covers subject,
  extracted body text and the envelope addresses; it does not search
  attachments. The list and the detail show how each item was captured
  (Exchange Online journal, Graph sync, IMAP sync or mail file import), and the
  search API returns it as `source`. The archive keeps items for 8 years,
  counted to the end of the year of receipt (a fixed default in this release,
  see Known Issues). The daily deletion run that enforces retention, and legal
  holds that block it for a whole tenant or for one mailbox, are Business and
  Service Provider.
- Archive evidence report: a JSON report for a period of up to 366 days with
  item counts, capture channels, hash chain state, retention and legal holds,
  through the integration API (`GET /api/v1/archive/report`, scope
  `archive:read`, audited). There is no PDF and no screen for it yet.
- Mail file import: bring a legacy mailbox that no longer exists as a mailbox
  into Restow from EML, MSG, MBOX, ZIP archives or a MailStore export (an EML
  or MSG folder tree, or a ZIP of it; MailStore's internal archive format cannot
  be read). Files arrive through a chunked, resumable browser upload that is
  sealed with the tenant key from the first byte (no plaintext copy on any disk,
  multi-gigabyte files, size limit, progress, cancel) or from a read-only
  server-side import folder (one subfolder per tenant). The type of every file
  is decided by its content. The import runs as a worker job with progress and
  checkpoints (a restarted worker continues where it stopped) and skips exact
  repeats (same Message-ID and SHA-256 within the same folder). A damaged,
  hostile or too expensive file or message is listed as unreadable with its
  reason and the import goes on; a message whose subject, sender and text
  cannot be read within the limits is imported byte for byte without them
  (noted as "metadata unavailable"). The import ends with a report of messages,
  folders, attachments, duplicates, failures and bytes. The result is an
  imported mailbox in the IMAP backup's storage format with the original folder
  structure, so it appears in the restore explorer (browse, preview, print,
  restore into an IMAP account or a Microsoft 365 mailbox, download). The
  administrator can archive it at the same time; the retention period then
  starts at the import date and search uses the mail's own date.
- Mail export: backed-up, imported or archived mail as EML in a ZIP (folder
  structure, `MANIFEST.csv`, `SHA256SUMS`) or as MBOX (one file per folder in a
  ZIP, or one `.mbox` for a single folder), built by a worker job, sealed in the
  tenant's storage, downloadable for 24 hours (`EXPORT_TTL_HOURS`) and audited.
  PST and OST files are recognised and refused with an explanation; PST export
  is shown as planned.
- Storage budgets for import staging and export files, per tenant: uploads that
  still hold staged files may declare 100 GiB together
  (`IMPORT_MAX_STAGING_BYTES`); a new upload that does not fit is refused before
  its first byte (422 `urn:restow:problem:import-staging-full`), and the upload
  dialog says what to do. Unexpired export files may take 50 GiB together
  (`EXPORT_MAX_TENANT_BYTES`); a new request beyond it is refused (422
  `urn:restow:problem:export-quota-exceeded`), and an export that grows beyond
  it stops, removes what it wrote and fails with "export storage full" and the
  next steps. The daily retention run removes the leftovers of failed or
  cancelled exports and of uploads and exports whose job is gone.

#### Endpoint backup

- Server and client backup with the Restow agent and restic (Community; Linux
  and macOS, Windows is planned). Servers & endpoints › Inventory lists every
  machine (filters All, Servers, Clients) and shows the install command
  and, apart from it, a one-time token (valid 24 hours, single use) that the
  installer asks for with hidden input; unattended installs (RMM) read it from a
  root-only file named by `RESTOW_TOKEN_FILE`. The instance serves the install
  script and the agent binaries. The agent and restic are installed owned by
  root in `/opt/restow-agent/bin` (Linux) or
  `/Library/Application Support/Restow/bin` (macOS). Each machine gets its own
  repository with its own password, sealed with the tenant key. The write path
  is append-only, enforced by the instance: an agent can add backups but never
  delete or overwrite one, and attempts to are audited, at most one entry per
  machine and kind of attempt every ten minutes.
- Signed agent releases: every agent release (the agent and restic, for every
  platform) is signed by the maintainer, and the installer and the agent's
  self-update install nothing that does not carry a valid signature (see
  Security). "Automatic agent updates" can be paused and resumed per tenant on
  the Inventory page. Each release target also carries `THIRD_PARTY_NOTICES.txt`
  (the agent's license, Go's, restic's and those of the 79 Go modules compiled
  into restic), covered by the signed `SHA256SUMS`, installed readable for all
  at `/opt/restow-agent/THIRD_PARTY_NOTICES.txt` or
  `/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt`, replaced by
  every self-update and removed by the uninstall; the GitHub release attaches it
  as `restow-agent-THIRD_PARTY_NOTICES.txt`.
- Hooks (commands before and after a backup, for example a database dump) run
  only on machines whose root allowed them: `sudo restow-agent hooks scripts`
  runs only named scripts that root put into `/etc/restow-agent/hooks.d`,
  without a shell; `sudo restow-agent hooks any` runs any command; the
  installer takes `--hooks=scripts` or `--hooks=any`. Hooks are off on a new
  machine, and the server cannot change the setting. The endpoint settings
  show each machine's policy with the command that changes it, accept only
  script names on a machine that runs only its own scripts, and refuse hooks a
  machine would not run (409 `urn:restow:problem:endpoint-hooks-not-allowed`). A
  backup whose hook was skipped is partial, with the reason "the machine does
  not allow hooks". Only those who may change the endpoint's settings see the
  hook text; everyone else sees whether a hook is set and a short fingerprint.
- Retention (daily 30, weekly 12, monthly 12 by default, in the tenant's time
  zone), repository checks and restore tests run on the server. The server
  decides what retention deletes from its own records: it keeps only snapshots
  that a backup run reported, dates them by when the storage received them, and
  passes exactly the chosen snapshot ids to restic. Snapshots no run reported,
  and snapshots dated in the future, are never deleted, are marked in the
  snapshot list and are announced once (alert `endpoint.suspicious_snapshot`).
  A machine counts as recoverable only after sampled files were read back with
  matching hashes: the server reads the samples with `restic dump` (the smallest
  file first and alone, so restic sets up its cache once), and the agent then
  restores the same files once on the machine and reports per file what it
  found; the server judges both. Red needs proof (a hash that differs, a file the
  snapshot does not contain, or restic reporting that the data the files need is
  missing or damaged). A test that could not complete (the repository busy or
  unreachable, restic unable to start, a full disk on the machine, an agent
  stopped or silent for six hours) rates nothing and sends no alert or
  `job.failed`: the server's test is offered again every hour, the machine's
  test after 1, 2, 4, 8, 16 and 24 hours while its backup is the machine's
  newest, and the interface shows it as "Not completed, will be retried". Sample
  paths are kept exactly as restic names the file. Browse a snapshot, download
  files as ZIP (up to 10,000 selected paths, started as a second, single-use
  step), or restore into a new folder on the machine, never over existing files,
  from the machine's page or from Servers & endpoints › File restore (pick a
  machine, then a restore point); a restore target must be a folder that only
  root can change. A partial backup names each file restic could not read with
  its reason (above 100 files the first 99 and how many more), and a failed
  restore names the first file and its cause. A run that only lost its agent to a
  restart is shown as interrupted, not as failed.
- Storage budgets: each machine's repository may take 2 TiB
  (`RESTOW_ENDPOINT_QUOTA_GIB`, default 2048, and a "Storage budget" per machine
  in its settings) and all machines of a tenant 20 TiB together
  (`RESTOW_ENDPOINT_TENANT_QUOTA_GIB`, default 20480); `0` switches a budget off.
  An upload that does not fit is refused (403
  `urn:restow:problem:endpoint-quota-exceeded`) and restic stops; restores keep
  working. The machine's "Repository" card shows the usage against both
  budgets, and the alert `endpoint.storage_quota` warns at 90 percent and when
  uploads are refused.
- Repository maintenance on the server never overlaps on one machine:
  retention and the repository check take the repository exclusively, restore
  tests, browsing, snapshot lists and downloads share it. A job that finds it
  busy waits up to a minute and is otherwise retried later without rating
  anything; a browse or download request answers "repository busy" (503
  `urn:restow:problem:endpoint-repository-locked`). Lock files older than 30
  minutes are removed before retention and checks; six locked attempts in a row
  over at least twelve hours raise the alert `endpoint.repository_locked`.
- Restore without Restow: the repository password of every machine is also
  stored next to its repository, sealed with the tenant key. The master key and
  the storage are enough to open it with
  `restow-restore endpoint-password --storage <dir> --key <file|env> --endpoint <id> [--out <file>]`,
  after which plain restic restores the machine. In the web interface,
  "Restore without Restow" on the machine's page shows the password after
  confirmation, audited.
- Silent servers, clients without a recent backup, failed runs and restore
  tests rated red raise the usual alerts and the `job.failed` webhook. Machines
  appear in `GET /api/v1/endpoints`, in the recovery readiness table and on the
  Overview (tabs Status and Statistics). A storage change that would leave active
  machines behind (replacing or promoting the primary) is refused with a clear
  message; the repositories are not moved by a storage migration yet.

#### Alerts, reports, dashboard and statistics

- Alert rules per tenant (every edition, Daily › Alerts) say who is told what, and when: by
  e-mail and, optionally, a signed webhook, for a failed backup, restore or
  directory sync, a completed restore, a restore check that did not pass or
  needs attention (and its recovery), damaged or repaired storage, a silent
  endpoint, a suspicious endpoint snapshot, an endpoint storage budget that is
  nearly or fully used, an endpoint repository that stays locked, and an
  available update. A red rating caused only by a backup that is 7 days or older
  reads "Backup too old: <name>" in the bell and as the subject of the alert
  mail, apart from "Restore check failed" for missing or damaged data
  (notifications carry `details.redReason`). Repeats for the same mailbox are
  held back for a chosen time. Every event also appears in the bell in the top bar, whose badge is red
  only while an unread entry is a warning or an error. A delivery log shows
  each mail, bell entry and webhook with its outcome; failed mails are retried
  four times over about 80 minutes. "Send test now" tries a rule on all its
  channels. The notification recipients chosen in the tenant wizard become
  rules.
- Report rules (Business and Service Provider) send a summary of the last day,
  week, month or quarter at a fixed time (daily, weekly, monthly or a cron
  expression in a time zone): backup success rate, failed items, the share
  proven restorable, the most frequent failure causes, protected and stored
  data, restores.
- Overview (Daily), tab Status: widgets for setup progress, the last backup,
  recovery readiness, recent runs, retention, storage, protected objects, protected mailboxes,
  backup success and trend, storage growth, verification history and protected
  machines. Service Provider adds a provider dashboard that rolls tenants up.
- Overview, tab Statistics: backups, restores, storage growth and checks over a period,
  compared with the previous period, with a CSV export per dataset and a PDF
  report. Service Provider adds the cross-tenant scope.
- Failure explanations: every failed or partly failed job, failed item, broken
  source, failed directory sync, failed IMAP login test and red restore check
  says what happened, why and what to do, in German and English. Errors are
  classified into stable cause codes (for example `graph.consent_missing`,
  `graph.permission_missing` with the permission named, `graph.throttled` with
  the wait Microsoft asked for, `imap.auth_failed`, `storage.full`,
  `crypto.key_missing`, `verify.hash_mismatch`, `export.quota_exceeded`), each
  with concrete next steps that link to the right settings page, a "Retry now"
  where a retry makes sense, and a link to the troubleshooting guide
  (`RESTOW_DOCS_TROUBLESHOOTING_URL` points it at your own runbook). The raw
  detail stays available under "Technical details" (HTTP status, Graph error
  code, request ID, client request ID, server time), with secrets removed. The
  cause is also part of the job objects, item failures and verification
  reasons of the integration API and of the `job.failed` webhook payload.

#### Setup, accounts, sign-in and teams

- Interface: React, full German and English translation, dark mode, passkey-first
  sign-in for provider and tenant administrators (with a password-plus-TOTP
  fallback while a domain is not yet verified for passkeys; the authenticator
  entry is named "Name (host)" so installations stay apart), and a guided
  first-run setup wizard.
- Setup token: the first step of the setup wizard asks for a one-time setup
  token that only someone with access to the server can read. The `api`
  container prints it to its log at every start until the setup is complete
  (`docker compose logs api | grep 'SETUP TOKEN'`); a restart issues a new one,
  and the wizard then asks for it again with your entries kept. Set
  `RESTOW_SETUP_TOKEN` (at least 16 characters, for example
  `openssl rand -hex 16`) to know it in advance for unattended installations or
  when container logs are shipped elsewhere; it is then never logged. Scripted
  setups send it as `X-Restow-Setup-Token`.
- Operator responsibility notice: the second step of the setup wizard is a
  short notice that Restow is a backup and archive tool and that the hardware
  and storage layer (redundancy, immutability, encryption key custody, network
  and access security, restore tests) is the operator's responsibility. It is
  accepted inside the wizard and saved together with the setup: the text
  version, time and client address are stored in the installation settings and
  written to the audit log with the new administrator as the one who accepted.
  The server refuses the setup without it.
- Administrator recovery on the command line: if the last owner has lost their
  passkey, authenticator app or password,
  `docker compose exec api restow admin recover --email <owner>` sets a new
  password (asked for at a hidden prompt, or `--password-stdin --yes` for
  scripts), removes the owner's authenticator app and passkeys and ends all
  their sessions; the owner then signs in and sets up an authenticator app
  before anything else. `restow admin list` lists the administrators. It works
  for owners only (an owner resets every other administrator in the web
  interface), needs no running api and is recorded in the audit log.
- Confirming it is you: changing the update source or its access token,
  announcing an update, setting or changing an endpoint hook and showing an
  endpoint's repository password need a sign-in from the last 10 minutes. With
  a passkey the confirmation happens in place and the action continues; with
  the password and authenticator code you sign in again and repeat it.
- Settings, Microsoft 365: the Microsoft app registration for backup (client ID,
  tenant ID, certificate or secret, with a connection test that compares the
  granted permissions) is entered in the interface, stored encrypted and
  effective without a restart; `ENTRA_CLIENT_*` variables take precedence when
  set. Settings, Mail: the notification transport, SMTP or Microsoft Graph, with
  a test mail.
- Tenant members: tenant administrators add people to their tenant as tenant
  administrator or user. Someone without an account receives a single-use
  sign-in link to choose a password (valid 72 hours; mailed when a mail
  transport is configured, otherwise shown once to copy). Community covers one
  organisation with its members.
- Team (Business and Service Provider): several provider administrators, each
  with a fixed role (owner, administrator, technician, read only) and either
  every tenant or a chosen set of tenants (with Business, which has one tenant,
  the scope only matters for Service Provider). Owners invite members by a
  single-use set-password link (72 hours), change roles and tenants, and remove
  members; the team always keeps at least one owner. Every API route carries a
  rule for the least role it needs, checked centrally for every provider
  administrator request. Read only members see status, reports and the audit
  log but no backed-up or archived content. Every team change is in the audit
  log. The provider administrator created by the setup wizard is an owner.
  Community has one provider administrator and no team.
- Audit log viewer (Business and Service Provider): list, filter, entry detail
  and verification of the audit chain. Recording happens in every edition;
  daily seals of each chain (see Security) make a cut-off chain visible.
- Editions: Community (free, no license key), Business and Service Provider
  (perpetual, an offline-verified Ed25519 license key, no phone-home, no
  shutdown). No edition limits the number of mailboxes or restores; mailbox and
  tenant counts are an honour rule of the license terms, never counted against
  a limit in the software. Community and Business run one organisation; Service
  Provider adds more tenants, tenant switching, a cross-tenant provider API for
  RMM and PSA integration and tenant-scoped team members. How the editions are
  delivered (two builds) and licensed is described under Changed.
  Contributions need the Contributor License Agreement and a DCO sign-off on
  every commit.
- Product name: `RESTOW_PRODUCT_NAME` sets the name that the web app, mails,
  reports, the PDF report headers and the API documentation show (default
  "Restow"). Technical identifiers keep their names: `RESTOW_*` variables,
  `restow-agent`, `restow-restore` and `restow`, `X-Restow-*` headers, `rsk_`
  keys and image names. The static maintenance page is written when the web
  image is built and carries the name given as build argument
  `RESTOW_PRODUCT_NAME`.

#### Integration

- Integration API (REST, documented with OpenAPI, every edition): API keys per
  tenant with scopes, backup, restore and verify status, jobs, storage, the
  archive status and evidence report, webhooks, and a directory export for PSA
  and billing. Reads of user and backup data through an API key are written to
  the audit log. `GET /api/v1/status` and `GET /api/v1/me` report the version
  and its commit (`version.commit`); `GET /api/v1/usage` (provider
  administrators) reports the protected mailboxes in total and per tenant;
  `GET /api/v1/notifications` reports `unreadAttention` next to `unread`.

#### Operation and updates

- Operation: one application image with the roles api, worker, scheduler and
  the optional updater, plus the web image (Caddy serving the interface), in
  two builds (see Changed), run with Docker Compose next to PostgreSQL 16;
  migrations run automatically when the api starts. A release stack that runs
  the published images (`deploy/release/`, also attached to each release as
  `docker-compose.yml` and `env.example`) and the source stack at the
  repository root are both provided. The `restow` command in the api container
  holds the server-side maintenance commands (`docker compose exec api restow
  help`).
- Install script for a dedicated Linux VM (new in 0.1.0): `install.sh`, attached
  to every release with `install.sh.sha256` and listed in the signed
  `SHA256SUMS` (source `deploy/install/install.sh`). On Debian 12 or 13 or
  Ubuntu 22.04, 24.04 or 26.04, amd64 or arm64, it checks the machine
  (operating system, architecture, virtualization, memory, disk, ports 80 and
  443, outbound HTTPS, clock, the domain's DNS record, an earlier
  installation), installs Docker Engine and the Compose plugin from Docker's
  signed apt repository when Docker is missing, downloads `docker-compose.yml`
  and `env.example` of the release and checks them against `SHA256SUMS` and its
  cosign signature, writes `/opt/restow/.env` (mode 0600) with secrets from the
  kernel's random generator, pulls the two images of the chosen build (full or
  Community), checks their cosign signatures against the release workflow of
  exactly that version and starts the stack. It shows `RESTOW_MASTER_KEY` once,
  on the terminal and never in its log (`/var/log/restow-install.log`), and asks
  you to confirm that it is stored offline. Options for an unattended run
  (`--non-interactive --domain ... --edition ...`), a dry run (`--dry-run`), an
  evaluation without a public domain (`--local`) and the opt-in updater
  (`--with-updater`, off by default); `bash install.sh --help` lists them with
  the exit codes. Running it again never changes `.env`, a secret or data: it
  checks the images and makes sure the stack runs. It does not update
  (`docs/UPDATING.md`) and has no uninstall (the README's "Removing Restow" has
  the manual steps). The manual Docker Compose installation stays fully
  supported; the README's Quickstart starts with platform recommendations (a
  dedicated VM on other hardware than the systems it backs up, backups
  off-site, preferably S3 with Object Lock; LXC best effort only; no native
  installation without Docker).
- Health endpoints: `/healthz` answers whether the api process is up.
  `/readyz` answers 503 `not_ready` unless the database answers and the worker
  and the scheduler have reported in within the last two minutes (they report
  every 30 seconds), so a backup product without a worker is not ready.
- Release images: the four images of a release (`restow`, `restow-web`,
  `restow-community`, `restow-web-community` on `ghcr.io/restow-backup`) are
  built for amd64 and arm64, signed with cosign (keyless, GitHub OIDC) and carry
  an SPDX SBOM as attestation; the SBOMs and `SHA256SUMS`, the checksums of the
  release files signed with cosign, are attached to the release. Tags are the
  version and `beta`. Both builds pass a smoke run before a release is
  published; the reports are attached to the release (see `docs/CI.md`).
- The application images carry only compiled code and production dependencies:
  the build fails on any first-party test file, test folder or TypeScript
  source, so none is left in the api, worker, scheduler and restore tool trees
  (leaving them out took the application image from 875 MB to 852 MB on
  linux/arm64). The build context leaves out test results and local work
  folders (`.dockerignore`; `.gitignore` keeps `/work` out of the repository).
- Updates (Admin › Settings, Updates): an update check that is off until a provider
  administrator turns it on. It reads only the release list of the chosen
  source once a day or on "Check now" (the public releases of the project by
  default; another GitHub, Forgejo or Gitea repository, with an optional access
  token kept encrypted for a private one; stable or beta channel) and shows the
  running and newest version, the release notes and why a check failed. A new
  version raises one "Update available" alert. Viewing needs a provider
  administrator; changing anything, including "Check now", needs the provider
  owner role. `RESTOW_UPDATE_CHECK_URL` is an environment override and takes
  precedence.
- Optional updater (`docker compose --profile updater up -d`, opt-in, mounts
  the Docker socket, which is root on the host; read `docs/UPDATING.md` first):
  announces an update with a lead time to everyone who is signed in, verifies
  the signature of the release images and pulls them by digest, dumps the
  database (the last three dumps are kept), replaces the services, checks that
  the new version answers and rolls back by itself when it does not. If the new
  version fails after its database migrations ran, the updater does not start
  the old version on the migrated database: it stops the application, keeps the
  dump and says how to restore it. It runs its own image, set as
  `RESTOW_UPDATER_IMAGE` in `.env`, which an update never replaces. Building an
  update from a source repository instead of installing release images is off
  unless the repository is named in `RESTOW_UPDATER_SOURCE_HOSTS`; the Updates
  tab then shows the exact `.env` line and offers no install button until it is
  set. While the api restarts, the edge shows a static maintenance page that
  names no version. The audit log records update checks, scheduling,
  cancellation, start, success and failure (`update.*`), not every step.
- Daily audit anchors: once a UTC day is over, a seal of each audit chain's
  last entry is stored (and written to the worker log), so a chain that was cut
  off at the end or recomputed becomes detectable.

### Changed

There is no earlier public release. The points below differ from what the
website, the documentation and the public demo described before this release;
each says how 0.1.0 behaves.

- Licenses: the Restow core, everything outside `ee/` including the endpoint
  agent, is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`). The
  Business and Service Provider modules in `ee/` are licensed under `ee/LICENSE`:
  the source is available, and production use needs a valid Restow license key
  under the Restow license terms on restowbackup.com. Every package declares its
  license, and CI checks the licenses of all dependencies against an allowlist
  (no copyleft at all in the dependencies of `ee/`) on every change. The images
  carry `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md` in
  `/usr/share/doc/restow/`, and the web image serves the third-party notices at
  `/licenses/THIRD_PARTY_NOTICES.txt`. The notices also cover the restic binary
  Restow ships and everything compiled into it: a section "Go modules compiled
  into the restic binary" lists each of the 79 modules of restic 0.19.1 with its
  license, copyright lines, license texts and NOTICE files (minio-go, grpc-go
  and go-yaml have one), taken from each module at exactly the version in the
  binary and kept in `licenses/restic-deps/`. 26 modules are Apache-2.0, 18 MIT,
  15 BSD-3-Clause, 7 BSD-2-Clause, 12 carry more than one license, and one,
  `github.com/hashicorp/golang-lru/v2`, is MPL-2.0: it is used unmodified, and
  its entry says where its source code is (MPL 2.0, section 3.2). CI checks these
  modules one by one (`scripts/ci/license-policy.json`, section
  `redistributedBinaries`, with MPL-2.0 for that one module as the only named
  exception, which allows nothing for Restow's own dependencies and nothing in
  `ee/`) and that the vendored list matches the pinned restic binaries.
- Two builds of every release instead of one image for every edition. The full
  images, `ghcr.io/restow-backup/restow` and `ghcr.io/restow-backup/restow-web`,
  contain the core and the Business and Service Provider modules; without a
  license key they run as Community, and the paid functions stay visible in the
  menu but locked (greyed out, lock icon, leading to Settings › About) while their
  API routes answer 403 `urn:restow:problem:edition-required`. The Community
  images, `ghcr.io/restow-backup/restow-community` and
  `ghcr.io/restow-backup/restow-web-community`, contain the Apache-2.0 core alone,
  without any `ee/` code: no license key screen, no locked menu entries, and the
  core routes that need a paid edition (a second tenant, provider API keys, the
  cross-tenant statistics and dashboard, time-triggered summary reports) answer
  403 `urn:restow:problem:feature-unavailable`. Both builds use the same database
  schema; switching is a change of `RESTOW_IMAGE` and `RESTOW_WEB_IMAGE` in
  `.env` and `docker compose up -d`, and the updater stays on the build it runs
  from.
- The core knows no license: license key verification, the edition switch,
  unlocking, the license API and the license screen live only in the modules
  under `ee/` (`ee/licensing`, `ee/api`, `ee/web`). Keys are issued only by the
  vendor's private license service; the images contain no signing tool and only
  verify. `RESTOW_LICENSE_PUBLIC_KEY` overrides the verification key for
  development and tests of the full build.
- Settings › About instead of a license page (in the full images the menu entry
  Admin › License opens it): product name, version, commit, the
  core license with a link to its text, the source code at the running
  release's tag and the third-party licenses. In the full images the license key
  is installed and removed in the same tab (edition, licensee, key id, a link to
  the Restow license terms in the interface language). The dashboard shows
  "Protected mailboxes" (tenant administrators their tenant's, provider
  administrators the installation's), not a license card. The core's API
  responses carry no `edition` field: `GET /api/v1/me` reports the enabled
  gated functions as `features` and, in the full images only, the edition as
  `extensions.edition`.
- `RESTOW_EDITION` only for the public demo: it has an effect only together with
  `RESTOW_DEMO=true`. Any other installation runs the edition of its installed
  license key, or Community without one.
- The menu has its final form, so it does not have to be rebuilt later. Daily:
  Overview (tabs Status and Statistics), History (every run: backup, restore,
  restore check, maintenance; formerly "Jobs"), Recovery readiness, Alerts
  (formerly "Alerts & reports"). Mail & SaaS: Jobs (marked "Soon", job
  definitions come with 0.2.0), Restore explorer (tab Recent restores, formerly
  "Restore jobs"), Archive, Exports. Servers & endpoints: Jobs ("Soon", 0.2.0),
  Inventory (one list of every machine with the filters All, Servers and
  Clients, instead of Agents, Servers and Clients), File restore (new: pick a
  machine, then a restore point, browse and restore or download). Tenants: All
  tenants (Service Provider) or Setup (Community and Business), which gathers
  Protection (with "Back up now" for all protected objects), Sources,
  Schedules, Retention and Imports in one tab bar; a service provider opens the
  same area for a tenant with "Open tenant page". Admin: Repositories (formerly
  "Storage"; the interface says "repository" instead of "storage target", the
  API keeps `storage`), Audit log, Integrations, License, Team (Members for
  tenant administrators), Settings, Resources ("Soon", 0.2.1); Audit log, License
  and Team come with the Business and Service Provider modules of the full
  images. Sign-in security
  is in the user menu at the top right. "Soon" entries carry an amber badge, are
  announced to screen readers as coming soon and open a page that says what the
  feature will do and which release brings it. Breadcrumbs open a menu of their
  section, and the command palette lists every entry and the setup tabs. Old
  addresses lead to the new place with their query kept (for example `/stats`,
  `/jobs`, `/jobs/<id>`, `/restore/jobs`, `/reports`, `/storage`,
  `/endpoints/...`), so links in mails, alerts and bookmarks keep working; the
  public API and the webhooks keep their names (`/api/v1/jobs` lists runs,
  `job.failed` is unchanged).
- Drop-down lists, dialogs and charts fit the screen, also on 1920x1080 and at
  125 percent scaling (reported against the public demo): every select opens
  below its field (above when there is no room), is at most 24rem or the
  available height high, scrolls inside and is as wide as its longest entry;
  long values wrap instead of being cut off. The audit log's "Action" filter is
  a searchable list grouped by category that works with the keyboard alone.
  Every dialog and confirmation is at most the screen height, scrolls inside
  and keeps its title and buttons in view. The storage chart names itself once,
  and charts no longer fill Firefox's console with dropped declarations.
- Green means proof: a badge, bar, icon or figure is green only for a passed
  restore check, a completed restore or an integrity check that came back
  intact (storage check "Intact", audit log "Chain intact"). States that are
  merely fine ("Protected", "Active", "Online", "Connected", "Completed") are a
  neutral outline, running work and information are blue. A test in each web
  package keeps it that way.

### Fixed

None (first public release).

### Security

This is the first public release; no earlier public version exists that
could be affected. The security-relevant behaviour of 0.1.0, most important
first:

- Encryption and key custody: every chunk and every manifest is encrypted with
  AES-256-GCM under a key per tenant. One master key (`RESTOW_MASTER_KEY`, the
  key-encryption key) wraps every tenant key. Whoever holds the master key and
  can read a storage target can decrypt every tenant's data; the provider has no
  plaintext access through Restow outside the audited restore and browse paths.
  Keep the master key offline and apart from the storage; without it nothing can
  be read.
- Setup and administrator access: completing the setup wizard needs the
  one-time setup token from the api's log (or `RESTOW_SETUP_TOKEN`), so neither
  a web page the operator happens to open nor someone who finds a fresh
  installation through the certificate-transparency logs can set it up first.
  Once the setup is complete the setup routes are closed for good; a lost owner
  is recovered only on the server's command line (`restow admin recover`), never
  through a public route. The setup, set-password links and agent enrollment,
  the routes that change state without a session, refuse requests from another
  site (403 `urn:restow:problem:cross-site-request`) and bodies that are not
  JSON (415 `urn:restow:problem:unsupported-media-type`), like every signed-in
  route.
- Install script: `install.sh` refuses release files whose `SHA256SUMS` is not
  signed by the release workflow of the requested version, files that do not
  match it, and images without a valid cosign signature of that workflow run
  (an unsigned image is removed again; nothing is started).
  `--skip-signature-check` switches the signature checks off for tests and
  unsigned mirrors only and says so loudly; the checksums are still checked.
  Docker's apt key is accepted only with its published fingerprint. cosign runs
  from its official image pinned by digest, the same one the opt-in updater
  uses, read-only and without capabilities.
- Updater: the optional updater mounts the Docker socket, which is root on the
  host, and holds no application credential. It installs a release image only
  after verifying its keyless cosign signature by digest before the pull: the
  certificate must be issued by `https://token.actions.githubusercontent.com`
  for exactly
  `https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v<version>`
  of the version being installed, and the signature must be in Sigstore's
  transparency log; the pulled image must carry the verified digest. A release
  without a published application digest is not installed (409
  `urn:restow:problem:update-not-verifiable`). cosign and the Docker command
  line helper run from images pinned by digest
  (`RESTOW_UPDATER_COSIGN_IMAGE`, `RESTOW_UPDATER_CLI_IMAGE`).
  `RESTOW_UPDATER_VERIFY_SIGNATURES=false` exists for test installations and
  unsigned mirrors only, set in a Compose override; the digest stays required
  and the run records that the signature was not checked. Building from a
  source repository is possible only for repositories the operator names in
  `RESTOW_UPDATER_SOURCE_HOSTS` on the server, which the updater enforces itself
  (409 `urn:restow:problem:update-source-not-allowed` otherwise). The updater
  runs its own image (`RESTOW_UPDATER_IMAGE`), never the image it installs, and
  refuses to update while the Compose file takes its image from `RESTOW_IMAGE`.
  The update check connects to public addresses only, judged on every resolved
  address at connect time, unless the operator lists the host, and gives up on
  answers larger than 8 MiB. The public maintenance status names no version.
- Recent sign-in for actions that hand someone the host or a machine: changing
  the update source or its access token, announcing an update, setting or
  changing an endpoint hook and showing an endpoint's repository password need a
  session opened in the last 10 minutes with a passkey, the password together
  with the authenticator code, or an OIDC sign-in; an older session gets 403
  `urn:restow:problem:recent-sign-in-required` and is asked to confirm. Removing
  all hooks of a machine needs no new sign-in.
- Endpoint agent: the agent and restic are installed in folders only root can
  change (`/opt/restow-agent/bin`, `/Library/Application Support/Restow/bin`);
  the installer and the agent check owner and permissions of every folder on
  the way and refuse a location another user could change, and they stage files
  under random names. Every agent release is signed by the maintainer with an
  Ed25519 key that never leaves the maintainer's machine, in the OpenSSH
  signature format (`ssh-keygen -Y sign`, namespace `restow-agent-release`) over
  the release's `SHA256SUMS`; the public key is compiled into the agent and
  written into the install scripts. The installer (with `ssh-keygen` 8.1 or
  newer, or OpenSSL 3) and the agent's self-update check the signature and the
  SHA-256 of every binary and of the license notices before they run or install anything, and refuse
  unsigned or wrongly signed releases. The release carries `agent-SHA256SUMS`
  and `agent-SHA256SUMS.sig`; every instance serves them at
  `/install/agent/<version>/`. Release key fingerprint, printed by the installer:
  `SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o` (ED25519, `restow-agent-release`). Hooks
  run as root and therefore only with the consent of root on the machine (see
  Added); the setting is stored on the machine. The enrollment token never
  appears on a command line, in a URL or in a log. The agent sends its
  credentials only to a backup repository on the instance's own host. The
  systemd service runs with `NoNewPrivileges`, protected kernel tunables, kernel
  log and control groups, no kernel module loading, no namespaces,
  `LockPersonality`, `RestrictRealtime`, native system calls only and
  `UMask=0077` (launchd: umask 077). Restore targets must be plain absolute
  paths below folders only root can change, and the agent creates the target
  folder itself (mode 0700).
- Endpoint repositories on the server: a machine cannot make the server delete
  its genuine backups. Retention is decided from the server's records (snapshots
  that a backup run reported, dated by the earlier of the time the storage
  received them and the end of the reporting run), never from the time an agent
  writes into a snapshot, and only the chosen snapshot ids are passed to
  `restic forget`. A machine cannot fill the storage target either: storage
  budgets per machine and per tenant (see Added). An agent can delete only the
  lock files it wrote (other attempts are refused and audited as `foreign_lock`),
  lock files older than 30 minutes are removed before maintenance, and the
  server's own jobs on one repository never overlap. Error messages and the log
  tail a machine sends with a run are redacted before they are stored, including
  bare `rset_` enrollment tokens, `rsea_` agent secrets, `rsk_` API keys and
  credential-named variables such as `PGPASSWORD=`. Names in snapshot ZIP
  downloads have backslashes, colons and control characters replaced and
  dot-only segments dropped, so a Windows extractor cannot read them as paths.
- Untrusted mail content is parsed outside the worker and the api process: the
  MSG reader and the metadata parser of the mail import, the mail preview and
  attachment download, and the journal receiver's report parser run in separate
  child processes with a memory limit and a time limit. A process that runs over
  a limit is killed, the item is reported as unreadable (or archived without
  details) and the work goes on, so a hostile file costs one helper process, not
  the worker or the api of every tenant. The structure of an MSG file is checked
  before the reader sees it; a file that stops the worker twice is not tried a
  third time; the parsers avoid conversions that create huge strings, and the
  steps that took time quadratic in the input are linear. Under load the api
  answers 503 `urn:restow:problem:preview-busy` rather than growing its memory.
  The per-tenant budgets for import staging and export files (see Added) keep
  one tenant from filling the storage target of all.
- Request bodies are limited to 1 MiB unless a route needs more (16 MiB for
  restore and export selections, import requests, IMAP account lists, directory
  rules and an agent's run report; 4 MiB for endpoint download selections; the
  restic data path and import upload segments keep their own caps). A larger
  body is refused with 413 `urn:restow:problem:payload-too-large`, before it is
  read when its size is declared. The Caddy edge applies the same limits as an
  outer bound. A malformed or oversized agent enrollment counts as a failed
  attempt, so 20 of them block the address like 20 wrong tokens.
- Client addresses: the api applies `RESTOW_EDGE_TRUSTED_PROXIES` itself (the
  same default and `private_ranges` shorthand as Caddy) and takes the
  right-most `X-Forwarded-For` address that is not a trusted proxy, so a client
  cannot write a forged address into audit entries, the operator notice record,
  the agent lockout or the sign-in rate limit.
- The journal receiver never serves the test certificate that ships with its
  SMTP library (its private key is public, so a session "encrypted" with it
  protects nothing). It starts only with the certificate and key you configure
  (`JOURNAL_TLS_CERT_PATH`, `JOURNAL_TLS_KEY_PATH`), checked at start (readable
  PEM, key matches, not expired); otherwise it does not open port 25 and the
  archive page says why. Sessions without STARTTLS are refused with 530 before
  `MAIL FROM`, because Exchange Online always uses TLS, and a renewed
  certificate is picked up within minutes without a restart. The release stack
  mounts `JOURNAL_TLS_DIR` read-only for the files. `JOURNAL_ALLOW_INSECURE=true`
  starts the receiver without STARTTLS for local development only, never for a
  production installation.
- Audit log: every read and restore of user data, and every administrative
  change such as a license, team, update or tenant change, is recorded in a
  hash-chained, tamper-evident audit log in every edition (who, when, what, for
  whom, from which IP). The application database roles cannot change or delete
  entries, each entry carries the hash of its predecessor, and a daily seal of
  each chain makes cutting it off or recomputing it detectable. The log lives in
  the installation's database, so it is tamper-evident, not tamper-proof against
  someone with database owner access. Viewing, filtering and verifying it in the
  interface is Business and Service Provider; its CSV and PDF export is planned.
- Refused actions are recorded as well: when a signed-in user is turned away (a
  role that may not do it, a tenant outside their scope), the audit log gets an
  "Action refused" entry with the route and the reason, at most one per user,
  tenant, route and reason every ten minutes.
- Secrets: tokens, client secrets and passwords that Restow has to keep are
  stored encrypted in the database; log output is redacted. No secret is
  committed to the repository (checked by gitleaks in CI).
- Image and dependency scans (Trivy, `pnpm audit`) run on the release images;
  their results are under Verification.

### Upgrade Notes

None (first public release): there is no earlier public release to upgrade
from. Internal builds 0.300 to 0.304 are not upgraded but replaced by a fresh
installation, as described under Breaking Changes.

### Known Issues

- Microsoft 365 backup and restore have never run against a real Microsoft 365
  tenant. They are covered by unit and integration tests against a simulated
  Graph API, and the release smoke check for Microsoft 365 is skipped while no
  development tenant credentials are configured. Expect to meet differences
  between the simulation and the real service. Run Restow next to your existing
  backups and restore a test mailbox before you rely on it.
- Restore checks read a sample back through the restore path and compare it with
  the recorded hashes. They do not restore into a Microsoft 365 mailbox, OneDrive
  or IMAP account: the optional test restore into a target is not wired up in
  this release. The page of a check whose last attempt ended without a rating
  shows the neutral "Not completed" state but no longer its cause (the attempts
  before it do). A storage target that loses its mount in the middle of a check,
  after the manifest was read, answers "not found" for data files and rates the
  object red; a target that is unmounted before the check is "not completed".
- Immutability is not guaranteed by the storage. On local disk, NFS and SMB
  targets Restow enforces the archive's immutability in application code only
  (no code path changes or deletes an archived item before its retention period
  ends); anyone with access to the files or the server can change or delete
  them. On S3 with Object Lock, 0.1.0 sets retention only on the archive item
  records, not on the packs that hold the message content, and backup data
  carries no Object Lock retention at all. Admin › Repositories shows whether a
  bucket enforces Object Lock. Protect the storage against deletion and
  ransomware yourself; the setup wizard's operator notice says so.
- The archive is written by two routes only: the Exchange Online journal
  receiver (Business and Service Provider; it needs a TLS certificate and port
  25 reachable from the internet) and mail file import with "archive at the same
  time". Continuous IMAP and Graph archive sync do not exist in this release,
  and no archive schedule is offered.
- Archive search, retention and legal holds are narrower than the design:
  search covers subject, extracted body text (very long bodies may be truncated)
  and envelope addresses, uses the PostgreSQL `simple` configuration (no
  stemming) and does not read attachments. Mail captured by the journal
  receiver is stored without extracted body text, so it is found by subject
  and addresses only, and a journal report that was archived without its
  details (see Added) is not found at all, although it is complete in the
  archive and in exports. Only administrators can search, and there is no
  self-service archive search for end users. No screen or API sets an archive
  retention policy, so the fixed default of 8 years applies; the deletion run
  and legal holds are Business and Service Provider. A legal hold covers a whole
  tenant or one mailbox, not a search result, and a mailbox hold protects only
  archive items that belong to a mailbox (imported mail archived at import):
  items captured by the journal receiver carry no mailbox assignment in this
  release, so only a tenant-wide hold protects them. Daily archive anchors and
  external timestamps are not implemented.
- The journal receiver does not verify that journal reports come from Microsoft
  (SPF or Microsoft address ranges); it accepts mail only for known journal
  addresses, with a per-sender-IP rate limit and a size limit
  (`JOURNAL_MAX_SIZE_MB`, default 150). It reads its license capability once at
  start: installing a key that adds it needs an `api` restart to open the SMTP
  listener.
- The api, worker and scheduler run as root inside their containers. They parse
  untrusted files and run restic on repositories that agents write to; the
  isolation described under Security limits what a hostile file can do, but not
  the user it runs as. Running them as an unprivileged user is planned for 0.2.0
  and will be announced as a breaking change, with the ownership steps for
  local volumes, NFS and SMB.
- Endpoint backup limits: Linux and macOS only, the Windows agent is planned.
  Agents authenticate with a per-agent secret over HTTPS (mTLS is planned), and
  consistency snapshots (LVM, ZFS, btrfs) are not used; use pre and post hooks
  for databases. A compromised agent can add index or snapshot files that restic
  cannot read: retention and the repository check then stop and the check rates
  the repository damaged, but nothing is deleted that the server did not choose.
  Snapshots that no backup run reported are kept for good, and the web interface
  has no action to delete one (remove them with restic and the repository
  password). The first installation trusts the install script the instance
  serves, as any `curl | sh` does: compare the release key fingerprint the
  installer prints with the one under Security. With the hook policy `any`,
  whoever may change a machine's settings in Restow and signed in recently can
  run commands as root on it; prefer `scripts`. Hooks that need namespaces
  (rootless containers) or module loading do not run under the hardened systemd
  service, and restore targets inside a user's home folder are refused. Uploads
  in flight at the same time can exceed a storage budget by a few packs, and a
  machine whose clock runs more than an hour ahead gets its snapshots flagged as
  dated in the future. While endpoints exist, the primary storage target of a
  tenant cannot be replaced (the change is refused with an explanation).
- Endpoint test coverage: the installers ran in a Linux container and, for
  macOS, natively on macOS as a normal user in a relocated root; the systemd
  unit ran under a real systemd only in a privileged container, the LaunchDaemon
  has never run under a real launchd, and the amd64 agent binaries are
  cross-compiled and were not run. Treat the first installation on each platform
  as a pilot.
- Mail files: PST and OST import, PST export and MSG export are planned (MSG
  export needs a writer with a clear permissive license). Calendar and contact
  items in MSG files are not imported. An imported mailbox cannot be deleted
  yet, and neither can the import source while it holds data. The MSG structure
  check protects the reader but is not a full validator: an unusual but harmless
  MSG file it refuses is reported as unreadable (convert it to EML). The parser
  processes need memory of their own (up to 512 MB each for messages up to
  8 MiB, a process of up to 3 GB for a larger one, `IMPORT_PARSE_WORKERS` and
  `PREVIEW_PARSE_WORKERS` of them at a time): a container memory limit below that
  makes large messages unreadable, and if the operating system stops the whole
  container for lack of memory, nothing inside it can help.
- Updater: building from a source repository checks only that the repository
  is on the operator's allowlist and is fetched over https; its code and tags
  are not verified, so allow only repositories you trust as much as the release.
  The signature check runs cosign in a container on the default Docker bridge
  network: a Docker daemon without outbound access for containers, or a registry
  reachable only from the host, makes every image update fail closed
  (`fetch.signature_invalid`); updating by hand still works. The check trusts
  what the project's release workflow signed; a compromise of that workflow or
  of the GitHub repository is outside what it can detect.
- Confirming it is you works in place with a passkey only. With the password
  and authenticator code you sign in again on the sign-in page and repeat the
  change; settings typed but not saved are not kept.
- The setup token is written to the api's container log until the setup is
  complete, so anyone who can read the container logs can complete the setup.
  If container logs are shipped to a central system, set `RESTOW_SETUP_TOKEN`
  instead; it is never logged.
- Sign in with Microsoft (Entra ID) is not available in this release. The
  sign-in side exists, but there is no way yet to link a Restow account to a
  Microsoft identity, so the login page does not offer the button. Leave
  `ENTRA_SSO_CLIENT_ID` and `ENTRA_SSO_CLIENT_SECRET` empty; account linking is
  planned. Everyone signs in with a passkey, or with the password link and an
  authenticator app.
- Deleting a tenant revokes every sign-in to it and marks it as being deleted,
  but no job removes its data in this release: its database rows and its backup
  data on the storage target stay until you delete them yourself.
- The audit log viewer is a Business and Service Provider feature, and the CSV
  and PDF export of the audit log is planned. The archive evidence report exists
  as JSON through the API only. Its `objectLocked` count (also in the archive
  status) counts items that have a retention date, not items whose storage
  enforces Object Lock; do not read it as a statement about WORM.
- The first backup of a large Microsoft 365 tenant can take days because
  Microsoft throttles Graph. Restow shows the wait it is asked to observe
  instead of hiding it.
- The bell's read state belongs to the tenant, not to a person: marking a
  notification read marks it read for everyone in that tenant.
- OAuth2 sign-in for IMAP sources is not implemented yet.
- Menu: the "Soon" entries are placeholders: Jobs in Mail & SaaS and in Servers &
  endpoints come with 0.2.0, Resources with 0.2.1, and pinned entries with 0.2.0.
  Setup is a light wrapper around the existing pages; the tenant page with its
  own tabs (including agent defaults and modules) comes with 0.2.0, and end users
  read the schedules at `/schedules` without a menu entry. "Schedules" keeps its
  name until jobs exist. A machine's page still calls the restic password the
  "repository password" and says "storage target" in that context; it becomes
  the "machine recovery key" in 0.2.0.
- Interface: Firefox ESR 128 and 140 and Safari were not tested (Firefox 155 and
  Chromium 151 were). The focus ring of inputs, selects and buttons has a
  contrast of about 2.6:1 against white in the light theme, below the 3:1 WCAG
  asks for; it changes with the design work of 0.2.0.
- Install script: Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04 only (the
  releases Docker's apt repository serves for amd64 and arm64); on any other
  system install with Docker Compose by hand. In an LXC container it warns and
  runs on a best-effort basis (Docker needs nesting and keyctl there); Docker
  from snap is refused. `--local` serves `https://localhost` or an internal name
  (`*.internal`, `*.home.arpa`, `*.localhost`) with a certificate of Caddy's own
  authority, and passkeys are not offered there.
- Not in scope: SharePoint, Teams, Google Workspace, public folders, eDiscovery
  case management, a mobile app, image or bare-metal backups.

### Verification

Measured on 2026-10-01 on the release candidate (revision `9272693` plus the uncommitted
release changes; the tag commit differs and the release pipeline repeats the smoke on it).
Host: Apple M4, Docker 29.5.2 in a Colima VM (arm64, 4 CPUs, 6 GiB); Node 22.23.3, pnpm
9.15.9, Go 1.27.1, restic 0.19.1, PostgreSQL 16. Images built locally as `0.1.0-dev` for
linux/arm64 only. No Microsoft 365 development tenant was used.

- **Release smoke, full build** (`restow`, `restow-web`, linux/arm64): PASS with gaps, 9 of
  11 checks passed in full. Check 1 partly: install, migrations and image checks passed, the
  upgrade path was not run because no earlier release exists. Check 4 (Microsoft 365)
  skipped: no development tenant credentials. Passed: health, passkey E2E with tenant and
  i18n (26 screens per language), IMAP backup and restore (27 messages equal by SHA-256),
  journal receipt, chain and export, standalone restore (29/29 verified, a damaged copy
  refused), storage targets (S3 with Garage, local path, mounted directory), Trivy and
  `pnpm audit`, endpoint backup (agent install, enroll, backup, restore; 14 files equal by
  SHA-256), mail import and export.
- **Release smoke, Community build** (`restow-community`, `restow-web-community`,
  linux/arm64): PASS with gaps, 7 of 11 in full; check 1 partly (as above); checks 4
  (no tenant credentials), 6 (journal, a Business module) and 8 (needs one tenant per
  target) skipped by design; no license API and a second tenant refused with 403.
- **Test suites:** lint (Biome over 2192 files, the `ee/` import boundary, the former-name
  and package-file guards), typecheck (13 workspaces) and build passed. Vitest: 664 test
  files, 8103 tests, all passed (apps/api 2564, apps/web 2349, packages/core 1822,
  apps/worker 374, ee/api 226, packages/i18n 216, demo seed 169, ee/web 128, packages/db
  111, ee/licensing 59, apps/scheduler 49, packages/cli 32, ee/worker 4); 81 PostgreSQL test
  files with 1001 tests ran, none skipped. Script self-tests 200 and 22 passed.
- **Endpoint agent:** gofmt and `go vet` for linux and darwin on amd64 and arm64, `go test
  -race` (20 packages), the integration tests with restic 0.19.1 and rest-server 0.14.0
  (7), the install tests on Linux (18 checks) and macOS (7) and the systemd test under the
  service's hardening (4) passed. The restic license check matches the 79 vendored Go
  modules to all four restic binaries.
- **Agent release signing:** `agent/release-signing.pub` holds the release key
  (`SHA256:2LB7RPpIS0wqbcZ2NA8MjuQN7ZfFPqBX3CwrGFSu76o`). The signed image path was checked
  with a throwaway key: a release signed with the committed key passes; another key, no
  signature, a version mismatch and a release without the license notices are refused.
  The real signature is made offline by the maintainer during the release.
- **Images and dependencies:** no test files or TypeScript sources in any image, `ee/` code
  only in the full images, license files in `/usr/share/doc/restow/`, the license notices
  next to every agent binary. Trivy: 0 critical findings with a fix; 4 critical findings
  without a fix in the Debian base image (perl-base CVE-2026-13221, CVE-2026-42496,
  CVE-2026-8376; zlib1g CVE-2023-45853), 112 high, not gating. `pnpm audit --prod`: no high
  or critical advisory (4 moderate). Licenses: 555 packages allowed, `ee/` 53 without
  copyleft, restic's 79 Go modules with one named exception (golang-lru/v2, MPL-2.0,
  unmodified). gitleaks over a single-commit copy of the tree: no leaks.
- **Migrations:** 20 (0000 to 0019), journal and snapshot chain consistent, no schema drift;
  a second run on a populated database changes nothing (62 tables, 47 with row level
  security).
- **Server install script:** `deploy/install/test.sh` 227 checks passed under bash 3.2
  (macOS) and 226 under bash 5.2/5.3 in the VMs; ShellCheck over 26 scripts and actionlint
  clean. Real installations on arm64 VMs (Lima, 2 vCPU, 4 GiB) with locally built images and
  a simulated release: Debian 12 (interactive install, re-run, non-interactive, every refusal
  and signature-failure case), Debian 13, Ubuntu 24.04 (including the one-liner and the
  distribution's docker.io) and Ubuntu 26.04 (Rust coreutils and sudo-rs) passed; the master
  key shows once and only in the terminal, a re-run changes nothing, a tampered release file
  or an unsigned image is refused and nothing starts, and the setup page answers. One fix came
  out of it: the installer now waits for the apt lock that unattended upgrades hold on a fresh
  VM instead of stopping.
- **Opt-in updater:** the end-to-end test passed 12 of 12 scenarios as a host process and 12
  of 12 in a container (real pull, digest check, dump, rollback, crash loop, failure after
  migrations, killed updater).
- **Not covered:** linux/amd64 (the release pipeline builds and smokes both
  architectures), Microsoft 365 against a real tenant, the upgrade path from an earlier
  release, the agent signed with the real key (done by the maintainer in the release run),
  the updater against two builds of the real published image, and the install script on
  amd64, on Ubuntu 22.04, in a real Proxmox LXC and against the real signed release (checked
  on release day before the announcement).

The release pipeline repeats the smoke run for both builds on amd64 and arm64
from the tagged commit before it publishes, and attaches the smoke reports
(`smoke-report.md`, `smoke-report-arm64.md`, `smoke-report-community.md`,
`smoke-report-community-arm64.md`) to the release.
