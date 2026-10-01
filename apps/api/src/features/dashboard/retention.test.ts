import { describe, expect, it } from "vitest";
import { type RetentionPolicyRow, snapshotPolicyOf, summarizeRetention } from "./retention.js";

const row = (overrides: Partial<RetentionPolicyRow>): RetentionPolicyRow => ({
  name: "Policy",
  years: null,
  isDefault: false,
  appliesTo: { target: "snapshots", preset: "default" },
  ...overrides,
});

describe("snapshot retention as the dashboard reads it", () => {
  it("keeps everything without a snapshot policy", () => {
    expect(summarizeRetention([])).toEqual({ policy: null, scopedPolicies: 0 });
    // Archive policies govern the archive, not backups.
    expect(summarizeRetention([row({ appliesTo: { target: "archive" }, years: 10 })])).toEqual({
      policy: null,
      scopedPolicies: 0,
    });
    expect(summarizeRetention([row({ appliesTo: null, years: 10 })]).policy).toBeNull();
  });

  it("reads a built-in preset's cutoff and keeps at least the newest restore point", () => {
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots", preset: "90d" } })),
    ).toMatchObject({ keepDays: 90, keepLast: 1 });
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots", preset: "default" } })),
    ).toMatchObject({ keepDays: 365, keepLast: 1 });
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots", preset: "keep_all" } })),
    ).toMatchObject({ keepDays: null, keepLast: 1 });
  });

  it("reads a custom policy's own tiers, taking the last tier's cutoff", () => {
    const tiers = [
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: 60, keepEveryDays: 7 },
    ];
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots", preset: "custom", tiers } })),
    ).toMatchObject({ keepDays: 60 });
    expect(
      snapshotPolicyOf(
        row({
          appliesTo: {
            target: "snapshots",
            preset: "custom",
            tiers: [{ fromDays: 0, toDays: null, keepEveryDays: 3 }],
          },
        }),
      ),
    ).toMatchObject({ keepDays: null });
    // Unreadable (no usable tier list): not a snapshot policy at all.
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots", preset: "custom" } })),
    ).toBeNull();
  });

  it("reads a row's own keepDays/keepLast from before presets existed", () => {
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots", keepDays: 90, keepLast: 3 } })),
    ).toMatchObject({ keepDays: 90, keepLast: 3 });
  });

  it("falls back to the plain years column for a row saved before presets existed", () => {
    expect(snapshotPolicyOf(row({ appliesTo: { target: "snapshots" }, years: 2 }))).toMatchObject({
      keepDays: 730,
    });
    expect(
      snapshotPolicyOf(row({ appliesTo: { target: "snapshots" }, years: null })),
    ).toMatchObject({
      keepDays: null,
    });
  });

  it("prefers the default tenant-wide policy and counts object-scoped ones", () => {
    const summary = summarizeRetention([
      row({ name: "First", appliesTo: { target: "snapshots", preset: "30d" } }),
      row({
        name: "Scoped",
        appliesTo: { target: "snapshots", preset: "7y", protectedObjectIds: ["a", "b"] },
      }),
      row({ name: "Default", isDefault: true, appliesTo: { target: "snapshots", preset: "1y" } }),
    ]);
    expect(summary).toEqual({
      policy: { name: "Default", keepDays: 365, keepLast: 1, preset: "1y", tiers: undefined },
      scopedPolicies: 1,
    });
  });

  it("carries the preset id (and a custom policy's own tiers) so the page can name the rule accurately", () => {
    expect(
      summarizeRetention([
        row({
          name: "Standard",
          isDefault: true,
          appliesTo: { target: "snapshots", preset: "default" },
        }),
      ]).policy,
    ).toMatchObject({ preset: "default", tiers: undefined });

    const tiers = [{ fromDays: 0, toDays: 45, keepEveryDays: 0 }];
    expect(
      summarizeRetention([
        row({
          name: "Custom",
          isDefault: true,
          appliesTo: { target: "snapshots", preset: "custom", tiers },
        }),
      ]).policy,
    ).toMatchObject({ preset: "custom", tiers });

    // A row saved before presets existed: the documented DTO shape exactly
    // (name/keepDays/keepLast, no preset/tiers key at all) — a caller of the
    // response is entitled to rely on that shape (dashboard.pg.test.ts
    // asserts it with a strict toEqual).
    expect(
      summarizeRetention([
        row({
          name: "Old",
          isDefault: true,
          appliesTo: { target: "snapshots", keepDays: 90, keepLast: 3 },
        }),
      ]).policy,
    ).toEqual({ name: "Old", keepDays: 90, keepLast: 3 });
  });
});
