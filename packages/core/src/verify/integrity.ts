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
 */
import { sha256 } from "../crypto.js";
import type { ChunkRecord, StorageTargets } from "../engine/types.js";
import { PackReader } from "../pack.js";
import type { StorageBackend } from "../storage/backend.js";
import type { CatalogPack } from "./catalog.js";
import { describeError } from "./errors.js";
import { type RandomSource, pickRandom } from "./random.js";

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
};

export type PackCheckStatus = "ok" | "repaired" | "corrupt";

export type PackCheck = {
  packId: string;
  path: string;
  size: number;
  status: PackCheckStatus;
  targets: PackTargetCheck[];
};

export type ScrubMode = "sample" | "full";

/** A sample scrub checks this share of the packs, but never fewer than the minimum. */
export const SCRUB_SAMPLE_FRACTION = 0.05;
export const SCRUB_SAMPLE_MINIMUM = 16;

/** How many packs a sample scrub checks out of `total`. */
export function sampleSizeFor(total: number): number {
  return Math.min(total, Math.max(SCRUB_SAMPLE_MINIMUM, Math.ceil(total * SCRUB_SAMPLE_FRACTION)));
}

/**
 * The packs a scrub run checks: all of them, or a random sample. Packs a
 * previous scrub found corrupt (listed in `alwaysCheck`, or marked damaged in
 * the catalog) are always re-checked, so a report never goes quiet about
 * damage just because the sample moved on.
 */
export function selectPacks(
  packs: readonly CatalogPack[],
  mode: ScrubMode,
  random: RandomSource,
  alwaysCheck: ReadonlySet<string> = new Set(),
): CatalogPack[] {
  if (mode === "full") {
    return [...packs];
  }
  const isForced = (pack: CatalogPack) => alwaysCheck.has(pack.path) || Boolean(pack.damagedAt);
  const forced = packs.filter(isForced);
  const rest = packs.filter((pack) => !isForced(pack));
  const drawn = pickRandom(rest, Math.max(0, sampleSizeFor(packs.length) - forced.length), random);
  return [...forced, ...drawn];
}

/** Check the bytes of one pack copy against its catalog record. */
export function inspectPackBytes(
  bytes: Buffer,
  pack: CatalogPack,
  tenantId: string,
  chunks: readonly ChunkRecord[],
): { status: PackTargetStatus; detail: string | null } {
  if (bytes.length !== pack.size) {
    return {
      status: "size_mismatch",
      detail: `expected ${pack.size} bytes, found ${bytes.length}`,
    };
  }
  if (sha256(bytes).toString("hex") !== pack.sha256) {
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

async function readTarget(
  backend: StorageBackend,
  target: number,
  pack: CatalogPack,
  tenantId: string,
  chunks: readonly ChunkRecord[],
): Promise<TargetRead> {
  let bytes: Buffer;
  try {
    if ((await backend.head(pack.path)) === null) {
      return {
        check: { target, status: "missing", detail: "the file does not exist", repaired: false },
        bytes: null,
      };
    }
    bytes = await backend.get(pack.path);
  } catch (error) {
    return {
      check: { target, status: "unreadable", detail: describeError(error), repaired: false },
      bytes: null,
    };
  }
  const { status, detail } = inspectPackBytes(bytes, pack, tenantId, chunks);
  return {
    check: { target, status, detail, repaired: false },
    bytes: status === "ok" ? bytes : null,
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
 * catalog, where it stops deduplication against the pack's chunks.
 */
export function isProvenDamage(check: PackCheck): boolean {
  return (
    check.status === "corrupt" && check.targets.every((target) => target.status !== "unreadable")
  );
}

export type PackCheckOptions = {
  /** Rewrite failed targets from an intact copy (default true). */
  readonly repair?: boolean;
};

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
    reads.push(await readTarget(backend, target, pack, tenantId, chunks));
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
