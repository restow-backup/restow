import { JobAbortedError } from "../engine/chunkstore.js";
import { FailureError } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";

const MAX_REASON_LENGTH = 300;

/** Cancellation or shutdown: never recorded as a finding, always rethrown. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof JobAbortedError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "JobAbortedError"))
  );
}

/** A short diagnostic from any thrown value. Messages name keys and ids, never content. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}…` : message;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new JobAbortedError();
  }
}

/**
 * A restore check that could not complete: the data could not be read back
 * (or the test restore could not reach its target) for a reason that proves
 * nothing about the backup, and nothing else in the run is evidence of damage.
 * It rates nothing: no report, no notification, the last check stays as it
 * was. The worker retries it with the queue's backoff. `failure` is the cause
 * (storage unreachable, rate limited, ...), always transient.
 */
export class VerifyIncompleteError extends FailureError {
  constructor(
    readonly detail: string,
    cause: FailureCause,
    options: { cause?: unknown } = {},
  ) {
    const known = cause.code !== "unknown";
    super(
      `the restore check could not complete and will be retried: ${detail}`,
      {
        code: known ? cause.code : "verify.incomplete",
        params: known ? cause.params : {},
        technical: cause.technical,
        transient: true,
      },
      options,
    );
    this.name = "VerifyIncompleteError";
  }
}
