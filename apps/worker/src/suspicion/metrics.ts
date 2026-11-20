/**
 * The numbers of one backup run, per kind of object (docs/RANSOMWARE.md, "Signals per kind"),
 * read from what the run stored anyway. Pure, so each kind's mapping is tested without a database.
 *
 *   endpoint    restic's summary (files new and changed, data added, files processed) and the
 *               agent's activity report (agent 0.4.0 and newer)
 *   file_share  the runner's statistics (the same restic summary, the walk's file count) and
 *               its activity report
 *   pve_guest   a container: restic's bytes added (and file counts and an activity report from
 *               a node that sends them); a VM: the bytes it uploaded (changed blocks)
 *
 * The files new and changed of a restic run come from its activity report where it has one: new
 * files and files with new content (`restic diff`, docs/RANSOMWARE.md). restic's summary also
 * counts a file whose owner, mode or ctime alone changed, so a `chown -R` over a data folder
 * looked like thousands of changed files (0.5.1). Without a report the summary counts.
 *   m365        the items a mailbox, OneDrive or IMAP backup wrote and the bytes it stored; a
 *               OneDrive backup's activity report
 *
 * The compression and deduplication of the new data (docs/RANSOMWARE.md, "Compression and
 * deduplication"), as far as the source reports them:
 *
 *   restic (machines, file shares, containers)
 *               compression  data_added_packed / data_added (agent and nodes 0.4.x on; every
 *                            file share runner)
 *               dedup        data_added / total_bytes_processed
 *   chunk store (VMs, mailboxes, OneDrive, SharePoint, IMAP)
 *               compression  the deflate estimate over a sample of every new chunk (the store
 *                            itself does not compress)
 *               dedup        new chunk bytes / bytes chunked
 */
import { type ActivityReport, parseActivityReport, type RunMetrics } from "@restow/core";

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sum(...values: unknown[]): number | null {
  const known = values.map(num);
  return known.every((value) => value === null)
    ? null
    : known.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** stored / raw, or null when either is unknown or nothing was added. */
function quotient(part: unknown, whole: unknown): number | null {
  const p = num(part);
  const w = num(whole);
  return p === null || w === null || w <= 0 ? null : Math.round((p / w) * 10_000) / 10_000;
}

/** The files new and changed of a restic run: the activity report's, else the summary's. */
function changedFiles(
  activity: ActivityReport | null,
  filesNew: unknown,
  filesChanged: unknown,
): Pick<RunMetrics, "itemsChanged" | "itemsBasis"> {
  if (activity) {
    return { itemsChanged: activity.added + activity.modified, itemsBasis: "content" };
  }
  const itemsChanged = sum(filesNew, filesChanged);
  return itemsChanged === null ? { itemsChanged } : { itemsChanged, itemsBasis: "summary" };
}

type DataShape = Pick<RunMetrics, "newBytes" | "compressionRatio" | "dedupRatio">;

/** A restic summary: compression packed / added, deduplication added / processed. */
function resticShape(added: unknown, packed: unknown, processed: unknown): DataShape {
  return {
    newBytes: num(added),
    compressionRatio: quotient(packed, added),
    dedupRatio: quotient(added, processed),
  };
}

/** The chunk writer's statistics (@restow/core `ChunkDataStats`). */
function chunkShape(bytesIn: unknown, bytesNew: unknown, sampled: unknown, compressed: unknown) {
  return {
    newBytes: num(bytesNew),
    compressionRatio: quotient(compressed, sampled),
    dedupRatio: quotient(bytesNew, bytesIn),
  } satisfies DataShape;
}

/** A machine's backup run (`endpoint_runs.stats`). */
export function endpointRunMetrics(stats: unknown): RunMetrics {
  const s = record(stats);
  const activity = parseActivityReport(s.activity);
  return {
    ...changedFiles(activity, s.filesNew, s.filesChanged),
    itemsTotal: num(s.totalFilesProcessed),
    bytesAdded: num(s.dataAdded),
    activity,
    ...resticShape(s.dataAdded, s.dataAddedPacked, s.totalBytesProcessed),
  };
}

/** A file share's backup run (`file_share_runs.stats`, the runner's statistics). */
export function fileShareRunMetrics(stats: unknown): RunMetrics {
  const s = record(stats);
  const activity = parseActivityReport(s.activity);
  return {
    ...changedFiles(activity, s.filesNew, s.filesChanged),
    itemsTotal: num(s.files) ?? num(s.totalFilesProcessed),
    bytesAdded: num(s.dataAdded),
    activity,
    ...resticShape(s.dataAdded, s.dataAddedPacked, s.totalBytesProcessed),
  };
}

/** A Proxmox VE guest's backup run (`pve_runs.stats`). */
export function pveRunMetrics(kind: string, stats: unknown): RunMetrics {
  const s = record(stats);
  if (kind === "ct") {
    const activity = parseActivityReport(s.activity);
    return {
      ...changedFiles(activity, s.resticFilesNew, s.resticFilesChanged),
      itemsTotal: num(s.resticFilesTotal),
      bytesAdded: num(s.resticBytesAdded),
      activity,
      ...resticShape(s.resticBytesAdded, s.resticBytesAddedPacked, s.resticTotalBytes),
    };
  }
  return {
    itemsChanged: null,
    itemsTotal: null,
    bytesAdded: num(s.uploadedBytes),
    activity: null,
    ...chunkShape(
      s.chunkBytesIn,
      s.chunkBytesNew,
      s.chunkBytesSampled,
      s.chunkBytesSampledCompressed,
    ),
  };
}

/** A mailbox, OneDrive or IMAP backup job (`jobs.payload.result`). */
export function m365RunMetrics(result: unknown): RunMetrics {
  const r = record(result);
  const c = record(r.chunkStats);
  return {
    itemsChanged: num(r.objectsWritten),
    itemsTotal: num(r.objectsTotal),
    bytesAdded: num(r.bytes),
    activity: parseActivityReport(r.activity),
    ...chunkShape(c.bytesIn, c.bytesNew, c.bytesSampled, c.bytesSampledCompressed),
  };
}
