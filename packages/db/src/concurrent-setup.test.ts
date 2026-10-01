import { describe, expect, it, vi } from "vitest";
import { isConcurrentSetupConflict, retryConcurrentSetup } from "./concurrent-setup.js";

function pgError(code: string): Error {
  return Object.assign(new Error(`postgres error ${code}`), { code });
}

const noSleep = async () => {};

describe("retryConcurrentSetup", () => {
  it("retries a deadlock and returns the result of the next attempt", async () => {
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(pgError("40P01"))
      .mockResolvedValueOnce("ready");
    const onRetry = vi.fn();
    await expect(retryConcurrentSetup(work, { sleep: noSleep, onRetry })).resolves.toBe("ready");
    expect(work).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, code: "40P01" }));
  });

  it("recognises the codes also when the error is wrapped", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: pgError("23505") });
    expect(isConcurrentSetupConflict(wrapped)).toBe(true);
    expect(isConcurrentSetupConflict(pgError("40001"))).toBe(true);
  });

  it("throws any other error at once", async () => {
    const work = vi.fn<() => Promise<void>>().mockRejectedValue(pgError("28P01"));
    await expect(retryConcurrentSetup(work, { sleep: noSleep })).rejects.toThrow("28P01");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt and throws the conflict", async () => {
    const work = vi.fn<() => Promise<void>>().mockRejectedValue(pgError("40P01"));
    await expect(retryConcurrentSetup(work, { attempts: 3, sleep: noSleep })).rejects.toThrow(
      "40P01",
    );
    expect(work).toHaveBeenCalledTimes(3);
  });
});
