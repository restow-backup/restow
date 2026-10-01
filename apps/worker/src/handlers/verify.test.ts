/**
 * The verify handler: its pure parts (sample size, notifications, the stored
 * result and report row), the whole handler on the memory engine (a real
 * snapshot written through the chunk store, then damaged on purpose), and the
 * Postgres store that records the outcome.
 *
 * The Postgres section runs when RESTOW_TEST_DATABASE_URL points at a Postgres
 * server (the database `restow_worker_verify_test` is recreated there and
 * dropped after); without it that section is skipped.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DEFAULT_SAMPLE_SIZE,
  type HeadResult,
  Keyring,
  MemoryChunkIndex,
  type MemoryProgressSink,
  MemorySnapshotIndex,
  type ProtectedObjectRef,
  type RecoveryReadiness,
  SnapshotWriter,
  type StorageBackend,
  VerifyIncompleteError,
  type VerifyOutcome,
  createMemoryJobContext,
  generateDek,
} from "@restow/core";
import {
  type Database,
  type NewNotification,
  type NewVerifyReport,
  createDb,
  jobs,
  notifications,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_DEFINITIONS } from "../queues.js";
import { dropTestDatabase } from "../testing/database.js";
import { InvalidPayloadError, type WorkerJobContext } from "./framework.js";
import {
  MAX_SAMPLE_SIZE,
  type StoredIncompleteVerify,
  VERIFY_EVENTS,
  type VerifyCompletedEvent,
  type VerifyRecord,
  type VerifyStore,
  createVerifyHandler,
  normalizeSampleSize,
  pgVerifyStore,
  readinessNotification,
  redReasonOf,
  toStoredVerifyResult,
  verifyKindOf,
  verifyRecordNotification,
  verifyReportRow,
} from "./verify.js";

const TENANT = "3a7c1e52-8b4d-4f6a-9c2e-1d0b9a8f7e6d";
const JOB = "6e5d4c3b-2a19-4807-b6f5-e4d3c2b1a098";
const NOW = new Date("2026-09-23T03:00:00.000Z");

const mailbox: ProtectedObjectRef = {
  id: "c4b3a291-8f7e-4d6c-9b5a-4e3d2c1b0a9f",
  tenantId: TENANT,
  sourceId: "d5c4b3a2-918f-4e7d-8c6b-5a4f3e2d1c0b",
  kind: "mailbox",
  externalId: "anna@example.org",
  displayName: "Anna Example",
  userId: null,
};

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("normalizeSampleSize / verifyKindOf", () => {
  it("keeps a usable sample size and falls back to the default otherwise", () => {
    expect(normalizeSampleSize(1)).toBe(1);
    expect(normalizeSampleSize(20)).toBe(20);
    expect(normalizeSampleSize(MAX_SAMPLE_SIZE)).toBe(MAX_SAMPLE_SIZE);
    for (const unusable of [0, -3, MAX_SAMPLE_SIZE + 1, 2.5, Number.NaN, "20", null, undefined]) {
      expect(normalizeSampleSize(unusable)).toBe(DEFAULT_SAMPLE_SIZE);
    }
  });

  it("runs a sampled verify unless a health check is asked for", () => {
    expect(verifyKindOf({ kind: "health_check" })).toBe("health_check");
    expect(verifyKindOf({ kind: "verify" })).toBe("verify");
    expect(verifyKindOf({ kind: "bogus" as never })).toBe("verify");
  });
});

describe("readinessNotification", () => {
  const notify = (previous: RecoveryReadiness | null, current: RecoveryReadiness) =>
    readinessNotification({
      tenantId: TENANT,
      object: mailbox,
      previous,
      current,
      reportId: "report-1",
      reasons: ["items_missing"],
    });

  // Every previous rating (none yet, green, yellow, red) against every current one.
  const expected: [RecoveryReadiness | null, RecoveryReadiness, string | null][] = [
    [null, "green", null],
    [null, "yellow", VERIFY_EVENTS.yellow],
    [null, "red", VERIFY_EVENTS.red],
    ["green", "green", null],
    ["green", "yellow", VERIFY_EVENTS.yellow],
    ["green", "red", VERIFY_EVENTS.red],
    ["yellow", "green", VERIFY_EVENTS.recovered],
    ["yellow", "yellow", null],
    ["yellow", "red", VERIFY_EVENTS.red],
    ["red", "green", VERIFY_EVENTS.recovered],
    // Better than red but not fine yet: no "needs attention" after a red alarm.
    ["red", "yellow", null],
    ["red", "red", null],
  ];

  it.each(expected)("from %s to %s raises %s", (previous, current, event) => {
    expect(notify(previous, current)?.event ?? null).toBe(event);
  });

  it("carries the level, the object and the findings", () => {
    expect(notify("green", "red")).toEqual({
      tenantId: TENANT,
      level: "error",
      event: VERIFY_EVENTS.red,
      message: "Recovery readiness of Anna Example is red: a restore would not be complete.",
      details: {
        protectedObjectId: mailbox.id,
        objectName: "Anna Example",
        objectKind: "mailbox",
        reportId: "report-1",
        readiness: "red",
        previous: "green",
        reasons: ["items_missing"],
        redReason: "damaged",
      },
    });
    expect(notify(null, "yellow")?.level).toBe("warning");
    expect(notify("red", "green")?.level).toBe("info");
  });

  it("tells a backup that is too old apart from data that is damaged or missing", () => {
    const red = (reasons: string[]) =>
      readinessNotification({
        tenantId: TENANT,
        object: mailbox,
        previous: "green",
        current: "red",
        reportId: "r",
        reasons,
      });
    const old = red(["snapshot_outdated", "nothing_to_verify"]);
    expect(old?.details).toMatchObject({ redReason: "outdated" });
    expect(old?.message).toBe(
      "Recovery readiness of Anna Example is red: the newest backup is too old, newer data could not be restored.",
    );
    expect(red(["items_mismatched", "snapshot_outdated"])?.details).toMatchObject({
      redReason: "damaged",
    });
    expect(red(["storage_corrupt"])?.message).toContain("a restore would not be complete");
    expect(redReasonOf(["no_snapshot"])).toBe("damaged");
  });

  it("names an object without a display name by its external id", () => {
    const unnamed = readinessNotification({
      tenantId: TENANT,
      object: { ...mailbox, displayName: null },
      previous: "green",
      current: "red",
      reportId: "r",
      reasons: [],
    });
    expect(unnamed?.message).toContain("anna@example.org");
  });
});

function outcome(overrides: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    readiness: "red",
    checked: 26,
    mismatched: 1,
    missing: 2,
    snapshotId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
    details: {
      format: 1,
      origin: "verify",
      kind: "verify",
      scope: "sample",
      seed: 7,
      quota: null,
      snapshot: null,
      reasons: [{ code: "items_missing", severity: "red", count: 2 }],
      counts: {
        eligible: { mail: 30, file: 0, event: 3, contact: 3 },
        sampled: { mail: 20, file: 0, event: 3, contact: 3 },
        checked: 26,
        bytesRead: 1024,
        verified: 23,
        mismatch: 1,
        missing: 1,
        unreadable: 1,
      },
      items: [],
      itemsOmitted: 0,
      damagedPacks: [],
      testRestore: null,
      startedAt: NOW.toISOString(),
      durationMs: 1200,
    },
    ...overrides,
  };
}

function record(overrides: Partial<VerifyRecord> = {}): VerifyRecord {
  return {
    tenantId: TENANT,
    jobId: JOB,
    object: mailbox,
    kind: "verify",
    outcome: outcome(),
    previous: "green",
    checkedAt: NOW,
    ...overrides,
  };
}

describe("toStoredVerifyResult", () => {
  it("keeps what the job views read, the checked snapshot included", () => {
    expect(toStoredVerifyResult("report-1", outcome(), NOW)).toEqual({
      reportId: "report-1",
      readiness: "red",
      snapshotId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
      checked: 26,
      mismatched: 1,
      missing: 2,
      completedAt: NOW.toISOString(),
    });
  });

  it("stores a null snapshot when there was nothing to check", () => {
    const result = toStoredVerifyResult("r", outcome({ snapshotId: null, checked: 0 }), NOW);
    expect(result.snapshotId).toBeNull();
    expect(result.checked).toBe(0);
  });
});

describe("verifyReportRow / verifyRecordNotification", () => {
  it("links the report to the checked snapshot", () => {
    const row = verifyReportRow(record());
    expect(row).toMatchObject({
      tenantId: TENANT,
      protectedObjectId: mailbox.id,
      jobId: JOB,
      snapshotId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
      kind: "verify",
      recoveryReadiness: "red",
      checkedAt: NOW,
    });
    expect(row.details).toMatchObject({ origin: "verify", seed: 7 });
    expect(verifyReportRow(record({ outcome: outcome({ snapshotId: null }) })).snapshotId).toBe(
      null,
    );
  });

  it("notifies from the recorded run only on a rating change", () => {
    expect(verifyRecordNotification(record(), "r1")?.event).toBe(VERIFY_EVENTS.red);
    expect(verifyRecordNotification(record({ previous: "red" }), "r1")).toBeNull();
    expect(verifyRecordNotification(record(), "r1")?.details).toMatchObject({
      reportId: "r1",
      reasons: ["items_missing"],
    });
  });
});

// ---------------------------------------------------------------------------
// The handler on the memory engine
// ---------------------------------------------------------------------------

/** A map-backed storage target whose bytes a test can damage. */
class MemoryStorage implements StorageBackend {
  readonly files = new Map<string, Buffer>();
  /** While set, every read fails with this error (the storage does not answer). */
  outage: (() => unknown) | null = null;

  async put(key: string, data: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(data)) {
      this.files.set(key, Buffer.from(data));
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of data) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    }
    this.files.set(key, Buffer.concat(parts));
  }

  async get(key: string): Promise<Buffer> {
    if (this.outage) {
      throw this.outage();
    }
    const file = this.files.get(key);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return Buffer.from(file);
  }

  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }

  async head(key: string): Promise<HeadResult | null> {
    const file = this.files.get(key);
    return file ? { size: file.length } : null;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  /** Flip one byte of a stored file (bit rot). */
  flipByte(key: string, offset: number): void {
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`no file ${key}`);
    }
    file[offset] = (file[offset] ?? 0) ^ 0xff;
  }
}

/** Deterministic bytes with real entropy, so chunks do not deduplicate. */
function fixtureBytes(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

interface Engine {
  ctx: WorkerJobContext;
  sink: MemoryProgressSink;
  storage: MemoryStorage;
  index: MemoryChunkIndex;
}

function memoryEngine(options: { tenantId?: string; object?: ProtectedObjectRef } = {}): Engine {
  const tenantId = options.tenantId ?? TENANT;
  const storage = new MemoryStorage();
  const index = new MemoryChunkIndex();
  const base = createMemoryJobContext({
    tenantId,
    jobId: JOB,
    queue: "verify",
    keys: new Keyring(tenantId, [generateDek(1)]),
    storage: { primary: storage, copies: [] },
    chunkIndex: index,
    snapshots: new MemorySnapshotIndex(tenantId),
    now: () => NOW,
  });
  const ctx: WorkerJobContext = {
    ...base,
    db: {} as Database,
    protectedObject: options.object ?? mailbox,
  };
  return { ctx, sink: base.progressSink as MemoryProgressSink, storage, index };
}

/** Five mails and one event, committed as one snapshot through the chunk store. */
async function writeMailboxSnapshot(
  engine: Engine,
  snapshotId: string = randomUUID(),
): Promise<{ snapshotId: string; chunksByPath: Map<string, string[]> }> {
  const object = engine.ctx.protectedObject as ProtectedObjectRef;
  const writer = await SnapshotWriter.begin(engine.ctx, {
    protectedObject: object,
    sourceType: "m365",
    maxPackBytes: 16 * 1024,
    snapshotIdGenerator: () => snapshotId,
  });
  const items = [
    ...Array.from({ length: 5 }, (_, i) => ({ path: `mail/Inbox/${i}.eml`, type: "mail" })),
    { path: "calendar/Calendar/0.json", type: "event" },
  ];
  const chunksByPath = new Map<string, string[]>();
  for (const [position, item] of items.entries()) {
    const written = await writer.chunks.write(fixtureBytes(700 + position * 13, 100 + position));
    writer.add({
      path: item.path,
      type: item.type,
      id: `item-${position}`,
      size: written.size,
      mtime: Date.UTC(2026, 8, 20, 8, 0),
      sha256: written.sha256,
      chunks: written.chunks,
    });
    chunksByPath.set(item.path, written.chunks);
  }
  const committed = await writer.commit();
  return { snapshotId: committed.snapshotId, chunksByPath };
}

type StoredReport = NewVerifyReport & { id: string };

/** The handler's store over plain arrays, with the same rules as the Postgres store. */
function memoryStore(damaged: ReadonlySet<string> = new Set()) {
  const reports: StoredReport[] = [];
  const raised: NewNotification[] = [];
  const incomplete: StoredIncompleteVerify[] = [];
  const store: VerifyStore = {
    recordIncomplete: async (_jobId, result) => {
      incomplete.push(result);
    },
    previousReadiness: async (objectId) =>
      reports.filter((report) => report.protectedObjectId === objectId).at(-1)?.recoveryReadiness ??
      null,
    damagedPacks: async () => damaged,
    record: async (entry) => {
      const id = randomUUID();
      reports.push({ ...verifyReportRow(entry), id });
      const notification = verifyRecordNotification(entry, id);
      if (notification) {
        raised.push(notification);
      }
      return toStoredVerifyResult(id, entry.outcome, entry.checkedAt);
    },
  };
  return { store, reports, raised, incomplete };
}

const payload = {
  jobId: JOB,
  tenantId: TENANT,
  protectedObjectId: mailbox.id,
  kind: "verify" as const,
  sampleSize: 20,
};

describe("verify handler on the memory engine", () => {
  function handlerWith(store: VerifyStore, events: VerifyCompletedEvent[] = []) {
    return createVerifyHandler({
      probes: () => null,
      store: () => store,
      announce: async (_ctx, event) => {
        events.push(event);
      },
    });
  }

  it("rates an intact snapshot green, links the report to it and raises nothing", async () => {
    const engine = memoryEngine();
    const { snapshotId } = await writeMailboxSnapshot(engine);
    const { store, reports, raised } = memoryStore();
    const events: VerifyCompletedEvent[] = [];

    const result = await handlerWith(store, events).run(engine.ctx, payload);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      recoveryReadiness: "green",
      snapshotId,
      jobId: JOB,
      kind: "verify",
      checkedAt: NOW,
    });
    expect(raised).toEqual([]);
    expect(result?.summary).toMatchObject({ readiness: "green", snapshotId, checked: 6 });
    expect(events[0]).toMatchObject({
      readiness: "green",
      snapshotId,
      reportId: reports[0]?.id,
      previous: null,
      protectedObjectId: mailbox.id,
      objectName: "Anna Example",
    });
  });

  it("ends red when a stored chunk is corrupted, with the snapshot id on the report", async () => {
    const engine = memoryEngine();
    const { snapshotId, chunksByPath } = await writeMailboxSnapshot(engine);
    const [chunk] = chunksByPath.get("mail/Inbox/2.eml") ?? [];
    const location = engine.index.chunks.get(chunk as string);
    if (!location) {
      throw new Error("fixture chunk is not indexed");
    }
    // Inside the sealed chunk: authenticated decryption must fail.
    engine.storage.flipByte(location.packPath, location.offset + Math.floor(location.length / 2));
    const { store, reports } = memoryStore();

    const result = await handlerWith(store).run(engine.ctx, payload);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ recoveryReadiness: "red", snapshotId });
    const details = reports[0]?.details as VerifyOutcome["details"];
    expect(details.reasons.map((reason) => reason.code)).toContain("items_unreadable");
    expect(details.items.find((item) => item.path === "mail/Inbox/2.eml")?.status).toBe(
      "unreadable",
    );
    expect(result?.summary).toMatchObject({ readiness: "red", snapshotId });
    expect(engine.sink.failures.length).toBeGreaterThan(0);
  });

  it("ends red when an item's data is missing, with the snapshot id on the report", async () => {
    const engine = memoryEngine();
    const { snapshotId, chunksByPath } = await writeMailboxSnapshot(engine);
    for (const chunk of chunksByPath.get("mail/Inbox/4.eml") ?? []) {
      engine.index.chunks.delete(chunk);
    }
    const { store, reports } = memoryStore();

    const result = await handlerWith(store).run(engine.ctx, payload);

    expect(reports[0]).toMatchObject({ recoveryReadiness: "red", snapshotId });
    const details = reports[0]?.details as VerifyOutcome["details"];
    expect(details.reasons.map((reason) => reason.code)).toContain("items_missing");
    expect(details.items.find((item) => item.path === "mail/Inbox/4.eml")?.status).toBe("missing");
    expect(result?.summary).toMatchObject({ readiness: "red", missing: 1, snapshotId });
  });

  it("writes a notification only when the rating changes", async () => {
    const engine = memoryEngine();
    const { chunksByPath } = await writeMailboxSnapshot(engine);
    const { store, reports, raised } = memoryStore();
    const handler = handlerWith(store);
    const run = async () => {
      await handler.run(engine.ctx, payload);
      return raised.map((notification) => notification.event);
    };

    // First green: nothing to tell. Green again: still nothing.
    expect(await run()).toEqual([]);
    expect(await run()).toEqual([]);

    // Data disappears: one alarm, and no second one while it stays red.
    const removed = new Map<string, NonNullable<ReturnType<typeof engine.index.chunks.get>>>();
    for (const chunk of chunksByPath.get("mail/Inbox/0.eml") ?? []) {
      const entry = engine.index.chunks.get(chunk);
      if (entry) {
        removed.set(chunk, entry);
        engine.index.chunks.delete(chunk);
      }
    }
    expect(await run()).toEqual([VERIFY_EVENTS.red]);
    expect(await run()).toEqual([VERIFY_EVENTS.red]);

    // Repaired: the recovery is announced once.
    for (const [chunk, entry] of removed) {
      engine.index.chunks.set(chunk, entry);
    }
    expect(await run()).toEqual([VERIFY_EVENTS.red, VERIFY_EVENTS.recovered]);
    expect(await run()).toEqual([VERIFY_EVENTS.red, VERIFY_EVENTS.recovered]);

    expect(reports.map((report) => report.recoveryReadiness)).toEqual([
      "green",
      "green",
      "red",
      "red",
      "green",
      "green",
    ]);
    expect(raised[0]?.details).toMatchObject({ previous: "green", readiness: "red" });
  });

  it("rates nothing when the storage does not answer, retries, and completes the last attempt without a rating", async () => {
    const engine = memoryEngine();
    await writeMailboxSnapshot(engine);
    const { store, reports, raised, incomplete } = memoryStore();
    const events: VerifyCompletedEvent[] = [];
    const handler = handlerWith(store, events);
    // A green check first: the outage must leave it as the last result.
    await handler.run(engine.ctx, payload);
    expect(reports.map((report) => report.recoveryReadiness)).toEqual(["green"]);

    engine.storage.outage = () =>
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:9000"), {
        code: "ECONNREFUSED",
        syscall: "connect",
        address: "10.0.0.5",
        port: 9000,
      });
    const failed = await handler.run(engine.ctx, payload).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(VerifyIncompleteError);
    expect(incomplete[0]).toMatchObject({
      incomplete: true,
      willRetry: true,
      failure: { code: "storage.unreachable", transient: true },
    });
    // No report, no notification, no verify.completed: the green check stays the last one.
    expect(reports).toHaveLength(1);
    expect(raised).toEqual([]);
    expect(events).toHaveLength(1);

    // The last attempt completes the job instead of failing it, still without a rating.
    const last = { ...engine.ctx, attempt: QUEUE_DEFINITIONS.verify.retryLimit };
    const result = await handler.run(last, payload);
    expect(result?.summary).toMatchObject({
      incomplete: true,
      willRetry: false,
      previous: "green",
    });
    expect(incomplete[1]).toMatchObject({ willRetry: false });
    expect(reports).toHaveLength(1);
    expect(raised).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("rates a pack the latest scrub left corrupt red although the sample reads fine", async () => {
    const engine = memoryEngine();
    const { snapshotId } = await writeMailboxSnapshot(engine);
    const packs = await engine.storage.list(`tenants/${TENANT}/packs/`);
    const { store, reports } = memoryStore(new Set(packs));

    await handlerWith(store).run(engine.ctx, payload);

    expect(reports[0]).toMatchObject({ recoveryReadiness: "red", snapshotId });
    const details = reports[0]?.details as VerifyOutcome["details"];
    expect(details.damagedPacks).toEqual(packs);
  });

  it("records a red report without a snapshot when nothing was backed up yet", async () => {
    const engine = memoryEngine();
    const { store, reports } = memoryStore();

    await handlerWith(store).run(engine.ctx, payload);

    expect(reports[0]).toMatchObject({ recoveryReadiness: "red", snapshotId: null });
  });

  it("keeps the recorded report when the webhook cannot be queued", async () => {
    const engine = memoryEngine();
    await writeMailboxSnapshot(engine);
    const { store, reports } = memoryStore();
    const handler = createVerifyHandler({
      probes: () => null,
      store: () => store,
      announce: async () => {
        throw new Error("webhook queue unavailable");
      },
    });

    await expect(handler.run(engine.ctx, payload)).resolves.toBeDefined();
    expect(reports).toHaveLength(1);
  });

  it("rejects a job without a protected object instead of retrying it", async () => {
    const engine = memoryEngine();
    const handler = handlerWith(memoryStore().store);
    await expect(
      handler.run({ ...engine.ctx, protectedObject: null }, payload),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});

// ---------------------------------------------------------------------------
// Postgres: the production store
// ---------------------------------------------------------------------------

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_verify_test";

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

describe.skipIf(!adminUrl)("verify handler against Postgres", () => {
  let db: Database;
  let tenantId: string;
  let object: ProtectedObjectRef;
  let snapshotId: string;
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
      .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "mailbox",
        externalId: "anna@example.org",
        displayName: "Anna Example",
      })
      .returning();
    object = {
      id: row?.id as string,
      tenantId,
      sourceId: source?.id as string,
      kind: "mailbox",
      externalId: "anna@example.org",
      displayName: "Anna Example",
      userId: null,
    };
    // The snapshot the memory engine writes has the id of this row, so the
    // report's foreign key points at a real snapshot.
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        tenantId,
        protectedObjectId: object.id,
        sequence: 1,
        manifestPath: "tenants/t/manifests/1.json",
        completedAt: NOW,
      })
      .returning();
    snapshotId = snapshot?.id as string;
    jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "verify",
      status: "active",
      protectedObjectId: object.id,
      payload: { jobId, tenantId, protectedObjectId: object.id, kind: "verify" },
    });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  function engineFor(): Engine {
    const engine = memoryEngine({ tenantId, object });
    const ctx: WorkerJobContext = { ...engine.ctx, db, jobId };
    return { ...engine, ctx };
  }

  async function storedReports() {
    return db
      .select({
        readiness: verifyReports.recoveryReadiness,
        snapshotId: verifyReports.snapshotId,
        jobId: verifyReports.jobId,
      })
      .from(verifyReports)
      .where(eq(verifyReports.tenantId, tenantId))
      .orderBy(asc(verifyReports.checkedAt), asc(verifyReports.createdAt));
  }

  async function storedEvents() {
    const rows = await db
      .select({ event: notifications.event })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId))
      .orderBy(asc(notifications.createdAt));
    return rows.map((row) => row.event);
  }

  it("stores the checked snapshot on every report and notifies only on a change", async () => {
    const engine = engineFor();
    const { chunksByPath } = await writeMailboxSnapshot(engine, snapshotId);
    let clock = NOW.getTime();
    const ctx: WorkerJobContext = {
      ...engine.ctx,
      now: () => {
        clock += 60_000;
        return new Date(clock);
      },
    };
    // The default store: the worker's tenant-pinned Postgres transactions.
    const handler = createVerifyHandler({ probes: () => null });
    const run = (): Promise<unknown> =>
      handler.run(ctx, { ...payload, jobId, tenantId, protectedObjectId: object.id });

    await run();
    await run();
    const [corrupt] = chunksByPath.get("mail/Inbox/1.eml") ?? [];
    const location = engine.index.chunks.get(corrupt as string);
    if (!location) {
      throw new Error("fixture chunk is not indexed");
    }
    engine.storage.flipByte(location.packPath, location.offset + Math.floor(location.length / 2));
    await run();
    await run();

    expect(await storedReports()).toEqual([
      { readiness: "green", snapshotId, jobId },
      { readiness: "green", snapshotId, jobId },
      { readiness: "red", snapshotId, jobId },
      { readiness: "red", snapshotId, jobId },
    ]);
    expect(await storedEvents()).toEqual([VERIFY_EVENTS.red]);

    const [job] = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, jobId));
    expect(job?.payload?.result).toMatchObject({ readiness: "red", snapshotId });
    expect(job?.payload).toMatchObject({ kind: "verify", protectedObjectId: object.id });
  });

  it("notes an attempt that could not complete on the job, with no report and no notification", async () => {
    const engine = engineFor();
    await writeMailboxSnapshot(engine, snapshotId);
    engine.storage.outage = () =>
      Object.assign(new Error("ServiceUnavailable"), {
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503 },
      });
    const handler = createVerifyHandler({ probes: () => null });
    const before = { reports: await storedReports(), events: await storedEvents() };
    await expect(
      handler.run(engine.ctx, { ...payload, jobId, tenantId, protectedObjectId: object.id }),
    ).rejects.toBeInstanceOf(VerifyIncompleteError);
    expect(await storedReports()).toEqual(before.reports);
    expect(await storedEvents()).toEqual(before.events);
    const [job] = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, jobId));
    expect(job?.payload?.result).toMatchObject({
      incomplete: true,
      willRetry: true,
      failure: { code: "storage.rate_limited", transient: true },
    });
    // The rating the object had stays its newest.
    expect(await pgVerifyStore(db, tenantId).previousReadiness(object.id)).toBe("red");
  });

  it("reads the newest rating of the object as the previous one", async () => {
    const store = pgVerifyStore(db, tenantId);
    expect(await store.previousReadiness(object.id)).toBe("red");
    expect(await store.previousReadiness(randomUUID())).toBeNull();
    expect(await store.damagedPacks()).toEqual(new Set());
  });

  it("refuses to record a run of another tenant", async () => {
    const store = pgVerifyStore(db, tenantId);
    await expect(store.record(record({ tenantId: randomUUID() }))).rejects.toThrow(
      /another tenant/,
    );
  });
});
