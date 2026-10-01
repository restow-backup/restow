import { describe, expect, it } from "vitest";
import {
  type FirstBackupCandidate,
  needsFirstBackup,
  selectFirstBackupTargets,
} from "./first-backup.js";

function candidate(overrides: Partial<FirstBackupCandidate> = {}): FirstBackupCandidate {
  return {
    protectedObjectId: "object-1",
    hasSnapshot: false,
    hasQueuedOrActiveBackup: false,
    ...overrides,
  };
}

describe("needsFirstBackup", () => {
  it("is true for an object with no snapshot and no backup in flight", () => {
    expect(needsFirstBackup(candidate())).toBe(true);
  });

  it("is false once a snapshot exists, however old", () => {
    expect(needsFirstBackup(candidate({ hasSnapshot: true }))).toBe(false);
  });

  it("is false while a backup is already queued or running", () => {
    expect(needsFirstBackup(candidate({ hasQueuedOrActiveBackup: true }))).toBe(false);
  });

  it("is false when both a snapshot and a queued backup exist", () => {
    expect(needsFirstBackup(candidate({ hasSnapshot: true, hasQueuedOrActiveBackup: true }))).toBe(
      false,
    );
  });
});

describe("selectFirstBackupTargets", () => {
  it("returns nothing for an empty batch", () => {
    expect(selectFirstBackupTargets([])).toEqual([]);
  });

  it("keeps only the ids that still need a first backup, in order", () => {
    const candidates: FirstBackupCandidate[] = [
      candidate({ protectedObjectId: "needs-1" }),
      candidate({ protectedObjectId: "has-snapshot", hasSnapshot: true }),
      candidate({ protectedObjectId: "needs-2" }),
      candidate({ protectedObjectId: "already-queued", hasQueuedOrActiveBackup: true }),
    ];
    expect(selectFirstBackupTargets(candidates)).toEqual(["needs-1", "needs-2"]);
  });

  it("skips every candidate once none of them need a first backup", () => {
    const candidates: FirstBackupCandidate[] = [
      candidate({ protectedObjectId: "a", hasSnapshot: true }),
      candidate({ protectedObjectId: "b", hasQueuedOrActiveBackup: true }),
    ];
    expect(selectFirstBackupTargets(candidates)).toEqual([]);
  });
});
