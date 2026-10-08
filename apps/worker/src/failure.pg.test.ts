/**
 * Postgres-backed tests of failure records: a failing handler ends up with the
 * classified cause on the job, on its failed items and on its source, the
 * legacy error text stays filled and secret-free, and a source-scoped cause
 * marks the source broken until a job proves the connection again.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_worker_failure_test` is recreated there on every run). Without it the
 * suite is skipped.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GraphError,
  ImapAuthError,
  JobAbortedError,
  Keyring,
  LocalStorageBackend,
  type StorageTargets,
  TokenAcquisitionError,
  buildCause,
  generateDek,
  noopLogger,
  wrapDek,
} from "@restow/core";
import {
  type Database,
  createDb,
  itemFailures,
  jobs,
  protectedObjects,
  providers,
  sources,
  tenantKeys,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDirectoryJob } from "./handlers/directory.js";
import {
  type AnyJobHandler,
  InvalidPayloadError,
  TenantCache,
  TenantConcurrencyLimiter,
  type WorkerRuntime,
  runJob,
  tenantRunner,
} from "./handlers/framework.js";
import { MAX_ITEM_FAILURE_ROWS, PgProgressSink } from "./progress.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_failure_test";

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

const dek = generateDek(1);
const kek = Buffer.alloc(32, 0x5a);

function pgBossJob(data: unknown, retryCount = 0, retryLimit = 3) {
  return {
    id: randomUUID(),
    name: "backup",
    data,
    expireInSeconds: 3600,
    priority: 0,
    state: "active" as const,
    retryLimit,
    retryCount,
    retryDelay: 60,
    retryBackoff: true,
    startAfter: new Date(),
    startedOn: new Date(),
    singletonKey: null,
    singletonOn: null,
    expireIn: { toPostgres: () => "", toISO: () => "", toISOString: () => "" },
    createdOn: new Date(),
    completedOn: null,
    keepUntil: new Date(),
    deadLetter: "",
    policy: "stately" as const,
    output: {},
  };
}

function graphError(status: number, code: string, message: string, headers = {}): GraphError {
  return new GraphError({
    status,
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/users/alice@example.test/mailFolders?$top=10",
    headers,
    payload: {
      error: {
        code,
        message,
        innerError: {
          "request-id": "req-1",
          "client-request-id": "client-1",
          date: "2026-09-29T08:12:01",
        },
      },
    },
  });
}

describe.skipIf(!adminUrl)("failure records against Postgres", () => {
  let db: Database;
  let root: string;
  let storage: StorageTargets;
  let tenantId: string;
  let sourceId: string;
  let objectId: string;
  let keys: Keyring;
  const NOW = new Date("2026-09-29T10:00:00.000Z");

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
    root = await mkdtemp(join(tmpdir(), "restow-worker-failures-"));
    storage = { primary: new LocalStorageBackend(join(root, "primary")), copies: [] };
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    const [provider] = await db.insert(providers).values({ name: "test provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Tenant",
        slug: `t-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
    await db.insert(tenantKeys).values({
      tenantId,
      keyVersion: 1,
      encryptedDek: wrapDek(kek, dek).toString("base64"),
      kekId: "env:test",
    });
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "M365", status: "active", config: {} })
      .returning();
    sourceId = source?.id as string;
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: "mailbox",
        externalId: "alice@example.test",
        displayName: "Alice",
      })
      .returning();
    objectId = object?.id as string;
    keys = new Keyring(tenantId, [dek]);
  });

  function runtime(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
    return {
      db,
      defaultStorage: storage,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: noopLogger,
      tenantLimiter: new TenantConcurrencyLimiter(2),
      shutdownSignal: new AbortController().signal,
      now: () => NOW,
      cancelPollMs: 50,
      progress: { flushEveryItems: 1, flushIntervalMs: 0 },
      ...overrides,
    };
  }

  const failing = (error: unknown, phase = "enumerate"): AnyJobHandler => ({
    queue: "backup",
    run: async (ctx) => {
      ctx.progress.phase(phase);
      throw error;
    },
  });

  function payloadFor(jobId: string) {
    return { jobId, tenantId, protectedObjectId: objectId };
  }

  async function jobRow(jobId: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return row;
  }

  async function sourceRow() {
    const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
    return row;
  }

  it("classifies a Microsoft answer and keeps the retry state while the queue has budget", async () => {
    const jobId = randomUUID();
    const error = graphError(
      403,
      "ErrorAccessDenied",
      "Access is denied. Check credentials and try again.",
    );
    await expect(
      runJob(runtime(), failing(error), pgBossJob(payloadFor(jobId), 1, 5)),
    ).rejects.toThrow();
    const row = await jobRow(jobId);
    expect(row.status).toBe("queued");
    expect(row.errorMessage).toContain("ErrorAccessDenied");
    expect(row.failure).toMatchObject({
      v: 1,
      code: "graph.access_denied",
      transient: false,
      step: "enumerate",
      occurredAt: NOW.toISOString(),
      params: { permission: "Mail.ReadWrite", httpStatus: 403, queue: "backup" },
      technical: {
        httpStatus: 403,
        errorCode: "ErrorAccessDenied",
        requestId: "req-1",
        clientRequestId: "client-1",
        endpoint: "GET /v1.0/users/alice@example.test/mailFolders",
      },
    });
    // Second attempt of six; backoff 60 s * 2^1 * 1.5 = 180 s.
    expect(row.failure?.retry).toEqual({
      attempt: 2,
      limit: 6,
      nextAttemptAt: new Date(NOW.getTime() + 180_000).toISOString(),
    });
    expect(JSON.stringify(row.failure)).not.toContain("$top");
  });

  it("ends a job that used up its retries without a retry state", async () => {
    const jobId = randomUUID();
    await expect(
      runJob(
        runtime(),
        failing(graphError(503, "ServiceNotAvailable", "try later")),
        pgBossJob(payloadFor(jobId), 5, 5),
      ),
    ).rejects.toThrow();
    const row = await jobRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.failure).toMatchObject({
      code: "graph.service_unavailable",
      transient: true,
      retry: null,
    });
  });

  it("records the wait Microsoft asked for on a throttled run", async () => {
    const jobId = randomUUID();
    const error = graphError(429, "TooManyRequests", "slow down", { "retry-after": "32" });
    await expect(
      runJob(runtime(), failing(error), pgBossJob(payloadFor(jobId), 0, 5)),
    ).rejects.toThrow();
    expect((await jobRow(jobId)).failure).toMatchObject({
      code: "graph.throttled",
      transient: true,
      params: { retryAfterSeconds: 32 },
    });
  });

  it("classifies IMAP and storage failures the same way", async () => {
    const imapJob = randomUUID();
    await expect(
      runJob(
        runtime(),
        failing(new ImapAuthError("authentication failed", "NO [AUTHENTICATIONFAILED]")),
        pgBossJob(payloadFor(imapJob), 5, 5),
      ),
    ).rejects.toThrow();
    expect((await jobRow(imapJob)).failure).toMatchObject({ code: "imap.auth_failed" });

    const storageJob = randomUUID();
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
      syscall: "write",
      path: "/data/tenants/x/packs/ab/abcdef.restow-tmp",
    });
    await expect(
      runJob(runtime(), failing(full, "download"), pgBossJob(payloadFor(storageJob), 5, 5)),
    ).rejects.toThrow();
    expect((await jobRow(storageJob)).failure).toMatchObject({
      code: "storage.full",
      step: "download",
    });
  });

  it("stores no secret in the error text or the record", async () => {
    const jobId = randomUUID();
    const leaky = new Error(
      "boom with Bearer abcdefghijklmnop0123456789 and client_secret=Sup3rSecretValue and postgres://restow:pa55w0rd@db:5432/app",
    );
    await expect(
      runJob(runtime(), failing(leaky), pgBossJob(payloadFor(jobId), 5, 5)),
    ).rejects.toThrow();
    const row = await jobRow(jobId);
    const stored = `${row.errorMessage}${JSON.stringify(row.failure)}`;
    for (const secret of ["abcdefghijklmnop0123456789", "Sup3rSecretValue", "pa55w0rd"]) {
      expect(stored).not.toContain(secret);
    }
    expect(row.failure).toMatchObject({ code: "unknown" });
  });

  it("names a rejected job's cause when the handler knows it", async () => {
    const jobId = randomUUID();
    await expect(
      runJob(
        runtime(),
        failing(
          new InvalidPayloadError(
            "backup skipped: the source is disabled",
            buildCause("config.source_disabled"),
          ),
        ),
        pgBossJob(payloadFor(jobId), 0, 5),
      ),
    ).resolves.toBeUndefined();
    const row = await jobRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.failure).toMatchObject({ code: "config.source_disabled", retry: null });

    const generic = randomUUID();
    await runJob(
      runtime(),
      failing(new InvalidPayloadError("no backup engine for kind x")),
      pgBossJob(payloadFor(generic), 0, 5),
    );
    expect((await jobRow(generic)).failure).toMatchObject({ code: "config.invalid" });
  });

  it("says a job was interrupted when the worker shut down", async () => {
    const shutdown = new AbortController();
    const jobId = randomUUID();
    const handler: AnyJobHandler = {
      queue: "backup",
      run: async () => {
        shutdown.abort();
        throw new JobAbortedError();
      },
    };
    await expect(
      runJob(
        runtime({ shutdownSignal: shutdown.signal }),
        handler,
        pgBossJob(payloadFor(jobId), 0, 5),
      ),
    ).rejects.toThrow();
    const row = await jobRow(jobId);
    expect(row.status).toBe("queued");
    expect(row.failure).toMatchObject({
      code: "job.interrupted",
      transient: true,
      params: { reason: "shutdown" },
    });
  });

  it("clears the failure once the job succeeds", async () => {
    const jobId = randomUUID();
    await expect(
      runJob(
        runtime(),
        failing(graphError(503, "ServiceNotAvailable", "try later")),
        pgBossJob(payloadFor(jobId), 0, 5),
      ),
    ).rejects.toThrow();
    expect((await jobRow(jobId)).failure).not.toBeNull();
    await runJob(
      runtime(),
      { queue: "backup", run: async () => ({ summary: {} }) },
      pgBossJob(payloadFor(jobId), 1, 5),
    );
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: "completed", errorMessage: null, failure: null });
  });

  describe("a cause that concerns the whole source", () => {
    const consentError = () =>
      new TokenAcquisitionError(
        "Token request failed with 400 (invalid_grant): AADSTS65001: The user or administrator has not consented",
        { status: 400, code: "invalid_grant", correlationId: "corr-1" },
      );

    it("marks the source broken with the cause, and a later good job clears it", async () => {
      const failed = randomUUID();
      await expect(
        runJob(runtime(), failing(consentError()), pgBossJob(payloadFor(failed), 5, 5)),
      ).rejects.toThrow();
      const broken = await sourceRow();
      expect(broken.status).toBe("error");
      expect(broken.errorMessage).toContain("AADSTS65001");
      expect(broken.failure).toMatchObject({
        code: "graph.consent_missing",
        technical: { aadsts: "AADSTS65001", correlationId: "corr-1" },
      });

      await runJob(
        runtime(),
        { queue: "backup", run: async () => ({ summary: {} }) },
        pgBossJob(payloadFor(randomUUID())),
      );
      expect(await sourceRow()).toMatchObject({
        status: "active",
        errorMessage: null,
        failure: null,
      });
    });

    it("leaves a paused source paused and a failure from a directory sync alone", async () => {
      await db.update(sources).set({ status: "disabled" }).where(eq(sources.id, sourceId));
      await expect(
        runJob(runtime(), failing(consentError()), pgBossJob(payloadFor(randomUUID()), 5, 5)),
      ).rejects.toThrow();
      expect((await sourceRow()).status).toBe("disabled");

      await db
        .update(sources)
        .set({
          status: "error",
          errorMessage: "directory sync failed",
          failure: {
            v: 1,
            code: "graph.permission_missing",
            transient: false,
            params: { queue: "directory", permission: "User.Read.All" },
            technical: {},
            occurredAt: NOW.toISOString(),
            step: null,
            retry: null,
          },
        })
        .where(eq(sources.id, sourceId));
      await runJob(
        runtime(),
        { queue: "backup", run: async () => ({ summary: {} }) },
        pgBossJob(payloadFor(randomUUID())),
      );
      // A mailbox backup says nothing about the permission the directory sync lacks.
      expect((await sourceRow()).status).toBe("error");
    });

    it("does not mark the source for a cause that concerns one object", async () => {
      await expect(
        runJob(
          runtime(),
          failing(graphError(404, "MailboxNotEnabledForRESTAPI", "no mailbox")),
          pgBossJob(payloadFor(randomUUID()), 5, 5),
        ),
      ).rejects.toThrow();
      expect(await sourceRow()).toMatchObject({ status: "active", failure: null });
    });
  });

  describe("a failed directory sync", () => {
    it("explains why on the source, in the last run and on the job", async () => {
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "m365",
          name: "Synced",
          status: "active",
          entraTenantId: `${randomUUID()}.onmicrosoft.com`,
          config: {},
        })
        .returning();
      const denied = graphError(
        403,
        "Authorization_RequestDenied",
        "Insufficient privileges to complete the operation.",
      );
      // Every way the sync can talk to Graph answers 403.
      const deniedClient = {
        request: async () => ({
          status: 403,
          headers: {},
          body: {
            error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" },
          },
        }),
        stream: async () => {
          throw denied;
        },
        batch: async () => {
          throw denied;
        },
        // biome-ignore lint/correctness/useYield: it fails before it can yield
        delta: async function* () {
          throw denied;
        },
      };
      const handler: AnyJobHandler = {
        queue: "directory",
        run: (ctx, payload) =>
          runDirectoryJob(ctx, payload as never, {
            graphClientFor: async () => deniedClient as never,
          }),
      };
      const jobId = randomUUID();
      await expect(
        runJob(runtime(), handler, {
          ...pgBossJob({ jobId, tenantId, sourceId: source?.id }, 5, 5),
          name: "directory",
        }),
      ).rejects.toThrow();

      const [row] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, source?.id as string));
      expect(row?.status).toBe("error");
      expect(row?.failure).toMatchObject({
        code: "graph.permission_missing",
        params: { queue: "directory" },
      });
      const lastRun = (
        row?.config as { directory?: { lastRun?: { ok: boolean; failure?: { code: string } } } }
      ).directory?.lastRun;
      expect(lastRun).toMatchObject({ ok: false, failure: { code: "graph.permission_missing" } });
      expect((await jobRow(jobId)).failure).toMatchObject({ code: "graph.permission_missing" });
    });
  });

  describe("failed items", () => {
    it("stores the cause and the step next to the reason, and leaves text-only failures alone", async () => {
      const jobId = randomUUID();
      await db
        .insert(jobs)
        .values({ id: jobId, tenantId, queue: "backup", protectedObjectId: objectId });
      const sink = new PgProgressSink({
        run: tenantRunner(db, tenantId),
        tenantId,
        jobId,
        protectedObjectId: objectId,
        logger: noopLogger,
        now: () => NOW,
      });
      await sink.ensureRow();
      await sink.publish({
        snapshot: { total: 3, done: 0, failed: 2, bytes: 0, phase: "download", etaSeconds: null },
        failures: [
          {
            itemRef: "mail/Inbox/big.eml",
            reason: "Graph 413 requestEntityTooLarge: too big",
            cause: buildCause("graph.item_too_large", { httpStatus: 413 }, { httpStatus: 413 }),
          },
          { itemRef: "mail/Inbox/plain.eml", reason: "some older engine text" },
        ],
      });
      const rows = await db.select().from(itemFailures).where(eq(itemFailures.jobId, jobId));
      const byRef = new Map(rows.map((row) => [row.itemRef, row]));
      expect(byRef.get("mail/Inbox/big.eml")?.failure).toMatchObject({
        code: "graph.item_too_large",
        transient: false,
        step: "download",
        occurredAt: NOW.toISOString(),
      });
      expect(byRef.get("mail/Inbox/big.eml")?.reason).toContain("413");
      expect(byRef.get("mail/Inbox/plain.eml")?.failure).toBeNull();
    });

    it("keeps the first rows of a run with the item date and counts every failure per cause", async () => {
      const jobId = randomUUID();
      await db
        .insert(jobs)
        .values({ id: jobId, tenantId, queue: "backup", protectedObjectId: objectId });
      const sink = new PgProgressSink({
        run: tenantRunner(db, tenantId),
        tenantId,
        jobId,
        protectedObjectId: objectId,
        logger: noopLogger,
        now: () => NOW,
      });
      const tooLarge = buildCause("graph.item_too_large", { httpStatus: 413 }, { httpStatus: 413 });
      const batch = (from: number, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          itemRef: `mail/Inbox/item-${from + index}.eml`,
          reason: "Graph 413: too big",
          cause: tooLarge,
          itemDate: "2026-09-01T08:00:00.000Z",
        }));
      const snapshot = {
        total: 0,
        done: 0,
        failed: 0,
        bytes: 0,
        phase: "download",
        etaSeconds: null,
      };
      await sink.publish({ snapshot, failures: batch(0, MAX_ITEM_FAILURE_ROWS - 10) });
      await sink.publish({
        snapshot,
        failures: [
          ...batch(MAX_ITEM_FAILURE_ROWS - 10, 30),
          { itemRef: "mail/Inbox/legacy.eml", reason: "text only" },
        ],
      });

      const rows = await db.select().from(itemFailures).where(eq(itemFailures.jobId, jobId));
      expect(rows).toHaveLength(MAX_ITEM_FAILURE_ROWS);
      expect(rows[0]?.itemDate?.toISOString()).toBe("2026-09-01T08:00:00.000Z");
      expect((await jobRow(jobId))?.itemFailureSummary).toEqual({
        total: MAX_ITEM_FAILURE_ROWS + 21,
        stored: MAX_ITEM_FAILURE_ROWS,
        byCause: { "graph.item_too_large": MAX_ITEM_FAILURE_ROWS + 20, unknown: 1 },
      });
    });
  });
});
