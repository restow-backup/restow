import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  Keyring,
  LocalStorageBackend,
  type MemoryProgressSink,
  type ProtectedObjectRef,
  type RestoreItemResult,
  type RestoreRequest,
  type RestoreResult,
  createMemoryJobContext,
  generateDek,
} from "@restow/core";
import {
  type Database,
  createDb,
  jobs,
  protectedObjects,
  providers,
  restoreJobs,
  secrets,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import type { BackupRuntimeState } from "./backup.js";
import { InvalidPayloadError, type WorkerJobContext, tenantRunner } from "./framework.js";
import {
  MAX_STORED_ITEMS,
  type RestoreDispatcher,
  type RestoreStore,
  type StoredRestoreResult,
  createRestoreHandler,
  imapTargetAccount,
  parseStoredSelection,
  pgRestoreStore,
  storedItems,
  toRestoreRequest,
  toStoredResult,
} from "./restore.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const SNAPSHOT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const RESTORE = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const JOB = "5d2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

const mailbox: ProtectedObjectRef = {
  id: "1b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
  tenantId: TENANT,
  sourceId: "2b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
  kind: "mailbox",
  externalId: "anna@example.com",
  displayName: "Anna",
  userId: null,
};

const storedRow = {
  id: RESTORE,
  tenantId: TENANT,
  jobId: JOB,
  snapshotId: SNAPSHOT,
  sourceSelection: {
    paths: ["mail/Inbox/a.eml"],
    options: { restoreFolderName: "Wiederhergestellt" },
  },
  targetType: "other" as const,
  targetRef: "bob@example.com",
  mode: "skip" as const,
  actorUserId: "user-1",
  impersonated: true,
  reason: "ticket 4711",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function item(path: string, partial: Partial<RestoreItemResult> = {}): RestoreItemResult {
  return {
    path,
    id: undefined,
    type: "mail",
    status: "restored",
    code: "restored",
    targetRef: undefined,
    bytes: 10,
    verified: true,
    reason: undefined,
    ...partial,
  };
}

describe("parseStoredSelection", () => {
  it("maps the stored jsonb onto the core selection and defaults to everything", () => {
    expect(parseStoredSelection(null)).toEqual({ all: true });
    expect(parseStoredSelection({})).toEqual({ all: true });
    expect(parseStoredSelection({ folderPaths: ["Inbox"], paths: [] })).toEqual({
      folderPaths: ["Inbox"],
    });
    expect(parseStoredSelection({ objectIds: ["a"], paths: ["x"], all: false })).toEqual({
      objectIds: ["a"],
      paths: ["x"],
    });
    expect(parseStoredSelection({ paths: [1, 2] })).toEqual({ all: true });
  });

  it("keeps the presentation options the engines read next to the selection", () => {
    expect(
      parseStoredSelection({ all: true, paths: ["x"], options: { archiveName: "a.zip" } }),
    ).toEqual({ all: true, options: { archiveName: "a.zip" } });
    expect(parseStoredSelection({ paths: ["x"], options: "nope" })).toEqual({ paths: ["x"] });
  });
});

describe("toRestoreRequest", () => {
  it("builds the engine request from the stored row", () => {
    const request: RestoreRequest = toRestoreRequest(storedRow, mailbox);
    expect(request).toEqual({
      restoreJobId: RESTORE,
      snapshotId: SNAPSHOT,
      protectedObject: mailbox,
      selection: {
        paths: ["mail/Inbox/a.eml"],
        options: { restoreFolderName: "Wiederhergestellt" },
      },
      target: { type: "other", ref: "bob@example.com" },
      mode: "skip",
      actor: { userId: "user-1", impersonated: true, reason: "ticket 4711" },
      requestedAt: new Date(0),
    });
  });

  it("rejects a request whose snapshot was pruned", () => {
    expect(() => toRestoreRequest({ ...storedRow, snapshotId: null }, mailbox)).toThrow(
      InvalidPayloadError,
    );
  });
});

describe("storedItems / toStoredResult", () => {
  it("puts items needing attention first and keeps the engine order otherwise", () => {
    const items = storedItems([
      item("a"),
      item("b", { status: "skipped", code: "exists", reason: "already exists", bytes: 0 }),
      item("c", { code: "unverified", verified: false, reason: "size mismatch" }),
      item("d", {
        status: "failed",
        code: "target_rejected",
        reason: "mailbox not found",
        id: "AAMk",
        subject: "Invoice 4711",
        from: "Anna Muster <anna@example.com>",
        cause: {
          code: "graph.user_not_found",
          transient: false,
          params: { httpStatus: 404 },
          technical: { httpStatus: 404 },
        },
      }),
      item("e", { reason: "restored into the Restored folder" }),
    ]);
    expect(items.map((stored) => stored.path)).toEqual(["d", "b", "c", "a", "e"]);
    expect(items[0]).toEqual({
      path: "d",
      itemId: "AAMk",
      type: "mail",
      status: "failed",
      code: "target_rejected",
      targetRef: null,
      bytes: 10,
      verified: true,
      reason: "mailbox not found",
      subject: "Invoice 4711",
      from: "Anna Muster <anna@example.com>",
      // Why it failed travels with the item, so the job page can explain it.
      cause: {
        code: "graph.user_not_found",
        transient: false,
        params: { httpStatus: 404 },
        technical: { httpStatus: 404 },
      },
    });
    // Items without a recorded subject (files) store null, not undefined.
    expect(items[1]).toMatchObject({ path: "b", subject: null, from: null });
  });

  it("caps the stored list but counts every outcome", () => {
    const many = Array.from({ length: MAX_STORED_ITEMS + 5 }, (_, index) => item(`i${index}`));
    const at = new Date("2026-03-01T10:00:00Z");
    const stored = toStoredResult(
      {
        restored: many.length,
        skipped: 0,
        bytes: 1234,
        failures: [],
        downloadKey: "tenants/t/downloads/r/restore.zip",
        items: many,
        unverified: 2,
        folders: 3,
      } as RestoreResult,
      at,
    );
    expect(stored).toMatchObject({
      restored: many.length,
      failures: 0,
      unverified: 2,
      folders: 3,
      bytes: 1234,
      downloadKey: "tenants/t/downloads/r/restore.zip",
      completedAt: at.toISOString(),
      itemCount: MAX_STORED_ITEMS + 5,
    });
    expect(stored.items).toHaveLength(MAX_STORED_ITEMS);
  });

  it("works with engines that only report counts", () => {
    const stored = toStoredResult(
      { restored: 0, skipped: 0, bytes: 0, failures: [{ itemRef: "x", reason: "gone" }] },
      new Date(0),
    );
    expect(stored).toMatchObject({
      failures: 1,
      unverified: 0,
      folders: 0,
      itemCount: 0,
      items: [],
      throttleWaits: 0,
      throttleWaitMs: 0,
    });
    expect(stored.downloadKey).toBeNull();
  });
});

describe("restore handler", () => {
  function context(protectedObject: ProtectedObjectRef | null = mailbox) {
    const memory = createMemoryJobContext({
      tenantId: TENANT,
      jobId: JOB,
      queue: "restore",
      keys: new Keyring(TENANT, [generateDek(1)]),
      storage: new LocalStorageBackend(tmpdir()),
      now: () => new Date("2026-03-01T10:00:00Z"),
    });
    const ctx: WorkerJobContext = { ...memory, db: {} as Database, protectedObject };
    return { ctx, sink: memory.progressSink as MemoryProgressSink };
  }

  function memoryStore(row: typeof storedRow | null = storedRow) {
    const persisted: { jobId: string; result: StoredRestoreResult }[] = [];
    const runtime: BackupRuntimeState[] = [];
    const store: RestoreStore = {
      loadRequest: async (id) => (row && row.id === id ? row : null),
      persistRuntimeState: async (_jobId, state) => {
        runtime.push(state);
      },
      persistResult: async (jobId, result) => {
        persisted.push({ jobId, result });
      },
    };
    return { store, persisted, runtime };
  }

  const payload = {
    jobId: JOB,
    tenantId: TENANT,
    restoreJobId: RESTORE,
    protectedObjectId: mailbox.id,
  };

  it("runs the stored request through the dispatcher and persists the outcome", async () => {
    const { ctx } = context();
    const { store, persisted } = memoryStore();
    const seen: RestoreRequest[] = [];
    const dispatcher: RestoreDispatcher = {
      async run(_ctx, request) {
        seen.push(request);
        return {
          restored: 1,
          skipped: 1,
          bytes: 10,
          failures: [],
          items: [
            item("mail/Inbox/a.eml"),
            item("mail/Inbox/b.eml", { status: "skipped", code: "exists", reason: "exists" }),
          ],
          unverified: 0,
        } as RestoreResult;
      },
    };
    const handler = createRestoreHandler({ dispatcher: () => dispatcher, store: () => store });

    const outcome = await handler.run(ctx, payload);

    expect(seen[0]?.target).toEqual({ type: "other", ref: "bob@example.com" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.jobId).toBe(JOB);
    expect(persisted[0]?.result.items.map((stored) => stored.status)).toEqual([
      "skipped",
      "restored",
    ]);
    expect(outcome?.summary).toMatchObject({ restored: 1, skipped: 1, itemCount: 2 });
    expect(outcome?.summary).not.toHaveProperty("items");
  });

  it("records failures an engine only returned, and none twice", async () => {
    const returnedOnly = context();
    const handler = (failures: RestoreResult["failures"], report: boolean) =>
      createRestoreHandler({
        dispatcher: () => ({
          async run(ctx) {
            if (report) {
              for (const failure of failures) ctx.progress.fail(failure.itemRef, failure.reason);
            }
            return { restored: 0, skipped: 0, bytes: 0, failures };
          },
        }),
        store: () => memoryStore().store,
      });
    const failures = [{ itemRef: "AAMk", reason: "mailbox not found" }];

    await handler(failures, false).run(returnedOnly.ctx, payload);
    await returnedOnly.ctx.progress.flush();
    expect(returnedOnly.sink.failures.map((failure) => failure.itemRef)).toEqual(["AAMk"]);

    const reported = context();
    await handler(failures, true).run(reported.ctx, payload);
    await reported.ctx.progress.flush();
    expect(reported.sink.failures).toHaveLength(1);
  });

  const url = "https://graph.microsoft.com/v1.0/users/anna@example.com/mailFolders";

  it("records Graph throttling waits while the restore runs and their totals after", async () => {
    const { ctx } = context();
    const { store, persisted, runtime } = memoryStore();
    const handler = createRestoreHandler({
      dispatcher: (_ctx, hooks) => ({
        async run(engineCtx) {
          engineCtx.progress.phase("folders");
          hooks.throttled({ status: 429, attempt: 1, waitMs: 30_000, retryAfterMs: 30_000, url });
          hooks.throttled({ status: 503, attempt: 2, waitMs: 5_000, retryAfterMs: null, url });
          return { restored: 1, skipped: 0, bytes: 10, failures: [] };
        },
      }),
      store: () => store,
    });

    const outcome = await handler.run(ctx, payload);

    expect(runtime.map((state) => state.throttle?.waits ?? 0)).toEqual([0, 1, 2, 0]);
    expect(runtime[1]?.throttle).toEqual({
      status: 429,
      waitMs: 30_000,
      retryAfterMs: 30_000,
      until: "2026-03-01T10:00:30.000Z",
      waits: 1,
      totalWaitMs: 30_000,
    });
    // The run is over: nothing is left to show as a current wait.
    expect(runtime.at(-1)).toEqual({ phase: null, phaseSince: null, throttle: null });
    expect(persisted[0]?.result).toMatchObject({ throttleWaits: 2, throttleWaitMs: 35_000 });
    expect(outcome?.summary).toMatchObject({ throttleWaits: 2, throttleWaitMs: 35_000 });
  });

  it("clears the runtime state when the engines fail", async () => {
    const { ctx } = context();
    const { store, runtime } = memoryStore();
    const handler = createRestoreHandler({
      dispatcher: (_ctx, hooks) => ({
        async run() {
          hooks.throttled({ status: 429, attempt: 1, waitMs: 1_000, retryAfterMs: null, url });
          throw new Error("Graph unavailable");
        },
      }),
      store: () => store,
    });

    await expect(handler.run(ctx, payload)).rejects.toThrow("Graph unavailable");
    expect(runtime.at(-1)).toEqual({ phase: null, phaseSince: null, throttle: null });
  });

  it("rejects jobs it cannot run instead of retrying them", async () => {
    const dispatcher = () => ({
      run: async () => ({ restored: 0, skipped: 0, bytes: 0, failures: [] }),
    });
    const withStore = (row: typeof storedRow | null) =>
      createRestoreHandler({ dispatcher, store: () => memoryStore(row).store });

    await expect(
      withStore(storedRow).run(context().ctx, { ...payload, restoreJobId: "nope" }),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(withStore(storedRow).run(context(null).ctx, payload)).rejects.toBeInstanceOf(
      InvalidPayloadError,
    );
    await expect(withStore(null).run(context().ctx, payload)).rejects.toBeInstanceOf(
      InvalidPayloadError,
    );
    await expect(
      withStore({ ...storedRow, snapshotId: null } as unknown as typeof storedRow).run(
        context().ctx,
        payload,
      ),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});

// ---------------------------------------------------------------------------
// Postgres: the store and the IMAP target lookup
// ---------------------------------------------------------------------------

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_restore_test";

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

describe.skipIf(!adminUrl)("restore store against Postgres", () => {
  let db: Database;
  let tenantId: string;
  let imapObject: ProtectedObjectRef;
  let restoreJobId: string;
  let jobId: string;

  beforeAll(async () => {
    const base = adminUrl as string;
    await withAdmin(base, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(base, `CREATE DATABASE ${TEST_DB}`);
    const url = new URL(base);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());

    const [provider] = await db.insert(providers).values({ name: "P" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "T",
        slug: `t-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: "Mail host",
        host: "imap.example.test",
        port: 993,
        security: "tls",
        config: { authKind: "password" },
      })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "imap",
        externalId: "info@example.test",
      })
      .returning();
    imapObject = object as ProtectedObjectRef;
    const [snapshot] = await db
      .insert(snapshots)
      .values({ tenantId, protectedObjectId: imapObject.id, sequence: 1 })
      .returning();
    jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "restore",
      protectedObjectId: imapObject.id,
      payload: { jobId, tenantId },
    });
    restoreJobId = randomUUID();
    await db.insert(restoreJobs).values({
      id: restoreJobId,
      tenantId,
      jobId,
      snapshotId: snapshot?.id as string,
      sourceSelection: { folderPaths: ["mail/INBOX"] },
      targetType: "original",
    });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  it("loads the request and merges the result into the job payload", async () => {
    const store = pgRestoreStore(tenantRunner(db, tenantId), tenantId);
    expect((await store.loadRequest(restoreJobId))?.sourceSelection).toEqual({
      folderPaths: ["mail/INBOX"],
    });
    expect(await store.loadRequest(randomUUID())).toBeNull();

    const result = toStoredResult(
      { restored: 2, skipped: 0, bytes: 20, failures: [] },
      new Date(0),
    );
    const runtime: BackupRuntimeState = { phase: null, phaseSince: null, throttle: null };
    await store.persistRuntimeState(jobId, runtime);
    await store.persistResult(jobId, result);
    const [row] = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, jobId));
    expect(row?.payload).toEqual({ jobId, tenantId, runtime, result });
  });

  it("resolves the IMAP account of the object and of another known login", async () => {
    const run = tenantRunner(db, tenantId);
    const loadSource = async () => {
      const [source] = await db.select().from(sources).where(eq(sources.tenantId, tenantId));
      if (!source) throw new Error("fixture source missing");
      return { objectStatus: "active" as const, source, objectSecretRef: null };
    };
    const store = { loadSource };

    // Without a stored credential the account is refused with a clear reason.
    await expect(
      imapTargetAccount(run, tenantId, store, imapObject, { type: "original", ref: null }),
    ).rejects.toThrow(/no stored credential/);

    const [secret] = await db
      .insert(secrets)
      .values({ tenantId, kind: "imap_password", ciphertext: "sealed" })
      .returning();
    await db.update(sources).set({ secretRef: secret?.id }).where(eq(sources.tenantId, tenantId));
    const expected = {
      host: "imap.example.test",
      port: 993,
      security: "tls",
      username: "info@example.test",
      authKind: "password",
      secretId: secret?.id,
      allowPrivateNetwork: false,
    };
    expect(
      await imapTargetAccount(run, tenantId, store, imapObject, { type: "original", ref: null }),
    ).toEqual(expected);
    expect(
      await imapTargetAccount(run, tenantId, store, imapObject, {
        type: "other",
        ref: " INFO@example.test ",
      }),
    ).toEqual(expected);
    await expect(
      imapTargetAccount(run, tenantId, store, imapObject, {
        type: "other",
        ref: "ghost@example.test",
      }),
    ).rejects.toThrow(/not an account of this tenant/);
  });

  it("resolves a per_mailbox account from the object's own secret, not the source's", async () => {
    const run = tenantRunner(db, tenantId);
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: "Hoster with per-mailbox passwords",
        host: "imap.hoster.test",
        port: 993,
        security: "tls",
        config: { imapAuthMode: "per_mailbox" },
      })
      .returning();
    const [objectSecret] = await db
      .insert(secrets)
      .values({ tenantId, kind: "imap_password", ciphertext: "sealed-mailbox-secret" })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "imap",
        externalId: "perbox@hoster.test",
        secretRef: objectSecret?.id,
        credentialStatus: "untested",
      })
      .returning();
    const store = {
      loadSource: async () => ({
        objectStatus: "active" as const,
        source: source as typeof source & { kind: "imap" },
        objectSecretRef: object?.secretRef ?? null,
      }),
    };
    expect(
      await imapTargetAccount(run, tenantId, store, object as ProtectedObjectRef, {
        type: "original",
        ref: null,
      }),
    ).toEqual({
      host: "imap.hoster.test",
      port: 993,
      security: "tls",
      username: "perbox@hoster.test",
      authKind: "password",
      secretId: objectSecret?.id,
      allowPrivateNetwork: false,
    });
  });

  it("master_user: builds the SASL authzid login from the source's master credential", async () => {
    const run = tenantRunner(db, tenantId);
    const [masterSecret] = await db
      .insert(secrets)
      .values({ tenantId, kind: "imap_password", ciphertext: "sealed-master-secret" })
      .returning();
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: "Master user host",
        host: "imap.master.test",
        port: 993,
        security: "tls",
        secretRef: masterSecret?.id,
        config: {
          imapAuthMode: "master_user",
          masterUser: { username: "master", style: "sasl_authzid" },
        },
      })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "imap",
        externalId: "impersonated@master.test",
      })
      .returning();
    const store = {
      loadSource: async () => ({
        objectStatus: "active" as const,
        source: source as typeof source & { kind: "imap" },
        objectSecretRef: null,
      }),
    };
    expect(
      await imapTargetAccount(run, tenantId, store, object as ProtectedObjectRef, {
        type: "original",
        ref: null,
      }),
    ).toEqual({
      host: "imap.master.test",
      port: 993,
      security: "tls",
      username: "master",
      authzid: "impersonated@master.test",
      authKind: "password",
      secretId: masterSecret?.id,
      allowPrivateNetwork: false,
    });
  });
});
