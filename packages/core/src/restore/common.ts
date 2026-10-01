/**
 * Helpers every restore engine shares: the chunk reader for a job, the name
 * of the folder "rename"-mode restores land in, optional per-request knobs,
 * the mailbox/IMAP restore mode (a mailbox or IMAP restore never replaces an
 * original, so these engines never honour "replace"; docs/ARCHITECTURE.md,
 * Restore), cancellation and safe JSON decoding of backed-up Graph objects.
 */
import { ChunkReader, JobAbortedError } from "../engine/chunkstore.js";
import type {
  JobContext,
  ProtectedObjectRef,
  RestoreMode,
  RestoreRequest,
} from "../engine/types.js";
import type { GraphClient } from "../graph/client.js";
import type { ManifestObject } from "../manifest.js";

/**
 * Hands out a throttled Graph client for the Microsoft 365 tenant that owns a
 * protected object. Same shape as the backup engines' factory, so the worker
 * can pass one function to both.
 */
export type RestoreGraphClientFactory = (
  ctx: JobContext,
  protectedObject: ProtectedObjectRef,
) => Promise<GraphClient> | GraphClient;

/** A chunk reader bound to the job's storage, keys, index and abort signal. */
export function chunkReaderFor(ctx: JobContext): ChunkReader {
  return new ChunkReader({
    storage: ctx.storage,
    keys: ctx.keys,
    index: ctx.chunkIndex,
    logger: ctx.logger,
    signal: ctx.signal,
  });
}

export function throwIfAborted(ctx: Pick<JobContext, "signal">): void {
  if (ctx.signal.aborted) {
    throw new JobAbortedError();
  }
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * The folder, calendar or mailbox that "rename"-mode restores land in when
 * the request does not name one, e.g. `Restow 2026-09-22 1430` (UTC). It is
 * deliberately language-neutral: the API passes a localised name through
 * {@link RestoreRequestOptions.restoreFolderName}. No character in it is a
 * hierarchy delimiter on any mail system.
 */
export function defaultRestoreFolderName(now: Date): string {
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  return `Restow ${date} ${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

/**
 * Optional knobs a request may carry beyond the core contract. The API stores
 * them in `restore_jobs.source_selection.options`; they are read from either
 * the request or its selection so the worker can pass the row through as is.
 */
export interface RestoreRequestOptions {
  /** Name of the folder/calendar/mailbox for "rename"-mode restores (localised by the caller). */
  readonly restoreFolderName?: string;
  /** Keep attendees on restored events; Exchange then sends invitations. Default false. */
  readonly keepAttendees?: boolean;
  /** Download restores: the archive file name (default `restore-<timestamp>.zip`). */
  readonly archiveName?: string;
}

function optionsRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A caller-supplied name as one folder segment: no control characters, no path separators. */
export function sanitizeFolderName(name: string): string {
  return name.replace(CONTROL_CHARACTERS, "").replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim();
}

function stringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = sanitizeFolderName(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function restoreRequestOptions(request: RestoreRequest): RestoreRequestOptions {
  const direct = optionsRecord((request as { options?: unknown }).options);
  const nested = optionsRecord((request.selection as { options?: unknown }).options);
  const raw = { ...(nested ?? {}), ...(direct ?? {}) };
  const restoreFolderName = stringOption(raw.restoreFolderName);
  const archiveName = stringOption(raw.archiveName);
  return {
    ...(restoreFolderName !== undefined ? { restoreFolderName } : {}),
    ...(typeof raw.keepAttendees === "boolean" ? { keepAttendees: raw.keepAttendees } : {}),
    ...(archiveName !== undefined ? { archiveName } : {}),
  };
}

/**
 * The moment a restore stands for: when it was requested, or the job clock
 * for callers that have no stored request. Stable across the attempts of a
 * retried job whenever the request carries it.
 */
export function restoreRequestTime(ctx: Pick<JobContext, "now">, request: RestoreRequest): Date {
  const requestedAt = request.requestedAt;
  return requestedAt instanceof Date && !Number.isNaN(requestedAt.getTime())
    ? requestedAt
    : ctx.now();
}

/**
 * The restore folder name for a request: the caller's, or the default dated
 * by the request. A retried attempt therefore writes into the folder of the
 * first one, where the duplicate checks recognise the items it already
 * restored, instead of into a new folder a few minutes later.
 */
export function restoreFolderNameFor(
  ctx: Pick<JobContext, "now">,
  request: RestoreRequest,
): string {
  return (
    restoreRequestOptions(request).restoreFolderName ??
    defaultRestoreFolderName(restoreRequestTime(ctx, request))
  );
}

/**
 * A restore into a mailbox or IMAP account never replaces an original
 * (docs/ARCHITECTURE.md, Restore): the API refuses a new restore request
 * with mode "replace" for these targets
 * (apps/api/src/features/restore/service.ts,
 * urn:restow:problem:restore-replace-not-allowed). The `restore_mode`
 * database enum keeps the value for history, so a job queued before that
 * change may still carry it.
 */
export const LEGACY_REPLACE_MODE_NOTE =
  'this restore was queued with the mode "replace", which mailboxes no longer support; it ran as "rename" instead: restored items were added next to the originals, and no existing item was changed or removed';

export interface MailboxRestoreMode {
  /** The mode the engine runs with; a mailbox or IMAP target only ever restores, never replaces. */
  readonly mode: "rename" | "skip";
  /** True when the stored request asked for the discontinued "replace" mode. */
  readonly legacyReplace: boolean;
}

/**
 * Resolve a mailbox or IMAP restore job's stored mode: "replace" (only
 * possible on a job queued before it was disallowed) becomes "rename" —
 * defence in depth, so these engines never reach code that could delete,
 * overwrite or move an existing item — everything else passes through.
 */
export function mailboxRestoreMode(mode: RestoreMode): MailboxRestoreMode {
  return mode === "replace"
    ? { mode: "rename", legacyReplace: true }
    : { mode, legacyReplace: false };
}

/** Thrown when a backed-up JSON object cannot be decoded. */
export class MalformedObjectError extends Error {
  constructor(object: ManifestObject, detail: string) {
    super(`object ${object.path} is not valid ${object.type ?? "JSON"}: ${detail}`);
    this.name = "MalformedObjectError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a backed-up JSON object (event, contact, parts-format message). */
export async function readJsonObject(
  reader: ChunkReader,
  object: ManifestObject,
): Promise<Record<string, unknown>> {
  const bytes = await reader.readObjectToBuffer(object);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new MalformedObjectError(object, error instanceof Error ? error.message : "parse error");
  }
  if (!isRecord(parsed)) {
    throw new MalformedObjectError(object, "expected a JSON object");
  }
  return parsed;
}
