import { pathToFileURL } from "node:url";
/**
 * @restow/worker — the pg-boss worker process (Docker CMD role: worker).
 *
 * Boots the shared runtime (Postgres, storage targets, key provider), creates
 * every Restow queue with its policy, registers the handlers listed in
 * ./handlers/index.ts and runs them through the framework. Next to the queue
 * workers it runs the webhook dispatcher (signed deliveries with retries) and
 * the nightly audit anchor. Shutdown is graceful: running jobs get an abort
 * signal, checkpoint, and are retried by pg-boss on another worker; nothing is
 * lost and nothing is loaded twice.
 *
 * Two database pools (packages/db/src/roles.ts): every job runs on the
 * application pool (DATABASE_URL), inside transactions pinned to its tenant, so
 * Row Level Security holds; the installation pool (DATABASE_PROVIDER_URL)
 * serves pg-boss and the scans that span tenants (webhook deliveries, the
 * audit anchor). The process refuses to start when the application pool could
 * bypass Row Level Security.
 *
 * Environment (see .env.example):
 *   DATABASE_URL                 required, the application role (subject to RLS)
 *   DATABASE_PROVIDER_URL        required, the installation role (BYPASSRLS)
 *   RESTOW_MASTER_KEY            required, base64 32-byte KEK (EnvKeyProvider)
 *   STORAGE_TARGET               local | s3 (default local); the installation default unless one
 *                                is saved under Installation, Default storage (default-storage.ts)
 *   STORAGE_LOCAL_PATH           root of the local target (default /data/chunks)
 *   S3_ENDPOINT/S3_REGION/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_PREFIX
 *   S3_FORCE_PATH_STYLE          "false" for virtual-hosted buckets (default true)
 *   STORAGE_COPY_LOCAL_PATH      optional second target (a mounted NFS share)
 *   WORKER_CONCURRENCY           parallel jobs per queue in this process (default 2)
 *   WORKER_TENANT_CONCURRENCY    parallel jobs per tenant in this process (default 2)
 *   WORKER_POLL_SECONDS          pg-boss polling interval (default 2)
 *   WORKER_SHUTDOWN_TIMEOUT_MS   how long shutdown waits for jobs to checkpoint (default 30000)
 *   WORKER_CANCEL_POLL_MS        how often a running job checks for cancellation (default 15000)
 *   WORKER_PROGRESS_FLUSH_ITEMS  progress rows are written every N items (default 50)
 *   WORKER_PROGRESS_FLUSH_MS     ... or at least this often (default 2000)
 *   ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET / ENTRA_CLIENT_CERT_PATH / ENTRA_AUTHORITY_HOST
 *                                optional: the Microsoft 365 backup app (directory, backup,
 *                                restore); without them the registration saved under
 *                                Settings → Microsoft 365 is used (./entra-app.ts)
 *   IMAP_ALLOW_INSECURE          "true" permits IMAP sources without TLS (development only)
 *   IMAP_ALLOW_PRIVATE_NETWORKS  "true" lets every IMAP source reach loopback and private networks
 *   IMPORT_DIR                   the server-side mail import folder (default /var/lib/restow/import);
 *                                a tenant reads only <IMPORT_DIR>/<tenant slug>/ (docs/IMPORT.md)
 *   IMPORT_MAX_MESSAGE_BYTES     largest single message an import reads (default 256 MiB)
 *   IMPORT_PARSE_WORKERS         parser processes (MSG, message metadata) with a memory and time
 *                                limit each, 1 to 8 (default 2)
 *   EXPORT_TTL_HOURS             how long a finished export can be downloaded (default 24)
 *   EXPORT_MAX_TENANT_BYTES      bytes all export files of a tenant may take (default 50 GiB)
 *   WEBHOOK_POLL_MS              how often the dispatcher looks for due deliveries
 *   WEBHOOK_CONCURRENCY          deliveries sent in parallel by this process
 *   WEBHOOK_TIMEOUT_MS           per-request timeout of a delivery
 *   RESTOW_WEBHOOK_ALLOW_PRIVATE "true" permits webhook targets in private networks
 *   RESTOW_PUBLIC_URL            links in chat webhook messages, when Settings name no public URL
 *   RESTOW_PRODUCT_NAME          the product name chat webhook messages use (branding)
 *   LOG_LEVEL                    debug | info | warn | error (default info)
 */
import {
  EnvKeyProvider,
  type KeyProvider,
  LocalStorageBackend,
  S3StorageBackend,
  type StorageBackend,
  type StorageTargets,
  type TenantKeyring,
  createLogger,
  kekFromBase64,
  parseLogLevel,
} from "@restow/core";
import {
  ServiceHeartbeatReporter,
  assertDatabaseRoles,
  createDb,
  heartbeatStore,
  retryConcurrentSetup,
  safeErrorMessage,
} from "@restow/db";
import { PRODUCT_NAME_ENV, configureProductName } from "@restow/i18n";
import PgBoss from "pg-boss";
import { configureDefaultStorage } from "./default-storage.js";
import { registerEndpointJobs } from "./endpoints/register.js";
import { configureEntraApp } from "./entra-app.js";
import { extensionHandlers, extensionRetentionTasks } from "./extensions.js";
import { registerAuditAnchor } from "./handlers/audit-anchor.js";
import {
  HandlerRegistry,
  PgSecretReader,
  TenantCache,
  TenantConcurrencyLimiter,
  type WorkerRuntime,
  createWorkHandler,
  loadTenantKeyring,
  mirrorTenantKeys,
  resolveTenantStorage,
  tenantRunner,
  withTenantTx,
} from "./handlers/framework.js";
import { handlers } from "./handlers/index.js";
import { mailFilesCleanupTask } from "./handlers/mail-files-cleanup.js";
import { retentionTasks } from "./handlers/retention.js";
import { emitJobWebhook, webhooksHandler } from "./handlers/webhooks.js";
import { startPveMaintenance } from "./pve/maintenance.js";
import { QUEUE_NAMES, pgBossQueueOptions, queuePriority } from "./queues.js";
import { raiseJobFinished } from "./reporting.js";

type Env = Record<string, string | undefined>;

export interface WorkerConfig {
  /** The application role, subject to Row Level Security. */
  readonly databaseUrl: string;
  /** The installation role (BYPASSRLS): pg-boss and the scans across tenants. */
  readonly databaseProviderUrl: string;
  readonly masterKey: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly concurrency: number;
  readonly tenantConcurrency: number;
  readonly pollSeconds: number;
  readonly shutdownTimeoutMs: number;
  readonly cancelPollMs: number;
  readonly progressFlushEveryItems: number;
  readonly progressFlushIntervalMs: number;
  readonly storage: StorageConfig;
}

export interface StorageConfig {
  readonly target: "local" | "s3";
  readonly localPath: string;
  readonly copyLocalPath: string | undefined;
  readonly s3: {
    readonly endpoint: string | undefined;
    readonly region: string | undefined;
    readonly bucket: string | undefined;
    readonly accessKeyId: string | undefined;
    readonly secretAccessKey: string | undefined;
    readonly prefix: string | undefined;
    readonly forcePathStyle: boolean;
  };
}

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = str(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Build the configuration; throws a clear message on a missing required value. */
export function loadConfig(env: Env = process.env): WorkerConfig {
  const databaseUrl = str(env, "DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the worker process");
  }
  const databaseProviderUrl = str(env, "DATABASE_PROVIDER_URL");
  if (!databaseProviderUrl) {
    throw new Error("DATABASE_PROVIDER_URL is required for the worker process");
  }
  const masterKey = str(env, "RESTOW_MASTER_KEY");
  if (!masterKey) {
    throw new Error("RESTOW_MASTER_KEY is required for the worker process");
  }
  const target = str(env, "STORAGE_TARGET") ?? "local";
  if (target !== "local" && target !== "s3") {
    throw new Error(`STORAGE_TARGET must be "local" or "s3", got "${target}"`);
  }
  return {
    databaseUrl,
    databaseProviderUrl,
    masterKey,
    logLevel: parseLogLevel(str(env, "LOG_LEVEL")),
    concurrency: positiveInt(env, "WORKER_CONCURRENCY", 2),
    tenantConcurrency: positiveInt(env, "WORKER_TENANT_CONCURRENCY", 2),
    pollSeconds: positiveInt(env, "WORKER_POLL_SECONDS", 2),
    shutdownTimeoutMs: positiveInt(env, "WORKER_SHUTDOWN_TIMEOUT_MS", 30_000),
    cancelPollMs: positiveInt(env, "WORKER_CANCEL_POLL_MS", 15_000),
    progressFlushEveryItems: positiveInt(env, "WORKER_PROGRESS_FLUSH_ITEMS", 50),
    progressFlushIntervalMs: positiveInt(env, "WORKER_PROGRESS_FLUSH_MS", 2000),
    storage: {
      target,
      localPath: str(env, "STORAGE_LOCAL_PATH") ?? "/data/chunks",
      copyLocalPath: str(env, "STORAGE_COPY_LOCAL_PATH"),
      s3: {
        endpoint: str(env, "S3_ENDPOINT"),
        region: str(env, "S3_REGION"),
        bucket: str(env, "S3_BUCKET"),
        accessKeyId: str(env, "S3_ACCESS_KEY_ID"),
        secretAccessKey: str(env, "S3_SECRET_ACCESS_KEY"),
        prefix: str(env, "S3_PREFIX"),
        forcePathStyle: (str(env, "S3_FORCE_PATH_STYLE") ?? "true").toLowerCase() !== "false",
      },
    },
  };
}

/** The primary target plus the optional copy target, from the configuration. */
export function createStorageTargets(config: StorageConfig): StorageTargets {
  let primary: StorageBackend;
  if (config.target === "s3") {
    const { s3 } = config;
    if (!s3.bucket) {
      throw new Error("S3_BUCKET is required when STORAGE_TARGET=s3");
    }
    primary = new S3StorageBackend({
      bucket: s3.bucket,
      prefix: s3.prefix,
      clientConfig: {
        endpoint: s3.endpoint,
        region: s3.region ?? "us-east-1",
        forcePathStyle: s3.forcePathStyle,
        ...(s3.accessKeyId && s3.secretAccessKey
          ? { credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } }
          : {}),
      },
    });
  } else {
    primary = new LocalStorageBackend(config.localPath);
  }
  const copies = config.copyLocalPath ? [new LocalStorageBackend(config.copyLocalPath)] : [];
  return { primary, copies };
}

function createKeyProvider(config: WorkerConfig): KeyProvider {
  return new EnvKeyProvider(kekFromBase64(config.masterKey));
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Branding: `{appName}` in the chat messages of webhooks names the product like the api does.
  configureProductName(process.env[PRODUCT_NAME_ENV]);
  const logger = createLogger({ level: config.logLevel, fields: { component: "worker" } });
  // The Business/Service Provider modules register with the extension
  // points (extensions.ts) before anything below reads them.
  await import("./ee.js");
  const registry = new HandlerRegistry([...handlers, ...extensionHandlers()]);
  const db = createDb(config.databaseUrl);
  const providerDb = createDb(config.databaseProviderUrl);
  await assertDatabaseRoles({ tenant: db.$client, installation: providerDb.$client });
  // Staged uploads and finished exports are temporary: the retention job sweeps them.
  retentionTasks.register(mailFilesCleanupTask);
  // Retention tasks contributed by extensions, e.g. the archive deletion run
  // (ee/worker), which gets the installation pool: only the installation
  // role may delete from `archive_items` (packages/db/src/roles.ts).
  for (const task of extensionRetentionTasks({ providerDb })) {
    retentionTasks.register(task);
  }
  // The Microsoft 365 app registration: environment first, else the one saved
  // in the web UI (an installation secret, read on the installation pool).
  configureEntraApp({ providerDb, masterKey: config.masterKey });
  // The environment's default, for the start-up log; tenants resolve the default that applies
  // right now (saved under Installation, Default storage, else the environment) on every load.
  const defaultStorage = createStorageTargets(config.storage);
  const installationDefault = configureDefaultStorage({
    providerDb,
    masterKey: config.masterKey,
  });
  const keyProvider = createKeyProvider(config);
  const shutdown = new AbortController();

  const keyrings = new TenantCache<TenantKeyring>((tenantId) =>
    loadTenantKeyring({ db, tenantId, keyProvider }),
  );
  // A tenant's targets come from `storage_targets` (falling back to the
  // installation default, default-storage.ts); resolving them also mirrors the wrapped DEKs so
  // every target is self-sufficient for a standalone restore.
  const storage = new TenantCache<StorageTargets>(async (tenantId) => {
    const run = tenantRunner(db, tenantId);
    const keys = await keyrings.get(tenantId);
    const tenantLogger = logger.child({ tenantId });
    const targets = await resolveTenantStorage({
      run,
      tenantId,
      secretReader: new PgSecretReader(run, tenantId, keys),
      defaults: () => installationDefault.current(),
      logger: tenantLogger,
    });
    await mirrorTenantKeys({ run, tenantId, storage: targets, logger: tenantLogger });
    return targets;
  });

  const runtime: WorkerRuntime = {
    db,
    defaultStorage,
    defaultStorageGeneration: () => installationDefault.generation(),
    keyrings,
    storage,
    logger,
    tenantLimiter: new TenantConcurrencyLimiter(config.tenantConcurrency),
    shutdownSignal: shutdown.signal,
    now: () => new Date(),
    cancelPollMs: config.cancelPollMs,
    progress: {
      flushEveryItems: config.progressFlushEveryItems,
      flushIntervalMs: config.progressFlushIntervalMs,
    },
    // job.completed / job.failed for the tenant's webhooks (RMM tickets), and
    // the bell plus notification rules for failed jobs and finished restores.
    onJobFinished: async (tenantId, job) => {
      await emitJobWebhook(db, tenantId, job);
      await withTenantTx(db, tenantId, (tx) => raiseJobFinished(tx, tenantId, job));
    },
  };
  // Deliveries are claimed across tenants: the dispatcher runs on the installation pool.
  const webhookDispatcher = webhooksHandler.start({ ...runtime, db: providerDb });

  // pg-boss owns its schema as the installation role; jobs are enqueued by the
  // API and the scheduler on the application role, which may insert into it.
  const boss = new PgBoss({ connectionString: config.databaseProviderUrl });
  boss.on("error", (error) => {
    logger.error("pg-boss error", { errorMessage: error.message });
  });
  // The scheduler sets up the same schema and queues at the same time on a
  // fresh installation; a conflict between the two is retried, not fatal.
  const onSetupRetry = (info: { attempt: number; code: string | null; delayMs: number }) =>
    logger.info("job queue setup raced with another process, retrying", info);
  await retryConcurrentSetup(() => boss.start(), { onRetry: onSetupRetry });

  // Every queue exists with its policy before any producer or worker touches
  // it; updateQueue keeps the settings current across upgrades.
  for (const queue of QUEUE_NAMES) {
    const options = pgBossQueueOptions(queue);
    await retryConcurrentSetup(
      async () => {
        await boss.createQueue(queue, options);
        await boss.updateQueue(queue, options);
      },
      { onRetry: onSetupRetry },
    );
  }
  logger.info("worker started", {
    queues: [...QUEUE_NAMES],
    handlers: registry.queues(),
    storageTarget: config.storage.target,
    defaultCopies: defaultStorage.copies.length,
    concurrency: config.concurrency,
    tenantConcurrency: config.tenantConcurrency,
  });

  for (const handler of registry.list()) {
    const slots = handler.concurrency ?? config.concurrency;
    for (let slot = 0; slot < slots; slot++) {
      await boss.work(
        handler.queue,
        { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: config.pollSeconds },
        createWorkHandler(runtime, handler),
      );
    }
    logger.info("queue ready", {
      queue: handler.queue,
      slots,
      priority: queuePriority(handler.queue),
    });
  }
  const idle = QUEUE_NAMES.filter((queue) => !registry.get(queue));
  if (idle.length > 0) {
    logger.warn("queues without a handler in this build", { queues: idle });
  }

  // Endpoint backup (docs/AGENT.md): retention, repository checks, restore tests and the
  // alerts of servers and clients, in their own queues next to the tenant queues.
  await registerEndpointJobs(
    boss,
    { db, providerDb, runtime },
    { pollingIntervalSeconds: config.pollSeconds },
  );

  // Proxmox VE guests (docs/PVE.md): job planning, retention, verify and restore checks,
  // one pass every five minutes in one worker at a time.
  startPveMaintenance({ db, providerDb, runtime });

  // Nightly seal of every audit chain (own cron queue, one catch-up run now).
  // Every chain, the installation chain included: on the installation pool.
  await registerAuditAnchor(boss, {
    db: providerDb,
    logger: logger.child({ task: "audit-anchor" }),
  });

  // Liveness for /readyz: reported once the queues are consumed, every 30 seconds, and
  // removed again on a graceful shutdown (docs/ARCHITECTURE.md, Health).
  let stopping = false;
  const heartbeat = new ServiceHeartbeatReporter({
    store: heartbeatStore(db),
    role: "worker",
    details: () => ({ state: stopping ? "stopping" : "running", queues: registry.queues() }),
    onError: (error) => {
      logger.warn("heartbeat failed", { errorMessage: safeErrorMessage(error) });
    },
  });
  await heartbeat.start();

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("worker shutting down", { signal, timeoutMs: config.shutdownTimeoutMs });
    // Tell running jobs to checkpoint and return; pg-boss then waits for them
    // (up to the timeout) before failing whatever is still active for retry.
    shutdown.abort("shutdown");
    try {
      await heartbeat.beat();
      await boss.stop({ graceful: true, wait: true, timeout: config.shutdownTimeoutMs });
      await webhookDispatcher.stop();
      await heartbeat.stop();
      await Promise.all([db.$client.end(), providerDb.$client.end()]);
      logger.info("worker stopped", { signal });
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, (received) => {
      void stop(received);
    });
  }
}

/** True when this module is the process entrypoint (not imported by a test). */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "worker failed to start", errorMessage: message })}\n`,
    );
    process.exit(1);
  });
}
