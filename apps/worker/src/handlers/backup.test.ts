import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  type BackupEngine,
  type BackupResult,
  createMemoryJobContext,
  deriveInstallationSecretsKey,
  EntraAppResolver,
  ExchangeBackupEngine,
  entraAppEnvironmentFrom,
  FetchGraphClient,
  GraphError,
  GroupMailboxBackupEngine,
  generateDek,
  type HeadResult,
  ImapBackupEngine,
  isNotBackedUpCause,
  isNotBackedUpFailure,
  Keyring,
  type Logger,
  MailboxAccessError,
  MemoryProgressSink,
  OneDriveBackupEngine,
  ProgressTracker,
  type ProtectedObjectRef,
  SharePointBackupEngine,
  type StorageBackend,
  type StorageTargets,
  type StoredEntraAppRow,
  sealSecret,
  serializeEntraAppDocument,
} from "@restow/core";
import type { Database, Source } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  appCredentialsForSource,
  type BackupEngineDeps,
  BackupEngineRegistry,
  type BackupRuntimeState,
  type BackupStore,
  backupRejection,
  backupRejectionCode,
  createBackupHandler,
  createDefaultBackupEngines,
  enqueueVerifyAfterBackup,
  ensureManifestOnCopies,
  graphClientForSource,
  IDLE_RUNTIME_STATE,
  imapAccountFor,
  mayBeInactiveMailbox,
  PhaseRecorder,
  type StoredBackupResult,
  selectBackupEngine,
  TokenProviderCache,
  toStoredBackupResult,
  withThrottle,
} from "./backup.js";
import { InvalidPayloadError, type WorkerJobContext } from "./framework.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const VERIFY_SCHEDULE = "5d8c1f3a-2b4e-4c6d-9e8f-0a1b2c3d4e5f";
const OBJECT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const SOURCE = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SECRET = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b";
const ENTRA_TENANT = "11111111-2222-4333-8444-555555555555";
/** Structure only (key block plus certificate block); never parsed as real key material here. */
const TEST_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "dGVzdC1rZXk=",
  "-----END PRIVATE KEY-----",
  "-----BEGIN CERTIFICATE-----",
  "dGVzdC1jZXJ0",
  "-----END CERTIFICATE-----",
].join("\n");

const mailbox: ProtectedObjectRef = {
  id: OBJECT,
  tenantId: TENANT,
  sourceId: SOURCE,
  kind: "mailbox",
  externalId: "alice@contoso.example",
  displayName: "Alice",
  userId: null,
};

function m365Source(overrides: Partial<Source> = {}): Source {
  const at = new Date(Date.UTC(2026, 0, 1));
  return {
    id: SOURCE,
    tenantId: TENANT,
    kind: "m365",
    name: "Contoso",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    entraTenantId: ENTRA_TENANT,
    consentGrantedAt: at,
    consentBy: "admin@contoso.example",
    permissionsVerified: null,
    host: null,
    port: null,
    security: null,
    username: null,
    secretRef: null,
    config: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function imapSource(overrides: Partial<Source> = {}): Source {
  return m365Source({
    kind: "imap",
    name: "Mail server",
    entraTenantId: null,
    consentGrantedAt: null,
    consentBy: null,
    host: "imap.example.org",
    port: 993,
    security: "tls",
    username: "service@example.org",
    secretRef: SECRET,
    config: { authKind: "password" },
    ...overrides,
  });
}

class MemoryStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(data)) {
      this.objects.set(key, Buffer.from(data));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) {
      throw new Error(`missing ${key}`);
    }
    return value;
  }

  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }

  async head(key: string): Promise<HeadResult | null> {
    const value = this.objects.get(key);
    return value ? { size: value.length } : null;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  debug(message: string, fields?: Record<string, unknown>) {
    this.lines.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: Record<string, unknown>) {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: Record<string, unknown>) {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: Record<string, unknown>) {
    this.lines.push({ level: "error", message, fields });
  }
  child(): Logger {
    return this;
  }
}

function engine(
  kind: ProtectedObjectRef["kind"],
  run?: BackupEngine["run"],
): BackupEngine<Database> {
  return {
    kind,
    run:
      run ??
      (async () => ({
        snapshotId: "unused",
        sequence: 1,
        objectsWritten: 0,
        objectsTotal: 0,
        bytes: 0,
        failures: [],
      })),
  };
}

interface FakeStoreOptions {
  source?: Source;
  objectStatus?: "active" | "excluded" | "orphaned";
  objectStatusReason?: "account_disabled" | "no_license" | "locked" | null;
  objectSecretRef?: string | null;
  verifyScheduled?: boolean;
  /** The backup job that checks restores of the object (it comes before a schedule). */
  verifyJobId?: string | null;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const runtime: BackupRuntimeState[] = [];
  const results: StoredBackupResult[] = [];
  const queued: Parameters<BackupStore["insertQueuedJob"]>[0][] = [];
  const replacedSecrets: { secretId: string; plaintext: string }[] = [];
  const markedInactive: { id: string; reason: string }[] = [];
  const store: BackupStore = {
    async loadSource() {
      return {
        objectStatus: options.objectStatus ?? "active",
        objectStatusReason: options.objectStatusReason ?? null,
        source: options.source ?? m365Source(),
        objectSecretRef: options.objectSecretRef ?? null,
      };
    },
    async persistRuntimeState(_jobId, state) {
      runtime.push(state);
    },
    async persistResult(_jobId, result) {
      results.push(result);
    },
    async verifyScheduleId() {
      return options.verifyScheduled ? VERIFY_SCHEDULE : null;
    },
    async verifyBackupJobId() {
      return options.verifyJobId ?? null;
    },
    async insertQueuedJob(row) {
      queued.push(row);
    },
    async replaceSecret(secretId, plaintext) {
      replacedSecrets.push({ secretId, plaintext });
    },
    async markInactive(id, reason) {
      markedInactive.push({ id, reason });
      return true;
    },
  };
  return { store, runtime, results, queued, replacedSecrets, markedInactive };
}

function workerContext(
  storage: StorageTargets,
  options: { logger?: Logger; secrets?: Record<string, string>; object?: ProtectedObjectRef } = {},
): WorkerJobContext {
  const keys = new Keyring(TENANT, [generateDek(1)]);
  const base = createMemoryJobContext({
    tenantId: TENANT,
    jobId: JOB,
    keys,
    storage,
    logger: options.logger ?? new RecordingLogger(),
    secrets: options.secrets,
    now: () => new Date(Date.UTC(2026, 0, 1, 12)),
  });
  return { ...base, db: {} as Database, protectedObject: options.object ?? mailbox };
}

function depsFor(
  ctx: WorkerJobContext,
  source: Source,
  objectSecretRef: string | null = null,
): BackupEngineDeps {
  return {
    ctx,
    source,
    store: fakeStore({ source }).store,
    objectSecretRef,
    throttled: () => undefined,
  };
}

describe("engine registry and selection", () => {
  it("selects the factory by kind and rejects a missing kind without retry", () => {
    const registry = new BackupEngineRegistry([
      ["mailbox", () => engine("mailbox")],
      ["onedrive", () => engine("onedrive")],
    ]);
    expect(
      selectBackupEngine(registry, "onedrive")(depsFor(workerContext(storage()), m365Source()))
        .kind,
    ).toBe("onedrive");
    expect(() => selectBackupEngine(registry, "imap")).toThrow(InvalidPayloadError);
    expect(() => selectBackupEngine(registry, "imap")).toThrow(/"imap".*mailbox, onedrive/);
    expect(() => selectBackupEngine(new BackupEngineRegistry(), "imap")).toThrow(
      /no backup engine for protected objects of kind "imap" in this build$/,
    );
  });

  it("lets a later registration replace a kind", () => {
    const first = () => engine("mailbox");
    const second = () => engine("mailbox");
    const registry = new BackupEngineRegistry([["mailbox", first]]).register("mailbox", second);
    expect(registry.get("mailbox")).toBe(second);
    expect(registry.kinds()).toEqual(["mailbox"]);
  });

  it("ships an engine for every protected-object kind", () => {
    const registry = createDefaultBackupEngines({ env: {} });
    expect(registry.kinds().sort()).toEqual(["group", "imap", "mailbox", "onedrive", "site"]);
    const ctx = workerContext(storage());
    expect(registry.get("mailbox")?.(depsFor(ctx, m365Source()))).toBeInstanceOf(
      ExchangeBackupEngine,
    );
    expect(registry.get("onedrive")?.(depsFor(ctx, m365Source()))).toBeInstanceOf(
      OneDriveBackupEngine,
    );
    expect(registry.get("imap")?.(depsFor(ctx, imapSource()))).toBeInstanceOf(ImapBackupEngine);
    expect(registry.get("site")?.(depsFor(ctx, m365Source()))).toBeInstanceOf(
      SharePointBackupEngine,
    );
    expect(registry.get("group")?.(depsFor(ctx, m365Source()))).toBeInstanceOf(
      GroupMailboxBackupEngine,
    );
  });
});

function storage(): StorageTargets {
  return { primary: new MemoryStorage(), copies: [] };
}

describe("backupRejection", () => {
  const ok = {
    objectKind: "mailbox",
    objectStatus: "active",
    sourceKind: "m365",
    sourceStatus: "active",
  } as const;

  it("rejects excluded and orphaned objects and unconnected or disabled sources", () => {
    expect(backupRejection({ ...ok, objectStatus: "excluded" })).toMatch(/excluded/);
    expect(backupRejection({ ...ok, objectStatus: "orphaned" })).toMatch(/no longer exists/);
    expect(backupRejection({ ...ok, sourceStatus: "pending" })).toMatch(/not connected/);
    expect(backupRejection({ ...ok, sourceStatus: "disabled" })).toMatch(/disabled/);
  });

  it("rejects an object whose kind does not belong to its source", () => {
    expect(backupRejection({ ...ok, sourceKind: "imap" })).toMatch(
      /mailbox object cannot belong to a imap source/,
    );
    expect(backupRejection({ ...ok, objectKind: "imap", sourceKind: "imap" })).toBeNull();
  });

  it("allows active objects, including sources whose last probe failed", () => {
    expect(backupRejection(ok)).toBeNull();
    expect(backupRejection({ ...ok, sourceStatus: "error" })).toBeNull();
  });
});

describe("runtime state", () => {
  it("folds throttling waits into a running total with the end of the current wait", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const first = withThrottle(
      IDLE_RUNTIME_STATE,
      { status: 429, waitMs: 32_000, retryAfterMs: 32_000 },
      now,
    );
    expect(first.throttle).toEqual({
      status: 429,
      waitMs: 32_000,
      retryAfterMs: 32_000,
      until: "2026-01-01T12:00:32.000Z",
      waits: 1,
      totalWaitMs: 32_000,
    });
    const second = withThrottle(first, { status: 503, waitMs: 1_000, retryAfterMs: null }, now);
    expect(second.throttle).toMatchObject({ status: 503, waits: 2, totalWaitMs: 33_000 });
    expect(IDLE_RUNTIME_STATE.throttle).toBeNull();
  });

  it("persists phase changes once each, records throttling, forwards counters and clears on finish", async () => {
    const sink = new MemoryProgressSink();
    const inner = new ProgressTracker({ sink, flushEveryItems: 1, flushIntervalMs: 0 });
    const persisted: BackupRuntimeState[] = [];
    let tick = 0;
    const recorder = new PhaseRecorder(
      inner,
      async (state) => {
        persisted.push(state);
      },
      new RecordingLogger(),
      () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    );

    recorder.total(3);
    recorder.phase("enumerate");
    recorder.phase("enumerate");
    recorder.advance(1, 10);
    recorder.throttled({ status: 429, attempt: 0, waitMs: 5000, retryAfterMs: 5000, url: "x" });
    recorder.phase("download");
    recorder.fail("item-1", "410 Gone");
    await recorder.finish();

    expect(persisted.map((state) => state.phase)).toEqual([
      "enumerate",
      "enumerate",
      "download",
      null,
    ]);
    expect(persisted[0]).toEqual({
      phase: "enumerate",
      phaseSince: "2026-01-01T00:00:00.000Z",
      throttle: null,
    });
    expect(persisted[1]?.throttle).toMatchObject({ waits: 1, until: "2026-01-01T00:00:06.000Z" });
    // The phase change keeps the throttle history; finishing clears everything persisted.
    expect(persisted[2]?.throttle?.waits).toBe(1);
    expect(persisted[3]).toEqual(IDLE_RUNTIME_STATE);
    expect(recorder.throttleTotals()).toEqual({ waits: 1, totalWaitMs: 5000 });
    expect(recorder.snapshot()).toMatchObject({ total: 3, done: 1, failed: 1, bytes: 10 });
    expect(sink.failures).toEqual([{ itemRef: "item-1", reason: "410 Gone" }]);
  });

  it("persists what a first backup knows about its size and clears it on finish (#47)", async () => {
    const persisted: BackupRuntimeState[] = [];
    const recorder = new PhaseRecorder(
      new ProgressTracker({ sink: new MemoryProgressSink(), flushIntervalMs: 0 }),
      async (state) => {
        persisted.push(state);
      },
      new RecordingLogger(),
      () => new Date(0),
    );
    recorder.phase("mail");
    recorder.firstBackup({ itemsBefore: 250, itemsTotal: 12_000 });
    recorder.phase("calendar");
    await recorder.finish();

    expect(persisted[1]).toMatchObject({
      phase: "mail",
      firstBackup: { itemsBefore: 250, itemsTotal: 12_000 },
    });
    // A later phase keeps it; the finished run has none.
    expect(persisted[2]?.firstBackup).toEqual({ itemsBefore: 250, itemsTotal: 12_000 });
    expect(persisted[3]).toEqual(IDLE_RUNTIME_STATE);
  });

  it("forwards the processed bytes and the transferred packs", async () => {
    const inner = new ProgressTracker({ sink: new MemoryProgressSink(), flushIntervalMs: 0 });
    const recorder = new PhaseRecorder(
      inner,
      async () => {},
      new RecordingLogger(),
      () => new Date(0),
    );

    recorder.advance(1, 10, 25);
    recorder.transfer(64);
    recorder.transfer(16);
    await recorder.finish();

    expect(recorder.snapshot()).toMatchObject({
      bytes: 10,
      bytesProcessed: 25,
      bytesTransferred: 80,
    });
  });

  it("logs a failed persist and keeps going", async () => {
    const logger = new RecordingLogger();
    const inner = new ProgressTracker({ sink: new MemoryProgressSink(), flushIntervalMs: 0 });
    let calls = 0;
    const recorder = new PhaseRecorder(
      inner,
      async () => {
        calls++;
        if (calls === 1) {
          throw new Error("connection reset");
        }
      },
      logger,
      () => new Date(0),
    );
    recorder.phase("enumerate");
    recorder.phase("download");
    await recorder.flush();
    expect(calls).toBe(2);
    const warnings = logger.lines.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.errorMessage).toBe("connection reset");
  });
});

describe("toStoredBackupResult", () => {
  it("keeps counts, the snapshot and the throttling totals", () => {
    const stored = toStoredBackupResult({
      result: {
        snapshotId: "snap-1",
        sequence: 4,
        objectsWritten: 12,
        objectsTotal: 900,
        bytes: 4096,
        failures: [{ itemRef: "a", reason: "b" }],
      },
      repairedCopies: 0,
      verifyJobId: null,
      throttle: { waits: 2, totalWaitMs: 7000 },
      completedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(stored).toEqual({
      snapshotId: "snap-1",
      sequence: 4,
      objectsWritten: 12,
      objectsTotal: 900,
      bytes: 4096,
      failures: 1,
      repairedCopies: 0,
      verifyJobId: null,
      throttleWaits: 2,
      throttleWaitMs: 7000,
      completedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("counts the failures an earlier attempt reported for parts a resume skipped", () => {
    const stored = toStoredBackupResult({
      result: {
        snapshotId: "snap-1",
        sequence: 4,
        objectsWritten: 12,
        objectsTotal: 900,
        bytes: 4096,
        failures: [{ itemRef: "a", reason: "b" }],
        failuresFromEarlierAttempts: 30,
      },
      repairedCopies: 0,
      verifyJobId: null,
      throttle: { waits: 0, totalWaitMs: 0 },
      completedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(stored.failures).toBe(31);
  });

  it("keeps the chunk writer's numbers for the compression and deduplication signals", () => {
    const chunkStats = {
      bytesIn: 9000,
      bytesNew: 4096,
      bytesSampled: 4096,
      bytesSampledCompressed: 900,
    };
    const stored = toStoredBackupResult({
      result: {
        snapshotId: "snap-1",
        sequence: 4,
        objectsWritten: 12,
        objectsTotal: 900,
        bytes: 4096,
        failures: [],
        chunkStats,
      },
      repairedCopies: 0,
      verifyJobId: null,
      throttle: { waits: 0, totalWaitMs: 0 },
      completedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(stored.chunkStats).toEqual(chunkStats);
  });

  it("keeps the activity report of an engine that sends one, for the ransomware judgement", () => {
    const activity = {
      v: 1,
      added: 3,
      modified: 1,
      removed: 0,
      renamed: 0,
      extensions: [],
      names: [],
      entropy: [],
      truncated: false,
    };
    const stored = toStoredBackupResult({
      result: {
        snapshotId: "snap-2",
        sequence: 5,
        objectsWritten: 4,
        objectsTotal: 900,
        bytes: 10,
        failures: [],
        activity,
      },
      repairedCopies: 0,
      verifyJobId: null,
      throttle: { waits: 0, totalWaitMs: 0 },
      completedAt: new Date(Date.UTC(2026, 0, 2)),
    });
    expect(stored.activity).toEqual(activity);
  });
});

describe("ensureManifestOnCopies", () => {
  it("writes the manifest to copies that miss it and leaves complete copies alone", async () => {
    const primary = new MemoryStorage();
    const complete = new MemoryStorage();
    const incomplete = new MemoryStorage();
    const key = `tenants/${TENANT}/manifests/snap.json.zst`;
    await primary.put(key, Buffer.from("manifest"));
    await complete.put(key, Buffer.from("manifest"));

    const repaired = await ensureManifestOnCopies(
      { primary, copies: [complete, incomplete] },
      key,
      new RecordingLogger(),
    );
    expect(repaired).toBe(1);
    expect((await incomplete.get(key)).toString()).toBe("manifest");
  });

  it("does nothing without copy targets", async () => {
    const primary = new MemoryStorage();
    expect(await ensureManifestOnCopies({ primary, copies: [] }, "x", new RecordingLogger())).toBe(
      0,
    );
  });
});

describe("IMAP account resolution", () => {
  const account: ProtectedObjectRef = {
    ...mailbox,
    kind: "imap",
    externalId: "bob@example.org",
  };

  it("takes server and credential from the source and the login from the object (shared, default)", () => {
    expect(imapAccountFor(imapSource(), account, null)).toEqual({
      host: "imap.example.org",
      port: 993,
      security: "tls",
      username: "bob@example.org",
      authKind: "password",
      secretId: SECRET,
      allowPrivateNetwork: false,
    });
    expect(
      imapAccountFor(imapSource({ config: { authKind: "oauth2" } }), account, null).authKind,
    ).toBe("oauth2");
    expect(imapAccountFor(imapSource({ config: {} }), account, null).authKind).toBe("password");
    // No imapAuthMode at all (a source saved before this mode existed) behaves the same
    // as an explicit "shared" (regression test for the pre-0.303 config shape).
    expect(imapAccountFor(imapSource({ config: { authKind: "password" } }), account, null)).toEqual(
      imapAccountFor(
        imapSource({ config: { authKind: "password", imapAuthMode: "shared" } }),
        account,
        null,
      ),
    );
  });

  it("lets a host reach private networks only by operator decision", () => {
    const approved = imapSource({
      config: {
        privateNetworkApproval: { by: "provider@example.org", at: "2026-09-01T00:00:00Z" },
      },
    });
    expect(imapAccountFor(imapSource(), account, null, {}).allowPrivateNetwork).toBe(false);
    expect(imapAccountFor(approved, account, null, {}).allowPrivateNetwork).toBe(true);
    expect(
      imapAccountFor(imapSource(), account, null, { IMAP_ALLOW_PRIVATE_NETWORKS: "true" })
        .allowPrivateNetwork,
    ).toBe(true);
  });

  it("refuses sources that cannot connect, without retry", () => {
    expect(() => imapAccountFor(m365Source(), account, null)).toThrow(InvalidPayloadError);
    expect(() => imapAccountFor(imapSource({ host: null }), account, null)).toThrow(
      /no server configured/,
    );
    expect(() => imapAccountFor(imapSource({ secretRef: null }), account, null)).toThrow(
      /no stored credential/,
    );
  });

  it("per_mailbox: uses the object's own sealed secret, login is still the object's external id", () => {
    const source = imapSource({ secretRef: null, config: { imapAuthMode: "per_mailbox" } });
    const OBJECT_SECRET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(imapAccountFor(source, account, OBJECT_SECRET)).toEqual({
      host: "imap.example.org",
      port: 993,
      security: "tls",
      username: "bob@example.org",
      authKind: "password",
      secretId: OBJECT_SECRET,
      allowPrivateNetwork: false,
    });
  });

  it("per_mailbox: fails the object with a clear, non-secret cause when it has no password", () => {
    const source = imapSource({ secretRef: null, config: { imapAuthMode: "per_mailbox" } });
    expect(() => imapAccountFor(source, account, null)).toThrow(
      /"bob@example.org".*no password set/,
    );
  });

  it("master_user: dovecot_separator folds the mailbox into the master login", () => {
    const source = imapSource({
      config: {
        imapAuthMode: "master_user",
        masterUser: { username: "master", style: "dovecot_separator" },
      },
    });
    expect(imapAccountFor(source, account, null)).toEqual({
      host: "imap.example.org",
      port: 993,
      security: "tls",
      username: "master*bob@example.org",
      authKind: "password",
      secretId: SECRET,
      allowPrivateNetwork: false,
    });
  });

  it("master_user: dovecot_separator honours a custom separator", () => {
    const source = imapSource({
      config: {
        imapAuthMode: "master_user",
        masterUser: { username: "master", style: "dovecot_separator", separator: "%" },
      },
    });
    expect(imapAccountFor(source, account, null).username).toBe("master%bob@example.org");
  });

  it("master_user: sasl_authzid keeps the master login and carries the mailbox as authzid", () => {
    const source = imapSource({
      config: {
        imapAuthMode: "master_user",
        masterUser: { username: "master", style: "sasl_authzid" },
      },
    });
    expect(imapAccountFor(source, account, null)).toEqual({
      host: "imap.example.org",
      port: 993,
      security: "tls",
      username: "master",
      authzid: "bob@example.org",
      authKind: "password",
      secretId: SECRET,
      allowPrivateNetwork: false,
    });
  });

  it("master_user: refuses a source with no master credential or no master user configured", () => {
    expect(() =>
      imapAccountFor(
        imapSource({ secretRef: null, config: { imapAuthMode: "master_user" } }),
        account,
        null,
      ),
    ).toThrow(/no master credential/);
    expect(() =>
      imapAccountFor(imapSource({ config: { imapAuthMode: "master_user" } }), account, null),
    ).toThrow(/no master user configured/);
  });
});

describe("Graph client per source", () => {
  const env = { ENTRA_CLIENT_ID: "app-id", ENTRA_CLIENT_SECRET: "env-secret" };
  const key = deriveInstallationSecretsKey(randomBytes(32));

  /** A registration saved under Settings → Microsoft 365, sealed as the API seals it. */
  function saved(clientSecret: string, updatedAt: string): StoredEntraAppRow {
    const id = randomUUID();
    const document = serializeEntraAppDocument({
      clientId: "saved-app-id",
      credentialKind: "secret",
      clientSecret,
      secretExpiresAt: null,
      homeTenantId: null,
      authorityHost: null,
      updatedAt,
      updatedBy: "admin@provider.test",
    });
    return { id, ciphertext: sealSecret(key, id, document), updatedAt };
  }

  /** The worker's resolver over a given environment and saved registration. */
  function entraApp(
    options: {
      env?: Record<string, string>;
      stored?: () => StoredEntraAppRow | null;
      readTextFile?: (path: string) => Promise<string>;
      now?: () => number;
    } = {},
  ): EntraAppResolver {
    return new EntraAppResolver({
      environment: entraAppEnvironmentFrom(options.env ?? {}),
      loadStored: async () => options.stored?.() ?? null,
      installationKey: () => key,
      readTextFile: options.readTextFile,
      now: options.now,
    });
  }

  it("prefers the source's own secret over the app's credential", async () => {
    const ctx = workerContext(storage(), { secrets: { [SECRET]: "source-secret" } });
    const settings = { entraApp: entraApp({ env }) };
    const fromSource = await appCredentialsForSource(
      { ctx, source: m365Source({ secretRef: SECRET }) },
      settings,
    );
    expect(fromSource).toEqual({
      clientId: "app-id",
      credential: { type: "secret", clientSecret: "source-secret" },
    });
    const fromEnv = await appCredentialsForSource({ ctx, source: m365Source() }, settings);
    expect(fromEnv.credential).toEqual({ type: "secret", clientSecret: "env-secret" });

    // A lone ENTRA_CLIENT_ID still names the app for a source's own secret.
    const lone = await appCredentialsForSource(
      { ctx, source: m365Source({ secretRef: SECRET }) },
      { entraApp: entraApp({ env: { ENTRA_CLIENT_ID: "app-id" } }) },
    );
    expect(lone.clientId).toBe("app-id");
  });

  it("reads the certificate when no secret is configured", async () => {
    const ctx = workerContext(storage());
    const read: string[] = [];
    const credentials = await appCredentialsForSource(
      { ctx, source: m365Source() },
      {
        entraApp: entraApp({
          env: { ENTRA_CLIENT_ID: "app-id", ENTRA_CLIENT_CERT_PATH: "/run/secrets/entra.pem" },
          readTextFile: async (path) => {
            read.push(path);
            return TEST_PEM;
          },
        }),
      },
    );
    expect(read).toEqual(["/run/secrets/entra.pem"]);
    expect(credentials.credential.type).toBe("certificate");
  });

  it("uses the registration saved in the web UI and follows a change without a restart", async () => {
    const ctx = workerContext(storage());
    let now = 0;
    let stored = saved("first-secret", "2026-09-20T08:00:00.000Z");
    const settings = { entraApp: entraApp({ stored: () => stored, now: () => now }) };
    const first = await appCredentialsForSource({ ctx, source: m365Source() }, settings);
    expect(first).toEqual({
      clientId: "saved-app-id",
      credential: { type: "secret", clientSecret: "first-secret" },
    });

    stored = saved("rotated-secret", "2026-09-21T08:00:00.000Z");
    now += 31_000;
    const second = await appCredentialsForSource({ ctx, source: m365Source() }, settings);
    expect(second.credential).toEqual({ type: "secret", clientSecret: "rotated-secret" });

    // A rotated credential never reuses a token provider of the old one.
    const tokens = new TokenProviderCache();
    expect(tokens.get(ENTRA_TENANT, second)).not.toBe(tokens.get(ENTRA_TENANT, first));
    expect(tokens.size).toBe(2);
  });

  it("lets the environment win over the saved registration", async () => {
    const ctx = workerContext(storage());
    const credentials = await appCredentialsForSource(
      { ctx, source: m365Source() },
      { entraApp: entraApp({ env, stored: () => saved("saved-secret", "2026-09-20") }) },
    );
    expect(credentials.clientId).toBe("app-id");
  });

  it("explains missing app credentials in operator terms, without retry", async () => {
    const ctx = workerContext(storage());
    const none = appCredentialsForSource({ ctx, source: m365Source() }, { entraApp: entraApp() });
    await expect(none).rejects.toThrow(/No Microsoft 365 app registration is configured/);
    await expect(none).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(
      appCredentialsForSource(
        { ctx, source: m365Source() },
        {
          entraApp: entraApp({
            env: { ENTRA_CLIENT_ID: "a", ENTRA_CLIENT_CERT_PATH: "/missing.pem" },
            readTextFile: async () => {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            },
          }),
        },
      ),
    ).rejects.toThrow("ENTRA_CLIENT_CERT_PATH could not be read (ENOENT).");
  });

  it("refuses a source without consent and shares token providers across jobs", async () => {
    const ctx = workerContext(storage());
    const tokens = new TokenProviderCache();
    const settings = { env, entraApp: entraApp({ env }), tokens };
    await expect(
      graphClientForSource(depsFor(ctx, m365Source({ entraTenantId: null })), settings),
    ).rejects.toThrow(/admin consent is outstanding/);

    const first = await graphClientForSource(depsFor(ctx, m365Source()), settings);
    const second = await graphClientForSource(depsFor(ctx, m365Source()), settings);
    expect(first).toBeInstanceOf(FetchGraphClient);
    expect(second).not.toBe(first);
    expect(tokens.size).toBe(1);
    await graphClientForSource(
      depsFor(ctx, m365Source({ entraTenantId: "99999999-2222-4333-8444-555555555555" })),
      settings,
    );
    expect(tokens.size).toBe(2);
  });

  it("evicts the oldest token provider beyond its limit", () => {
    const tokens = new TokenProviderCache(2);
    const app = {
      clientId: "a",
      credential: { type: "secret" as const, clientSecret: "do-not-leak" },
    };
    const first = tokens.get("t1", app);
    tokens.get("t2", app);
    tokens.get("t3", app);
    expect(tokens.size).toBe(2);
    expect(tokens.get("t1", app)).not.toBe(first);
    expect(TokenProviderCache.keyOf("t1", app)).not.toContain("do-not-leak");
  });
});

describe("enqueueVerifyAfterBackup", () => {
  it("skips without a verify schedule", async () => {
    const { store, queued } = fakeStore({ verifyScheduled: false });
    const sent: string[] = [];
    const result = await enqueueVerifyAfterBackup({
      store,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      send: async (queue) => {
        sent.push(queue);
        return "boss-1";
      },
      logger: new RecordingLogger(),
    });
    expect(result).toBeNull();
    expect(sent).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("sends a verify with priority and singleton key and records the queued row", async () => {
    const { store, queued } = fakeStore({ verifyScheduled: true });
    const sent: unknown[] = [];
    const jobId = await enqueueVerifyAfterBackup({
      store,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      send: async (queue, payload, options) => {
        sent.push({ queue, payload, options });
        return "boss-1";
      },
      logger: new RecordingLogger(),
      jobIdGenerator: () => JOB,
    });
    const payload = {
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      kind: "verify",
      sampleSize: 20,
      scheduleId: VERIFY_SCHEDULE,
      afterBackup: true,
    };
    expect(jobId).toBe(JOB);
    expect(sent).toEqual([
      { queue: "verify", payload, options: { priority: 80, singletonKey: `verify:${OBJECT}` } },
    ]);
    expect(queued).toEqual([
      { jobId: JOB, queue: "verify", protectedObjectId: OBJECT, payload, pgBossJobId: "boss-1" },
    ]);
  });

  it("names the backup job that asked for the check, and prefers it to a schedule", async () => {
    const BACKUP_JOB = "7b1f0f0e-0000-4000-8000-0000000000aa";
    const { store, queued } = fakeStore({ verifyScheduled: true, verifyJobId: BACKUP_JOB });
    const sent: unknown[] = [];
    await enqueueVerifyAfterBackup({
      store,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      send: async (queue, payload) => {
        sent.push({ queue, payload });
        return "boss-1";
      },
      logger: new RecordingLogger(),
      jobIdGenerator: () => JOB,
    });
    expect(queued[0]?.payload).toEqual({
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      kind: "verify",
      sampleSize: 20,
      backupJobId: BACKUP_JOB,
      afterBackup: true,
    });
  });

  it("records nothing when pg-boss reports the verify as already queued", async () => {
    const { store, queued } = fakeStore({ verifyScheduled: true });
    const jobId = await enqueueVerifyAfterBackup({
      store,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      send: async () => null,
      logger: new RecordingLogger(),
    });
    expect(jobId).toBeNull();
    expect(queued).toEqual([]);
  });
});

describe("backup handler", () => {
  const manifestKey = `tenants/${TENANT}/manifests/snap-1.json.zst`;

  /** An engine that behaves like a real one: records a snapshot, commits a manifest, reports phases. */
  function committingEngine(
    deps: BackupEngineDeps,
    storageTarget: MemoryStorage,
    options: { reportFailures?: boolean } = {},
  ): BackupEngine<Database> {
    return engine("mailbox", async (engineCtx, object, backupOptions) => {
      engineCtx.progress.phase("enumerate");
      engineCtx.progress.total(2);
      const record = await engineCtx.snapshots.create({
        id: "snap-1",
        protectedObjectId: object.id,
        jobId: engineCtx.jobId,
        sequence: 1,
        startedAt: engineCtx.now(),
      });
      deps.throttled({ status: 429, attempt: 0, waitMs: 2000, retryAfterMs: 2000, url: "x" });
      engineCtx.progress.phase("download");
      engineCtx.progress.advance(1, 100);
      if (options.reportFailures !== false) {
        engineCtx.progress.fail("mail-2", "404 Not Found");
      }
      await storageTarget.put(manifestKey, Buffer.from("manifest"));
      await engineCtx.snapshots.complete(record.id, {
        manifestPath: manifestKey,
        itemCount: 1,
        byteSize: 100,
        completedAt: engineCtx.now(),
      });
      const result: BackupResult = {
        snapshotId: record.id,
        sequence: 1,
        objectsWritten: 1,
        objectsTotal: 1,
        bytes: 100,
        failures: [{ itemRef: "mail-2", reason: "404 Not Found" }],
      };
      expect(backupOptions.full).toBe(true);
      return result;
    });
  }

  it("runs the engine for the object's kind, checks the manifest, heals copies, enqueues verify and stores the result", async () => {
    const primary = new MemoryStorage();
    const copy = new MemoryStorage();
    const ctx = workerContext({ primary, copies: [copy] });
    const { store, runtime, results, queued } = fakeStore({ verifyScheduled: true });
    const seen: BackupEngineDeps[] = [];
    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([
        [
          "mailbox",
          (deps) => {
            seen.push(deps);
            return committingEngine(deps, primary);
          },
        ],
      ]),
      store: () => store,
      send: async () => "boss-verify",
    });

    const outcome = await handler.run(ctx, {
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      full: true,
    });

    expect(seen[0]?.source.id).toBe(SOURCE);
    expect(outcome?.summary).toMatchObject({
      snapshotId: "snap-1",
      sequence: 1,
      objectsWritten: 1,
      bytes: 100,
      failures: 1,
      repairedCopies: 1,
      throttleWaits: 1,
      throttleWaitMs: 2000,
    });
    expect(typeof outcome?.summary?.verifyJobId).toBe("string");
    expect(results).toHaveLength(1);
    expect(results[0]?.verifyJobId).toBe(queued[0]?.jobId);
    expect((await copy.get(manifestKey)).toString()).toBe("manifest");
    expect(runtime.map((state) => state.phase)).toEqual([
      "starting",
      "enumerate",
      "enumerate",
      "download",
      null,
    ]);
    expect(runtime.at(-1)).toEqual(IDLE_RUNTIME_STATE);
    expect(ctx.progress.snapshot()).toMatchObject({ total: 2, done: 1, failed: 1, bytes: 100 });
  });

  it("records failures an engine only returned", async () => {
    const primary = new MemoryStorage();
    const ctx = workerContext({ primary, copies: [] });
    const { store } = fakeStore();
    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([
        ["mailbox", (deps) => committingEngine(deps, primary, { reportFailures: false })],
      ]),
      store: () => store,
    });
    await handler.run(ctx, { jobId: JOB, tenantId: TENANT, protectedObjectId: OBJECT, full: true });
    expect(ctx.progress.snapshot().failed).toBe(1);
  });

  it("rejects an excluded object before building the engine", async () => {
    const ctx = workerContext(storage());
    let built = false;
    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([
        [
          "mailbox",
          () => {
            built = true;
            return engine("mailbox");
          },
        ],
      ]),
      store: () => fakeStore({ objectStatus: "excluded" }).store,
    });
    await expect(
      handler.run(ctx, { jobId: JOB, tenantId: TENANT, protectedObjectId: OBJECT }),
    ).rejects.toThrow(InvalidPayloadError);
    expect(built).toBe(false);
  });

  it("rejects a kind without an engine", async () => {
    const ctx = workerContext(storage());
    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([["onedrive", () => engine("onedrive")]]),
      store: () => fakeStore().store,
    });
    await expect(
      handler.run(ctx, { jobId: JOB, tenantId: TENANT, protectedObjectId: OBJECT }),
    ).rejects.toThrow(/kind "mailbox"/);
  });

  it("fails when the engine returns a snapshot without a committed manifest", async () => {
    const ctx = workerContext(storage());
    const { store, runtime, results } = fakeStore();
    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([
        [
          "mailbox",
          () =>
            engine("mailbox", async (engineCtx, object) => {
              await engineCtx.snapshots.create({
                id: "snap-x",
                protectedObjectId: object.id,
                jobId: engineCtx.jobId,
                sequence: 1,
                startedAt: engineCtx.now(),
              });
              return {
                snapshotId: "snap-x",
                sequence: 1,
                objectsWritten: 0,
                objectsTotal: 0,
                bytes: 0,
                failures: [],
              };
            }),
        ],
      ]),
      store: () => store,
    });
    await expect(
      handler.run(ctx, { jobId: JOB, tenantId: TENANT, protectedObjectId: OBJECT }),
    ).rejects.toThrow(/without a committed manifest/);
    expect(runtime.at(-1)).toEqual(IDLE_RUNTIME_STATE);
    expect(results).toEqual([]);
  });

  it("clears the runtime state when the engine throws", async () => {
    const ctx = workerContext(storage());
    const { store, runtime } = fakeStore();
    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([
        [
          "mailbox",
          (deps) =>
            engine("mailbox", async (engineCtx) => {
              engineCtx.progress.phase("download");
              deps.throttled({
                status: 503,
                attempt: 4,
                waitMs: 60_000,
                retryAfterMs: null,
                url: "x",
              });
              throw new Error("Graph 503");
            }),
        ],
      ]),
      store: () => store,
    });
    await expect(
      handler.run(ctx, { jobId: JOB, tenantId: TENANT, protectedObjectId: OBJECT }),
    ).rejects.toThrow("Graph 503");
    expect(runtime.map((state) => state.phase)).toEqual(["starting", "download", "download", null]);
    expect(runtime.at(-1)).toEqual(IDLE_RUNTIME_STATE);
  });
});

describe("disabled and unlicensed mailboxes", () => {
  const graphError = (status: number, code: string) =>
    new GraphError({
      status,
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/users/u/mailFolders/delta",
      payload: { error: { code, message: "x" } },
    });

  function failingHandler(
    error: unknown,
    check: (() => Promise<"account_disabled" | "no_license" | "locked" | null>) | null,
    store = fakeStore(),
  ) {
    const engines = new BackupEngineRegistry([
      [
        "mailbox",
        () =>
          engine("mailbox", async () => {
            throw error;
          }),
      ],
    ]);
    const calls: string[] = [];
    engines.inactiveCheck = check
      ? async (_deps, object) => {
          calls.push(object.externalId);
          return check();
        }
      : null;
    return { handler: createBackupHandler({ engines, store: () => store.store }), store, calls };
  }

  const run = (handler: ReturnType<typeof createBackupHandler>) =>
    handler.run(workerContext(storage()), {
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
    });

  it("marks a confirmed inactive mailbox and ends the run neutral, with the original details", async () => {
    const { handler, store, calls } = failingHandler(
      graphError(404, "MailboxNotEnabledForRESTAPI"),
      async () => "account_disabled",
    );
    const error = await run(handler).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidPayloadError);
    const failure = (error as InvalidPayloadError).failure;
    expect(failure?.code).toBe("graph.mailbox_inactive");
    expect(failure?.params).toMatchObject({
      reason: "account_disabled",
      httpStatus: 404,
      graphCode: "MailboxNotEnabledForRESTAPI",
    });
    expect(failure?.technical.errorCode).toBe("MailboxNotEnabledForRESTAPI");
    expect(calls).toHaveLength(1);
    expect(store.markedInactive).toEqual([{ id: OBJECT, reason: "account_disabled" }]);
  });

  it("reads through the engine's mailbox access wrapper", async () => {
    const inner = graphError(404, "MailboxNotEnabledForRESTAPI");
    const wrapped = new MailboxAccessError("cannot read folders", {
      status: 404,
      code: "MailboxNotEnabledForRESTAPI",
      cause: inner,
    });
    const { handler } = failingHandler(wrapped, async () => "no_license");
    const error = await run(handler).catch((caught: unknown) => caught);
    expect((error as InvalidPayloadError).failure?.code).toBe("graph.mailbox_inactive");
  });

  it("keeps the failure when Microsoft does not confirm, and never checks a permission problem", async () => {
    const original = graphError(404, "MailboxNotEnabledForRESTAPI");
    const unconfirmed = failingHandler(original, async () => null);
    await expect(run(unconfirmed.handler)).rejects.toBe(original);
    expect(unconfirmed.store.markedInactive).toEqual([]);

    const denied = graphError(403, "ErrorAccessDenied");
    const forbidden = failingHandler(denied, async () => "account_disabled");
    await expect(run(forbidden.handler)).rejects.toBe(denied);
    expect(forbidden.calls).toEqual([]);

    const broken = failingHandler(original, async () => {
      throw new Error("token endpoint down");
    });
    await expect(run(broken.handler)).rejects.toBe(original);
  });

  it("checks only causes that may mean an inactive account", () => {
    const cause = (code: string, httpStatus: number) =>
      ({ code, transient: false, params: { httpStatus }, technical: {} }) as Parameters<
        typeof mayBeInactiveMailbox
      >[0];
    expect(mayBeInactiveMailbox(cause("graph.mailbox_not_licensed", 404))).toBe(true);
    expect(mayBeInactiveMailbox(cause("graph.user_not_found", 404))).toBe(true);
    expect(mayBeInactiveMailbox(cause("graph.request_rejected", 400))).toBe(true);
    expect(mayBeInactiveMailbox(cause("graph.request_rejected", 404))).toBe(true);
    expect(mayBeInactiveMailbox(cause("graph.request_rejected", 409))).toBe(false);
    expect(mayBeInactiveMailbox(cause("graph.access_denied", 403))).toBe(false);
    expect(mayBeInactiveMailbox(cause("graph.permission_missing", 403))).toBe(false);
    expect(mayBeInactiveMailbox(cause("graph.token_rejected", 401))).toBe(false);
  });

  it("turns away a mailbox already marked inactive with the neutral cause", async () => {
    const ok = {
      objectKind: "mailbox",
      objectStatus: "orphaned",
      sourceKind: "m365",
      sourceStatus: "active",
    } as const;
    expect(backupRejection({ ...ok, objectStatusReason: "account_disabled" })).toMatch(
      /account is disabled/,
    );
    expect(backupRejection({ ...ok, objectStatusReason: "no_license" })).toMatch(/licence/);
    expect(backupRejectionCode({ ...ok, objectStatusReason: "no_license" })).toBe(
      "config.object_inactive",
    );
    expect(backupRejectionCode(ok)).toBe("config.object_orphaned");

    const handler = createBackupHandler({
      engines: new BackupEngineRegistry([["mailbox", () => engine("mailbox")]]),
      store: () => fakeStore({ objectStatus: "orphaned", objectStatusReason: "no_license" }).store,
    });
    const error = await run(handler).catch((caught: unknown) => caught);
    expect((error as InvalidPayloadError).failure).toMatchObject({
      code: "config.object_inactive",
      params: { reason: "no_license" },
    });
  });
});

describe("a OneDrive or site Microsoft locked (HTTP 423)", () => {
  const drive: ProtectedObjectRef = {
    ...mailbox,
    kind: "onedrive",
    externalId: "b!drive-1",
    displayName: "Alice OneDrive",
  };
  // The production answer for the OneDrive of a departed, unlicensed user.
  const locked = new GraphError({
    status: 423,
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/drives/b!drive-1/root/delta",
    payload: {
      error: {
        code: "notAllowed",
        message:
          "Access to this site has been blocked. Please contact the administrator to resolve this problem.",
        innerError: { code: "resourceLocked" },
      },
    },
  });

  function lockedHandler(error: unknown, check: (() => Promise<boolean | null>) | null) {
    const store = fakeStore();
    const engines = new BackupEngineRegistry([
      [
        "onedrive",
        () =>
          engine("onedrive", async () => {
            throw error;
          }),
      ],
    ]);
    const calls: string[] = [];
    engines.lockCheck = check
      ? async (_deps, object) => {
          calls.push(object.externalId);
          return check();
        }
      : null;
    return { handler: createBackupHandler({ engines, store: () => store.store }), store, calls };
  }

  const run = (handler: ReturnType<typeof createBackupHandler>) =>
    handler.run(workerContext(storage(), { object: drive }), {
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
    });

  it("marks a confirmed lock and ends the run final and neutral, with the original details", async () => {
    const { handler, store, calls } = lockedHandler(locked, async () => true);
    const error = await run(handler).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidPayloadError);
    const failure = (error as InvalidPayloadError).failure;
    expect(failure?.code).toBe("graph.object_locked");
    expect(failure?.params).toMatchObject({ reason: "locked", httpStatus: 423 });
    expect(failure?.technical.innerErrorCode).toBe("resourceLocked");
    expect(calls).toEqual(["b!drive-1"]);
    expect(store.markedInactive).toEqual([{ id: OBJECT, reason: "locked" }]);
  });

  it("ends a lock the probe does not confirm as a counted failure, never neutral", async () => {
    // Probe 200 (false), 503/429/403 (null: cannot tell), a thrown check, no check at all.
    const handlers = [
      lockedHandler(locked, async () => false),
      lockedHandler(locked, async () => null),
      lockedHandler(locked, async () => {
        throw new Error("token endpoint down");
      }),
      lockedHandler(locked, null),
    ];
    for (const { handler, store } of handlers) {
      const error = await run(handler).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InvalidPayloadError);
      const failure = (error as InvalidPayloadError).failure;
      expect(failure?.code).toBe("graph.request_rejected");
      expect(isNotBackedUpCause(failure?.code)).toBe(false);
      expect(isNotBackedUpFailure("failed", failure)).toBe(false);
      expect(failure?.params).toMatchObject({ httpStatus: 423 });
      expect(failure?.params.reason).toBeUndefined();
      expect(failure?.technical.innerErrorCode).toBe("resourceLocked");
      expect(store.markedInactive).toEqual([]);
    }
  });

  it("never checks another failure of a OneDrive", async () => {
    const denied = new GraphError({
      status: 403,
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/drives/b!drive-1/root/delta",
      payload: { error: { code: "accessDenied", message: "x" } },
    });
    const { handler, calls } = lockedHandler(denied, async () => true);
    await expect(run(handler)).rejects.toBe(denied);
    expect(calls).toEqual([]);
  });

  it("turns away an object already marked locked with the neutral cause", async () => {
    const ok = {
      objectKind: "onedrive",
      objectStatus: "orphaned",
      objectStatusReason: "locked",
      sourceKind: "m365",
      sourceStatus: "active",
    } as const;
    expect(backupRejection(ok)).toMatch(/locked/);
    expect(backupRejectionCode(ok)).toBe("config.object_inactive");
  });
});
