/**
 * Restore mode coming on while a job of the restored database dump already waits or runs
 * (restore-mode.ts `RestoreModeJobHold`, framework.ts `runJob`): the job gate only checks a job
 * when pg-boss hands it out, so the runner asks the hold again while the job waits for a tenant
 * slot and while it runs. A held job stops through its abort signal and ends cancelled with
 * `job.restore_mode_hold`, its pg-boss job cancelled, no checkpoint kept and no retry; a job
 * created after the hold point runs on. Runs when RESTOW_TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateDek,
  JobAbortedError,
  Keyring,
  LocalStorageBackend,
  noopLogger,
  type RestoreModeSnapshot,
  type StorageTargets,
} from "@restow/core";
import { createDb, type Database, providers, tenants } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AnyJobHandler,
  runJob,
  TenantCache,
  TenantConcurrencyLimiter,
  type WorkerJobContext,
  type WorkerRuntime,
} from "./handlers/framework.js";
import { RESTORE_MODE_HOLD_MESSAGE, RestoreModeJobHold } from "./restore-mode.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_restore_mode_running_test";
const POLL_MS = 25;

const OFF: RestoreModeSnapshot = {
  active: false,
  id: null,
  activatedAt: null,
  holdJobsBefore: null,
  keepUnknownBefore: null,
};

/** Resolves when `signal` aborts, or with false after `ms`. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

describe.skipIf(!adminUrl)("restore mode stops a running job of the restored dump", () => {
  let db: Database;
  let boss: PgBoss;
  let root: string;
  let storage: StorageTargets;
  let tenantId: string;
  let state: RestoreModeSnapshot = OFF;
  let hold: RestoreModeJobHold;

  const q = async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await db.$client.query<R>(text, values)).rows;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    db.$client.on("error", ignoreTerminatedConnection);
    boss = new PgBoss({ connectionString: url.toString(), schedule: false, supervise: false });
    boss.on("error", ignoreTerminatedConnection);
    await boss.start();
    await boss.createQueue("restore", { name: "restore", retryLimit: 5, retryDelay: 60 });
    const [provider] = await db.insert(providers).values({ name: "test provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider.id, name: "Tenant", slug: `t-${randomUUID().slice(0, 8)}` })
      .returning();
    tenantId = tenant.id;
    root = await mkdtemp(join(tmpdir(), "restow-restore-mode-running-"));
    storage = { primary: new LocalStorageBackend(join(root, "primary")), copies: [] };
    hold = new RestoreModeJobHold(db, async () => state, noopLogger);
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  beforeEach(async () => {
    state = OFF;
    await q("DELETE FROM jobs");
    await q("DELETE FROM pgboss.job");
  });

  function runtime(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
    return {
      db,
      defaultStorage: storage,
      keyrings: new TenantCache(async () => new Keyring(tenantId, [generateDek(1)])),
      storage: new TenantCache(async () => storage),
      logger: noopLogger,
      tenantLimiter: new TenantConcurrencyLimiter(2),
      shutdownSignal: new AbortController().signal,
      now: () => new Date(),
      cancelPollMs: 60_000,
      progress: { flushEveryItems: 1, flushIntervalMs: 0 },
      restoreModeHold: hold,
      restoreModeHoldPollMs: POLL_MS,
      ...overrides,
    };
  }

  /** A mail restore pg-boss handed to this worker, created `createdOn`, and its queued row. */
  async function deliveredRestore(createdOn: Date) {
    const bossId = (await boss.send("restore", { kind: "mail" })) as string;
    const [fetched] = await boss.fetch("restore");
    expect(fetched?.id).toBe(bossId);
    const jobId = randomUUID();
    const data = { jobId, tenantId };
    // The row the api wrote when it queued the restore.
    await q(
      `INSERT INTO jobs (id, tenant_id, queue, status, pg_boss_job_id, payload)
       VALUES ($1, $2, 'restore', 'queued', $3, $4::jsonb)`,
      [jobId, tenantId, bossId, JSON.stringify(data)],
    );
    const job = {
      id: bossId,
      name: "restore",
      data,
      expireInSeconds: 3600,
      priority: 0,
      state: "active" as const,
      retryLimit: 3,
      retryCount: 0,
      retryDelay: 0,
      retryBackoff: false,
      startAfter: new Date(),
      startedOn: new Date(),
      singletonKey: null,
      singletonOn: null,
      expireIn: { toPostgres: () => "", toISO: () => "", toISOString: () => "" },
      createdOn,
      completedOn: null,
      keepUntil: new Date(),
      deadLetter: "",
      policy: "standard" as const,
      output: {},
    };
    return { bossId, jobId, job: job as unknown as PgBoss.JobWithMetadata<unknown> };
  }

  const jobRow = async (id: string) =>
    (
      await q<{
        status: string;
        failure: Record<string, unknown> | null;
        error_message: string | null;
        cursor: unknown;
      }>("SELECT status::text AS status, failure, error_message, cursor FROM jobs WHERE id = $1", [
        id,
      ])
    )[0];
  const bossState = async (id: string) =>
    (
      await q<{ state: string }>("SELECT state::text AS state FROM pgboss.job WHERE id = $1", [id])
    )[0]?.state;

  /** A restore that writes until its signal fires (or 3 s pass), checkpointing as it goes. */
  function writingRestore(onStart: () => void, seen: { aborted: boolean | null }): AnyJobHandler {
    return {
      queue: "restore",
      run: async (ctx: WorkerJobContext) => {
        await ctx.cursor.save({ item: 1 });
        onStart();
        seen.aborted = await abortedWithin(ctx.signal, 3_000);
        if (seen.aborted) {
          await ctx.cursor.save({ item: 2 });
          throw new JobAbortedError();
        }
        return { summary: { restored: 1 } };
      },
    } as AnyJobHandler;
  }

  it("stops a running job of the dump when restore mode comes on and ends it held, without a retry", async () => {
    const createdOn = new Date(Date.now() - 60 * 60_000);
    const { bossId, jobId, job } = await deliveredRestore(createdOn);
    const seen = { aborted: null as boolean | null };
    const handler = writingRestore(() => {
      // The restored dump is detected while the restore writes into the mailbox.
      const activatedAt = new Date();
      state = {
        active: true,
        id: "rm",
        activatedAt,
        holdJobsBefore: activatedAt,
        keepUnknownBefore: null,
      };
    }, seen);
    // Ends without throwing: pg-boss must not retry it.
    await runJob(runtime(), handler, job);
    expect(seen.aborted).toBe(true);
    expect(await jobRow(jobId)).toMatchObject({
      status: "cancelled",
      failure: { code: "job.restore_mode_hold" },
      error_message: RESTORE_MODE_HOLD_MESSAGE,
      cursor: null,
    });
    expect(await bossState(bossId)).toBe("cancelled");
  });

  it("lets a job created after the hold point run on in restore mode", async () => {
    const activatedAt = new Date(Date.now() - 60_000);
    state = {
      active: true,
      id: "rm",
      activatedAt,
      holdJobsBefore: activatedAt,
      keepUnknownBefore: null,
    };
    const { jobId, job } = await deliveredRestore(new Date());
    const seen = { aborted: null as boolean | null };
    let started = 0;
    const handler: AnyJobHandler = {
      queue: "restore",
      run: async (ctx: WorkerJobContext) => {
        started++;
        // Several hold probes pass while it runs.
        seen.aborted = await abortedWithin(ctx.signal, POLL_MS * 8);
        return { summary: {} };
      },
    } as AnyJobHandler;
    await runJob(runtime(), handler, job);
    expect(started).toBe(1);
    expect(seen.aborted).toBe(false);
    expect((await jobRow(jobId))?.status).toBe("completed");
  });

  it("holds a job of the dump that waited for a tenant slot while restore mode came on, without running it", async () => {
    const limiter = new TenantConcurrencyLimiter(1);
    const busy = await limiter.acquire(tenantId);
    const { bossId, jobId, job } = await deliveredRestore(new Date(Date.now() - 60 * 60_000));
    let ran = false;
    const handler: AnyJobHandler = {
      queue: "restore",
      run: async () => {
        ran = true;
        return { summary: {} };
      },
    } as AnyJobHandler;
    const running = runJob(runtime({ tenantLimiter: limiter }), handler, job);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
    const activatedAt = new Date();
    state = {
      active: true,
      id: "rm",
      activatedAt,
      holdJobsBefore: activatedAt,
      keepUnknownBefore: null,
    };
    // The slot frees up only after a while (or never, while the restore mode probe stops the wait).
    const freed = setTimeout(busy, 2_000);
    await running;
    clearTimeout(freed);
    busy();
    expect(ran).toBe(false);
    expect(await bossState(bossId)).toBe("cancelled");
    expect(await jobRow(jobId)).toMatchObject({
      status: "cancelled",
      failure: { code: "job.restore_mode_hold" },
    });
  });
});
