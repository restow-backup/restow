import { describe, expect, it } from "vitest";
import { type AgentConfig as EndpointConfig, defaultEndpointConfig } from "../endpoints/config.js";
import {
  buildEndpointConfig,
  effectiveSchedule,
  effectiveSettings,
  retentionToWrite,
  sameEndpointConfig,
} from "./endpoint-config.js";
import {
  type LegacyEndpointRow,
  type LegacyScheduleRow,
  type MailMigrationPlan,
  planEndpointMigration,
  planMailMigration,
} from "./migration.js";
import { jobScheduleFromCadence, scheduleGaps } from "./schedule.js";
import type { JobSchedule } from "./types.js";

const NOW = new Date("2026-10-02T10:00:00.000Z");
const ZONE = "Europe/Berlin";
let counter = 0;

function row(
  overrides: Partial<LegacyScheduleRow> & Pick<LegacyScheduleRow, "kind">,
): LegacyScheduleRow {
  counter++;
  return {
    id: `s${String(counter).padStart(3, "0")}`,
    protectedObjectId: null,
    intervalMinutes: null,
    cron: null,
    timezone: ZONE,
    enabled: true,
    nextRunAt: new Date("2026-10-02T12:00:00.000Z"),
    lastRunAt: new Date("2026-10-02T04:00:00.000Z"),
    createdAt: new Date(Date.UTC(2026, 8, 1) + counter * 3_600_000),
    ...overrides,
  };
}

const every = (minutes: number) => ({ intervalMinutes: minutes, cron: null });
const cron = (expression: string) => ({ intervalMinutes: null, cron: expression });

describe("mail migration", () => {
  it("turns the recommended schedules into one job over every object", () => {
    const backup = row({ kind: "backup", ...every(480) });
    const verify = row({ kind: "verify", ...cron("0 3 * * 0") });
    const plan = planMailMigration([backup, verify], NOW);
    expect(plan.create).toBe(true);
    expect(plan.scopeMode).toBe("all");
    expect(plan.schedule).toEqual({ kind: "interval", intervalMinutes: 480, timeZone: ZONE });
    expect(plan.nextRunAt).toEqual(backup.nextRunAt);
    expect(plan.lastRunAt).toEqual(backup.lastRunAt);
    expect(plan.verifySchedule).toEqual({ kind: "cron", cron: "0 3 * * 0", timeZone: ZONE });
    expect(plan.verifyNextRunAt).toEqual(verify.nextRunAt);
    expect(plan.members).toEqual([]);
    expect([...plan.supersede].sort()).toEqual([backup.id, verify.id].sort());
    expect(plan.leftover).toEqual([]);
  });

  it("creates nothing when no backup or verify schedule is enabled", () => {
    expect(planMailMigration([], NOW).create).toBe(false);
    const disabled = planMailMigration(
      [row({ kind: "backup", ...every(480), enabled: false })],
      NOW,
    );
    expect(disabled.create).toBe(false);
    expect(disabled.supersede).toEqual([]);
  });

  it("carries a verify-only tenant over with manual backups", () => {
    const verify = row({ kind: "verify", ...cron("0 3 * * 0") });
    const plan = planMailMigration([verify], NOW);
    expect(plan.schedule).toBeNull();
    expect(plan.verifySchedule).not.toBeNull();
    expect(plan.scopeMode).toBe("all");
  });

  it("replaces a disabled schedule without carrying its cadence", () => {
    const enabled = row({ kind: "backup", ...every(480) });
    const disabled = row({ kind: "backup", ...every(60), enabled: false });
    const plan = planMailMigration([enabled, disabled], NOW);
    expect(plan.schedule).toMatchObject({ intervalMinutes: 480 });
    expect(plan.supersede).toContain(disabled.id);
    expect(plan.leftover).toEqual([]);
  });

  it("keeps a second tenant-wide schedule with another cadence running as it was", () => {
    const first = row({ kind: "backup", ...every(480) });
    const twin = row({ kind: "backup", ...every(480) });
    const other = row({ kind: "backup", ...cron("0 2 * * *") });
    const plan = planMailMigration([first, twin, other], NOW);
    expect(plan.supersede).toContain(first.id);
    expect(plan.supersede).toContain(twin.id);
    expect(plan.supersede).not.toContain(other.id);
    expect(plan.leftover).toEqual([
      { id: other.id, kind: "backup", protectedObjectId: null, reason: "different_cadence" },
    ]);
  });

  it("makes an object's own, more frequent schedule an override with its own timer", () => {
    const tenantWide = row({ kind: "backup", ...cron("0 2 * * *") });
    const own = row({
      kind: "backup",
      protectedObjectId: "obj-ceo",
      ...every(60),
      nextRunAt: new Date("2026-10-02T10:30:00.000Z"),
      lastRunAt: new Date("2026-10-02T09:30:00.000Z"),
    });
    const plan = planMailMigration([tenantWide, own], NOW);
    expect(plan.scopeMode).toBe("all");
    expect(plan.members).toEqual([
      {
        protectedObjectId: "obj-ceo",
        overrides: { schedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE } },
        nextRunAt: own.nextRunAt,
        lastRunAt: own.lastRunAt,
        verifyNextRunAt: null,
        verifyLastRunAt: null,
      },
    ]);
    expect(plan.supersede).toContain(own.id);
  });

  it("never lets an object run less often than before", () => {
    const tenantWide = row({ kind: "backup", ...every(480) });
    const weekly = row({ kind: "backup", protectedObjectId: "obj-1", ...cron("0 3 * * 0") });
    const plan = planMailMigration([tenantWide, weekly], NOW);
    expect(plan.members).toEqual([]);
    expect(plan.supersede).not.toContain(weekly.id);
    expect(plan.leftover).toEqual([
      { id: weekly.id, kind: "backup", protectedObjectId: "obj-1", reason: "less_frequent" },
    ]);
  });

  it("keeps the best of several schedules of one object, and the others running, without a tenant-wide one", () => {
    // Hourly, and a nightly one added later for the same mailbox. One member can carry one
    // schedule; the hourly one must not be replaced by the nightly one.
    const hourly = row({ kind: "backup", protectedObjectId: "obj-ceo", ...every(60) });
    const nightly = row({ kind: "backup", protectedObjectId: "obj-ceo", ...cron("0 2 * * *") });
    const other = row({ kind: "backup", protectedObjectId: "obj-1", ...cron("0 2 * * *") });
    const plan = planMailMigration([hourly, nightly, other], NOW);
    expect(plan.scopeMode).toBe("selected");
    const ceo = plan.members.find((member) => member.protectedObjectId === "obj-ceo");
    // The nightly cadence is the job's (most common); the CEO keeps the hourly one as override.
    expect(plan.schedule).toMatchObject({ kind: "cron", cron: "0 2 * * *" });
    expect(ceo?.overrides).toEqual({
      schedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE },
    });
    expect(plan.supersede).toContain(hourly.id);
    // The nightly one of the CEO is not what the member runs on: it keeps running.
    expect(plan.supersede).not.toContain(nightly.id);
    expect(plan.leftover).toEqual([
      { id: nightly.id, kind: "backup", protectedObjectId: "obj-ceo", reason: "different_cadence" },
    ]);
  });

  it("keeps the best of several schedules of one object under a tenant-wide one", () => {
    const tenantWide = row({ kind: "verify", ...cron("0 3 * * 0") });
    const twoHourly = row({ kind: "verify", protectedObjectId: "obj-b", ...cron("15 */2 * * *") });
    const sixHourly = row({ kind: "verify", protectedObjectId: "obj-b", ...cron("0 */6 * * *") });
    const plan = planMailMigration([tenantWide, twoHourly, sixHourly], NOW);
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]?.overrides.verifySchedule).toMatchObject({ cron: "15 */2 * * *" });
    expect(plan.supersede).toContain(twoHourly.id);
    expect(plan.leftover.map((left) => left.id)).toEqual([sixHourly.id]);
  });

  it("keeps an object schedule with long pauses running, even when its runs are closer together", () => {
    // Every half hour during office hours on weekdays: its runs are 30 minutes apart, but it
    // leaves every night and the whole weekend without a run. Replacing the tenant's daily backup
    // with it would leave the mailbox 64 hours without a backup every weekend.
    const tenantWide = row({ kind: "backup", ...cron("0 2 * * *") });
    const office = row({
      kind: "backup",
      protectedObjectId: "obj-office",
      ...cron("*/30 9-17 * * 1-5"),
    });
    // Two runs an hour apart on the first of the month: once a month, not every hour.
    const monthly = row({
      kind: "backup",
      protectedObjectId: "obj-monthly",
      ...cron("0 2,3 1 * *"),
    });
    const plan = planMailMigration([tenantWide, office, monthly], NOW);
    expect(plan.members).toEqual([]);
    expect(plan.supersede).toEqual([tenantWide.id]);
    expect(plan.leftover).toEqual([
      { id: office.id, kind: "backup", protectedObjectId: "obj-office", reason: "less_frequent" },
      { id: monthly.id, kind: "backup", protectedObjectId: "obj-monthly", reason: "less_frequent" },
    ]);
  });

  it("keeps an object's restore check with long pauses running next to the job's", () => {
    const verify = row({ kind: "verify", ...cron("0 3 * * *") });
    const weekdays = row({
      kind: "verify",
      protectedObjectId: "obj-1",
      ...cron("0 */4 * * 1-5"),
    });
    const plan = planMailMigration([verify, weekdays], NOW);
    expect(plan.members).toEqual([]);
    expect(plan.leftover).toEqual([
      { id: weekdays.id, kind: "verify", protectedObjectId: "obj-1", reason: "less_frequent" },
    ]);
  });

  it("still makes an override of a cron schedule that never leaves a longer pause than the job's", () => {
    const tenantWide = row({ kind: "backup", ...cron("0 2 * * *") });
    const sixHourly = row({ kind: "backup", protectedObjectId: "obj-1", ...cron("0 */6 * * *") });
    const plan = planMailMigration([tenantWide, sixHourly], NOW);
    expect(plan.members.map((member) => member.overrides)).toEqual([
      { schedule: { kind: "cron", cron: "0 */6 * * *", timeZone: ZONE } },
    ]);
    expect(plan.leftover).toEqual([]);
  });

  it("replaces an object schedule that repeats the job's cadence, and needs no member for it", () => {
    const tenantWide = row({ kind: "backup", ...every(480) });
    const same = row({ kind: "backup", protectedObjectId: "obj-1", ...every(480) });
    const plan = planMailMigration([tenantWide, same], NOW);
    expect(plan.supersede).toContain(same.id);
    expect(plan.members).toEqual([]);
  });

  it("without a tenant-wide schedule, the most common object cadence is the job's and covers only those objects", () => {
    const a = row({
      kind: "backup",
      protectedObjectId: "obj-a",
      ...every(480),
      nextRunAt: new Date("2026-10-02T11:00:00.000Z"),
    });
    const b = row({
      kind: "backup",
      protectedObjectId: "obj-b",
      ...every(480),
      nextRunAt: new Date("2026-10-02T12:00:00.000Z"),
    });
    const c = row({ kind: "backup", protectedObjectId: "obj-c", ...cron("0 2 * * *") });
    const plan = planMailMigration([a, b, c], NOW);
    expect(plan.scopeMode).toBe("selected");
    expect(plan.schedule).toMatchObject({ kind: "interval", intervalMinutes: 480 });
    expect(plan.nextRunAt).toEqual(a.nextRunAt);
    expect(plan.members.map((m) => [m.protectedObjectId, Object.keys(m.overrides)])).toEqual([
      ["obj-a", []],
      ["obj-b", []],
      ["obj-c", ["schedule"]],
    ]);
    expect([...plan.supersede].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("does not let an object's own backup schedule start protecting every object when only verify is tenant-wide", () => {
    const verify = row({ kind: "verify", ...cron("0 3 * * 0") });
    const own = row({ kind: "backup", protectedObjectId: "obj-1", ...every(480) });
    const plan = planMailMigration([verify, own], NOW);
    expect(plan.scopeMode).toBe("all");
    expect(plan.schedule).toBeNull();
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]?.overrides.schedule).toMatchObject({ intervalMinutes: 480 });
  });

  it("gives an object its own restore-check schedule when it runs at least as often", () => {
    const verify = row({ kind: "verify", ...cron("0 3 * * 0") });
    const own = row({ kind: "verify", protectedObjectId: "obj-1", ...cron("0 3 * * *") });
    const plan = planMailMigration([verify, own], NOW);
    expect(plan.members[0]?.overrides.verifySchedule).toEqual({
      kind: "cron",
      cron: "0 3 * * *",
      timeZone: ZONE,
    });
    expect(plan.members[0]?.verifyNextRunAt).toEqual(own.nextRunAt);
  });

  it("leaves a schedule that cannot be planned where it is", () => {
    const good = row({ kind: "backup", ...every(480) });
    const broken = row({ kind: "backup", ...cron("not a cron"), protectedObjectId: "obj-1" });
    const plan = planMailMigration([good, broken], NOW);
    expect(plan.leftover).toEqual([
      { id: broken.id, kind: "backup", protectedObjectId: "obj-1", reason: "invalid_cadence" },
    ]);
    expect(plan.supersede).not.toContain(broken.id);
  });

  it("carries the earliest timer, and a missing one means due now", () => {
    const never = row({ kind: "backup", ...every(480), nextRunAt: null, lastRunAt: null });
    const plan = planMailMigration([never], NOW);
    expect(plan.nextRunAt).toBeNull();
    expect(plan.lastRunAt).toBeNull();
  });
});

describe("mail migration, over many random tenants", () => {
  // A small deterministic generator, so a failure names a tenant that can be replayed.
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const CADENCES: readonly { intervalMinutes: number | null; cron: string | null }[] = [
    every(60),
    every(240),
    every(480),
    every(1440),
    cron("0 2 * * *"),
    cron("0 */6 * * *"),
    cron("15 */2 * * *"),
    cron("*/30 9-17 * * 1-5"),
    cron("0 2 * * 1-5"),
    cron("0 3 * * 0"),
    cron("0 2,3 1 * *"),
  ];
  const gapsSeen = new Map<string, number>();
  /** The longest stretch a schedule leaves an object without a run (infinite: none). */
  function longestPause(schedule: JobSchedule | null | undefined): number {
    if (!schedule) {
      return Number.POSITIVE_INFINITY;
    }
    const key = JSON.stringify(schedule);
    if (!gapsSeen.has(key)) {
      gapsSeen.set(key, scheduleGaps(schedule, NOW)?.max ?? Number.POSITIVE_INFINITY);
    }
    return gapsSeen.get(key) as number;
  }
  const scheduleOf = (row: LegacyScheduleRow) =>
    jobScheduleFromCadence({
      intervalMinutes: row.intervalMinutes,
      cron: row.cron,
      timezone: row.timezone,
    });

  /**
   * How well one object is protected for one kind: the shortest of the longest pauses of the
   * schedules that cover it (several schedules together never pause longer than the best one).
   */
  function protectionBefore(
    rows: readonly LegacyScheduleRow[],
    kind: "backup" | "verify",
    object: string,
  ): number {
    return Math.min(
      ...rows
        .filter((r) => r.kind === kind && r.enabled && (r.protectedObjectId ?? object) === object)
        .map((r) => longestPause(scheduleOf(r))),
    );
  }

  function protectionAfter(
    rows: readonly LegacyScheduleRow[],
    plan: MailMigrationPlan,
    kind: "backup" | "verify",
    object: string,
  ): number {
    if (!plan.create) {
      return protectionBefore(rows, kind, object);
    }
    const pauses: number[] = [];
    const member = plan.members.find((m) => m.protectedObjectId === object);
    if (plan.scopeMode === "all" || member) {
      const own = kind === "backup" ? member?.overrides.schedule : member?.overrides.verifySchedule;
      pauses.push(longestPause(own ?? (kind === "backup" ? plan.schedule : plan.verifySchedule)));
    }
    const left = new Set(plan.leftover.map((l) => l.id));
    for (const r of rows) {
      if (left.has(r.id) && r.kind === kind && (r.protectedObjectId ?? object) === object) {
        pauses.push(longestPause(scheduleOf(r)));
      }
    }
    return Math.min(...pauses);
  }

  it("never leaves an object less protected than the best schedule that covered it, and accounts for every schedule", () => {
    const next = random(20261002);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const objects = ["obj-a", "obj-b", "obj-c", "obj-d"];
    for (let tenant = 0; tenant < 500; tenant++) {
      const rows: LegacyScheduleRow[] = [];
      for (const kind of ["backup", "verify"] as const) {
        const tenantWide = Math.floor(next() * 3);
        for (let i = 0; i < tenantWide; i++) {
          rows.push(row({ kind, ...pick(CADENCES), enabled: next() < 0.8 }));
        }
        const own = Math.floor(next() * 4);
        for (let i = 0; i < own; i++) {
          rows.push(
            row({
              kind,
              protectedObjectId: pick(objects),
              ...pick(CADENCES),
              enabled: next() < 0.85,
            }),
          );
        }
      }
      const plan = planMailMigration(rows, NOW);
      const context = `tenant ${tenant}: ${JSON.stringify(rows.map((r) => [r.kind, r.protectedObjectId, r.intervalMinutes ?? r.cron, r.enabled]))}`;
      for (const object of objects) {
        for (const kind of ["backup", "verify"] as const) {
          expect(
            protectionAfter(rows, plan, kind, object),
            `${context} ${kind} ${object}`,
          ).toBeLessThanOrEqual(protectionBefore(rows, kind, object));
        }
      }
      if (plan.create) {
        // Every schedule is either replaced or left running, never both and never forgotten.
        const replaced = new Set(plan.supersede);
        const left = new Set(plan.leftover.map((l) => l.id));
        for (const r of rows) {
          expect(replaced.has(r.id) && left.has(r.id), context).toBe(false);
          if (r.enabled) {
            expect(replaced.has(r.id) || left.has(r.id), context).toBe(true);
          }
        }
      }
    }
  });
});

describe("endpoint migration", () => {
  let created = 0;
  function machine(
    id: string,
    patch: Partial<EndpointConfig> = {},
    options: Partial<LegacyEndpointRow> = {},
  ): LegacyEndpointRow {
    created++;
    const os = options.os ?? "linux";
    const profile = options.profile ?? "server";
    return {
      id,
      os,
      profile,
      config: {
        ...defaultEndpointConfig(os as "linux" | "darwin", profile, { timeZone: ZONE }),
        ...patch,
      },
      settings: {},
      createdAt: new Date(`2026-09-${String(created).padStart(2, "0")}T08:00:00.000Z`),
      ...options,
    };
  }

  it("makes one job of machines with the same configuration and none of their overrides", () => {
    const plans = planEndpointMigration([machine("a"), machine("b"), machine("c")]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.members.map((m) => m.endpointId)).toEqual(["a", "b", "c"]);
    expect(plans[0]?.members.every((m) => Object.keys(m.overrides).length === 0)).toBe(true);
    expect(plans[0]?.schedule).toMatchObject({ kind: "daily", timeOfDay: "22:00" });
  });

  it("splits by profile, operating system and schedule", () => {
    const plans = planEndpointMigration([
      machine("srv1"),
      machine("srv2", { schedule: { kind: "daily", timeOfDay: "02:00", timeZone: ZONE } }),
      machine("mac", {}, { os: "darwin", profile: "client" }),
      machine("srv3"),
    ]);
    expect(plans.map((p) => [p.profile, p.os, p.members.map((m) => m.endpointId)])).toEqual([
      ["server", "linux", ["srv1", "srv3"]],
      ["server", "linux", ["srv2"]],
      ["client", "darwin", ["mac"]],
    ]);
  });

  it("keeps what most machines share and turns the difference into an override", () => {
    const plans = planEndpointMigration([
      machine("a"),
      machine("fileserver", { paths: ["/srv", "/data"], bandwidthKbps: 5000 }),
      machine("b"),
    ]);
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.settings.paths).toEqual(
      defaultEndpointConfig("linux", "server", { timeZone: ZONE }).paths,
    );
    expect(plan?.members.find((m) => m.endpointId === "fileserver")?.overrides).toEqual({
      paths: ["/srv", "/data"],
      bandwidthKbps: 5000,
    });
    expect(plan?.members.find((m) => m.endpointId === "a")?.overrides).toEqual({});
  });

  it("carries bandwidth windows a configuration already has, and states limit and windows together", () => {
    const night = [{ days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 }];
    const plans = planEndpointMigration([
      machine("a", { bandwidthKbps: 500, bandwidthWindows: night }),
      machine("b", { bandwidthKbps: 500, bandwidthWindows: night }),
      machine("other-limit", { bandwidthKbps: 100, bandwidthWindows: night }),
      machine("no-windows", { bandwidthKbps: 500 }),
    ]);
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.settings).toMatchObject({ bandwidthKbps: 500, bandwidthWindows: night });
    const overrides = (id: string) => plan?.members.find((m) => m.endpointId === id)?.overrides;
    expect(overrides("a")).toEqual({});
    // The job's windows would otherwise be dropped from a machine that has its own limit.
    expect(overrides("other-limit")).toEqual({ bandwidthKbps: 100, bandwidthWindows: night });
    expect(overrides("no-windows")).toEqual({ bandwidthKbps: 500, bandwidthWindows: [] });
  });

  it("lets the machine enrolled first decide a tie", () => {
    const plans = planEndpointMigration([
      machine("first", { paths: ["/one"] }),
      machine("second", { paths: ["/two"] }),
    ]);
    expect(plans[0]?.settings.paths).toEqual(["/one"]);
    expect(plans[0]?.members.find((m) => m.endpointId === "second")?.overrides.paths).toEqual([
      "/two",
    ]);
  });

  it("carries retention, with the product default made explicit where a job sets one", () => {
    const withRetention = (id: string) => ({
      ...machine(id),
      settings: { retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 } },
    });
    const plans = planEndpointMigration([withRetention("a"), withRetention("b"), machine("c")]);
    expect(plans[0]?.settings.retention).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    expect(plans[0]?.members.find((m) => m.endpointId === "c")?.overrides.retention).toEqual({
      keepDaily: 30,
      keepWeekly: 12,
      keepMonthly: 12,
    });
  });

  it("gives every machine back exactly the configuration it has (nothing lost, nothing to write)", () => {
    const rows = [
      machine("a"),
      machine("b", { paths: ["/srv"], excludes: ["*.iso"], hooks: { pre: "dump" } }),
      machine("c", { bandwidthKbps: 1000, onlyOnAcPower: true }),
      machine("d", { schedule: { kind: "daily", timeOfDay: "02:00", timeZone: ZONE } }),
      machine(
        "e",
        { schedule: { kind: "on_connect", intervalMinutes: 240, timeZone: ZONE } },
        { os: "darwin", profile: "client" },
      ),
    ];
    const plans = planEndpointMigration(rows);
    const seen = new Set<string>();
    for (const plan of plans) {
      for (const member of plan.members) {
        const source = rows.find((r) => r.id === member.endpointId) as LegacyEndpointRow;
        expect(seen.has(member.endpointId)).toBe(false);
        seen.add(member.endpointId);
        const built = buildEndpointConfig(
          source.config,
          effectiveSchedule(plan.schedule, member.overrides),
          effectiveSettings(plan.settings, member.overrides),
        );
        expect(sameEndpointConfig(built, source.config)).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("does not put machines whose interval schedules name different time zones into one job", () => {
    // Two administrators in different zones set "every hour" on two machines: the schedules
    // differ only in `timeZone`, which the agent receives as it is. One job would rewrite one of
    // them (and raise its configVersion), which the migration promises never to do.
    const rows = [
      machine("berlin", { schedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE } }),
      machine("utc", { schedule: { kind: "interval", intervalMinutes: 60, timeZone: "UTC" } }),
    ];
    const plans = planEndpointMigration(rows);
    for (const plan of plans) {
      for (const member of plan.members) {
        const source = rows.find((r) => r.id === member.endpointId) as LegacyEndpointRow;
        const built = buildEndpointConfig(
          source.config,
          effectiveSchedule(plan.schedule, member.overrides),
          effectiveSettings(plan.settings, member.overrides),
        );
        expect(sameEndpointConfig(built, source.config), member.endpointId).toBe(true);
      }
    }
    expect(plans).toHaveLength(2);
  });

  it("leaves a schedule alone that carries a field its kind does not use", () => {
    // The 0.1.0 API stored a schedule as it was sent: a daily schedule with an interval as well
    // means the same to the agent, so it must neither be rewritten nor get a new version.
    const rows = [
      machine("plain", { schedule: { kind: "daily", timeOfDay: "02:00", timeZone: ZONE } }),
      machine("extra", {
        schedule: { kind: "daily", timeOfDay: "02:00", intervalMinutes: 60, timeZone: ZONE },
      }),
    ];
    const plans = planEndpointMigration(rows);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.schedule).toEqual({ kind: "daily", timeOfDay: "02:00", timeZone: ZONE });
    for (const member of plans[0]?.members ?? []) {
      const source = rows.find((r) => r.id === member.endpointId) as LegacyEndpointRow;
      const built = buildEndpointConfig(
        source.config,
        effectiveSchedule(plans[0]?.schedule ?? null, member.overrides),
        effectiveSettings(plans[0]?.settings ?? {}, member.overrides),
      );
      expect(sameEndpointConfig(built, source.config), member.endpointId).toBe(true);
    }
  });

  it("reproduces every machine of many random tenants exactly, and puts each in one job", () => {
    let state = 4242;
    const next = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const zones = [ZONE, "UTC", "America/New_York"];
    const schedules: (() => EndpointConfig["schedule"])[] = [
      () => ({ kind: "daily", timeOfDay: pick(["02:00", "22:00"]), timeZone: pick(zones) }),
      () => ({ kind: "interval", intervalMinutes: pick([60, 240]), timeZone: pick(zones) }),
      () => ({ kind: "on_connect", intervalMinutes: 240, timeZone: pick(zones) }),
      () => ({ kind: "on_connect", timeZone: pick(zones) }),
      () => ({ kind: "daily", timeOfDay: "02:00", intervalMinutes: 60, timeZone: pick(zones) }),
    ];
    for (let tenant = 0; tenant < 200; tenant++) {
      const rows: LegacyEndpointRow[] = [];
      const count = 1 + Math.floor(next() * 6);
      for (let index = 0; index < count; index++) {
        const darwin = next() < 0.3;
        const base = machine(
          `t${tenant}-m${index}`,
          {},
          {
            os: darwin ? "darwin" : "linux",
            profile: next() < 0.5 ? "server" : "client",
          },
        );
        const config: EndpointConfig = {
          ...base.config,
          schedule: pick(schedules)(),
          paths: pick([base.config.paths, ["/srv"], ["/home", "/etc"]]),
          excludes: pick([base.config.excludes, [], ["*.iso"]]),
          hooks: pick([{}, { pre: "dump.sh" }, { pre: "", post: "" }, { post: "notify.sh" }]),
          bandwidthKbps: pick([null, 1000, 5000]),
          onlyOnAcPower: next() < 0.2,
        };
        const retention = pick([
          undefined,
          { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
          { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
        ]);
        rows.push({ ...base, config, settings: retention ? { retention } : {} });
      }
      const plans = planEndpointMigration(rows);
      const seen = new Set<string>();
      for (const plan of plans) {
        for (const member of plan.members) {
          const source = rows.find((r) => r.id === member.endpointId) as LegacyEndpointRow;
          expect(seen.has(member.endpointId)).toBe(false);
          seen.add(member.endpointId);
          const settings = effectiveSettings(plan.settings, member.overrides);
          const built = buildEndpointConfig(
            source.config,
            effectiveSchedule(plan.schedule, member.overrides),
            settings,
          );
          expect(sameEndpointConfig(built, source.config), JSON.stringify(source)).toBe(true);
          // The retention the machine keeps (its own, else the product default) does not change.
          expect(retentionToWrite(settings.retention, source.settings.retention)).toBeNull();
        }
      }
      expect(seen.size).toBe(rows.length);
    }
  });

  it("returns nothing for no machines", () => {
    expect(planEndpointMigration([])).toEqual([]);
  });
});
