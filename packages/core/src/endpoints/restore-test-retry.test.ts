import { describe, expect, it } from "vitest";
import {
  RESTORE_TEST_RETRY_DELAYS_MS,
  RESTORE_TEST_TASK_TTL_MS,
  restoreTestAlreadyWaiting,
  restoreTestRetry,
} from "./restore-test-retry.js";

const HOUR = 60 * 60 * 1000;
const SNAPSHOT = "5e".repeat(32);
const FILES = [{ path: "/etc/hosts", sha256: "ab".repeat(32) }];
const now = new Date("2026-10-01T10:00:00.000Z");
const active = { status: "active", lastSnapshotId: SNAPSHOT };

describe("offering a restore test that could not complete again", () => {
  it("waits 1, 2, 4, 8, 16 and 24 hours, then stops", () => {
    expect(RESTORE_TEST_RETRY_DELAYS_MS.map((delay) => delay / HOUR)).toEqual([1, 2, 4, 8, 16, 24]);
    const waits: number[] = [];
    let params: { snapshotId: string; files: typeof FILES; retry?: number } = {
      snapshotId: SNAPSHOT,
      files: FILES,
    };
    for (;;) {
      const next = restoreTestRetry(params, active, now);
      if (!next) break;
      waits.push((Date.parse(next.params.notBefore) - now.getTime()) / HOUR);
      expect(next.expiresAt.getTime()).toBe(
        Date.parse(next.params.notBefore) + RESTORE_TEST_TASK_TTL_MS,
      );
      params = next.params;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 24]);
    expect(params.retry).toBe(6);
  });

  it("keeps the snapshot and the files of the test", () => {
    expect(restoreTestRetry({ snapshotId: SNAPSHOT, files: FILES }, active, now)).toEqual({
      params: {
        snapshotId: SNAPSHOT,
        files: FILES,
        retry: 1,
        notBefore: "2026-10-01T11:00:00.000Z",
      },
      expiresAt: new Date("2026-10-08T11:00:00.000Z"),
    });
  });

  it("offers nothing for an older backup, a revoked machine or a test without files", () => {
    const params = { snapshotId: SNAPSHOT, files: FILES };
    expect(
      restoreTestRetry(params, { ...active, lastSnapshotId: "6f".repeat(32) }, now),
    ).toBeNull();
    expect(restoreTestRetry(params, { ...active, lastSnapshotId: null }, now)).toBeNull();
    expect(restoreTestRetry(params, { ...active, status: "revoked" }, now)).toBeNull();
    expect(restoreTestRetry({ snapshotId: SNAPSHOT, files: [] }, active, now)).toBeNull();
    expect(restoreTestRetry({ files: FILES }, active, now)).toBeNull();
  });

  it("reads a retry count it does not understand as none", () => {
    for (const retry of [-1, 1.5, Number.NaN, "3" as unknown as number]) {
      expect(
        restoreTestRetry({ snapshotId: SNAPSHOT, files: FILES, retry }, active, now)?.params.retry,
      ).toBe(1);
    }
  });

  it("knows when a test of the same backup already waits, leaving out the one that ended", () => {
    const waiting = [
      { id: "t1", params: { snapshotId: SNAPSHOT } },
      { id: "t2", params: { snapshotId: "6f".repeat(32) } },
      { id: "t3", params: null },
    ];
    expect(restoreTestAlreadyWaiting(waiting, SNAPSHOT, "t9")).toBe(true);
    expect(restoreTestAlreadyWaiting(waiting, SNAPSHOT, "t1")).toBe(false);
    expect(restoreTestAlreadyWaiting([], SNAPSHOT, "t1")).toBe(false);
  });
});
