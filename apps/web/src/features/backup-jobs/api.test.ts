// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

import {
  LIMITS,
  addJobMembers,
  backupJobKeys,
  createBackupJob,
  deleteBackupJob,
  fetchBackupJob,
  fetchBackupJobs,
  fetchJobCandidates,
  fetchJobDefaults,
  fetchJobMembers,
  fetchJobRuns,
  removeJobMember,
  replaceJobMembers,
  runBackupJob,
  setMemberOverrides,
  updateBackupJob,
} from "./api.js";
import { mailJob } from "./fixtures.js";
import { conflictsOf, jobProblemOf } from "./problems.js";

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

let calls: Call[] = [];

function answer(body: unknown, status = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url: new URL(String(input), "http://localhost"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
    });
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the jobs client", () => {
  it("lists the jobs of one kind, or of both", async () => {
    vi.stubGlobal("fetch", answer({ items: [], uncovered: { mail: 0, endpoint: 0 } }));
    await fetchBackupJobs("mail");
    await fetchBackupJobs();
    expect(calls.map((call) => call.url.pathname + call.url.search)).toEqual([
      "/api/v1/backup-jobs?kind=mail",
      "/api/v1/backup-jobs",
    ]);
  });

  it("asks for the defaults of the chosen machines, so a Mac client is not a Linux server", async () => {
    vi.stubGlobal("fetch", answer({}));
    await fetchJobDefaults("endpoint", ["m1", "m2"]);
    expect(calls[0]?.url.searchParams.get("endpointIds")).toBe("m1,m2");
    expect(calls[0]?.url.searchParams.get("kind")).toBe("endpoint");
  });

  it("asks for the recommended values of a kind and searches the candidates", async () => {
    vi.stubGlobal("fetch", answer({ items: [], total: 0 }));
    await fetchJobDefaults("endpoint");
    await fetchJobCandidates("mail", "  anna ", 50);
    await fetchJobCandidates("endpoint", "");
    expect(calls[0]?.url.pathname + calls[0]?.url.search).toBe(
      "/api/v1/backup-jobs/defaults?kind=endpoint",
    );
    expect(calls[1]?.url.pathname).toBe("/api/v1/backup-jobs/candidates");
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({
      kind: "mail",
      q: "anna",
      limit: "50",
    });
    // No search text, no q; the largest page the API allows by default.
    expect(Object.fromEntries(calls[2]?.url.searchParams ?? [])).toEqual({
      kind: "endpoint",
      limit: String(LIMITS.candidates),
    });
  });

  it("creates, reads, changes and deletes a job", async () => {
    vi.stubGlobal("fetch", answer(mailJob(), 200));
    await createBackupJob({
      kind: "mail",
      name: "Mail",
      scope: { mode: "all", members: [] },
      moveMembers: true,
    });
    await fetchBackupJob("a/b");
    await updateBackupJob("j1", { name: "Renamed", settings: { paths: ["/etc"] } });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["POST", "/api/v1/backup-jobs"],
      ["GET", "/api/v1/backup-jobs/a%2Fb"],
      ["PATCH", "/api/v1/backup-jobs/j1"],
    ]);
    expect(calls[0]?.body).toEqual({
      kind: "mail",
      name: "Mail",
      scope: { mode: "all", members: [] },
      moveMembers: true,
    });
    expect(calls[2]?.body).toEqual({ name: "Renamed", settings: { paths: ["/etc"] } });

    vi.stubGlobal("fetch", answer(undefined, 204));
    calls = [];
    await expect(deleteBackupJob("j1")).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]?.url.pathname).toBe("/api/v1/backup-jobs/j1");
  });

  it("reads and changes the scope: replace, add, one member's overrides, remove", async () => {
    vi.stubGlobal("fetch", answer({ mode: "selected", items: [] }));
    await fetchJobMembers("j1");
    await replaceJobMembers("j1", { mode: "selected", members: [{ id: "m1" }], move: true });
    await addJobMembers("j1", { members: [{ id: "m2", overrides: { bandwidthKbps: 500 } }] });
    await setMemberOverrides("j1", "m 3", { paths: ["/srv"] });
    await setMemberOverrides("j1", "m3", {});
    await removeJobMember("j1", "m3");
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/backup-jobs/j1/members"],
      ["PUT", "/api/v1/backup-jobs/j1/members"],
      ["POST", "/api/v1/backup-jobs/j1/members"],
      ["PATCH", "/api/v1/backup-jobs/j1/members/m%203"],
      ["PATCH", "/api/v1/backup-jobs/j1/members/m3"],
      ["DELETE", "/api/v1/backup-jobs/j1/members/m3"],
    ]);
    expect(calls[1]?.body).toEqual({ mode: "selected", members: [{ id: "m1" }], move: true });
    expect(calls[2]?.body).toEqual({ members: [{ id: "m2", overrides: { bandwidthKbps: 500 } }] });
    // An empty overrides object clears the member's overrides.
    expect(calls[3]?.body).toEqual({ overrides: { paths: ["/srv"] } });
    expect(calls[4]?.body).toEqual({ overrides: {} });
  });

  it("runs a job, all of it or some objects, and reads its runs", async () => {
    vi.stubGlobal("fetch", answer({ queued: 1, skipped: [], items: [] }));
    await runBackupJob("j1");
    await runBackupJob("j1", { targetIds: ["m1"], full: true });
    await fetchJobRuns("j1", 10);
    await fetchJobRuns("j1");
    expect(calls[0]).toMatchObject({ method: "POST", body: {} });
    expect(calls[1]?.body).toEqual({ targetIds: ["m1"], full: true });
    expect(calls[2]?.url.pathname + calls[2]?.url.search).toBe(
      "/api/v1/backup-jobs/j1/runs?limit=10",
    );
    expect(calls[3]?.url.search).toBe("?limit=30");
  });

  it("scopes every query key to the tenant", () => {
    for (const key of [
      backupJobKeys.all("t"),
      backupJobKeys.list("t", "mail"),
      backupJobKeys.detail("t", "j"),
      backupJobKeys.members("t", "j"),
      backupJobKeys.runs("t", "j", 30),
      backupJobKeys.defaults("t", "mail"),
      backupJobKeys.candidates("t", "mail", "q", 200),
    ]) {
      expect(key.slice(0, 3)).toEqual(["tenant", "t", "backup-jobs"]);
    }
    // One prefix to invalidate everything a change touches.
    const prefix = backupJobKeys.all("t");
    expect(backupJobKeys.detail("t", "j").slice(0, prefix.length)).toEqual([...prefix]);
    expect(backupJobKeys.members("t", "j").slice(0, 5)).toEqual([
      ...backupJobKeys.detail("t", "j"),
    ]);
    expect(backupJobKeys.list("t", undefined)).toContain("all");
  });

  it("mirrors the API's limits", () => {
    expect(LIMITS).toMatchObject({
      name: 120,
      members: 5000,
      paths: 200,
      pathLength: 1024,
      excludes: 500,
      excludeLength: 512,
      hookLength: 4096,
      bandwidthMaxKbps: 10_000_000,
      keepDaily: 3650,
      keepWeekly: 520,
      keepMonthly: 240,
    });
  });
});

describe("what the API refuses", () => {
  it("hands the field of a 422 and the conflicts of a 409 to the forms", async () => {
    vi.stubGlobal(
      "fetch",
      answer(
        {
          type: "urn:restow:problem:invalid-backup-job",
          title: "Invalid backup job",
          status: 422,
          field: "settings",
          issues: [{ path: ["settings", "paths"], code: "invalid", message: "bad path" }],
        },
        422,
      ),
    );
    const refused = await createBackupJob({ kind: "endpoint", name: "x" }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect(jobProblemOf(refused)).toMatchObject({ path: ["settings", "paths"] });

    vi.stubGlobal(
      "fetch",
      answer(
        {
          type: "urn:restow:problem:backup-job-member-in-other-job",
          title: "In another job",
          status: 409,
          conflicts: [{ targetId: "m1", jobId: "j9", jobName: "Old" }],
        },
        409,
      ),
    );
    const conflict = await createBackupJob({ kind: "endpoint", name: "x" }).catch(
      (error: unknown) => error,
    );
    expect(conflictsOf(conflict)).toEqual([{ targetId: "m1", jobId: "j9", jobName: "Old" }]);
  });
});
