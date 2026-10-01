/**
 * Per-item bookkeeping shared by every restore engine.
 *
 * A {@link RestoreLedger} records what happened to each selected object
 * (restored, skipped, failed), feeds the job's {@link ProgressReporter} as it
 * goes, and turns into the {@link RestoreReport} the worker persists. Nothing
 * is hidden: a skipped duplicate is listed with its reason exactly like a
 * failure is, because the person restoring needs to know both.
 *
 * Every outcome carries a machine-readable {@link RestoreItemCode} next to the
 * English detail, so the UI can explain it in the user's language.
 */
import { JobAbortedError, MissingChunkError, RestoreIntegrityError } from "../engine/chunkstore.js";
import type { ItemFailureRecord, ProgressReporter, RestoreResult } from "../engine/types.js";
import { classifyFailure } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";
import { isGraphError } from "../graph/errors.js";
import type { ManifestObject } from "../manifest.js";
import { objectTypeOf } from "./conventions.js";

export type RestoreItemStatus = "restored" | "skipped" | "failed";

export type RestoreItemCode =
  /** Restored and confirmed by the target, or no confirmation was possible. */
  | "restored"
  /** Restored, but the target's confirmation did not match (see the reason). */
  | "unverified"
  /** The target already holds this item (skip mode, or a retried job found its own work). */
  | "exists"
  /** The backup holds no restorable content for this kind of item. */
  | "not_restorable"
  /** Belongs to a message that was not restored in this run. */
  | "parent_not_restored"
  /** The item does not belong in this kind of target (a file in a mailbox, ...). */
  | "wrong_target"
  /** The snapshot references data the chunk store does not have. */
  | "data_missing"
  /** The restored bytes do not match the snapshot (tampering or corruption). */
  | "integrity"
  /** The target service refused the item. */
  | "target_rejected"
  | "error";

export interface RestoreItemResult {
  readonly path: string;
  /** Source item id (ManifestObject.id) when the manifest has one. */
  readonly id: string | undefined;
  readonly type: string;
  readonly status: RestoreItemStatus;
  readonly code: RestoreItemCode;
  /** Where the item ended up: a Graph id, an IMAP `mailbox:uid`, a ZIP entry name. */
  readonly targetRef: string | undefined;
  readonly bytes: number;
  /** True when the target confirmed the restored item (hash, size or Message-ID match). */
  readonly verified: boolean;
  /** Why an item was skipped or failed, or what to know about a restored one. Never contains secrets. */
  readonly reason: string | undefined;
  /** The classified cause of a failed item (why and what to do); absent for other outcomes. */
  readonly cause?: FailureCause;
  /** The mail's or event's subject from the manifest, so reports can name it instead of its path. */
  readonly subject?: string;
  /** The mail's sender from the manifest. */
  readonly from?: string;
}

/**
 * A {@link RestoreResult} plus the per-item outcomes.
 *
 * Folders are containers, not items: a recreated folder is listed in `items`
 * and counted in `folders`, while `restored` and `skipped` count what the
 * folders hold (messages, events, contacts, files). A folder that could not
 * be created is a failure like any other.
 */
export interface RestoreReport extends RestoreResult {
  readonly items: readonly RestoreItemResult[];
  /** Restored items whose target confirmation did not match (counted in `restored`). */
  readonly unverified: number;
  /** Folders recreated or found in place. */
  readonly folders: number;
}

export interface RestoredItemInput {
  readonly targetRef?: string;
  readonly bytes?: number;
  /** Omit when the target offered no way to confirm; false when the check failed. */
  readonly verified?: boolean;
  /** What went wrong with the confirmation, or what the user should know. */
  readonly note?: string;
}

const MAX_REASON_LENGTH = 500;

/** A human-readable reason from any thrown value, without payloads or tokens. */
export function describeRestoreError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
}

/** Thrown when reconstructed bytes do not match what the snapshot recorded (see the chunk reader). */
export { RestoreIntegrityError };

/** The outcome code of a thrown error. */
export function failureCodeOf(error: unknown): RestoreItemCode {
  if (error instanceof MissingChunkError) {
    return "data_missing";
  }
  if (error instanceof RestoreIntegrityError) {
    return "integrity";
  }
  if (
    error instanceof Error &&
    /(size|hash) mismatch|authenticat|missing from pack/i.test(error.message)
  ) {
    return "integrity";
  }
  if (isGraphError(error) || (error instanceof Error && error.name === "ImapRestoreError")) {
    return "target_rejected";
  }
  return "error";
}

/** Errors that mean "the job was cancelled", which engines never turn into an item failure. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof JobAbortedError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "JobAbortedError"))
  );
}

/** First non-blank value of `keys` in the manifest metadata (the same keys the explorer reads). */
function pickMetadata(object: ManifestObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object.metadata?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/** The human label of an item: subject and sender, when the manifest recorded them. */
function labelOf(object: ManifestObject): Pick<RestoreItemResult, "subject" | "from"> {
  const subject = pickMetadata(object, ["subject"]);
  const from = pickMetadata(object, ["from", "sender", "fromAddress"]);
  return {
    ...(subject === undefined ? {} : { subject }),
    ...(from === undefined ? {} : { from }),
  };
}

export class RestoreLedger {
  private readonly results: RestoreItemResult[] = [];
  private readonly reported = new Set<string>();
  private restoredCount = 0;
  private skippedCount = 0;
  private folderCount = 0;
  private byteCount = 0;
  private unverifiedCount = 0;
  private downloadKey: string | null = null;

  constructor(private readonly progress: ProgressReporter) {}

  private record(
    object: ManifestObject,
    result: Omit<RestoreItemResult, "path" | "id" | "type" | "subject" | "from">,
  ): void {
    this.reported.add(object.path);
    this.results.push({
      path: object.path,
      id: object.id,
      type: object.type ?? "file",
      ...labelOf(object),
      ...result,
    });
  }

  restored(object: ManifestObject, input: RestoredItemInput = {}): void {
    const bytes = input.bytes ?? object.size;
    const unverified = input.verified === false;
    this.record(object, {
      status: "restored",
      code: unverified ? "unverified" : "restored",
      targetRef: input.targetRef,
      bytes,
      verified: input.verified === true,
      reason:
        input.note ?? (unverified ? "the target did not confirm the restored item" : undefined),
    });
    if (objectTypeOf(object) === "folder") {
      this.folderCount++;
    } else {
      this.restoredCount++;
      this.unverifiedCount += unverified ? 1 : 0;
    }
    this.byteCount += bytes;
    this.progress.advance(1, bytes);
  }

  skipped(
    object: ManifestObject,
    code: Exclude<RestoreItemCode, "restored" | "unverified">,
    reason: string,
    targetRef?: string,
  ): void {
    this.record(object, { status: "skipped", code, targetRef, bytes: 0, verified: false, reason });
    if (objectTypeOf(object) !== "folder") {
      this.skippedCount++;
    }
    this.progress.advance(1, 0);
  }

  /**
   * Record a failure from an error; the code is derived from the error unless
   * given. `targetRef` names what the target holds after the failure, when
   * something was written there.
   */
  failed(
    object: ManifestObject,
    error: unknown,
    code: RestoreItemCode = failureCodeOf(error),
    targetRef?: string,
  ): void {
    const reason = describeRestoreError(error);
    const cause = classifyFailure(error);
    this.record(object, {
      status: "failed",
      code,
      targetRef,
      bytes: 0,
      verified: false,
      reason,
      cause,
    });
    this.progress.fail(object.id ?? object.path, reason, cause);
  }

  /**
   * Fail every object of `expected` no engine step reported. A restore must
   * never restore less than asked without saying so.
   */
  settle(expected: readonly ManifestObject[]): void {
    for (const object of expected) {
      if (!this.reported.has(object.path)) {
        this.failed(object, new Error("the item was not processed by the restore"), "error");
      }
    }
  }

  setDownloadKey(key: string): void {
    this.downloadKey = key;
  }

  get items(): readonly RestoreItemResult[] {
    return this.results;
  }

  report(): RestoreReport {
    const failures: ItemFailureRecord[] = this.results
      .filter((item) => item.status === "failed")
      .map((item) => ({
        itemRef: item.id ?? item.path,
        reason: item.reason ?? "failed",
        ...(item.cause ? { cause: item.cause } : {}),
      }));
    return {
      restored: this.restoredCount,
      skipped: this.skippedCount,
      bytes: this.byteCount,
      failures,
      downloadKey: this.downloadKey,
      items: [...this.results],
      unverified: this.unverifiedCount,
      folders: this.folderCount,
    };
  }
}
