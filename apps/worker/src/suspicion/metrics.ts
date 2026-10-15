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

/** A machine's backup run (`endpoint_runs.stats`). */
export function endpointRunMetrics(stats: unknown): RunMetrics {
  const s = record(stats);
  return {
    itemsChanged: sum(s.filesNew, s.filesChanged),
    itemsTotal: num(s.totalFilesProcessed),
    bytesAdded: num(s.dataAdded),
    activity: parseActivityReport(s.activity),
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
    };
  }
  return { itemsChanged: null, itemsTotal: null, bytesAdded: num(s.uploadedBytes), activity: null };
}

/** A mailbox, OneDrive or IMAP backup job (`jobs.payload.result`). */
export function m365RunMetrics(result: unknown): RunMetrics {
  const r = record(result);
  return {
    itemsChanged: num(r.objectsWritten),
    itemsTotal: num(r.objectsTotal),
    bytesAdded: num(r.bytes),
    activity: parseActivityReport(r.activity),
  };
}
