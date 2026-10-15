import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attemptLegacyReclaim,
  LEGACY_RECLAIM_INTERVAL_MS,
  type LegacyReclaimDeps,
  legacyReclaimFromEnvironment,
  startLegacyManifestReclaim,
} from "./legacy-manifest-reclaim.js";

const MB = 1024 * 1024;

function deps(sizes: (number | null | Error)[], reclaims: (boolean | Error)[]) {
  const calls = { probe: 0, reclaim: 0 };
  const logged: { level: string; message: string }[] = [];
  const value: LegacyReclaimDeps = {
    probe: async () => {
      const next = sizes[Math.min(calls.probe, sizes.length - 1)];
      calls.probe += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next ?? null;
    },
    reclaim: async () => {
      const next = reclaims[Math.min(calls.reclaim, reclaims.length - 1)];
      calls.reclaim += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next ?? false;
    },
    log: (level, message) => logged.push({ level, message }),
    firstAttemptMs: 1000,
  };
  return { value, calls, logged };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attemptLegacyReclaim", () => {
  it("opens no owner connection while the old table is gone or small", async () => {
    for (const size of [null, 0, 8 * MB - 1]) {
      const { value, calls } = deps([size], [true]);
      expect(await attemptLegacyReclaim(value)).toBe("nothing_to_do");
      expect(calls.reclaim).toBe(0);
    }
  });

  it("reclaims a large emptied table and says so", async () => {
    const { value, calls, logged } = deps([512 * MB], [true]);
    expect(await attemptLegacyReclaim(value)).toBe("reclaimed");
    expect(calls.reclaim).toBe(1);
    expect(logged).toEqual([expect.objectContaining({ level: "info" })]);
  });

  it("tries again while rows are left, and after a failure, without throwing", async () => {
    expect(await attemptLegacyReclaim(deps([512 * MB], [false]).value)).toBe("retry");
    const failing = deps([new Error("connection refused")], [true]);
    expect(await attemptLegacyReclaim(failing.value)).toBe("retry");
    expect(failing.logged).toEqual([expect.objectContaining({ level: "warn" })]);
    const reclaimFails = deps([512 * MB], [new Error("boom")]);
    expect(await attemptLegacyReclaim(reclaimFails.value)).toBe("retry");
  });
});

describe("startLegacyManifestReclaim", () => {
  it("retries on its interval until the space is back, then stops for good", async () => {
    vi.useFakeTimers();
    const { value, calls } = deps([512 * MB], [false, false, true]);
    startLegacyManifestReclaim(value);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.reclaim).toBe(1);
    await vi.advanceTimersByTimeAsync(LEGACY_RECLAIM_INTERVAL_MS);
    expect(calls.reclaim).toBe(2);
    await vi.advanceTimersByTimeAsync(LEGACY_RECLAIM_INTERVAL_MS);
    expect(calls.reclaim).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * LEGACY_RECLAIM_INTERVAL_MS);
    expect(calls.reclaim).toBe(3);
    expect(calls.probe).toBe(3);
  });

  it("stops at once when there is nothing to give back", async () => {
    vi.useFakeTimers();
    const { value, calls } = deps([null], [true]);
    startLegacyManifestReclaim(value);
    await vi.advanceTimersByTimeAsync(10 * LEGACY_RECLAIM_INTERVAL_MS);
    expect(calls.probe).toBe(1);
    expect(calls.reclaim).toBe(0);
  });

  it("does nothing after its stop function ran", async () => {
    vi.useFakeTimers();
    const { value, calls } = deps([512 * MB], [false]);
    const stop = startLegacyManifestReclaim(value);
    stop();
    await vi.advanceTimersByTimeAsync(10 * LEGACY_RECLAIM_INTERVAL_MS);
    expect(calls.probe).toBe(0);
  });
});

describe("legacyReclaimFromEnvironment", () => {
  const pool = { query: async () => ({ rows: [] }) };

  it("never starts without the owner connection string", () => {
    expect(legacyReclaimFromEnvironment(pool, () => undefined, {})).toBeNull();
    expect(
      legacyReclaimFromEnvironment(pool, () => undefined, { DATABASE_MIGRATION_URL: "  " }),
    ).toBeNull();
  });

  it("probes on the installation pool it was given", async () => {
    const queries: string[] = [];
    const probePool = {
      query: async <R extends Record<string, unknown>>(text: string) => {
        queries.push(text);
        return { rows: [{ bytes: "4096" }] as unknown as R[] };
      },
    };
    const built = legacyReclaimFromEnvironment(probePool, () => undefined, {
      DATABASE_MIGRATION_URL: "postgres://owner@127.0.0.1:1/restow",
    });
    expect(built).not.toBeNull();
    expect(await built?.probe()).toBe(4096);
    expect(queries).toEqual([expect.stringContaining("manifest_objects")]);
  });
});
