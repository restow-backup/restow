/**
 * Health checks of the module "Databases" (docs/DATABASES.md 8), stage D2: one pass a minute, in
 * one worker at a time (advisory lock, like the PVE maintenance).
 *
 *   - **Checks of the Restow server as executor** (4.2): every enabled connection whose newest
 *     check is older than its interval (1 to 60 minutes, default 5), at most 200 per pass and 4 at
 *     once. The credentials are read from the secret store for the one check and handed to
 *     @restow/core `checkDatabaseHealthFromServer` only: the address is judged before connecting
 *     and resolved through the guarded lookup (private networks only with the installation flag or
 *     the provider admin's approval of this connection), the confirmed certificate is passed so a
 *     different one ends the check before the sign-in, and one deadline of 10 seconds closes every
 *     socket. The messages are cleaned of the credentials once more before they are stored. A
 *     PostgreSQL that turns out to be Restow's own database is refused (`db_target_is_restow`),
 *     none of its facts kept. Agents check their own connections (`db_health` tasks, apps/api).
 *   - **Evaluation** of every connection with new samples (the server's and the agents'): the state
 *     in `database_connections.health` advances, three failures in a row raise
 *     `database.unreachable` once per episode, the first good check after it
 *     `database.reachable` (@restow/core `advanceDbHealthState`), in the same transaction.
 *   - **Housekeeping** once a day: raw samples older than 14 days fold into hours, hours older than
 *     400 days go; `db_health` tasks of agents older than a day go.
 *
 * Restore mode (10): no checks with credentials while it is on; evaluation and housekeeping go on.
 * Nothing is ever logged with a credential; a log line names the connection and the code only.
 */
import {
  advanceDbHealthState,
  checkDatabaseHealthFromServer,
  DB_HEALTH_HOURLY_KEEP_DAYS,
  DB_HEALTH_RAW_KEEP_DAYS,
  DB_HEALTH_SIZES_EVERY_MS,
  type DbHealthCheckOptions,
  type DbHealthCheckTarget,
  type DbHealthJudgement,
  type DbHealthState,
  type DbProbeResult,
  databaseUrlTargets,
  formatDbAddress,
  type HostResolver,
  judgeDbHealth,
  sanitizeDbMessage,
  systemResolver,
} from "@restow/core";
import {
  compactDatabaseHealthSamples,
  type Database,
  type DatabaseConnection,
  databaseConnections,
  databaseHealthSamples,
  endpointTasks,
  type NewNotification,
  recordDatabaseHealthSample,
} from "@restow/db";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import {
  PgSecretReader,
  type TenantKeyringCache,
  tenantRunner,
  withTenantTx,
} from "../handlers/framework.js";
import type { TenantTx } from "../progress.js";
import { raiseEvents } from "../reporting.js";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The pass runs every minute; the smallest interval of a connection is one minute. */
export const DATABASE_HEALTH_PASS_MS = MINUTE_MS;
const LOCK_KEY = 0x64626831; // "dbh1"
const MAX_CHECKS_PER_PASS = 200;
const CHECK_CONCURRENCY = 4;
const MAX_EVALUATIONS_PER_PASS = 500;

interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug?(message: string, fields?: Record<string, unknown>): void;
}

export interface DatabaseHealthDeps {
  /** The application role (Row Level Security), one tenant per transaction. */
  readonly db: Database;
  /** The installation role, for the scans across tenants and the housekeeping. */
  readonly providerDb: Database;
  readonly logger: Logger;
  readonly now: () => Date;
  /** `RESTOW_DB_ALLOW_PRIVATE_NETWORKS`. */
  readonly privateNetworksAllowed: boolean;
  /** Restore mode is on: no checks with credentials (10). */
  readonly restoreModeActive: () => Promise<boolean>;
  /** The sealed user and password of a connection, opened for one check. */
  readonly readCredentials: (
    tenantId: string,
    secretId: string,
  ) => Promise<{ user: string | null; password: string | null }>;
  /** Tests: the check itself. */
  readonly check?: (
    target: DbHealthCheckTarget,
    options: DbHealthCheckOptions,
  ) => Promise<DbProbeResult>;
  /** The system identifier of Restow's own database (4.2: never the own database), the backstop. */
  readonly ownSystemIdentifier: () => Promise<string | null>;
  /**
   * Where Restow's own database listens (4.2): refused by the address a check reached, before the
   * sign-in. Throws when it cannot be told; the server's checks then wait (none runs unguarded).
   */
  readonly ownDatabaseTargets: () => Promise<{ address: string; port: number }[]>;
}

export interface DatabaseHealthSummary {
  checked: number;
  failed: number;
  /** Due checks of the server that waited: where Restow's own database is could not be told. */
  waiting: number;
  evaluated: number;
  alerts: number;
  folded: number;
  dropped: number;
}

/** The credentials reader of the worker: the tenant's keyring opens the sealed secret. */
export function workerCredentialsReader(
  db: Database,
  keyrings: TenantKeyringCache,
): DatabaseHealthDeps["readCredentials"] {
  return async (tenantId, secretId) => {
    const keys = await keyrings.get(tenantId);
    const plaintext = await new PgSecretReader(tenantRunner(db, tenantId), tenantId, keys).get(
      secretId,
    );
    if (!plaintext) {
      return { user: null, password: null };
    }
    const parsed = JSON.parse(plaintext) as { user?: string | null; password?: string | null };
    return { user: parsed.user ?? null, password: parsed.password ?? null };
  };
}

/**
 * Where Restow's own database listens, from the worker's own database URLs (as the API reads its
 * own, @restow/core `databaseUrlTargets`); kept five minutes, a failure is not kept.
 */
export function ownDatabaseTargetsOf(
  urls: readonly string[],
  resolve?: HostResolver,
): () => Promise<{ address: string; port: number }[]> {
  let kept: { at: number; targets: { address: string; port: number }[] } | null = null;
  return async () => {
    if (kept && Date.now() - kept.at <= 5 * 60 * 1000) {
      return kept.targets;
    }
    const present = urls.filter((url) => url.trim() !== "");
    if (present.length === 0) {
      throw new Error("no database URL is configured");
    }
    const lists = await Promise.all(
      present.map((url) => databaseUrlTargets(url, resolve ?? systemResolver)),
    );
    kept = { at: Date.now(), targets: lists.flat() };
    return kept.targets;
  };
}

/** Restow's own cluster, read once (and again after a failure). */
export function ownSystemIdentifierOf(providerDb: Database): () => Promise<string | null> {
  let cached: Promise<string | null> | null = null;
  return () => {
    cached ??= providerDb
      .execute(sql`SELECT system_identifier::text AS id FROM pg_control_system()`)
      .then((result) => {
        const rows = (result as unknown as { rows?: { id?: string }[] }).rows ?? [];
        return rows[0]?.id ?? null;
      })
      .catch(() => {
        cached = null;
        return null;
      });
    return cached;
  };
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** The server's connections whose check is due (enabled, tenant active), oldest first. */
async function dueServerConnections(
  deps: DatabaseHealthDeps,
  now: Date,
): Promise<{ id: string; tenant_id: string }[]> {
  const result = await deps.providerDb.execute(sql`
    SELECT c.id, c.tenant_id
      FROM database_connections c
      JOIN tenants t ON t.id = c.tenant_id
      LEFT JOIN LATERAL (
        SELECT max(s.at) AS at FROM database_health_samples s
         WHERE s.connection_id = c.id AND s.resolution = 'raw'
      ) last ON true
     WHERE t.status = 'active'
       AND c.enabled
       AND c.executor_kind = 'server'
       AND (last.at IS NULL
            OR last.at <= ${now.toISOString()}::timestamptz - make_interval(mins => c.health_interval_minutes))
     ORDER BY last.at NULLS FIRST, c.id
     LIMIT ${MAX_CHECKS_PER_PASS}`);
  return rowsOf<{ id: string; tenant_id: string }>(result);
}

/** Whether the sizes are due: none read in the last hour. */
async function sizesDue(tx: TenantTx, connectionId: string, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ at: databaseHealthSamples.at })
    .from(databaseHealthSamples)
    .where(
      and(
        eq(databaseHealthSamples.connectionId, connectionId),
        gt(databaseHealthSamples.at, new Date(now.getTime() - DB_HEALTH_SIZES_EVERY_MS)),
        sql`${databaseHealthSamples.sizes} IS NOT NULL`,
      ),
    )
    .limit(1);
  return !row;
}

/** The judgement of a check of Restow's own database: refused, nothing of it kept (4.2). */
function ownDatabase(): DbHealthJudgement {
  return {
    ok: false,
    errorCode: "db_target_is_restow",
    errorMessage:
      "This is the database of this Restow installation. It is backed up as described in the backup guide of the installation, not by this module.",
    latencyMs: null,
    serverVersion: null,
    startedAt: null,
    connectionsUsed: null,
    connectionsMax: null,
    tlsFingerprint: null,
    instanceKey: null,
    sizes: null,
  };
}

/** One check of the server, written as a sample. Returns whether it was good. */
async function checkOne(
  deps: DatabaseHealthDeps,
  row: { id: string; tenant_id: string },
  now: Date,
  forbiddenTargets: readonly { address: string; port: number }[],
): Promise<boolean | null> {
  const tenantId = row.tenant_id;
  const loaded = await withTenantTx(deps.db, tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(databaseConnections)
      .where(and(eq(databaseConnections.tenantId, tenantId), eq(databaseConnections.id, row.id)))
      .limit(1);
    if (connection?.executorKind !== "server" || !connection.enabled) {
      return null;
    }
    return { connection, sizes: await sizesDue(tx, connection.id, now) };
  });
  const host = loaded?.connection.host;
  if (!loaded || !host) {
    return null;
  }
  const { connection } = loaded;
  const credentials = connection.credentialSecretId
    ? await deps.readCredentials(tenantId, connection.credentialSecretId)
    : { user: null, password: null };
  const run = deps.check ?? checkDatabaseHealthFromServer;
  const at = deps.now();
  const result = await run(
    {
      engine: connection.engine,
      host,
      port: connection.port,
      database: connection.loginDatabase,
      user: credentials.user,
      password: credentials.password,
      allowUnencrypted: connection.allowUnencrypted,
      pinnedFingerprintSha256: connection.tlsFingerprint,
      sizes: loaded.sizes,
    },
    {
      // Private networks: the installation flag, else exactly the addresses the provider admin's
      // approval names (an approval without addresses reaches none). A health check never
      // renews an approval and never takes a certificate: it only reads.
      allowPrivateNetworks: deps.privateNetworksAllowed,
      approvedAddresses: connection.privateNetworkApproval?.addresses ?? [],
      forbiddenTargets,
    },
  );
  const cleaned: DbProbeResult = result.error
    ? {
        ...result,
        error: { ...result.error, message: sanitizeDbMessage(result.error.message, credentials) },
      }
    : result;
  let judgement = judgeDbHealth(cleaned, connection);
  if (
    cleaned.engine === "postgresql" &&
    cleaned.health?.systemIdentifier &&
    cleaned.health.systemIdentifier === (await deps.ownSystemIdentifier())
  ) {
    judgement = ownDatabase();
  }
  await withTenantTx(deps.db, tenantId, (tx) =>
    recordDatabaseHealthSample(tx, {
      tenantId,
      connectionId: connection.id,
      instanceKey: connection.instanceKey,
      executorKind: "server",
      at,
      judgement,
    }),
  );
  if (!judgement.ok) {
    deps.logger.info("database health check failed", {
      tenantId,
      connectionId: connection.id,
      code: judgement.errorCode,
    });
  }
  return judgement.ok;
}

async function runServerChecks(
  deps: DatabaseHealthDeps,
  now: Date,
): Promise<{ checked: number; failed: number; waiting: number }> {
  const due = await dueServerConnections(deps, now);
  if (due.length === 0) {
    return { checked: 0, failed: 0, waiting: 0 };
  }
  let forbiddenTargets: { address: string; port: number }[];
  try {
    forbiddenTargets = await deps.ownDatabaseTargets();
  } catch (error) {
    // Not run unguarded: the connections stay without a new sample (their reachability turns
    // "unknown" after three intervals) until the own database can be told again.
    deps.logger.warn("database health checks wait: Restow's own database cannot be located", {
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : String(error),
      waiting: due.length,
    });
    return { checked: 0, failed: 0, waiting: due.length };
  }
  let checked = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const row = due[next++];
      if (!row) {
        return;
      }
      try {
        const ok = await checkOne(deps, row, now, forbiddenTargets);
        if (ok !== null) {
          checked++;
          if (!ok) failed++;
        }
      } catch (error) {
        // Never the error's text: it could hold what the client said about the sign-in.
        deps.logger.error("database health check could not run", {
          tenantId: row.tenant_id,
          connectionId: row.id,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  return { checked, failed, waiting: 0 };
}

/** The connections with samples the state has not taken in yet. */
async function connectionsToEvaluate(
  deps: DatabaseHealthDeps,
): Promise<{ id: string; tenant_id: string }[]> {
  const result = await deps.providerDb.execute(sql`
    SELECT c.id, c.tenant_id
      FROM database_connections c
     WHERE EXISTS (
       SELECT 1 FROM database_health_samples s
        WHERE s.connection_id = c.id AND s.resolution = 'raw'
          AND s.at > coalesce((c.health ->> 'lastAt')::timestamptz, '-infinity'::timestamptz))
     LIMIT ${MAX_EVALUATIONS_PER_PASS}`);
  return rowsOf<{ id: string; tenant_id: string }>(result);
}

function alertOf(
  connection: DatabaseConnection,
  alert: ReturnType<typeof advanceDbHealthState>["alerts"][number],
): NewNotification {
  const details = {
    connectionId: connection.id,
    objectName: connection.name,
    engine: connection.engine,
    address: formatDbAddress(connection),
    executor: connection.executorKind,
    endpointId: connection.executorEndpointId,
  };
  if (alert.kind === "unreachable") {
    return {
      tenantId: connection.tenantId,
      level: "warning",
      event: "database.unreachable",
      message: `The database connection ${connection.name} failed ${alert.failures} health checks in a row since ${alert.since}${alert.errorCode ? ` (${alert.errorCode})` : ""}.`,
      details: {
        ...details,
        since: alert.since,
        failures: alert.failures,
        errorCode: alert.errorCode,
        errorMessage: alert.errorMessage,
      },
    };
  }
  return {
    tenantId: connection.tenantId,
    level: "info",
    event: "database.reachable",
    message: `The database connection ${connection.name} passes its health check again.`,
    details: { ...details, since: alert.since, unreachableSince: alert.unreachableSince },
  };
}

async function evaluate(
  deps: DatabaseHealthDeps,
  row: { id: string; tenant_id: string },
  now: Date,
): Promise<number> {
  return withTenantTx(deps.db, row.tenant_id, async (tx) => {
    const [connection] = await tx
      .select()
      .from(databaseConnections)
      .where(
        and(eq(databaseConnections.tenantId, row.tenant_id), eq(databaseConnections.id, row.id)),
      )
      .limit(1)
      .for("update");
    if (!connection) {
      return 0;
    }
    const previous: DbHealthState | null = connection.health ?? null;
    const since = previous?.lastAt ? new Date(previous.lastAt) : new Date(0);
    const samples = await tx
      .select({
        at: databaseHealthSamples.at,
        okChecks: databaseHealthSamples.okChecks,
        errorCode: databaseHealthSamples.errorCode,
        errorMessage: databaseHealthSamples.errorMessage,
        latencyMs: databaseHealthSamples.latencyMs,
      })
      .from(databaseHealthSamples)
      .where(
        and(
          eq(databaseHealthSamples.connectionId, connection.id),
          eq(databaseHealthSamples.resolution, "raw"),
          gt(databaseHealthSamples.at, since),
        ),
      )
      .orderBy(asc(databaseHealthSamples.at))
      .limit(1000);
    const { state, alerts } = advanceDbHealthState(
      previous,
      samples.map((sample) => ({
        at: sample.at,
        ok: sample.okChecks > 0,
        errorCode: sample.errorCode,
        errorMessage: sample.errorMessage,
        latencyMs: sample.latencyMs,
      })),
      now,
    );
    // A paused connection is not alerted about: its checks stopped with it.
    const raised = connection.enabled ? alerts.map((alert) => alertOf(connection, alert)) : [];
    await raiseEvents(tx, raised, now);
    await tx
      .update(databaseConnections)
      .set({ health: state })
      .where(eq(databaseConnections.id, connection.id));
    return raised.length;
  });
}

/** Once a day: fold the raw samples into hours, drop old hours and old `db_health` tasks. */
async function housekeeping(
  deps: DatabaseHealthDeps,
  now: Date,
): Promise<{ folded: number; dropped: number }> {
  const result = await compactDatabaseHealthSamples(
    deps.providerDb,
    new Date(now.getTime() - DB_HEALTH_RAW_KEEP_DAYS * DAY_MS),
    new Date(now.getTime() - DB_HEALTH_HOURLY_KEEP_DAYS * DAY_MS),
  );
  await deps.providerDb
    .delete(endpointTasks)
    .where(
      and(
        eq(endpointTasks.kind, "db_health"),
        lt(endpointTasks.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return result;
}

/** One pass: the server's checks, the evaluation, and (when `compact`) the housekeeping. */
export async function databaseHealthPass(
  deps: DatabaseHealthDeps,
  options: { compact: boolean },
): Promise<DatabaseHealthSummary> {
  const summary: DatabaseHealthSummary = {
    checked: 0,
    failed: 0,
    waiting: 0,
    evaluated: 0,
    alerts: 0,
    folded: 0,
    dropped: 0,
  };
  const now = deps.now();
  if (!(await deps.restoreModeActive())) {
    const checks = await runServerChecks(deps, now);
    summary.checked = checks.checked;
    summary.failed = checks.failed;
    summary.waiting = checks.waiting;
  }
  for (const row of await connectionsToEvaluate(deps)) {
    try {
      summary.alerts += await evaluate(deps, row, deps.now());
      summary.evaluated++;
    } catch (error) {
      deps.logger.error("database health evaluation failed", {
        tenantId: row.tenant_id,
        connectionId: row.id,
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
  }
  if (options.compact) {
    const kept = await housekeeping(deps, now);
    summary.folded = kept.folded;
    summary.dropped = kept.dropped;
  }
  return summary;
}

/** Start the pass every minute in one worker of the installation at a time. */
export function startDatabaseHealth(
  deps: DatabaseHealthDeps,
  shutdownSignal: AbortSignal,
  intervalMs = DATABASE_HEALTH_PASS_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastCompactedAt = 0;
  const tick = async () => {
    const client = await deps.providerDb.$client.connect().catch(() => null);
    if (!client) {
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
      return;
    }
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY],
      );
      if (!rows[0]?.locked) {
        return;
      }
      try {
        const now = deps.now().getTime();
        const compact = now - lastCompactedAt >= DAY_MS;
        const summary = await databaseHealthPass(deps, { compact });
        if (compact) {
          lastCompactedAt = now;
        }
        if (Object.values(summary).some((value) => value > 0)) {
          deps.logger.info("database health pass", { ...summary });
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (error) {
      deps.logger.error("database health pass failed", {
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    } finally {
      client.release();
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };
  timer = setTimeout(() => void tick(), 20_000);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
