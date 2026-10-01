import type { AuditLogEntry } from "@restow/db";
import { computeChainHash, payloadFromEntry } from "../../../../apps/api/src/lib/audit.js";

/**
 * Verification of one audit hash chain (pure, no I/O).
 *
 * The audit log keeps one chain per tenant plus one installation chain
 * (lib/audit.ts). Walking a chain oldest first, every entry must
 *
 *   1. link to its predecessor: `prev_hash` equals the previous `chain_hash`
 *      (null for the first entry) — otherwise an entry was removed, inserted
 *      or reordered;
 *   2. reproduce its own hash from the stored fields — otherwise the row was
 *      rewritten after it was appended.
 *
 * A chain that was cut off at the end, or recomputed wholesale by someone who
 * can write to the database, still passes both checks. The daily anchors in
 * `audit_anchor` catch that: each seals one UTC day of a chain with the
 * day's last `chain_hash` and its entry count, so when the walk leaves a day
 * the chain must still end that day in exactly the sealed state, and an
 * anchor for a day without entries means entries went missing.
 *
 * The walk stops at the first break: everything after it can no longer be
 * vouched for, and the first break is what an operator has to investigate.
 */

/** One daily anchor as stored in `audit_anchor`. */
export interface AnchorRecord {
  /** The UTC calendar day the anchor seals (`YYYY-MM-DD`). */
  readonly date: string;
  /** `chain_hash` of the chain's last entry on that day. */
  readonly lastHash: string;
  /** Number of the chain's entries created on that day. */
  readonly count: number;
}

/** The fields the walk reads from an entry. */
export type ChainEntry = Pick<
  AuditLogEntry,
  | "id"
  | "tenantId"
  | "actor"
  | "actorUserId"
  | "action"
  | "target"
  | "targetType"
  | "onBehalfOf"
  | "ip"
  | "details"
  | "prevHash"
  | "chainHash"
  | "createdAt"
>;

/** Why and where a chain stops being trustworthy. */
export type ChainBreak =
  | {
      reason: "hash_mismatch";
      /** 1-based position of the entry in the chain. */
      position: number;
      entryId: string;
      createdAt: Date;
      storedHash: string;
      computedHash: string;
    }
  | {
      reason: "link_mismatch";
      position: number;
      entryId: string;
      createdAt: Date;
      /** `chain_hash` of the predecessor (null: the entry should start the chain). */
      expectedPrevHash: string | null;
      storedPrevHash: string | null;
    }
  | {
      reason: "anchor_mismatch";
      /** Entries walked when the anchored day ended. */
      position: number;
      anchorDate: string;
      anchoredHash: string;
      anchoredCount: number;
      /** What the chain holds for that day now (null / 0: no entries at all). */
      chainHash: string | null;
      chainCount: number;
    };

export type ChainBreakReason = ChainBreak["reason"];
export type ChainStatus = "intact" | "broken" | "empty";

export interface ChainResult {
  status: ChainStatus;
  /** Entries that passed every check (all of them for an intact chain). */
  verifiedEntries: number;
  /** The newest verified entry. */
  head: { hash: string; createdAt: Date } | null;
  anchorsTotal: number;
  /** Anchors the walk confirmed before it ended. */
  anchorsVerified: number;
  latestAnchor: AnchorRecord | null;
  firstBreak: ChainBreak | null;
}

/** The UTC calendar day of an instant (`YYYY-MM-DD`), the unit anchors seal. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Recompute an entry's hash from its stored fields, as `audit()` computed it. */
export function recomputeEntryHash(entry: ChainEntry): string {
  return computeChainHash(
    entry.prevHash,
    payloadFromEntry(entry as AuditLogEntry),
    entry.createdAt,
  );
}

/** True when the stored `chain_hash` still matches the stored fields. */
export function entryHashMatches(entry: ChainEntry): boolean {
  return recomputeEntryHash(entry) === entry.chainHash;
}

/**
 * Split rows sorted by `created_at` into runs that share a timestamp. Within
 * a run, the database order (by id) says nothing about insertion order.
 */
export function tieGroups<T extends { createdAt: Date }>(rows: readonly T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const row of rows) {
    const previous = current[current.length - 1];
    if (previous && previous.createdAt.getTime() !== row.createdAt.getTime()) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/**
 * Split sorted rows into the part that can be walked now and the trailing run
 * sharing the last timestamp, which may continue in the next batch.
 */
export function splitTrailingTieGroup<T extends { createdAt: Date }>(
  rows: readonly T[],
): { settled: T[]; trailing: T[] } {
  const last = rows[rows.length - 1];
  if (last === undefined) {
    return { settled: [], trailing: [] };
  }
  let start = rows.length - 1;
  while (start > 0 && rows[start - 1]?.createdAt.getTime() === last.createdAt.getTime()) {
    start -= 1;
  }
  return { settled: rows.slice(0, start), trailing: rows.slice(start) };
}

/**
 * Put entries that share a timestamp into chain order by following the links
 * from `expectedPrev`. Entries the links do not reach keep their given order
 * after the linked ones, where the walk then reports the broken link.
 */
export function orderTieGroup<T extends Pick<ChainEntry, "prevHash" | "chainHash">>(
  group: readonly T[],
  expectedPrev: string | null,
): T[] {
  if (group.length < 2) {
    return [...group];
  }
  const remaining = [...group];
  const ordered: T[] = [];
  let cursor = expectedPrev;
  for (;;) {
    const index = remaining.findIndex((entry) => (entry.prevHash ?? null) === cursor);
    const next = index === -1 ? undefined : remaining.splice(index, 1)[0];
    if (next === undefined) {
      break;
    }
    ordered.push(next);
    cursor = next.chainHash;
  }
  return [...ordered, ...remaining];
}

/**
 * Walks one chain entry by entry (oldest first) and checks links, hashes and
 * anchors on the way. Feed it with {@link push} in chain order — use
 * {@link orderTieGroup} for entries sharing a timestamp — then call
 * {@link finish} once.
 */
export class ChainWalker {
  private readonly anchors: readonly AnchorRecord[];
  private expectedPrev: string | null = null;
  private position = 0;
  private day: string | null = null;
  private dayCount = 0;
  private dayHead: string | null = null;
  private nextAnchor = 0;
  private anchorsVerified = 0;
  private head: { hash: string; createdAt: Date } | null = null;
  private broken: ChainBreak | null = null;
  private finished = false;

  constructor(anchors: readonly AnchorRecord[]) {
    this.anchors = [...anchors].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /** The `chain_hash` the next entry must link to. */
  get expectedPrevHash(): string | null {
    return this.expectedPrev;
  }

  get isBroken(): boolean {
    return this.broken !== null;
  }

  /** Check the next entry; false once the chain is broken (stop feeding it). */
  push(entry: ChainEntry): boolean {
    if (this.finished) {
      throw new Error("ChainWalker.push after finish");
    }
    if (this.broken) {
      return false;
    }
    const day = utcDay(entry.createdAt);
    if (day !== this.day) {
      this.settleAnchorsBefore(day);
      if (this.broken) {
        return false;
      }
      this.day = day;
      this.dayCount = 0;
      this.dayHead = null;
    }

    const position = this.position + 1;
    const storedPrev = entry.prevHash ?? null;
    if (storedPrev !== this.expectedPrev) {
      this.broken = {
        reason: "link_mismatch",
        position,
        entryId: entry.id,
        createdAt: entry.createdAt,
        expectedPrevHash: this.expectedPrev,
        storedPrevHash: storedPrev,
      };
      return false;
    }
    const computed = recomputeEntryHash(entry);
    if (computed !== entry.chainHash) {
      this.broken = {
        reason: "hash_mismatch",
        position,
        entryId: entry.id,
        createdAt: entry.createdAt,
        storedHash: entry.chainHash,
        computedHash: computed,
      };
      return false;
    }

    this.position = position;
    this.expectedPrev = entry.chainHash;
    this.dayCount += 1;
    this.dayHead = entry.chainHash;
    this.head = { hash: entry.chainHash, createdAt: entry.createdAt };
    return true;
  }

  /** Settle the remaining anchors and report. */
  finish(): ChainResult {
    if (!this.finished) {
      this.finished = true;
      if (!this.broken) {
        this.settleAnchorsBefore(null);
      }
    }
    const status: ChainStatus = this.broken ? "broken" : this.position === 0 ? "empty" : "intact";
    return {
      status,
      verifiedEntries: this.position,
      head: this.head,
      anchorsTotal: this.anchors.length,
      anchorsVerified: this.anchorsVerified,
      latestAnchor: this.anchors[this.anchors.length - 1] ?? null,
      firstBreak: this.broken,
    };
  }

  /**
   * Compare every anchor dated before `nextDay` (all of them when null) with
   * the walk: the anchor of the day just walked must match its last hash and
   * count; an anchor of any other day claims entries the chain no longer has.
   */
  private settleAnchorsBefore(nextDay: string | null): void {
    while (this.nextAnchor < this.anchors.length) {
      const anchor = this.anchors[this.nextAnchor];
      if (anchor === undefined || (nextDay !== null && anchor.date >= nextDay)) {
        return;
      }
      this.nextAnchor += 1;
      const walked = anchor.date === this.day;
      const chainHash = walked ? this.dayHead : null;
      const chainCount = walked ? this.dayCount : 0;
      if (anchor.lastHash !== chainHash || anchor.count !== chainCount) {
        this.broken = {
          reason: "anchor_mismatch",
          position: this.position,
          anchorDate: anchor.date,
          anchoredHash: anchor.lastHash,
          anchoredCount: anchor.count,
          chainHash,
          chainCount,
        };
        return;
      }
      this.anchorsVerified += 1;
    }
  }
}

/**
 * Feed entries sorted by `created_at` to the walker in chain order, each run
 * of equal timestamps as a whole; false once the walker found a break.
 */
export function pushInChainOrder(walker: ChainWalker, entries: readonly ChainEntry[]): boolean {
  for (const group of tieGroups(entries)) {
    for (const entry of orderTieGroup(group, walker.expectedPrevHash)) {
      if (!walker.push(entry)) {
        return false;
      }
    }
  }
  return true;
}

/** Order entries as the database walk does: by `created_at`, then id. */
export function byCreatedAtThenId(a: ChainEntry, b: ChainEntry): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Verify a whole chain held in memory. */
export function verifyChain(
  entries: readonly ChainEntry[],
  anchors: readonly AnchorRecord[] = [],
): ChainResult {
  const walker = new ChainWalker(anchors);
  pushInChainOrder(walker, [...entries].sort(byCreatedAtThenId));
  return walker.finish();
}
