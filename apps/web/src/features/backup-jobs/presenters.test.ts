import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import type { SkipReason } from "./api.js";
import { endpointJob, mailJob, member, restoreCheck } from "./fixtures.js";
import "./i18n.js";
import {
  canPause,
  describeJobSchedule,
  describeScope,
  lastRunView,
  memberOutcomeTone,
  nextRunView,
  pendingBackupView,
  repositoryLabel,
  restoreCheckView,
  retentionLabel,
  runOutcomeView,
  scheduleUsesZone,
  scopeNote,
  stateView,
  switchAction,
} from "./presenters.js";

const t = (language: "en" | "de") => i18n.getFixedT(language, "backupjobs");
const tSchedules = (language: "en" | "de") => i18n.getFixedT(language, "schedules");
const ctx = (language: "en" | "de") => ({
  t: t(language),
  tSchedules: tSchedules(language),
  language,
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("describeJobSchedule", () => {
  it("puts intervals, cron expressions and daily times into words in both languages", () => {
    const interval = { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" } as const;
    expect(describeJobSchedule(interval, ctx("en"))).toBe("Every 8 hours");
    expect(describeJobSchedule(interval, ctx("de"))).toBe("Alle 8 Stunden");
    const cron = { kind: "cron", cron: "0 2 * * *", timeZone: "Europe/Berlin" } as const;
    expect(describeJobSchedule(cron, ctx("en"))).toMatch(/^Daily at 0?2:00/);
    expect(describeJobSchedule(cron, ctx("de"))).toBe("Täglich um 02:00");
    const daily = { kind: "daily", timeOfDay: "22:30", timeZone: "UTC" } as const;
    expect(describeJobSchedule(daily, ctx("de"))).toBe("Täglich um 22:30");
  });

  it("reads a machine schedule that starts when the machine is online", () => {
    const onConnect = { kind: "on_connect", timeZone: "UTC" } as const;
    expect(describeJobSchedule(onConnect, ctx("en"))).toBe("Whenever the machine is online");
    expect(describeJobSchedule({ ...onConnect, intervalMinutes: 240 }, ctx("en"))).toBe(
      "When online, at most every 4 hours",
    );
    expect(describeJobSchedule({ ...onConnect, intervalMinutes: 90 }, ctx("en"))).toBe(
      "When online, at most every 90 minutes",
    );
    expect(describeJobSchedule({ ...onConnect, intervalMinutes: 60 }, ctx("de"))).toBe(
      "Bei Verbindung, höchstens jede Stunde",
    );
  });

  it("says that a job without a schedule runs by hand", () => {
    expect(describeJobSchedule(null, ctx("en"))).toBe("Started by hand");
    expect(describeJobSchedule(null, ctx("de"))).toBe("Nur von Hand gestartet");
  });

  it("shows the time zone only for clock times", () => {
    expect(scheduleUsesZone(null)).toBe(false);
    expect(scheduleUsesZone({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" })).toBe(
      false,
    );
    expect(scheduleUsesZone({ kind: "cron", cron: "0 2 * * *", timeZone: "UTC" })).toBe(true);
    expect(scheduleUsesZone({ kind: "daily", timeOfDay: "02:00", timeZone: "UTC" })).toBe(true);
  });
});

describe("describeScope", () => {
  it("counts the kinds: mailboxes and OneDrives, servers and clients", () => {
    expect(
      describeScope({ count: 220, byKind: { mailbox: 214, onedrive: 6 } }, "mail", t("en")),
    ).toBe("214 mailboxes, 6 OneDrives");
    expect(describeScope({ count: 3, byKind: { server: 3 } }, "endpoint", t("en"))).toBe(
      "3 servers",
    );
    expect(describeScope({ count: 1, byKind: { client: 1 } }, "endpoint", t("en"))).toBe(
      "1 client",
    );
    expect(describeScope({ count: 4, byKind: { mailbox: 1, imap: 3 } }, "mail", t("de"))).toBe(
      "1 Postfach, 3 IMAP-Konten",
    );
  });

  it("says what is not counted by a kind it does not know, and what an empty scope is", () => {
    expect(describeScope({ count: 5, byKind: { mailbox: 4 } }, "mail", t("en"))).toBe(
      "4 mailboxes, 1 other",
    );
    expect(describeScope({ count: 0, byKind: {} }, "mail", t("en"))).toBe("Nothing yet");
  });

  it("notes an all job and the overrides under the counts", () => {
    expect(scopeNote(mailJob(), t("en"))).toBe(
      "Everything in no other job, new ones included · 2 with overrides",
    );
    expect(
      scopeNote(endpointJob({ scope: { count: 3, byKind: { server: 3 }, overrides: 0 } }), t("en")),
    ).toBeNull();
    expect(scopeNote(endpointJob(), t("de"))).toBe("1 mit Abweichungen");
  });
});

describe("restoreCheckView: green only when every one passed", () => {
  it("is green only for a complete pass", () => {
    const all = restoreCheckView(restoreCheck({ passed: 6, unverified: 0, total: 6 }));
    expect(all).toMatchObject({
      tone: "success",
      state: "passed",
      passed: 6,
      total: 6,
      details: [],
    });
  });

  it("is amber for warnings, objects not checked yet and objects without a backup", () => {
    expect(restoreCheckView(restoreCheck()).tone).toBe("warning");
    expect(restoreCheckView(restoreCheck({ passed: 5, unverified: 0, warning: 1 })).tone).toBe(
      "warning",
    );
    expect(restoreCheckView(restoreCheck({ passed: 5, unverified: 0, noBackup: 1 })).tone).toBe(
      "warning",
    );
  });

  it("is red when one failed, even if the rest passed", () => {
    const view = restoreCheckView(restoreCheck({ passed: 5, unverified: 0, failed: 1 }));
    expect(view).toMatchObject({ tone: "destructive", state: "failed" });
    expect(view.details).toEqual([{ key: "failed", count: 1 }]);
  });

  it("lists what is not passed, worst first, and is muted without anything to check", () => {
    const view = restoreCheckView(
      restoreCheck({ passed: 1, failed: 1, warning: 2, unverified: 3, noBackup: 4, total: 11 }),
    );
    expect(view.details.map((entry) => entry.key)).toEqual([
      "failed",
      "warning",
      "unverified",
      "noBackup",
    ]);
    expect(restoreCheckView(restoreCheck({ passed: 0, unverified: 0, total: 0 }))).toMatchObject({
      tone: "muted",
      state: "none",
    });
  });
});

describe("state, runs and the next run", () => {
  it("maps every state to a tone; running is the Lapis one and a job that is merely fine is neutral", () => {
    expect(stateView("running")).toMatchObject({ tone: "info", live: true });
    expect(stateView("ok")).toMatchObject({ tone: "neutral", key: "ok" });
    expect(stateView("queued")).toMatchObject({ tone: "muted", key: "queued", live: false });
    // A job that backs up nothing on its own never reads as the neutral "Active".
    expect(stateView("manual")).toMatchObject({ tone: "warning", key: "manual" });
    expect(stateView("overdue")).toMatchObject({ tone: "warning", key: "overdue" });
    expect(stateView("storage_error")).toMatchObject({ tone: "destructive", key: "storage_error" });
    expect(stateView("failing").tone).toBe("destructive");
    expect(stateView("attention").tone).toBe("warning");
    expect(stateView("paused").tone).toBe("muted");
    expect(stateView("empty").tone).toBe("muted");
    // Green is for a passed restore check: no state is green.
    for (const state of [
      "paused",
      "failing",
      "running",
      "queued",
      "attention",
      "empty",
      "ok",
    ] as const) {
      expect(stateView(state).tone).not.toBe("success");
    }
  });

  it("tells a job that never ran from one that runs or failed", () => {
    expect(
      lastRunView(
        mailJob({
          lastRun: { at: null, failed: 0, partial: 0, running: 0, queued: 0, runId: null },
        }),
      ).never,
    ).toBe(true);
    expect(
      lastRunView(
        mailJob({
          lastRun: { at: null, failed: 0, partial: 0, running: 2, queued: 0, runId: "r" },
        }),
      ).never,
    ).toBe(false);
    expect(
      lastRunView(
        mailJob({
          lastRun: {
            at: "2026-10-02T09:00:00Z",
            failed: 1,
            partial: 0,
            running: 0,
            queued: 0,
            runId: "r",
          },
        }),
      ),
    ).toMatchObject({
      failed: 1,
      never: false,
    });
  });

  it("gives the next run, or the reason there is none", () => {
    const base = {
      enabled: true,
      schedule: mailJob().schedule,
      nextRunAt: "2026-10-03T00:00:00Z",
      scope: { count: 5, byKind: {}, overrides: 0 },
    };
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(nextRunView(base, now)).toEqual({ kind: "at", at: "2026-10-03T00:00:00Z" });
    // Long past: overdue, not a plain "3 days ago"; a little late is not.
    expect(nextRunView({ ...base, nextRunAt: "2026-09-29T00:00:00Z" }, now)).toEqual({
      kind: "overdue",
      at: "2026-09-29T00:00:00Z",
    });
    expect(nextRunView({ ...base, nextRunAt: "2026-10-02T11:30:00Z" }, now).kind).toBe("at");
    expect(nextRunView({ ...base, enabled: false })).toEqual({ kind: "paused" });
    expect(nextRunView({ ...base, nextRunAt: null, schedule: null })).toEqual({ kind: "manual" });
    expect(
      nextRunView({ ...base, nextRunAt: null, scope: { count: 0, byKind: {}, overrides: 0 } }),
    ).toEqual({ kind: "empty" });
    expect(
      nextRunView({ ...base, nextRunAt: null, schedule: { kind: "on_connect", timeZone: "UTC" } }),
    ).toEqual({ kind: "onConnect" });
    expect(nextRunView({ ...base, nextRunAt: null })).toEqual({ kind: "unknown" });
  });

  it("tells a job with a request waiting for its machine from one that never ran", () => {
    const view = lastRunView(
      mailJob({
        lastRun: { at: null, failed: 0, partial: 0, running: 0, queued: 1, runId: null },
      }),
    );
    expect(view).toMatchObject({ queued: 1, never: false });
  });

  it("says what a requested machine backup waits for", () => {
    const now = Date.parse("2026-10-02T10:00:00.000Z");
    const pending = (over: Partial<NonNullable<ReturnType<typeof member>["pendingBackup"]>>) => ({
      status: "pending" as const,
      requestedAt: "2026-10-02T09:58:00.000Z",
      nextCheckInAt: "2026-10-02T10:03:30.000Z",
      ...over,
    });
    expect(pendingBackupView(pending({}), now)).toEqual({ kind: "waiting", minutes: 4 });
    expect(pendingBackupView(pending({ nextCheckInAt: "2026-10-02T10:00:10.000Z" }), now)).toEqual({
      kind: "waiting",
      minutes: 1,
    });
    expect(pendingBackupView(pending({ nextCheckInAt: "2026-10-02T09:59:00.000Z" }), now)).toEqual({
      kind: "due",
    });
    expect(pendingBackupView(pending({ nextCheckInAt: null }), now)).toEqual({ kind: "due" });
    expect(pendingBackupView(pending({ status: "delivered" }), now)).toEqual({ kind: "starting" });
  });

  it("words the toast of a run request: waiting is not nothing started", () => {
    const skipped = (reason: SkipReason) => ({ targetId: "m1", name: "m1", reason });
    expect(runOutcomeView({ queued: 1, skipped: [skipped("already_queued")] })).toBe("queued");
    expect(runOutcomeView({ queued: 0, skipped: [skipped("already_queued")] })).toBe("waiting");
    expect(
      runOutcomeView({
        queued: 0,
        skipped: [skipped("already_queued"), skipped("revoked")],
      }),
    ).toBe("nothing");
    expect(runOutcomeView({ queued: 0, skipped: [skipped("revoked")] })).toBe("nothing");
    expect(runOutcomeView({ queued: 0, skipped: [skipped("already_queued")] })).toBe("waiting");
    expect(runOutcomeView({ queued: 0, skipped: [skipped("excluded")] })).toBe("nothing");
  });

  it("names the tone of a member's last backup only when it needs a word", () => {
    expect(memberOutcomeTone("failed")).toBe("destructive");
    expect(memberOutcomeTone("partial")).toBe("warning");
    expect(memberOutcomeTone("running")).toBe("info");
    expect(memberOutcomeTone("queued")).toBe("muted");
    expect(memberOutcomeTone("succeeded")).toBeNull();
    expect(memberOutcomeTone(null)).toBeNull();
    expect(member().lastBackup.outcome).toBe("succeeded");
  });
});

describe("pause, repository and retention", () => {
  it("lets a mail job be paused but a machine job never: the agent decides when to back up", () => {
    expect(canPause(mailJob())).toBe(true);
    expect(canPause(endpointJob())).toBe(false);
    expect(switchAction(mailJob())).toBe("pause");
    expect(switchAction(mailJob({ enabled: false }))).toBe("resume");
    expect(switchAction(endpointJob())).toBeNull();
    // A machine job that somehow is off can still be switched on again.
    expect(switchAction(endpointJob({ enabled: false }))).toBe("resume");
  });

  it("names the repository, or the installation's default", () => {
    expect(repositoryLabel(mailJob().repository, t("en"))).toBe("Primary S3");
    expect(
      repositoryLabel(
        {
          id: null,
          name: null,
          kind: "installation_default",
          role: null,
          status: null,
          objectLock: null,
        },
        t("en"),
      ),
    ).toBe("Default storage location of the installation");
  });

  it("words the retention: a policy, the tenant default, or numbers", () => {
    expect(retentionLabel(mailJob(), t("en"))).toBe("Tenant default (Standard 30 days)");
    expect(
      retentionLabel(
        mailJob({ retention: { policyId: "p1", policyName: "Ninety days", keep: null } }),
        t("en"),
      ),
    ).toBe("Ninety days");
    expect(retentionLabel(endpointJob(), t("en"))).toBe("Daily 14, weekly 8, monthly 6");
    expect(
      retentionLabel(
        endpointJob({ retention: { policyId: null, policyName: null, keep: null } }),
        t("en"),
      ),
    ).toBe("Each machine keeps its own retention");
  });
});
