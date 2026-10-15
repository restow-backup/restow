# Ransomware detection on backups

Status: **built** (0.4.x). Audience: operators and maintainers. Edition: Community (core).

Every backup sees what changed on the system it protects. When ransomware encrypts a file
server, the next backup sees thousands of files change at once, files renamed to `.locked`,
ransom notes in every folder, and file contents that suddenly look like random bytes. Restow
judges every new restore point from these traces, marks the suspicious ones, alerts once per
attack, and points every restore view to the newest restore point without findings.

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
                episode
```

- `packages/core/src/ransomware/`: the signals, the signatures, the baseline and the judgement
  (pure functions), the activity report format.
- `agent/internal/activity/`: the activity report of the endpoint agent and the file share
  runner (`restic diff`, names, entropy).
- `packages/core/src/backup/onedrive/run.ts`: the activity report of a OneDrive backup.
- `apps/worker/src/suspicion/`: the pass that judges new restore points and raises the event.
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

## Signals per kind of object

| Object | Amount of change | Deletions, renames, names | Entropy |
| --- | --- | --- | --- |
| Machine (server, client) | files new + changed, bytes added (restic summary) | agent 0.4.1 and newer (`restic diff`) | agent 0.4.1 and newer (files on disk) |
| File share | files new + changed, bytes added (runner statistics) | runner 0.4.1 and newer (`restic diff` against the parent) | runner 0.4.1 and newer (files on the share) |
| Proxmox VE container | bytes added; files new + changed from nodes 0.4.1 on | not available | not available |
| Proxmox VE VM | bytes uploaded (changed blocks) | not available | not available |
| OneDrive | items written, bytes added | yes (delta items: new, changed, gone, renamed) | yes (first downloads) |
| Mailbox, IMAP account | items written, bytes added | not available | not available |

A signal that has no data says **not available**, never "clean": an older agent that sends no
activity report, a first backup (there is nothing to compare with), a previous snapshot that
retention removed, or a kind that has no such data. The reasons dialog of a restore point lists
every signal with its state (finding, no finding, learning, not available, switched off).

## The activity report (agent protocol)

Version 1, sent by the endpoint agent with `POST /agent/v1/runs/:runId/finish` (field
`activity`), by the file share runner in its finish statistics (`stats.activity`), and kept by a
OneDrive backup in `jobs.payload.result.activity`. A Proxmox VE node sends `resticFilesNew`,
`resticFilesChanged` and `resticFilesTotal` with its commit.

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
was clean, a false alarm, or there was none. The next suspicious restore points of the same attack
are marked but not announced again. An episode ends with a restore point without findings or with
a false alarm. Notification rules additionally throttle per object (`throttle_minutes`).

The event reaches the bell, the rules (e-mail) and the webhooks through the notification matrix
like every other catalog event. Its details carry `objectKind`, `objectId`, `objectName`, the
object's own id field (`endpointId`, `fileShareId`, `pveGuestId` or `protectedObjectId`),
`runId`, `restorePointId`, `restorePointAt`, `suspicionId`, `findings` and `signaturesVersion`.
The alert mail lists every finding with its numbers in the recipient's language.

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

Every signal can be switched off on its own (`changeRate.enabled`, ...). The defaults are chosen
so that ordinary days of ordinary objects stay quiet: a file server where a quarter of the files
change every night has a high median and a wide spread, and only a jump far beyond it alerts.

## What it cannot detect

- **Slow or partial encryption.** Ransomware that encrypts a few files per day, or only parts of
  large files, stays within the baseline. Intermittent encryption that leaves the first and last
  64 KiB of a file intact is invisible to the entropy samples.
- **Encryption without a trace in names** keeps the extension and drops no note: then only the
  amount of change and the entropy can see it.
- **Data the backup does not see**: excluded folders, files above a size limit, data changed
  after the backup, VMs (no files, only the amount of changed blocks), mailboxes (only the
  amount of new items).
- **An attacker who knows the detection** can stay below the thresholds, encrypt into compressed
  formats (never judged), or encrypt the backup history first. Immutable storage protects the
  history; this detection does not.
- **Malware that does not encrypt** (data theft, backdoors) leaves no trace in these signals.
- **The first backup** and objects with a short history: no comparison, the amount of change is
  still being learned.
- **Not validated against real samples.** The signals and defaults are built from the published
  behaviour of ransomware families and tested with simulated attacks (random bytes, renamed
  extensions, notes in every folder), not against live ransomware.
