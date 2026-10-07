import { describe, expect, it } from "vitest";

import { defaults, endpointJob, mailJob, member } from "./fixtures.js";
import {
  MASKED_HOOK,
  cadenceOfJobSchedule,
  checkEndpointSchedule,
  checkJobDraft,
  checkOverrides,
  checkSettings,
  createInputOf,
  draftOfJob,
  endpointScheduleDraftOf,
  jobHasProblems,
  jobScheduleOfCadence,
  jobScheduleOfEndpointDraft,
  newJobDraft,
  overrideGroupsSet,
  overridesDraftOf,
  overridesOfDraft,
  retentionReduction,
  scheduleKeyOf,
  scopeChanged,
  settingsDraftOf,
  settingsOfDraft,
  updateInputOf,
} from "./form.js";

describe("a stricter machine retention", () => {
  const before = { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 };
  it("says how many restore points of each kind fewer each machine keeps", () => {
    const draft = { ...settingsDraftOf({}, before), retentionOwn: true, keepDaily: "7" };
    expect(retentionReduction(before, draft)).toEqual({
      keepDaily: 23,
      keepWeekly: 0,
      keepMonthly: 0,
    });
  });

  it("is nothing when no value goes down or each machine keeps its own", () => {
    const longer = { ...settingsDraftOf({}, before), retentionOwn: true, keepDaily: "60" };
    expect(retentionReduction(before, longer)).toBeNull();
    const own = { ...settingsDraftOf({}, before), retentionOwn: false, keepDaily: "1" };
    expect(retentionReduction(before, own)).toBeNull();
  });
});

describe("schedules", () => {
  it("turns the cadence of the form into a mail schedule: an interval or a cron expression", () => {
    expect(jobScheduleOfCadence({ intervalMinutes: 480, cron: null }, "UTC")).toEqual({
      kind: "interval",
      intervalMinutes: 480,
      timeZone: "UTC",
    });
    expect(
      jobScheduleOfCadence({ intervalMinutes: null, cron: "0 2 * * *" }, "Europe/Berlin"),
    ).toEqual({
      kind: "cron",
      cron: "0 2 * * *",
      timeZone: "Europe/Berlin",
    });
  });

  it("reads a stored mail schedule back, a daily time as the cron expression it stands for", () => {
    expect(cadenceOfJobSchedule({ kind: "daily", timeOfDay: "04:30", timeZone: "UTC" })).toEqual({
      intervalMinutes: null,
      cron: "30 4 * * *",
    });
    expect(
      cadenceOfJobSchedule({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" }),
    ).toEqual({
      intervalMinutes: 60,
      cron: null,
    });
    expect(cadenceOfJobSchedule({ kind: "on_connect", timeZone: "UTC" })).toBeNull();
  });

  it("keeps only the fields of a machine schedule's kind", () => {
    const base = { intervalMinutes: "", timeOfDay: "22:00", timeZone: " Europe/Berlin " };
    expect(jobScheduleOfEndpointDraft({ ...base, kind: "daily", intervalMinutes: "99" })).toEqual({
      kind: "daily",
      timeOfDay: "22:00",
      timeZone: "Europe/Berlin",
    });
    expect(
      jobScheduleOfEndpointDraft({ ...base, kind: "interval", intervalMinutes: "60" }),
    ).toEqual({
      kind: "interval",
      intervalMinutes: 60,
      timeZone: "Europe/Berlin",
    });
    expect(jobScheduleOfEndpointDraft({ ...base, kind: "on_connect" })).toEqual({
      kind: "on_connect",
      timeZone: "Europe/Berlin",
    });
    expect(
      jobScheduleOfEndpointDraft({ ...base, kind: "on_connect", intervalMinutes: "240" }),
    ).toEqual({ kind: "on_connect", intervalMinutes: 240, timeZone: "Europe/Berlin" });
  });

  it("checks a machine schedule against the agent contract: 5 minutes to a week", () => {
    const draft = endpointScheduleDraftOf(
      { kind: "interval", intervalMinutes: 60, timeZone: "UTC" },
      null,
      "UTC",
    );
    expect(checkEndpointSchedule(draft)).toEqual({});
    expect(checkEndpointSchedule({ ...draft, intervalMinutes: "4" }).intervalMinutes).toMatchObject(
      {
        code: "range",
        values: { min: 5, max: 10080 },
      },
    );
    expect(
      checkEndpointSchedule({ ...draft, intervalMinutes: "10081" }).intervalMinutes?.code,
    ).toBe("range");
    expect(checkEndpointSchedule({ ...draft, intervalMinutes: "" }).intervalMinutes?.code).toBe(
      "required",
    );
    expect(checkEndpointSchedule({ ...draft, intervalMinutes: "1.5" }).intervalMinutes?.code).toBe(
      "integer",
    );
    // On connect the minutes are optional.
    expect(checkEndpointSchedule({ ...draft, kind: "on_connect", intervalMinutes: "" })).toEqual(
      {},
    );
    expect(
      checkEndpointSchedule({ ...draft, kind: "daily", timeOfDay: "25:00" }).timeOfDay?.code,
    ).toBe("timeOfDay");
    expect(checkEndpointSchedule({ ...draft, timeZone: " " }).timeZone?.code).toBe("required");
  });

  it("tells two schedules apart by what their kind uses", () => {
    expect(scheduleKeyOf(null)).toBe("none");
    expect(scheduleKeyOf({ kind: "cron", cron: " 0  2 * * * ", timeZone: "UTC" })).toBe(
      scheduleKeyOf({ kind: "cron", cron: "0 2 * * *", timeZone: "UTC" }),
    );
    expect(scheduleKeyOf({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" })).not.toBe(
      scheduleKeyOf({ kind: "interval", intervalMinutes: 61, timeZone: "UTC" }),
    );
  });
});

describe("the settings of a machine job", () => {
  const draft = settingsDraftOf(endpointJob().settings);

  it("reads the stored settings into the form and back, without losing anything", () => {
    expect(draft.paths).toEqual(["/etc", "/var/www"]);
    expect(draft.largerEnabled).toBe(true);
    expect(draft.largerGib).toBe("4");
    expect(draft.bandwidth).toBe("20000");
    expect(draft.preHook).toBe("db-dump");
    expect(draft.retentionOwn).toBe(true);
    expect(settingsOfDraft(draft)).toEqual(endpointJob().settings);
  });

  it("sends the whole object, with null where a limit is lifted and an empty object for no hooks", () => {
    const cleared = {
      ...draft,
      largerEnabled: false,
      bandwidth: "",
      preHook: "",
      retentionOwn: false,
    };
    expect(settingsOfDraft(cleared)).toEqual({
      paths: ["/etc", "/var/www"],
      excludes: endpointJob().settings.excludes,
      excludeLargerThanGib: null,
      hooks: {},
      bandwidthKbps: null,
    });
  });

  it("checks everything the API would refuse", () => {
    expect(checkSettings(draft)).toEqual({});
    expect(checkSettings({ ...draft, paths: [] }).paths?.code).toBe("paths.none");
    expect(checkSettings({ ...draft, paths: ["relative"] }).paths).toMatchObject({
      code: "paths.notAbsolute",
      values: { value: "relative" },
    });
    expect(checkSettings({ ...draft, excludes: ["bad\npattern"] }).excludes?.code).toBe(
      "excludes.controlCharacters",
    );
    expect(checkSettings({ ...draft, largerGib: "0" }).larger?.code).toBe("larger");
    expect(checkSettings({ ...draft, bandwidth: "0" }).bandwidth?.code).toBe("range");
    expect(checkSettings({ ...draft, bandwidth: "10000001" }).bandwidth?.code).toBe("range");
    expect(checkSettings({ ...draft, bandwidth: "10000000" }).bandwidth).toBeUndefined();
    expect(checkSettings({ ...draft, preHook: "x".repeat(4097) }).hooks?.code).toBe("hookTooLong");
    expect(checkSettings({ ...draft, keepDaily: "3651" }).keepDaily?.code).toBe("range");
    expect(checkSettings({ ...draft, keepWeekly: "521" }).keepWeekly?.code).toBe("range");
    expect(checkSettings({ ...draft, keepMonthly: "241" }).keepMonthly?.code).toBe("range");
    expect(
      checkSettings({ ...draft, keepMonthly: "240", keepWeekly: "520", keepDaily: "3650" }),
    ).toEqual({});
  });

  it("checks only the retention numbers when the job sets a retention", () => {
    expect(checkSettings({ ...draft, retentionOwn: false, keepDaily: "oops" })).toEqual({});
  });

  it("never saves a hook text the API hid: it blocks the save instead", () => {
    const hidden = settingsDraftOf({ ...endpointJob().settings, hooks: { pre: MASKED_HOOK } });
    expect(hidden.hooksHidden).toBe(true);
    expect(checkSettings(hidden).hooks?.code).toBe("hooksHidden");
  });
});

describe("a new job", () => {
  it("starts from the recommended values of the kind", () => {
    const mail = newJobDraft("mail", defaults("mail"));
    expect(mail).toMatchObject({
      kind: "mail",
      name: "",
      enabled: true,
      scheduleOn: true,
      verifyOn: true,
      scopeMode: "selected",
    });
    expect(mail.cadence).toMatchObject({
      presetType: "every_hours",
      hours: "8",
      timezone: "Europe/Berlin",
    });
    const machines = newJobDraft("endpoint", defaults("endpoint"));
    expect(machines.endpointSchedule).toMatchObject({ kind: "daily", timeOfDay: "22:00" });
    expect(machines.settings.paths).toEqual(["/etc", "/home"]);
    expect(machines.verifyOn).toBe(false);
    expect(machines.settings.retentionOwn).toBe(false);
    expect(machines.settings.keepDaily).toBe("30");
  });

  it("asks for a name and, for a machine job, a folder", () => {
    const draft = newJobDraft("endpoint", defaults("endpoint"));
    expect(checkJobDraft(draft).name?.code).toBe("nameRequired");
    expect(checkJobDraft({ ...draft, name: "x".repeat(121) }).name?.code).toBe("nameTooLong");
    expect(jobHasProblems(checkJobDraft({ ...draft, name: "Servers" }))).toBe(false);
    const none = checkJobDraft({
      ...draft,
      name: "Servers",
      settings: { ...draft.settings, paths: [] },
    });
    expect(none.settings?.paths?.code).toBe("paths.none");
  });

  it("does not limit the scope of a mail job to anything: an empty job is allowed", () => {
    const draft = { ...newJobDraft("mail", defaults("mail")), name: "Mail" };
    expect(jobHasProblems(checkJobDraft(draft))).toBe(false);
  });

  it("builds the create request: a mail job with its schedules and policy, scope, no settings", () => {
    const draft = {
      ...newJobDraft("mail", defaults("mail")),
      name: "  Executive board  ",
      scopeMode: "selected" as const,
      selected: [
        { id: "o1", kind: "mailbox" as const, name: "Anna", detail: null, job: null },
        {
          id: "o2",
          kind: "mailbox" as const,
          name: "Ben",
          detail: null,
          job: null,
          overrides: {
            schedule: { kind: "interval" as const, intervalMinutes: 60, timeZone: "UTC" },
          },
        },
      ],
      retentionPolicyId: "p-90",
    };
    const input = createInputOf(draft);
    expect(input).toMatchObject({
      kind: "mail",
      name: "Executive board",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" },
      verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: "Europe/Berlin" },
      retentionPolicyId: "p-90",
      settings: {},
      enabled: true,
    });
    expect(input.scope).toEqual({
      mode: "selected",
      members: [
        { id: "o1" },
        {
          id: "o2",
          overrides: { schedule: { kind: "interval", intervalMinutes: 60, timeZone: "UTC" } },
        },
      ],
    });
    expect(input).not.toHaveProperty("moveMembers");
  });

  it("sends no schedule for a mail job that runs by hand, and no restore check when it is off", () => {
    const draft = {
      ...newJobDraft("mail", defaults("mail")),
      name: "Manual",
      scheduleOn: false,
      verifyOn: false,
    };
    const input = createInputOf(draft);
    expect(input.schedule).toBeNull();
    expect(input.verifySchedule).toBeNull();
  });

  it("asks to move the objects that belong to another job only when told", () => {
    const draft = {
      ...newJobDraft("endpoint", defaults("endpoint")),
      name: "Moved",
      selected: [
        {
          id: "m1",
          kind: "server" as const,
          name: "A",
          detail: null,
          job: { id: "j", name: "Old" },
        },
      ],
      moves: ["m1"],
    };
    expect(createInputOf(draft).moveMembers).toBe(true);
    expect(createInputOf({ ...draft, moves: [] })).not.toHaveProperty("moveMembers");
    expect(createInputOf({ ...draft, moves: [] }, { moveMembers: true }).moveMembers).toBe(true);
  });

  it("builds a machine job request: the whole settings object, no restore check, always on", () => {
    const draft = {
      ...newJobDraft("endpoint", defaults("endpoint")),
      name: "Servers",
      enabled: false,
    };
    const input = createInputOf(draft);
    expect(input).toMatchObject({
      kind: "endpoint",
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
      settings: {
        paths: ["/etc", "/home"],
        excludes: ["**/.cache"],
        bandwidthKbps: null,
        excludeLargerThanGib: null,
        hooks: {},
      },
      // A machine job cannot be paused: it is created switched on whatever the draft says.
      enabled: true,
    });
    expect(input).not.toHaveProperty("verifySchedule");
    expect(input).not.toHaveProperty("retentionPolicyId");
  });
});

describe("changing a job", () => {
  const job = mailJob();
  const base = draftOfJob(job, [], defaults("mail"));

  it("sends nothing when nothing changed, the daily cron and the interval round trip", () => {
    expect(updateInputOf(job, base)).toBeNull();
    const interval = mailJob({
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: "UTC" },
    });
    expect(updateInputOf(interval, draftOfJob(interval, [], defaults("mail")))).toBeNull();
    const daily = mailJob({
      schedule: { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" },
    });
    expect(updateInputOf(daily, draftOfJob(daily, [], defaults("mail")))).toBeNull();
  });

  it("sends only what changed", () => {
    expect(updateInputOf(job, { ...base, name: "  Renamed " })).toEqual({ name: "Renamed" });
    expect(updateInputOf(job, { ...base, enabled: false })).toEqual({ enabled: false });
    expect(updateInputOf(job, { ...base, verifyOn: false })).toEqual({ verifySchedule: null });
    expect(updateInputOf(job, { ...base, retentionPolicyId: "p-90" })).toEqual({
      retentionPolicyId: "p-90",
    });
    expect(updateInputOf(job, { ...base, scheduleOn: false })).toEqual({ schedule: null });
    const faster = {
      ...base,
      cadence: { ...base.cadence, presetType: "every_hours" as const, hours: "4" },
    };
    expect(updateInputOf(job, faster)).toEqual({
      schedule: { kind: "interval", intervalMinutes: 240, timeZone: "Europe/Berlin" },
    });
  });

  it("sends the settings of a machine job whole when any of them changed (the API replaces them)", () => {
    const machines = endpointJob();
    const draft = draftOfJob(machines, [], defaults("endpoint"));
    expect(updateInputOf(machines, draft)).toBeNull();
    const patch = updateInputOf(machines, {
      ...draft,
      settings: { ...draft.settings, bandwidth: "" },
    });
    expect(patch).toEqual({ settings: { ...machines.settings, bandwidthKbps: null } });
    expect(patch?.settings?.paths).toEqual(["/etc", "/var/www"]);
    // The pause switch is not a machine job's to send.
    expect(updateInputOf(machines, { ...draft, enabled: false })).toBeNull();
  });

  it("knows when the scope changed: the mode, or the members that are named", () => {
    const named = [
      member({ targetId: "a" }),
      member({ targetId: "b" }),
      member({ targetId: "c", explicit: false }),
    ];
    const selected = endpointJob();
    const draft = draftOfJob(selected, named, defaults("endpoint"));
    expect(draft.selected.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(scopeChanged(selected, named, draft)).toBe(false);
    expect(scopeChanged(selected, named, { ...draft, selected: draft.selected.slice(1) })).toBe(
      true,
    );
    expect(scopeChanged(selected, named, { ...draft, scopeMode: "all" })).toBe(true);
    const all = mailJob();
    expect(scopeChanged(all, named, draftOfJob(all, named, defaults("mail")))).toBe(false);
  });

  it("keeps a member's overrides in the draft so saving the scope does not drop them", () => {
    const own = { schedule: { kind: "interval" as const, intervalMinutes: 60, timeZone: "UTC" } };
    const draft = draftOfJob(
      endpointJob(),
      [member({ targetId: "a", overrides: own })],
      defaults("endpoint"),
    );
    expect(draft.selected[0]?.overrides).toEqual(own);
  });
});

describe("the overrides of one member", () => {
  const job = endpointJob();

  it("switches on what the member does differently and starts the rest from the job", () => {
    const overrides = {
      paths: ["/srv"],
      bandwidthKbps: null,
      schedule: { kind: "interval" as const, intervalMinutes: 60, timeZone: "UTC" },
    };
    const target = member({
      overrides,
      effective: {
        schedule: overrides.schedule,
        verifySchedule: null,
        settings: { ...job.settings, paths: ["/srv"], bandwidthKbps: null },
      },
    });
    const draft = overridesDraftOf("endpoint", target, job, defaults("endpoint"));
    expect(draft.on).toEqual({
      schedule: true,
      verify: false,
      folders: true,
      exclusions: false,
      bandwidth: true,
      hooks: false,
      retention: false,
    });
    expect(draft.settings.paths).toEqual(["/srv"]);
    expect(draft.endpointSchedule).toMatchObject({ kind: "interval", intervalMinutes: "60" });
    expect(overrideGroupsSet(overrides)).toEqual(["schedule", "folders", "bandwidth"]);
  });

  it("sends only the groups that are on, an empty object when none is (which clears them)", () => {
    const draft = overridesDraftOf("endpoint", member(), job, defaults("endpoint"));
    expect(overridesOfDraft(draft)).toEqual({});
    const folders = {
      ...draft,
      on: { ...draft.on, folders: true },
      settings: { ...draft.settings, paths: ["/srv", "/opt"] },
    };
    expect(overridesOfDraft(folders)).toEqual({ paths: ["/srv", "/opt"] });
    const exclusions = {
      ...draft,
      on: { ...draft.on, exclusions: true },
      settings: { ...draft.settings, excludes: ["*.iso"], largerEnabled: false },
    };
    expect(overridesOfDraft(exclusions)).toEqual({
      excludes: ["*.iso"],
      excludeLargerThanGib: null,
    });
    const hooks = {
      ...draft,
      on: { ...draft.on, hooks: true },
      settings: { ...draft.settings, preHook: "", postHook: "ok" },
    };
    expect(overridesOfDraft(hooks)).toEqual({ hooks: { post: "ok" } });
    const retention = { ...draft, on: { ...draft.on, retention: true } };
    expect(overridesOfDraft(retention).retention).toEqual({
      keepDaily: 14,
      keepWeekly: 8,
      keepMonthly: 6,
    });
  });

  it("checks only the groups that are on", () => {
    const draft = overridesDraftOf("endpoint", member(), job, defaults("endpoint"));
    const broken = { ...draft.settings, paths: [], bandwidth: "0" };
    expect(checkOverrides({ ...draft, settings: broken })).toEqual({});
    const checked = checkOverrides({
      ...draft,
      on: { ...draft.on, folders: true },
      settings: broken,
    });
    expect(checked.settings?.paths?.code).toBe("paths.none");
    expect(checked.settings?.bandwidth).toBeUndefined();
  });

  it("offers a mail member its own schedule and its own restore check", () => {
    const mail = mailJob();
    const target = member({
      kind: "mailbox",
      overrides: { verifySchedule: { kind: "interval", intervalMinutes: 1440, timeZone: "UTC" } },
      effective: {
        schedule: mail.schedule,
        verifySchedule: { kind: "interval", intervalMinutes: 1440, timeZone: "UTC" },
        settings: {},
      },
    });
    const draft = overridesDraftOf("mail", target, mail, defaults("mail"));
    expect(draft.on).toMatchObject({ schedule: false, verify: true });
    expect(overridesOfDraft(draft)).toEqual({
      verifySchedule: { kind: "interval", intervalMinutes: 1440, timeZone: "UTC" },
    });
    expect(
      checkOverrides({ ...draft, verifyCadence: { ...draft.verifyCadence, hours: "" } })
        .verifyCadence,
    ).toBe(true);
  });
});

describe("time windows in the settings", () => {
  const windows = [
    { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
    { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
  ];
  const withWindows = () =>
    endpointJob({ settings: { ...endpointJob().settings, bandwidthWindows: windows } });

  it("reads the windows into rows and back, and leaves the key out when there are none", () => {
    const draft = settingsDraftOf(withWindows().settings);
    expect(draft.bandwidthWindows.map((row) => [row.days, row.from, row.to, row.kbps])).toEqual([
      [[1, 2, 3, 4, 5], "08:00", "18:00", "2000"],
      [[1, 2, 3, 4, 5], "22:00", "06:00", "0"],
    ]);
    expect(settingsOfDraft(draft)).toEqual(withWindows().settings);
    // No rows: no key, so saving the whole object removes the windows a job had.
    const none = settingsOfDraft({ ...draft, bandwidthWindows: [] });
    expect(none).not.toHaveProperty("bandwidthWindows");
    expect(settingsDraftOf(endpointJob().settings).bandwidthWindows).toEqual([]);
  });

  it("blocks the save while a row is wrong, and only when the bandwidth part is checked", () => {
    const draft = settingsDraftOf(withWindows().settings);
    expect(checkSettings(draft)).toEqual({});
    const broken = {
      ...draft,
      bandwidthWindows: [
        ...draft.bandwidthWindows,
        { ...(draft.bandwidthWindows[0] as object), key: "w9", kbps: "" } as never,
      ],
    };
    expect(checkSettings(broken).bandwidthWindows?.code).toBe("windows.fix");
    // An override of something else does not check windows the member does not have.
    expect(
      checkSettings(broken, {
        folders: true,
        exclusions: false,
        bandwidth: false,
        hooks: false,
        retention: false,
      }).bandwidthWindows,
    ).toBeUndefined();
    const overlapping = {
      ...draft,
      bandwidthWindows: [
        draft.bandwidthWindows[0] as never,
        {
          ...(draft.bandwidthWindows[0] as object),
          key: "w9",
          from: "17:00",
          to: "19:00",
        } as never,
      ],
    };
    expect(checkSettings(overlapping).bandwidthWindows?.code).toBe("windows.fix");
    expect(
      checkJobDraft({
        ...draftOfJob(withWindows(), [], defaults("endpoint")),
        settings: overlapping,
      }).settings?.bandwidthWindows?.code,
    ).toBe("windows.fix");
  });

  it("sends the settings only when the windows really changed, not when they were reordered", () => {
    const job = withWindows();
    const draft = draftOfJob(job, [], defaults("endpoint"));
    expect(updateInputOf(job, draft)).toBeNull();
    const reordered = {
      ...draft,
      settings: {
        ...draft.settings,
        bandwidthWindows: [...draft.settings.bandwidthWindows].reverse(),
      },
    };
    expect(updateInputOf(job, reordered)).toBeNull();
    const respelled = {
      ...draft,
      settings: {
        ...draft.settings,
        bandwidthWindows: draft.settings.bandwidthWindows.map((row) => ({
          ...row,
          days: [...row.days].reverse(),
        })),
      },
    };
    expect(updateInputOf(job, respelled)).toBeNull();
    const faster = {
      ...draft,
      settings: {
        ...draft.settings,
        bandwidthWindows: draft.settings.bandwidthWindows.map((row, index) =>
          index === 0 ? { ...row, kbps: "5000" } : row,
        ),
      },
    };
    expect(updateInputOf(job, faster)?.settings?.bandwidthWindows?.[0]).toMatchObject({
      kbps: 5000,
    });
    // Taking the last window away removes the key from the whole object that is sent.
    const lifted = { ...draft, settings: { ...draft.settings, bandwidthWindows: [] } };
    const patch = updateInputOf(job, lifted);
    expect(patch?.settings).toBeDefined();
    expect(patch?.settings).not.toHaveProperty("bandwidthWindows");
  });

  it("puts the limit and the windows of a member together: one switch, both sent", () => {
    const job = withWindows();
    const own = [{ days: [6, 7], from: "06:00", to: "22:00", kbps: 4000 }];
    const target = member({
      overrides: { bandwidthKbps: 100, bandwidthWindows: own },
      effective: {
        schedule: job.schedule,
        verifySchedule: null,
        settings: { ...job.settings, bandwidthKbps: 100, bandwidthWindows: own },
      },
    });
    const draft = overridesDraftOf("endpoint", target, job, defaults("endpoint"));
    expect(draft.on.bandwidth).toBe(true);
    expect(draft.settings.bandwidthWindows.map((row) => row.kbps)).toEqual(["4000"]);
    expect(overrideGroupsSet(target.overrides)).toEqual(["bandwidth"]);
    expect(overridesOfDraft(draft)).toEqual({ bandwidthKbps: 100, bandwidthWindows: own });
    // Without rows the member states "no windows" next to its own limit.
    const unlimited = {
      ...draft,
      settings: { ...draft.settings, bandwidth: "", bandwidthWindows: [] },
    };
    expect(overridesOfDraft(unlimited)).toEqual({ bandwidthKbps: null, bandwidthWindows: [] });
  });

  it("shows an override that only names windows as a bandwidth override too", () => {
    const own = [{ days: [1], from: "08:00", to: "09:00", kbps: 1 }];
    expect(overrideGroupsSet({ bandwidthWindows: own })).toEqual(["bandwidth"]);
    const job = withWindows();
    const target = member({
      overrides: { bandwidthWindows: own },
      effective: {
        schedule: job.schedule,
        verifySchedule: null,
        settings: { ...job.settings, bandwidthWindows: own },
      },
    });
    expect(overridesDraftOf("endpoint", target, job, defaults("endpoint")).on.bandwidth).toBe(true);
    // A member that has nothing of the kind follows the job.
    expect(overridesDraftOf("endpoint", member(), job, defaults("endpoint")).on.bandwidth).toBe(
      false,
    );
  });
});
