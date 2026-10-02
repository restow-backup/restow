import { describe, expect, it } from "vitest";
import {
  addMembersSchema,
  createBackupJobSchema,
  memberOverridesSchema,
  replaceMembersSchema,
  runBackupJobSchema,
  updateBackupJobSchema,
} from "./schemas.js";

const ID = "6b1c4d2e-0000-4000-8000-000000000001";
const schedule = { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" };

describe("backup job requests", () => {
  it("fills in what a request may leave out", () => {
    const parsed = createBackupJobSchema.parse({ kind: "mail", name: "  Mail  " });
    expect(parsed).toMatchObject({
      name: "Mail",
      enabled: true,
      moveMembers: false,
      scope: { mode: "selected", members: [] },
      settings: {},
    });
  });

  it("checks folders, exclusions, size, bandwidth and retention", () => {
    const ok = {
      kind: "endpoint",
      name: "Servers",
      schedule,
      settings: {
        paths: ["/srv", "C:\\Data"],
        excludes: ["*.iso"],
        excludeLargerThanGib: 4,
        bandwidthKbps: 2000,
        hooks: { pre: "dump" },
        retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
      },
    };
    expect(createBackupJobSchema.safeParse(ok).success).toBe(true);
    const bad = (settings: Record<string, unknown>) =>
      createBackupJobSchema.safeParse({ ...ok, settings });
    expect(bad({ paths: ["relative"] }).success).toBe(false);
    expect(bad({ paths: [] }).success).toBe(false);
    expect(bad({ paths: ["/a\u0000b"] }).success).toBe(false);
    expect(bad({ excludes: ["x".repeat(513)] }).success).toBe(false);
    expect(bad({ excludeLargerThanGib: 0 }).success).toBe(false);
    expect(bad({ bandwidthKbps: 0 }).success).toBe(false);
    expect(bad({ bandwidthKbps: 10_000_001 }).success).toBe(false);
    expect(bad({ retention: { keepDaily: -1, keepWeekly: 0, keepMonthly: 0 } }).success).toBe(
      false,
    );
  });

  it("takes time windows of the bandwidth limit and checks their shape", () => {
    const window = { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 };
    const job = (bandwidthWindows: unknown) =>
      createBackupJobSchema.safeParse({
        kind: "endpoint",
        name: "Servers",
        schedule,
        settings: { paths: ["/srv"], bandwidthKbps: 500, bandwidthWindows },
      });
    expect(job([window]).success).toBe(true);
    // A window of 0 is unlimited; no windows at all is fine.
    expect(job([{ ...window, kbps: 0 }]).success).toBe(true);
    expect(job([]).success).toBe(true);
    // Unknown settings are stripped, so a window must be a named field to survive.
    expect(
      createBackupJobSchema.parse({
        kind: "endpoint",
        name: "S",
        settings: { bandwidthWindows: [window] },
      }).settings.bandwidthWindows,
    ).toEqual([window]);
    for (const bad of [
      { ...window, days: [] },
      { ...window, days: [0] },
      { ...window, days: [8] },
      { ...window, days: [1.5] },
      { ...window, from: "8:00" },
      { ...window, to: "24:00" },
      { ...window, kbps: -1 },
      { ...window, kbps: 1.5 },
      { ...window, kbps: 10_000_001 },
      { from: "08:00", to: "18:00", kbps: 1 },
    ]) {
      expect(job([bad]).success, JSON.stringify(bad)).toBe(false);
    }
    expect(job(Array.from({ length: 25 }, () => window)).success).toBe(false);
    // A member's own setting and a patch take them too.
    expect(
      memberOverridesSchema.safeParse({ bandwidthKbps: 100, bandwidthWindows: [window] }).success,
    ).toBe(true);
    expect(
      updateBackupJobSchema.safeParse({ settings: { bandwidthWindows: [window] } }).success,
    ).toBe(true);
  });

  it("refuses a name that is empty or too long, and a patch that changes nothing", () => {
    expect(createBackupJobSchema.safeParse({ kind: "mail", name: "   " }).success).toBe(false);
    expect(createBackupJobSchema.safeParse({ kind: "mail", name: "x".repeat(121) }).success).toBe(
      false,
    );
    expect(updateBackupJobSchema.safeParse({}).success).toBe(false);
    expect(updateBackupJobSchema.safeParse({ schedule: null }).success).toBe(true);
    expect(updateBackupJobSchema.safeParse({ settings: {} }).success).toBe(true);
  });

  it("takes members by id, with overrides, and bounds the lists", () => {
    expect(addMembersSchema.safeParse({ members: [] }).success).toBe(false);
    expect(addMembersSchema.safeParse({ members: [{ id: "nope" }] }).success).toBe(false);
    expect(addMembersSchema.parse({ members: [{ id: ID }] })).toEqual({
      members: [{ id: ID }],
      move: false,
    });
    expect(replaceMembersSchema.safeParse({ members: [] }).success).toBe(true);
    expect(memberOverridesSchema.safeParse({ schedule, bandwidthKbps: null }).success).toBe(true);
  });

  it("runs the whole job or the chosen members", () => {
    expect(runBackupJobSchema.parse({})).toEqual({ full: false });
    expect(runBackupJobSchema.safeParse({ targetIds: [] }).success).toBe(false);
    expect(runBackupJobSchema.parse({ targetIds: [ID], full: true })).toEqual({
      targetIds: [ID],
      full: true,
    });
  });
});
