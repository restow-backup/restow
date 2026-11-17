import type { Database } from "@restow/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runBillingPass: vi.fn(), pruneBillingSamples: vi.fn() }));

vi.mock("./service.js", () => ({
  runBillingPass: mocks.runBillingPass,
  pruneBillingSamples: mocks.pruneBillingSamples,
}));

const { billingCloseServiceFor } = await import("./job.js");

const deps = { db: {} as Database, providerDb: {} as Database };

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the billing close service", () => {
  it("starts nothing where there is nothing to do (the demo)", async () => {
    expect(await billingCloseServiceFor(async () => null).start()).toBeNull();
    expect(mocks.runBillingPass).not.toHaveBeenCalled();
  });

  it("runs a pass at once and then every interval, never two at the same time, and prunes once a day", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    mocks.runBillingPass.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ enabled: true, timeZone: "Europe/Berlin" });
        }),
    );
    const started = await billingCloseServiceFor(async () => deps, { intervalMs: 1000 }).start();
    expect(mocks.runBillingPass).toHaveBeenCalledTimes(1);
    // The first pass is still running: the next ticks skip.
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.runBillingPass).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.pruneBillingSamples).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.runBillingPass).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    // Pruned once a day, not every pass.
    expect(mocks.pruneBillingSamples).toHaveBeenCalledTimes(1);
    started?.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.runBillingPass).toHaveBeenCalledTimes(2);
  });
});
