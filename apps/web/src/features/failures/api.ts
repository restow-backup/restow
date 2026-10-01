/**
 * The shapes of a classified failure as the API sends them (apps/api/src/
 * features/failures/dto.ts, mirrored here like every feature's DTOs). Every
 * place that shows a failure receives this same shape: a failed job, a failed
 * item, a broken source, a sync run, a login test, a red verification.
 */

export type FailureParamValue = string | number | boolean | null;

/** A place in the UI a step sends the operator to. */
export type FailureTarget =
  | "settings_microsoft"
  | "sources"
  | "source"
  | "directory"
  | "storage"
  | "verify"
  | "jobs";

export interface FailureStep {
  /** Key under `failures:steps.<id>`. */
  id: string;
  target: FailureTarget | string | null;
}

export interface FailureRetry {
  /** The attempt that failed (1 = first run). */
  attempt: number;
  limit: number;
  /** When the next attempt starts, roughly; null when unknown. */
  nextAttemptAt: string | null;
}

export interface Failure {
  /** Stable machine code, e.g. `graph.consent_missing`. Codes of newer servers stay strings. */
  code: string;
  category: string | null;
  /** Waiting alone may help; the run is retried automatically. */
  transient: boolean;
  /** A manual retry makes sense once the cause is fixed. */
  retryable: boolean;
  params: Record<string, FailureParamValue>;
  /** Redacted details for a support case. */
  technical: Record<string, string | number>;
  occurredAt: string;
  step: string | null;
  retry: FailureRetry | null;
  steps: FailureStep[];
  /** The troubleshooting page (configured on the server, never hard-coded here). */
  docsUrl: string;
}

/** How many failed items share one cause code. */
export interface ItemCauseCount {
  code: string;
  count: number;
}

/** Failed items grouped by cause, with the latest example's full explanation. */
export interface FailureGroup {
  failure: Failure;
  count: number;
}
