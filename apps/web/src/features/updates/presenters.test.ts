import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import {
  BLOCKER_CODES,
  CHECK_ERROR_CODES,
  FAILURE_CODES,
  LEAD_TIME_PRESETS,
  RUN_OUTCOMES,
  UPDATE_STEPS,
  type UpdatesView,
} from "./api";
import {
  DEFAULT_SOURCE_URL,
  ENABLE_UPDATER_COMMAND,
  RECREATE_UPDATER_COMMAND,
  blockerKey,
  buildSettingsPatch,
  canDismissRun,
  checkErrorKey,
  checkErrorTone,
  checkStatusOf,
  clockOffset,
  defaultSourceUrl,
  failureKey,
  formatClock,
  formatReleaseDate,
  isMaintenanceActive,
  isUpdaterOutdated,
  leadTimeLabel,
  maintenanceMessageKey,
  manualUpdateCommands,
  offeredLeadTimes,
  outcomeKey,
  outcomeTone,
  recoveryPlan,
  recoveryScript,
  remainingSeconds,
  runStatusOf,
  safeReleaseUrl,
  selfUpdateNote,
  settingsFormOf,
  shellQuote,
  sourceUrlIssueKey,
  spanLabel,
  stepLabelKey,
  stepStatusKey,
  switchKey,
  tokenIntentReady,
  updaterImageLine,
  updatesErrorKey,
  validateSourceUrl,
} from "./presenters";
import { updatesFixture } from "./testing";

function problemError(type: string, status = 409, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError(status, { type, title: type, status, ...extra }, "failed");
}

describe("updatesErrorKey", () => {
  it("maps each problem type of the updates endpoints to its own message", () => {
    expect(updatesErrorKey(problemError("urn:restow:problem:updater-unavailable", 503))).toBe(
      "updates:errors.updaterUnavailable",
    );
    expect(updatesErrorKey(problemError("urn:restow:problem:updater-blocked"))).toBe(
      "updates:errors.updaterBlocked",
    );
    expect(updatesErrorKey(problemError("urn:restow:problem:update-busy"))).toBe(
      "updates:errors.busy",
    );
    expect(updatesErrorKey(problemError("urn:restow:problem:update-version-unknown", 422))).toBe(
      "updates:errors.versionUnknown",
    );
    expect(updatesErrorKey(problemError("urn:restow:problem:update-running-unknown"))).toBe(
      "updates:errors.runningUnknown",
    );
    for (const [type, key] of [
      ["urn:restow:problem:update-source-not-allowed", "updates:errors.sourceNotAllowed"],
      ["urn:restow:problem:recent-sign-in-required", "updates:errors.recentSignIn"],
      ["urn:restow:problem:update-not-verifiable", "updates:errors.notVerifiable"],
      ["urn:restow:problem:invalid-update-source", "updates:errors.invalidSource"],
    ] as const) {
      expect(updatesErrorKey(problemError(type, 422)), type).toBe(key);
    }
  });

  it("falls back to the shared messages for everything else", () => {
    expect(updatesErrorKey(problemError("urn:restow:problem:demo-read-only", 403))).toBe(
      "common:errors.demoReadOnly",
    );
    expect(updatesErrorKey(new NetworkError(new TypeError("x")))).toBe("common:errors.network");
    expect(updatesErrorKey(problemError("about:blank", 422))).toBe("common:errors.validation");
    expect(updatesErrorKey(problemError("about:blank", 403))).toBe("common:errors.forbidden");
    expect(updatesErrorKey(new Error("boom"))).toBe("common:errors.generic");
  });
});

describe("the update check", () => {
  const view = (
    state: UpdatesView["check"]["state"],
    updateAvailable: boolean | null,
    code?: (typeof CHECK_ERROR_CODES)[number],
  ): Pick<UpdatesView, "check" | "updateAvailable"> => ({
    check: {
      enabled: state !== "disabled",
      state,
      checkedAt: null,
      nextCheckAt: null,
      error: code ? { code, status: null, retryAt: null, detail: null } : null,
    },
    updateAvailable,
  });

  it("names the state and its tone", () => {
    expect(checkStatusOf(view("disabled", null))).toEqual({ kind: "off", tone: "muted" });
    expect(checkStatusOf(view("pending", null))).toEqual({ kind: "pending", tone: "muted" });
    expect(checkStatusOf(view("ok", false))).toEqual({ kind: "upToDate", tone: "neutral" });
    expect(checkStatusOf(view("ok", true))).toEqual({ kind: "available", tone: "info" });
    expect(checkStatusOf(view("ok", null))).toEqual({
      kind: "comparisonUnavailable",
      tone: "muted",
    });
  });

  it("treats transient failures as warnings and the rest as errors", () => {
    for (const code of ["rate_limited", "server_error", "network", "timeout"] as const) {
      expect(checkStatusOf(view("failed", null, code)), code).toEqual({
        kind: "failed",
        tone: "warning",
      });
      expect(checkErrorTone(code)).toBe("warning");
    }
    for (const code of [
      "unauthorized",
      "not_found",
      "forbidden",
      "invalid_response",
      "no_release",
      "redirect",
    ] as const) {
      expect(checkStatusOf(view("failed", null, code)).tone, code).toBe("destructive");
    }
    expect(checkStatusOf(view("failed", null))).toEqual({ kind: "failed", tone: "warning" });
  });

  it("has a key for every code", () => {
    for (const code of CHECK_ERROR_CODES) {
      expect(checkErrorKey(code)).toBe(`check.errors.${code}`);
    }
    // @ts-expect-error a code from a newer api
    expect(checkErrorKey("something_new")).toBe("check.errors.unknown");
  });
});

describe("dates and links", () => {
  it("formats a release date in the UI language", () => {
    expect(formatReleaseDate("2026-09-28T12:00:00.000Z", "en")).toBe("Sep 28, 2026");
    expect(formatReleaseDate("2026-09-28T12:00:00.000Z", "de")).toBe("28.09.2026");
    expect(formatReleaseDate(null, "en")).toBeNull();
    expect(formatReleaseDate("not a date", "en")).toBeNull();
  });

  it("links only to web addresses", () => {
    expect(safeReleaseUrl("https://github.com/o/r/releases/tag/v1")).toBe(
      "https://github.com/o/r/releases/tag/v1",
    );
    expect(safeReleaseUrl("http://forge.local/r")).toBe("http://forge.local/r");
    expect(safeReleaseUrl("javascript:alert(1)")).toBeNull();
    expect(safeReleaseUrl("data:text/html,x")).toBeNull();
    expect(safeReleaseUrl("/relative")).toBeNull();
    expect(safeReleaseUrl(null)).toBeNull();
  });
});

describe("the source form", () => {
  it("accepts an empty address (the default) and web addresses of bounded length", () => {
    expect(validateSourceUrl("")).toBeNull();
    expect(validateSourceUrl("   ")).toBeNull();
    expect(validateSourceUrl("https://github.com/owner/repo")).toBeNull();
    expect(validateSourceUrl(" http://forge.local/o/r ")).toBeNull();
    expect(validateSourceUrl("ftp://example.test/r")).toBe("protocol");
    expect(validateSourceUrl("javascript:alert(1)")).toBe("protocol");
    expect(validateSourceUrl("owner/repo")).toBe("invalid");
    expect(validateSourceUrl(`https://example.test/${"a".repeat(400)}`)).toBe("tooLong");
    expect(sourceUrlIssueKey("protocol")).toBe("source.url.issues.protocol");
  });

  it("sends nothing when nothing changed", () => {
    const view = updatesFixture();
    expect(buildSettingsPatch(settingsFormOf(view), view)).toBeNull();
  });

  it("sends exactly the fields that differ", () => {
    const view = updatesFixture();
    const form = settingsFormOf(view);
    expect(buildSettingsPatch({ ...form, enabled: false }, view)).toEqual({ enabled: false });
    expect(buildSettingsPatch({ ...form, channel: "beta" }, view)).toEqual({ channel: "beta" });
    expect(buildSettingsPatch({ ...form, sourceUrl: "  https://forge.local/o/r  " }, view)).toEqual(
      { sourceUrl: "https://forge.local/o/r" },
    );
  });

  it("goes back to the default source with null", () => {
    const view = updatesFixture({
      settings: {
        enabled: true,
        channel: "stable",
        sourceUrl: "https://forge.local/o/r",
        tokenSet: false,
      },
    });
    expect(buildSettingsPatch({ ...settingsFormOf(view), sourceUrl: "" }, view)).toEqual({
      sourceUrl: null,
    });
    expect(buildSettingsPatch({ ...settingsFormOf(view), sourceUrl: "   " }, view)).toEqual({
      sourceUrl: null,
    });
  });

  it("sets, replaces and removes the token", () => {
    const none = updatesFixture();
    const stored = updatesFixture({
      settings: { enabled: true, channel: "stable", sourceUrl: null, tokenSet: true },
    });
    expect(
      buildSettingsPatch(
        { ...settingsFormOf(none), token: { kind: "replace", value: " abc " } },
        none,
      ),
    ).toEqual({ token: "abc" });
    expect(
      buildSettingsPatch(
        { ...settingsFormOf(stored), token: { kind: "replace", value: "new" } },
        stored,
      ),
    ).toEqual({ token: "new" });
    expect(
      buildSettingsPatch({ ...settingsFormOf(stored), token: { kind: "remove" } }, stored),
    ).toEqual({
      token: null,
    });
    // Nothing to remove, nothing typed, or nothing to say.
    expect(
      buildSettingsPatch({ ...settingsFormOf(none), token: { kind: "remove" } }, none),
    ).toBeNull();
    expect(
      buildSettingsPatch(
        { ...settingsFormOf(stored), token: { kind: "replace", value: "  " } },
        stored,
      ),
    ).toBeNull();
    expect(
      buildSettingsPatch({ ...settingsFormOf(stored), token: { kind: "keep" } }, stored),
    ).toBeNull();
  });

  it("knows when a replacement token is still to be typed", () => {
    expect(tokenIntentReady({ kind: "keep" })).toBe(true);
    expect(tokenIntentReady({ kind: "remove" })).toBe(true);
    expect(tokenIntentReady({ kind: "replace", value: "x" })).toBe(true);
    expect(tokenIntentReady({ kind: "replace", value: "  " })).toBe(false);
  });

  it("leaves the switch, the source and the token to the environment when it is set", () => {
    const view = updatesFixture({ environmentOverride: { url: "https://mirror.test/feed" } });
    const form = {
      enabled: false,
      sourceUrl: "https://other.test/r",
      channel: "beta" as const,
      token: { kind: "replace" as const, value: "secret" },
    };
    expect(buildSettingsPatch(form, view)).toEqual({ channel: "beta" });
    expect(buildSettingsPatch({ ...form, channel: "stable" }, view)).toBeNull();
  });

  it("shows the default source of the installation as the placeholder", () => {
    expect(defaultSourceUrl(updatesFixture())).toBe("https://github.com/restow-backup/restow");
    const custom = updatesFixture({
      source: {
        origin: "settings",
        url: "https://forge.local/o/r",
        provider: "forgejo",
        repository: "o/r",
        isDefault: false,
        isAlpha: false,
      },
    });
    expect(defaultSourceUrl(custom)).toBe(DEFAULT_SOURCE_URL);
  });
});

describe("the updater", () => {
  it("has a message for every blocker", () => {
    for (const code of BLOCKER_CODES) {
      expect(blockerKey(code)).toBe(`updater.blockers.${code}`);
    }
    // @ts-expect-error a blocker from a newer updater
    expect(blockerKey("something_new")).toBe("updater.blockers.unknown");
  });

  it("labels each lead time", () => {
    const labels = LEAD_TIME_PRESETS.map((seconds) => leadTimeLabel(seconds).key);
    expect(labels).toEqual([
      "lead.now",
      "lead.minute1",
      "lead.minutes5",
      "lead.minutes15",
      "lead.minutes30",
      "lead.hour1",
    ]);
    expect(leadTimeLabel(7200)).toEqual({ key: "lead.custom", params: { minutes: 120 } });
    expect(leadTimeLabel(20)).toEqual({ key: "lead.custom", params: { minutes: 1 } });
  });

  it("offers the api's lead times, or the presets when it names none", () => {
    expect(offeredLeadTimes({ leadTimes: [0, 300] })).toEqual([0, 300]);
    expect(offeredLeadTimes({ leadTimes: [] })).toEqual([...LEAD_TIME_PRESETS]);
    expect(offeredLeadTimes({ leadTimes: [-5, 60, 1.5] })).toEqual([60]);
  });

  it("notices an updater that was not recreated", () => {
    expect(isUpdaterOutdated(updatesFixture())).toBe(false);
    expect(
      isUpdaterOutdated({
        running: "0.2.0",
        updater: { ...updatesFixture().updater, version: "0.1.0" },
      }),
    ).toBe(true);
    expect(
      isUpdaterOutdated({
        running: null,
        updater: { ...updatesFixture().updater, version: "0.1.0" },
      }),
    ).toBe(false);
    expect(
      isUpdaterOutdated({
        running: "0.2.0",
        updater: { ...updatesFixture().updater, version: null },
      }),
    ).toBe(false);
  });
});

describe("steps, outcomes and failures", () => {
  it("labels each step, by mode where it matters", () => {
    for (const id of UPDATE_STEPS) {
      expect(stepLabelKey(id)).toBe(`steps.${id}`);
    }
    expect(stepLabelKey("fetch", "image")).toBe("steps.fetchImage");
    expect(stepLabelKey("fetch", "source")).toBe("steps.fetchSource");
    expect(stepLabelKey("backup", "source")).toBe("steps.backup");
    expect(stepStatusKey("running")).toBe("steps.status.running");
  });

  it("nests failure codes, which contain a dot", () => {
    expect(failureKey("fetch.pull_failed")).toBe("failure.fetch.pull_failed");
    expect(failureKey("interrupted")).toBe("failure.interrupted");
    expect(failureKey("nonsense.code")).toBe("failure.unknown");
    for (const code of FAILURE_CODES) {
      expect(failureKey(code)).toBe(`failure.${code}`);
    }
  });

  it("maps outcomes to keys and tones", () => {
    expect(RUN_OUTCOMES.map(outcomeKey)).toEqual([
      "run.outcomes.succeeded",
      "run.outcomes.unchanged",
      "run.outcomes.rolled_back",
      "run.outcomes.needs_attention",
    ]);
    // An update that went through is neutral: green is for a passed restore check.
    expect(outcomeTone("succeeded")).toBe("neutral");
    expect(outcomeTone("unchanged")).toBe("info");
    expect(outcomeTone("rolled_back")).toBe("warning");
    expect(outcomeTone("needs_attention")).toBe("destructive");
  });

  it("names what a run is, from its outcome or its phase", () => {
    const base = { outcome: null, cancelled: false, finishedAt: null, startedAt: null } as const;
    expect(runStatusOf({ ...base, cancelled: true }, "idle")).toEqual({
      kind: "cancelled",
      tone: "muted",
    });
    expect(runStatusOf({ ...base, outcome: "rolled_back" }, "failed")).toEqual({
      kind: "rolled_back",
      tone: "warning",
    });
    expect(runStatusOf(base, "scheduled")).toEqual({ kind: "scheduled", tone: "info" });
    expect(runStatusOf(base, "running")).toEqual({ kind: "running", tone: "info" });
    expect(runStatusOf({ ...base, startedAt: "2026-01-01T00:00:00Z" }, "idle").kind).toBe(
      "running",
    );
    expect(runStatusOf({ ...base, startedAt: "x", finishedAt: "y" }, "failed")).toEqual({
      kind: "failed",
      tone: "destructive",
    });
  });

  it("clears only finished runs", () => {
    expect(canDismissRun("succeeded")).toBe(true);
    expect(canDismissRun("failed")).toBe(true);
    for (const phase of ["idle", "scheduled", "running"] as const) {
      expect(canDismissRun(phase)).toBe(false);
    }
    expect(isMaintenanceActive("scheduled")).toBe(true);
    expect(isMaintenanceActive("running")).toBe(true);
    expect(isMaintenanceActive("failed")).toBe(false);
  });

  it("builds the key of an updater message", () => {
    expect(maintenanceMessageKey("step.fetch.pulling")).toBe(
      "maintenance.messages.step.fetch.pulling",
    );
  });
});

describe("the clock", () => {
  it("measures the skew between the server and the browser", () => {
    expect(clockOffset("2026-09-30T12:00:05.000Z", Date.parse("2026-09-30T12:00:00.000Z"))).toBe(
      5000,
    );
    expect(clockOffset("2026-09-30T11:00:00.000Z", Date.parse("2026-09-30T12:00:00.000Z"))).toBe(
      -3_600_000,
    );
    expect(clockOffset("garbage", 1000)).toBe(0);
  });

  it("counts whole seconds down on the server's clock and stops at zero", () => {
    const startsAt = "2026-09-30T12:05:00.000Z";
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    expect(remainingSeconds(startsAt, now)).toBe(300);
    expect(remainingSeconds(startsAt, now + 1)).toBe(300);
    expect(remainingSeconds(startsAt, now + 299_001)).toBe(1);
    expect(remainingSeconds(startsAt, now + 300_000)).toBe(0);
    expect(remainingSeconds(startsAt, now + 999_000)).toBe(0);
    // A browser clock one hour behind still counts down five minutes.
    expect(remainingSeconds(startsAt, now - 3_600_000, 3_600_000)).toBe(300);
    expect(remainingSeconds(null, now)).toBeNull();
    expect(remainingSeconds("nonsense", now)).toBeNull();
  });

  it("writes a countdown as minutes and seconds, and hours from one hour on", () => {
    expect(formatClock(272)).toBe("04:32");
    expect(formatClock(59)).toBe("00:59");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });

  it("rounds a span to its largest unit", () => {
    expect(spanLabel(20)).toEqual({ key: "span.seconds", count: 20 });
    expect(spanLabel(60)).toEqual({ key: "span.minutes", count: 1 });
    expect(spanLabel(300)).toEqual({ key: "span.minutes", count: 5 });
    expect(spanLabel(899)).toEqual({ key: "span.minutes", count: 15 });
    expect(spanLabel(3600)).toEqual({ key: "span.hours", count: 1 });
    expect(spanLabel(7000)).toEqual({ key: "span.hours", count: 2 });
    expect(spanLabel(-3)).toEqual({ key: "span.seconds", count: 0 });
  });
});

describe("commands", () => {
  it("quotes a value for the shell only when it needs it", () => {
    expect(shellQuote("restow-0.1.0-2026-09-30.dump")).toBe("restow-0.1.0-2026-09-30.dump");
    expect(shellQuote("ghcr.io/restow-backup/restow:0.1.0")).toBe(
      "ghcr.io/restow-backup/restow:0.1.0",
    );
    expect(shellQuote("a b.dump")).toBe("'a b.dump'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("a;b")).toBe("'a;b'");
  });

  it("gives the manual update of docs/UPDATING.md", () => {
    expect(manualUpdateCommands("v0.2.0")).toEqual({
      image: ["docker compose pull", "docker compose up -d"],
      source: ["git fetch --tags", "git checkout v0.2.0", "docker compose up -d --build"],
    });
    expect(manualUpdateCommands(null).source[1]).toBe("git checkout vX.Y.Z");
    // A tag from a hostile source cannot inject a command.
    expect(manualUpdateCommands("v1; rm -rf /").source[1]).toBe("git checkout 'v1; rm -rf /'");
    expect(ENABLE_UPDATER_COMMAND).toBe("docker compose --profile updater up -d");
    expect(RECREATE_UPDATER_COMMAND).toBe("docker compose --profile updater up -d updater");
  });

  it("builds the recovery steps from the run's facts", () => {
    const plan = recoveryPlan({
      dumpFile: "restow-0.1.0.dump",
      dumpBytes: 100,
      fromVersion: "0.1.0",
      previousImages: {
        app: "ghcr.io/restow-backup/restow:0.1.0",
        web: "ghcr.io/restow-backup/restow-web:0.1.0",
      },
    });
    expect(plan.map((step) => step.id)).toEqual(["copy", "stop", "restore", "images", "start"]);
    expect(plan[0]?.commands).toEqual([
      "docker compose --profile updater cp updater:/state/dumps/restow-0.1.0.dump ./restow-0.1.0.dump",
    ]);
    expect(plan[1]?.commands).toEqual(["docker compose stop api worker scheduler"]);
    expect(plan[2]?.commands).toEqual([
      "docker compose exec -T postgres pg_restore -U restow -d restow --clean --if-exists < restow-0.1.0.dump",
    ]);
    expect(plan[3]).toEqual({
      id: "images",
      commands: [
        "RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0",
        "RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.1.0",
      ],
      removeVariables: [],
    });
    expect(plan[4]?.commands).toEqual(["docker compose up -d"]);
  });

  it("removes the image variables that were not set before the update", () => {
    const plan = recoveryPlan({
      dumpFile: "x.dump",
      dumpBytes: null,
      fromVersion: null,
      previousImages: { app: null, web: null },
    });
    expect(plan[3]).toEqual({
      id: "images",
      commands: [],
      removeVariables: ["RESTOW_IMAGE", "RESTOW_WEB_IMAGE"],
    });
  });

  it("quotes a dump file name that would break the command", () => {
    const plan = recoveryPlan({
      dumpFile: "a b; c.dump",
      dumpBytes: null,
      fromVersion: null,
      previousImages: { app: null, web: null },
    });
    expect(plan[0]?.commands[0]).toBe(
      "docker compose --profile updater cp updater:/state/dumps/'a b; c.dump' ./'a b; c.dump'",
    );
  });

  it("offers all the commands as one block, with the .env edits as comments", () => {
    const script = recoveryScript({
      dumpFile: "x.dump",
      dumpBytes: null,
      fromVersion: null,
      previousImages: { app: "restow:local", web: null },
    });
    expect(script.split("\n")).toEqual([
      "docker compose --profile updater cp updater:/state/dumps/x.dump ./x.dump",
      "docker compose stop api worker scheduler",
      "docker compose exec -T postgres pg_restore -U restow -d restow --clean --if-exists < x.dump",
      "# .env: RESTOW_IMAGE=restow:local",
      "# .env: remove the line RESTOW_WEB_IMAGE",
      "docker compose up -d",
    ]);
  });
});

describe("selfUpdateNote", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    status: "failed" as const,
    reason: "helper_failed" as const,
    fromVersion: "0.1.0",
    targetVersion: "0.2.0",
    image: `ghcr.io/restow-backup/restow:0.2.0@sha256:${"a".repeat(64)}`,
    startedAt: "2026-10-03T10:00:00.000Z",
    finishedAt: "2026-10-03T10:00:05.000Z",
    detail: "exit 1",
    ...over,
  });
  const at = (selfUpdate: UpdatesView["updater"]["selfUpdate"], version = "0.1.0") => ({
    running: "0.2.0",
    mode: "image" as const,
    updater: { ...updatesFixture().updater, version, selfUpdate },
  });
  const on = { enabled: true, verifiesSignatures: true, last: null };

  it("says nothing while the updater runs the installation's version", () => {
    expect(selfUpdateNote(updatesFixture())).toBeNull();
    expect(selfUpdateNote(at({ ...on, last: record() }, "0.2.0"))).toBeNull();
  });

  it("follows the last self-update for the running version", () => {
    expect(selfUpdateNote(at({ ...on, last: record({ status: "pending" }) }))).toEqual({
      kind: "pending",
      version: "0.2.0",
    });
    expect(selfUpdateNote(at({ ...on, last: record() }))).toEqual({
      kind: "failed",
      reason: "helper_failed",
      detail: "exit 1",
    });
    expect(
      selfUpdateNote(at({ ...on, last: record({ status: "skipped", reason: "source_mode" }) })),
    ).toEqual({ kind: "skipped", reason: "source_mode" });
  });

  it("explains an updater that did not try, or cannot", () => {
    expect(selfUpdateNote(at(on))).toEqual({ kind: "on" });
    // A record of an older version does not describe the running one.
    expect(selfUpdateNote(at({ ...on, last: record({ targetVersion: "0.1.5" }) }))).toEqual({
      kind: "on",
    });
    expect(selfUpdateNote(at({ ...on, enabled: false }))).toEqual({
      kind: "skipped",
      reason: "disabled",
    });
    expect(selfUpdateNote(at({ ...on, verifiesSignatures: false }))).toEqual({
      kind: "skipped",
      reason: "signature_unverified",
    });
    expect(selfUpdateNote(at(null))).toEqual({ kind: "legacy" });
  });

  it("offers the .env line with the application image in image mode only", () => {
    expect(updaterImageLine(updatesFixture())).toBe(
      "RESTOW_UPDATER_IMAGE=ghcr.io/restow-backup/restow:0.1.0",
    );
    expect(updaterImageLine({ ...updatesFixture(), mode: "source" })).toBeNull();
  });
});

describe("the wording of a build switch", () => {
  it("names the switch variant of a key only for a switch", () => {
    expect(switchKey("run.title", null)).toBe("run.title");
    expect(switchKey("run.title", undefined)).toBe("run.title");
    expect(switchKey("run.title", "full")).toBe("run.titleSwitch");
  });

  it("has a message wording for the run's own messages, but not for the interruption", () => {
    expect(maintenanceMessageKey("run.scheduled")).toBe("maintenance.messages.run.scheduled");
    expect(maintenanceMessageKey("run.scheduled", "full")).toBe(
      "maintenance.messages.run.scheduledSwitch",
    );
    expect(maintenanceMessageKey("run.rolled_back", "full")).toBe(
      "maintenance.messages.run.rolled_backSwitch",
    );
    expect(maintenanceMessageKey("run.interrupted", "full")).toBe(
      "maintenance.messages.run.interrupted",
    );
    expect(maintenanceMessageKey("step.fetch.pulling", "full")).toBe(
      "maintenance.messages.step.fetch.pulling",
    );
  });
});
