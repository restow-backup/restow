/**
 * File share jobs and copy jobs through the backup job routes against Postgres
 * (docs/FILESHARES.md 7.5, 4.10, 9.1): a share job with members, its include folders and
 * schedule overrides, "run now" queueing backup runs, and its standing from the members; a copy
 * job with its two shares, the safety rules on save (restore not allowed, same place, share
 * root for mirror), the mirror confirmation for a folder that is not empty (409 with the entry
 * count, cleared by a change of target), "Copy anyway", and the job never counted as protection.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { RunnerClient, RunnerExecRequest, RunnerExecResult } from "@restow/core";
import {
  type Database,
  auditLog,
  backupJobMembers,
  backupJobs,
  createDb,
  fileShareRuns,
  fileShares,
  providers,
  settings,
  tenants,
  user,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { BackupJobDto, BackupJobListDto, BackupJobMembersDto } from "./dto.js";

const DATABASE = "restow_api_share_jobs_test";
const ZONE = "Europe/Berlin";

/** A mounter whose listing of the target folder each test decides. */
class FakeRunner implements RunnerClient {
  readonly enabled = true;
  listed: RunnerExecRequest[] = [];
  answer: () => RunnerExecResult = () => ({
    ok: true,
    code: null,
    detail: null,
    output: { ok: true, entries: [], truncated: false, durationMs: 5 },
  });
  async capabilities() {
    return null;
  }
  async exec(request: RunnerExecRequest) {
    this.listed.push(request);
    return this.answer();
  }
  async start(): Promise<never> {
    throw new Error("not used");
  }
  async list() {
    return [];
  }
  async get() {
    return null;
  }
  async stop() {}
  async removeCache() {}
}

describe.skipIf(!testDatabaseAdminUrl)("file share and copy jobs against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let tenantId: string;
  let otherTenantId: string;
  const adminId = randomUUID();
  const clock = new Date("2026-10-10T10:00:00.000Z");
  const runner = new FakeRunner();
  const shares: Record<string, string> = {};

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { buildBackupJobsRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");
    await owner
      .insert(user)
      .values({ id: adminId, name: "Admin", email: "admin@contoso.example", emailVerified: true });
    await owner.insert(settings).values({}).onConflictDoNothing();
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const made = await owner
      .insert(tenants)
      .values([
        {
          providerId: provider?.id ?? "",
          name: "Contoso",
          slug: "contoso",
          backupJobsMigratedAt: clock,
        },
        {
          providerId: provider?.id ?? "",
          name: "Fabrikam",
          slug: "fabrikam",
          backupJobsMigratedAt: clock,
        },
      ])
      .returning();
    tenantId = made[0]?.id ?? "";
    otherTenantId = made[1]?.id ?? "";
    const nfs = (name: string, exportPath: string, allowRestore: boolean, server = "1.1.1.1") => ({
      tenantId,
      name,
      protocol: "nfs" as const,
      server,
      exportPath,
      nfsVersion: "4.1" as const,
      allowRestore,
    });
    const rows = await owner
      .insert(fileShares)
      .values([
        nfs("Projects", "/srv/projects", false),
        nfs("Scans", "/srv/scans", false),
        nfs("Standby", "/srv/standby", true, "8.8.8.8"),
        nfs("Locked", "/srv/locked", false, "8.8.4.4"),
        { ...nfs("Foreign", "/srv/foreign", true), tenantId: made[1]?.id ?? "" },
      ])
      .returning();
    for (const row of rows) shares[row.name] = row.id;

    const stand: MiddlewareHandler<TenantEnv> = async (c, next) => {
      c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
      c.set("role", "tenant_admin");
      c.set("user", { id: adminId, email: "admin@contoso.example" } as unknown as SessionUser);
      c.set("auth", { session: { createdAt: new Date(), authMethod: "passkey" } } as never);
      await next();
    };
    app = new Hono();
    app.onError((error, c) => {
      if (!(error instanceof ProblemError)) console.error(error);
      return errorHandler(error, c);
    });
    app.route(
      "/backup-jobs",
      buildBackupJobsRoutes({
        db: appDb,
        requireAdmin: stand,
        now: () => clock,
        fileShares: { runner, resolve: async () => ["8.8.8.8"] },
      }),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(async () => {
    runner.listed = [];
    runner.answer = new FakeRunner().answer;
    await owner.delete(fileShareRuns);
    await owner.delete(backupJobs);
  });

  async function call(method: string, path: string, body?: unknown, tenant = tenantId) {
    const response = await app.request(path, {
      method,
      headers: { "x-restow-tenant": tenant, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  const daily = { kind: "daily", timeOfDay: "22:00", timeZone: ZONE };

  describe("share jobs", () => {
    it("creates a job with shares, include folders and its own retention", async () => {
      const created = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "File servers",
        schedule: daily,
        scope: {
          mode: "selected",
          members: [
            { id: shares.Projects, overrides: { includes: ["/Active/", "Archive\\2025"] } },
            { id: shares.Scans },
          ],
        },
        settings: {
          excludes: ["*.bak"],
          presets: { systemFiles: true },
          fileTypes: { exclude: [".iso", "tmp"] },
          skipOffline: true,
          readConcurrency: 6,
          retention: { keepDaily: 14, keepWeekly: 8, keepMonthly: 6 },
        },
      });
      expect(created.status).toBe(201);
      const job = created.body as BackupJobDto;
      expect(job).toMatchObject({
        kind: "share",
        // A daily time is stored as the cron expression the scheduler plans with.
        schedule: { kind: "cron", cron: "0 22 * * *", timeZone: ZONE },
        scope: { count: 2, byKind: { nfs: 2 }, overrides: 1 },
        retention: { keep: { keepDaily: 14, keepWeekly: 8, keepMonthly: 6 } },
        settings: { fileTypes: { exclude: ["iso", "tmp"] }, readConcurrency: 6 },
        restoreCheck: { noBackup: 2, total: 2 },
        copy: null,
      });
      const [row] = await owner.select().from(backupJobs).where(eq(backupJobs.id, job.id));
      expect(row?.nextRunAt).not.toBeNull();
      const members = (await call("GET", `/backup-jobs/${job.id}/members`))
        .body as BackupJobMembersDto;
      expect(
        members.items.map((member) => [member.name, member.kind, member.overrides.includes]),
      ).toEqual([
        ["Projects", "nfs", ["Active", "Archive/2025"]],
        ["Scans", "nfs", undefined],
      ]);
      const listed = (await call("GET", "/backup-jobs?kind=share")).body as BackupJobListDto;
      expect(listed.items).toHaveLength(1);
      // Standby and Locked are in no share job.
      expect(listed.uncovered.share).toBe(2);
    });

    it("refuses what a share job cannot have", async () => {
      const verify = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "x",
        schedule: daily,
        verifySchedule: daily,
      });
      expect(verify.status).toBe(422);
      expect(verify.body.code).toBe("restore_check_not_supported");
      const hourly = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "x",
        schedule: { kind: "interval", intervalMinutes: 30, timeZone: ZONE },
      });
      expect(hourly.status).toBe(422);
      const hooks = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "x",
        schedule: daily,
        settings: { hooks: { pre: "echo" } },
      });
      expect(hooks.status).toBe(422);
      const foreign = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "x",
        schedule: daily,
        scope: { mode: "selected", members: [{ id: shares.Foreign }] },
      });
      expect(foreign.status).toBe(422);
      expect(foreign.body.code).toBe("file_share_not_found");
    });

    it("runs a job now: one queued backup per share, the waiting ones skipped", async () => {
      const job = (
        await call("POST", "/backup-jobs", {
          kind: "share",
          name: "Nightly",
          schedule: daily,
          scope: { mode: "selected", members: [{ id: shares.Projects }, { id: shares.Scans }] },
        })
      ).body as BackupJobDto;
      const first = await call("POST", `/backup-jobs/${job.id}/run`, {});
      expect(first.body).toEqual({ queued: 2, skipped: [] });
      const second = await call("POST", `/backup-jobs/${job.id}/run`, {});
      expect(second.body.queued).toBe(0);
      expect(second.body.skipped.map((entry: { reason: string }) => entry.reason)).toEqual([
        "already_queued",
        "already_queued",
      ]);
      const runs = await owner.select().from(fileShareRuns);
      expect(runs.map((run) => [run.kind, run.status, run.backupJobId])).toEqual([
        ["backup", "queued", job.id],
        ["backup", "queued", job.id],
      ]);
      const after = (await call("GET", `/backup-jobs/${job.id}`)).body as BackupJobDto;
      expect(after.lastRun.queued).toBe(2);
      const history = (await call("GET", `/backup-jobs/${job.id}/runs`)).body;
      expect(history.items).toHaveLength(2);
      expect(history.items[0]).toMatchObject({ source: "file_share", type: "backup" });
    });

    it("moves a share between jobs only when asked", async () => {
      const a = (
        await call("POST", "/backup-jobs", {
          kind: "share",
          name: "A",
          schedule: daily,
          scope: { mode: "selected", members: [{ id: shares.Projects }] },
        })
      ).body as BackupJobDto;
      const conflict = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "B",
        schedule: daily,
        scope: { mode: "selected", members: [{ id: shares.Projects }] },
      });
      expect(conflict.status).toBe(409);
      const moved = await call("POST", "/backup-jobs", {
        kind: "share",
        name: "B",
        schedule: daily,
        moveMembers: true,
        scope: { mode: "selected", members: [{ id: shares.Projects }] },
      });
      expect(moved.status).toBe(201);
      const left = (await call("GET", `/backup-jobs/${a.id}`)).body as BackupJobDto;
      expect(left.scope.count).toBe(0);
      const members = await owner.select().from(backupJobMembers);
      expect(members.map((member) => member.fileShareId)).toEqual([shares.Projects]);
    });
  });

  describe("copy jobs", () => {
    const copyBody = (overrides: Record<string, unknown> = {}) => ({
      kind: "copy",
      name: "Standby copy",
      schedule: { kind: "daily", timeOfDay: "06:00", timeZone: ZONE },
      sourceFileShareId: shares.Projects,
      targetFileShareId: shares.Standby,
      settings: { mode: "overwrite", targetFolder: "Projects" },
      ...overrides,
    });

    it("creates an overwrite copy with its two shares; it is never protection", async () => {
      const created = await call("POST", "/backup-jobs", copyBody());
      expect(created.status).toBe(201);
      const job = created.body as BackupJobDto;
      expect(job).toMatchObject({
        kind: "copy",
        copy: {
          source: { id: shares.Projects, name: "Projects" },
          target: { id: shares.Standby, name: "Standby", allowRestore: true },
          mode: "overwrite",
          targetFolder: "Projects",
          mirrorConfirmedAt: null,
          lastCopied: null,
        },
        restoreCheck: { total: 0 },
      });
      // The overwrite mode never looks into the folder.
      expect(runner.listed).toEqual([]);
      const audit = await owner
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "backup_job.created"));
      expect(audit.at(-1)?.details).toMatchObject({ mode: "overwrite", mirrorConfirmed: false });
      const members = await call("GET", `/backup-jobs/${job.id}/members`);
      expect(members.body.items).toEqual([]);
      const add = await call("POST", `/backup-jobs/${job.id}/members`, {
        members: [{ id: shares.Scans }],
      });
      expect(add.status).toBe(409);
    });

    it("refuses an unsafe target with the rule that failed", async () => {
      const notAllowed = await call(
        "POST",
        "/backup-jobs",
        copyBody({ targetFileShareId: shares.Locked }),
      );
      expect(notAllowed.status).toBe(422);
      expect(notAllowed.body).toMatchObject({
        type: "urn:restow:problem:file-share-restore-not-allowed",
        rule: "restore_not_allowed",
      });
      const same = await call(
        "POST",
        "/backup-jobs",
        copyBody({ targetFileShareId: shares.Projects }),
      );
      expect(same.status).toBe(422);
      const root = await call(
        "POST",
        "/backup-jobs",
        copyBody({ settings: { mode: "mirror", targetFolder: "/" } }),
      );
      expect(root.status).toBe(422);
      expect(root.body).toMatchObject({
        type: "urn:restow:problem:file-share-copy-unsafe-target",
        rule: "share_root",
      });
      const foreign = await call(
        "POST",
        "/backup-jobs",
        copyBody({ targetFileShareId: shares.Foreign }),
      );
      expect(foreign.status).toBe(422);
      expect(foreign.body.code).toBe("file_share_not_found");
    });

    it("asks to confirm a mirror into a folder that is not empty, and keeps the confirmation", async () => {
      runner.answer = () => ({
        ok: true,
        code: null,
        detail: null,
        output: {
          ok: true,
          entries: [
            { name: "old.txt", type: "file", size: 1, mtime: "2026-10-01T00:00:00Z" },
            { name: "keep", type: "dir", size: 0, mtime: "2026-10-01T00:00:00Z" },
          ],
          truncated: false,
          durationMs: 3,
        },
      });
      const body = copyBody({ settings: { mode: "mirror", targetFolder: "Replica" } });
      const asked = await call("POST", "/backup-jobs", body);
      expect(asked.status).toBe(409);
      expect(asked.body).toMatchObject({
        type: "urn:restow:problem:file-share-copy-confirm",
        entries: 2,
        folder: "Replica",
      });
      expect(runner.listed[0]).toMatchObject({ op: "list", path: "Replica" });
      const confirmed = await call("POST", "/backup-jobs", { ...body, confirmMirror: true });
      expect(confirmed.status).toBe(201);
      const job = confirmed.body as BackupJobDto;
      expect(job.copy?.mirrorConfirmedAt).toBe(clock.toISOString());
      // A change of name keeps the confirmation; a new folder clears it and asks again.
      const renamed = await call("PATCH", `/backup-jobs/${job.id}`, { name: "Replica copy" });
      expect(renamed.body.copy.mirrorConfirmedAt).toBe(clock.toISOString());
      const moved = await call("PATCH", `/backup-jobs/${job.id}`, {
        settings: { mode: "mirror", targetFolder: "Replica2" },
      });
      expect(moved.status).toBe(409);
    });

    it("needs no confirmation for a folder that does not exist yet", async () => {
      runner.answer = () => ({
        ok: false,
        code: "not_found",
        detail: "no such folder",
        output: { ok: false, code: "not_found", durationMs: 1 },
      });
      const created = await call(
        "POST",
        "/backup-jobs",
        copyBody({ settings: { mode: "mirror", targetFolder: "New replica" } }),
      );
      expect(created.status).toBe(201);
      expect(created.body.copy.mirrorConfirmedAt).toBeNull();
    });

    it("runs a copy as a restore run of the job; Copy anyway carries force", async () => {
      const job = (await call("POST", "/backup-jobs", copyBody())).body as BackupJobDto;
      const run = await call("POST", `/backup-jobs/${job.id}/run`, { force: true });
      expect(run.body).toEqual({ queued: 1, skipped: [] });
      const again = await call("POST", `/backup-jobs/${job.id}/run`, {});
      expect(again.body.skipped[0]).toMatchObject({
        reason: "already_queued",
        targetId: shares.Standby,
      });
      const [row] = await owner.select().from(fileShareRuns);
      expect(row).toMatchObject({
        kind: "restore",
        trigger: "copy",
        status: "queued",
        fileShareId: shares.Projects,
        lockShareId: shares.Standby,
        targetShareId: shares.Standby,
        backupJobId: job.id,
        params: { force: true },
      });
      const listed = (await call("GET", `/backup-jobs/${job.id}`)).body as BackupJobDto;
      expect(listed.lastRun.queued).toBe(1);
    });

    it("keeps tenants apart", async () => {
      const job = (await call("POST", "/backup-jobs", copyBody())).body as BackupJobDto;
      const other = await call("GET", `/backup-jobs/${job.id}`, undefined, otherTenantId);
      expect(other.status).toBe(404);
    });
  });
});
