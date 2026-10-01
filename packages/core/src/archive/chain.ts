/**
 * The pure math behind the archive's per-tenant hash chain (docs/ARCHIVE.md,
 * the storage section): `chainHash = SHA-256(prevChainHash || itemHash || receivedAt)`.
 * Mirrors audit-chain.ts (canonical JSON is not needed here since an entry's
 * hashed payload is already just two fixed strings and a timestamp), so the
 * two chains stay independent but use the same conventions.
 *
 * Storage (Postgres, the advisory lock, the insert) is the receiver's job
 * (ARCHIVE-JOURNAL); this module only computes hashes and verifies them.
 */
import { createHash } from "node:crypto";

/** Empty predecessor hash for the first item of a tenant's chain. */
const GENESIS_PREV_HASH = "";

/** One entry of a tenant's archive chain, as needed to verify or extend it. */
export interface ArchiveChainEntry {
  /** SHA-256 (hex) of the archived original. */
  readonly itemHash: string;
  readonly receivedAt: Date;
  /** The chain hash this entry claims (computed at write time, or read back from storage). */
  readonly chainHash: string;
}

/** Compute the chain hash of the next entry from its predecessor's chain hash. */
export function computeArchiveChainHash(
  prevChainHash: string | null,
  itemHash: string,
  receivedAt: Date,
): string {
  return createHash("sha256")
    .update(prevChainHash ?? GENESIS_PREV_HASH, "utf8")
    .update(itemHash, "utf8")
    .update(receivedAt.toISOString(), "utf8")
    .digest("hex");
}

export interface ChainBreak {
  /** Index into the entries array where the chain first stops verifying. */
  readonly index: number;
  readonly expectedChainHash: string;
  readonly actualChainHash: string;
}

export interface ChainVerificationResult {
  readonly ok: boolean;
  /** The first break, or null when every entry verified. */
  readonly brokenAt: ChainBreak | null;
}

/**
 * Walk a tenant's chain in the given order, recomputing each entry's chain
 * hash from its predecessor and comparing it to the stored value. Any of the
 * three failure modes the archive must detect shows up as a mismatch at a
 * specific index, which is what makes this one check catch all three:
 *
 * - Tampering: an entry's stored `itemHash` (or `chainHash`) was changed —
 *   the recomputed hash no longer matches the entry's own stored hash.
 * - Deletion: an entry is missing from the sequence — the next surviving
 *   entry's stored `chainHash` was computed against a predecessor that is no
 *   longer there, so recomputing against the entry that is now its neighbour
 *   does not match.
 * - Reordering: two entries were swapped — the same reasoning applies at the
 *   first swapped position.
 *
 * `genesisPrevChainHash` lets a caller verify a suffix of a longer chain by
 * passing the last known-good chain hash before `entries[0]`; omit it (or
 * pass `null`) to verify from the start of the chain.
 */
export function verifyChain(
  entries: readonly ArchiveChainEntry[],
  genesisPrevChainHash: string | null = null,
): ChainVerificationResult {
  let prev = genesisPrevChainHash;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as ArchiveChainEntry;
    const expected = computeArchiveChainHash(prev, entry.itemHash, entry.receivedAt);
    if (expected !== entry.chainHash) {
      return {
        ok: false,
        brokenAt: { index, expectedChainHash: expected, actualChainHash: entry.chainHash },
      };
    }
    prev = entry.chainHash;
  }
  return { ok: true, brokenAt: null };
}

/**
 * A daily anchor: the chain hash and cumulative item count as of the last
 * item captured on a given UTC calendar day. Anchors are the archive's
 * defence against deletion at the very end of a chain, where nothing is left
 * to break internally (docs/ARCHITECTURE.md, the tenant model section:
 * `archive_anchor` rows are append-only for both database roles).
 */
export interface DailyAnchor {
  /** UTC calendar day the anchor covers, `YYYY-MM-DD`. */
  readonly date: string;
  readonly chainHash: string;
  /** Cumulative number of chain entries through this anchor, from genesis. */
  readonly itemCount: number;
}

/** The UTC calendar day (`YYYY-MM-DD`) a timestamp falls on. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the anchor for one UTC day from a tenant's full chain, in chain
 * order from genesis. Returns null when no entry was received on that day
 * (there is nothing new to anchor).
 */
export function buildDailyAnchor(
  date: string,
  chain: readonly ArchiveChainEntry[],
): DailyAnchor | null {
  let lastIndexOfDay = -1;
  for (let index = 0; index < chain.length; index++) {
    if (utcDateKey((chain[index] as ArchiveChainEntry).receivedAt) === date) {
      lastIndexOfDay = index;
    }
  }
  if (lastIndexOfDay === -1) {
    return null;
  }
  return {
    date,
    chainHash: (chain[lastIndexOfDay] as ArchiveChainEntry).chainHash,
    itemCount: lastIndexOfDay + 1,
  };
}

/**
 * Whether a chain still agrees with a previously recorded anchor: the chain
 * must have at least `anchor.itemCount` entries, and the entry at that
 * position must carry exactly `anchor.chainHash`. Catches items deleted from
 * the end of the chain, which an internal {@link verifyChain} walk alone
 * cannot: nothing there breaks against its predecessor, there is simply
 * nothing left.
 */
export function verifyAnchor(anchor: DailyAnchor, chain: readonly ArchiveChainEntry[]): boolean {
  const entry = chain[anchor.itemCount - 1];
  return entry !== undefined && entry.chainHash === anchor.chainHash;
}
