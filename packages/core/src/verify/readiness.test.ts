import { describe, expect, it } from "vitest";
import { assessReadiness, isEmptyFinding, type ReadinessFacts } from "./readiness.js";

const NOW = new Date("2026-10-01T01:00:00Z");

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    snapshotCompletedAt: new Date("2026-10-01T00:00:00Z"),
    hasSnapshot: true,
    manifestReadable: true,
    checked: 0,
    contentBytes: 0,
    contentObjects: 0,
    itemCount: 9,
    outcomes: { verified: 0, mismatch: 0, missing: 0, unreadable: 0 },
    damagedPacks: 0,
    testRestore: null,
    now: NOW,
    ...overrides,
  };
}

describe("assessReadiness: empty objects", () => {
  it("calls a snapshot without content and without anything read back empty", () => {
    expect(assessReadiness(facts())).toEqual({
      readiness: "yellow",
      reasons: [{ code: "snapshot_empty", severity: "yellow", count: 9 }],
    });
  });

  it("counts the content objects when the item count is unknown", () => {
    const { itemCount: _unknown, ...rest } = facts({ contentObjects: 2 });
    expect(assessReadiness(rest).reasons).toEqual([
      { code: "snapshot_empty", severity: "yellow", count: 2 },
    ]);
  });

  it("keeps nothing_to_verify, with the bytes, for content no check can read back", () => {
    expect(assessReadiness(facts({ contentBytes: 4096, contentObjects: 3 }))).toEqual({
      readiness: "yellow",
      reasons: [{ code: "nothing_to_verify", severity: "yellow", bytes: 4096 }],
    });
  });

  it("says neither once something was read back", () => {
    const rated = assessReadiness(
      facts({
        checked: 1,
        contentBytes: 3800,
        contentObjects: 1,
        outcomes: { verified: 1, mismatch: 0, missing: 0, unreadable: 0 },
      }),
    );
    expect(rated).toEqual({ readiness: "green", reasons: [] });
  });

  it("says nothing about content when the manifest could not be read", () => {
    const codes = assessReadiness(facts({ manifestReadable: false })).reasons.map((r) => r.code);
    expect(codes).toEqual(["manifest_unreadable"]);
  });
});

describe("isEmptyFinding", () => {
  it("holds only for a rating that rests on the empty reason alone", () => {
    expect(isEmptyFinding([{ code: "snapshot_empty" }])).toBe(true);
    expect(isEmptyFinding([])).toBe(false);
    expect(isEmptyFinding([{ code: "snapshot_empty" }, { code: "snapshot_stale" }])).toBe(false);
    expect(isEmptyFinding([{ code: "nothing_to_verify" }])).toBe(false);
  });
});
