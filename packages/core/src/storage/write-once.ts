/**
 * Write-once (WORM) storage (docs/STORAGE.md, "Write-once storage"): a target that takes new
 * objects but refuses to delete, overwrite or rename existing ones. An NFS share of a NAS with
 * a WORM or retention lock answers EPERM ("Operation not permitted"), a read-only mount EROFS,
 * an S3 bucket whose policy denies deletions AccessDenied, a bucket whose default retention
 * locks every object an Object Lock refusal.
 *
 * The probe of a target ({@link probeStorageBackend} in factory.ts) finds it out: after writing,
 * reading and listing its probe object it overwrites the object and deletes it. A refusal of
 * either is recorded with the probe (`storage_targets.config.lastProbe.writeOnce`, and for the
 * installation default `settings.default_storage_write_once`), and every part of Restow that
 * would otherwise delete or move something on such a target reads it:
 *
 *   - restic repositories that must begin a new chain go to a fresh prefix instead of moving
 *     the old one aside (endpoints/repository-prefix.ts);
 *   - retention is not applied (no restore point is pruned, no `restic forget`, no prune),
 *     and the interface says so;
 *   - restic lock files stay: restic and Restow read them as stale by their age.
 *
 * Restores, checks and new backups work as everywhere: they only read and add.
 */
import { isDeleteRefused, isObjectLocked } from "./backend.js";

/** What the storage refused when the probe overwrote and deleted its probe object. */
export type WriteOnceRefusal = "overwrite" | "delete";

/** The write-once finding of one probe of a target. */
export interface WriteOnceFinding {
  /** True when the storage refused to overwrite or delete an object it holds. */
  readonly writeOnce: boolean;
  /** What it refused (empty when it is not write-once). */
  readonly refused: readonly WriteOnceRefusal[];
  /**
   * How it refused: the file system code (`EPERM`, `EACCES`, `EROFS`), `AccessDenied` (S3),
   * `object_lock` (S3 Object Lock), or `ignored` (an overwrite that was accepted, but the object
   * kept its old content). Null when nothing was refused.
   */
  readonly code: string | null;
  /** When the probe ran (ISO 8601). */
  readonly checkedAt: string;
}

/** The code of a refusal (see {@link WriteOnceFinding.code}), or null when `error` is none. */
export function writeRefusalCode(error: unknown): string | null {
  if (isObjectLocked(error)) {
    return "object_lock";
  }
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const shape = current as {
      code?: unknown;
      Code?: unknown;
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    if (isDeleteRefused(current) && typeof shape.code === "string") {
      return shape.code;
    }
    if (
      shape.name === "AccessDenied" ||
      shape.Code === "AccessDenied" ||
      shape.$metadata?.httpStatusCode === 403
    ) {
      return "AccessDenied";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Whether `error` says the storage refuses to delete, overwrite or rename for good: a write-once
 * share (EPERM, EACCES), a read-only mount (EROFS), an S3 bucket that denies it, or Object Lock.
 */
export function isWriteRefused(error: unknown): boolean {
  return writeRefusalCode(error) !== null;
}

/** A finding of a target that is not write-once. */
export function notWriteOnce(at: Date): WriteOnceFinding {
  return { writeOnce: false, refused: [], code: null, checkedAt: at.toISOString() };
}

/** Whether a stored finding (any JSON) says write-once. */
export function isWriteOnceFinding(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { writeOnce?: unknown }).writeOnce === true
  );
}

/**
 * The write-once finding recorded with a `storage_targets` row (`config.lastProbe.writeOnce`),
 * or null when its last probe did not get that far (or the row was never probed since 0.5.0).
 */
export function writeOnceOfConfig(config: unknown): WriteOnceFinding | null {
  const probe = (config as { lastProbe?: { writeOnce?: unknown } } | null)?.lastProbe;
  const finding = probe?.writeOnce;
  if (typeof finding !== "object" || finding === null) {
    return null;
  }
  const shape = finding as Partial<WriteOnceFinding>;
  if (typeof shape.writeOnce !== "boolean" || typeof shape.checkedAt !== "string") {
    return null;
  }
  return {
    writeOnce: shape.writeOnce,
    refused: Array.isArray(shape.refused)
      ? shape.refused.filter((item): item is WriteOnceRefusal =>
          ["overwrite", "delete"].includes(item as string),
        )
      : [],
    code: typeof shape.code === "string" ? shape.code : null,
    checkedAt: shape.checkedAt,
  };
}
