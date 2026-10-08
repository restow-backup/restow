import { describe, expect, it } from "vitest";

import type { EndpointDetail } from "./api.js";
import {
  DEFAULTS,
  buildPatch,
  changedSections,
  checkDraft,
  draftFromDetail,
  hasProblems,
  linesOf,
  scheduleOf,
  stricterRetention,
} from "./settings-form.js";

type Base = Pick<EndpointDetail, "displayName" | "config" | "settings" | "profile">;

function server(over: Partial<Base> = {}): Base {
  return {
    displayName: "Mail server",
    profile: "server",
    config: {
      profile: "server",
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
      paths: ["/etc", "/home"],
      excludes: ["*.tmp", "node_modules"],
      hooks: { pre: "pg_dumpall > /var/backups/all.sql" },
      bandwidthKbps: null,
      onlyOnAcPower: false,
      useVss: false,
    },
    settings: {
      retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      staleAfterHours: 2,
      staleAfterDays: 7,
      quotaGib: null,
    },
    ...over,
  };
}

function client(): Base {
  const base = server();
  return {
    ...base,
    profile: "client",
    config: {
      ...base.config,
      profile: "client",
      schedule: { kind: "on_connect", intervalMinutes: 240, timeZone: "Europe/Berlin" },
      hooks: {},
    },
  };
}

describe("a stricter retention of a machine", () => {
  it("counts the restore points of each kind it keeps fewer, and nothing for a longer one", () => {
    const before = { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 };
    expect(stricterRetention(before, { keepDaily: 30, keepWeekly: 4, keepMonthly: 6 })).toEqual({
      keepDaily: 0,
      keepWeekly: 8,
      keepMonthly: 6,
    });
    expect(
      stricterRetention(before, { keepDaily: 31, keepWeekly: 12, keepMonthly: 12 }),
    ).toBeNull();
    expect(stricterRetention(before, undefined)).toBeNull();
  });
});

describe("the settings draft", () => {
  it("starts from what the server holds", () => {
    const draft = draftFromDetail(server(), "UTC");
    expect(draft).toMatchObject({
      displayName: "Mail server",
      paths: ["/etc", "/home"],
      excludes: "*.tmp\nnode_modules",
      scheduleKind: "daily",
      timeOfDay: "22:00",
      timeZone: "Europe/Berlin",
      preHook: "pg_dumpall > /var/backups/all.sql",
      postHook: "",
      bandwidthKbps: "",
      keepDaily: "30",
    });
  });

  it("sends nothing when nothing changed", () => {
    expect(buildPatch(server(), draftFromDetail(server(), "UTC"))).toBeNull();
    expect(buildPatch(client(), draftFromDetail(client(), "UTC"))).toBeNull();
    expect(changedSections(server(), draftFromDetail(server(), "UTC"))).toEqual([]);
  });

  it("sends only the part that changed", () => {
    const draft = { ...draftFromDetail(server(), "UTC"), timeOfDay: "03:30" };
    expect(buildPatch(server(), draft)).toEqual({
      config: {
        schedule: { kind: "daily", timeOfDay: "03:30", timeZone: "Europe/Berlin" },
      },
    });
    expect(changedSections(server(), draft)).toEqual(["schedule"]);
  });

  it("builds a minimal body across name, folders, patterns, limits, retention and alerts", () => {
    const draft = {
      ...draftFromDetail(server(), "UTC"),
      displayName: "  Mail  ",
      paths: ["/etc", "  ", "/srv"],
      excludes: "*.tmp\n\n  cache  \n",
      bandwidthKbps: "2048",
      onlyOnAcPower: true,
      keepDaily: "14",
      staleAfterHours: "6",
    };
    expect(buildPatch(server(), draft)).toEqual({
      displayName: "Mail",
      config: {
        paths: ["/etc", "/srv"],
        excludes: ["*.tmp", "cache"],
        bandwidthKbps: 2048,
        onlyOnAcPower: true,
      },
      settings: {
        retention: { keepDaily: 14, keepWeekly: 12, keepMonthly: 12 },
        staleAfterHours: 6,
      },
    });
  });

  it("clears the name and the bandwidth limit with null", () => {
    const withLimit = server();
    withLimit.config = { ...withLimit.config, bandwidthKbps: 500 };
    const draft = { ...draftFromDetail(withLimit, "UTC"), displayName: " ", bandwidthKbps: "" };
    expect(buildPatch(withLimit, draft)).toEqual({
      displayName: null,
      config: { bandwidthKbps: null },
    });
  });

  it("sends both hooks when one changes, because the API replaces them as a pair", () => {
    const draft = { ...draftFromDetail(server(), "UTC"), postHook: "systemctl start app" };
    expect(buildPatch(server(), draft)?.config?.hooks).toEqual({
      pre: "pg_dumpall > /var/backups/all.sql",
      post: "systemctl start app",
    });
    const cleared = { ...draftFromDetail(server(), "UTC"), preHook: "  " };
    expect(buildPatch(server(), cleared)?.config?.hooks).toEqual({});
  });

  it("ignores whitespace-only differences in hooks", () => {
    const draft = {
      ...draftFromDetail(server(), "UTC"),
      preHook: "pg_dumpall > /var/backups/all.sql\n",
    };
    expect(buildPatch(server(), draft)).toBeNull();
  });

  it("uses the alert threshold that belongs to the profile", () => {
    const draft = {
      ...draftFromDetail(client(), "UTC"),
      staleAfterDays: "14",
      staleAfterHours: "9",
    };
    expect(buildPatch(client(), draft)).toEqual({ settings: { staleAfterDays: 14 } });
  });

  it("reduces a schedule to the fields of its kind", () => {
    const base = draftFromDetail(server(), "UTC");
    expect(scheduleOf({ ...base, scheduleKind: "interval", intervalMinutes: "60" })).toEqual({
      kind: "interval",
      intervalMinutes: 60,
      timeZone: "Europe/Berlin",
    });
    expect(scheduleOf({ ...base, scheduleKind: "on_connect", intervalMinutes: "" })).toEqual({
      kind: "on_connect",
      timeZone: "Europe/Berlin",
    });
    expect(scheduleOf({ ...base, scheduleKind: "on_connect", intervalMinutes: "120" })).toEqual({
      kind: "on_connect",
      intervalMinutes: 120,
      timeZone: "Europe/Berlin",
    });
  });

  it("switches the schedule kind in one patch", () => {
    const draft = {
      ...draftFromDetail(server(), "UTC"),
      scheduleKind: "interval" as const,
      intervalMinutes: "360",
    };
    expect(buildPatch(server(), draft)?.config?.schedule).toEqual({
      kind: "interval",
      intervalMinutes: 360,
      timeZone: "Europe/Berlin",
    });
  });
});

describe("the storage budget in the draft", () => {
  it("is empty while the installation's default applies, and sends only a change", () => {
    const base = server();
    const draft = draftFromDetail(base, "UTC");
    expect(draft.quotaGib).toBe("");
    expect(buildPatch(base, { ...draft, quotaGib: "500" })).toEqual({
      settings: { quotaGib: 500 },
    });
    const own = server({ settings: { ...base.settings, quotaGib: 500 } });
    expect(draftFromDetail(own, "UTC").quotaGib).toBe("500");
    expect(buildPatch(own, draftFromDetail(own, "UTC"))).toBeNull();
    // Emptied: back to the installation's default.
    expect(buildPatch(own, { ...draftFromDetail(own, "UTC"), quotaGib: "" })).toEqual({
      settings: { quotaGib: null },
    });
  });

  it("takes whole GiB from 1 up to 1 PiB", () => {
    const draft = draftFromDetail(server(), "UTC");
    expect(checkDraft({ ...draft, quotaGib: "0" }, "server").quotaGib?.code).toBe("range");
    expect(checkDraft({ ...draft, quotaGib: "1.5" }, "server").quotaGib?.code).toBe("integer");
    expect(
      checkDraft({ ...draft, quotaGib: String(1024 * 1024 + 1) }, "server").quotaGib?.code,
    ).toBe("range");
    expect(checkDraft({ ...draft, quotaGib: "1" }, "server").quotaGib).toBeUndefined();
  });
});

describe("checking the draft", () => {
  const ok = () => draftFromDetail(server(), "UTC");

  it("accepts what the server holds", () => {
    expect(hasProblems(checkDraft(ok(), "server"))).toBe(false);
    expect(hasProblems(checkDraft(draftFromDetail(client(), "UTC"), "client"))).toBe(false);
  });

  it("refuses what the API would refuse", () => {
    expect(checkDraft({ ...ok(), paths: [" "] }, "server").paths?.code).toBe("noPaths");
    expect(checkDraft({ ...ok(), paths: ["relative/path"] }, "server").paths).toMatchObject({
      code: "notAbsolute",
      values: { value: "relative/path" },
    });
    expect(checkDraft({ ...ok(), paths: ["/ok", "/bad\u0001"] }, "server").paths?.code).toBe(
      "controlCharacters",
    );
    expect(checkDraft({ ...ok(), timeOfDay: "25:00" }, "server").timeOfDay?.code).toBe("timeOfDay");
    expect(
      checkDraft({ ...ok(), scheduleKind: "interval", intervalMinutes: "2" }, "server")
        .intervalMinutes,
    ).toMatchObject({ code: "range", values: { min: 5 } });
    expect(
      checkDraft({ ...ok(), scheduleKind: "interval", intervalMinutes: "" }, "server")
        .intervalMinutes?.code,
    ).toBe("required");
    expect(checkDraft({ ...ok(), bandwidthKbps: "fast" }, "server").bandwidthKbps?.code).toBe(
      "integer",
    );
    expect(checkDraft({ ...ok(), keepDaily: "99999" }, "server").keepDaily?.code).toBe("range");
    expect(checkDraft({ ...ok(), staleAfterHours: "0" }, "server").staleAfterHours?.code).toBe(
      "range",
    );
    expect(checkDraft({ ...ok(), preHook: "x".repeat(4097) }, "server").preHook?.code).toBe(
      "tooLong",
    );
  });

  it("lets an on-connect schedule leave the minimum interval empty", () => {
    const draft = { ...ok(), scheduleKind: "on_connect" as const, intervalMinutes: "" };
    expect(checkDraft(draft, "client").intervalMinutes).toBeUndefined();
  });

  it("checks only the alert threshold of the profile", () => {
    const draft = { ...ok(), staleAfterDays: "" };
    expect(checkDraft(draft, "server").staleAfterDays).toBeUndefined();
    expect(checkDraft(draft, "client").staleAfterDays?.code).toBe("required");
  });

  it("splits patterns by line and drops empty ones", () => {
    expect(linesOf("a\r\n\n b \n")).toEqual(["a", "b"]);
  });

  it("documents the defaults the form shows", () => {
    expect(DEFAULTS.retention).toEqual({ keepDaily: 30, keepWeekly: 12, keepMonthly: 12 });
    expect(DEFAULTS.staleAfterHours).toBe(2);
    expect(DEFAULTS.staleAfterDays).toBe(7);
    expect(DEFAULTS.clientSchedule.intervalMinutes).toBe(240);
  });
});

describe("time windows of a machine without a job", () => {
  const windows = [
    { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
    { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
  ];
  const withWindows = (): Base => {
    const base = server();
    return { ...base, config: { ...base.config, bandwidthKbps: 500, bandwidthWindows: windows } };
  };

  it("reads them into rows and sends nothing while they are as they were", () => {
    const draft = draftFromDetail(withWindows(), "UTC");
    expect(draft.bandwidthWindows.map((row) => row.kbps)).toEqual(["2000", "0"]);
    expect(buildPatch(withWindows(), draft)).toBeNull();
    expect(draftFromDetail(server(), "UTC").bandwidthWindows).toEqual([]);
  });

  it("does not send them again when they were only reordered", () => {
    const draft = draftFromDetail(withWindows(), "UTC");
    const reordered = { ...draft, bandwidthWindows: [...draft.bandwidthWindows].reverse() };
    expect(buildPatch(withWindows(), reordered)).toBeNull();
  });

  it("sends the windows in the order of the week when they changed, and null when none are left", () => {
    const draft = draftFromDetail(server(), "UTC");
    const added = {
      ...draft,
      bandwidthWindows: [
        { key: "w0", days: [7, 6], from: "00:00", to: "00:00", kbps: "0" },
        { key: "w1", days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: "2000" },
      ],
    };
    expect(buildPatch(server(), added)).toEqual({
      config: {
        bandwidthWindows: [
          { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
          { days: [6, 7], from: "00:00", to: "00:00", kbps: 0 },
        ],
      },
    });
    const removed = { ...draftFromDetail(withWindows(), "UTC"), bandwidthWindows: [] };
    expect(buildPatch(withWindows(), removed)).toEqual({ config: { bandwidthWindows: null } });
    expect(changedSections(withWindows(), removed)).toContain("bandwidthWindows");
  });

  it("blocks the save while a row is wrong", () => {
    const draft = draftFromDetail(withWindows(), "UTC");
    expect(checkDraft(draft, "server").bandwidthWindows).toBeUndefined();
    const broken = {
      ...draft,
      bandwidthWindows: [{ key: "w0", days: [], from: "08:00", to: "18:00", kbps: "5" }],
    };
    expect(checkDraft(broken, "server").bandwidthWindows?.code).toBe("windows");
    const overlapping = {
      ...draft,
      bandwidthWindows: [
        { key: "w0", days: [1], from: "08:00", to: "12:00", kbps: "5" },
        { key: "w1", days: [1], from: "11:00", to: "14:00", kbps: "5" },
      ],
    };
    expect(checkDraft(overlapping, "server").bandwidthWindows?.code).toBe("windows");
  });
});
