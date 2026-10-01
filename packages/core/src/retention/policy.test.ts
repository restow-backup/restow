import { describe, expect, it } from "vitest";
import { type RetentionPolicyRow, parseSnapshotPolicy, policyAppliesTo } from "./policy.js";
import { DEFAULT_TIERS } from "./tiers.js";

const row = (overrides: Partial<RetentionPolicyRow>): RetentionPolicyRow => ({
  id: "p1",
  name: "Policy",
  isDefault: false,
  appliesTo: { target: "snapshots", preset: "default" },
  ...overrides,
});

describe("parseSnapshotPolicy", () => {
  it("ignores rows for another target", () => {
    expect(parseSnapshotPolicy(row({ appliesTo: null }))).toBeNull();
    expect(parseSnapshotPolicy(row({ appliesTo: { target: "archive" } }))).toBeNull();
  });

  it("resolves a built-in preset to its tiers", () => {
    expect(parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", preset: "90d" } }))).toEqual(
      {
        policyId: "p1",
        tiers: [{ fromDays: 0, toDays: 90, keepEveryDays: 0 }],
        protectedObjectIds: null,
        isDefault: false,
      },
    );
    expect(parseSnapshotPolicy(row({}))?.tiers).toEqual(DEFAULT_TIERS);
  });

  it("reads a custom policy's own tiers, and rejects one without a usable list", () => {
    const tiers = [{ fromDays: 0, toDays: null, keepEveryDays: 3 }];
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", preset: "custom", tiers } })),
    ).toMatchObject({ tiers });
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", preset: "custom" } })),
    ).toBeNull();
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", preset: "custom", tiers: [] } })),
    ).toBeNull();
  });

  it("reads a row saved before presets existed as a flat cutoff", () => {
    // Its own keepDays, no preset at all.
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", keepDays: 90, keepLast: 3 } })),
    ).toMatchObject({ tiers: [{ fromDays: 0, toDays: 90, keepEveryDays: 0 }] });
    // Older still: only the plain years column, no keepDays either.
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots" }, years: 2 })),
    ).toMatchObject({ tiers: [{ fromDays: 0, toDays: 730, keepEveryDays: 0 }] });
    // Neither keepDays nor years: never expires by age.
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots" }, years: null })),
    ).toMatchObject({ tiers: [{ fromDays: 0, toDays: null, keepEveryDays: 0 }] });
  });

  it("carries a legacy row's own keepLast, but never for a preset-based policy", () => {
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", keepDays: 90, keepLast: 3 } })),
    ).toMatchObject({ keepLast: 3 });
    // Older still: years column plus its own keepLast.
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", keepLast: 5 }, years: 1 })),
    ).toMatchObject({ keepLast: 5 });
    // No keepLast at all on the legacy row: the tiered rule's own guard applies.
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", keepDays: 90 } }))?.keepLast,
    ).toBeUndefined();
    // A preset-based policy never carries keepLast, even if the JSON somehow had one.
    expect(
      parseSnapshotPolicy(row({ appliesTo: { target: "snapshots", preset: "30d", keepLast: 9 } }))
        ?.keepLast,
    ).toBeUndefined();
  });

  it("reads the object scope, dropping non-string entries", () => {
    expect(
      parseSnapshotPolicy(
        row({
          appliesTo: { target: "snapshots", preset: "30d", protectedObjectIds: ["a", 7, "b"] },
        }),
      )?.protectedObjectIds,
    ).toEqual(["a", "b"]);
    expect(parseSnapshotPolicy(row({}))?.protectedObjectIds).toBeNull();
  });
});

describe("policyAppliesTo", () => {
  it("writes a built-in preset without its tiers (they are looked up fresh on read)", () => {
    expect(policyAppliesTo("default", DEFAULT_TIERS, null)).toEqual({
      target: "snapshots",
      preset: "default",
    });
  });

  it("writes a custom preset's own tiers and a non-empty object scope", () => {
    const tiers = [{ fromDays: 0, toDays: null, keepEveryDays: 1 }];
    expect(policyAppliesTo("custom", tiers, ["a", "b"])).toEqual({
      target: "snapshots",
      preset: "custom",
      tiers,
      protectedObjectIds: ["a", "b"],
    });
    expect(policyAppliesTo("keep_all", [], [])).toEqual({
      target: "snapshots",
      preset: "keep_all",
    });
  });
});
