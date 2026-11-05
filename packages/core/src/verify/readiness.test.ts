import { describe, expect, it } from "vitest";
import {
  assessReadiness,
  isEmptyFinding,
  isSourceEmptyFinding,
  type ReadinessFacts,
} from "./readiness.js";

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

describe("assessReadiness: the source's own size signal (0.5.0)", () => {
  it("rates an object empty by the source and by the backup as empty, without confirmation", () => {
    const rated = assessReadiness(
      facts({ source: { service: "onedrive", verdict: "empty", bytes: 0 } }),
    );
    expect(rated.reasons).toEqual([
      { code: "snapshot_empty_confirmed_by_source", severity: "yellow", count: 9 },
    ]);
    expect(isSourceEmptyFinding(rated.reasons)).toBe(true);
    // Nothing for an admin to confirm.
    expect(isEmptyFinding(rated.reasons)).toBe(false);
  });

  it("turns red when the source reports content and the backup holds none", () => {
    const drive = assessReadiness(
      facts({ source: { service: "onedrive", verdict: "content", bytes: 20_480 } }),
    );
    expect(drive).toEqual({
      readiness: "red",
      reasons: [{ code: "backup_missing_source_content", severity: "red", bytes: 20_480 }],
    });
    expect(isEmptyFinding(drive.reasons)).toBe(false);
    expect(isSourceEmptyFinding(drive.reasons)).toBe(false);

    const mailbox = assessReadiness(
      facts({ source: { service: "mailbox", verdict: "content", items: 12 } }),
    );
    expect(mailbox.reasons).toEqual([
      { code: "backup_missing_source_content", severity: "red", count: 12 },
    ]);
  });

  it("stays yellow and confirmable without a signal, or with one that proves nothing", () => {
    for (const source of [null, undefined, { service: "mailbox", verdict: "unknown" } as const]) {
      const rated = assessReadiness(facts({ source }));
      expect(rated.reasons).toEqual([{ code: "snapshot_empty", severity: "yellow", count: 9 }]);
      expect(isEmptyFinding(rated.reasons)).toBe(true);
    }
  });

  it("ignores the signal for a backup with content", () => {
    const rated = assessReadiness(
      facts({
        checked: 1,
        contentBytes: 10,
        contentObjects: 1,
        outcomes: { verified: 1, mismatch: 0, missing: 0, unreadable: 0 },
        source: { service: "onedrive", verdict: "content", bytes: 10 },
      }),
    );
    expect(rated).toEqual({ readiness: "green", reasons: [] });
  });

  it("does not call an old empty backup empty by the source alone", () => {
    const rated = assessReadiness(
      facts({
        snapshotCompletedAt: new Date("2026-09-28T00:00:00Z"),
        source: { service: "onedrive", verdict: "empty", bytes: 0 },
      }),
    );
    expect(rated.reasons.map((reason) => reason.code)).toEqual([
      "snapshot_stale",
      "snapshot_empty_confirmed_by_source",
    ]);
    expect(isSourceEmptyFinding(rated.reasons)).toBe(false);
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

describe("assessReadiness: items the backup run left out", () => {
  const readBack = {
    checked: 20,
    contentBytes: 9000,
    contentObjects: 20,
    outcomes: { verified: 20, mismatch: 0, missing: 0, unreadable: 0 },
  };

  it("is not green when the run that made the backup failed items, however well it reads back", () => {
    expect(
      assessReadiness(facts({ ...readBack, backupFailures: { failed: 300, persistent: 0 } })),
    ).toEqual({
      readiness: "yellow",
      reasons: [{ code: "backup_incomplete", severity: "yellow", count: 300 }],
    });
  });

  it("turns red for items that failed in each of the last runs", () => {
    expect(
      assessReadiness(facts({ ...readBack, backupFailures: { failed: 4, persistent: 4 } })),
    ).toEqual({
      readiness: "red",
      reasons: [{ code: "backup_incomplete_persistent", severity: "red", count: 4 }],
    });
  });

  it("stays green for a complete backup", () => {
    expect(assessReadiness(facts({ ...readBack, backupFailures: null })).readiness).toBe("green");
    expect(
      assessReadiness(facts({ ...readBack, backupFailures: { failed: 0, persistent: 0 } }))
        .readiness,
    ).toBe("green");
  });
});
