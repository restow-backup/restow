import type { RestoreModeSnapshot } from "@restow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The task hold of agent and Proxmox VE heartbeats (hold.ts) when the restore mode cannot be
 * read: it fails closed like the worker's job hold, never hands out the dump's tasks.
 */

const guard = vi.hoisted(() => ({
  restoreMode: vi.fn<() => Promise<RestoreModeSnapshot>>(),
  holding: vi.fn<() => boolean>(),
}));

vi.mock("./instance.js", () => ({ apiRestoreModeGuard: () => guard }));

const { forgetLastKnownRestoreMode, RESTORE_MODE_UNKNOWN_PROBLEM, restoreModeTaskHoldBefore } =
  await import("./hold.js");

const holdJobsBefore = new Date("2026-11-01T10:00:00.000Z");
const on: RestoreModeSnapshot = {
  active: true,
  id: "rm-1",
  activatedAt: holdJobsBefore,
  holdJobsBefore,
  keepUnknownBefore: null,
};
const off: RestoreModeSnapshot = {
  active: false,
  id: null,
  activatedAt: null,
  holdJobsBefore: null,
  keepUnknownBefore: null,
};
const unreadable = () => Promise.reject(new Error("connection terminated"));

describe("restoreModeTaskHoldBefore", () => {
  beforeEach(() => {
    forgetLastKnownRestoreMode();
    guard.restoreMode.mockReset();
    guard.holding.mockReset().mockReturnValue(false);
  });

  it("answers the hold point while restore mode is on and null while it is off", async () => {
    guard.restoreMode.mockResolvedValueOnce(on).mockResolvedValueOnce(off);
    await expect(restoreModeTaskHoldBefore()).resolves.toEqual(holdJobsBefore);
    await expect(restoreModeTaskHoldBefore()).resolves.toBeNull();
  });

  it("keeps the last known hold point when the read fails while restore mode was on", async () => {
    guard.restoreMode.mockResolvedValueOnce(on).mockImplementationOnce(unreadable);
    guard.holding.mockReturnValue(true);
    await expect(restoreModeTaskHoldBefore()).resolves.toEqual(holdJobsBefore);
    await expect(restoreModeTaskHoldBefore()).resolves.toEqual(holdJobsBefore);
  });

  it("hands out nothing (503) when the restore mode was never read", async () => {
    guard.restoreMode.mockImplementationOnce(unreadable);
    await expect(restoreModeTaskHoldBefore()).rejects.toMatchObject({
      status: 503,
      type: RESTORE_MODE_UNKNOWN_PROBLEM,
    });
  });

  it("hands out nothing (503) when the guard has seen restore mode on since the last read here", async () => {
    guard.restoreMode.mockResolvedValueOnce(off).mockImplementationOnce(unreadable);
    await expect(restoreModeTaskHoldBefore()).resolves.toBeNull();
    guard.holding.mockReturnValue(true);
    await expect(restoreModeTaskHoldBefore()).rejects.toMatchObject({ status: 503 });
  });

  it("holds nothing when the read fails and restore mode was last seen off", async () => {
    guard.restoreMode.mockResolvedValueOnce(off).mockImplementationOnce(unreadable);
    await expect(restoreModeTaskHoldBefore()).resolves.toBeNull();
    await expect(restoreModeTaskHoldBefore()).resolves.toBeNull();
  });
});
