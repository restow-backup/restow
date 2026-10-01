import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import type {
  BrowseEntry,
  EndpointReport,
  EndpointSummary,
  EndpointTask,
  RunSummary,
} from "./api.js";
import {
  IDLE_REFRESH_MS,
  LIVE_REFRESH_MS,
  type Selection,
  activityKey,
  allState,
  attentionMessage,
  attentionTone,
  configPending,
  coveredByFolder,
  detailRefetchInterval,
  effectivePaths,
  endpointErrorKey,
  endpointHostLine,
  endpointName,
  formatDuration,
  incompleteCheckKey,
  isAbsolutePath,
  isBelow,
  isKnownAttention,
  isRetryableProblem,
  lastBackupOf,
  listRefetchInterval,
  onlyInterrupted,
  pathSegments,
  progressRatio,
  reportView,
  retryNotBefore,
  runBadgeView,
  runDurationMs,
  runErrorView,
  runStatusView,
  selectionLimits,
  sortAttention,
  statusView,
  taskOutcomeOf,
  taskStatusView,
  toggleAll,
  toggleItem,
  waitingTasks,
} from "./presenters.js";

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "r1",
    kind: "backup",
    status: "succeeded",
    startedAt: "2026-09-30T10:00:00.000Z",
    finishedAt: "2026-09-30T10:03:12.000Z",
    snapshotId: null,
    errorCount: 0,
    interruptedOnly: false,
    checkIncomplete: false,
    failure: null,
    filesNew: null,
    dataAdded: null,
    totalBytesProcessed: null,
    progress: null,
    ...over,
  };
}

function endpoint(over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "e1",
    hostname: "web-01",
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.1.0",
    osVersion: "Debian 12",
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-09-30T10:00:00.000Z",
    lastBackupAt: "2026-09-30T09:00:00.000Z",
    lastSuccessAt: "2026-09-30T09:00:00.000Z",
    nextRunAt: null,
    readiness: {
      state: "green",
      checkedAt: null,
      overdue: false,
      basis: null,
      latestSnapshotId: "abc",
    },
    latestRun: null,
    attention: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

function entry(name: string, type: BrowseEntry["type"], path = `/data/${name}`): BrowseEntry {
  return { name, path, type, size: type === "dir" ? null : 10, mtime: null };
}

describe("names", () => {
  it("prefers the label an admin gave over the host name", () => {
    expect(endpointName({ displayName: "  Mail server ", hostname: "mx1" })).toBe("Mail server");
    expect(endpointName({ displayName: null, hostname: "mx1" })).toBe("mx1");
    expect(endpointName({ displayName: "   ", hostname: "mx1" })).toBe("mx1");
  });

  it("shows the host name as a second line only when a label replaced it", () => {
    expect(endpointHostLine({ displayName: "Mail server", hostname: "mx1" })).toBe("mx1");
    expect(endpointHostLine({ displayName: null, hostname: "mx1" })).toBeNull();
    expect(endpointHostLine({ displayName: "mx1", hostname: "mx1" })).toBeNull();
  });
});

describe("connection and activity", () => {
  it("treats a silent server as a warning and an offline client as neutral", () => {
    expect(statusView(endpoint({ connection: "offline", profile: "server" }))).toEqual({
      tone: "warning",
      key: "status.offline",
    });
    expect(statusView(endpoint({ connection: "offline", profile: "client" }))).toEqual({
      tone: "muted",
      key: "status.offline",
    });
    // Online is a state, not a proof: neutral, never green.
    expect(statusView(endpoint({ connection: "online" }))).toEqual({
      tone: "neutral",
      key: "status.online",
    });
    expect(statusView(endpoint({ connection: "never" })).key).toBe("status.never");
  });

  it("shows a revoked machine as revoked whatever it last did", () => {
    expect(statusView(endpoint({ status: "revoked", connection: "online" }))).toEqual({
      tone: "muted",
      key: "status.revoked",
    });
  });

  it("names the running work, or a generic busy state when only the agent says so", () => {
    expect(activityKey(endpoint({ latestRun: run({ status: "running", kind: "restore" }) }))).toBe(
      "activity.restore",
    );
    expect(activityKey(endpoint({ agentState: "running" }))).toBe("activity.busy");
    expect(activityKey(endpoint({ agentState: "idle" }))).toBeNull();
    expect(activityKey(endpoint({ status: "revoked", agentState: "running" }))).toBeNull();
  });
});

describe("last backup", () => {
  it("marks a failed or partial last run instead of passing it as a success", () => {
    expect(
      lastBackupOf(
        endpoint({ latestRun: run({ status: "failed" }), attention: ["last_backup_failed"] }),
      ),
    ).toEqual({
      state: "done",
      at: "2026-09-30T09:00:00.000Z",
      outcome: "failed",
    });
    expect(lastBackupOf(endpoint({ latestRun: run({ status: "partial" }) }))).toMatchObject({
      outcome: "partial",
    });
    expect(lastBackupOf(endpoint({ latestRun: run() }))).toMatchObject({ outcome: "ok" });
  });

  it("shows a run that was only interrupted neutrally, as the server flags it", () => {
    expect(
      lastBackupOf(
        endpoint({
          latestRun: run({ status: "failed", errorCount: 1, interruptedOnly: true }),
          attention: [],
        }),
      ),
    ).toMatchObject({ outcome: "interrupted" });
  });

  it("shows the failed run of a revoked machine as failed, and an interrupted one neutrally", () => {
    expect(
      lastBackupOf(
        endpoint({ status: "revoked", latestRun: run({ status: "failed" }), attention: [] }),
      ),
    ).toMatchObject({ outcome: "failed" });
    expect(
      lastBackupOf(
        endpoint({
          status: "revoked",
          latestRun: run({ status: "failed", interruptedOnly: true }),
          attention: [],
        }),
      ),
    ).toMatchObject({ outcome: "interrupted" });
  });

  it("says running while a backup runs and never when there is none", () => {
    expect(lastBackupOf(endpoint({ latestRun: run({ status: "running" }) }))).toEqual({
      state: "running",
    });
    expect(lastBackupOf(endpoint({ lastBackupAt: null, latestRun: null }))).toEqual({
      state: "never",
    });
  });

  it("does not read a failed restore as a failed backup", () => {
    expect(
      lastBackupOf(endpoint({ latestRun: run({ kind: "restore", status: "failed" }) })),
    ).toMatchObject({ outcome: "ok" });
  });
});

describe("attention", () => {
  it("orders the heaviest first and drops repeats", () => {
    expect(
      sortAttention(["never_seen", "silent", "repository_damaged", "silent", "backup_overdue"]),
    ).toEqual(["repository_damaged", "silent", "backup_overdue", "never_seen"]);
  });

  it("recognises only the codes it can word", () => {
    expect(isKnownAttention("silent")).toBe(true);
    expect(isKnownAttention("something_new")).toBe(false);
  });

  it("colours damage and failures red and lateness amber", () => {
    expect(attentionTone("repository_damaged")).toBe("destructive");
    expect(attentionTone("restore_test_failed")).toBe("destructive");
    expect(attentionTone("backup_overdue")).toBe("warning");
  });

  it("names the limit that applies in the message", () => {
    expect(attentionMessage("silent", { staleAfterHours: 6, staleAfterDays: 7 })).toEqual({
      key: "attention.silent.message",
      values: { hours: 6 },
    });
    expect(
      attentionMessage("backup_overdue", { staleAfterHours: 2, staleAfterDays: 14 }).values,
    ).toEqual({
      days: 14,
    });
    expect(attentionMessage("silent", null).values).toEqual({ hours: 2 });
    expect(attentionMessage("last_backup_failed", null)).toEqual({
      key: "attention.last_backup_failed.message",
    });
  });
});

describe("runs", () => {
  it("gives every status a tone; only a running one is live", () => {
    expect(runStatusView("running")).toMatchObject({ tone: "info", live: true });
    // A backup run that succeeded is neutral: nothing has read it back yet.
    expect(runStatusView("succeeded")).toMatchObject({ tone: "neutral", live: false });
    expect(runStatusView("succeeded", "backup")).toMatchObject({ tone: "neutral" });
    expect(runStatusView("partial")).toMatchObject({ tone: "warning" });
    expect(runStatusView("failed")).toMatchObject({ tone: "destructive" });
  });

  it("keeps the green for a restore and a restore test that succeeded", () => {
    expect(runStatusView("succeeded", "restore")).toMatchObject({ tone: "success" });
    expect(runStatusView("succeeded", "verify_sample")).toMatchObject({ tone: "success" });
    // Whatever the kind, a failure is a failure.
    expect(runStatusView("failed", "restore")).toMatchObject({ tone: "destructive" });
    expect(runStatusView("partial", "backup")).toMatchObject({ tone: "warning" });
  });

  it("shows a restore test that could not complete neutrally, never green or red", () => {
    const test = { kind: "verify_sample" as const, checkIncomplete: true };
    expect(runBadgeView({ ...test, status: "failed" })).toEqual({
      tone: "info",
      key: "runStatus.incomplete",
      live: false,
      mark: "incomplete",
    });
    // Also when the agent lost it to a restart: the server offers it again, not the agent.
    expect(runBadgeView({ ...test, status: "failed", interrupted: true }).mark).toBe("incomplete");
    // Even a run that says it succeeded is no pass without a rating.
    expect(runBadgeView({ ...test, status: "succeeded" }).tone).toBe("info");
    // A revoked machine runs no more tests.
    expect(runBadgeView({ ...test, status: "failed" }, { willRetry: false }).key).toBe(
      "runStatus.incompleteFinal",
    );
    expect(incompleteCheckKey(true)).toBe("runStatus.incomplete");
    // Still running: live, as any run.
    expect(runBadgeView({ ...test, status: "running" })).toMatchObject({ live: true, mark: null });
    // Rated: red is proof of damage, green a pass.
    expect(runBadgeView({ kind: "verify_sample", status: "failed" }).tone).toBe("destructive");
    expect(runBadgeView({ kind: "verify_sample", status: "succeeded" }).tone).toBe("success");
    // The interruption of other runs keeps its own neutral badge.
    expect(runBadgeView({ kind: "backup", status: "failed", interrupted: true })).toMatchObject({
      tone: "info",
      key: "runStatus.interrupted",
      mark: "interrupted",
    });
    expect(
      runBadgeView({ kind: "backup", status: "succeeded", interrupted: true }).mark,
    ).toBeNull();
  });

  it("words how a request ended: done, a test that could not complete, or failed", () => {
    const task = (over: Partial<EndpointTask>): EndpointTask => ({
      id: "t",
      kind: "verify_sample",
      status: "failed",
      params: {},
      createdAt: "2026-09-30T10:00:00.000Z",
      deliveredAt: null,
      finishedAt: "2026-09-30T10:05:00.000Z",
      errorMessage: "expired",
      checkIncomplete: true,
      ...over,
    });
    const view = (value: EndpointTask, willRetry = true) =>
      taskStatusView(value, taskOutcomeOf(value), { willRetry });
    expect(taskOutcomeOf(task({}))).toEqual({
      state: "incomplete",
      reason: { key: "tasks.reason.expired" },
    });
    expect(view(task({}))).toEqual({
      tone: "info",
      key: "runStatus.incomplete",
      mark: "incomplete",
    });
    expect(view(task({}), false).key).toBe("runStatus.incompleteFinal");
    expect(view(task({ checkIncomplete: false, errorMessage: "SHA-256 mismatch" }))).toEqual({
      tone: "destructive",
      key: "tasks.status.failed",
      mark: null,
    });
    expect(
      taskOutcomeOf(task({ checkIncomplete: false, errorMessage: "SHA-256 mismatch" })),
    ).toEqual({ state: "failed", reason: { text: "SHA-256 mismatch" } });
    expect(view(task({ status: "done", checkIncomplete: false })).tone).toBe("neutral");
    expect(view(task({ kind: "restore", status: "done", checkIncomplete: false })).tone).toBe(
      "success",
    );
  });

  it("knows when a restore test offered again may be picked up", () => {
    const now = Date.parse("2026-10-01T10:00:00.000Z");
    const task = (kind: EndpointTask["kind"], params: Record<string, unknown>) => ({
      kind,
      params,
    });
    expect(
      retryNotBefore(task("verify_sample", { notBefore: "2026-10-01T12:00:00.000Z" }), now),
    ).toBe("2026-10-01T12:00:00.000Z");
    expect(
      retryNotBefore(task("verify_sample", { notBefore: "2026-10-01T09:00:00.000Z" }), now),
    ).toBeNull();
    expect(retryNotBefore(task("verify_sample", {}), now)).toBeNull();
    expect(retryNotBefore(task("verify_sample", { notBefore: "soon" }), now)).toBeNull();
    expect(
      retryNotBefore(task("backup_now", { notBefore: "2026-10-01T12:00:00.000Z" }), now),
    ).toBeNull();
  });

  it("measures a finished run, and a running one up to now", () => {
    expect(runDurationMs(run())).toBe(192_000);
    expect(
      runDurationMs(
        { startedAt: "2026-09-30T10:00:00.000Z", finishedAt: null },
        Date.parse("2026-09-30T10:01:00.000Z"),
      ),
    ).toBe(60_000);
    expect(runDurationMs({ startedAt: "nonsense", finishedAt: null })).toBeNull();
  });

  it("reads durations with the two largest units", () => {
    expect(formatDuration(45_000, "en")).toMatch(/45/);
    expect(formatDuration(192_000, "en")).toMatch(/3.*12/);
    expect(formatDuration(3_900_000, "en")).toMatch(/1.*5/);
    expect(formatDuration(7_200_000, "en")).not.toMatch(/0/);
  });

  it("computes progress by bytes, else by files, else says it is unknown", () => {
    const base = { filesDone: 5, bytesDone: 50, updatedAt: "2026-09-30T10:00:00.000Z" };
    expect(progressRatio({ ...base, totalBytes: 200, totalFiles: 10 })).toBe(0.25);
    expect(progressRatio({ ...base, totalFiles: 10 })).toBe(0.5);
    expect(progressRatio(base)).toBeNull();
    expect(progressRatio({ ...base, totalBytes: 10 })).toBe(1);
    expect(progressRatio(null)).toBeNull();
  });
});

describe("run errors", () => {
  it("words the codes of the agent", () => {
    expect(runErrorView({ code: "pre_hook_failed" })).toEqual({
      headline: { key: "runErrors.pre_hook_failed" },
      neutral: false,
    });
    expect(runErrorView({ code: "target_not_empty" }).headline?.key).toBe(
      "runErrors.target_not_empty",
    );
    expect(runErrorView({ code: "hash_mismatch" }).headline?.key).toBe("runErrors.hash_mismatch");
    expect(runErrorView({ code: "agent_stopped" }).headline?.key).toBe("runErrors.agent_stopped");
  });

  it("treats an interruption as neutral", () => {
    expect(runErrorView({ code: "interrupted" })).toEqual({
      headline: { key: "runErrors.interrupted" },
      neutral: true,
    });
  });

  it("names the exit code of restic", () => {
    expect(runErrorView({ code: "restic_exit_3" })).toEqual({
      headline: { key: "runErrors.restic_exit", values: { code: 3 } },
      neutral: false,
    });
  });

  it("shows a code it does not know as it is, and says nothing for an error without a code", () => {
    expect(runErrorView({ code: "brand_new_code" }).headline).toEqual({
      key: "runErrors.unknown",
      values: { code: "brand_new_code" },
    });
    expect(runErrorView({}).headline).toBeNull();
    expect(runErrorView({ code: "  " }).headline).toBeNull();
  });

  it("knows a run whose every error is an interruption", () => {
    expect(onlyInterrupted([{ code: "interrupted" }, { code: "interrupted" }])).toBe(true);
    expect(onlyInterrupted([{ code: "interrupted" }, { code: "read_error" }])).toBe(false);
    expect(onlyInterrupted([])).toBe(false);
  });
});

describe("reports", () => {
  const format = { bytes: (n: number) => `${n} B`, integer: (n: number) => String(n) };
  function report(over: Partial<EndpointReport>): EndpointReport {
    return {
      id: "p1",
      kind: "restore_test",
      origin: "server",
      snapshotId: "abc",
      readiness: "green",
      summary: {},
      checkedAt: "2026-09-30T10:00:00.000Z",
      ...over,
    };
  }

  it("reads a restore test as matched x of y files", () => {
    const view = reportView(
      report({ summary: { files: 20, matched: 19 }, readiness: "red" }),
      format,
    );
    expect(view.tone).toBe("destructive");
    expect(view.headline).toEqual({
      key: "reports.restoreTest.matched",
      values: { matched: "19", files: "20" },
    });
  });

  it("carries the reason of a failed step", () => {
    const view = reportView(report({ summary: { errorMessage: "repository locked" } }), format);
    expect(view.details).toContainEqual({
      key: "reports.errorMessage",
      values: { message: "repository locked" },
    });
    expect(view.headline.key).toBe("reports.restoreTest.noResult");
  });

  it("describes a retention run and a repository check", () => {
    const retention = reportView(
      report({
        kind: "retention",
        readiness: null,
        summary: { removedSnapshots: 3, keptSnapshots: 40, repositoryBytes: 1000 },
      }),
      format,
    );
    expect(retention.tone).toBe("muted");
    expect(retention.headline).toEqual({ key: "reports.retention.removed", values: { count: 3 } });
    expect(retention.details.map((d) => d.key)).toEqual([
      "reports.retention.kept",
      "reports.retention.size",
    ]);
    const check = reportView(
      report({ kind: "repository_check", summary: { subsetPercent: 12.4 } }),
      format,
    );
    expect(check.headline).toEqual({ key: "reports.check.subset", values: { percent: 12 } });
  });
});

describe("tasks and configuration", () => {
  it("keeps only the tasks that still wait for the machine", () => {
    const task = (status: EndpointTask["status"]): EndpointTask => ({
      id: status,
      kind: "backup_now",
      status,
      params: {},
      createdAt: "2026-09-30T10:00:00.000Z",
      deliveredAt: null,
      finishedAt: null,
      errorMessage: null,
      checkIncomplete: false,
    });
    expect(
      waitingTasks([task("pending"), task("delivered"), task("done"), task("failed")]),
    ).toHaveLength(2);
  });

  it("knows when the machine has not fetched the newest configuration", () => {
    expect(configPending({ configVersion: 3, agentConfigVersion: 3 })).toBe(false);
    expect(configPending({ configVersion: 4, agentConfigVersion: 3 })).toBe(true);
    expect(configPending({ configVersion: 1, agentConfigVersion: null })).toBe(true);
  });
});

describe("file browser", () => {
  it("builds the path bar from a path", () => {
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments("/home/ada/docs")).toEqual([
      { name: "home", path: "/home" },
      { name: "ada", path: "/home/ada" },
      { name: "docs", path: "/home/ada/docs" },
    ]);
  });

  it("knows what lies below a folder, and not a sibling with the same prefix", () => {
    expect(isBelow("/home/ada", "/home")).toBe(true);
    expect(isBelow("/home", "/home")).toBe(false);
    expect(isBelow("/homework", "/home")).toBe(false);
    expect(isBelow("/anything", "/")).toBe(true);
  });

  it("selects and unselects one entry", () => {
    let selection: Selection = new Map();
    selection = toggleItem(selection, entry("a", "file"));
    expect([...selection.keys()]).toEqual(["/data/a"]);
    selection = toggleItem(selection, entry("a", "file"));
    expect(selection.size).toBe(0);
  });

  it("selects everything selectable in a folder, then clears it, skipping special files", () => {
    const entries = [entry("a", "file"), entry("d", "dir"), entry("dev", "other")];
    let selection: Selection = new Map();
    expect(allState(selection, entries)).toBe(false);
    selection = toggleAll(selection, entries);
    expect([...selection.keys()].sort()).toEqual(["/data/a", "/data/d"]);
    expect(allState(selection, entries)).toBe(true);
    selection = toggleItem(selection, entries[0] as BrowseEntry);
    expect(allState(selection, entries)).toBe("indeterminate");
    selection = toggleAll(toggleAll(new Map(), entries), entries);
    expect(selection.size).toBe(0);
  });

  it("lets a selected folder cover what is inside it", () => {
    let selection: Selection = new Map();
    selection = toggleItem(selection, entry("docs", "dir", "/home/docs"));
    selection = toggleItem(selection, entry("a.txt", "file", "/home/docs/a.txt"));
    selection = toggleItem(selection, entry("b.txt", "file", "/home/b.txt"));
    expect(coveredByFolder(selection, "/home/docs/a.txt")).toBe(true);
    expect(coveredByFolder(selection, "/home/b.txt")).toBe(false);
    // The folder already includes a.txt, so only the folder and the other file are named.
    expect(effectivePaths(selection)).toEqual(["/home/b.txt", "/home/docs"]);
  });

  it("stops a selection the API would refuse", () => {
    const many: Selection = new Map(
      Array.from({ length: 10_001 }, (_, i) => {
        const e = entry(`f${i}`, "file", `/d/f${i}`);
        return [e.path, { path: e.path, name: e.name, type: e.type }] as const;
      }),
    );
    const limits = { downloadPaths: 10_000, restorePaths: 200 };
    expect(selectionLimits(many, limits)).toMatchObject({
      downloadBlocked: "too_many",
      restoreBlocked: "too_many",
    });
    const one = toggleItem(new Map(), entry("a", "file"));
    expect(selectionLimits(one, limits)).toMatchObject({
      downloadBlocked: null,
      restoreBlocked: null,
    });
    // A download takes far more than a restore; 201 items are fine for a ZIP.
    const some: Selection = new Map(
      Array.from({ length: 201 }, (_, i) => [
        `/d/f${i}`,
        { path: `/d/f${i}`, name: `f${i}`, type: "file" as const },
      ]),
    );
    expect(selectionLimits(some, limits)).toMatchObject({
      downloadBlocked: null,
      restoreBlocked: "too_many",
    });
  });

  it("accepts absolute paths of both kinds of machine", () => {
    expect(isAbsolutePath("/srv/restore")).toBe(true);
    expect(isAbsolutePath("C:\\Restore")).toBe(true);
    expect(isAbsolutePath("restore/here")).toBe(false);
  });
});

describe("problems", () => {
  const problem = (type: string, title: string, status: number) =>
    new ApiError(status, { type, title, status }, title);

  it("asks to try again when the server is busy or the repository is locked", () => {
    const busy = problem("urn:restow:problem:restic-busy", "Server busy", 429);
    const locked = problem("urn:restow:problem:endpoint-repository-locked", "Repository busy", 503);
    expect(endpointErrorKey(busy)).toBe("endpoints:errors.resticBusy");
    expect(endpointErrorKey(locked)).toBe("endpoints:errors.repositoryLocked");
    expect(isRetryableProblem(busy)).toBe(true);
    expect(isRetryableProblem(locked)).toBe(true);
    expect(isRetryableProblem(problem("urn:restow:problem:restic-failed", "x", 502))).toBe(false);
  });

  it("words every problem of the endpoint API by its type, never by its title", () => {
    const keys: Record<string, string> = {
      "urn:restow:problem:endpoint-revoked": "endpoints:errors.revoked",
      "urn:restow:problem:endpoint-nothing-to-test": "endpoints:errors.nothingToTest",
      "urn:restow:problem:endpoint-instance-unknown": "endpoints:errors.instanceUnknown",
      "urn:restow:problem:endpoint-queue-not-ready": "endpoints:errors.queueNotReady",
      "urn:restow:problem:endpoint-path-not-found": "endpoints:errors.pathNotFound",
      "urn:restow:problem:endpoint-token-settled": "endpoints:errors.tokenSettled",
      "urn:restow:problem:endpoint-download-gone": "endpoints:errors.downloadGone",
      "urn:restow:problem:unsupported-os": "endpoints:errors.unsupportedOs",
      // Setting a hook and showing the repository password need a recent sign-in.
      "urn:restow:problem:recent-sign-in-required": "endpoints:errors.recentSignIn",
    };
    for (const [type, key] of Object.entries(keys)) {
      expect(endpointErrorKey(problem(type, "Any title", 409))).toBe(key);
    }
  });

  it("does not guess from the title of a problem without a type of its own", () => {
    expect(endpointErrorKey(problem("about:blank", "Endpoint revoked", 409))).toBe(
      "common:errors.conflict",
    );
    expect(endpointErrorKey(problem("about:blank", "Instance address unknown", 503))).toBe(
      "common:errors.network",
    );
  });

  it("falls back to the general messages of the app", () => {
    expect(endpointErrorKey(problem("about:blank", "Not Found", 404))).toBe(
      "common:errors.notFound",
    );
    expect(endpointErrorKey(new Error("boom"))).toBe("common:errors.generic");
  });
});

describe("polling", () => {
  it("follows a running backup closely and idles otherwise", () => {
    expect(listRefetchInterval(undefined)).toBe(IDLE_REFRESH_MS);
    expect(listRefetchInterval([endpoint()])).toBe(IDLE_REFRESH_MS);
    expect(
      listRefetchInterval([endpoint(), endpoint({ latestRun: run({ status: "running" }) })]),
    ).toBe(LIVE_REFRESH_MS);
    expect(listRefetchInterval([endpoint({ agentState: "running" })])).toBe(LIVE_REFRESH_MS);
  });

  it("also follows a detail that waits for the machine to pick up a request", () => {
    const waiting: EndpointTask = {
      id: "t",
      kind: "backup_now",
      status: "pending",
      params: {},
      createdAt: "2026-09-30T10:00:00.000Z",
      deliveredAt: null,
      finishedAt: null,
      errorMessage: null,
      checkIncomplete: false,
    };
    expect(detailRefetchInterval({ ...endpoint(), tasks: [waiting] })).toBe(LIVE_REFRESH_MS);
    expect(detailRefetchInterval({ ...endpoint(), tasks: [] })).toBe(IDLE_REFRESH_MS);
    expect(detailRefetchInterval(undefined)).toBe(IDLE_REFRESH_MS);
  });
});
