/**
 * Building, storing and reading failure records.
 *
 * The worker stores a {@link FailureRecord} (jsonb) next to the legacy error
 * text of a job, item or source. Readers (the API) never trust what they
 * load: {@link parseFailureRecord} keeps what it understands and drops the
 * rest, so a row written by a newer or older version cannot break a response.
 */
import { catalogEntry } from "./catalog.js";
import { type ClassifyContext, classifyFailure } from "./classify.js";
import { MAX_FAILURE_TEXT, redactSensitiveText } from "./redact.js";
import {
  FAILURE_RECORD_VERSION,
  type FailureCause,
  type FailureParams,
  type FailureRecord,
  type FailureRetry,
  type FailureStep,
  type FailureTechnical,
} from "./types.js";

/** The default place operators are sent to for more help; overridable by configuration. */
export const DEFAULT_DOCS_TROUBLESHOOTING_URL =
  "https://docs.restowbackup.com/administrators/troubleshooting/";

export interface RecordOptions {
  now: Date;
  /** The step (engine phase) the run was in. */
  step?: string | null;
  retry?: FailureRetry | null;
  context?: ClassifyContext;
}

/** Wrap a classified cause with when, where and retry state, ready to store. */
export function toFailureRecord(cause: FailureCause, options: RecordOptions): FailureRecord {
  return {
    v: FAILURE_RECORD_VERSION,
    code: cause.code,
    transient: cause.transient,
    params: cause.params,
    technical: cause.technical,
    occurredAt: options.now.toISOString(),
    step: options.step ?? null,
    retry: options.retry ?? null,
  };
}

/** Classify `error` and wrap the result for storage. */
export function recordFailure(error: unknown, options: RecordOptions): FailureRecord {
  return toFailureRecord(classifyFailure(error, options.context), options);
}

// ---------------------------------------------------------------------------
// Reading what was stored
// ---------------------------------------------------------------------------

function scalarRecord<T extends string | number | boolean | null>(
  value: unknown,
  accepts: (entry: unknown) => entry is T,
  maxEntries = 20,
): Record<string, T> {
  const result: Record<string, T> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= maxEntries) {
      break;
    }
    if (key.length > 0 && key.length <= 40 && accepts(entry)) {
      result[key] = (typeof entry === "string" ? entry.slice(0, MAX_FAILURE_TEXT) : entry) as T;
    }
  }
  return result;
}

const isParam = (entry: unknown): entry is string | number | boolean | null =>
  entry === null ||
  typeof entry === "string" ||
  typeof entry === "boolean" ||
  (typeof entry === "number" && Number.isFinite(entry));
const isTechnical = (entry: unknown): entry is string | number =>
  typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry));

function parseRetry(value: unknown): FailureRetry | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as { attempt?: unknown; limit?: unknown; nextAttemptAt?: unknown };
  if (typeof raw.attempt !== "number" || typeof raw.limit !== "number") {
    return null;
  }
  const next =
    typeof raw.nextAttemptAt === "string" && !Number.isNaN(Date.parse(raw.nextAttemptAt))
      ? raw.nextAttemptAt
      : null;
  return { attempt: raw.attempt, limit: raw.limit, nextAttemptAt: next };
}

/**
 * A stored failure, defensively: null for anything that is not a failure
 * record. Unknown codes are kept (a newer version may have written them); the
 * caller falls back to the generic explanation for those.
 */
export function parseFailureRecord(value: unknown): FailureRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string" || raw.code.length === 0 || raw.code.length > 80) {
    return null;
  }
  const occurredAt =
    typeof raw.occurredAt === "string" && !Number.isNaN(Date.parse(raw.occurredAt))
      ? raw.occurredAt
      : new Date(0).toISOString();
  return {
    v: FAILURE_RECORD_VERSION,
    // A code from a newer version stays a string; typing it as FailureCode would be a lie.
    code: raw.code as FailureRecord["code"],
    transient: raw.transient === true,
    params: scalarRecord(raw.params, isParam) as FailureParams,
    technical: scalarRecord(raw.technical, isTechnical, 30) as FailureTechnical,
    occurredAt,
    step: typeof raw.step === "string" && raw.step.length > 0 ? raw.step.slice(0, 80) : null,
    retry: parseRetry(raw.retry),
  };
}

// ---------------------------------------------------------------------------
// What to do
// ---------------------------------------------------------------------------

export interface FailureGuidance {
  /** Steps in the order to try them (empty for a code this build does not know). */
  steps: readonly FailureStep[];
  /** A manual retry makes sense once the cause is fixed. */
  retryable: boolean;
  /** Waiting is enough by default. */
  transient: boolean;
  category: string | null;
}

/** The steps and retry advice for a cause, from the catalog. */
export function guidanceFor(
  cause: Pick<FailureCause, "code" | "params" | "transient">,
): FailureGuidance {
  const entry = catalogEntry(cause.code);
  if (!entry) {
    return { steps: [], retryable: true, transient: cause.transient, category: null };
  }
  return {
    steps: entry.steps(cause.params),
    retryable: entry.retryable,
    transient: cause.transient,
    category: entry.category,
  };
}

/** The troubleshooting page operators are pointed to; `configured` overrides the default. */
export function docsTroubleshootingUrl(configured?: string | null): string {
  const value = configured?.trim();
  if (!value) {
    return DEFAULT_DOCS_TROUBLESHOOTING_URL;
  }
  return value.endsWith("/") ? value : `${value}/`;
}

/** A one-line, redacted English summary, for the legacy error columns and logs. */
export function summarizeFailure(cause: FailureCause, fallbackMessage?: string): string {
  const message = cause.technical.message;
  const text = typeof message === "string" && message.length > 0 ? message : fallbackMessage;
  return redactSensitiveText(text ? `${cause.code}: ${text}` : cause.code);
}
