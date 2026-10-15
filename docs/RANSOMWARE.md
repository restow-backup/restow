# Ransomware detection on backups

Status: **built** (0.4.x). Audience: operators and maintainers. Edition: Community (core).

Every backup sees what changed on the system it protects. When ransomware encrypts a file
server, the next backup sees thousands of files change at once, files renamed to `.locked`,
ransom notes in every folder, and file contents that suddenly look like random bytes. Restow
judges every new restore point from these traces, marks the suspicious ones, alerts once per
attack, points every restore view to the newest restore point without findings, and **pauses
retention** of the object until an administrator resolves the finding, so the clean old restore
points are not pruned away while encrypted ones pile up.

The detection works only from data the backup already has. It never reads the backed-up data a
second time, never scans files for malware and never blocks a backup. It is a tripwire, not an
antivirus: a finding is a reason to look, and a restore point without findings proves nothing
(see [What it cannot detect](#what-it-cannot-detect)).

## Overview

```
 agent / runner / worker                     server
 ───────────────────────                     ──────
 backup (restic, Graph)                      endpoint_runs.stats, file_share_runs.stats,
   + activity report  ───── finish ────────▶ pve_runs.stats, jobs.payload.result
     (restic diff, names,                              │
      entropy samples)                                 ▼  every 2 min (worker)
                                             suspicion pass: metrics + baseline + signatures
                                                       │
                                     restore_point_suspicions (one row per restore point)
                                                       │
                       ┌───────────────────────────────┼────────────────────────────┐
                       ▼                               ▼                            ▼
               backup.suspicious               badges and the hint            false alarm
               (bell, rules, mail,            "last clean restore point"      (audited, feeds
                webhooks), once per            in every restore view           the baseline)
                episode                                │
                                                       ▼
                                  retention hold: retention, forget and prune delete
                                  nothing of the object until a false alarm or a release
                                  (audited); backup.suspicious_hold after 14 days
```

- `packages/core/src/ransomware/`: the signals, the signatures, the baseline and the judgement
  (pure functions), the activity report format.
- `agent/internal/activity/`: the activity report of the endpoint agent and the file share
  runner (`restic diff`, names, entropy).
- `packages/core/src/backup/onedrive/run.ts`: the activity report of a OneDrive backup.
- `apps/worker/src/suspicion/`: the pass that judges new restore points and raises the event;
  `holds.ts`, the retention hold every retention path asks.
- `packages/db/src/suspicion-holds.ts`: which objects are held.
- `apps/api/src/features/suspicion/`: the judgements for the web app, the false alarm, the
  thresholds (`/api/v1/suspicions`, `/api/v1/settings/ransomware`).
- `apps/web/src/features/suspicion/`: badges, the last clean restore point, the false alarm
  dialog, Installation > Ransomware detection.

## Signals

A restore point is **suspicious** when at least one signal fires. Every finding carries the
numbers that made it (the measured value, the threshold it crossed, the object's usual value or
the share), so the admin can see at a glance how far off it is.

| Signal | Finding codes | Fires when (defaults) |
| --- | --- | --- |
| Amount of change | `change_rate_items`, `change_rate_bytes` | new + changed files (items) or bytes added lie more than 8 median absolute deviations above the object's median, are at least 5 times the median, and reach 500 files or 1 GiB |
| Deletions | `mass_deletions` | at least 1,000 files deleted and at least 25 % of the files the previous restore point had |
| Renamed extensions | `mass_renames` | at least 100 files renamed with an appended or replaced extension (`a.docx` → `a.docx.locked`, `b.xlsx` → `b.crypt`), at least 2 % of the files |
| Known names | `known_extensions`, `ransom_notes` | at least 20 new or changed files carry a known ransomware extension; at least 2 new files are named like a ransom note |
| Entropy | `high_entropy` | of the sampled new or changed files that are not of a compressed format, at least 3 and at least half look encrypted (≥ 7.9 bits per byte) |
| Compression and deduplication | `incompressible_data`, `dedup_collapse` | the run added at least 256 MiB of new data, and its compression ratio (stored / raw) reaches 0.95 or its deduplication ratio (new / processed) reaches 0.8, each at least 0.15 resp. 0.3 and 6 median absolute deviations above the object's own median |

### Amount of change and the baseline

Each object is compared with **itself**. The baseline is the object's last 14 restore points that
count as clean (judged without findings, called a false alarm, or made before the detection
existed); suspicious ones that nobody called a false alarm stay out, so an attack spanning several
backups does not teach the baseline that encryption is normal. The baseline is read from the run
tables, so an object that was backed up before the detection was installed is judged from the
first pass on. With fewer than 5 such restore points the signal says **learning**.

The bound is `max(median + 8 × spread, 5 × median, floor)`, where the spread is the median
absolute deviation scaled to a standard deviation (× 1.4826) but never less than a tenth of the
median, so a perfectly steady object does not alert on noise. The median and the MAD are robust:
one large monthly job in the history does not move them the way a mean would.

### Names

The signature lists live in `packages/core/src/ransomware/signatures.ts` and are **versioned**
(`RANSOMWARE_SIGNATURES_VERSION`, currently `2026.10-1`); every judgement records the version it
was made with. They are matched on the server only: runners send counts of extensions and the
names of new text and web page files (`.txt`, `.html`, `.htm`, `.hta`, `.rtf`, `.url`, where ransom
notes are written), so a list update needs no agent update.

- About 100 extensions of known families (`.locked`, `.encrypted`, `.lockbit`, `.akira`, `.djvu`,
  `.phobos`, `.ryk`, ...). Extensions that ordinary software uses stay out on purpose, however many
  families used them: `.enc`, `.java`, `.xyz`, `.abc`, `.crypt12`. A test keeps the list apart
  from the formats the entropy rules know.
- Ransom notes: fixed names (`_readme.txt`, `RyukReadMe.txt`, `Restore-My-Files.txt`, `info.hta`,
  ...) and any text or web page whose name pairs an action word (`decrypt`, `restore`, `recover`,
  `unlock`, `encrypted`) with a subject word (`readme`, `how_to`, `help`, `instruction`, `files`,
  `your`, ...), like `HOW_TO_DECRYPT_FILES.txt`. Notes are dropped into every folder; the default
  of two copies keeps an admin's own `how_to_restore.txt` from alerting.

To change a list: edit `signatures.ts`, bump the version (year, month, counter), run the core
tests. Lists only ever say "suspicious"; a name missing from them never makes anything clean.

### Entropy

Encrypted data looks like random bytes: close to 8 bits per byte (Shannon entropy). Runners
measure the **first and the last 64 KiB** of a handful of new or changed files, nothing else of
them:

- endpoint agent and file share runner: 8 files picked at random from the new and changed files
  of `restic diff`, read from disk after the backup;
- OneDrive: the first 8 eligible files the backup downloads, measured on the way through the
  chunker (no extra download, no buffering beyond the two windows).

Compressed or encrypted formats (ZIP and the Office XML files, JPEG, PNG, video, audio, PDF, disk
images, KeePass, PGP, ...) are never judged: their entropy says nothing. For plain formats (text,
CSV, the old Office files, bitmaps, WAV, source code) one window at or above the bound is enough;
for formats of unknown type both windows must be (one window may be an embedded picture).

### Compression and deduplication

Encrypted data does not compress and does not deduplicate. When ransomware encrypts a VM's disk
or a file server, the amount of change may still look ordinary (an attacker can go slowly, a VM
rewrites the same blocks), but the new data suddenly stores at its full size and none of it is
found in the repository already. Per run, two ratios of the **new** data are measured:

- **compression ratio** = stored / raw of the new data. Near 1.0: it does not compress.
- **deduplication ratio** = new / processed: the share of what the run read that the repository did
  not have yet. Near 1.0: nothing deduplicated.

| Source | Compression ratio | Deduplication ratio |
| --- | --- | --- |
| Machine (restic) | `data_added_packed / data_added` (agent 0.4.x and newer: `dataAddedPacked`) | `data_added / total_bytes_processed` |
| File share (restic) | the same (every runner sends `dataAddedPacked`) | the same |
| Proxmox VE container (restic) | the same (nodes 0.4.x and newer: `resticBytesAddedPacked`) | `data_added / total_bytes_processed` (`resticTotalBytes`) |
| Proxmox VE VM (Restow's chunk store) | estimate, see below | new chunk bytes / bytes chunked of the changed blocks |
| Mailbox, OneDrive, SharePoint site, IMAP account (chunk store) | estimate, see below | new chunk bytes / bytes chunked |

Restow's own chunk store does not compress (packs hold the chunks sealed with AES-GCM). Its chunk
writer therefore **estimates** how well the new data would compress: the first 16 KiB of every new
chunk are deflated at the fastest level, up to 64 MiB per writer (a few hundred milliseconds of
CPU), and the ratio is deflated / sampled. A VM's block frames arrive in several requests; the
server sums the writer's numbers of every frame into the run's statistics (`chunkBytesIn`,
`chunkBytesNew`, `chunkBytesSampled`, `chunkBytesSampledCompressed` in `pve_runs.stats`), a backup
of a mailbox, OneDrive, SharePoint site or IMAP account keeps them in its result
(`jobs.payload.result.chunkStats`). A restic repository of format 1 does not compress either: its
ratio is then always about 1.0, which the baseline takes as normal.

Like the amount of change, both ratios are judged **against the object's own history**: the median
and median absolute deviation of the last clean restore points that added any data (at least 5).
A finding needs all of:

- at least `minBytes` (256 MiB) of new data in the run (small runs have noisy ratios);
- the ratio at or above the absolute bound (compression 0.95, deduplication 0.8);
- the ratio at least `minRise` above the object's median (0.15 for compression, 0.3 for
  deduplication) and `madFactor` (6) deviations above it (a deviation of at least 0.01).

An object whose new data is **always** incompressible (media files, already compressed archives, a
VM with BitLocker or LUKS inside, a compressed VM disk) has a median near 1.0. Its bound is then
above 1.15 and can never be reached, so it never alerts on this signal; its amount of change is
still judged. An older agent or node that sends no packed size, and a run of a kind without the
numbers, says **not available**.

## Retention hold

The real damage is not the encrypted restore point. It is retention removing the clean old restore
points while encrypted ones accumulate: after a week of daily encrypted backups and seven daily
restore points kept, nothing clean is left. So while an object has a **suspicious restore point
nobody resolved**, retention deletes **no restore point of that object**, and with them nothing
they reference:

| Object | Retention path | While held |
| --- | --- | --- |
| Machine | `endpoint-retention` (`restic forget` + `prune`, `apps/worker/src/endpoints/retention.ts`) | nothing is forgotten or pruned; the snapshots are still audited and the repository measured; the retention report says `retentionHeld` and how many snapshots it kept back |
| File share | share retention (`apps/worker/src/file-shares/maintenance.ts`) | the same |
| Proxmox VE guest | PVE maintenance (`apps/worker/src/pve/maintenance.ts`) | no restore point is pruned, so no chunk reference is released and no container snapshot forgotten |
| Mailbox, OneDrive, SharePoint site, IMAP account | `retention` queue (`apps/worker/src/handlers/retention.ts`) | the object's expired snapshots stay active (summary `heldOnSuspicion`) |

Shared storage: a restic repository belongs to one object. Restow's chunk store is shared by every
mailbox, OneDrive, site and VM of a tenant, and deduplicates across them; retention of the other
objects goes on, and garbage collection only collects chunks whose reference count is zero, so a
held restore point keeps every chunk it references (tested with the real collection next to a held
VM).

**When it holds.** A restore point holds while it is judged suspicious, is not called a false alarm
and its hold was not released. While the detection is on, a backup of the object from the last six
hours that the pass has not judged yet holds as well (the pass runs every two minutes; a backup it
cannot judge stops retention for six hours at most, not for days). The owner can switch the hold off
(`retentionHold.enabled`); then nothing holds.

**When it ends.** Only an administrator ends a hold, never a later clean restore point: ransomware
that was cleaned up still leaves its encrypted restore points, and an attacker who stops encrypting
for a day must not restart pruning. Two ways:

- **Mark as false alarm**: every finding that holds it counts as clean (technicians and up, audited
  per restore point, `suspicion.false_alarm`).
- **Release hold**: the findings stay marked, retention resumes with its next run and deletes what
  the rules no longer keep, suspicious restore points included. Administrators (provider admins from
  the administrator role on), a recent sign-in (like the other actions that weaken a protection),
  audited (`suspicion.hold_released`, with every restore point it released and the note).

A release ends the episode as well: the next finding is announced again and holds again.

**It never goes on silently.** The `backup.suspicious` alert says that retention is paused. A hold
still open after `retentionHold.reminderDays` (14) is announced again with `backup.suspicious_hold`
(group "Restore readiness", warning: since when, how many restore points), and every 14 days after,
also while the detection is switched off. Backups go on during a hold, so the object's storage
grows: the hold notice shows what a machine's or file share's repository takes, and storage quotas
and their warnings (`endpoint.storage_quota`, `file_share.storage_quota`) still apply; a backup that
a used-up quota refuses fails as usual.

## Signals per kind of object

| Object | Amount of change | Deletions, renames, names | Entropy | Compression, deduplication |
| --- | --- | --- | --- | --- |
| Machine (server, client) | files new + changed, bytes added (restic summary) | agent 0.4.0 and newer (`restic diff`) | agent 0.4.0 and newer (files on disk) | compression from agent 0.4.x on, deduplication always |
| File share | files new + changed, bytes added (runner statistics) | runner 0.4.0 and newer (`restic diff` against the parent) | runner 0.4.0 and newer (files on the share) | yes |
| Proxmox VE container | bytes added; files new + changed from nodes 0.4.0 on | not available | not available | from nodes 0.4.x on |
| Proxmox VE VM | bytes uploaded (changed blocks) | not available | not available | yes (server side, every node) |
| OneDrive, SharePoint site | items written, bytes added | OneDrive: yes (delta items: new, changed, gone, renamed) | OneDrive: yes (first downloads) | yes |
| Mailbox, IMAP account | items written, bytes added | not available | not available | yes |

A signal that has no data says **not available**, never "clean": an older agent that sends no
activity report, a first backup (there is nothing to compare with), a previous snapshot that
retention removed, or a kind that has no such data. The reasons dialog of a restore point lists
every signal with its state (finding, no finding, learning, not available, switched off).

## The activity report (agent protocol)

Version 1, sent by the endpoint agent with `POST /agent/v1/runs/:runId/finish` (field
`activity`), by the file share runner in its finish statistics (`stats.activity`), and kept by a
OneDrive backup in `jobs.payload.result.activity`. A Proxmox VE node sends `resticFilesNew`,
`resticFilesChanged` and `resticFilesTotal` with its commit.

For the compression signal the endpoint agent sends `stats.dataAddedPacked` with its finish and a
Proxmox VE node `resticBytesAddedPacked` with a container's commit (both 0.4.x on, left out when 0;
an older server ignores them, and without them the compression ratio is not available).

```json
{
  "v": 1,
  "added": 1240, "modified": 3, "removed": 1200, "renamed": 1200,
  "extensions": [{ "value": "locked", "count": 1200 }, { "value": "txt", "count": 41 }],
  "names": [{ "value": "HOW_TO_DECRYPT.txt", "count": 40 }],
  "entropy": [{ "path": "/srv/data/a.csv", "ext": "csv", "size": 182400, "head": 7.998, "tail": 7.997 }],
  "truncated": false
}
```

- The agent compares the new snapshot with the previous one with
  `restic diff --json --no-lock <previous> <new>`: tree metadata only, no file content, no lock.
  The previous snapshot is the one of the last backup that made one (the agent's local status);
  the runner uses the parent the server named. Ten minutes at most; failing changes nothing.
- A removed file counts only below a folder that is still backed up, so taking a folder out of a
  job is not a mass deletion. The runner leaves its own scratch files out.
- At most 40 extensions and 40 names (the most frequent), 8 entropy samples; renames and names
  stop being tracked beyond 100,000 entries (`truncated`).
- Compatible both ways: the server parses the report tolerantly (unknown fields ignored, numbers
  bounded, a malformed report dropped without failing the finish); an older server ignores the
  field; an older agent sends none.

## Results, episodes and alerts

The worker (`apps/worker/src/suspicion/scan.ts`) runs a pass every two minutes in one worker at a
time. It judges every finished backup of the last 72 hours that has no judgement yet, oldest
first, and stores one row per restore point in `restore_point_suspicions` (migration
`0045_ransomware_detection`): verdict, findings, signal states, the metrics of the baseline, the
signatures version. Runs older than 72 hours are not judged later (an upgrade or an outage does
not flood).

Alerts follow **episodes**: a suspicious restore point raises the event `backup.suspicious`
(group "Restore readiness", severity error) only when the object's previous judged restore point
was clean, a false alarm, released from its retention hold, or there was none. The next suspicious
restore points of the same attack are marked but not announced again. An episode ends with a
restore point without findings, a false alarm or the release of its hold. Notification rules
additionally throttle per object (`throttle_minutes`). The retention hold is not an episode: it
lasts until an administrator resolves it (see [Retention hold](#retention-hold)).

The event reaches the bell, the rules (e-mail) and the webhooks through the notification matrix
like every other catalog event. Its details carry `objectKind`, `objectId`, `objectName`, the
object's own id field (`endpointId`, `fileShareId`, `pveGuestId` or `protectedObjectId`),
`runId`, `restorePointId`, `restorePointAt`, `suspicionId`, `findings`, `signaturesVersion` and
`retentionHeld`. The alert mail lists every finding with its numbers in the recipient's language
and says that retention is paused.

`backup.suspicious_hold` carries the same object fields and `heldSince` (the oldest held restore
point), `heldAt`, `heldDays` and `restorePoints`.

## In the web interface

- **Badge** "Suspicious" (red, never green) on the restore point in every restore view and on the
  object (machine page, file share page, VM or container page, the account list of the explorer).
  A restore point without findings gets no badge: no finding is no proof.
- **Last clean restore point**: when the newest restore point is suspicious, the file restore of a
  machine, a file share and a container, the explorer of a mailbox or OneDrive, and the restore
  points of a VM or container say since when restore points show signs of ransomware and offer the
  newest restore point without findings. A restore point made before the detection existed counts
  as without findings.
- **Reasons**: a click on the badge shows the findings with their numbers, the state of every
  signal, the signatures version and what the detection cannot see.
- **False alarm**: technicians and administrators (provider admins from the technician role on)
  can mark a finding as a false alarm, with a note, and take it back. Both are audited
  (`suspicion.false_alarm`, `suspicion.false_alarm_revoked`). A false alarm makes the restore point
  count as clean: its numbers join the baseline, so the same amount of change (a planned migration)
  no longer alerts, and it ends the episode.
- **Retention paused**: on the machine page, the file share page, the VM or container page, the
  explorer of a mailbox or OneDrive and the file restore, a held object shows "Retention
  paused: suspicious restore point since ...", how many restore points hold it, what the repository
  takes (machines, file shares) and that quotas still apply, with **Mark as false alarm** and
  **Release hold** (administrators; an older session confirms with the passkey or signs in again
  first). Beside the object's name a "Retention paused" badge (warning) stays while the hold lasts,
  also after a clean restore point. The reasons dialog of a restore point names who released its
  hold and when.
- **Installation > Ransomware detection**: the thresholds. Every provider admin reads them, the
  owner changes them (audited, `settings.ransomware.updated`).

## Thresholds

Stored per installation in `settings.ransomware_detection` (only what the owner changed; `{}` is
every default) and read by `resolveRansomwareSettings`, which clamps every value into its range.
`PUT /api/v1/settings/ransomware` refuses values outside the range and unknown keys.

| Setting | Default | Range |
| --- | --- | --- |
| `enabled` | on | (off: nothing is judged) |
| `baselineRuns` | 14 | 3 to 60 |
| `minBaselineRuns` | 5 | 2 to 30 |
| `changeRate.madFactor` | 8 | 2 to 50 |
| `changeRate.minRatio` | 5 | 1.5 to 100 |
| `changeRate.minItems` | 500 | 10 to 10,000,000 |
| `changeRate.minBytes` | 1 GiB | 1 MiB to 10 TiB |
| `deletions.minFiles` / `minShare` | 1,000 / 25 % | 10 to 10,000,000 / 1 to 100 % |
| `renames.minFiles` / `minShare` | 100 / 2 % | 5 to 10,000,000 / 0.1 to 100 % |
| `names.minExtensionFiles` / `minNoteCopies` | 20 / 2 | 1 to 1,000,000 / 1 to 1,000 |
| `entropy.minSamples` / `highBits` / `minHighShare` | 3 / 7.9 / 50 % | 1 to 16 / 7 to 8 / 10 to 100 % |
| `compressibility.minBytes` | 256 MiB | 1 MiB to 10 TiB |
| `compressibility.madFactor` | 6 | 2 to 50 |
| `compressibility.compressionMinRatio` / `compressionMinRise` | 0.95 / 0.15 | 0.5 to 1 / 0.01 to 0.9 |
| `compressibility.dedupMinRatio` / `dedupMinRise` | 0.8 / 0.3 | 0.1 to 1 / 0.01 to 0.9 |
| `retentionHold.enabled` | on | (off: nothing holds retention) |
| `retentionHold.reminderDays` | 14 | 1 to 365 |

Every signal can be switched off on its own (`changeRate.enabled`, ...). The defaults are chosen
so that ordinary days of ordinary objects stay quiet: a file server where a quarter of the files
change every night has a high median and a wide spread, and only a jump far beyond it alerts.

## What it cannot detect

- **Slow or partial encryption.** Ransomware that encrypts a few files per day, or only parts of
  large files, stays within the baseline. Intermittent encryption that leaves the first and last
  64 KiB of a file intact is invisible to the entropy samples.
- **Encryption without a trace in names** keeps the extension and drops no note: then only the
  amount of change, the entropy and the compression and deduplication of the new data can see it.
- **Small or mixed runs.** Below 256 MiB of new data the ratios are not judged, and encrypted
  data mixed into a large amount of ordinary new data moves them only partly. An object whose new
  data never compresses gains nothing from this signal (by design, it must not alert).
- **Data the backup does not see**: excluded folders, files above a size limit, data changed
  after the backup, VMs (no files, only the amount of changed blocks), mailboxes (only the
  amount of new items).
- **An attacker who knows the detection** can stay below the thresholds, encrypt into compressed
  formats (never judged by the entropy samples), or encrypt the backup history first. Immutable
  storage protects the history; the retention hold only stops Restow's own retention from deleting
  it, and an administrator account the attacker holds can release it (a recent sign-in, audited).
- **Malware that does not encrypt** (data theft, backdoors) leaves no trace in these signals.
- **The first backup** and objects with a short history: no comparison, the amount of change is
  still being learned.
- **Not validated against real samples.** The signals and defaults are built from the published
  behaviour of ransomware families and tested with simulated attacks (random bytes, renamed
  extensions, notes in every folder), not against live ransomware.
