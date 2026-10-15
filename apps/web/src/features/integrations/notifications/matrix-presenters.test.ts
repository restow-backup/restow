import { describe, expect, it } from "vitest";

import type { NotificationMatrix } from "@/features/reports/api";

import {
  applyPreset,
  changedChannels,
  channelKey,
  draftFrom,
  groupedRows,
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
