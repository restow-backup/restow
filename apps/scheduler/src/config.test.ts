import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const urls = {
  DATABASE_URL: "postgres://localhost/restow",
  DATABASE_PROVIDER_URL: "postgres://provider@localhost/restow",
};

describe("loadConfig", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is blank", () => {
    expect(() => loadConfig({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL/);
  });

  it("throws when the installation role's DATABASE_PROVIDER_URL is missing", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/restow" })).toThrow(
      /DATABASE_PROVIDER_URL/,
    );
  });

  it("applies sane defaults", () => {
    const config = loadConfig({ ...urls });
    expect(config.databaseUrl).toBe("postgres://localhost/restow");
    expect(config.databaseProviderUrl).toBe("postgres://provider@localhost/restow");
    expect(config.tickIntervalMs).toBeGreaterThan(0);
    expect(config.leaderRetryIntervalMs).toBeGreaterThan(0);
    expect(config.advisoryLockKey).toBeGreaterThan(0);
  });

  it("parses valid numeric overrides", () => {
    const config = loadConfig({
      ...urls,
      SCHEDULER_TICK_MS: "5000",
      SCHEDULER_LEADER_RETRY_MS: "2000",
    });
    expect(config.tickIntervalMs).toBe(5_000);
    expect(config.leaderRetryIntervalMs).toBe(2_000);
  });

  it("gives recommended schedules Berlin time unless SCHEDULER_DEFAULT_TIMEZONE names a zone", () => {
    expect(loadConfig({ ...urls }).defaultTimezone).toBe("Europe/Berlin");
    expect(loadConfig({ ...urls, SCHEDULER_DEFAULT_TIMEZONE: "  " }).defaultTimezone).toBe(
      "Europe/Berlin",
    );
    expect(
      loadConfig({ ...urls, SCHEDULER_DEFAULT_TIMEZONE: "America/New_York" }).defaultTimezone,
    ).toBe("America/New_York");
  });

  it("refuses a SCHEDULER_DEFAULT_TIMEZONE that is not an IANA zone", () => {
    expect(() => loadConfig({ ...urls, SCHEDULER_DEFAULT_TIMEZONE: "CEST+2" })).toThrow(
      /SCHEDULER_DEFAULT_TIMEZONE/,
    );
  });

  it("falls back to the default for non-numeric or non-positive overrides", () => {
    const config = loadConfig({
      ...urls,
      SCHEDULER_TICK_MS: "not-a-number",
      SCHEDULER_LEADER_RETRY_MS: "-5",
    });
    expect(config.tickIntervalMs).toBe(30_000);
    expect(config.leaderRetryIntervalMs).toBe(15_000);
  });

  it("keeps the default pool sizes and reads RESTOW_DB_*_POOL_MAX", () => {
    expect(loadConfig({ ...urls }).dbPool).toEqual({ app: 10, installation: 10, queue: 10 });
    expect(
      loadConfig({ ...urls, RESTOW_DB_POOL_MAX: "20", RESTOW_DB_BOSS_POOL_MAX: "4" }).dbPool,
    ).toEqual({ app: 20, installation: 10, queue: 4 });
  });

  it("refuses an invalid pool size", () => {
    expect(() => loadConfig({ ...urls, RESTOW_DB_POOL_MAX: "0" })).toThrow(/RESTOW_DB_POOL_MAX/);
  });
});
