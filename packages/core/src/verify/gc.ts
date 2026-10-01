/**
 * Garbage collection of unreferenced chunks (docs/ARCHITECTURE.md: copy
 * the referenced chunks into new packs, then delete the old packs; never
 * in place).
 *
 * A pack with enough unreferenced chunks is re-packed: its surviving sealed
 * chunks are copied, byte for byte and still encrypted, into a new pack; the
 * new pack is written to every target first, then the catalog swaps the rows
 * atomically, and only then is the old file retired (kept for a grace period,
 * then deleted; see the last paragraph). A crash at any point
 * leaves either the old or the new pack authoritative, never neither; the
 * unrecorded leftover is an orphan file, removed later by the orphan sweep
 * once it is older than a grace period.
 *
 * A backup references its chunks only when it commits, so everything a
 * running backup wrote or deduplicated against looks unreferenced until then.
 * What may be collected is therefore decided conservatively:
 *   - collection yields to every job that writes or reads the tenant's packs:
 *     it does not start, and stops between two packs, while `blockedBy`
 *     reports a running backup, restore or verify of the tenant
 *   - refcount 0, and the row last changed before `cutoff` (a grace period
 *     after the last reference was released)
 *   - not referenced by a checkpointed, uncommitted snapshot (partial
 *     manifests in storage), which a backup waiting for its retry resumes from.
 *     A checkpoint nothing can resume any more (its row is gone or committed,
 *     or its job ended for good; the caller decides) is deleted instead: it
 *     neither keeps its chunks nor, when unreadable, blocks collection
 *   - and the catalog re-checks "still unreferenced" inside the swap
 *     transaction; a chunk that gained a reference meanwhile cancels the swap
 * A replacement pack is read back from every target and compared with its
 * SHA-256 before the swap, so an old pack is only ever deleted once an
 * intact successor exists everywhere. Damaged packs are never re-packed.
 *
 * Readers look up a chunk's pack in the catalog and open the file a moment
 * later. A restore or verify that starts while a pack is being swapped can
 * therefore hold the old location for a short while. The swapped-out
 * ("superseded") file is kept for a grace period instead of being deleted on
 * the spot: it has no catalog row any more, its path is handed back to the
 * caller in {@link GcSummary.superseded}, and a later run deletes it with
 * {@link releaseSupersededPacks} once the grace period is over. The pack file
 * itself is untouched, so the storage format does not change; until then the
 * orphan sweep leaves it alone (see {@link sweepOrphanPacks}).
 */
import { randomUUID } from "node:crypto";
import { sha256 } from "../crypto.js";
import { readFromAnyTargetAs, writeToAllTargets } from "../engine/chunkstore.js";
import { deleteOnAllTargets } from "../engine/discard.js";
import { manifestPrefix, packKey, packPrefix, parseManifestKey } from "../engine/layout.js";
import { noopLogger } from "../engine/logger.js";
import { loadManifest } from "../engine/snapshot.js";
import type {
  ChunkRecord,
  Logger,
  PackRecord,
  StorageTargets,
  TenantKeyring,
} from "../engine/types.js";
import { PackReader, PackWriter } from "../pack.js";
import type { StorageBackend } from "../storage/backend.js";
import type { CatalogChunk, CatalogPack, PackCatalog } from "./catalog.js";
import { describeError, isAbortError, throwIfAborted } from "./errors.js";

/** Re-pack once at least this share of a pack's sealed bytes is unreferenced. */
export const DEFAULT_MIN_DEAD_FRACTION = 0.1;

/** Orphaned pack files younger than this are left alone (a writer may still record them). */
export const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Superseded pack files stay this long after their swap, so a reader that
 * looked the old location up just before the swap can still open it.
 */
export const DEFAULT_SUPERSEDED_GRACE_MS = 24 * 60 * 60 * 1000;

export type ScrubEnvironment = {
  readonly tenantId: string;
  readonly storage: StorageTargets;
  /** Opens the sealed checkpoints of snapshots in progress. */
  readonly keys: Pick<TenantKeyring, "open">;
  readonly catalog: PackCatalog;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly now: () => Date;
};

/**
 * Why collection must not run right now: a job of the tenant is writing packs
 * (a backup or archive sync commits its references only at the end) or
 * reading them (a restore or verify job resolves chunk locations as it goes).
 */
export type GcBlocker = "backup_running" | "restore_running" | "verify_running";

export const GC_BLOCKERS: readonly GcBlocker[] = [
  "backup_running",
  "restore_running",
  "verify_running",
];

export function isGcBlocker(value: unknown): value is GcBlocker {
  return typeof value === "string" && (GC_BLOCKERS as readonly string[]).includes(value);
}

export type GcOptions = {
  /** Only chunks whose row last changed before this are collected. */
  readonly cutoff: Date;
  /** Chunk ids that must survive whatever their refcount says. */
  readonly keep: ReadonlySet<string>;
  /** Asked before every pack; a blocker stops collection until the next run. */
  readonly blockedBy?: () => Promise<GcBlocker | null>;
  /** Packs never touched (damaged ones are left as evidence for the operator). */
  readonly exclude?: ReadonlySet<string>;
  readonly minDeadFraction?: number;
  readonly packIdGenerator?: () => string;
  /**
   * How long a swapped-out pack file is kept (default
   * {@link DEFAULT_SUPERSEDED_GRACE_MS}). 0 deletes it right after the swap.
   */
  readonly supersededGraceMs?: number;
};

export type GcSkippedPack = { path: string; reason: string };

/** A pack file that lost its catalog row to a re-pack and waits out its grace period. */
export type SupersededPack = {
  readonly path: string;
  readonly size: number;
  /** ISO 8601 time of the swap. */
  readonly supersededAt: string;
};

export type GcSummary = {
  packsExamined: number;
  packsRewritten: number;
  packsRemoved: number;
  chunksDropped: number;
  /**
   * Bytes the catalog no longer accounts for. Files kept for their grace
   * period ({@link superseded}) still occupy storage until a later run
   * deletes them.
   */
  bytesReclaimed: number;
  /** Swaps cancelled because a chunk gained a reference in the meantime. */
  conflicts: number;
  skipped: GcSkippedPack[];
  /** Old pack files swapped out by this run and kept for the grace period. */
  superseded: SupersededPack[];
  /** Set when collection stopped early to make way for a running job. */
  interruptedBy: GcBlocker | null;
};

/**
 * Whether a checkpointed snapshot can never be resumed any more: its row is
 * gone or committed, or the job that wrote it ended for good. Only the host
 * can tell (it owns the snapshot and job rows). Answer false when unsure.
 */
export type AbandonedCheckpointProbe = (snapshotId: string) => Promise<boolean>;

export type PartialManifestScanOptions = {
  /**
   * Checkpoints this probe calls abandoned are deleted from every target
   * instead of being read. Without it every checkpoint counts as resumable.
   */
  readonly abandoned?: AbandonedCheckpointProbe;
  readonly logger?: Logger;
};

export type HeldChunks = {
  /** Chunk ids named by checkpoints a retry may still resume. */
  ids: Set<string>;
  /** Resumable checkpoints that could not be read; collection must not run. */
  unreadable: string[];
  /** Abandoned checkpoints deleted by this scan (storage keys). */
  discarded: string[];
};

/**
 * Chunk ids referenced by checkpointed snapshots that have not been committed
 * yet. A checkpoint the probe calls abandoned is deleted rather than read: it
 * would otherwise keep its chunks forever and, if unreadable (for example
 * truncated by an interrupted write), block collection for the tenant.
 */
export async function chunksHeldByPartialManifests(
  storage: StorageTargets,
  tenantId: string,
  keys: Pick<TenantKeyring, "open">,
  options: PartialManifestScanOptions = {},
): Promise<HeldChunks> {
  const ids = new Set<string>();
  const unreadable: string[] = [];
  const discarded: string[] = [];
  const logger = options.logger ?? noopLogger;
  const partials = (await storage.primary.list(manifestPrefix(tenantId))).filter((key) =>
    key.endsWith(".partial"),
  );
  for (const key of partials) {
    const named = parseManifestKey(key);
    if (named?.partial && options.abandoned && (await options.abandoned(named.snapshotId))) {
      if (await deleteOnAllTargets(storage, key, logger)) {
        discarded.push(key);
      }
      continue;
    }
    try {
      const manifest = await loadManifest(storage, key, keys);
      for (const object of manifest.objects) {
        for (const id of object.chunks) {
          ids.add(id);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      unreadable.push(key);
    }
  }
  if (discarded.length > 0) {
    logger.info("abandoned checkpoints removed", { count: discarded.length });
  }
  return { ids, unreadable, discarded };
}

export type RepackPlan = {
  readonly live: CatalogChunk[];
  readonly dead: CatalogChunk[];
  /** Share of the chunks' sealed bytes that is unreferenced. */
  readonly deadFraction: number;
};

/** Split a pack's chunks into survivors and collectable ones. */
export function planRepack(
  chunks: readonly CatalogChunk[],
  cutoff: Date,
  keep: ReadonlySet<string>,
): RepackPlan {
  const live: CatalogChunk[] = [];
  const dead: CatalogChunk[] = [];
  for (const chunk of chunks) {
    const collectable =
      chunk.refcount === 0 && chunk.updatedAt < cutoff && !keep.has(chunk.storedId);
    (collectable ? dead : live).push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const deadBytes = dead.reduce((sum, chunk) => sum + chunk.length, 0);
  return { live, dead, deadFraction: total === 0 ? 0 : deadBytes / total };
}

/** Build the replacement pack from the surviving sealed chunks of `source`. */
export function buildReplacement(
  tenantId: string,
  source: PackReader,
  live: readonly CatalogChunk[],
  packId: string,
): { record: PackRecord; bytes: Buffer; moved: ChunkRecord[] } {
  const writer = new PackWriter(tenantId);
  const moved: ChunkRecord[] = [];
  for (const chunk of [...live].sort((a, b) => a.offset - b.offset)) {
    const id = Buffer.from(chunk.storedId, "hex");
    const sealed = source.get(id);
    if (!sealed) {
      throw new Error(`chunk ${chunk.storedId} is not in the pack it is indexed in`);
    }
    const entry = writer.append(id, sealed);
    moved.push({ storedId: chunk.storedId, offset: entry.offset, length: entry.length });
  }
  const bytes = writer.finalize();
  const path = packKey(tenantId, packId);
  return {
    record: { id: packId, path, sha256: sha256(bytes).toString("hex"), size: bytes.length },
    bytes,
    moved,
  };
}

async function deleteEverywhere(
  storage: StorageTargets,
  key: string,
  logger: Logger,
): Promise<void> {
  const targets: readonly StorageBackend[] = [storage.primary, ...storage.copies];
  for (const target of targets) {
    try {
      await target.delete(key);
    } catch (error) {
      // Left behind as an orphan; the next sweep removes it.
      logger.warn("could not delete pack file", { key, error: describeError(error) });
    }
  }
}

/** Read a freshly written pack back from every target and compare its SHA-256. */
async function confirmOnAllTargets(storage: StorageTargets, record: PackRecord): Promise<void> {
  const targets: readonly StorageBackend[] = [storage.primary, ...storage.copies];
  for (const [index, target] of targets.entries()) {
    const written = await target.get(record.path);
    if (sha256(written).toString("hex") !== record.sha256) {
      throw new Error(`the copy on target ${index} differs from what was written`);
    }
  }
}

async function repackOne(
  env: ScrubEnvironment,
  pack: CatalogPack,
  plan: RepackPlan,
  newPackId: () => string,
  supersededGraceMs: number,
  summary: GcSummary,
): Promise<void> {
  let source: PackReader;
  try {
    // A copy that does not verify is passed over for the next target.
    source = await readFromAnyTargetAs(env.storage, pack.path, (bytes) =>
      PackReader.open(bytes, { verify: true }),
    );
  } catch (error) {
    // Never copy out of a pack that does not verify; the integrity check reports it.
    summary.skipped.push({ path: pack.path, reason: `unreadable: ${describeError(error)}` });
    return;
  }

  const replacement =
    plan.live.length > 0 ? buildReplacement(env.tenantId, source, plan.live, newPackId()) : null;
  if (replacement) {
    try {
      await writeToAllTargets(env.storage, replacement.record.path, replacement.bytes);
      await confirmOnAllTargets(env.storage, replacement.record);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // The old pack stays authoritative; a replacement that cannot be read
      // back intact from every target is withdrawn.
      await deleteEverywhere(env.storage, replacement.record.path, env.logger);
      summary.skipped.push({
        path: pack.path,
        reason: `replacement not confirmed: ${describeError(error)}`,
      });
      return;
    }
  }
  const swapped = await env.catalog.replacePack({
    oldPack: pack,
    newPack: replacement?.record ?? null,
    moved: replacement?.moved ?? [],
    dropped: plan.dead.map((chunk) => chunk.storedId),
  });
  if (!swapped) {
    summary.conflicts++;
    if (replacement) {
      await deleteEverywhere(env.storage, replacement.record.path, env.logger);
    }
    return;
  }
  if (supersededGraceMs > 0) {
    // A reader may have looked this location up just before the swap.
    summary.superseded.push({
      path: pack.path,
      size: pack.size,
      supersededAt: env.now().toISOString(),
    });
  } else {
    await deleteEverywhere(env.storage, pack.path, env.logger);
  }
  summary.chunksDropped += plan.dead.length;
  summary.bytesReclaimed += pack.size - (replacement?.record.size ?? 0);
  if (replacement) {
    summary.packsRewritten++;
  } else {
    summary.packsRemoved++;
  }
}

/** Re-pack every pack whose unreferenced share reached the threshold. */
export async function collectGarbage(
  env: ScrubEnvironment,
  options: GcOptions,
): Promise<GcSummary> {
  const summary: GcSummary = {
    packsExamined: 0,
    packsRewritten: 0,
    packsRemoved: 0,
    chunksDropped: 0,
    bytesReclaimed: 0,
    conflicts: 0,
    skipped: [],
    superseded: [],
    interruptedBy: null,
  };
  const threshold = options.minDeadFraction ?? DEFAULT_MIN_DEAD_FRACTION;
  const newPackId = options.packIdGenerator ?? randomUUID;
  const supersededGraceMs = Math.max(0, options.supersededGraceMs ?? DEFAULT_SUPERSEDED_GRACE_MS);
  for (const pack of await env.catalog.collectablePacks(options.cutoff)) {
    throwIfAborted(env.signal);
    if (options.exclude?.has(pack.path)) {
      summary.skipped.push({ path: pack.path, reason: "damaged pack left untouched" });
      continue;
    }
    summary.packsExamined++;
    const plan = planRepack(await env.catalog.chunksOf(pack.id), options.cutoff, options.keep);
    if (plan.dead.length === 0 || (plan.live.length > 0 && plan.deadFraction < threshold)) {
      continue;
    }
    const blocker = (await options.blockedBy?.()) ?? null;
    if (blocker) {
      summary.interruptedBy = blocker;
      break;
    }
    try {
      await repackOne(env, pack, plan, newPackId, supersededGraceMs, summary);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      summary.skipped.push({ path: pack.path, reason: describeError(error) });
    }
  }
  env.logger.info("garbage collection finished", {
    ...summary,
    skipped: summary.skipped.length,
    superseded: summary.superseded.length,
  });
  return summary;
}

export type SupersededRelease = {
  /** Files deleted because their grace period is over. */
  released: number;
  releasedBytes: number;
  /** Files still inside their grace period; a later run deletes them. */
  pending: SupersededPack[];
};

/**
 * Delete superseded pack files whose grace period is over, on every target.
 * The caller only calls this while no job of the tenant reads or writes
 * packs. A path the catalog knows again is never deleted (it cannot happen
 * with generated pack ids, but a live pack must never go), and an entry
 * without a valid time counts as expired.
 */
export async function releaseSupersededPacks(
  env: ScrubEnvironment,
  superseded: readonly SupersededPack[],
  graceMs: number = DEFAULT_SUPERSEDED_GRACE_MS,
): Promise<SupersededRelease> {
  const result: SupersededRelease = { released: 0, releasedBytes: 0, pending: [] };
  if (superseded.length === 0) {
    return result;
  }
  const live = new Set((await env.catalog.listPacks()).map((pack) => pack.path));
  const now = env.now().getTime();
  const seen = new Set<string>();
  for (const pack of superseded) {
    throwIfAborted(env.signal);
    if (seen.has(pack.path) || live.has(pack.path)) {
      continue;
    }
    seen.add(pack.path);
    const age = now - Date.parse(pack.supersededAt);
    if (age < graceMs) {
      result.pending.push(pack);
      continue;
    }
    await deleteEverywhere(env.storage, pack.path, env.logger);
    result.released++;
    result.releasedBytes += pack.size;
  }
  if (result.released > 0) {
    env.logger.info("superseded pack files removed", {
      released: result.released,
      bytes: result.releasedBytes,
      pending: result.pending.length,
    });
  }
  return result;
}

export type OrphanSweep = {
  removed: number;
  bytes: number;
  /** Unrecorded files kept because they are recent, carry no timestamp, or wait out a grace period. */
  kept: number;
};

/**
 * Delete pack files that no catalog row points to, on every target. Only files
 * older than the grace period go: a pack is written before it is recorded.
 * `retained` are superseded packs still inside their own grace period; their
 * file time is the time they were written, not swapped out, so they are
 * skipped by path.
 */
export async function sweepOrphanPacks(
  env: ScrubEnvironment,
  graceMs: number = DEFAULT_ORPHAN_GRACE_MS,
  retained: ReadonlySet<string> = new Set(),
): Promise<OrphanSweep> {
  const known = new Set((await env.catalog.listPacks()).map((pack) => pack.path));
  const sweep: OrphanSweep = { removed: 0, bytes: 0, kept: 0 };
  const now = env.now().getTime();
  const targets: readonly StorageBackend[] = [env.storage.primary, ...env.storage.copies];
  for (const target of targets) {
    for (const key of await target.list(packPrefix(env.tenantId))) {
      throwIfAborted(env.signal);
      if (known.has(key)) {
        continue;
      }
      if (retained.has(key)) {
        sweep.kept++;
        continue;
      }
      const head = await target.head(key);
      const modified = head?.lastModified?.getTime();
      if (!head || modified === undefined || now - modified < graceMs) {
        sweep.kept++;
        continue;
      }
      await target.delete(key);
      sweep.removed++;
      sweep.bytes += head.size;
    }
  }
  if (sweep.removed > 0) {
    env.logger.info("orphaned pack files removed", { ...sweep });
  }
  return sweep;
}
