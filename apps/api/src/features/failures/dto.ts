import {
  type FailureCause,
  type FailureRecord,
  guidanceFor,
  parseFailureRecord,
  toFailureRecord,
} from "@restow/core";
import type { FailureRecordJson } from "@restow/db";
import { config } from "../../config.js";

/**
 * How a classified failure (packages/core/src/failures) reaches clients: what
 * the worker stored, plus what the catalog knows about the code (the steps to
 * take, whether a retry makes sense) and the page for more help. The UI
 * translates `code`, `params` and the step ids; nothing here is prose.
 *
 * Every reader is defensive: a row written by a newer version (unknown code,
 * extra fields) or an older one (no record at all) never breaks a response.
 */

/** One thing to do; `target` is a place in the UI (the client maps it to a route). */
export interface FailureStepDto {
  id: string;
  target: string | null;
}

export interface FailureRetryDto {
  /** The attempt that failed (1 = first run). */
  attempt: number;
  /** Attempts the queue allows in total. */
  limit: number;
  /** When the next attempt starts, roughly; null when unknown. */
  nextAttemptAt: string | null;
}

export interface FailureDto {
  /** Stable machine code, e.g. `graph.consent_missing`. */
  code: string;
  /** The catalog's group (microsoft, imap, network, storage, ...); null for a code this version does not know. */
  category: string | null;
  /** Waiting alone may help: the run is retried automatically. */
  transient: boolean;
  /** A manual retry makes sense once the cause is fixed. */
  retryable: boolean;
  /** Scalars the explanation interpolates: permission, host, retryAfterSeconds, ... */
  params: Record<string, string | number | boolean | null>;
  /** Redacted details for a support case: HTTP status, Graph code, request ids, server time, endpoint. */
  technical: Record<string, string | number>;
  /** When it happened (ISO 8601). */
  occurredAt: string;
  /** The step the run was in, when known (an engine phase such as `download`). */
  step: string | null;
  retry: FailureRetryDto | null;
  /** What to do, in order, with the place in the UI for each step. */
  steps: FailureStepDto[];
  /** The troubleshooting page for more help (configurable, one address for the installation). */
  docsUrl: string;
}

function build(record: FailureRecord, docsUrl: string): FailureDto {
  const guidance = guidanceFor(record);
  return {
    code: record.code,
    category: guidance.category,
    transient: record.transient,
    retryable: guidance.retryable,
    params: record.params,
    technical: record.technical,
    occurredAt: record.occurredAt,
    step: record.step,
    retry: record.retry,
    steps: guidance.steps.map((step) => ({ id: step.id, target: step.target })),
    docsUrl,
  };
}

/** A stored failure record as the client sees it; null when there is none (or it is unusable). */
export function failureDto(
  value: unknown,
  docsUrl: string = config.docsTroubleshootingUrl,
): FailureDto | null {
  const record = parseFailureRecord(value);
  return record ? build(record, docsUrl) : null;
}

/**
 * A cause the API derived itself (a verification reason, a probe result) with
 * the time it belongs to.
 */
export function causeToFailureDto(
  cause: FailureCause,
  occurredAt: Date | string,
  docsUrl: string = config.docsTroubleshootingUrl,
): FailureDto {
  return build(
    {
      v: 1,
      ...cause,
      occurredAt: typeof occurredAt === "string" ? occurredAt : occurredAt.toISOString(),
      step: null,
      retry: null,
    },
    docsUrl,
  );
}

/** How many items failed for one cause (the latest example carries the details). */
export interface FailureGroupDto {
  failure: FailureDto;
  count: number;
}

/**
 * A cause the API derived (a probe, a verification) shaped for storage in a
 * jsonb column next to the legacy text, so it survives reloads and reaches
 * every reader the same way as a worker-written record. Null in, null out.
 */
export function causeToRecord(
  cause: FailureCause | null,
  occurredAt: Date,
): FailureRecordJson | null {
  return cause
    ? (toFailureRecord(cause, { now: occurredAt }) as unknown as FailureRecordJson)
    : null;
}
