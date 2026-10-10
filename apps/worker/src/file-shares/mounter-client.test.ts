import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MOUNTER_URL, MounterSecretFile, runnerClientFromEnv } from "./mounter-client.js";

describe("worker mounter client", () => {
  it("talks to the configured mounter with the secret from the shared volume", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const read = vi.fn(async (path: string) => {
      expect(path).toBe("/run/secret-file");
      return "shared-secret-value\n";
    });
    const client = runnerClientFromEnv(
      { RESTOW_MOUNTER_URL: "http://mounter:8091", RESTOW_MOUNTER_SECRET_FILE: "/run/secret-file" },
      { fetch: fetchImpl as unknown as typeof fetch, readFile: read },
    );
    expect(client.enabled).toBe(true);
    expect(await client.list()).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://mounter:8091/v1/runner/runs");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer shared-secret-value",
    );
  });

  it("defaults to the compose service, is off when empty or in demo mode", () => {
    expect(DEFAULT_MOUNTER_URL).toBe("http://mounter:8091");
    expect(runnerClientFromEnv({}).enabled).toBe(true);
    expect(runnerClientFromEnv({ RESTOW_MOUNTER_URL: " " }).enabled).toBe(false);
    expect(runnerClientFromEnv({ RESTOW_MOUNTER_URL: "http://m:1" }, { demo: true }).enabled).toBe(
      false,
    );
  });

  it("caches the secret and forgets it on demand", async () => {
    let now = 0;
    const read = vi.fn(async () => "s1");
    const file = new MounterSecretFile("/x", read, () => now);
    expect(await file.get()).toBe("s1");
    expect(await file.get()).toBe("s1");
    expect(read).toHaveBeenCalledTimes(1);
    now = 31_000;
    await file.get();
    expect(read).toHaveBeenCalledTimes(2);
    file.forget();
    await file.get();
    expect(read).toHaveBeenCalledTimes(3);
    const missing = new MounterSecretFile("/nope", async () => {
      throw new Error("ENOENT");
    });
    expect(await missing.get()).toBeNull();
  });
});
