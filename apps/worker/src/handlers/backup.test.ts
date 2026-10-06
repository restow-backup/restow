import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  type BackupEngine,
  type BackupResult,
  EntraAppResolver,
  ExchangeBackupEngine,
  FetchGraphClient,
  type HeadResult,
  ImapBackupEngine,
  Keyring,
  type Logger,
  MemoryProgressSink,
  OneDriveBackupEngine,
  ProgressTracker,
  type ProtectedObjectRef,
  type StorageBackend,
  type StorageTargets,
  type StoredEntraAppRow,
  createMemoryJobContext,
  deriveInstallationSecretsKey,
  entraAppEnvironmentFrom,
  generateDek,
  sealSecret,
  serializeEntraAppDocument,
} from "@restow/core";
import type { Database, Source } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  type BackupEngineDeps,
  BackupEngineRegistry,
  type BackupRuntimeState,
  type BackupStore,
  IDLE_RUNTIME_STATE,
  PhaseRecorder,
  type StoredBackupResult,
  TokenProviderCache,
  appCredentialsForSource,
  backupRejection,
  createBackupHandler,
  createDefaultBackupEngines,
  enqueueVerifyAfterBackup,
  ensureManifestOnCopies,
  graphClientForSource,
  imapAccountFor,
  selectBackupEngine,
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
  const store: BackupStore = {
    async loadSource() {
      return {
        objectStatus: options.objectStatus ?? "active",
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
  };
  return { store, runtime, results, queued, replacedSecrets };
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
    expect(registry.kinds().sort()).toEqual(["imap", "mailbox", "onedrive"]);
    const ctx = workerContext(storage());
    expect(registry.get("mailbox")?.(depsFor(ctx, m365Source()))).toBeInstanceOf(
      ExchangeBackupEngine,
    );
    expect(registry.get("onedrive")?.(depsFor(ctx, m365Source()))).toBeInstanceOf(
      OneDriveBackupEngine,
    );
    expect(registry.get("imap")?.(depsFor(ctx, imapSource()))).toBeInstanceOf(ImapBackupEngine);
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
