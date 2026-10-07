import { describe, expect, it } from "vitest";

import { type OverdueCandidate, overdueNotification, overdueOf } from "./overdue.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const bounds = { mail: 48, machines: 336 };

const mailbox = (id: string, hours: number, backedUp = true): OverdueCandidate => ({
  kind: "object",
  id,
  name: `${id}@contoso.example`,
  since: hoursAgo(hours),
  backedUp,
});
const machine = (id: string, hours: number): OverdueCandidate => ({
  kind: "endpoint",
  id,
  name: id,
  since: hoursAgo(hours),
  backedUp: true,
});

describe("backup.overdue", () => {
  it("raises for what is past the bound of its kind, by the schedules", () => {
    const due = overdueOf(
      [mailbox("fresh", 10), mailbox("late", 50), machine("weekly", 100), machine("gone", 400)],
      bounds,
      new Map(),
      NOW,
    );
    expect(due.map((candidate) => candidate.id)).toEqual(["late", "gone"]);
  });

  it("announces an object once per stretch, and again after a backup ended it", () => {
    const late = mailbox("late", 50);
    expect(overdueOf([late], bounds, new Map([["object:late", hoursAgo(1)]]), NOW)).toEqual([]);
    // Announced before its newest backup: a new stretch, a new alert.
    expect(overdueOf([late], bounds, new Map([["object:late", hoursAgo(60)]]), NOW)).toEqual([
      late,
    ]);
  });

  it("names the object, the machine and the bound in days", () => {
    expect(overdueNotification("t", mailbox("late", 50), bounds)).toMatchObject({
      event: "backup.overdue",
      level: "warning",
      details: { protectedObjectId: "late", objectName: "late@contoso.example", days: 2 },
    });
    expect(overdueNotification("t", machine("srv", 400), bounds)).toMatchObject({
      details: { endpointId: "srv", days: 14 },
    });
    expect(overdueNotification("t", mailbox("never", 50, false), bounds).message).toMatch(
      /never been backed up/,
    );
  });
});
