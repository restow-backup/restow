import type { RestoreJob } from "@restow/db";
import { type FailureDto, failureDto } from "../failures/dto.js";

/**
 * Reading what the worker recorded about a finished restore
 * (apps/worker/src/handlers/restore.ts writes `jobs.payload.result`), and the
 * download-link lifetime. Pure and tolerant: the payload is free-form jsonb,
 * so anything missing degrades to zero or null instead of failing a request.
 */

/** Download links stop working this long after the job finished (docs/ARCHITECTURE.md). */
export const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type RestoreItemStatus = "restored" | "skipped" | "failed";

/**
 * Machine-readable outcome of one item (packages/core restore/results.ts,
 * RestoreItemCode); the UI explains each in the user's language and falls
 * back to the engine's English `reason` for codes it does not know.
 */
export const RESTORE_ITEM_CODES = [
  "restored",
  "unverified",
  "exists",
  "not_restorable",
  "parent_not_restored",
  "wrong_target",
  "data_missing",
  "integrity",
  "target_rejected",
  "error",
] as const;
export type RestoreItemCode = (typeof RESTORE_ITEM_CODES)[number];

/** One item's outcome, as the engine reported it. */
export interface RestoreItemDto {
  path: string;
  itemId: string | null;
  /** Manifest object type (mail, event, contact, file, ...). */
  type: string;
  status: RestoreItemStatus;
  code: RestoreItemCode | null;
  /** Where it ended up: a Graph id, an IMAP UID, a ZIP entry name. */
  targetRef: string | null;
  bytes: number;
  /** The target confirmed the item (hash, size or Message-ID match). */
  verified: boolean;
  /** Why an item was skipped, failed, or could not be confirmed. */
  reason: string | null;
  /** Subject and sender from the backup, when recorded; null for files and older jobs. */
  subject: string | null;
  from: string | null;
  /**
   * Why a failed item failed and what to do (classified); null for other
   * outcomes and for results stored before causes existed (`reason` remains).
   */
  failure: FailureDto | null;
}

/** Counts of a finished restore. */
export interface RestoreResultDto {
  restored: number;
  skipped: number;
  failures: number;
  /** Restored items whose target confirmation did not match (counted in `restored`). */
  unverified: number;
  /** Folders recreated or found in place (containers, not counted as items). */
  folders: number;
  bytes: number;
  downloadKey: string | null;
  /** Pauses Microsoft Graph imposed on the run and their summed duration. */
  throttleWaits: number;
  throttleWaitMs: number;
}

export interface RestoreItemsDto {
  /** Items needing attention first (failed, skipped, unconfirmed), then the rest. */
  items: RestoreItemDto[];
  /** How many per-item outcomes the engine produced before the list was capped. */
  total: number;
  truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resultRecord(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return record(payload?.result);
}

/** The engine counts the worker stored in the job payload, if the job finished. */
export function resultFromPayload(
  payload: Record<string, unknown> | null,
): RestoreResultDto | null {
  const result = resultRecord(payload);
  if (!result) {
    return null;
  }
  return {
    restored: count(result.restored),
    skipped: count(result.skipped),
    failures: count(result.failures),
    unverified: count(result.unverified),
    folders: count(result.folders),
    bytes: count(result.bytes),
    downloadKey: text(result.downloadKey),
    throttleWaits: count(result.throttleWaits),
    throttleWaitMs: count(result.throttleWaitMs),
  };
}

const ITEM_STATUSES: ReadonlySet<string> = new Set(["restored", "skipped", "failed"]);
const ITEM_CODES: ReadonlySet<string> = new Set(RESTORE_ITEM_CODES);

function toItem(value: unknown, at: string): RestoreItemDto | null {
  const item = record(value);
  const path = text(item?.path);
  const status = item?.status;
  if (!item || !path || typeof status !== "string" || !ITEM_STATUSES.has(status)) {
    return null;
  }
  return {
    path,
    itemId: text(item.itemId),
    type: text(item.type) ?? "file",
    status: status as RestoreItemStatus,
    code:
      typeof item.code === "string" && ITEM_CODES.has(item.code)
        ? (item.code as RestoreItemCode)
        : null,
    targetRef: text(item.targetRef),
    bytes: count(item.bytes),
    verified: item.verified === true,
    reason: text(item.reason),
    subject: text(item.subject),
    from: text(item.from),
    failure:
      item.cause !== null && typeof item.cause === "object"
        ? failureDto({ ...(item.cause as Record<string, unknown>), occurredAt: at })
        : null,
  };
}

/** The per-item outcomes the worker stored, or null while the job has not finished. */
export function itemsFromPayload(payload: Record<string, unknown> | null): RestoreItemsDto | null {
  const result = resultRecord(payload);
  if (!result || !Array.isArray(result.items)) {
    return null;
  }
  const at = text(result.completedAt) ?? new Date(0).toISOString();
  const items = result.items
    .map((item) => toItem(item, at))
    .filter((item): item is RestoreItemDto => item !== null);
  const total = Math.max(count(result.itemCount), items.length);
  return { items, total, truncated: total > items.length };
}

/** Storage prefix the download engine writes into (mirrors @restow/core `downloadKey`). */
export function downloadPrefix(tenantId: string, restoreJobId: string): string {
  return `tenants/${tenantId}/downloads/${restoreJobId}/`;
}

/** Whether (and until when) a download restore can still be fetched. */
export function downloadAvailability(
  targetType: RestoreJob["targetType"],
  status: string,
  completedAt: Date | null,
  now: Date,
): { available: boolean; expiresAt: string | null } {
  if (targetType !== "download" || status !== "completed" || !completedAt) {
    return { available: false, expiresAt: null };
  }
  const expiresAt = new Date(completedAt.getTime() + DOWNLOAD_TTL_MS);
  return { available: expiresAt.getTime() > now.getTime(), expiresAt: expiresAt.toISOString() };
}
