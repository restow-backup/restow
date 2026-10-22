import { describe, expect, it } from "vitest";
import { decideStartup, readInstalledKeyRow } from "./startup-check.js";

const RELEASE_2028 = { RESTOW_VERSION: "1.8.0", RESTOW_RELEASED_AT: "2028-03-01T09:00:00Z" };
const EXPIRED = { edition: "business", series: "1", updates_until: "2027-11-30" };

describe("decideStartup", () => {
  it("starts without a key, with a Community row and in the demo", () => {
    expect(decideStartup(null, RELEASE_2028).action).toBe("start");
    expect(decideStartup({ edition: "community" }, RELEASE_2028).action).toBe("start");
    expect(
      decideStartup(null, { ...RELEASE_2028, RESTOW_DEMO: "true", RESTOW_EDITION: "business" })
        .action,
    ).toBe("start");
  });

  it("starts with every key installed before 0.4.5 (no update columns yet) on 0.x and 1.x", () => {
    for (const version of ["0.4.5", "0.9.9", "1.0.0", "1.99.0"]) {
      const env = { RESTOW_VERSION: version, RESTOW_RELEASED_AT: "2035-01-01T00:00:00Z" };
      expect(decideStartup({ edition: "business" }, env).action).toBe("start");
      expect(decideStartup({ edition: "service_provider", series: null }, env).action).toBe(
        "start",
      );
    }
  });

  it("starts a development build with any key", () => {
    expect(decideStartup(EXPIRED, {}).action).toBe("start");
    expect(decideStartup(EXPIRED, { RESTOW_VERSION: "1.8.0" }).action).toBe("start");
  });

  it("starts a release made within the update period", () => {
    const env = { RESTOW_VERSION: "1.6.0", RESTOW_RELEASED_AT: "2027-11-30T22:00:00Z" };
    expect(decideStartup(EXPIRED, env).action).toBe("start");
  });

  it("refuses a release made after the update period, naming version and dates", () => {
    const decision = decideStartup(EXPIRED, RELEASE_2028);
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.message).toContain("1.8.0");
    expect(decision.message).toContain("2027-11-30");
    expect(decision.message).toContain("2027-11-30T23:59:59.999Z");
    expect(decision.message).toContain("2028-03-01T09:00:00.000Z");
    expect(decision.message).toContain("RESTOW_RUN_AS_COMMUNITY=1");
    expect(decision.message).toContain("Business");
  });

  it("refuses a beta licence on the next major version", () => {
    const decision = decideStartup(
      { edition: "service_provider" },
      { RESTOW_VERSION: "2.0.0", RESTOW_RELEASED_AT: "2030-01-01T00:00:00Z" },
    );
    expect(decision.action).toBe("refuse");
    expect(decision.action === "refuse" && decision.message).toContain("1.x");
  });

  it("starts as Community instead when RESTOW_RUN_AS_COMMUNITY is set", () => {
    const decision = decideStartup(EXPIRED, { ...RELEASE_2028, RESTOW_RUN_AS_COMMUNITY: "1" });
    expect(decision.action).toBe("community");
  });

  it("ignores a malformed stored date rather than refusing on it", () => {
    expect(decideStartup({ ...EXPIRED, updates_until: 42 }, RELEASE_2028).action).toBe("start");
  });
});

describe("readInstalledKeyRow", () => {
  it("returns the active row as JSON", async () => {
    const queries: string[] = [];
    const row = await readInstalledKeyRow({
      query: async (text) => {
        queries.push(text);
        return { rows: [{ row: { edition: "business" } }] };
      },
    });
    expect(row).toEqual({ edition: "business" });
    expect(queries[0]).toMatch(/^select to_jsonb\(l\)/);
  });

  it("returns null without a row and without the table", async () => {
    expect(await readInstalledKeyRow({ query: async () => ({ rows: [] }) })).toBeNull();
    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    expect(
      await readInstalledKeyRow({
        query: async () => {
          throw missing;
        },
      }),
    ).toBeNull();
  });

  it("passes other errors on", async () => {
    await expect(
      readInstalledKeyRow({
        query: async () => {
          throw new Error("connection refused");
        },
      }),
    ).rejects.toThrow("connection refused");
  });
});
