import { describe, expect, it } from "vitest";

import type { NotificationMatrix } from "@/features/reports/api";

import {
  applyPreset,
  changedChannels,
  channelFailure,
  channelKey,
  digestModesOf,
  draftFrom,
  groupedRows,
  lockedEventsOf,
  presetEvents,
  presetOf,
  toggleCell,
} from "./matrix-presenters";

const MATRIX: NotificationMatrix = {
  events: [
    { name: "backup.failed", group: "jobs", level: "error" },
    { name: "backup.overdue", group: "jobs", level: "warning" },
    { name: "backup.succeeded", group: "jobs", level: "info" },
    { name: "verify.red", group: "recoverability", level: "error" },
    { name: "verify.completed", group: "recoverability", level: "info" },
  ],
  channels: [
    {
      kind: "bell",
      id: "bell",
      events: ["backup.failed", "backup.overdue", "verify.red"],
      custom: false,
    },
    {
      kind: "webhook",
      id: "w1",
      name: "Ops",
      host: "discord.com",
      format: "discord",
      active: true,
      events: ["backup.failed", "backup.overdue", "backup.succeeded"],
    },
    {
      kind: "email",
      id: "r1",
      email: "ops@x.test",
      name: null,
      events: ["backup.failed"],
      weeklyReport: false,
    },
  ],
};

describe("the notification matrix", () => {
  it("groups the rows in catalog order and leaves empty groups out", () => {
    expect(groupedRows(MATRIX.events).map((group) => [group.group, group.rows.length])).toEqual([
      ["jobs", 3],
      ["recoverability", 2],
    ]);
  });

  it("offers errors only, errors and warnings, and all", () => {
    expect(presetEvents("errors", MATRIX.events)).toEqual(["backup.failed", "verify.red"]);
    expect(presetEvents("warnings", MATRIX.events)).toEqual([
      "backup.failed",
      "backup.overdue",
      "verify.red",
    ]);
    expect(presetEvents("all", MATRIX.events)).toHaveLength(5);
    expect(presetOf(["verify.red", "backup.failed"], MATRIX.events)).toBe("errors");
    expect(presetOf(["backup.failed"], MATRIX.events)).toBeNull();
  });

  it("sends only the columns that changed", () => {
    const draft = draftFrom(MATRIX);
    expect(changedChannels(MATRIX, draft)).toEqual([]);
    // Unticking "Backup succeeded" for the Discord webhook.
    const unticked = toggleCell(draft, "webhook:w1", "backup.succeeded", false, MATRIX.events);
    expect(changedChannels(MATRIX, unticked)).toEqual([
      { kind: "webhook", id: "w1", events: ["backup.failed", "backup.overdue"] },
    ]);
    // Ticking it again is no change any more.
    const back = toggleCell(unticked, "webhook:w1", "backup.succeeded", true, MATRIX.events);
    expect(changedChannels(MATRIX, back)).toEqual([]);
    const bell = applyPreset(draft, "bell", "errors", MATRIX.events);
    expect(changedChannels(MATRIX, bell)).toEqual([
      { kind: "bell", events: ["backup.failed", "verify.red"] },
    ]);
  });

  it("keeps a column in catalog order whatever the order of the clicks", () => {
    const draft = toggleCell(draftFrom(MATRIX), "email:r1", "verify.red", true, MATRIX.events);
    const more = toggleCell(draft, "email:r1", "backup.overdue", true, MATRIX.events);
    expect(more["email:r1"]).toEqual(["backup.failed", "backup.overdue", "verify.red"]);
  });

  it("names the columns", () => {
    expect(MATRIX.channels.map(channelKey)).toEqual(["bell", "webhook:w1", "email:r1"]);
  });
});

describe("locked cells, digest chips and failing channels (0.5.0)", () => {
  const rows = MATRIX.events;
  const bell = {
    kind: "bell" as const,
    id: "bell" as const,
    events: ["backup.failed" as const, "verify.red" as const],
    custom: true,
    locked: ["verify.red" as const],
  };
  const email = {
    kind: "email" as const,
    id: "e1",
    email: "ops@contoso.example",
    name: null,
    events: [],
    weeklyReport: false,
    delivery: { error: "immediate" as const, warning: "daily" as const, info: "hourly" as const },
    failure: { since: "2026-11-05T08:00:00.000Z", reason: "recipient_rejected", detail: null },
  };
  const webhook = {
    kind: "webhook" as const,
    id: "w9",
    name: "Ops",
    host: "discord.com",
    format: "discord" as const,
    active: true,
    events: [],
    health: {
      status: "failing" as const,
      failingSince: "2026-11-05T07:00:00.000Z",
      consecutiveFailures: 4,
      lastError: "http_error 500",
      alertedAt: "2026-11-05T07:30:00.000Z",
    },
  };

  it("locks the bell's critical events and nothing of the other columns", () => {
    expect(lockedEventsOf(bell)).toEqual(["verify.red"]);
    expect(lockedEventsOf({ ...bell, locked: undefined })).toEqual([]);
    expect(lockedEventsOf(email)).toEqual([]);
  });

  it("keeps the locked events on when a preset is applied", () => {
    const draft = draftFrom({ events: rows, channels: [bell] });
    const next = applyPreset(draft, "bell", "errors", rows, ["verify.red"]);
    expect(next.bell).toContain("verify.red");
    const info = applyPreset(draft, "bell", "all", rows, ["verify.red"]);
    expect(info.bell).toEqual(rows.map((row) => row.name));
  });

  it("lists the digest modes of an e-mail column that are not at once", () => {
    expect(digestModesOf(email)).toEqual([
      ["warning", "daily"],
      ["info", "hourly"],
    ]);
    expect(
      digestModesOf({
        ...email,
        delivery: { error: "immediate", warning: "immediate", info: "immediate" },
      }),
    ).toEqual([]);
    expect(digestModesOf(webhook)).toEqual([]);
  });

  it("says why a webhook or an address fails, and nothing while they get through", () => {
    expect(channelFailure(webhook)).toEqual({
      since: "2026-11-05T07:00:00.000Z",
      reason: "http_error 500",
      attempts: 4,
    });
    expect(channelFailure(email)).toEqual({
      since: "2026-11-05T08:00:00.000Z",
      reason: "recipient_rejected",
      attempts: null,
    });
    expect(
      channelFailure({
        ...webhook,
        health: { ...webhook.health, status: "ok", failingSince: null, consecutiveFailures: 0 },
      }),
    ).toBeNull();
    expect(channelFailure({ ...email, failure: null })).toBeNull();
    expect(channelFailure(bell)).toBeNull();
  });
});
