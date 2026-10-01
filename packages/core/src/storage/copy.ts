/**
 * Copy targets: mirror a tenant's chunk store from its primary onto a copy,
 * and prove the copy is complete (docs/ARCHITECTURE.md: several
 * targets per tenant, a primary plus copies).
 *
 * New packs, manifests and wrapped keys are written to every target as they are
 * produced (engine/chunkstore.ts, writeToAllTargets). The mirror covers what a
 * copy cannot have received that way: data written before the copy existed,
 * writes that failed on the copy, and damage found later. It copies exactly
 * what a standalone restore needs from a copy (packages/cli):
 *
 *   tenants/<tid>/packs/...                   every pack the chunk index knows
 *   tenants/<tid>/manifests/<snap>.json.zst   every committed manifest on the primary
 *   tenants/<tid>/keys/<version>              every wrapped DEK on the primary
 *
 * In-progress manifest checkpoints (`.partial`) are skipped: they are transient.
 * Deleting on the copy is left to garbage collection, which sweeps every target
 * (verify/gc.ts), so a copy never loses data because of a mirror run.
 *
 * Verification: every object written to the copy is read back and compared by
 * SHA-256 before it counts. A pack is only ever copied when the primary's bytes
 * match the hash recorded when the pack was written, so the mirror never
 * spreads damage from the primary to the copy.
 */
import { sha256 } from "../crypto.js";
import { JobAbortedError } from "../engine/chunkstore.js";
import { keyPrefix, manifestPrefix, packPrefix } from "../engine/layout.js";
import type { Logger, PackRecord, ProgressReporter, StorageTargets } from "../engine/types.js";
import { buildCause, classifyFailure } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";
import { type StorageBackend, isObjectNotFound } from "./backend.js";
import { describeStorageError } from "./factory.js";

/** One object to mirror. Packs carry their recorded size and hash; other objects are compared with the source. */
export interface MirrorItem {
  readonly key: string;
  /** Expected size in bytes, when the index recorded it. */
  readonly size: number | null;
  /** Expected SHA-256 (hex) of the whole object, when the index recorded it. */
  readonly sha256: string | null;
}

/**
 * How objects already on the copy are checked: `size` compares sizes (cheap,
 * catches truncation and missing files), `hash` reads them and compares
 * SHA-256 (a deep verification that costs a full read of the copy).
 */
export type MirrorVerifyMode = "size" | "hash";

export type MirrorItemOutcome =
  /** Already on the copy and passed the check. */
  | "present"
  /** Was missing and has been copied and verified. */
  | "copied"
  /** Was on the copy but failed the check; rewritten and verified. */
  | "repaired"
  /** The primary does not have the object. */
  | "source_missing"
  /** The primary's bytes do not match the recorded size/hash; nothing was copied. */
  | "source_corrupt"
  /** Written to the copy, but the read-back did not match. */
  | "verify_failed"
  /** Reading or writing failed. */
  | "failed";

export interface MirrorItemResult {
  readonly key: string;
  readonly outcome: MirrorItemOutcome;
  /** Bytes written to the copy for this object (0 when nothing was written). */
  readonly bytesWritten: number;
  readonly detail: string | null;
  /** The classified cause of a problem (why, what to do); absent when the object is fine. */
  readonly cause?: FailureCause;
}

export interface MirrorReport {
  readonly total: number;
  readonly present: number;
  readonly copied: number;
  readonly repaired: number;
  readonly failed: number;
  readonly bytesWritten: number;
  /** True when every object is on the copy and verified. */
  readonly complete: boolean;
  /** Objects that did not end up verified on the copy (capped, see `problemsOmitted`). */
  readonly problems: readonly MirrorItemResult[];
  readonly problemsOmitted: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface MirrorOptions {
  readonly source: StorageBackend;
  readonly target: StorageBackend;
  readonly items: readonly MirrorItem[];
  readonly verify?: MirrorVerifyMode;
  /** Objects in flight at once (default 2; packs are up to 64 MiB each). */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** How many failed objects the report lists by name (default 100). */
  readonly maxReportedProblems?: number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_PROBLEMS = 100;

function hashHex(bytes: Buffer): string {
  return sha256(bytes).toString("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobAbortedError();
  }
}

function result(
  key: string,
  outcome: MirrorItemOutcome,
  bytesWritten = 0,
  detail: string | null = null,
  cause?: FailureCause,
): MirrorItemResult {
  return cause
    ? { key, outcome, bytesWritten, detail, cause }
    : { key, outcome, bytesWritten, detail };
}

/** The classified cause of a failed storage call, saying which side of the mirror it was. */
function storageCause(error: unknown, side: "primary" | "copy"): FailureCause {
  const cause = classifyFailure(error, { role: "storage" });
  return { ...cause, params: { ...cause.params, side } };
}

/** A mirror finding where the stored bytes are not what the index recorded. */
function integrityCause(
  reason: "source_missing" | "source_corrupt" | "verify_failed",
): FailureCause {
  return buildCause("storage.integrity", { reason });
}

/** Is the copy's object acceptable as it is? */
async function copyIsIntact(
  options: MirrorOptions,
  item: MirrorItem,
  targetSize: number,
): Promise<boolean> {
  let expectedSize = item.size;
  if (expectedSize === null) {
    const sourceHead = await options.source.head(item.key);
    // Without the source there is nothing to compare against; keep what the copy has.
    expectedSize = sourceHead?.size ?? targetSize;
  }
  if (targetSize !== expectedSize) {
    return false;
  }
  if ((options.verify ?? "size") === "size") {
    return true;
  }
  const expectedHash = item.sha256 ?? hashHex(await options.source.get(item.key));
  return hashHex(await options.target.get(item.key)) === expectedHash;
}

async function readSource(
  options: MirrorOptions,
  item: MirrorItem,
): Promise<{ bytes: Buffer } | { failure: MirrorItemResult }> {
  let bytes: Buffer;
  try {
    bytes = await options.source.get(item.key);
  } catch (error) {
    const exists = await options.source.head(item.key).catch(() => undefined);
    return {
      failure:
        exists === null
          ? result(
              item.key,
              "source_missing",
              0,
              "the primary does not have this object",
              integrityCause("source_missing"),
            )
          : result(
              item.key,
              "failed",
              0,
              `reading the primary: ${describeStorageError(error)}`,
              storageCause(error, "primary"),
            ),
    };
  }
  if (item.size !== null && bytes.length !== item.size) {
    return {
      failure: result(
        item.key,
        "source_corrupt",
        0,
        `the primary holds ${bytes.length} bytes, the index recorded ${item.size}`,
        integrityCause("source_corrupt"),
      ),
    };
  }
  if (item.sha256 !== null && hashHex(bytes) !== item.sha256) {
    return {
      failure: result(
        item.key,
        "source_corrupt",
        0,
        "the primary's SHA-256 differs from the recorded hash",
        integrityCause("source_corrupt"),
      ),
    };
  }
  return { bytes };
}

/** Mirror one object: check the copy, copy from the source when needed, verify by reading back. */
export async function mirrorItem(
  options: MirrorOptions,
  item: MirrorItem,
): Promise<MirrorItemResult> {
  let existing: { size: number } | null;
  try {
    existing = await options.target.head(item.key);
    if (existing && (await copyIsIntact(options, item, existing.size))) {
      return result(item.key, "present");
    }
  } catch (error) {
    return result(
      item.key,
      "failed",
      0,
      `checking the copy: ${describeStorageError(error)}`,
      storageCause(error, "copy"),
    );
  }

  const source = await readSource(options, item);
  if ("failure" in source) {
    return source.failure;
  }
  const expectedHash = hashHex(source.bytes);
  try {
    await options.target.put(item.key, source.bytes);
    const written = await options.target.get(item.key);
    if (hashHex(written) !== expectedHash) {
      return result(
        item.key,
        "verify_failed",
        source.bytes.length,
        "the copy returned different bytes after writing",
        integrityCause("verify_failed"),
      );
    }
  } catch (error) {
    return result(
      item.key,
      "failed",
      0,
      `writing the copy: ${describeStorageError(error)}`,
      storageCause(error, "copy"),
    );
  }
  return result(item.key, existing ? "repaired" : "copied", source.bytes.length);
}

/**
 * Mirror `items` from `source` to `target`. Idempotent and resumable: a rerun
 * finds what the previous run copied and only checks it. Cancellation (the
 * signal) stops between objects and throws JobAbortedError.
 */
export async function mirrorObjects(options: MirrorOptions): Promise<MirrorReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const maxProblems = options.maxReportedProblems ?? DEFAULT_MAX_PROBLEMS;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const counts = { present: 0, copied: 0, repaired: 0, failed: 0, bytesWritten: 0 };
  const problems: MirrorItemResult[] = [];
  let problemsOmitted = 0;
  let next = 0;

  const record = (outcome: MirrorItemResult) => {
    counts.bytesWritten += outcome.bytesWritten;
    switch (outcome.outcome) {
      case "present":
        counts.present++;
        options.progress?.advance(1, 0);
        return;
      case "copied":
        counts.copied++;
        options.progress?.advance(1, outcome.bytesWritten);
        return;
      case "repaired":
        counts.repaired++;
        options.progress?.advance(1, outcome.bytesWritten);
        options.logger?.warn("copy target object repaired", { key: outcome.key });
        return;
      default:
        counts.failed++;
        options.progress?.fail(outcome.key, outcome.detail ?? outcome.outcome, outcome.cause);
        options.logger?.warn("copy target object not mirrored", {
          key: outcome.key,
          outcome: outcome.outcome,
          detail: outcome.detail,
        });
        if (problems.length < maxProblems) {
          problems.push(outcome);
        } else {
          problemsOmitted++;
        }
    }
  };

  const worker = async () => {
    while (next < options.items.length) {
      throwIfAborted(options.signal);
      const item = options.items[next++];
      if (item) {
        record(await mirrorItem(options, item));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, options.items.length) }, worker));
  throwIfAborted(options.signal);

  return {
    total: options.items.length,
    ...counts,
    complete: counts.failed === 0,
    problems,
    problemsOmitted,
    startedAt,
    finishedAt: now().toISOString(),
  };
}

const PARTIAL_MANIFEST_SUFFIX = ".partial";

/** Pack records as mirror items (recorded size and hash), in key order. */
export function packMirrorItems(
  packs: readonly Pick<PackRecord, "path" | "size" | "sha256">[],
): MirrorItem[] {
  return packs
    .map((pack) => ({ key: pack.path, size: pack.size, sha256: pack.sha256 }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Committed manifests and wrapped keys on the primary (no recorded hash; compared with the source). */
export async function metadataMirrorItems(
  tenantId: string,
  source: StorageBackend,
): Promise<MirrorItem[]> {
  const manifests = (await source.list(manifestPrefix(tenantId))).filter(
    (key) => !key.endsWith(PARTIAL_MANIFEST_SUFFIX),
  );
  const keys = await source.list(keyPrefix(tenantId));
  return [...keys, ...manifests].map((key) => ({ key, size: null, sha256: null }));
}

/**
 * A read-only view over several backends, tried in order (docs/STORAGE.md,
 * "Replace the primary": a `move` migration that follows an earlier `keep`
 * needs to read packs the current source never received, only the `previous`
 * target that `keep` left behind). `get`/`head`/`getStream` return the first
 * backend that has the key; `put`/`delete` throw: this view is never a valid
 * write target, exactly like the `previous` rows it is meant to chain in are
 * never written to.
 *
 * `list` merges every backend's listing instead of returning the first
 * non-empty one: a `move` that follows an earlier `keep` must see manifests
 * that exist only on the retired `previous` target even once the current
 * primary already has manifests of its own (a "first non-empty" listing would
 * stop at the primary's and never look further, so those older manifests
 * would never be copied — see `metadataMirrorItems` and `copy.test.ts`, "keep
 * then move"). A key present on more than one backend (a manifest written
 * again after a rotation, say) is only ever listed once.
 */
export function readOnlyFallbackChain(backends: readonly StorageBackend[]): StorageBackend {
  if (backends.length === 0) {
    throw new Error("readOnlyFallbackChain needs at least one backend");
  }
  // When every backend fails, a backend that could not answer outranks one that
  // said "not found": the object may well be on the one that did not answer.
  const worse = (kept: unknown, next: unknown): unknown =>
    kept !== undefined && !isObjectNotFound(kept) ? kept : next;
  return {
    async get(key) {
      let failure: unknown;
      for (const backend of backends) {
        try {
          return await backend.get(key);
        } catch (error) {
          failure = worse(failure, error);
        }
      }
      throw failure;
    },
    async getStream(key) {
      let failure: unknown;
      for (const backend of backends) {
        try {
          return await backend.getStream(key);
        } catch (error) {
          failure = worse(failure, error);
        }
      }
      throw failure;
    },
    async head(key) {
      for (const backend of backends) {
        const result = await backend.head(key).catch(() => null);
        if (result) {
          return result;
        }
      }
      return null;
    },
    async list(prefix) {
      const seen = new Set<string>();
      for (const backend of backends) {
        const keys = await backend.list(prefix).catch(() => [] as string[]);
        for (const key of keys) {
          seen.add(key);
        }
      }
      return [...seen].sort();
    },
    async put() {
      throw new Error("readOnlyFallbackChain is read-only: cannot write to it");
    },
    async delete() {
      throw new Error("readOnlyFallbackChain is read-only: cannot delete from it");
    },
  };
}

/**
 * Wrap a writable `primary` so reads that miss on it fall back to `previous`
 * targets, in order (docs/STORAGE.md, "Replace the primary": a `keep` switch
 * leaves the retired primary attached read-only, so restore, verify and
 * download of a snapshot that still lives only there must still find it).
 * Unlike {@link readOnlyFallbackChain}, `primary` itself stays fully
 * writable: `put` and `delete` go only to it, never to a `previous` target —
 * the same contract `resolveStorageTargets`'s `previous` result documents (it
 * is never folded into `StorageTargets.copies`, which the chunk writer, the
 * copy mirror and garbage collection all write to or delete from). `list`
 * also only ever
 * lists `primary`: every reader that matters here (the chunk reader, the
 * manifest loader, `apps/api/src/features/restore/storage.ts`'s download
 * lookup) addresses objects by key, never by listing a `previous` target, so
 * there is nothing to merge a listing for.
 *
 * With no `previous` targets this returns `primary` itself, unwrapped: the
 * common case (a tenant that never had a "keep" replacement) pays nothing
 * for it.
 */
export function withReadOnlyFallback(
  primary: StorageBackend,
  previous: readonly StorageBackend[],
): StorageBackend {
  if (previous.length === 0) {
    return primary;
  }
  const reads = readOnlyFallbackChain([primary, ...previous]);
  return {
    get: (key) => reads.get(key),
    getStream: (key) => reads.getStream(key),
    head: (key) => reads.head(key),
    list: (prefix) => primary.list(prefix),
    put: (key, data, options) => primary.put(key, data, options),
    delete: (key) => primary.delete(key),
  };
}

// ---------------------------------------------------------------------------
// Exclusive objects: what only a source holds, not a set of other targets
// ---------------------------------------------------------------------------

export interface ExclusiveObjectsCheck {
  /** True when `exclusiveKeys` is non-empty. */
  readonly exclusive: boolean;
  /** Keys present on the source but on none of the other backends (capped, see `problemsOmitted`). */
  readonly exclusiveKeys: readonly string[];
  /** How many further exclusive keys exist beyond `exclusiveKeys`. */
  readonly exclusiveKeysOmitted: number;
}

const DEFAULT_MAX_EXCLUSIVE_KEYS = 20;

/**
 * Objects under `prefix` that `source` holds but none of `others` do (docs/
 * STORAGE.md, "Removing an old location"): a `previous` target left by a
 * "keep" replacement may still be the only copy of packs a snapshot needs, and
 * removing it would make that snapshot unrestorable without warning. Listing
 * only (no reads), like {@link checkCopyCompleteness}: fast enough to run
 * before every removal of a `previous` target.
 *
 * `isLive`, when given, drops source keys it returns false for before the
 * comparison: a key can be physically present on `source` and still be pure
 * garbage nothing would ever need again — an abandoned `.partial` checkpoint,
 * the manifest of a snapshot retention already pruned, a pack no index row
 * references any more. None of that is a reason to call `source` exclusive;
 * without a filter every caller would have to hold the target open forever.
 */
export async function checkSourceExclusiveObjects(options: {
  readonly source: StorageBackend;
  readonly others: readonly StorageBackend[];
  readonly prefix: string;
  readonly maxReportedKeys?: number;
  readonly isLive?: (key: string) => boolean;
}): Promise<ExclusiveObjectsCheck> {
  const listed = await options.source.list(options.prefix);
  const sourceKeys = options.isLive ? listed.filter((key) => options.isLive?.(key)) : listed;
  const maxReported = options.maxReportedKeys ?? DEFAULT_MAX_EXCLUSIVE_KEYS;
  const exclusiveKeys: string[] = [];
  let exclusiveKeysOmitted = 0;
  for (const key of sourceKeys) {
    let foundElsewhere = false;
    for (const other of options.others) {
      if (await other.head(key).catch(() => null)) {
        foundElsewhere = true;
        break;
      }
    }
    if (!foundElsewhere) {
      if (exclusiveKeys.length < maxReported) {
        exclusiveKeys.push(key);
      } else {
        exclusiveKeysOmitted++;
      }
    }
  }
  return {
    exclusive: exclusiveKeys.length > 0 || exclusiveKeysOmitted > 0,
    exclusiveKeys,
    exclusiveKeysOmitted,
  };
}

export interface TenantMirrorOptions {
  readonly tenantId: string;
  /** The tenant's resolved targets; every copy is mirrored from the primary. */
  readonly storage: StorageTargets;
  /** Every pack the chunk index knows for the tenant. */
  readonly packs: readonly Pick<PackRecord, "path" | "size" | "sha256">[];
  readonly verify?: MirrorVerifyMode;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface TenantMirrorReport {
  /** One report per copy, in the order of `storage.copies`. */
  readonly copies: readonly MirrorReport[];
  readonly complete: boolean;
}

/**
 * Mirror a tenant's store onto every copy target. Wrapped keys go first (a
 * copy without keys is useless for a standalone restore), then manifests, then
 * packs.
 */
export async function mirrorTenantStorage(
  options: TenantMirrorOptions,
): Promise<TenantMirrorReport> {
  const { storage, tenantId } = options;
  if (storage.copies.length === 0) {
    return { copies: [], complete: true };
  }
  options.progress?.phase("enumerate");
  const items = [
    ...(await metadataMirrorItems(tenantId, storage.primary)),
    ...packMirrorItems(options.packs),
  ];
  options.progress?.total(items.length * storage.copies.length);
  options.progress?.phase("mirror");

  const copies: MirrorReport[] = [];
  for (const [index, target] of storage.copies.entries()) {
    throwIfAborted(options.signal);
    const report = await mirrorObjects({
      source: storage.primary,
      target,
      items,
      verify: options.verify,
      concurrency: options.concurrency,
      signal: options.signal,
      progress: options.progress,
      logger: options.logger?.child({ copy: index }),
      now: options.now,
    });
    options.logger?.info("copy target mirrored", {
      copy: index,
      total: report.total,
      copied: report.copied,
      repaired: report.repaired,
      failed: report.failed,
      bytesWritten: report.bytesWritten,
    });
    copies.push(report);
  }
  return { copies, complete: copies.every((report) => report.complete) };
}

// ---------------------------------------------------------------------------
// Completeness (fast, listing only)
// ---------------------------------------------------------------------------

export interface CompletenessCount {
  readonly expected: number;
  readonly present: number;
}

export interface CopyCompleteness {
  readonly complete: boolean;
  readonly packs: CompletenessCount & {
    readonly bytesExpected: number;
    readonly bytesMissing: number;
  };
  readonly manifests: CompletenessCount;
  readonly keys: CompletenessCount;
  /** A few missing keys, for the operator (capped). */
  readonly missingSample: readonly string[];
  readonly checkedAt: string;
}

const MISSING_SAMPLE = 10;

/**
 * Does the copy hold everything the primary holds? Compares listings only (no
 * reads), so it is fast enough to answer before a copy is promoted to primary;
 * byte-level verification is the mirror's and the scrub's job.
 */
export async function checkCopyCompleteness(options: {
  readonly tenantId: string;
  readonly source: StorageBackend;
  readonly target: StorageBackend;
  readonly packs: readonly Pick<PackRecord, "path" | "size">[];
  readonly now?: () => Date;
}): Promise<CopyCompleteness> {
  const { tenantId, source, target } = options;
  const [targetPacks, targetManifests, targetKeys, sourceManifests, sourceKeys] = await Promise.all(
    [
      target.list(packPrefix(tenantId)),
      target.list(manifestPrefix(tenantId)),
      target.list(keyPrefix(tenantId)),
      source.list(manifestPrefix(tenantId)),
      source.list(keyPrefix(tenantId)),
    ],
  );
  const onTarget = new Set([...targetPacks, ...targetManifests, ...targetKeys]);
  const missing: string[] = [];
  const count = (expected: readonly string[]): CompletenessCount => {
    let present = 0;
    for (const key of expected) {
      if (onTarget.has(key)) {
        present++;
      } else {
        missing.push(key);
      }
    }
    return { expected: expected.length, present };
  };

  const keys = count(sourceKeys);
  const manifests = count(sourceManifests.filter((key) => !key.endsWith(PARTIAL_MANIFEST_SUFFIX)));
  let bytesExpected = 0;
  let bytesMissing = 0;
  for (const pack of options.packs) {
    bytesExpected += pack.size;
    if (!onTarget.has(pack.path)) {
      bytesMissing += pack.size;
    }
  }
  const packs = count(options.packs.map((pack) => pack.path));

  return {
    complete: missing.length === 0,
    packs: { ...packs, bytesExpected, bytesMissing },
    manifests,
    keys,
    missingSample: missing.slice(0, MISSING_SAMPLE),
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * Every key `target` currently holds across the three prefixes a mirror ever
 * writes (packs, manifests, wrapped keys) for one tenant: a listing only, no
 * reads. Lets a caller that resumes a checkpointed mirror pass tell a
 * genuinely new object — written to the source between two executions,
 * sorting at or below whatever key the checkpoint remembers as done — apart
 * from one an earlier execution actually finished copying and verifying: the
 * checkpoint only ever advances past a key once that key's object is
 * confirmed on `target`, so anything really done is already in this set, and
 * anything still missing from it is a gap the checkpoint must not have
 * skipped.
 */
export async function destinationObjectKeys(
  tenantId: string,
  target: StorageBackend,
): Promise<ReadonlySet<string>> {
  const [packKeys, manifestKeys, wrappedKeys] = await Promise.all([
    target.list(packPrefix(tenantId)),
    target.list(manifestPrefix(tenantId)),
    target.list(keyPrefix(tenantId)),
  ]);
  return new Set([...packKeys, ...manifestKeys, ...wrappedKeys]);
}
