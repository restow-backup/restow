import { describe, expect, it } from "vitest";

import { defaults, endpointJob } from "./fixtures.js";
import {
  checkCopyJobDraft,
  checkShareJobDraft,
  checkShareSchedule,
  cleanExtension,
  copyCreateInputOf,
  copyUpdateInputOf,
  draftOfCopyJob,
  draftOfShareJob,
  mirrorConfirmationMatches,
  newCopyJobDraft,
  newShareJobDraft,
  newShareScheduleDraft,
  shareCreateInputOf,
  shareMembersChanged,
  shareScheduleDraftOf,
  shareScheduleOf,
  shareUpdateInputOf,
} from "./share-form.js";

/**
 * The editors of file share jobs and copy jobs as data (docs/FILESHARES.md 7.5, 12.5, 12.6): the
 * checks mirror the API, a stored daily schedule comes back as a time, and an edit sends only
 * what changed.
 */

const ZONE = "Europe/Berlin";

describe("the schedule of a share or copy job", () => {
  it("reads a daily cron back as a time and keeps any other cron", () => {
    expect(
      shareScheduleDraftOf({ kind: "cron", cron: "30 21 * * *", timeZone: ZONE }, ZONE),
    ).toMatchObject({
      kind: "daily",
      timeOfDay: "21:30",
    });
    expect(
      shareScheduleDraftOf({ kind: "cron", cron: "0 22 * * 1-5", timeZone: ZONE }, ZONE),
    ).toMatchObject({
      kind: "cron",
      cron: "0 22 * * 1-5",
    });
    expect(
      shareScheduleDraftOf({ kind: "interval", intervalMinutes: 360, timeZone: ZONE }, ZONE),
    ).toMatchObject({
      kind: "interval",
      intervalHours: "6",
    });
  });

  it("runs at most once an hour and wants five cron fields", () => {
    const base = newShareScheduleDraft(ZONE);
    expect(
      checkShareSchedule({ ...base, kind: "interval", intervalHours: "0" }).intervalHours?.code,
    ).toBe("range");
    expect(checkShareSchedule({ ...base, kind: "interval", intervalHours: "1" })).toEqual({});
    expect(checkShareSchedule({ ...base, kind: "cron", cron: "0 22 * *" }).cron?.code).toBe("cron");
    expect(checkShareSchedule({ ...base, timeOfDay: "25:00" }).timeOfDay?.code).toBe("timeOfDay");
    expect(shareScheduleOf({ ...base, kind: "interval", intervalHours: "4" })).toEqual({
      kind: "interval",
      intervalMinutes: 240,
      timeZone: ZONE,
    });
  });
});

describe("a file share job", () => {
  it("keeps file types the way the API does and refuses what it would refuse", () => {
    expect(cleanExtension("*.ISO")).toBe("ISO");
    expect(cleanExtension(".bak")).toBe("bak");
    expect(cleanExtension("a b")).toBeNull();
    const draft = { ...newShareJobDraft(undefined), name: "Nightly" };
    expect(checkShareJobDraft(draft)).toEqual({});
    expect(checkShareJobDraft({ ...draft, name: "" }).name?.code).toBe("nameRequired");
    expect(checkShareJobDraft({ ...draft, fileTypes: ["a b"] }).fileTypes?.code).toBe("fileType");
    expect(checkShareJobDraft({ ...draft, largerOn: true, largerGib: "0" }).larger?.code).toBe(
      "larger",
    );
    expect(checkShareJobDraft({ ...draft, readConcurrency: "17" }).readConcurrency?.code).toBe(
      "range",
    );
  });

  it("creates with the shares and their folders, moving shares only when one is in another job", () => {
    const draft = {
      ...newShareJobDraft(defaults("endpoint")),
      name: "Nightly",
      members: [
        { id: "s1", name: "Projects", detail: null, job: null, includes: ["Finance"] },
        { id: "s2", name: "Archive", detail: null, job: null, includes: [] },
      ],
    };
    const input = shareCreateInputOf(draft);
    expect(input).toMatchObject({
      kind: "share",
      scope: {
        mode: "selected",
        members: [{ id: "s1", overrides: { includes: ["Finance"] } }, { id: "s2" }],
      },
    });
    expect(input).not.toHaveProperty("moveMembers");
    const moving = shareCreateInputOf({
      ...draft,
      members: [
        { id: "s1", name: "Projects", detail: null, job: { id: "j", name: "Old" }, includes: [] },
      ],
    });
    expect(moving).toHaveProperty("moveMembers", true);
  });

  it("sends nothing for an edit that changed nothing, and only what changed otherwise", () => {
    const job = endpointJob({
      kind: "share",
      schedule: { kind: "cron", cron: "0 22 * * *", timeZone: ZONE },
      settings: {
        excludes: [],
        presets: { systemFiles: true },
        fileTypes: { exclude: [] },
        excludeLargerThanGib: null,
        bandwidthKbps: null,
        skipOffline: true,
        retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      },
    });
    const members = [
      {
        targetId: "s1",
        name: "Projects",
        detail: null,
        overrides: { includes: ["Finance"] },
      },
    ] as never;
    const draft = draftOfShareJob(job, members);
    expect(draft.schedule).toMatchObject({ kind: "daily", timeOfDay: "22:00" });
    expect(shareUpdateInputOf(job, draft)).toBeNull();
    expect(shareMembersChanged(members, draft)).toBe(false);
    expect(shareUpdateInputOf(job, { ...draft, fileTypes: ["iso"] })).toEqual({
      settings: expect.objectContaining({ fileTypes: { exclude: ["iso"] } }),
    });
    expect(
      shareMembersChanged(members, {
        ...draft,
        members: [{ ...draft.members[0], includes: ["Marketing"] } as never],
      }),
    ).toBe(true);
  });
});

describe("a copy job", () => {
  it("starts from the address and refuses the same share and a mirror into a root", () => {
    const draft = {
      ...newCopyJobDraft(undefined, { source: "a", target: "b", folder: "Mirror" }),
      name: "Copy",
    };
    expect(draft).toMatchObject({
      sourceId: "a",
      targetId: "b",
      targetFolder: "Mirror",
      mode: "overwrite",
    });
    expect(checkCopyJobDraft(draft)).toEqual({});
    expect(checkCopyJobDraft({ ...draft, targetId: "a" }).target?.code).toBe("copy.sameShare");
    expect(
      checkCopyJobDraft({ ...draft, mode: "mirror", targetFolder: "" }).targetFolder?.code,
    ).toBe("copy.mirrorRoot");
    expect(checkCopyJobDraft({ ...draft, targetFolder: "a/../b" }).targetFolder?.code).toBe(
      "copy.folderInvalid",
    );
  });

  it("asks for the mirror's confirmation only when the person confirmed", () => {
    const draft = {
      ...newCopyJobDraft(undefined, { source: "a", target: "b", folder: "/Mirror/" }),
      name: "Copy",
    };
    expect(copyCreateInputOf(draft)).toEqual({
      kind: "copy",
      name: "Copy",
      schedule: { kind: "daily", timeOfDay: "06:00", timeZone: ZONE },
      sourceFileShareId: "a",
      targetFileShareId: "b",
      settings: { targetFolder: "Mirror", mode: "overwrite", restorePermissions: false },
      enabled: true,
    });
    expect(copyCreateInputOf(draft, true)).toHaveProperty("confirmMirror", true);
    expect(mirrorConfirmationMatches("Mirror/", "/Mirror")).toBe(true);
    expect(mirrorConfirmationMatches("Mirro", "Mirror")).toBe(false);
    expect(mirrorConfirmationMatches("", "")).toBe(false);
  });

  it("sends only what changed on an edit", () => {
    const job = endpointJob({
      kind: "copy",
      schedule: { kind: "cron", cron: "0 6 * * *", timeZone: ZONE },
      settings: { targetFolder: "Mirror", mode: "mirror", restorePermissions: false },
      copy: {
        source: { id: "a", name: "Projects", retired: false },
        target: { id: "b", name: "Archive", retired: false, allowRestore: true },
        mode: "mirror",
        targetFolder: "Mirror",
        mirrorConfirmedAt: null,
        lastCopied: null,
      },
    });
    const draft = draftOfCopyJob(job);
    expect(copyUpdateInputOf(job, draft)).toBeNull();
    expect(copyUpdateInputOf(job, { ...draft, targetFolder: "Other" }, true)).toEqual({
      settings: { targetFolder: "Other", mode: "mirror", restorePermissions: false },
      confirmMirror: true,
    });
  });
});
