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
import { parseActivityReport, type RunMetrics } from "@restow/core";

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
  return {
    itemsChanged: sum(s.filesNew, s.filesChanged),
    itemsTotal: num(s.totalFilesProcessed),
    bytesAdded: num(s.dataAdded),
    activity: parseActivityReport(s.activity),
    ...resticShape(s.dataAdded, s.dataAddedPacked, s.totalBytesProcessed),
  };
}

/** A file share's backup run (`file_share_runs.stats`, the runner's statistics). */
export function fileShareRunMetrics(stats: unknown): RunMetrics {
  const s = record(stats);
  return {
    itemsChanged: sum(s.filesNew, s.filesChanged),
    itemsTotal: num(s.files) ?? num(s.totalFilesProcessed),
    bytesAdded: num(s.dataAdded),
    activity: parseActivityReport(s.activity),
    ...resticShape(s.dataAdded, s.dataAddedPacked, s.totalBytesProcessed),
  };
}

/** A Proxmox VE guest's backup run (`pve_runs.stats`). */
export function pveRunMetrics(kind: string, stats: unknown): RunMetrics {
  const s = record(stats);
  if (kind === "ct") {
    return {
      itemsChanged: sum(s.resticFilesNew, s.resticFilesChanged),
      itemsTotal: num(s.resticFilesTotal),
      bytesAdded: num(s.resticBytesAdded),
      activity: parseActivityReport(s.activity),
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
