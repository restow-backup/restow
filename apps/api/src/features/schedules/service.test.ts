import type { Schedule } from "@restow/db";
import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  describeScheduleChanges,
  mergePatch,
  needsNewNextRun,
  previewSchedule,
  scheduleVisibility,
  toScheduleDto,
} from "./service.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";

function row(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "5d3c1b2a-0f9e-4d8c-8b7a-6e5d4c3b2a19",
    tenantId: TENANT,
    protectedObjectId: null,
    kind: "backup",
    intervalMinutes: 480,
    cron: null,
    timezone: "Europe/Berlin",
    enabled: true,
    nextRunAt: new Date("2026-03-01T18:00:00Z"),
    lastRunAt: new Date("2026-03-01T10:00:00Z"),
    createdAt: new Date("2026-02-01T00:00:00Z"),
    updatedAt: new Date("2026-02-02T00:00:00Z"),
    ...overrides,
  };
}

describe("toScheduleDto", () => {
  it("maps a schedule with its object and last job", () => {
    const dto = toScheduleDto(
      row({ protectedObjectId: "object-1" }),
      { id: "object-1", displayName: " ", externalId: "anna@contoso.example", kind: "mailbox" },
      { id: "job-1", status: "failed", finishedAt: "2026-03-01T10:05:00.000Z" },
    );
    expect(dto).toEqual({
      id: "5d3c1b2a-0f9e-4d8c-8b7a-6e5d4c3b2a19",
      kind: "backup",
      protectedObject: { id: "object-1", name: "anna@contoso.example", kind: "mailbox" },
      intervalMinutes: 480,
      cron: null,
      timezone: "Europe/Berlin",
      enabled: true,
      nextRunAt: "2026-03-01T18:00:00.000Z",
      lastRunAt: "2026-03-01T10:00:00.000Z",
      lastJob: { id: "job-1", status: "failed", finishedAt: "2026-03-01T10:05:00.000Z" },
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
  });

  it("shows no next run while the schedule is switched off", () => {
    expect(toScheduleDto(row({ enabled: false }), null, null).nextRunAt).toBeNull();
  });

  it("withholds another person's object and the job id from a tenant user", () => {
    const object = {
      id: "object-1",
      displayName: "Chief Executive",
      externalId: "ceo@contoso.example",
      kind: "mailbox" as const,
    };
    const lastJob = { id: "job-1", status: "failed" as const, finishedAt: null };
    const member = { role: "tenant_user" as const, email: "anna@contoso.example" };

    const foreign = toScheduleDto(
      row({ protectedObjectId: "object-1" }),
      object,
      lastJob,
      scheduleVisibility(member, { externalId: object.externalId, ownerEmail: null }),
    );
    expect(foreign.protectedObject).toEqual({ id: null, name: null, kind: "mailbox" });
    expect(foreign.lastJob).toEqual({ id: null, status: "failed", finishedAt: null });
    expect(JSON.stringify(foreign)).not.toContain("ceo@contoso.example");
    expect(JSON.stringify(foreign)).not.toContain("Chief Executive");

    // Their own mailbox (by the directory owner's address) is named, job ids stay hidden.
    const own = toScheduleDto(
      row({ protectedObjectId: "object-1" }),
      object,
      lastJob,
      scheduleVisibility(member, {
        externalId: object.externalId,
        ownerEmail: "Anna@Contoso.example",
      }),
    );
    expect(own.protectedObject).toEqual({
      id: "object-1",
      name: "Chief Executive",
      kind: "mailbox",
    });
    expect(own.lastJob?.id).toBeNull();
  });

  it("shows administrators everything", () => {
    for (const role of ["tenant_admin", "provider_admin"] as const) {
      expect(
        scheduleVisibility(
          { role, email: "admin@contoso.example" },
          { externalId: "ceo@contoso.example", ownerEmail: null },
        ),
      ).toEqual({ objectName: true, jobId: true });
    }
    expect(scheduleVisibility({ role: "tenant_user", email: "a@contoso.example" }, null)).toEqual({
      objectName: true,
      jobId: false,
    });
  });
});

describe("mergePatch", () => {
  it("replaces the cadence when either member is named and keeps it otherwise", () => {
    expect(mergePatch(row(), { cron: "0 3 * * *" })).toMatchObject({
      intervalMinutes: null,
      cron: "0 3 * * *",
    });
    expect(
      mergePatch(row({ intervalMinutes: null, cron: "0 3 * * *" }), { intervalMinutes: 60 }),
    ).toMatchObject({ intervalMinutes: 60, cron: null });
    expect(mergePatch(row(), { enabled: false })).toMatchObject({
      intervalMinutes: 480,
      cron: null,
      enabled: false,
    });
    // Both cleared: the cadence check refuses it afterwards.
    expect(mergePatch(row(), { cron: null })).toMatchObject({ intervalMinutes: null, cron: null });
  });

  it("changes or clears the scope", () => {
    expect(mergePatch(row(), { protectedObjectId: "object-2" }).protectedObjectId).toBe("object-2");
    expect(
      mergePatch(row({ protectedObjectId: "object-2" }), { protectedObjectId: null })
        .protectedObjectId,
    ).toBeNull();
  });
});

describe("describeScheduleChanges and needsNewNextRun", () => {
  it("record what changed and recompute the next run only when it matters", () => {
    const before = row();
    const paused = mergePatch(before, { enabled: false });
    expect(describeScheduleChanges(before, paused)).toEqual({
      enabled: { from: true, to: false },
    });
    expect(needsNewNextRun(before, paused)).toBe(false);

    const resumed = mergePatch(row({ enabled: false }), { enabled: true });
    expect(needsNewNextRun(row({ enabled: false }), resumed)).toBe(true);

    const moved = mergePatch(before, { cron: "30 4 * * *", timezone: "UTC" });
    expect(describeScheduleChanges(before, moved)).toEqual({
      intervalMinutes: { from: 480, to: null },
      cron: { from: null, to: "30 4 * * *" },
      timezone: { from: "Europe/Berlin", to: "UTC" },
    });
    expect(needsNewNextRun(before, moved)).toBe(true);

    expect(describeScheduleChanges(before, mergePatch(before, { intervalMinutes: 480 }))).toEqual(
      {},
    );
  });
});

describe("previewSchedule", () => {
  it("lists the next five runs across the Berlin daylight-saving switch", () => {
    expect(
      previewSchedule(
        { cron: "30 3 * * *", timezone: "Europe/Berlin" },
        new Date("2026-03-27T12:00:00Z"),
      ),
    ).toEqual({
      next: [
        "2026-03-28T02:30:00.000Z",
        "2026-03-29T01:30:00.000Z",
        "2026-03-30T01:30:00.000Z",
        "2026-03-31T01:30:00.000Z",
        "2026-04-01T01:30:00.000Z",
      ],
    });
  });

  it("starts an interval at once", () => {
    expect(
      previewSchedule({ intervalMinutes: 360, timezone: "UTC" }, new Date("2026-03-01T10:00:00Z"))
        .next,
    ).toEqual([
      "2026-03-01T10:00:00.000Z",
      "2026-03-01T16:00:00.000Z",
      "2026-03-01T22:00:00.000Z",
      "2026-03-02T04:00:00.000Z",
      "2026-03-02T10:00:00.000Z",
    ]);
  });

  it("refuses an unusable cadence with a 422 problem naming the field", () => {
    try {
      previewSchedule({ cron: "0 3 * *", timezone: "UTC" }, new Date());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).status).toBe(422);
      expect((error as ProblemError).extensions).toMatchObject({ field: "cron" });
    }
  });
});
