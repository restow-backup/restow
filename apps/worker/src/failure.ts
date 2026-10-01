/**
 * Failure records for the worker: classify what a job, item or source hit and
 * shape it for the jsonb columns next to the legacy error text.
 *
 * Everything stored here passes through the core classifier, which redacts
 * (packages/core/src/failures/redact.ts) on top of the database errors being
 * reduced to their driver message (@restow/db reportableError) so the SQL and
 * its bound values never get in.
 */
import {
  type ClassifyContext,
  type FailureCause,
  type FailureRecord,
  buildCause,
  classifyFailure,
  redactSensitiveText,
  toFailureRecord,
} from "@restow/core";
import type { FailureRecordJson } from "@restow/db";
import { reportableError } from "@restow/db";

function isInvalidPayload(error: unknown): boolean {
  return error instanceof Error && error.name === "InvalidPayloadError";
}

/** Causes that concern the whole source (its credentials, consent or reachability), not one object. */
const SOURCE_SCOPED_CODES: ReadonlySet<string> = new Set([
  "graph.consent_missing",
  "graph.app_credentials_invalid",
  "graph.tenant_not_found",
  "graph.permission_missing",
  "imap.auth_failed",
  "imap.oauth_failed",
  "imap.address_blocked",
  "imap.starttls_unavailable",
  "config.app_not_configured",
]);

export function isSourceScopedCause(cause: { readonly code: string }): boolean {
  return SOURCE_SCOPED_CODES.has(cause.code);
}

/**
 * The retry state of a run that failed while pg-boss still has budget: which
 * attempt failed, how many the queue allows, and when the next one starts.
 * pg-boss waits between `delay * 2^count` and twice that with backoff; the
 * middle is stored and shown as "around".
 */
export function retryStateOf(
  meta: {
    readonly retryCount: number;
    readonly retryLimit: number;
    readonly retryDelay: number;
    readonly retryBackoff: boolean;
  },
  now: Date,
): NonNullable<FailureRecord["retry"]> {
  const base = Math.max(0, meta.retryDelay);
  const seconds = meta.retryBackoff ? base * 2 ** Math.min(16, meta.retryCount) * 1.5 : base;
  return {
    attempt: meta.retryCount + 1,
    limit: meta.retryLimit + 1,
    nextAttemptAt: new Date(now.getTime() + seconds * 1000).toISOString(),
  };
}

export interface JobFailureInput {
  readonly error: unknown;
  /** The queue the job ran on; kept as `params.queue` (a directory failure is not cleared by a backup). */
  readonly queue: string;
  readonly now: Date;
  /** The engine phase the run was in. */
  readonly step: string | null;
  /** Why the abort signal fired, when it did ("shutdown", "expired"). */
  readonly abortReason: string | null;
  /** Set when pg-boss will run the job again. */
  readonly retry: FailureRecord["retry"];
  readonly context?: ClassifyContext;
}

/** The failure record of a failed run. */
export function jobFailureRecord(input: JobFailureInput): FailureRecordJson {
  const reportable = reportableError(input.error);
  const interrupted = input.abortReason === "shutdown" || input.abortReason === "expired";
  let cause = classifyFailure(reportable, { ...input.context, abortReason: input.abortReason });
  if (interrupted) {
    // The worker stopping or the run hitting its limit is why it ended, whatever error that raised.
    cause = {
      ...cause,
      code: "job.interrupted",
      transient: true,
      params: { reason: input.abortReason },
    };
  } else if (cause.code === "unknown" && isInvalidPayload(reportable)) {
    // The job was rejected before it started; the message names the setting.
    cause = buildCause(
      "config.invalid",
      {},
      {
        message: redactSensitiveText((reportable as Error).message),
      },
    );
  }
  return toFailureRecord(
    { ...cause, params: { ...cause.params, queue: input.queue } },
    { now: input.now, step: input.step, retry: input.retry },
  ) as FailureRecordJson;
}

/** The failure record of one item, from the cause its engine classified. */
export function itemFailureRecord(
  cause: FailureCause,
  now: Date,
  step: string | null,
): FailureRecordJson {
  return toFailureRecord(cause, { now, step }) as FailureRecordJson;
}
