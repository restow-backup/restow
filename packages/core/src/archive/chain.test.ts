import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ArchiveChainEntry,
  buildDailyAnchor,
  computeArchiveChainHash,
  utcDateKey,
  verifyAnchor,
  verifyChain,
} from "./chain.js";

function itemHashOf(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** Build a valid chain of `n` entries, one per day starting 2026-01-01 UTC. */
function buildValidChain(n: number): ArchiveChainEntry[] {
  const entries: ArchiveChainEntry[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const itemHash = itemHashOf(`item-${i}`);
    const receivedAt = new Date(Date.UTC(2026, 0, i + 1, 12, 0, 0));
    const chainHash = computeArchiveChainHash(prev, itemHash, receivedAt);
    entries.push({ itemHash, receivedAt, chainHash });
    prev = chainHash;
  }
  return entries;
}

describe("computeArchiveChainHash", () => {
  it("is deterministic and depends on every input", () => {
    const receivedAt = new Date("2026-03-01T10:15:00.000Z");
    const a = computeArchiveChainHash(null, itemHashOf("x"), receivedAt);
    const b = computeArchiveChainHash(null, itemHashOf("x"), receivedAt);
    expect(a).toBe(b);

    const differentPrev = computeArchiveChainHash("somehash", itemHashOf("x"), receivedAt);
    const differentItem = computeArchiveChainHash(null, itemHashOf("y"), receivedAt);
    const differentTime = computeArchiveChainHash(
      null,
      itemHashOf("x"),
      new Date("2026-03-01T10:15:01.000Z"),
    );
    expect(differentPrev).not.toBe(a);
    expect(differentItem).not.toBe(a);
    expect(differentTime).not.toBe(a);
  });
});

describe("verifyChain", () => {
  it("verifies a correctly built chain", () => {
    const chain = buildValidChain(5);
    expect(verifyChain(chain)).toEqual({ ok: true, brokenAt: null, deleted: 0 });
  });

  it("verifies an empty chain", () => {
    expect(verifyChain([])).toEqual({ ok: true, brokenAt: null, deleted: 0 });
  });

  it("detects a tampered item at the position it was tampered", () => {
    const chain = buildValidChain(5);
    const tampered = chain.map((entry, index) =>
      index === 2 ? { ...entry, itemHash: itemHashOf("tampered-content") } : entry,
    );
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(2);
  });

  it("detects a deleted item at the position right after the gap", () => {
    const chain = buildValidChain(5);
    const withDeletion = [...chain.slice(0, 2), ...chain.slice(3)]; // entry at index 2 removed
    const result = verifyChain(withDeletion);
    expect(result.ok).toBe(false);
    // Index 2 in the shortened array is the entry that used to be at index 3,
    // whose stored chainHash was computed against the now-missing entry.
    expect(result.brokenAt?.index).toBe(2);
  });

  it("accepts items deleted after their retention where a tombstone keeps the link", () => {
    const chain = buildValidChain(6);
    // A deleted prefix (0, 1) and an item deleted mid-chain (4), next to a held one (3).
    const withTombstones = chain.map((entry, index) =>
      index === 0 || index === 1 || index === 4 ? { ...entry, deleted: true } : entry,
    );
    expect(verifyChain(withTombstones)).toEqual({ ok: true, brokenAt: null, deleted: 3 });
    // Anchors keep their positions: an anchor sealed before the deletions still agrees.
    const anchor = buildDailyAnchor(utcDateKey((chain[4] as ArchiveChainEntry).receivedAt), chain);
    expect(anchor && verifyAnchor(anchor, withTombstones)).toBe(true);
  });

  it("still detects a row removed without a tombstone, also next to tombstones", () => {
    const chain = buildValidChain(6);
    const tombstoned = chain.map((entry, index) =>
      index < 2 ? { ...entry, deleted: true } : entry,
    );
    const gap = [...tombstoned.slice(0, 3), ...tombstoned.slice(4)];
    const result = verifyChain(gap);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(3);
    // A forged tombstone (another hash) breaks just like a changed item.
    const forged = tombstoned.map((entry, index) =>
      index === 1 ? { ...entry, itemHash: itemHashOf("forged") } : entry,
    );
    expect(verifyChain(forged).brokenAt?.index).toBe(1);
  });

  it("detects two reordered items at the first position the swap affects", () => {
    const chain = buildValidChain(5);
    const reordered = [
      chain[0] as ArchiveChainEntry,
      chain[2] as ArchiveChainEntry,
      chain[1] as ArchiveChainEntry,
      chain[3] as ArchiveChainEntry,
      chain[4] as ArchiveChainEntry,
    ];
    const result = verifyChain(reordered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(1);
  });

  it("verifies a suffix against a known-good genesis hash", () => {
    const chain = buildValidChain(5);
    const suffix = chain.slice(2);
    const result = verifyChain(suffix, (chain[1] as ArchiveChainEntry).chainHash);
    expect(result).toEqual({ ok: true, brokenAt: null, deleted: 0 });
  });
});

describe("daily anchors", () => {
  it("builds an anchor from the last entry of a UTC day and nothing else", () => {
    // Three entries on 2026-01-01, one on 2026-01-02.
    let prev: string | null = null;
    const entries: ArchiveChainEntry[] = [];
    const times = [
      Date.UTC(2026, 0, 1, 1),
      Date.UTC(2026, 0, 1, 12),
      Date.UTC(2026, 0, 1, 23, 59),
      Date.UTC(2026, 0, 2, 0, 1),
    ];
    for (const [i, ms] of times.entries()) {
      const itemHash = itemHashOf(`day-item-${i}`);
      const receivedAt = new Date(ms);
      const chainHash = computeArchiveChainHash(prev, itemHash, receivedAt);
      entries.push({ itemHash, receivedAt, chainHash });
      prev = chainHash;
    }

    const anchor = buildDailyAnchor("2026-01-01", entries);
    expect(anchor).not.toBeNull();
    expect(anchor?.itemCount).toBe(3);
    expect(anchor?.chainHash).toBe((entries[2] as ArchiveChainEntry).chainHash);
    expect(verifyAnchor(anchor as NonNullable<typeof anchor>, entries)).toBe(true);
  });

  it("returns null for a day with no captured items", () => {
    const entries = buildValidChain(2); // 2026-01-01, 2026-01-02
    expect(buildDailyAnchor("2026-06-15", entries)).toBeNull();
  });

  it("catches items deleted off the end of the chain, which an internal walk alone cannot", () => {
    const chain = buildValidChain(4);
    const anchor = buildDailyAnchor(utcDateKey((chain[3] as ArchiveChainEntry).receivedAt), chain);
    expect(anchor).not.toBeNull();
    expect(verifyAnchor(anchor as NonNullable<typeof anchor>, chain)).toBe(true);

    // The last item is deleted; the remaining chain is still internally
    // consistent (nothing downstream references the deleted item), but the
    // anchor now disagrees.
    const truncated = chain.slice(0, 3);
    expect(verifyChain(truncated).ok).toBe(true);
    expect(verifyAnchor(anchor as NonNullable<typeof anchor>, truncated)).toBe(false);
  });
});
