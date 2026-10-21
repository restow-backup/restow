import { describe, expect, it } from "vitest";
import {
  BOOT_TEST_WEEKLY_MS,
  DEFAULT_BOOT_TEST_MAX_MEMORY_MIB,
  DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
  MAX_BOOT_TEST_TIMEOUT_SECONDS,
  PVE_BOOT_TEST_CAPABILITY,
  pveBootTestDue,
  pveBootTestPlan,
  pveBootTestRating,
  pveBootTestTaskParams,
  pveNodeDeclares,
  pveRestorePointRating,
} from "./boot-test.js";

// Relative to a fixed instant: nothing here reads the clock.
const NOW = new Date(Date.UTC(2030, 0, 15, 12));
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const iso = (ms: number) => ago(ms).toISOString();

describe("the boot test setting of a job", () => {
  it("is off unless the job turned it on, with the default limits", () => {
    expect(pveBootTestPlan(undefined)).toEqual({
      schedule: "off",
      maxMemoryMiB: DEFAULT_BOOT_TEST_MAX_MEMORY_MIB,
      timeoutSeconds: DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
    });
    expect(pveBootTestPlan({ schedule: "weekly" }).schedule).toBe("weekly");
    expect(pveBootTestPlan({ schedule: "after_backup" }).schedule).toBe("after_backup");
  });

  it("keeps the limits within their bounds", () => {
    expect(pveBootTestPlan({ schedule: "weekly", timeoutSeconds: 10 }).timeoutSeconds).toBe(60);
    expect(pveBootTestPlan({ schedule: "weekly", timeoutSeconds: 1e9 }).timeoutSeconds).toBe(
      MAX_BOOT_TEST_TIMEOUT_SECONDS,
    );
    expect(pveBootTestPlan({ schedule: "weekly", maxMemoryMiB: 4096 }).maxMemoryMiB).toBe(4096);
    expect(pveBootTestPlan({ schedule: "weekly", maxMemoryMiB: 1 }).maxMemoryMiB).toBe(256);
  });
});

describe("which node may run a boot test", () => {
  it("only one that announced the capability; an older node announces nothing", () => {
    expect(pveNodeDeclares({ capabilities: ["boot_test"] }, PVE_BOOT_TEST_CAPABILITY)).toBe(true);
    expect(pveNodeDeclares({ capabilities: [] }, PVE_BOOT_TEST_CAPABILITY)).toBe(false);
    expect(pveNodeDeclares({}, PVE_BOOT_TEST_CAPABILITY)).toBe(false);
    expect(pveNodeDeclares(null, PVE_BOOT_TEST_CAPABILITY)).toBe(false);
  });
});

describe("when a boot test is due", () => {
  const newest = { backupAt: ago(60_000), tested: false };

  it("never while the job has it off, or without a restore point", () => {
    expect(pveBootTestDue({ schedule: "off", lastBootTestAt: null, newest }, NOW)).toBe(false);
    expect(pveBootTestDue({ schedule: "weekly", lastBootTestAt: null, newest: null }, NOW)).toBe(
      false,
    );
  });

  it("after every backup: once per restore point", () => {
    const input = { schedule: "after_backup" as const, lastBootTestAt: ago(1000) };
    expect(pveBootTestDue({ ...input, newest }, NOW)).toBe(true);
    expect(pveBootTestDue({ ...input, newest: { ...newest, tested: true } }, NOW)).toBe(false);
  });

  it("weekly: a week after the last one", () => {
    const weekly = { schedule: "weekly" as const, newest };
    expect(pveBootTestDue({ ...weekly, lastBootTestAt: null }, NOW)).toBe(true);
    expect(pveBootTestDue({ ...weekly, lastBootTestAt: ago(BOOT_TEST_WEEKLY_MS - 1) }, NOW)).toBe(
      false,
    );
    expect(pveBootTestDue({ ...weekly, lastBootTestAt: ago(BOOT_TEST_WEEKLY_MS) }, NOW)).toBe(true);
  });
});

describe("how a boot test rates its restore point", () => {
  it("green only for proof, yellow without an answer, red on failure, nothing when skipped", () => {
    expect(pveBootTestRating({ outcome: "green", checkedAt: iso(0) })).toBe("green");
    expect(pveBootTestRating({ outcome: "yellow", checkedAt: iso(0) })).toBe("yellow");
    expect(pveBootTestRating({ outcome: "red", checkedAt: iso(0) })).toBe("red");
    expect(pveBootTestRating({ outcome: "skipped", checkedAt: iso(0) })).toBeNull();
    expect(pveBootTestRating({ outcome: "error", checkedAt: iso(0) })).toBeNull();
    expect(pveBootTestRating(null)).toBeNull();
  });
});

describe("the rating of a restore point from its read-back and its boot test", () => {
  const readGreen = { checkedAt: iso(5000), mismatched: 0, errors: [] };
  const readRed = { checkedAt: iso(5000), mismatched: 2, errors: [] };

  it("is the read-back alone without a rated boot test (as before boot tests)", () => {
    expect(pveRestorePointRating(readGreen, null)).toEqual({
      readiness: "green",
      checkedAt: readGreen.checkedAt,
      basis: "verify",
    });
    expect(pveRestorePointRating(readGreen, { outcome: "skipped", checkedAt: iso(0) })).toEqual({
      readiness: "green",
      checkedAt: readGreen.checkedAt,
      basis: "verify",
    });
    expect(pveRestorePointRating(null, null)).toEqual({
      readiness: null,
      checkedAt: null,
      basis: null,
    });
  });

  it("is red when either check failed", () => {
    expect(pveRestorePointRating(readRed, { outcome: "green", checkedAt: iso(0) }).readiness).toBe(
      "red",
    );
    const boot = { outcome: "red", checkedAt: iso(0) };
    expect(pveRestorePointRating(readGreen, boot)).toEqual({
      readiness: "red",
      checkedAt: boot.checkedAt,
      basis: "boot_test",
    });
  });

  it("is yellow when the read-back could not run (locked), unless a boot test decides", () => {
    const locked = { mismatched: 0, errors: [], notChecked: { gaveUpAt: iso(6000) } };
    expect(pveRestorePointRating(locked, null)).toEqual({
      readiness: "yellow",
      checkedAt: iso(6000),
      basis: "verify",
    });
    expect(pveRestorePointRating(locked, { outcome: "green", checkedAt: iso(0) })).toMatchObject({
      readiness: "green",
      basis: "boot_test",
    });
    expect(pveRestorePointRating(locked, { outcome: "red", checkedAt: iso(0) }).readiness).toBe(
      "red",
    );
    // While the worker still tries, the earlier read-back stands.
    expect(pveRestorePointRating({ ...readGreen, notChecked: {} }, null).readiness).toBe("green");
  });

  it("is yellow when the guest only started, green when its guest agent answered", () => {
    expect(
      pveRestorePointRating(readGreen, { outcome: "yellow", checkedAt: iso(0) }).readiness,
    ).toBe("yellow");
    expect(pveRestorePointRating(null, { outcome: "green", checkedAt: iso(0) })).toEqual({
      readiness: "green",
      checkedAt: iso(0),
      basis: "boot_test",
    });
  });
});

describe("the task a node gets", () => {
  it("names the restore point, the limits and what the restore writes", () => {
    const plan = pveBootTestPlan({ schedule: "weekly", maxMemoryMiB: 4096 });
    const vm = {
      id: "s1",
      archiveName: "vm/101/2030-01-01T00:00:00Z",
      kind: "vm" as const,
      byteSize: 0,
      disks: [
        { size: 32 * 2 ** 30, dataBlocks: 100 },
        { size: 4 * 2 ** 20, dataBlocks: 1 },
      ],
    };
    expect(pveBootTestTaskParams(vm, 101, plan)).toEqual({
      volname: "vm/101/2030-01-01T00:00:00Z",
      kind: "vm",
      vmid: 101,
      maxMemoryMiB: 4096,
      timeoutSeconds: DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
      dataBytes: 101 * 4 * 2 ** 20,
      diskBytes: 32 * 2 ** 30 + 4 * 2 ** 20,
      snapshotId: "s1",
    });
    const ct = { ...vm, kind: "ct" as const, byteSize: 5000, disks: [] };
    expect(pveBootTestTaskParams(ct, 200, plan)).toMatchObject({
      dataBytes: 5000,
      diskBytes: 5000,
    });
  });
});
