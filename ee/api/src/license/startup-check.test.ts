import { describe, expect, it } from "vitest";
import { runStartupLicenseCheck } from "./startup-check.js";

const RELEASE_2028 = { RESTOW_VERSION: "1.8.0", RESTOW_RELEASED_AT: "2028-03-01T09:00:00Z" };

function fakeDatabase(result: () => Array<Record<string, unknown>>) {
  const calls = { queries: 0, ended: 0 };
  return {
    calls,
    connect: () => ({
      query: async () => {
        calls.queries += 1;
        return { rows: result() };
      },
      end: async () => {
        calls.ended += 1;
      },
    }),
  };
}

describe("runStartupLicenseCheck", () => {
  const env = { DATABASE_MIGRATION_URL: "postgres://owner@db/restow", ...RELEASE_2028 };
  const expiredRow = () => [
    { row: { edition: "business", series: "1", updates_until: "2027-11-30" } },
  ];

  it("exits 1 for a release the installed key does not cover, and closes the connection", async () => {
    const database = fakeDatabase(expiredRow);
    const lines: Array<[string, string]> = [];
    const code = await runStartupLicenseCheck(env, {
      connect: database.connect,
      log: (level, message) => lines.push([level, message]),
    });
    expect(code).toBe(1);
    expect(database.calls).toEqual({ queries: 1, ended: 1 });
    expect(lines[0]?.[0]).toBe("error");
    expect(lines[0]?.[1]).toContain("has not touched the database");
  });

  it("exits 0 and warns when the operator starts it as Community", async () => {
    const lines: string[] = [];
    const code = await runStartupLicenseCheck(
      { ...env, RESTOW_RUN_AS_COMMUNITY: "1" },
      { connect: fakeDatabase(expiredRow).connect, log: (level) => lines.push(level) },
    );
    expect(code).toBe(0);
    expect(lines).toEqual(["warn"]);
  });

  it("exits 0 quietly without a key and with a beta licence", async () => {
    const lines: string[] = [];
    const log = (level: string) => lines.push(level);
    expect(
      await runStartupLicenseCheck(env, { connect: fakeDatabase(() => []).connect, log }),
    ).toBe(0);
    expect(
      await runStartupLicenseCheck(env, {
        connect: fakeDatabase(() => [{ row: { edition: "service_provider" } }]).connect,
        log,
      }),
    ).toBe(0);
    expect(lines).toEqual([]);
  });

  it("never stops a start because the database could not be read", async () => {
    const lines: string[] = [];
    const code = await runStartupLicenseCheck(env, {
      connect: () => ({
        query: async () => {
          throw new Error("connection refused");
        },
        end: async () => undefined,
      }),
      log: (level) => lines.push(level),
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["warn"]);
  });

  it("is skipped without the migration connection", async () => {
    expect(
      await runStartupLicenseCheck(RELEASE_2028, {
        connect: () => {
          throw new Error("must not connect");
        },
        log: () => undefined,
      }),
    ).toBe(0);
  });
});
