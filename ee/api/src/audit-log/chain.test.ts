import { randomUUID } from "node:crypto";
import type { AuditLogEntry } from "@restow/db";
import { describe, expect, it } from "vitest";
import { type AuditPayload, computeChainHash } from "../../../../apps/api/src/lib/audit.js";
import {
  type AnchorRecord,
  ChainWalker,
  entryHashMatches,
  orderTieGroup,
  splitTrailingTieGroup,
  tieGroups,
  utcDay,
  verifyChain,
} from "./chain.js";

const TENANT = "0f1e2d3c-4b5a-4978-8899-aabbccddeeff";

/** Build a correctly hashed chain: one entry per timestamp, in order. */
function chainOf(times: readonly string[], overrides: Partial<AuditPayload> = {}): AuditLogEntry[] {
  const entries: AuditLogEntry[] = [];
  let prevHash: string | null = null;
  times.forEach((time, index) => {
    const payload: AuditPayload = {
      tenantId: TENANT,
      actor: "ops@example.com",
      actorUserId: "user-1",
      action: index % 2 === 0 ? "restore.requested" : "backup.requested",
      target: `mailbox-${index}`,
      targetType: "mailbox",
      onBehalfOf: null,
      ip: "203.0.113.7",
      details: { index },
      ...overrides,
    };
    const createdAt = new Date(time);
    const entry: AuditLogEntry = {
      id: randomUUID(),
      ...payload,
      prevHash,
      chainHash: computeChainHash(prevHash, payload, createdAt),
      createdAt,
    };
    entries.push(entry);
    prevHash = entry.chainHash;
  });
  return entries;
}

/** Re-link and re-hash `entries` from `from` on, as an attacker with DB access could. */
function recomputeFrom(entries: AuditLogEntry[], from: number): AuditLogEntry[] {
  const out = entries.map((entry) => ({ ...entry }));
  for (let index = from; index < out.length; index++) {
    const entry = out[index] as AuditLogEntry;
    const prevHash = index === 0 ? null : (out[index - 1] as AuditLogEntry).chainHash;
    const { id: _id, prevHash: _prev, chainHash: _chain, createdAt, ...payload } = entry;
    entry.prevHash = prevHash;
    entry.chainHash = computeChainHash(prevHash, payload, createdAt);
  }
  return out;
}

/** The anchor the daily writer would store for `day`. */
function anchorFor(entries: readonly AuditLogEntry[], day: string): AnchorRecord {
  const ofDay = entries.filter((entry) => utcDay(entry.createdAt) === day);
  const last = ofDay[ofDay.length - 1];
  if (!last) {
    throw new Error(`no entries on ${day}`);
  }
  return { date: day, lastHash: last.chainHash, count: ofDay.length };
}

const TIMES = [
  "2026-09-20T08:00:00.000Z",
  "2026-09-20T17:30:00.000Z",
  "2026-09-21T09:15:00.000Z",
  "2026-09-21T23:59:59.999Z",
  "2026-09-22T00:00:00.000Z",
  "2026-09-23T11:00:00.000Z",
];

describe("utcDay", () => {
  it("uses the UTC calendar day, independent of the local zone", () => {
    expect(utcDay(new Date("2026-09-21T23:59:59.999Z"))).toBe("2026-09-21");
    expect(utcDay(new Date("2026-09-22T00:30:00.000+02:00"))).toBe("2026-09-21");
  });
});

describe("verifyChain", () => {
  it("reports an empty chain as empty", () => {
    expect(verifyChain([])).toEqual({
      status: "empty",
      verifiedEntries: 0,
      head: null,
      anchorsTotal: 0,
      anchorsVerified: 0,
      latestAnchor: null,
      firstBreak: null,
    });
  });

  it("verifies an intact chain with its anchors", () => {
    const entries = chainOf(TIMES);
    const anchors = ["2026-09-20", "2026-09-21", "2026-09-22"].map((day) =>
      anchorFor(entries, day),
    );
    const result = verifyChain(entries, anchors);
    expect(result).toMatchObject({
      status: "intact",
      verifiedEntries: 6,
      anchorsTotal: 3,
      anchorsVerified: 3,
      latestAnchor: anchors[2],
      firstBreak: null,
    });
    expect(result.head).toEqual({
      hash: entries[5]?.chainHash,
      createdAt: entries[5]?.createdAt,
    });
  });

  it("detects a tampered row: the rewritten field no longer reproduces the hash", () => {
    const entries = chainOf(TIMES);
    const victim = entries[2] as AuditLogEntry;
    const tampered = entries.map((entry) =>
      entry.id === victim.id ? { ...entry, target: "someone-elses-mailbox" } : entry,
    );
    const result = verifyChain(tampered);
    expect(result.status).toBe("broken");
    expect(result.verifiedEntries).toBe(2);
    expect(result.firstBreak).toMatchObject({
      reason: "hash_mismatch",
      position: 3,
      entryId: victim.id,
      storedHash: victim.chainHash,
    });
    expect(
      result.firstBreak?.reason === "hash_mismatch" && result.firstBreak.computedHash,
    ).not.toBe(victim.chainHash);
  });

  it("detects rewritten details and a moved timestamp", () => {
    const entries = chainOf(TIMES);
    const details = entries.map((entry, index) =>
      index === 4 ? { ...entry, details: { index: 4, reason: "added later" } } : entry,
    );
    expect(verifyChain(details).firstBreak).toMatchObject({ reason: "hash_mismatch", position: 5 });

    const moved = entries.map((entry, index) =>
      index === 1 ? { ...entry, createdAt: new Date("2026-09-20T17:30:00.001Z") } : entry,
    );
    expect(verifyChain(moved).firstBreak).toMatchObject({ reason: "hash_mismatch", position: 2 });
  });

  it("detects a deleted row as a broken link at its successor", () => {
    const entries = chainOf(TIMES);
    const withoutThird = entries.filter((_, index) => index !== 2);
    expect(verifyChain(withoutThird).firstBreak).toEqual({
      reason: "link_mismatch",
      position: 3,
      entryId: entries[3]?.id,
      createdAt: entries[3]?.createdAt,
      expectedPrevHash: entries[1]?.chainHash,
      storedPrevHash: entries[2]?.chainHash,
    });
  });

  it("detects a deleted first entry and an inserted foreign entry", () => {
    const entries = chainOf(TIMES);
    expect(verifyChain(entries.slice(1)).firstBreak).toMatchObject({
      reason: "link_mismatch",
      position: 1,
      expectedPrevHash: null,
    });

    const [forged] = chainOf(["2026-09-21T10:00:00.000Z"]);
    expect(verifyChain([...entries, forged as AuditLogEntry]).firstBreak).toMatchObject({
      reason: "link_mismatch",
      position: 4,
      entryId: forged?.id,
    });
  });

  it("catches a recomputed chain only through the anchors", () => {
    const entries = chainOf(TIMES);
    const anchors = ["2026-09-20", "2026-09-21", "2026-09-22"].map((day) =>
      anchorFor(entries, day),
    );
    // Rewrite entry 3 and re-hash everything after it: links and hashes all pass.
    const rewritten = entries.map((entry, index) =>
      index === 2 ? { ...entry, actor: "innocent@example.com" } : entry,
    );
    const forged = recomputeFrom(rewritten, 2);
    expect(verifyChain(forged).status).toBe("intact");

    expect(verifyChain(forged, anchors).firstBreak).toEqual({
      reason: "anchor_mismatch",
      position: 4,
      anchorDate: "2026-09-21",
      anchoredHash: entries[3]?.chainHash,
      anchoredCount: 2,
      chainHash: forged[3]?.chainHash,
      chainCount: 2,
    });
  });

  it("catches a truncated tail through the anchors", () => {
    const entries = chainOf(TIMES);
    const anchors = ["2026-09-20", "2026-09-21", "2026-09-22"].map((day) =>
      anchorFor(entries, day),
    );

    // The last anchored day lost its only entry.
    const withoutLastDay = entries.slice(0, 4);
    const lostDay = verifyChain(withoutLastDay, anchors);
    expect(lostDay.status).toBe("broken");
    expect(lostDay.anchorsVerified).toBe(2);
    expect(lostDay.firstBreak).toEqual({
      reason: "anchor_mismatch",
      position: 4,
      anchorDate: "2026-09-22",
      anchoredHash: entries[4]?.chainHash,
      anchoredCount: 1,
      chainHash: null,
      chainCount: 0,
    });

    // The last entry of an anchored day is gone, the chain simply ends earlier.
    const cutInsideDay = verifyChain(entries.slice(0, 3), anchors);
    expect(cutInsideDay.firstBreak).toMatchObject({
      reason: "anchor_mismatch",
      anchorDate: "2026-09-21",
      anchoredCount: 2,
      chainHash: entries[2]?.chainHash,
      chainCount: 1,
    });

    // Every entry deleted, only the anchors remain.
    expect(verifyChain([], anchors).firstBreak).toMatchObject({
      reason: "anchor_mismatch",
      position: 0,
      anchorDate: "2026-09-20",
      chainCount: 0,
    });
  });

  it("catches a whole day removed between anchored days", () => {
    const entries = chainOf(TIMES);
    const anchors = ["2026-09-20", "2026-09-21", "2026-09-22"].map((day) =>
      anchorFor(entries, day),
    );
    const forged = recomputeFrom(
      entries.filter((entry) => utcDay(entry.createdAt) !== "2026-09-21"),
      2,
    );
    expect(verifyChain(forged, anchors).firstBreak).toMatchObject({
      reason: "anchor_mismatch",
      position: 2,
      anchorDate: "2026-09-21",
      chainHash: null,
      chainCount: 0,
    });
  });

  it("does not require anchors for days that were not sealed yet", () => {
    const entries = chainOf(TIMES);
    const result = verifyChain(entries, [anchorFor(entries, "2026-09-20")]);
    expect(result).toMatchObject({ status: "intact", anchorsVerified: 1, anchorsTotal: 1 });
  });

  it("walks entries that share a millisecond in link order, whatever their ids", () => {
    const same = "2026-09-21T09:15:00.000Z";
    const entries = chainOf([TIMES[0] as string, same, same, same, TIMES[5] as string]);
    // Ids sort opposite to insertion order inside the tie.
    const ids = ["ffffffff", "cccccccc", "aaaaaaaa"];
    const reordered = entries.map((entry, index) =>
      index >= 1 && index <= 3
        ? { ...entry, id: `${ids[index - 1]}-0000-4000-8000-000000000000` }
        : entry,
    );
    expect(verifyChain(reordered)).toMatchObject({ status: "intact", verifiedEntries: 5 });
  });
});

describe("ChainWalker", () => {
  it("stops at the first break and refuses input after finish", () => {
    const entries = chainOf(TIMES);
    const walker = new ChainWalker([]);
    expect(walker.push(entries[0] as AuditLogEntry)).toBe(true);
    expect(walker.push(entries[2] as AuditLogEntry)).toBe(false);
    expect(walker.isBroken).toBe(true);
    expect(walker.push(entries[3] as AuditLogEntry)).toBe(false);
    expect(walker.finish()).toMatchObject({ status: "broken", verifiedEntries: 1 });
    expect(() => walker.push(entries[1] as AuditLogEntry)).toThrow(/after finish/);
  });

  it("accepts anchors in any order", () => {
    const entries = chainOf(TIMES);
    const anchors = ["2026-09-22", "2026-09-20", "2026-09-21"].map((day) =>
      anchorFor(entries, day),
    );
    expect(verifyChain(entries, anchors)).toMatchObject({
      status: "intact",
      anchorsVerified: 3,
      latestAnchor: { date: "2026-09-22" },
    });
  });
});

describe("entryHashMatches", () => {
  it("tells a stored row from a rewritten one", () => {
    const [entry] = chainOf([TIMES[0] as string]);
    expect(entryHashMatches(entry as AuditLogEntry)).toBe(true);
    expect(entryHashMatches({ ...(entry as AuditLogEntry), ip: "198.51.100.1" })).toBe(false);
  });
});

describe("tie handling helpers", () => {
  const at = (iso: string, id: string) => ({ id, createdAt: new Date(iso) });

  it("groups equal timestamps", () => {
    const rows = [
      at("2026-09-21T10:00:00.000Z", "a"),
      at("2026-09-21T10:00:00.000Z", "b"),
      at("2026-09-21T10:00:00.001Z", "c"),
    ];
    expect(tieGroups(rows).map((group) => group.map((row) => row.id))).toEqual([["a", "b"], ["c"]]);
    expect(tieGroups([])).toEqual([]);
  });

  it("holds back the trailing run of a batch", () => {
    const rows = [
      at("2026-09-21T10:00:00.000Z", "a"),
      at("2026-09-21T10:00:00.001Z", "b"),
      at("2026-09-21T10:00:00.001Z", "c"),
    ];
    const split = splitTrailingTieGroup(rows);
    expect(split.settled.map((row) => row.id)).toEqual(["a"]);
    expect(split.trailing.map((row) => row.id)).toEqual(["b", "c"]);
    expect(splitTrailingTieGroup([rows[1], rows[2]]).settled).toEqual([]);
    expect(splitTrailingTieGroup([])).toEqual({ settled: [], trailing: [] });
  });

  it("orders a tie by links and leaves unreachable entries last", () => {
    const first = { prevHash: "p", chainHash: "h1" };
    const second = { prevHash: "h1", chainHash: "h2" };
    const stray = { prevHash: "x", chainHash: "h3" };
    expect(orderTieGroup([stray, second, first], "p")).toEqual([first, second, stray]);
    expect(orderTieGroup([second, first], "unrelated")).toEqual([second, first]);
    expect(orderTieGroup([first], "anything")).toEqual([first]);
  });
});
