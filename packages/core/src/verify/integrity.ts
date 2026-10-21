/**
 * Pack integrity (scrub): is every pack still exactly what was written?
 *
 * Each selected pack is read from every storage target (primary and copies)
 * and checked against what Postgres recorded when it was written: the size,
 * the SHA-256 of the whole file, a well-formed pack of this tenant, and an
 * index that still holds every chunk the chunk index says lives there.
 *
 * A target that fails while another holds an intact copy is repaired from
 * that copy (the verified bytes are written back under the same key and read
 * again to confirm). A pack without any intact copy is reported corrupt.
 *
 * A read that breaks off with a transfer error (a connection cut mid-download,
 * a timeout, S3 asking to slow down) proves nothing about the pack: it is read
 * again, whole, up to {@link PACK_READ_ATTEMPTS} times with a pause before
 * each new attempt, and only then reported `unreadable`. Each read streams
 * through the hash into a buffer of the recorded size, so a pack never takes
 * more memory than its catalog size, however much the storage sends.
 */
import { createHash } from "node:crypto";
import { sha256 } from "../crypto.js";
import type { ChunkRecord, StorageTargets } from "../engine/types.js";
import { PackReader } from "../pack.js";
import type { StorageBackend } from "../storage/backend.js";
import { isTransientTransferError, pauseBeforeRetry } from "../storage/transfer.js";
import type { CatalogPack, PackUnreadableState } from "./catalog.js";
import { describeError, isAbortError } from "./errors.js";
import { pickRandom, type RandomSource } from "./random.js";

export type PackTargetStatus =
  | "ok"
  | "missing"
  | "unreadable"
  | "size_mismatch"
  | "hash_mismatch"
  | "malformed"
  | "foreign_tenant"
  | "index_mismatch";

export type PackTargetCheck = {
  /** 0 is the primary target, 1..n the copies in configuration order. */
  target: number;
  status: PackTargetStatus;
  detail: string | null;
  /** The target failed and was rewritten from an intact copy. */
  repaired: boolean;
  /** How often the pack was read from this target, when more than once (transfer errors). */
  attempts?: number;
};

export type PackCheckStatus = "ok" | "repaired" | "corrupt";

export type PackCheck = {
  packId: string;
  path: string;
  size: number;
  status: PackCheckStatus;
  targets: PackTargetCheck[];
};

/**
 * `sample` checks a share of the packs, `full` every pack and collects
 * garbage, `recheck` only the packs an earlier check left damaged or
 * unreadable.
 */
export type ScrubMode = "sample" | "full" | "recheck";

/** A sample scrub checks this share of the packs, but never fewer than the minimum. */
export const SCRUB_SAMPLE_FRACTION = 0.05;
export const SCRUB_SAMPLE_MINIMUM = 16;

/** How many packs a sample scrub checks out of `total`. */
export function sampleSizeFor(total: number): number {
  return Math.min(total, Math.max(SCRUB_SAMPLE_MINIMUM, Math.ceil(total * SCRUB_SAMPLE_FRACTION)));
}

/**
 * The packs a scrub run checks, the flagged ones first: packs a previous scrub
 * found corrupt or unreadable (listed in `alwaysCheck`, marked damaged or
 * unreadable in the catalog) are always re-checked, before anything else, so
 * a report never goes quiet about them just because the sample moved on, and
 * a pack that was only briefly unreachable is cleared as early as possible.
 * A sample adds randomly drawn packs; a full run adds all the others; a
 * recheck checks only the flagged packs.
 */
export function selectPacks(
  packs: readonly CatalogPack[],
  mode: ScrubMode,
  random: RandomSource,
  alwaysCheck: ReadonlySet<string> = new Set(),
): CatalogPack[] {
  const isForced = (pack: CatalogPack) =>
    alwaysCheck.has(pack.path) || Boolean(pack.damagedAt) || Boolean(pack.unreadable);
  const forced = packs.filter(isForced);
  if (mode === "recheck") {
    return forced;
  }
  const rest = packs.filter((pack) => !isForced(pack));
  if (mode === "full") {
    return [...forced, ...rest];
  }
  const drawn = pickRandom(rest, Math.max(0, sampleSizeFor(packs.length) - forced.length), random);
  return [...forced, ...drawn];
}

/** Check the bytes of one pack copy against its catalog record. */
export function inspectPackBytes(
  bytes: Buffer,
  pack: CatalogPack,
  tenantId: string,
  chunks: readonly ChunkRecord[],
  /** Size and SHA-256 measured while the bytes streamed in (they may exceed `bytes`). */
  measured?: { size: number; sha256: string },
): { status: PackTargetStatus; detail: string | null } {
  const size = measured?.size ?? bytes.length;
  if (size !== pack.size) {
    return {
      status: "size_mismatch",
      detail: `expected ${pack.size} bytes, found ${size}`,
    };
  }
  if ((measured?.sha256 ?? sha256(bytes).toString("hex")) !== pack.sha256) {
    return { status: "hash_mismatch", detail: "SHA-256 of the file differs from the record" };
  }
  let reader: PackReader;
  try {
    reader = PackReader.open(bytes, { verify: true });
  } catch (error) {
    return { status: "malformed", detail: describeError(error) };
  }
  if (reader.tenantId !== tenantId) {
    return { status: "foreign_tenant", detail: "the pack header names a different tenant" };
  }
  const entries = new Map(reader.entries().map((entry) => [entry.storedId.toString("hex"), entry]));
  const misplaced = chunks.filter((chunk) => {
    const entry = entries.get(chunk.storedId);
    return !entry || entry.offset !== chunk.offset || entry.length !== chunk.length;
  });
  if (misplaced.length > 0) {
    return {
      status: "index_mismatch",
      detail: `${misplaced.length} of ${chunks.length} indexed chunks are absent from the pack or at another position`,
    };
  }
  return { status: "ok", detail: null };
}

type TargetRead = { check: PackTargetCheck; bytes: Buffer | null };

/** Reads of one pack per target: the first and two more after transfer errors. */
export const PACK_READ_ATTEMPTS = 3;
/** Pauses before the second and the third read. */
export const PACK_READ_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

export type PackReadRetry = {
  /** Reads in all (default {@link PACK_READ_ATTEMPTS}). */
  readonly attempts?: number;
  /** Pause before each further read (default {@link PACK_READ_RETRY_DELAYS_MS}). */
  readonly delaysMs?: readonly number[];
};

/**
 * Stream one pack file from `backend`, hashing as it goes. At most
 * `expectedSize` bytes are kept; anything beyond is hashed and counted only,
 * so the size check can name what was found without holding it.
 */
export async function readPackObject(
  backend: StorageBackend,
  key: string,
  expectedSize: number,
): Promise<{ bytes: Buffer; size: number; sha256: string }> {
  const stream = await backend.getStream(key);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(expectedSize);
  let size = 0;
  try {
    for await (const piece of stream) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
      hash.update(chunk);
      if (size < expectedSize) {
        chunk.copy(buffer, size, 0, Math.min(chunk.length, expectedSize - size));
      }
      size += chunk.length;
    }
  } finally {
    stream.destroy();
  }
  return {
    bytes: size >= expectedSize ? buffer : buffer.subarray(0, size),
    size,
    sha256: hash.digest("hex"),
  };
}

const retried = (attempts: number): { attempts?: number } => (attempts > 1 ? { attempts } : {});

async function readTarget(
  backend: StorageBackend,
  target: number,
  pack: CatalogPack,
  tenantId: string,
  chunks: readonly ChunkRecord[],
  options: PackCheckOptions,
): Promise<TargetRead> {
  const attempts = Math.max(1, options.retry?.attempts ?? PACK_READ_ATTEMPTS);
  const delays = options.retry?.delaysMs ?? PACK_READ_RETRY_DELAYS_MS;
  let read: { bytes: Buffer; size: number; sha256: string } | null = null;
  let attempt = 0;
  while (read === null) {
    attempt += 1;
    try {
      if ((await backend.head(pack.path)) === null) {
        return {
          check: {
            target,
            status: "missing",
            detail: "the file does not exist",
            repaired: false,
            ...retried(attempt),
          },
          bytes: null,
        };
      }
      read = await readPackObject(backend, pack.path, pack.size);
    } catch (error) {
      if (isAbortError(error) && options.signal?.aborted) {
        throw error;
      }
      if (attempt < attempts && isTransientTransferError(error)) {
        await pauseBeforeRetry(
          delays[attempt - 1] ?? delays[delays.length - 1] ?? 0,
          options.signal,
        );
        continue;
      }
      const reason = describeError(error);
      return {
        check: {
          target,
          status: "unreadable",
          detail: attempt > 1 ? `${reason} (${attempt} attempts)` : reason,
          repaired: false,
          ...retried(attempt),
        },
        bytes: null,
      };
    }
  }
  const { status, detail } = inspectPackBytes(read.bytes, pack, tenantId, chunks, read);
  return {
    check: { target, status, detail, repaired: false, ...retried(attempt) },
    bytes: status === "ok" ? read.bytes : null,
  };
}

/** Rewrite a failed target from intact bytes and confirm by reading it back. */
async function repairTarget(
  backend: StorageBackend,
  pack: CatalogPack,
  intact: Buffer,
  check: PackTargetCheck,
): Promise<PackTargetCheck> {
  try {
    await backend.put(pack.path, intact);
    const written = await backend.get(pack.path);
    if (sha256(written).toString("hex") === pack.sha256) {
      return { ...check, repaired: true };
    }
    return { ...check, detail: `${check.detail ?? check.status}; repair did not persist` };
  } catch (error) {
    return {
      ...check,
      detail: `${check.detail ?? check.status}; repair failed: ${describeError(error)}`,
    };
  }
}

/**
 * Whether a corrupt pack is proven damaged, as opposed to unreachable: no
 * target failed with an I/O error. Only proven damage is marked in the
 * catalog, where it stops deduplication against the pack's chunks; a pack
 * that could not be read is "temporarily unreadable" (see
 * {@link isPersistentlyUnreadable}).
 */
export function isProvenDamage(check: PackCheck): boolean {
  return (
    check.status === "corrupt" && check.targets.every((target) => target.status !== "unreadable")
  );
}

export type PackCheckOptions = {
  /** Rewrite failed targets from an intact copy (default true). */
  readonly repair?: boolean;
  /** Reading again after transfer errors. */
  readonly retry?: PackReadRetry;
  /** Cancels a pause between two reads. */
  readonly signal?: AbortSignal;
};

/** A corrupt pack that is not proven damaged: at least one target could not be read. */
export function isUnreadable(check: PackCheck): boolean {
  return check.status === "corrupt" && !isProvenDamage(check);
}

/** Consecutive checks a pack must fail to read before it counts like damage. */
export const UNREADABLE_CHECKS_LIMIT = 3;
/** ... and the time those checks must span at least. */
export const UNREADABLE_MIN_SPAN_MS = 24 * 3_600_000;

/**
 * Whether a pack that could not be read counts like damage for the rating of
 * the objects using it: unreadable in {@link UNREADABLE_CHECKS_LIMIT}
 * consecutive checks spread over at least {@link UNREADABLE_MIN_SPAN_MS}.
 * Before that it is a reason for attention only: one broken download, or a
 * storage that was briefly unreachable, proves nothing about the data.
 */
export function isPersistentlyUnreadable(
  state: Pick<PackUnreadableState, "since" | "lastAt" | "checks"> | null | undefined,
): boolean {
  return Boolean(
    state &&
      state.checks >= UNREADABLE_CHECKS_LIMIT &&
      state.lastAt.getTime() - state.since.getTime() >= UNREADABLE_MIN_SPAN_MS,
  );
}

/** Check one pack on every target and repair what can be repaired. */
export async function checkPack(
  storage: StorageTargets,
  tenantId: string,
  pack: CatalogPack,
  chunks: readonly ChunkRecord[],
  options: PackCheckOptions = {},
): Promise<PackCheck> {
  const backends: readonly StorageBackend[] = [storage.primary, ...storage.copies];
  const reads: TargetRead[] = [];
  for (const [target, backend] of backends.entries()) {
    reads.push(await readTarget(backend, target, pack, tenantId, chunks, options));
  }
  const intact = reads.find((read) => read.bytes !== null)?.bytes ?? null;
  const targets: PackTargetCheck[] = [];
  for (const [target, read] of reads.entries()) {
    const repairable = read.check.status !== "ok" && read.check.status !== "index_mismatch";
    targets.push(
      intact && repairable && options.repair !== false
        ? await repairTarget(backends[target], pack, intact, read.check)
        : read.check,
    );
  }
  const failing = targets.filter((check) => check.status !== "ok");
  const status: PackCheckStatus =
    failing.length === 0 ? "ok" : failing.every((check) => check.repaired) ? "repaired" : "corrupt";
  return { packId: pack.id, path: pack.path, size: pack.size, status, targets };
}
