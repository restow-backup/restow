/**
 * The api's side of a file share run against Postgres (docs/FILESHARES.md 5): the runner routes
 * (`/internal/file-shares/v1`: session, progress, items, samples, finish) and the persisted
 * parts of the runners' restic route (credentials from `file_share_runs`, the lock registry in
 * `file_share_repository_locks`, the budgets, the size accounting, denials in the audit log).
 * The routes run in this process on the real handlers; no restic is needed (the end-to-end run
 * with restow-share and restic is apps/worker/src/file-shares/e2e.pg.test.ts).
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GIB, hashSecret } from "@restow/core";
import {
  auditLog,
  backupJobMembers,
  backupJobs,
  fileShareRepositoryLocks,
  fileShareRunItems,
  fileShareRuns,
  fileShareSamples,
  fileShareSnapshots,
  fileShares,
  runSamples,
  settings,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_file_shares_test";
const TOKEN = randomBytes(32).toString("base64url");

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const basic = (runId: string, token = TOKEN) =>
  `Basic ${Buffer.from(`${runId}:${token}`).toString("base64")}`;

describe.skipIf(!testDatabaseAdminUrl)("file share runner routes against Postgres", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let shareId: string;
  let repositoryPassword: string;

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    const { errorHandler } = await import("../../problem.js");
    const { fileShareRunnerRoutes } = await import("./runner-routes.js");
    const { FILE_SHARE_RESTIC_PATH, fileShareResticRoutes } = await import("./restic-route.js");
    const { FILE_SHARE_RUNNER_PATH } = await import("./constants.js");
    const secretStore = await import("../../lib/secrets.js");
    const shared = await import("../../db.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route(FILE_SHARE_RESTIC_PATH, fileShareResticRoutes);
    app.route(FILE_SHARE_RUNNER_PATH, fileShareRunnerRoutes);
    await fixture.db.insert(settings).values({}).onConflictDoNothing();

    repositoryPassword = `repo-${randomBytes(12).toString("hex")}`;
    const ref = await secretStore.storeSecret(shared.db, {
      tenantId: fixture.tenantId,
      kind: "file_share_repository",
      plaintext: repositoryPassword,
    });
    const [share] = await fixture.db
      .insert(fileShares)
      .values({
        tenantId: fixture.tenantId,
        name: "Data",
        protocol: "smb",
        server: "files.example.test",
        shareName: "data",
        repositorySecretId: ref.id,
        repositoryReadyAt: new Date(),
      })
      .returning();
    shareId = share?.id as string;
    const [job] = await fixture.db
      .insert(backupJobs)
      .values({
        tenantId: fixture.tenantId,
        kind: "share",
        name: "Shares",
        schedule: { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" },
        settings: {
          excludes: ["*.bak"],
          presets: { systemFiles: false },
          readConcurrency: 6,
          excludeLargerThanGib: 1,
        },
      })
      .returning();
    await fixture.db.insert(backupJobMembers).values({
      tenantId: fixture.tenantId,
      jobId: job?.id as string,
      fileShareId: shareId,
      overrides: { includes: ["Finance", "/HR/"] },
    });
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  beforeEach(async () => {
    await fixture.db.delete(fileShareRuns);
  });

  async function startedRun(
    values: Partial<typeof fileShareRuns.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await fixture.db
      .insert(fileShareRuns)
      .values({
        tenantId: fixture.tenantId,
        fileShareId: shareId,
        lockShareId: shareId,
        kind: "backup",
        status: "starting",
        startedAt: new Date(),
        tokenHash: hashSecret(TOKEN),
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ...values,
      })
      .returning();
    return row?.id as string;
  }

  async function runner(
    method: string,
    path: string,
    runId: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.request(`/internal/file-shares/v1${path}`, {
      method,
      headers: {
        authorization: basic(runId),
        host: "api:3000",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function run(id: string) {
    const [row] = await fixture.db.select().from(fileShareRuns).where(eq(fileShareRuns.id, id));
    return row;
  }

  describe("the session", () => {
    it("refuses a missing or wrong credential, and every request through a proxy", async () => {
      const runId = await startedRun();
      expect((await app.request("/internal/file-shares/v1/session")).status).toBe(401);
      const wrong = await app.request("/internal/file-shares/v1/session", {
        headers: { authorization: basic(runId, randomBytes(32).toString("base64url")) },
      });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("www-authenticate")).toBe('Basic realm="restow-share"');
      expect((await runner("GET", "/session", randomUUID())).status).toBe(401);
      for (const header of ["x-forwarded-for", "forwarded", "via"]) {
        const proxied = await runner("GET", "/session", runId, undefined, {
          [header]: "203.0.113.4",
        });
        expect(proxied.status, header).toBe(404);
      }
    });

    it("hands a backup its parameters and moves the run to running", async () => {
      const [previous] = await fixture.db
        .insert(fileShareSnapshots)
        .values({
          tenantId: fixture.tenantId,
          fileShareId: shareId,
          sequence: 1,
          resticSnapshotId: "c".repeat(64),
          snapshotTime: new Date(),
          files: 1234,
        })
        .returning();
      const runId = await startedRun({ params: { allowEmptyOnce: true } });
      const response = await runner("GET", "/session", runId);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const session = (await response.json()) as Record<string, unknown>;
      expect(session).toMatchObject({
        run: { id: runId, kind: "backup", shareId },
        expect: { protocol: "smb", readOnly: true },
        repository: {
          url: `rest:http://api:3000/internal/file-shares/restic/${shareId}/`,
          repositoryPassword,
        },
        backup: {
          includes: ["Finance", "HR"],
          excludes: ["*.bak"],
          caseInsensitive: true,
          excludeLargerThanBytes: GIB,
          readConcurrency: 6,
          parentSnapshotId: "c".repeat(64),
          previous: { snapshotId: "c".repeat(64), fileCount: 1234 },
          allowEmptyOnce: true,
          permissions: "auto",
          skipOffline: true,
          samples: 20,
        },
      });
      expect(session.restore).toBeUndefined();
      const running = await run(runId);
      expect(running?.status).toBe("running");
      expect(running?.params.includes).toEqual(["Finance", "HR"]);
      await fixture.db
        .delete(fileShareSnapshots)
        .where(eq(fileShareSnapshots.id, previous?.id as string));
    });

    it("hands a copy run its restore point and the copy rules", async () => {
      const [snap] = await fixture.db
        .insert(fileShareSnapshots)
        .values({
          tenantId: fixture.tenantId,
          fileShareId: shareId,
          sequence: 7,
          resticSnapshotId: "d".repeat(64),
          snapshotTime: new Date(),
        })
        .returning();
      const runId = await startedRun({
        kind: "restore",
        trigger: "copy",
        sourceSnapshotId: snap?.id,
        params: {
          mode: "mirror",
          targetFolder: "Replica",
          mirrorConfirmedAt: new Date().toISOString(),
          lastCopiedFileCount: 42,
        },
      });
      const session = (await (await runner("GET", "/session", runId)).json()) as Record<
        string,
        unknown
      >;
      expect(session.expect).toEqual({ protocol: "smb", readOnly: false });
      expect(session.restore).toEqual({
        snapshotId: "d".repeat(64),
        paths: [],
        destination: "folder",
        folder: "Replica",
        conflict: "",
        restorePermissions: false,
        verify: false,
        targetShareId: shareId,
        copy: {
          jobId: "",
          sourceShareId: shareId,
          mode: "mirror",
          mirrorConfirmed: true,
          lastCopiedFileCount: 42,
          force: false,
        },
      });
      await fixture.db
        .delete(fileShareSnapshots)
        .where(eq(fileShareSnapshots.id, snap?.id as string));
    });

    it("refuses a credential that expired, ended or whose tenant is suspended", async () => {
      const expired = await startedRun({ tokenExpiresAt: new Date(Date.now() - 1000) });
      expect((await runner("GET", "/session", expired)).status).toBe(401);
      await fixture.db.delete(fileShareRuns);
      const ended = await startedRun({ status: "failed", finishedAt: new Date() });
      expect((await runner("GET", "/session", ended)).status).toBe(401);
      await fixture.db.delete(fileShareRuns);
      const live = await startedRun();
      await fixture.db
        .update(tenants)
        .set({ status: "suspended" })
        .where(eq(tenants.id, fixture.tenantId));
      try {
        expect((await runner("GET", "/session", live)).status).toBe(401);
      } finally {
        await fixture.db
          .update(tenants)
          .set({ status: "active" })
          .where(eq(tenants.id, fixture.tenantId));
      }
    });
  });

  describe("progress, items and samples", () => {
    it("records progress with its throughput point and passes a cancel on", async () => {
      const runId = await startedRun({ status: "running" });
      const progress = {
        phase: "backup",
        filesDone: 10,
        bytesDone: 1000,
        totalFiles: 20,
        totalBytes: 2000,
        currentPath: "Finance/Q3.xlsx",
        bytesUploaded: 400,
        at: new Date().toISOString(),
      };
      const answer = await runner("POST", "/progress", runId, progress);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ cancel: false });
      const stored = await run(runId);
      expect(stored?.progress).toMatchObject({
        phase: "backup",
        filesDone: 10,
        currentPath: "Finance/Q3.xlsx",
      });
      expect(stored?.lastProgressAt).not.toBeNull();
      const points = await fixture.db
        .select()
        .from(runSamples)
        .where(eq(runSamples.fileShareRunId, runId));
      expect(points[0]?.points).toHaveLength(1);
      await fixture.db
        .update(fileShareRuns)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(fileShareRuns.id, runId));
      expect(await (await runner("POST", "/progress", runId, progress)).json()).toEqual({
        cancel: true,
      });
      expect((await runner("POST", "/progress", runId, { phase: "x" })).status).toBe(422);
    });

    it("keeps the first 10,000 items of a run and counts the rest", async () => {
      const runId = await startedRun({ status: "running" });
      const items = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          path: `f${i}`,
          code: "locked_file",
          message: `open on the server ${"x".repeat(600)}`,
          phase: "backup",
        }));
      expect((await runner("POST", "/items", runId, { items: items(500) })).status).toBe(204);
      expect((await runner("POST", "/items", runId, { items: items(501) })).status).toBe(422);
      await fixture.db
        .update(fileShareRuns)
        .set({ itemsStored: 9_900 })
        .where(eq(fileShareRuns.id, runId));
      expect((await runner("POST", "/items", runId, { items: items(500) })).status).toBe(204);
      const stored = await run(runId);
      expect(stored).toMatchObject({ itemCount: 1000, itemsStored: 10_000 });
      const rows = await fixture.db
        .select()
        .from(fileShareRunItems)
        .where(eq(fileShareRunItems.runId, runId));
      expect(rows).toHaveLength(600);
      expect(rows.every((row) => row.message.length <= 500)).toBe(true);
    });

    it("stores the samples of a backup, and none for a restore", async () => {
      const runId = await startedRun({ status: "running" });
      const files = [{ path: "/share/Finance/Q3.xlsx", sha256: "e".repeat(64), size: 10 }];
      expect(
        (await runner("POST", "/samples", runId, { snapshotId: "f".repeat(64), files })).status,
      ).toBe(204);
      // The same report twice keeps one row.
      expect(
        (await runner("POST", "/samples", runId, { snapshotId: "f".repeat(64), files })).status,
      ).toBe(204);
      const rows = await fixture.db
        .select()
        .from(fileShareSamples)
        .where(eq(fileShareSamples.runId, runId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fileShareId: shareId, snapshotId: "f".repeat(64), size: 10 });
      await fixture.db.delete(fileShareRuns);
      const restore = await startedRun({ status: "running", kind: "restore" });
      expect(
        (await runner("POST", "/samples", restore, { snapshotId: "f".repeat(64), files })).status,
      ).toBe(409);
    });
  });

  describe("the finish", () => {
    it("records the result, ends the credential and accepts the same report again", async () => {
      const runId = await startedRun({ status: "running" });
      const report = {
        status: "failed",
        code: "include_missing",
        message: `the include folder Finance does not exist (${repositoryPassword})`,
        stats: { items: { locked_file: 2 } },
        logTail: `restic: password ${repositoryPassword}\nend`,
      };
      expect((await runner("POST", "/finish", runId, report)).status).toBe(200);
      const stored = await run(runId);
      expect(stored).toMatchObject({ status: "failed" });
      expect(stored?.finishedAt).not.toBeNull();
      expect(stored?.failure).toMatchObject({
        code: "share.include_missing",
        params: { path: "Finance" },
      });
      expect(JSON.stringify(stored)).not.toContain(repositoryPassword);
      expect(stored?.logTail).toContain("end");
      // The credential is dead for everything else ...
      expect((await runner("GET", "/session", runId)).status).toBe(401);
      expect(
        (
          await runner("POST", "/progress", runId, {
            phase: "x",
            filesDone: 0,
            bytesDone: 0,
            totalFiles: 0,
            totalBytes: 0,
          })
        ).status,
      ).toBe(401);
      // ... but the same finish may arrive again (a lost answer), a different one may not.
      const again = await runner("POST", "/finish", runId, report);
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ repeated: true });
      expect(
        (
          await runner("POST", "/finish", runId, {
            ...report,
            status: "succeeded",
            code: undefined,
          })
        ).status,
      ).toBe(409);
    });

    it("keeps the restic snapshot of a success and the warning cause of its items", async () => {
      const runId = await startedRun({ status: "running" });
      const snapshotId = "a".repeat(64);
      const response = await runner("POST", "/finish", runId, {
        status: "warning",
        snapshotId,
        stats: { files: 9, items: { locked_file: 3, offline_skipped: 5 } },
        logTail: "",
      });
      expect(response.status).toBe(200);
      const stored = await run(runId);
      expect(stored?.stats).toMatchObject({ files: 9, resticSnapshotId: snapshotId });
      expect(stored?.failure).toMatchObject({ code: "share.locked_files", params: { count: 3 } });
      expect((await runner("POST", "/finish", runId, { status: "bogus" })).status).toBe(422);
    });
  });

  describe("the restic route", () => {
    async function restic(method: string, path: string, runId: string, body?: string) {
      return app.request(`/internal/file-shares/restic/${shareId}${path}`, {
        method,
        headers: {
          authorization: basic(runId),
          ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
        body,
      });
    }

    it("records a backup runner's locks, lets it remove only those, and counts its uploads", async () => {
      await fixture.db
        .update(fileShares)
        .set({ repositoryBytes: 0, quotaGib: null })
        .where(eq(fileShares.id, shareId));
      const runId = await startedRun({ status: "running" });
      const lock = `lock-${randomUUID()}`;
      expect((await restic("POST", `/locks/${sha256(lock)}`, runId, lock)).status).toBe(200);
      const locks = await fixture.db
        .select()
        .from(fileShareRepositoryLocks)
        .where(eq(fileShareRepositoryLocks.fileShareId, shareId));
      expect(locks.map((row) => row.name)).toContain(sha256(lock));
      expect((await restic("DELETE", `/locks/${sha256(lock)}`, runId)).status).toBe(200);
      expect(
        await fixture.db
          .select()
          .from(fileShareRepositoryLocks)
          .where(
            and(
              eq(fileShareRepositoryLocks.fileShareId, shareId),
              eq(fileShareRepositoryLocks.name, sha256(lock)),
            ),
          ),
      ).toEqual([]);
      const pack = `pack-${randomUUID()}`;
      expect((await restic("POST", `/data/${sha256(pack)}`, runId, pack)).status).toBe(200);
      const [counted] = await fixture.db
        .select()
        .from(fileShares)
        .where(eq(fileShares.id, shareId));
      expect(counted?.repositoryBytes).toBe(Buffer.byteLength(pack));
      expect(
        await readFile(
          join(
            fixture.storageDir,
            "file-shares",
            shareId,
            "data",
            sha256(pack).slice(0, 2),
            sha256(pack),
          ),
          "utf8",
        ),
      ).toBe(pack);
    });

    it("refuses uploads over the share's budget and notes the refusal", async () => {
      await fixture.db
        .update(fileShares)
        .set({ quotaGib: 1, repositoryBytes: GIB - 4, quotaRefusedAt: null })
        .where(eq(fileShares.id, shareId));
      const runId = await startedRun({ status: "running" });
      const pack = "more than four bytes";
      const refused = await restic("POST", `/data/${sha256(pack)}`, runId, pack);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { type: string }).type).toBe(
        "urn:restow:problem:file-share-quota-exceeded",
      );
      const [noted] = await fixture.db.select().from(fileShares).where(eq(fileShares.id, shareId));
      expect(noted?.quotaRefusedAt).not.toBeNull();
      await fixture.db.update(fileShares).set({ quotaGib: null }).where(eq(fileShares.id, shareId));
    });

    it("gives a restore run nothing to write and audits what it tried", async () => {
      const runId = await startedRun({ status: "running", kind: "restore" });
      const pack = `pack-${randomUUID()}`;
      expect((await restic("POST", `/data/${sha256(pack)}`, runId, pack)).status).toBe(403);
      // The audit entry is written in the background.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const denied = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, fixture.tenantId),
            eq(auditLog.action, "file_share.repository.denied"),
          ),
        );
      expect(denied.length).toBeGreaterThan(0);
      expect(denied[0]).toMatchObject({ target: shareId, targetType: "file_share" });
      expect(JSON.stringify(denied[0]?.details)).not.toContain(TOKEN);
    });
  });
});
