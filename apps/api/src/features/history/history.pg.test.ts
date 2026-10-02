/**
 * Postgres-backed tests of History and the live channel, through the same Hono routes the web UI
 * calls: one list over the mail runs and the runs agents reported, paged newest first without a
 * row twice or missing; the tabs (backup, restore, restore check, export, import, maintenance);
 * the tries of one restore test as one row; the filter per backup job; the detail of a mail and
 * of an agent run with its wave, restore check and timeline; the measurements kept per run; the
 * live window and the stream's snapshot and changes; tenant isolation under Row Level Security;
 * and the role the routes ask for.
 *
 * The routes run on the application role that Row Level Security binds; the suite's own handle is
 * the owner, for fixtures and assertions. Runs when RESTOW_TEST_DATABASE_URL points at a Postgres
 * server as a superuser (the database `restow_api_history_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import {
  type Database,
  backupJobMembers,
  backupJobs,
  createDb,
  endpointReports,
  endpointRuns,
  endpointTasks,
  endpoints,
  jobProgress,
  jobs,
  protectedObjects,
  providers,
  runSamples,
  samplePoint,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Role, roleSatisfies } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { RunDetailDto, RunDto } from "./dto.js";
import { createLiveStep, databaseSources } from "./live.js";
import { buildHistoryRoutes, buildLiveRoutes } from "./routes.js";

const DATABASE = "restow_api_history_test";
const ROLE_HEADER = "x-test-role";
const ZONE = "Europe/Berlin";
/** The moment the fixtures are relative to. */
const NOW = new Date("2026-10-02T12:00:00.000Z");
const minutes = (count: number) => new Date(NOW.getTime() - count * 60_000);

function stand(minimum: "tenant_admin"): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role", {
        detail: `This endpoint requires the ${minimum} role.`,
      });
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    await next();
  };
}

interface Page {
  items: RunDto[];
  next: string | null;
}

describe.skipIf(!testDatabaseAdminUrl)("history against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let mailJob: string;
  let machineJob: string;
  const objects: Record<string, string> = {};
  const runs: Record<string, string> = {};
  let machine: string;
  let foreignRun: string;

  async function mailRun(
    name: string,
    values: Partial<typeof jobs.$inferInsert> & { objectId?: string | null },
  ) {
    const { objectId, ...rest } = values;
    const [row] = await owner
      .insert(jobs)
      .values({
        tenantId: contoso,
        queue: "backup",
        status: "completed",
        protectedObjectId: objectId === undefined ? objects.anna : objectId,
        // The row changed when it was made or ended, not when this test ran.
        updatedAt: rest.completedAt ?? rest.startedAt ?? rest.createdAt,
        ...rest,
      })
      .returning();
    runs[name] = row?.id ?? "";
    return row?.id ?? "";
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { errorHandler } = await import("../../problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const made = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = made[0]?.id ?? "";
    fabrikam = made[1]?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    for (const name of ["anna", "ben", "clara"]) {
      const [row] = await owner
        .insert(protectedObjects)
        .values({
          tenantId: contoso,
          sourceId: m365?.id ?? "",
          kind: "mailbox",
          externalId: `${name}@contoso.example`,
          displayName: name,
        })
        .returning();
      objects[name] = row?.id ?? "";
    }

    // A mail job over anna and ben, a machine job over one server.
    const [mail] = await owner
      .insert(backupJobs)
      .values({
        tenantId: contoso,
        kind: "mail",
        name: "Mail backup",
        schedule: { kind: "interval", intervalMinutes: 480, timeZone: ZONE },
      })
      .returning();
    mailJob = mail?.id ?? "";
    await owner.insert(backupJobMembers).values([
      { tenantId: contoso, jobId: mailJob, protectedObjectId: objects.anna },
      { tenantId: contoso, jobId: mailJob, protectedObjectId: objects.ben },
    ]);
    const [server] = await owner
      .insert(endpoints)
      .values({
        tenantId: contoso,
        hostname: "fs-bergisch",
        displayName: "Fileserver",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: defaultEndpointConfig("linux", "server", { timeZone: ZONE }),
        // Seen just now, whenever the suite runs (the connection state is read against the clock).
        lastSeenAt: new Date(),
        repositoryBytes: 1_000_000,
      })
      .returning();
    machine = server?.id ?? "";
    const [machines] = await owner
      .insert(backupJobs)
      .values({
        tenantId: contoso,
        kind: "endpoint",
        name: "Linux servers",
        schedule: { kind: "daily", timeOfDay: "02:00", timeZone: ZONE },
        settings: { paths: ["/srv"] },
      })
      .returning();
    machineJob = machines?.id ?? "";
    await owner
      .insert(backupJobMembers)
      .values({ tenantId: contoso, jobId: machineJob, endpointId: machine });

    // --- Mail runs, oldest to newest ------------------------------------------------------
    await mailRun("maintenance", {
      queue: "retention",
      objectId: null,
      createdAt: minutes(300),
      startedAt: minutes(300),
      completedAt: minutes(299),
    });
    await mailRun("export", {
      queue: "export",
      objectId: objects.clara,
      createdAt: minutes(280),
      completedAt: minutes(279),
    });
    await mailRun("restore", {
      queue: "restore",
      objectId: objects.clara,
      createdAt: minutes(260),
      completedAt: minutes(259),
    });
    // A wave of the mail job: anna done and checked, ben running, clara not in the job.
    await mailRun("annaBackup", {
      objectId: objects.anna,
      createdAt: minutes(120),
      startedAt: minutes(120),
      completedAt: minutes(110),
      payload: { backupJobId: mailJob },
    });
    await mailRun("annaVerify", {
      queue: "verify",
      objectId: objects.anna,
      createdAt: minutes(109),
      completedAt: minutes(108),
      payload: { result: { readiness: "green", completedAt: minutes(108).toISOString() } },
    });
    await mailRun("benBackup", {
      objectId: objects.ben,
      status: "active",
      createdAt: minutes(119),
      startedAt: minutes(119),
      payload: { backupJobId: mailJob },
    });
    // A restore check that failed its second attempt and waits for the third.
    await mailRun("benVerifyRetry", {
      queue: "verify",
      objectId: objects.ben,
      status: "queued",
      createdAt: minutes(20),
      failure: {
        v: 1,
        code: "storage.unreachable",
        transient: true,
        params: {},
        technical: {},
        occurredAt: minutes(15).toISOString(),
        step: null,
        retry: { attempt: 2, limit: 6, nextAttemptAt: minutes(-5).toISOString() },
      },
    });
    await owner.insert(jobProgress).values([
      {
        tenantId: contoso,
        jobId: runs.annaBackup as string,
        total: 40,
        done: 40,
        updatedAt: minutes(110),
        bytes: 5_000,
        bytesProcessed: 50_000,
        bytesTransferred: 2_000,
      },
      {
        tenantId: contoso,
        jobId: runs.benBackup as string,
        total: 100,
        done: 25,
        updatedAt: minutes(119),
        bytes: 1_000,
        bytesProcessed: 20_000,
        bytesTransferred: 300,
        etaSeconds: 90,
      },
    ]);
    const [snapshot] = await owner
      .insert(snapshots)
      .values({
        tenantId: contoso,
        protectedObjectId: objects.anna as string,
        jobId: runs.annaBackup,
        sequence: 7,
        manifestPath: "m/7",
        itemCount: 40,
      })
      .returning();
    await owner.insert(verifyReports).values({
      tenantId: contoso,
      protectedObjectId: objects.anna as string,
      snapshotId: snapshot?.id,
      recoveryReadiness: "green",
      checkedAt: minutes(108),
      details: { origin: "verify" },
    });
    await owner
      .update(jobs)
      .set({
        payload: {
          backupJobId: mailJob,
          result: {
            snapshotId: snapshot?.id,
            completedAt: minutes(110).toISOString(),
            sequence: 7,
            objectsWritten: 12,
            objectsTotal: 40,
            bytes: 5000,
            verifyJobId: runs.annaVerify,
          },
        },
      })
      .where(eq(jobs.id, runs.annaBackup as string));
    // The measurements of the running backup.
    await owner.insert(runSamples).values({
      tenantId: contoso,
      jobId: runs.benBackup,
      points: [
        samplePoint(minutes(119).getTime(), 0, 0),
        samplePoint(minutes(119).getTime() + 2000, 8_000, 100),
        samplePoint(minutes(119).getTime() + 4000, 20_000, 300),
      ],
    });
    await owner.insert(runSamples).values({
      tenantId: contoso,
      jobId: runs.annaBackup,
      points: [
        samplePoint(minutes(120).getTime(), 0, 0),
        samplePoint(minutes(110).getTime(), 50_000, 2_000),
      ],
    });

    // --- Runs agents reported --------------------------------------------------------------
    const agentRun = async (
      name: string,
      values: Partial<typeof endpointRuns.$inferInsert>,
    ): Promise<string> => {
      const [row] = await owner
        .insert(endpointRuns)
        .values({
          tenantId: contoso,
          endpointId: machine,
          kind: "backup",
          status: "succeeded",
          startedAt: minutes(200),
          createdAt: minutes(200),
          ...values,
        })
        .returning();
      runs[name] = row?.id ?? "";
      return row?.id ?? "";
    };
    const task = async (retry: number, createdAt: Date, snapshotId = "snapA") => {
      const [row] = await owner
        .insert(endpointTasks)
        .values({
          tenantId: contoso,
          endpointId: machine,
          kind: "verify_sample",
          status: "failed",
          params: {
            snapshotId,
            files: [{ path: "/a", sha256: "ab" }],
            ...(retry ? { retry } : {}),
          },
          createdAt,
        })
        .returning();
      return row?.id ?? "";
    };
    await agentRun("machineBackup", {
      status: "succeeded",
      startedAt: minutes(121),
      createdAt: minutes(121),
      finishedAt: minutes(115),
      snapshotId: "snapA",
      stats: { filesNew: 10, filesChanged: 5, dataAdded: 4000, totalBytesProcessed: 900_000 },
      logTail: "line 1\nline 2",
      errors: [{ path: "/srv/locked", message: "permission denied" }],
    });
    await agentRun("machineRunning", {
      status: "running",
      startedAt: minutes(1),
      createdAt: minutes(1),
      progress: {
        filesDone: 100,
        bytesDone: 500_000,
        totalBytes: 2_000_000,
        updatedAt: minutes(0).toISOString(),
      },
    });
    // Three tries of one restore test of snapshot snapA: only the newest is a row of its own.
    for (const [index, retry] of [0, 1, 2].entries()) {
      const at = minutes(100 - index * 10);
      await agentRun(`test${index}`, {
        kind: "verify_sample",
        status: "failed",
        startedAt: at,
        createdAt: at,
        finishedAt: at,
        taskId: await task(retry, at),
        errors: [{ message: "no room for the copy", code: "no_space" }],
      });
    }
    // A test of another snapshot that a report rated.
    const ratedTask = await task(0, minutes(60), "snapB");
    await agentRun("ratedTest", {
      kind: "verify_sample",
      status: "succeeded",
      startedAt: minutes(60),
      createdAt: minutes(60),
      finishedAt: minutes(59),
      taskId: ratedTask,
    });
    await owner.insert(endpointReports).values({
      tenantId: contoso,
      endpointId: machine,
      kind: "restore_test",
      snapshotId: "snapA",
      readiness: "green",
      runId: runs.test2,
      checkedAt: minutes(79),
    });
    await owner.insert(runSamples).values({
      tenantId: contoso,
      endpointRunId: runs.machineRunning,
      baselineBytes: 1_000_000,
      points: [
        samplePoint(minutes(1).getTime(), 0, 0),
        samplePoint(minutes(1).getTime() + 5000, 500_000, 120_000),
      ],
    });

    // --- Another tenant's run ------------------------------------------------------------------
    const [foreignSource] = await owner
      .insert(sources)
      .values({ tenantId: fabrikam, kind: "imap", name: "Fabrikam IMAP", status: "active" })
      .returning();
    const [foreignObject] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: fabrikam,
        sourceId: foreignSource?.id ?? "",
        kind: "imap",
        externalId: "x@fabrikam.example",
      })
      .returning();
    const [foreign] = await owner
      .insert(jobs)
      .values({
        tenantId: fabrikam,
        queue: "backup",
        status: "completed",
        protectedObjectId: foreignObject?.id,
        createdAt: minutes(5),
      })
      .returning();
    foreignRun = foreign?.id ?? "";

    app = new Hono();
    app.onError((error, c) => {
      if (!(error instanceof ProblemError)) {
        console.error(error);
      }
      return errorHandler(error, c);
    });
    app.route("/history", buildHistoryRoutes({ db: appDb, requireAdmin: stand("tenant_admin") }));
    app.route("/live", buildLiveRoutes({ db: appDb, requireAdmin: stand("tenant_admin") }));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function call(path: string, options: { tenant?: string; role?: Role } = {}) {
    return app.request(path, {
      headers: {
        "x-restow-tenant": options.tenant ?? contoso,
        [ROLE_HEADER]: options.role ?? "tenant_admin",
      },
    });
  }

  async function page(query = "", tenant?: string): Promise<Page> {
    const response = await call(`/history${query}`, { tenant });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Page;
  }

  /** Every page of `query`, followed through `next`. */
  async function all(query = ""): Promise<RunDto[]> {
    const items: RunDto[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const sep = query.includes("?") ? "&" : "?";
      const next: Page = await page(
        cursor ? `${query}${sep}cursor=${encodeURIComponent(cursor)}` : query,
      );
      items.push(...next.items);
      cursor = next.next;
      if (!cursor) {
        return items;
      }
    }
    throw new Error("the cursor never ended");
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  it("lists the mail runs and the runs agents reported together, newest first", async () => {
    const { items, next } = await page("?limit=200");
    expect(next).toBeNull();
    const created = items.map((item) => Date.parse(item.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));
    const sources = new Set(items.map((item) => item.source));
    expect(sources).toEqual(new Set(["mail", "endpoint"]));
    expect(items[0]?.id).toBe(runs.machineRunning);
    // Nothing of the other tenant.
    expect(items.map((item) => item.id)).not.toContain(foreignRun);
  });

  it("pages through everything without a run twice or missing, whatever the page size", async () => {
    const everything = (await all("?limit=200")).map((item) => item.id);
    expect(new Set(everything).size).toBe(everything.length);
    for (const size of [1, 2, 3, 5]) {
      const paged = (await all(`?limit=${size}`)).map((item) => item.id);
      expect(paged, `limit ${size}`).toEqual(everything);
    }
    const firstPage = await page("?limit=3");
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.next).not.toBeNull();
  });

  it("filters by tab", async () => {
    const backups = await all("?type=backup");
    expect(backups.every((item) => item.kind === "backup")).toBe(true);
    expect(backups.map((item) => item.source).sort()).toEqual(
      ["endpoint", "endpoint", "mail", "mail"].sort(),
    );
    expect((await all("?type=export")).map((item) => item.id)).toEqual([runs.export]);
    expect((await all("?type=restore")).map((item) => item.id)).toEqual([runs.restore]);
    expect((await all("?type=maintenance")).map((item) => item.id)).toEqual([runs.maintenance]);
    expect(await all("?type=import")).toEqual([]);
    const checks = await all("?type=restore_check");
    expect(checks.every((item) => item.kind === "restore_check")).toBe(true);
  });

  it("shows the tries of one restore test as one row, with the attempt it is on", async () => {
    const checks = await all("?type=restore_check");
    const ofMachine = checks.filter((item) => item.source === "endpoint");
    // Three tries of snapA (the newest shows) and the rated test of snapB.
    expect(ofMachine.map((item) => item.id).sort()).toEqual([runs.test2, runs.ratedTest].sort());
    const newest = ofMachine.find((item) => item.id === runs.test2);
    expect(newest?.attempt).toEqual({ number: 3, of: 7 });
    // The older tries are still reachable by their address.
    const older = await call(`/history/${runs.test0}`);
    expect(older.status).toBe(200);
    // A mail check that failed its second attempt waits for the third.
    const mailCheck = checks.find((item) => item.id === runs.benVerifyRetry);
    expect(mailCheck).toMatchObject({ state: "queued", attempt: { number: 2, of: 6 } });
  });

  it("filters by backup job: its backups and its objects' checks, or its machines' runs", async () => {
    const mine = await all(`?job=${mailJob}`);
    expect(mine.map((item) => item.id).sort()).toEqual(
      [runs.annaBackup, runs.annaVerify, runs.benBackup, runs.benVerifyRetry].sort(),
    );
    expect(mine.every((item) => item.source === "mail")).toBe(true);
    const machines = await all(`?job=${machineJob}`);
    expect(machines.every((item) => item.source === "endpoint")).toBe(true);
    expect(machines.map((item) => item.id)).toContain(runs.machineBackup);
    // A tab on top of the job narrows it further.
    expect((await all(`?job=${mailJob}&type=backup`)).map((item) => item.id).sort()).toEqual(
      [runs.annaBackup, runs.benBackup].sort(),
    );
    // A job of another tenant, or none, is a plain 404.
    const missing = await call(`/history?job=${randomUUID()}`);
    expect(missing.status).toBe(404);
    const foreignJob = await call(`/history?job=${mailJob}`, { tenant: fabrikam });
    expect(foreignJob.status).toBe(404);
  });

  it("carries the measurements of a run that is running, and of no other row", async () => {
    const items = await all("?limit=200");
    const ben = items.find((item) => item.id === runs.benBackup);
    expect(ben?.state).toBe("running");
    expect(ben?.samples).toHaveLength(3);
    expect(ben?.throughput?.processedBps).toBeGreaterThan(0);
    expect(ben?.progress).toMatchObject({
      percent: 25,
      bytesProcessed: 20_000,
      bytesTransferred: 300,
      etaSeconds: 90,
    });
    const anna = items.find((item) => item.id === runs.annaBackup);
    expect(anna?.state).toBe("succeeded");
    expect(anna?.samples).toBeNull();
    const machineNow = items.find((item) => item.id === runs.machineRunning);
    expect(machineNow?.samples).toHaveLength(2);
    expect(machineNow?.progress).toMatchObject({ percent: 25, bytesTransferred: 120_000 });
    expect(machineNow?.job).toEqual({ id: machineJob, name: "Linux servers" });
  });

  it("names the backup job a mail run was queued for", async () => {
    const items = await all("?type=backup");
    const anna = items.find((item) => item.id === runs.annaBackup);
    expect(anna?.job).toEqual({ id: mailJob, name: "Mail backup" });
  });

  it("refuses a cursor it did not issue, and a malformed query", async () => {
    expect((await call("/history?cursor=nonsense")).status).toBe(400);
    expect((await call("/history?type=bogus")).status).toBe(422);
    expect((await call("/history?limit=0")).status).toBe(422);
    expect((await call("/history?limit=500")).status).toBe(422);
  });

  // -------------------------------------------------------------------------
  // The detail
  // -------------------------------------------------------------------------

  async function detail(id: string, tenant?: string): Promise<RunDetailDto> {
    const response = await call(`/history/${id}`, { tenant });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as RunDetailDto;
  }

  it("opens a finished mail backup with its result, its wave and the restore check that passed", async () => {
    const run = await detail(runs.annaBackup as string);
    expect(run).toMatchObject({
      state: "succeeded",
      kind: "backup",
      job: { id: mailJob, name: "Mail backup" },
      restoreCheck: { state: "passed", runId: runs.annaVerify },
      summary: { itemsWritten: 12, itemsTotal: 40, bytesNew: 5000, snapshot: { sequence: 7 } },
    });
    // Both runs of the job's wave are listed; the opened one comes first.
    expect(run.batch).toMatchObject({ total: 2, running: 1, succeeded: 1 });
    expect(
      run.objects.map((object) => [object.subject.name, object.current, object.state]),
    ).toEqual([
      ["anna", true, "succeeded"],
      ["ben", false, "running"],
    ]);
    expect(run.objects[0]?.restoreCheck.state).toBe("passed");
    expect(run.objects[1]?.restoreCheck.state).toBe("none");
    // The timeline: queued, started, completed and the check, in time order with the gaps.
    expect(run.events.map((event) => event.type)).toEqual([
      "queued",
      "started",
      "completed",
      "restore_check_passed",
    ]);
    expect(run.events[0]?.durationMs).toBeNull();
    expect(run.events[2]?.durationMs).toBe(10 * 60_000);
    // All of the measurements, for the charts.
    expect(run.samples).toHaveLength(2);
    expect(run.docsUrl).toMatch(/^https?:/);
  });

  it("opens a running mail backup: progress, speed, and no restore check yet", async () => {
    const run = await detail(runs.benBackup as string);
    expect(run.state).toBe("running");
    expect(run.cancellable).toBe(true);
    expect(run.restoreCheck.state).toBe("none");
    expect(run.samples).toHaveLength(3);
    expect(run.events.map((event) => event.type)).toContain("started");
    expect(run.events.map((event) => event.type)).not.toContain("completed");
  });

  it("opens a restore check with its own rating as the result", async () => {
    const run = await detail(runs.annaVerify as string);
    expect(run).toMatchObject({ kind: "restore_check", restoreCheck: { state: "passed" } });
  });

  it("opens an agent backup with its errors, log, wave and the machine's own restore test", async () => {
    const run = await detail(runs.machineBackup as string);
    expect(run).toMatchObject({
      source: "endpoint",
      state: "succeeded",
      subject: { name: "Fileserver", kind: "server" },
      summary: { filesNew: 10, filesChanged: 5, bytesNew: 4000, snapshot: { id: "snapA" } },
      errorCount: 1,
      logTail: "line 1\nline 2",
      errors: [{ path: "/srv/locked", message: "permission denied" }],
      // The report of snapA rated it green.
      restoreCheck: { state: "passed" },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "agent_error",
      "finished",
      "restore_check_passed",
    ]);
    expect(run.objects.map((object) => object.subject.name)).toEqual(["Fileserver"]);
  });

  it("opens a run an agent is still running with the repository growth as what it transferred", async () => {
    const run = await detail(runs.machineRunning as string);
    expect(run.state).toBe("running");
    expect(run.progress).toMatchObject({
      bytesProcessed: 500_000,
      bytesTransferred: 120_000,
      bytesTotal: 2_000_000,
    });
    expect(run.cancellable).toBe(false);
  });

  it("answers 404 for a run that does not exist or belongs to another tenant, 422 for no id", async () => {
    expect((await call(`/history/${randomUUID()}`)).status).toBe(404);
    expect((await call(`/history/${foreignRun}`)).status).toBe(404);
    expect((await call("/history/not-an-id")).status).toBe(422);
    // The other tenant sees its own run.
    expect((await detail(foreignRun, fabrikam)).id).toBe(foreignRun);
  });

  it("asks for a tenant administrator", async () => {
    for (const role of ["tenant_user"] as const) {
      expect((await call("/history", { role })).status).toBe(403);
      expect((await call(`/history/${runs.annaBackup}`, { role })).status).toBe(403);
      expect((await call("/live", { role })).status).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it("shows each tenant only its own runs", async () => {
    const theirs = await all("?limit=200");
    expect(theirs.length).toBeGreaterThan(5);
    const foreign = await page("", fabrikam);
    expect(foreign.items.map((item) => item.id)).toEqual([foreignRun]);
    // Also for the samples: contoso's measurements are not readable as fabrikam.
    const rows = await appDb.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`select set_config('app.tenant_id', ${fabrikam}, true)`,
      );
      return tx.select().from(runSamples);
    });
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The live channel
  // -------------------------------------------------------------------------

  it("follows the runs in flight and those that finished lately, not older ones", async () => {
    const sources = databaseSources(appDb, contoso, minutes(115));
    const { runs: live, jobs: legacy } = await sources.runs();
    const ids = live.map((run) => run.id);
    // The queued retry and the two running runs, and the ones that moved inside the window.
    expect(ids).toContain(runs.benBackup);
    expect(ids).toContain(runs.machineRunning);
    expect(ids).toContain(runs.benVerifyRetry);
    expect(ids).toContain(runs.annaVerify);
    expect(ids).not.toContain(runs.maintenance);
    expect(ids).not.toContain(runs.export);
    // Running runs come first.
    expect(live.slice(0, 2).every((run) => run.state === "running")).toBe(true);
    // The mail runs also come in the legacy shape.
    expect(legacy.map((job) => job.id)).toContain(runs.benBackup);
    expect(legacy.map((job) => job.id)).not.toContain(runs.machineRunning);
  });

  it("reads the machines' connection state and the backup jobs' state for the stream", async () => {
    const sources = databaseSources(appDb, contoso, minutes(100));
    const machines = await sources.machines();
    expect(machines).toEqual([
      expect.objectContaining({ id: machine, status: "active", connection: "online" }),
    ]);
    const definitions = await sources.definitions();
    expect(definitions.map((definition) => definition.id).sort()).toEqual(
      [mailJob, machineJob].sort(),
    );
    const mailDefinition = definitions.find((definition) => definition.id === mailJob);
    expect(mailDefinition).toMatchObject({ kind: "mail", enabled: true });
    expect(mailDefinition?.lastRun.running).toBe(1);
    // "The job's current or last run" is the run that is going, else the newest that ended.
    expect(mailDefinition?.lastRun.runId).toBe(runs.benBackup);
    const machineDefinition = definitions.find((definition) => definition.id === machineJob);
    expect(machineDefinition?.lastRun.runId).toBe(runs.machineRunning);
    // What moves, not what is edited: no schedule or settings on the wire.
    expect(mailDefinition).not.toHaveProperty("settings");
    expect(mailDefinition).not.toHaveProperty("schedule");
  });

  it("opens with a snapshot and then sends the run whose progress moved", async () => {
    const step = createLiveStep(databaseSources(appDb, contoso, minutes(100)));
    const first = await step();
    expect(first.messages.map((message) => message.event)).toEqual(["snapshot", "jobs"]);
    const snapshot = JSON.parse(first.messages[0]?.data ?? "{}");
    expect(snapshot.runs.length).toBeGreaterThan(2);
    expect(snapshot.machines).toHaveLength(1);
    expect(snapshot.definitions).toHaveLength(2);
    expect((await step()).messages).toEqual([]);

    // The worker publishes progress: ben's backup is at 60 items now.
    await owner
      .update(jobProgress)
      .set({ done: 60, bytesProcessed: 40_000, updatedAt: new Date(NOW.getTime() + 1000) })
      .where(eq(jobProgress.jobId, runs.benBackup as string));
    const moved = await step();
    expect(moved.messages.map((message) => message.event)).toEqual(["run", "job"]);
    const run = JSON.parse(moved.messages[0]?.data ?? "{}") as RunDto;
    expect(run.id).toBe(runs.benBackup);
    expect(run.progress).toMatchObject({ itemsDone: 60, bytesProcessed: 40_000, percent: 60 });
    expect(JSON.parse(moved.messages[1]?.data ?? "{}").id).toBe(runs.benBackup);

    // It finishes: the run changes state and the job's last run is re-read in the same poll.
    await owner
      .update(jobs)
      .set({ status: "completed", completedAt: new Date(NOW.getTime() + 2000) })
      .where(eq(jobs.id, runs.benBackup as string));
    const finished = await step();
    const events = finished.messages.map((message) => message.event);
    expect(events).toContain("run");
    expect(events).toContain("definition");
    const definition = finished.messages.find((message) => message.event === "definition");
    expect(JSON.parse(definition?.data ?? "{}").lastRun.running).toBe(0);
  });
});
