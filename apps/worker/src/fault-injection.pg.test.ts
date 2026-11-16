/**
 * Fault injection into what a job depends on (docs/CLAIMS.md, FAULT): the
 * credentials of a source stop working, Microsoft 365 refuses writes when a
 * restore needs them, the storage is full. Each test asserts both halves of
 * the promise: a state the admin sees changes (the source, the run, the
 * restore) and an alert is raised, and where the product sets a bound in time
 * (the retries before a failed backup is announced), that it holds.
 *
 * Real: the job framework (`runJob`) with its failure records, the source
 * marking and the alert a finished job raises, the token client against an
 * endpoint that answers as Entra ID does, the IMAP backup engine, the Exchange
 * restore engine, the chunk store and Postgres. Injected: only the fault (the
 * answer of the token endpoint, of the IMAP server, of Graph, of the disk).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_worker_fault_jobs_test` is recreated there on every run).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  ClientCredentialsTokenProvider,
  createMemoryJobContext,
  createRestoreEngines,
  FetchGraphClient,
  generateDek,
  ImapAuthError,
  ImapBackupEngine,
  Keyring,
  LocalStorageBackend,
  noopLogger,
  type ProtectedObjectRef,
  SnapshotWriter,
  type StorageTargets,
  sealSecret,
  wrapDek,
} from "@restow/core";
import {
  createDb,
  type Database,
  itemFailures,
  jobs,
  notifications,
  protectedObjects,
  providers,
  restoreJobs,
  secrets,
  snapshots,
  sources,
  tenantKeys,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AnyJobHandler,
  PgChunkIndex,
  PgSnapshotIndex,
  runJob,
  TenantCache,
  TenantConcurrencyLimiter,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "./handlers/framework.js";
import { createRestoreHandler } from "./handlers/restore.js";
import { QUEUE_DEFINITIONS } from "./queues.js";
import { raiseJobFinished } from "./reporting.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_fault_jobs_test";

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

/** A pg-boss job on `queue` with that queue's own retry settings. */
function pgBossJob(queue: "backup" | "restore", data: unknown, retryCount: number) {
  const policy = QUEUE_DEFINITIONS[queue];
  return {
    id: randomUUID(),
    name: queue,
    data,
    expireInSeconds: 3600,
    priority: 0,
    state: "active" as const,
    retryLimit: policy.retryLimit,
    retryCount,
    retryDelay: policy.retryDelaySeconds,
    retryBackoff: policy.retryBackoff,
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

/** The answer of the Entra token endpoint to a credential it refuses. */
function entraRefusal(aadsts: string, description: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        error: "invalid_client",
        error_description: `${aadsts}: ${description} Trace ID: 5d1e3a52 Correlation ID: 7c0a11ee Timestamp: 2026-11-02 08:00:00Z`,
        error_codes: [Number(aadsts.replace("AADSTS", ""))],
        correlation_id: "7c0a11ee",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

/** A directory that is full: every write is refused the way the operating system does it. */
class FullDisk extends LocalStorageBackend {
  full = false;

  override async put(key: string, data: Buffer | Readable): Promise<void> {
    if (this.full) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${key}'`), {
        code: "ENOSPC",
        errno: -28,
        syscall: "write",
      });
    }
    return super.put(key, data);
  }
}

describe.skipIf(!adminUrl)("fault injection into running jobs", { timeout: 30_000 }, () => {
  let db: Database;
  let root: string;
  let storage: StorageTargets;
  let disk: FullDisk;
  let tenantId: string;
  let sourceId: string;
  let object: ProtectedObjectRef;
  let keys: Keyring;
  const NOW = new Date("2026-11-02T08:00:00.000Z");

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
    root = await mkdtemp(join(tmpdir(), "restow-worker-fault-jobs-"));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function tenantWith(kind: "m365" | "imap", objectKind: "mailbox" | "imap") {
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
      .values({ tenantId, kind, name: "Source", status: "active", config: {} })
      .returning();
    sourceId = source?.id as string;
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: objectKind,
        externalId: "anna@example.org",
        displayName: "Anna Example",
      })
      .returning();
    object = {
      id: row?.id as string,
      tenantId,
      sourceId,
      kind: objectKind,
      externalId: "anna@example.org",
      displayName: "Anna Example",
      userId: null,
    };
    keys = new Keyring(tenantId, [dek]);
    disk = new FullDisk(join(root, tenantId));
    storage = { primary: disk, copies: [] };
  }

  beforeEach(async () => {
    await tenantWith("m365", "mailbox");
  });

  /** The worker's runtime, with the alert of a finished job wired as index.ts wires it. */
  function runtime(): WorkerRuntime {
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
      onJobFinished: async (tenant, job) => {
        await withTenantTx(db, tenant, (tx) => raiseJobFinished(tx, tenant, job));
      },
    };
  }

  const payloadFor = (jobId: string) => ({ jobId, tenantId, protectedObjectId: object.id });

  async function jobRow(jobId: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return row;
  }

  async function sourceRow() {
    const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
    return row;
  }

  async function alerts() {
    return db
      .select({
        event: notifications.event,
        level: notifications.level,
        details: notifications.details,
      })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId))
      .orderBy(asc(notifications.createdAt));
  }

  /**
   * One backup job through all its attempts, as pg-boss hands them out: the first
   * attempt and every retry the queue allows. Returns what was raised after each.
   */
  async function backupThroughItsRetries(handler: AnyJobHandler) {
    const jobId = randomUUID();
    const limit = QUEUE_DEFINITIONS.backup.retryLimit;
    const raisedAfter: string[][] = [];
    for (let retryCount = 0; retryCount <= limit; retryCount++) {
      await expect(
        runJob(runtime(), handler, pgBossJob("backup", payloadFor(jobId), retryCount)),
      ).rejects.toThrow();
      raisedAfter.push((await alerts()).map((row) => row.event));
    }
    return { jobId, raisedAfter };
  }

  /** A good backup run: it proves the connection of the source again. */
  async function goodBackup(): Promise<void> {
    await runJob(
      runtime(),
      { queue: "backup", run: async () => ({ summary: {} }) },
      pgBossJob("backup", payloadFor(randomUUID()), 0),
    );
  }

  describe("the credentials of a Microsoft 365 source stop working", () => {
    /** A backup that asks Entra ID for its token first, with the real token client. */
    function backupWith(fetchImpl: typeof fetch): AnyJobHandler {
      const tokens = new ClientCredentialsTokenProvider({
        tenantId: "contoso.onmicrosoft.com",
        app: { clientId: "app-id", credential: { type: "secret", clientSecret: "rotated-away" } },
        fetchImpl,
        sleep: async () => {},
      });
      return {
        queue: "backup",
        run: async (ctx) => {
          ctx.progress.phase("enumerate");
          await tokens.getToken();
          return { summary: {} };
        },
      };
    }

    it.each([
      [
        "a rotated client secret",
        "AADSTS7000215",
        "Invalid client secret provided.",
        "invalid_secret",
      ],
      [
        "an expired client secret",
        "AADSTS7000222",
        "The provided client secret keys for app 'app-id' are expired.",
        "secret_expired",
      ],
      [
        "an expired certificate",
        "AADSTS700027",
        "The certificate with identifier used to sign the client assertion is expired on application.",
        "invalid_certificate",
      ],
    ])(
      "%s: the source turns to error at the first failed run, backup.failed follows once the retries are used up [FAULT-009]",
      async (_name, aadsts, description, reason) => {
        const handler = backupWith(entraRefusal(aadsts, description));
        const jobId = randomUUID();

        // The first attempt: the state changes at once, the run is queued for its retry.
        await expect(
          runJob(runtime(), handler, pgBossJob("backup", payloadFor(jobId), 0)),
        ).rejects.toThrow();
        expect(await sourceRow()).toMatchObject({
          status: "error",
          failure: { code: "graph.app_credentials_invalid", params: { reason, aadsts } },
        });
        const first = await jobRow(jobId);
        expect(first?.status).toBe("queued");
        expect(first?.failure).toMatchObject({
          code: "graph.app_credentials_invalid",
          transient: false,
          retry: { attempt: 1, limit: QUEUE_DEFINITIONS.backup.retryLimit + 1 },
        });
        // No alert yet: it comes with the end of the run.
        expect(await alerts()).toEqual([]);

        // The bound in time: five retries, 60 s doubled each time (pg-boss waits between
        // that and twice that), so the last attempt starts 31 to 62 minutes after the first.
        expect(QUEUE_DEFINITIONS.backup).toMatchObject({
          retryLimit: 5,
          retryDelaySeconds: 60,
          retryBackoff: true,
        });
        const waits = Array.from({ length: 5 }, (_, count) => 60 * 2 ** count);
        expect(waits.reduce((sum, seconds) => sum + seconds, 0)).toBe(31 * 60);

        for (let retryCount = 1; retryCount <= QUEUE_DEFINITIONS.backup.retryLimit; retryCount++) {
          expect(await alerts()).toEqual([]);
          await expect(
            runJob(runtime(), handler, pgBossJob("backup", payloadFor(jobId), retryCount)),
          ).rejects.toThrow();
        }
        expect((await jobRow(jobId))?.status).toBe("failed");
        const raised = await alerts();
        expect(raised.map((row) => [row.event, row.level])).toEqual([["backup.failed", "error"]]);
        expect(raised[0]?.details).toMatchObject({
          protectedObjectId: object.id,
          objectName: "Anna Example",
          failure: { code: "graph.app_credentials_invalid", transient: false },
        });
        // What to do is part of the alert, the secret never is.
        const details = (raised[0]?.details ?? {}) as { failure?: { steps?: string[] } };
        expect(details.failure?.steps?.length).toBeGreaterThan(0);
        expect(JSON.stringify(raised)).not.toContain("rotated-away");

        // A run with working credentials clears the state again.
        await goodBackup();
        expect(await sourceRow()).toMatchObject({ status: "active", failure: null });
      },
    );
  });

  describe("the password of an IMAP account is wrong", () => {
    beforeEach(async () => {
      await tenantWith("imap", "imap");
    });

    it("the source turns to error at the first failed run, backup.failed follows once the retries are used up [FAULT-010]", async () => {
      const secretId = randomUUID();
      await db.insert(secrets).values({
        id: secretId,
        tenantId,
        kind: "imap_password",
        ciphertext: sealSecret(dek, secretId, "the-old-password"),
        keyVersion: 1,
      });
      let logins = 0;
      // The real IMAP backup engine; the server answers the login as a mail server does.
      const engine = new ImapBackupEngine({
        resolveAccount: async () => ({
          host: "imap.example.org",
          port: 993,
          security: "tls",
          username: "anna@example.org",
          authKind: "password",
          secretId,
        }),
        connector: {
          connect: async () => {
            logins += 1;
            throw new ImapAuthError(
              "authentication failed",
              "[AUTHENTICATIONFAILED] Invalid credentials",
            );
          },
        },
      });
      const handler: AnyJobHandler = {
        queue: "backup",
        run: async (ctx) => {
          await engine.run(ctx, object, {});
          return { summary: {} };
        },
      };

      const { jobId, raisedAfter } = await backupThroughItsRetries(handler);
      expect(logins).toBeGreaterThan(0);
      // The state, from the first attempt on.
      expect(await sourceRow()).toMatchObject({
        status: "error",
        failure: { code: "imap.auth_failed" },
      });
      expect(await jobRow(jobId)).toMatchObject({
        status: "failed",
        failure: { code: "imap.auth_failed", transient: false, retry: null },
      });
      // The alert: nothing while the run still retries, backup.failed at its end.
      expect(raisedAfter.slice(0, -1).every((events) => events.length === 0)).toBe(true);
      expect(raisedAfter.at(-1)).toEqual(["backup.failed"]);
      const [alert] = await alerts();
      expect(alert).toMatchObject({
        level: "error",
        details: { failure: { code: "imap.auth_failed" } },
      });
      expect(JSON.stringify(alert)).not.toContain("the-old-password");
      // No backup was started, so nothing half-written counts as a restore point.
      expect(
        await db.select().from(snapshots).where(eq(snapshots.protectedObjectId, object.id)),
      ).toEqual([]);
    });
  });

  describe("Microsoft 365 refuses writes when a restore needs them", () => {
    it("restores nothing, names the missing permission on every item and raises restore.failed at once [FAULT-011]", async () => {
      // A backup of one mail in the inbox, as the Exchange backup writes it.
      const run = tenantRunner(db, tenantId);
      const backupJob = randomUUID();
      await db.insert(jobs).values({
        id: backupJob,
        tenantId,
        queue: "backup",
        status: "active",
        protectedObjectId: object.id,
      });
      const writer = await SnapshotWriter.begin(
        {
          ...createMemoryJobContext({
            tenantId,
            keys,
            storage,
            jobId: backupJob,
            chunkIndex: new PgChunkIndex(run, tenantId),
            snapshots: new PgSnapshotIndex(run, tenantId, noopLogger),
            now: () => NOW,
          }),
        },
        { protectedObject: object, sourceType: "m365" },
      );
      const mime = Buffer.from(
        "Message-ID: <one@example.org>\r\nDate: Mon, 02 Nov 2026 07:00:00 +0000\r\nFrom: bob@example.org\r\nTo: anna@example.org\r\nSubject: Offer\r\n\r\nhello\r\n",
      );
      const written = await writer.chunks.write(mime);
      writer.add({
        path: "mail",
        type: "folder",
        size: 0,
        mtime: 0,
        chunks: [],
        metadata: { folderKind: "root" },
      });
      writer.add({
        path: "mail/Inbox",
        type: "folder",
        id: "F-inbox",
        size: 0,
        mtime: 0,
        chunks: [],
        metadata: {
          folderKind: "mail",
          folderPath: "Inbox",
          wellKnownFolder: "inbox",
          wellKnownName: "inbox",
          displayName: "Inbox",
        },
      });
      writer.add({
        path: "mail/Inbox/Offer.0001.eml",
        type: "mail",
        id: "AAMk1",
        size: written.size,
        mtime: NOW.getTime(),
        sha256: written.sha256,
        chunks: written.chunks,
        metadata: {
          messageId: "<one@example.org>",
          folderPath: "Inbox",
          wellKnownFolder: "inbox",
          format: "mime",
        },
      });
      const committed = await writer.commit();

      // The restore an admin asks for: back into the mailbox, next to what is there.
      const jobId = randomUUID();
      const restoreJobId = randomUUID();
      await db.insert(jobs).values({
        id: jobId,
        tenantId,
        queue: "restore",
        status: "queued",
        protectedObjectId: object.id,
        payload: { jobId, tenantId, restoreJobId, protectedObjectId: object.id },
      });
      await db.insert(restoreJobs).values({
        id: restoreJobId,
        tenantId,
        jobId,
        snapshotId: committed.snapshotId,
        sourceSelection: { all: true },
        targetType: "original",
        mode: "rename",
      });

      // Graph still reads (the backup's permission) and refuses every write, as it does
      // when the app holds Mail.Read where Mail.ReadWrite is needed, or lost the consent.
      const writes: string[] = [];
      const graph = new FetchGraphClient({
        accessTokenProvider: async () => "token",
        sleep: async () => {},
        random: () => 0,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const method = (init?.method ?? "GET").toUpperCase();
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (method === "GET") {
            return new Response(JSON.stringify({ value: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          writes.push(`${method} ${new URL(url).pathname}`);
          return new Response(
            JSON.stringify({
              error: {
                code: "ErrorAccessDenied",
                message: "Access is denied. Check credentials and try again.",
              },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      });
      const handler = createRestoreHandler({
        dispatcher: () =>
          createRestoreEngines({
            graph: () => graph,
            imap: async () => {
              throw new Error("no IMAP in this test");
            },
          }),
      });

      await runJob(
        runtime(),
        handler as AnyJobHandler,
        pgBossJob("restore", { jobId, tenantId, restoreJobId, protectedObjectId: object.id }, 0),
      );

      // Restow asked Graph to write, and Graph refused.
      expect(writes.length).toBeGreaterThan(0);
      // The state of the restore: it ran, and not one item came back.
      const row = await jobRow(jobId);
      expect(row?.status).toBe("completed");
      const stored = (row?.payload ?? {}) as { result?: Record<string, unknown> };
      expect(stored.result).toMatchObject({ restored: 0 });
      const failed = await db
        .select({ failure: itemFailures.failure })
        .from(itemFailures)
        .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, jobId)));
      expect(failed.length).toBeGreaterThan(0);
      for (const item of failed) {
        expect(item.failure).toMatchObject({
          code: "graph.access_denied",
          params: { permission: "Mail.ReadWrite", httpStatus: 403 },
        });
      }
      // The alert, with the end of the run: a restore is not retried for a refusal.
      const raised = await alerts();
      expect(raised.map((entry) => [entry.event, entry.level])).toEqual([
        ["restore.failed", "error"],
      ]);
      expect(raised[0]?.details).toMatchObject({
        protectedObjectId: object.id,
        restoreOutcome: "nothingRestored",
      });
    });
  });

  describe("the storage is full", () => {
    it("fails the backup with storage.full, raises backup.failed and leaves the earlier restore point as it was [FAULT-012]", async () => {
      /** A backup of one mail through the chunk store. */
      const backup = (subject: string): AnyJobHandler => ({
        queue: "backup",
        run: async (ctx) => {
          ctx.progress.phase("download");
          const writer = await SnapshotWriter.begin(ctx, {
            protectedObject: object,
            sourceType: "m365",
          });
          const written = await writer.chunks.write(
            Buffer.from(`Subject: ${subject}\r\n\r\n${subject.repeat(400)}`),
          );
          writer.add({
            path: `mail/Inbox/${subject}.eml`,
            type: "mail",
            id: subject,
            size: written.size,
            mtime: NOW.getTime(),
            sha256: written.sha256,
            chunks: written.chunks,
          });
          const committed = await writer.commit();
          return { summary: { snapshotId: committed.snapshotId } };
        },
      });

      // A first backup while there is room.
      await runJob(runtime(), backup("first"), pgBossJob("backup", payloadFor(randomUUID()), 0));
      const before = await db
        .select({
          id: snapshots.id,
          status: snapshots.status,
          manifestPath: snapshots.manifestPath,
        })
        .from(snapshots)
        .where(eq(snapshots.protectedObjectId, object.id));
      expect(before).toHaveLength(1);
      expect(before[0]?.status).toBe("active");
      expect(await alerts()).toEqual([]);

      // The disk runs full.
      disk.full = true;
      const { jobId, raisedAfter } = await backupThroughItsRetries(backup("second"));

      // The state of the run: failed, with the cause and the step.
      expect(await jobRow(jobId)).toMatchObject({
        status: "failed",
        failure: { code: "storage.full", retry: null },
      });
      // The alert at the end of the run, naming the cause.
      expect(raisedAfter.at(-1)).toEqual(["backup.failed"]);
      const [alert] = await alerts();
      expect(alert).toMatchObject({
        level: "error",
        details: { protectedObjectId: object.id, failure: { code: "storage.full" } },
      });
      // A full disk concerns the storage, not the source: the source stays as it was.
      expect(await sourceRow()).toMatchObject({ status: "active", failure: null });
      // Nothing half-written became a restore point, and the earlier one is untouched.
      const after = await db
        .select({
          id: snapshots.id,
          status: snapshots.status,
          manifestPath: snapshots.manifestPath,
        })
        .from(snapshots)
        .where(and(eq(snapshots.protectedObjectId, object.id), eq(snapshots.status, "active")));
      expect(after).toEqual(before);
      expect(await disk.head(before[0]?.manifestPath as string)).not.toBeNull();
    });
  });
});
