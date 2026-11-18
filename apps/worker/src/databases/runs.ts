/**
 * Backup and restore runs of the module "Databases", stage D3 (docs/DATABASES.md 4.3, 5.1, 5.2,
 * 7.1, 16 "D3"), for PostgreSQL:
 *
 *   - **Planning** (one pass a minute, one worker at a time): an enabled connection whose
 *     interval passed since its last backup run gets a run (`database_runs`, at most one queued
 *     or running per connection: a due run while one is active is dropped with the note
 *     `db_run_overlap` on the active one). A run of the Restow server goes to the queue `db`; a
 *     run of an agent becomes its task `db_backup` / `db_restore`. Agent runs nobody fetched for
 *     an hour fail with `db_runner_offline`, runs that never ended fail after a day.
 *   - **Backup by the server** (queue `db`): the instance is checked with Restow's own client
 *     over a pinned connection (the confirmed instance, never Restow's own database), its
 *     databases are listed and recorded (a new OID is a new database, a missing one is
 *     dropped), the programs are chosen (newest, at least the server's major version), and each
 *     selected database is dumped with `restic backup --stdin-from-command` through `db-stream`
 *     and the pinning relay (../../../../packages/core/src/databases/relay.ts): one snapshot per
 *     database and run, none when the dump fails. The instance's roles and tablespaces are
 *     dumped once (`pg_dumpall --globals-only`, without password hashes unless the user may
 *     read them).
 *   - **Restore by the server**: always into a new database (O3): the target's rights and the
 *     name are checked, `CREATE DATABASE … TEMPLATE template0` records the new OID in the run,
 *     the dump comes from the repository (its SHA-256 compared on the way) into `pg_restore
 *     --exit-on-error --no-owner --no-privileges` through a relay to the target; when that fails
 *     only the database with the recorded name and OID is dropped.
 *
 * Credentials are read for the run and handed to the program in a `PGPASSFILE` (0600, in
 * memory) only; messages are cleaned of them before they are stored. Restore mode: nothing
 * starts.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRetentionPolicy,
  choosePgTools,
  type DbErrorCode,
  type DbPinnedTarget,
  type DbServerProbeOptions,
  type DbStreamSpec,
  type DbStreamStats,
  DEFAULT_ENDPOINT_RETENTION,
  deletionDecision,
  type MysqlFamily,
  type MysqlToolChoice,
  openPgAdminSession,
  openPgRelay,
  type PgAdminSession,
  type PgRelay,
  type PgRelayOpen,
  type PgToolChoice,
  pgDumpArgs,
  pgDumpallGlobalsArgs,
  pgQuoteIdent,
  pgQuoteLiteral,
  pgRestoreArgs,
  pgToolEnv,
  privateTempDir,
  type RepositoryAccess,
  type ResticSession,
  resticBinary,
  resticCacheBase,
  resticDump,
  resticForget,
  resticInit,
  resticPrune,
  resticSnapshots,
  runRestic,
  type StorageBackend,
  sanitizeDbMessage,
  sealSecret,
  sweepStaleTempDirs,
  withDeletionPermit,
  withRepository,
  writePgPassFile,
} from "@restow/core";
import {
  DATABASE_RUN_AGENT_FETCH_MS,
  type Database,
  type DatabaseConnection,
  type DatabaseRun,
  databaseBackups,
  databaseConnections,
  databaseRuns,
  insertDatabaseRunTx,
  recordInstanceDatabasesTx,
  secrets,
} from "@restow/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  PgSecretReader,
  type TenantKeyringCache,
  tenantRunner,
  withTenantTx,
} from "../handlers/framework.js";
import { recordDeferredDeletion } from "../handlers/immutability.js";
import { hasActiveMigration } from "../handlers/storage-migration.js";
import { serverMysqlBackup, serverMysqlRestore } from "./mysql-runs.js";

const MINUTE_MS = 60 * 1000;
/** The pass runs every minute. */
export const DATABASE_RUNS_PASS_MS = MINUTE_MS;
const LOCK_KEY = 0x64627231; // "dbr1"
/** The queue of the server's runs (4.2: `db`, `DB_CONCURRENCY` at once per worker process). */
export const DATABASE_RUN_QUEUE = "db";
/** pg-boss settings of `db`: a failed run is final (its row says why), one queued job per run. */
export const DATABASE_RUN_QUEUE_OPTIONS = {
  name: DATABASE_RUN_QUEUE,
  policy: "short" as const,
  retryLimit: 0,
  expireInHours: 23,
  retentionDays: 7,
};
/** Shortest schedule (5.1: at least every 15 minutes). */
export const DB_BACKUP_MIN_INTERVAL_MINUTES = 15;
/** An agent run nobody fetched in this time fails (`db_runner_offline`). */
const AGENT_FETCH_DEADLINE_MS = DATABASE_RUN_AGENT_FETCH_MS;
/** A run that never ended fails after this. */
const RUN_MAX_MS = 24 * 60 * MINUTE_MS;
/** One dump, one restore: the relay's hard deadline. */
export const PROGRAM_MAX_MS = 12 * 60 * MINUTE_MS;
/** A restored database name: at most 63 bytes (PostgreSQL's NAMEDATALEN - 1). */
export const DB_NAME_MAX_BYTES = 63;

/** The engines whose runs the executors know (D3 PostgreSQL, D4 MySQL and MariaDB). */
export const DB_RUN_ENGINES: ReadonlySet<string> = new Set(["postgresql", "mysql", "mariadb"]);

interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface DatabaseRunDeps {
  readonly db: Database;
  readonly providerDb: Database;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly keyrings: TenantKeyringCache;
  /** The tenant's primary storage target. */
  readonly primaryStorage: (tenantId: string) => Promise<StorageBackend>;
  /** Whether the tenant's primary storage target is write-once (retention then keeps all). */
  readonly primaryWriteOnce: (tenantId: string) => Promise<boolean>;
  readonly privateNetworksAllowed: boolean;
  readonly restoreModeActive: () => Promise<boolean>;
  readonly readCredentials: (
    tenantId: string,
    secretId: string,
  ) => Promise<{ user: string | null; password: string | null }>;
  readonly ownSystemIdentifier: () => Promise<string | null>;
  readonly ownDatabaseTargets: () => Promise<{ address: string; port: number }[]>;
  /** Send a server run to the queue `db` (deduplicated by the run id). */
  readonly enqueue: (payload: { tenantId: string; runId: string }) => Promise<void>;
  /** Tests: the programs. */
  readonly tools?: (serverMajor: number) => Promise<PgToolChoice>;
  /** Tests: the MySQL and MariaDB programs. */
  readonly mysqlTools?: (
    family: MysqlFamily,
    serverVersion: { major: number; minor: number },
  ) => Promise<MysqlToolChoice>;
  /** Tests: how restic starts `db-stream` (default: this Node with the compiled entry). */
  readonly dbStreamCommand?: readonly string[];
}

/** The node command restic runs for each dump (5.1: `db-stream` in the worker image). */
export function defaultDbStreamCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("./db-stream.js", import.meta.url))];
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** A failure of a run with its code; the message is cleaned before it is stored. */
export class DatabaseRunFailure extends Error {
  constructor(
    readonly code: DbErrorCode | "db_run_failed",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Plan a run (packages/db `insertDatabaseRunTx`); the connection's executor runs a backup. */
export async function insertDatabaseRun(
  db: Database,
  connection: Pick<DatabaseConnection, "id" | "tenantId" | "executorKind" | "executorEndpointId">,
  input: Parameters<typeof insertDatabaseRunTx>[3],
  now: Date,
  executor: Pick<DatabaseConnection, "executorKind" | "executorEndpointId"> = connection,
): Promise<DatabaseRun | null> {
  return withTenantTx(db, connection.tenantId, (tx) =>
    insertDatabaseRunTx(tx, connection, executor, input, now),
  );
}

export interface DatabaseRunsSummary {
  planned: number;
  enqueued: number;
  expired: number;
  forgotten: number;
}

/** One pass: plan due backups, send queued server runs to `db`, expire stuck runs. */
export async function databaseRunsPass(deps: DatabaseRunDeps): Promise<DatabaseRunsSummary> {
  const summary: DatabaseRunsSummary = { planned: 0, enqueued: 0, expired: 0, forgotten: 0 };
  if (await deps.restoreModeActive()) {
    return summary;
  }
  const now = deps.now();
  const due = rowsOf<{ id: string; tenant_id: string }>(
    await deps.providerDb.execute(sql`
      SELECT c.id, c.tenant_id
        FROM database_connections c
        JOIN tenants t ON t.id = c.tenant_id
        LEFT JOIN LATERAL (
          SELECT max(r.created_at) AS at FROM database_runs r
           WHERE r.connection_id = c.id AND r.kind = 'backup'
        ) last ON true
       WHERE t.status = 'active'
         AND c.enabled
         AND c.engine IN ('postgresql', 'mysql', 'mariadb')
         AND c.mode = 'backup'
         -- An agent on Windows runs no PostgreSQL or MySQL backup yet (E7, db_platform_unsupported).
         AND NOT EXISTS (SELECT 1 FROM endpoints e
                          WHERE c.executor_kind = 'agent'
                            AND e.id = c.executor_endpoint_id
                            AND e.os = 'windows')
         AND (last.at IS NULL
              OR last.at <= ${now.toISOString()}::timestamptz - make_interval(
                   mins => greatest(${DB_BACKUP_MIN_INTERVAL_MINUTES}, (c.schedule ->> 'intervalMinutes')::int)))
       ORDER BY last.at NULLS FIRST
       LIMIT 200`),
  );
  for (const row of due) {
    const [connection] = await withTenantTx(deps.db, row.tenant_id, (tx) =>
      tx.select().from(databaseConnections).where(eq(databaseConnections.id, row.id)).limit(1),
    );
    if (connection && (await insertDatabaseRun(deps.db, connection, { kind: "backup" }, now))) {
      summary.planned++;
    }
  }
  const queued = rowsOf<{ id: string; tenant_id: string }>(
    await deps.providerDb.execute(sql`
      SELECT id, tenant_id FROM database_runs
       WHERE status = 'queued' AND executor_kind = 'server'
       ORDER BY created_at LIMIT 200`),
  );
  for (const row of queued) {
    await deps.enqueue({ tenantId: row.tenant_id, runId: row.id });
    summary.enqueued++;
  }
  const expired = rowsOf<{ id: string }>(
    await deps.providerDb.execute(sql`
      UPDATE database_runs
         SET status = 'failed', finished_at = ${now.toISOString()}::timestamptz,
             error_code = CASE WHEN executor_kind = 'agent' AND fetched_at IS NULL
                               THEN 'db_runner_offline' ELSE 'db_run_failed' END,
             error_message = CASE WHEN executor_kind = 'agent' AND fetched_at IS NULL
                               THEN 'The agent did not pick the run up.'
                               ELSE 'The run did not end in time.' END
       WHERE (status = 'queued' AND executor_kind = 'agent' AND fetched_at IS NULL
              AND created_at < ${new Date(now.getTime() - AGENT_FETCH_DEADLINE_MS).toISOString()}::timestamptz)
          OR (status IN ('queued', 'running')
              AND created_at < ${new Date(now.getTime() - RUN_MAX_MS).toISOString()}::timestamptz)
      RETURNING id`),
  );
  summary.expired = expired.length;
  summary.forgotten = await retentionPass(deps);
  return summary;
}

// ---------------------------------------------------------------------------
// The repository of a connection (4.4)
// ---------------------------------------------------------------------------

export function databaseRepositoryPrefix(connectionId: string): string {
  return `db/${connectionId}/`;
}

async function openTenantSecret(
  deps: DatabaseRunDeps,
  tenantId: string,
  secretId: string,
): Promise<string | null> {
  const keys = await deps.keyrings.get(tenantId);
  return new PgSecretReader(tenantRunner(deps.db, tenantId), tenantId, keys).get(secretId);
}

/** The connection's repository: a password sealed with the tenant key, `restic init` once. */
export async function ensureDatabaseRepository(
  deps: DatabaseRunDeps,
  connection: DatabaseConnection,
): Promise<RepositoryAccess> {
  const storage = await deps.primaryStorage(connection.tenantId);
  const prefix = databaseRepositoryPrefix(connection.id);
  let secretId = connection.repositorySecretId;
  if (!secretId) {
    if (await storage.head(`${prefix}config`).catch(() => null)) {
      // A repository the database holds no password for (a restored database dump): never
      // a new password over it.
      throw new DatabaseRunFailure(
        "db_snapshot_failed",
        "The storage holds a repository of this connection that Restow has no password for.",
      );
    }
    const keys = await deps.keyrings.get(connection.tenantId);
    const password = randomBytes(32).toString("base64url");
    secretId = await withTenantTx(deps.db, connection.tenantId, async (tx) => {
      const [locked] = await tx
        .select({ secretId: databaseConnections.repositorySecretId })
        .from(databaseConnections)
        .where(eq(databaseConnections.id, connection.id))
        .for("update");
      if (locked?.secretId) {
        return locked.secretId;
      }
      const id = randomUUID();
      await tx.insert(secrets).values({
        id,
        tenantId: connection.tenantId,
        kind: "database_repository",
        ciphertext: sealSecret(keys.current, id, password),
        keyVersion: keys.current.version,
      });
      await tx
        .update(databaseConnections)
        .set({ repositorySecretId: id })
        .where(eq(databaseConnections.id, connection.id));
      return id;
    });
  }
  const password = await openTenantSecret(deps, connection.tenantId, secretId);
  if (!password) {
    throw new DatabaseRunFailure("db_snapshot_failed", "The repository's password is gone.");
  }
  const access: RepositoryAccess = {
    storage,
    prefix,
    repositoryPassword: password,
    repositoryKey: `db-${connection.id}`,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
  if (!connection.repositoryInitializedAt) {
    if (!(await storage.head(`${prefix}config`).catch(() => null))) {
      await withRepository(access, (session) => resticInit(session));
    }
    await withTenantTx(deps.db, connection.tenantId, (tx) =>
      tx
        .update(databaseConnections)
        .set({ repositoryInitializedAt: deps.now() })
        .where(eq(databaseConnections.id, connection.id)),
    );
  }
  return access;
}

// ---------------------------------------------------------------------------
// The server's runs
// ---------------------------------------------------------------------------

export interface Prepared {
  connection: DatabaseConnection;
  credentials: { user: string; password: string | null };
  target: DbPinnedTarget;
  network: DbServerProbeOptions;
}

export async function prepare(
  deps: DatabaseRunDeps,
  connection: DatabaseConnection,
): Promise<Prepared> {
  if (!DB_RUN_ENGINES.has(connection.engine)) {
    throw new DatabaseRunFailure(
      "db_engine_unsupported",
      "Backups of this engine come with a later stage.",
    );
  }
  if (!connection.host || !connection.port) {
    throw new DatabaseRunFailure("db_engine_unsupported", "The connection has no address.");
  }
  if (!connection.credentialSecretId) {
    throw new DatabaseRunFailure("db_login_failed", "The connection keeps no credentials.");
  }
  const stored = await deps.readCredentials(connection.tenantId, connection.credentialSecretId);
  if (!stored.user) {
    throw new DatabaseRunFailure("db_login_failed", "The connection keeps no user.");
  }
  let forbiddenTargets: { address: string; port: number }[];
  try {
    forbiddenTargets = await deps.ownDatabaseTargets();
  } catch {
    throw new DatabaseRunFailure(
      "db_target_is_restow",
      "Where Restow's own database listens cannot be told; the run does not connect unguarded.",
    );
  }
  return {
    connection,
    credentials: { user: stored.user, password: stored.password },
    target: {
      host: connection.host,
      port: connection.port,
      allowUnencrypted: connection.allowUnencrypted,
      pinnedFingerprintSha256: connection.tlsFingerprint,
    },
    network: {
      allowPrivateNetworks: deps.privateNetworksAllowed,
      approvedAddresses: connection.privateNetworkApproval?.addresses ?? [],
      forbiddenTargets,
    },
  };
}

async function adminSession(prepared: Prepared, database: string): Promise<PgAdminSession> {
  const opened = await openPgAdminSession(
    prepared.target,
    prepared.network,
    prepared.credentials,
    database,
  );
  if (!opened.ok) {
    throw new DatabaseRunFailure(opened.code, opened.message);
  }
  // The run's first connection did the instance check: every later one (the relays, the other
  // statements) goes to the same address, judged by the same rules.
  if (!prepared.target.address && opened.session.connectedAddress) {
    prepared.target = { ...prepared.target, address: opened.session.connectedAddress };
  }
  return opened.session;
}

interface InstanceFacts {
  serverMajor: number;
  serverVersion: string;
  systemIdentifier: string;
  rolePasswords: boolean;
  canCreateDb: boolean;
  databases: { name: string; oid: string; empty: boolean }[];
}

async function instanceFacts(
  deps: DatabaseRunDeps,
  session: PgAdminSession,
): Promise<InstanceFacts> {
  const [head] = await session.query(
    "SELECT current_setting('server_version_num'), current_setting('server_version'), (SELECT system_identifier::text FROM pg_control_system()), has_table_privilege('pg_authid', 'SELECT'), (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user)",
  );
  const own = await deps.ownSystemIdentifier();
  const systemIdentifier = head?.[2] ?? "";
  if (own && systemIdentifier === own) {
    throw new DatabaseRunFailure(
      "db_target_is_restow",
      "This is the database of this Restow installation.",
    );
  }
  const list = await session.query(
    "SELECT datname, oid::text FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
  );
  return {
    serverMajor: Math.floor(Number(head?.[0] ?? 0) / 10000),
    serverVersion: head?.[1] ?? "",
    systemIdentifier,
    rolePasswords: head?.[3] === "t",
    canCreateDb: head?.[4] === "t",
    databases: list.map((row) => ({ name: row[0] ?? "", oid: row[1] ?? "", empty: false })),
  };
}

/** Whether `postgres` holds anything of its own (5.2: skipped when empty). */
async function postgresIsEmpty(prepared: Prepared): Promise<boolean> {
  const session = await adminSession(prepared, "postgres");
  try {
    const [row] = await session.query(
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'",
    );
    return Number(row?.[0] ?? 0) === 0;
  } finally {
    session.close();
  }
}

export async function finishRun(
  deps: DatabaseRunDeps,
  run: DatabaseRun,
  outcome: {
    status: "succeeded" | "partial" | "failed";
    errorCode?: string | null;
    errorMessage?: string | null;
    notes?: Record<string, unknown>[];
    targetOid?: string | null;
  },
): Promise<void> {
  await withTenantTx(deps.db, run.tenantId, (tx) =>
    tx
      .update(databaseRuns)
      .set({
        status: outcome.status,
        finishedAt: deps.now(),
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage?.slice(0, 1000) ?? null,
        ...(outcome.notes ? { notes: outcome.notes } : {}),
        ...(outcome.targetOid !== undefined ? { targetOid: outcome.targetOid } : {}),
      })
      // A run failed meanwhile (its connection moved to another executor) stays failed.
      .where(and(eq(databaseRuns.id, run.id), eq(databaseRuns.status, "running"))),
  );
}

/** Take a queued server run (`running`); null when it is gone or already taken. */
async function takeRun(deps: DatabaseRunDeps, tenantId: string, runId: string) {
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const [run] = await tx
      .update(databaseRuns)
      .set({ status: "running", startedAt: deps.now() })
      .where(
        and(
          eq(databaseRuns.id, runId),
          eq(databaseRuns.status, "queued"),
          eq(databaseRuns.executorKind, "server"),
        ),
      )
      .returning();
    if (!run) {
      return null;
    }
    const [connection] = await tx
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, run.connectionId))
      .limit(1);
    return connection ? { run, connection } : null;
  });
}

/** The queue `db`: one server run. */
export async function runDatabaseJob(
  deps: DatabaseRunDeps,
  payload: { tenantId: string; runId: string },
): Promise<void> {
  if (await deps.restoreModeActive()) {
    return;
  }
  const taken = await takeRun(deps, payload.tenantId, payload.runId);
  if (!taken) {
    return;
  }
  const { run, connection } = taken;
  let secretsSeen: { user: string | null; password: string | null } = {
    user: null,
    password: null,
  };
  try {
    const mysql = connection.engine === "mysql" || connection.engine === "mariadb";
    if (run.kind === "backup") {
      const prepared = await prepare(deps, connection);
      secretsSeen = prepared.credentials;
      await (mysql ? serverMysqlBackup : serverBackup)(deps, run, prepared);
    } else {
      await (mysql ? serverMysqlRestore : serverRestore)(deps, run, connection, (credentials) => {
        secretsSeen = credentials;
      });
    }
  } catch (error) {
    const code = error instanceof DatabaseRunFailure ? error.code : "db_run_failed";
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(deps, run, {
      status: "failed",
      errorCode: code,
      errorMessage: sanitizeDbMessage(message, secretsSeen),
    });
    deps.logger.info("database run failed", {
      tenantId: run.tenantId,
      runId: run.id,
      connectionId: connection.id,
      code,
    });
  }
}

function fileNameOf(name: string, kind: "database" | "globals"): string {
  return kind === "globals"
    ? "postgresql/globals.sql"
    : `postgresql/${name.replace(/[/\\]/g, "_")}.pgdump`;
}

export interface DumpOutcome {
  snapshotId: string;
  stats: DbStreamStats;
  startedAt: Date;
  finishedAt: Date;
}

/** One `restic backup --stdin-from-command` through a relay of its own. */
async function dumpOne(
  deps: DatabaseRunDeps,
  session: ResticSession,
  prepared: Prepared,
  dir: string,
  passFile: string,
  input: {
    tool: string;
    args: string[];
    listTool: string | null;
    fileName: string;
    tags: string[];
  },
): Promise<DumpOutcome> {
  return dumpThrough(deps, session, dir, {
    open: () =>
      openPgRelay({
        target: prepared.target,
        network: prepared.network,
        maxDurationMs: PROGRAM_MAX_MS,
      }),
    spec: (relay) => ({
      tool: input.tool,
      args: input.args,
      env: pgToolEnv({
        socketDir: relay?.socketDir ?? "",
        port: relay?.port ?? 0,
        user: prepared.credentials.user,
        passFile,
      }),
      listTool: input.listTool,
    }),
    fileName: input.fileName,
    tags: input.tags,
  });
}

/**
 * One `restic backup --stdin-from-command` of `db-stream`, through a relay of its own (`open`,
 * none for a file the executor wrote): what restic keeps is a snapshot only when the program
 * ended well (5.1).
 */
export async function dumpThrough(
  deps: DatabaseRunDeps,
  session: ResticSession,
  dir: string,
  input: {
    open: (() => Promise<PgRelayOpen>) | null;
    spec: (
      relay: PgRelay | null,
    ) => Omit<DbStreamSpec, "statsPath"> | Promise<Omit<DbStreamSpec, "statsPath">>;
    fileName: string;
    tags: string[];
  },
): Promise<DumpOutcome> {
  const startedAt = deps.now();
  const opened = input.open ? await input.open() : null;
  if (opened && !opened.ok) {
    throw new DatabaseRunFailure(opened.code, opened.message);
  }
  const relay = opened?.ok ? opened : null;
  const statsPath = join(dir, `stats-${randomUUID()}.json`);
  const specPath = join(dir, `spec-${randomUUID()}.json`);
  let spec: DbStreamSpec;
  try {
    spec = { ...(await input.spec(relay?.relay ?? null)), statsPath };
  } catch (error) {
    relay?.relay.close();
    throw error;
  }
  await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
  try {
    const command = deps.dbStreamCommand ?? defaultDbStreamCommand();
    const result = await runRestic(
      session,
      [
        "backup",
        "--json",
        "--host",
        "restow-db",
        "--stdin-from-command",
        "--stdin-filename",
        input.fileName,
        ...input.tags.flatMap((tag) => ["--tag", tag]),
        "--",
        ...command,
        "--spec",
        specPath,
      ],
      { acceptExitCodes: [0, 1, 3] },
    );
    const stats = JSON.parse(
      await readFile(statsPath, "utf8").catch(() => "null"),
    ) as DbStreamStats | null;
    // A sign-in the relay stopped (MySQL: a method it does not hand on) says why the program failed.
    const failure =
      !stats?.ok && relay
        ? (
            await Promise.race([
              relay.relay.ended,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref()),
            ])
          )?.failure
        : null;
    if (!stats?.ok && failure) {
      throw new DatabaseRunFailure(failure.code, failure.message);
    }
    if (!stats?.ok) {
      throw new DatabaseRunFailure(
        "db_dump_failed",
        stats?.stderr || `the dump program failed (restic exit ${result.exitCode})`,
      );
    }
    const summary = result.stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        } catch {
          return null;
        }
      })
      .find((message) => message?.message_type === "summary");
    if (result.exitCode !== 0 || !summary?.snapshot_id) {
      throw new DatabaseRunFailure("db_snapshot_failed", "restic kept no snapshot of the dump.");
    }
    return { snapshotId: summary.snapshot_id, stats, startedAt, finishedAt: deps.now() };
  } finally {
    relay?.relay.close();
    await rm(specPath, { force: true });
    await rm(statsPath, { force: true });
  }
}

/** Record the databases the instance has now (packages/db `recordInstanceDatabasesTx`). */
export function recordDatabases(
  deps: DatabaseRunDeps,
  connection: DatabaseConnection,
  instanceKey: string,
  found: { name: string; oid: string | null }[],
): Promise<Map<string, string>> {
  return withTenantTx(deps.db, connection.tenantId, (tx) =>
    recordInstanceDatabasesTx(tx, connection, instanceKey, found, deps.now()),
  );
}

export function selected(connection: DatabaseConnection, name: string): boolean {
  const selection = connection.selection;
  if (selection.mode === "selected") {
    return selection.names.includes(name);
  }
  return !selection.exclude.includes(name);
}

async function serverBackup(
  deps: DatabaseRunDeps,
  run: DatabaseRun,
  prepared: Prepared,
): Promise<void> {
  const { connection } = prepared;
  const admin = await adminSession(prepared, connection.loginDatabase ?? "postgres");
  let facts: InstanceFacts;
  try {
    facts = await instanceFacts(deps, admin);
  } finally {
    admin.close();
  }
  const instanceKey = `postgresql:${facts.systemIdentifier}`;
  if (connection.instanceKey && connection.instanceKey !== instanceKey) {
    throw new DatabaseRunFailure(
      "db_instance_changed",
      "Another instance answers under the address; an administrator confirms it after a test.",
    );
  }
  const tools = await (deps.tools ?? choosePgTools)(facts.serverMajor);
  if (!tools.ok) {
    throw new DatabaseRunFailure(tools.code, tools.message);
  }
  const ids = await recordDatabases(deps, connection, instanceKey, facts.databases);
  const notes: Record<string, unknown>[] = [];
  const wanted: InstanceFacts["databases"] = [];
  for (const database of facts.databases) {
    if (!selected(connection, database.name)) {
      continue;
    }
    if (database.name === "postgres" && (await postgresIsEmpty(prepared))) {
      notes.push({ database: database.name, result: "skipped", code: "db_database_empty" });
      continue;
    }
    wanted.push(database);
  }
  const access = await ensureDatabaseRepository(deps, connection);
  const dir = await privateTempDir("restow-db-run-");
  let failed = 0;
  let done = 0;
  try {
    const passFile = await writePgPassFile(dir, prepared.credentials.password ?? "");
    await withRepository(access, async (session) => {
      const baseTags = [
        "restow-db",
        "restow-db-engine=postgresql",
        `restow-db-connection=${connection.id}`,
        `restow-db-run=${run.id}`,
      ];
      for (const database of wanted) {
        const databaseId = ids.get(database.name) ?? null;
        const fileName = fileNameOf(database.name, "database");
        try {
          const dumped = await dumpOne(deps, session, prepared, dir, passFile, {
            tool: tools.tools.path("pg_dump"),
            args: pgDumpArgs(database.name),
            listTool: tools.tools.path("pg_restore"),
            fileName,
            tags: [...baseTags, ...(databaseId ? [`restow-db-database=${databaseId}`] : [])],
          });
          await recordBackup(deps, run, connection, {
            databaseId,
            kind: "database",
            name: database.name,
            identity: database.oid,
            instanceKey,
            fileName,
            dumped,
            toolVersion: String(tools.tools.major),
            serverVersion: facts.serverVersion,
          });
          notes.push({
            database: database.name,
            result: "backed_up",
            snapshotId: dumped.snapshotId,
          });
          done++;
        } catch (error) {
          failed++;
          notes.push({
            database: database.name,
            result: "failed",
            code: error instanceof DatabaseRunFailure ? error.code : "db_dump_failed",
            message: sanitizeDbMessage(
              error instanceof Error ? error.message : String(error),
              prepared.credentials,
            ).slice(0, 500),
          });
        }
      }
      try {
        const fileName = fileNameOf("", "globals");
        const dumped = await dumpOne(deps, session, prepared, dir, passFile, {
          tool: tools.tools.path("pg_dumpall"),
          args: pgDumpallGlobalsArgs({ rolePasswords: facts.rolePasswords }),
          listTool: null,
          fileName,
          tags: [...baseTags, "restow-db-globals"],
        });
        await recordBackup(deps, run, connection, {
          databaseId: null,
          kind: "globals",
          name: "",
          identity: null,
          instanceKey,
          fileName,
          dumped,
          toolVersion: String(tools.tools.major),
          serverVersion: facts.serverVersion,
        });
        notes.push({ globals: true, result: "backed_up", rolePasswords: facts.rolePasswords });
        done++;
      } catch (error) {
        // The instance's roles count like a database: without them the run is not whole.
        failed++;
        notes.push({
          globals: true,
          result: "failed",
          code: error instanceof DatabaseRunFailure ? error.code : "db_dump_failed",
          message: sanitizeDbMessage(
            error instanceof Error ? error.message : String(error),
            prepared.credentials,
          ).slice(0, 500),
        });
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const status = failed === 0 ? "succeeded" : done > 0 ? "partial" : "failed";
  await finishRun(deps, run, {
    status,
    errorCode: status === "succeeded" ? null : "db_dump_failed",
    errorMessage: status === "succeeded" ? null : `${failed} of ${wanted.length + 1} dumps failed.`,
    notes,
  });
}

export async function recordBackup(
  deps: DatabaseRunDeps,
  run: DatabaseRun,
  connection: DatabaseConnection,
  input: {
    databaseId: string | null;
    kind: "database" | "globals";
    name: string;
    identity: string | null;
    instanceKey: string;
    fileName: string;
    dumped: DumpOutcome;
    toolVersion: string;
    serverVersion: string;
    engineOptions?: { characterSet?: string; collation?: string };
  },
): Promise<void> {
  await withTenantTx(deps.db, connection.tenantId, (tx) =>
    tx.insert(databaseBackups).values({
      tenantId: connection.tenantId,
      connectionId: connection.id,
      runId: run.id,
      databaseId: input.databaseId,
      kind: input.kind,
      databaseName: input.name,
      identity: input.identity,
      instanceKey: input.instanceKey,
      snapshotId: input.dumped.snapshotId,
      fileName: input.fileName,
      sha256: input.dumped.stats.sha256,
      bytes: input.dumped.stats.bytes,
      objects: input.dumped.stats.objects,
      engineOptions: input.engineOptions ?? {},
      toolVersion: input.toolVersion,
      serverVersion: input.serverVersion.slice(0, 256),
      startedAt: input.dumped.startedAt,
      finishedAt: input.dumped.finishedAt,
    }),
  );
}

/** A new database's name (O3): at most 63 bytes, no control character, no outer blanks. */
export function validRestoreName(name: string): boolean {
  return (
    name.length > 0 &&
    name.trim() === name &&
    Buffer.byteLength(name, "utf8") <= DB_NAME_MAX_BYTES &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/** The default name of a restore: `<name>_restored_<UTC time>`, cut to 63 bytes. */
export function defaultRestoreName(name: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "_");
  const suffix = `_restored_${stamp}`;
  let base = name;
  while (Buffer.byteLength(base + suffix, "utf8") > DB_NAME_MAX_BYTES) {
    base = base.slice(0, -1);
  }
  return base + suffix;
}

async function serverRestore(
  deps: DatabaseRunDeps,
  run: DatabaseRun,
  source: DatabaseConnection,
  seen: (credentials: { user: string | null; password: string | null }) => void,
): Promise<void> {
  const [backup, target] = await withTenantTx(deps.db, run.tenantId, async (tx) => {
    const [row] = run.sourceBackupId
      ? await tx
          .select()
          .from(databaseBackups)
          .where(eq(databaseBackups.id, run.sourceBackupId))
          .limit(1)
      : [];
    const [to] = run.targetConnectionId
      ? await tx
          .select()
          .from(databaseConnections)
          .where(eq(databaseConnections.id, run.targetConnectionId))
          .limit(1)
      : [];
    return [row ?? null, to ?? null] as const;
  });
  if (
    !backup ||
    backup.connectionId !== source.id ||
    backup.status !== "active" ||
    backup.kind !== "database"
  ) {
    throw new DatabaseRunFailure("db_restore_failed", "The backup to restore is not available.");
  }
  if (target?.engine !== "postgresql" || target.tenantId !== run.tenantId) {
    throw new DatabaseRunFailure("db_restore_failed", "The target connection is not available.");
  }
  const name = run.targetName ?? "";
  if (!validRestoreName(name)) {
    throw new DatabaseRunFailure("db_restore_failed", "The new database's name is not valid.");
  }
  const prepared = await prepare(deps, target);
  seen(prepared.credentials);
  const admin = await adminSession(prepared, target.loginDatabase ?? "postgres");
  let createdOid: string | null = null;
  let facts: InstanceFacts;
  try {
    facts = await instanceFacts(deps, admin);
    if (target.instanceKey && target.instanceKey !== `postgresql:${facts.systemIdentifier}`) {
      throw new DatabaseRunFailure(
        "db_instance_changed",
        "Another instance answers under the target's address.",
      );
    }
    if (!facts.canCreateDb) {
      throw new DatabaseRunFailure(
        "db_permission_missing",
        "The target's user may not create databases (CREATEDB).",
      );
    }
    if (facts.databases.some((database) => database.name === name)) {
      throw new DatabaseRunFailure("db_restore_name_taken", "A database of that name exists.");
    }
    try {
      await admin.query(`CREATE DATABASE ${pgQuoteIdent(name)} TEMPLATE template0`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseRunFailure(
        /already exists/.test(message) ? "db_restore_name_taken" : "db_restore_failed",
        message,
      );
    }
    const [created] = await admin.query(
      `SELECT oid::text FROM pg_database WHERE datname = ${pgQuoteLiteral(name)}`,
    );
    createdOid = created?.[0] ?? null;
    await withTenantTx(deps.db, run.tenantId, (tx) =>
      tx.update(databaseRuns).set({ targetOid: createdOid }).where(eq(databaseRuns.id, run.id)),
    );
  } finally {
    admin.close();
  }
  try {
    const tools = await (deps.tools ?? choosePgTools)(facts.serverMajor);
    if (!tools.ok) {
      throw new DatabaseRunFailure(tools.code, tools.message);
    }
    const access = await ensureDatabaseRepository(deps, source);
    await restoreInto(access, backup, prepared, tools.tools.path("pg_restore"), name);
    await finishRun(deps, run, { status: "succeeded", targetOid: createdOid });
  } catch (error) {
    // Only the database this run created, by its recorded name and OID, never by a pattern.
    if (createdOid) {
      await dropCreated(prepared, target, name, createdOid).catch(() => undefined);
    }
    throw error;
  }
}

async function restoreInto(
  access: RepositoryAccess,
  backup: { snapshotId: string; fileName: string; sha256: string },
  prepared: Prepared,
  pgRestore: string,
  name: string,
): Promise<void> {
  const dir = await privateTempDir("restow-db-restore-");
  try {
    const passFile = await writePgPassFile(dir, prepared.credentials.password ?? "");
    await withRepository(access, async (session) => {
      const relay = await openPgRelay({
        target: prepared.target,
        network: prepared.network,
        maxDurationMs: PROGRAM_MAX_MS,
      });
      if (!relay.ok) {
        throw new DatabaseRunFailure(relay.code, relay.message);
      }
      try {
        const dump = resticDump(session, backup.snapshotId, `/${backup.fileName}`);
        const hash = createHash("sha256");
        let stderr = "";
        const child = spawn(pgRestore, pgRestoreArgs(name), {
          env: pgToolEnv({
            socketDir: relay.relay.socketDir,
            port: relay.relay.port,
            user: prepared.credentials.user,
            passFile,
          }),
          stdio: ["pipe", "ignore", "pipe"],
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4096);
        });
        child.stdin.on("error", () => undefined);
        dump.stream.on("data", (chunk: Buffer) => hash.update(chunk));
        dump.stream.pipe(child.stdin);
        const code = await new Promise<number | null>((resolve) => {
          child.on("error", () => resolve(null));
          child.on("close", resolve);
        });
        await dump.done.catch((error: unknown) => {
          throw new DatabaseRunFailure(
            "db_restore_failed",
            `the backup could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        if (hash.digest("hex") !== backup.sha256) {
          throw new DatabaseRunFailure(
            "db_backup_mismatch",
            "The backup's SHA-256 differs from the one recorded.",
          );
        }
        if (code !== 0) {
          throw new DatabaseRunFailure("db_restore_failed", stderr.trim() || "pg_restore failed");
        }
      } finally {
        relay.relay.close();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function dropCreated(
  prepared: Prepared,
  target: DatabaseConnection,
  name: string,
  oid: string,
): Promise<void> {
  const session = await adminSession(prepared, target.loginDatabase ?? "postgres");
  try {
    const [row] = await session.query(
      `SELECT oid::text FROM pg_database WHERE datname = ${pgQuoteLiteral(name)}`,
    );
    if (row?.[0] === oid) {
      await session.query(`DROP DATABASE ${pgQuoteIdent(name)}`);
    }
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Retention (4.4, 9): decided by the server, per database
// ---------------------------------------------------------------------------

/** Retention runs at most this often per connection. */
const RETENTION_EVERY_MS = 24 * 60 * MINUTE_MS;

/** Retention runs at most this many connections per pass, the longest unchecked first. */
const RETENTION_PER_PASS = 20;

/** A snapshot id restic forgets exactly: the full 64 hex characters, never a prefix. */
const FULL_SNAPSHOT_ID = /^[0-9a-f]{64}$/;

/**
 * Keep a connection's repository to its retention (4.4, 5.1: per database, group
 * `db:<connection>:<database>`; the instance's globals are a group of their own): the server
 * decides from the backups it recorded (a server run's own, an agent's after the server found the
 * snapshot in the repository), dated by the server, never restic's own rules, so an agent cannot
 * push genuine backups out. Only full snapshot ids that the repository lists for this connection
 * are forgotten; snapshots no run reported are never touched. The forgotten ones turn `pruned`,
 * then restic prunes. `deferred`: a run of the connection is active, retention comes back soon.
 * D3 keeps the default of the machines (30 daily, 12 weekly, 12 monthly).
 */
export async function databaseRetention(
  deps: DatabaseRunDeps,
  connection: DatabaseConnection,
): Promise<{ forgotten: number; deferred?: true }> {
  const [active] = await withTenantTx(deps.db, connection.tenantId, (tx) =>
    tx
      .select({ id: databaseRuns.id })
      .from(databaseRuns)
      .where(
        and(
          eq(databaseRuns.connectionId, connection.id),
          inArray(databaseRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1),
  );
  if (active) {
    return { forgotten: 0, deferred: true };
  }
  if (!connection.repositorySecretId) {
    return { forgotten: 0 };
  }
  const rows = (
    await withTenantTx(deps.db, connection.tenantId, (tx) =>
      tx
        .select()
        .from(databaseBackups)
        .where(
          and(
            eq(databaseBackups.connectionId, connection.id),
            eq(databaseBackups.status, "active"),
          ),
        ),
    )
  ).filter((row) => FULL_SNAPSHOT_ID.test(row.snapshotId));
  const groups = new Map<string, { id: string; time: Date }[]>();
  for (const row of rows) {
    const group = `db:${connection.id}:${row.kind === "globals" ? "globals" : (row.databaseId ?? row.databaseName)}`;
    groups.set(group, [...(groups.get(group) ?? []), { id: row.snapshotId, time: row.finishedAt }]);
  }
  const remove: string[] = [];
  for (const snapshots of groups.values()) {
    remove.push(
      ...applyRetentionPolicy(snapshots, DEFAULT_ENDPOINT_RETENTION, connection.schedule.timeZone)
        .remove,
    );
  }
  if (remove.length === 0) {
    return { forgotten: 0 };
  }
  const { tenantId } = connection;
  const context = { tenantId, connectionId: connection.id };
  // Write-once storage (docs/STORAGE.md, "Write-once storage"): forget and prune would only fail
  // on every deletion; every backup stays.
  if (await deps.primaryWriteOnce(tenantId)) {
    deps.logger.info(
      "database retention: not applied, the primary storage target of the tenant is write-once",
      context,
    );
    return { forgotten: 0 };
  }
  // A "move" storage migration copies the repository file by file: retention waits for it.
  if (await hasActiveMigration(tenantRunner(deps.db, tenantId), tenantId)) {
    return { forgotten: 0 };
  }
  // Restore mode after restoring a database dump (docs/STORAGE.md): nothing is deleted.
  const deletions = await deletionDecision({ pass: "database_retention", tenantId });
  if (!deletions.allowed) {
    deps.logger.warn("database retention held: deleting is paused", {
      ...context,
      reason: deletions.reason,
    });
    return { forgotten: 0 };
  }
  const ensured = await ensureDatabaseRepository(deps, connection);
  // A deletion the storage refuses (Object Lock, deletion delay) is recorded for the renewal.
  const access: RepositoryAccess = {
    ...ensured,
    onDeletionDeferred: (key, retainUntil) =>
      recordDeferredDeletion(deps.db, tenantId, ensured.storage, key, retainUntil),
  };
  // restic's deletes through the loopback carry this permit (storage/deletion-guard.ts).
  const gone = await withDeletionPermit({ pass: "database_retention", tenantId }, () =>
    withRepository(access, async (session) => {
      const listed = new Set(
        (await resticSnapshots(session))
          .filter(
            (snapshot) =>
              snapshot.hostname === "restow-db" &&
              snapshot.tags.includes(`restow-db-connection=${connection.id}`),
          )
          .map((snapshot) => snapshot.id),
      );
      const forget = remove.filter((id) => listed.has(id));
      if (forget.length > 0) {
        await resticForget(session, forget);
        await resticPrune(session, { storage: access.storage });
      }
      return forget;
    }),
  );
  // What the repository no longer lists is gone as well; only `gone` was forgotten here.
  await withTenantTx(deps.db, connection.tenantId, (tx) =>
    tx
      .update(databaseBackups)
      .set({ status: "pruned", prunedAt: deps.now() })
      .where(
        and(
          eq(databaseBackups.connectionId, connection.id),
          inArray(databaseBackups.snapshotId, remove),
        ),
      ),
  );
  return { forgotten: gone.length };
}

/**
 * Retention once a day per connection with active backups: the longest unchecked first, at most
 * {@link RETENTION_PER_PASS} per pass, taking the tenants in turn (one tenant's many connections
 * do not hold back the others'). A connection with an active run comes back on the next pass.
 */
async function retentionPass(deps: DatabaseRunDeps): Promise<number> {
  const now = deps.now();
  const due = new Date(now.getTime() - RETENTION_EVERY_MS);
  const candidates = rowsOf<{ id: string; tenant_id: string }>(
    await deps.providerDb.execute(sql`
      SELECT id, tenant_id FROM (
        SELECT c.id, c.tenant_id, c.retention_checked_at,
               row_number() OVER (
                 PARTITION BY c.tenant_id ORDER BY c.retention_checked_at NULLS FIRST, c.id
               ) AS turn
          FROM database_connections c
         WHERE (c.retention_checked_at IS NULL OR c.retention_checked_at < ${due.toISOString()}::timestamptz)
           AND EXISTS (SELECT 1 FROM database_backups b
                        WHERE b.connection_id = c.id AND b.status = 'active')
      ) d
      ORDER BY turn, retention_checked_at NULLS FIRST, id
      LIMIT ${RETENTION_PER_PASS}`),
  );
  let forgotten = 0;
  for (const row of candidates) {
    const [connection] = await withTenantTx(deps.db, row.tenant_id, (tx) =>
      tx.select().from(databaseConnections).where(eq(databaseConnections.id, row.id)).limit(1),
    );
    if (!connection) {
      continue;
    }
    let deferred = false;
    try {
      const outcome = await databaseRetention(deps, connection);
      forgotten += outcome.forgotten;
      deferred = outcome.deferred === true;
    } catch (error) {
      deps.logger.error("database retention failed", {
        tenantId: row.tenant_id,
        connectionId: row.id,
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
    if (!deferred) {
      await withTenantTx(deps.db, row.tenant_id, (tx) =>
        tx
          .update(databaseConnections)
          .set({ retentionCheckedAt: now })
          .where(eq(databaseConnections.id, row.id)),
      );
    }
  }
  return forgotten;
}

/** The latest backups of a connection (tests, the API). */
export async function latestBackups(db: Database, tenantId: string, connectionId: string) {
  return withTenantTx(db, tenantId, (tx) =>
    tx
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.connectionId, connectionId))
      .orderBy(desc(databaseBackups.finishedAt)),
  );
}

/** Start the planning pass every minute in one worker of the installation at a time. */
export function startDatabaseRuns(
  deps: DatabaseRunDeps,
  shutdownSignal: AbortSignal,
  intervalMs = DATABASE_RUNS_PASS_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // What crashed runs left in memory (the relay's sockets, password files): older than any run.
  void sweepStaleTempDirs({ maxAgeMs: RUN_MAX_MS + 60 * MINUTE_MS })
    .then((removed) => {
      if (removed > 0) {
        deps.logger.info("database runs: stale directories removed", { removed });
      }
    })
    .catch(() => undefined);
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
      if (rows[0]?.locked) {
        try {
          const summary = await databaseRunsPass(deps);
          if (summary.planned + summary.expired > 0) {
            deps.logger.info("database runs pass", { ...summary });
          }
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
        }
      }
    } catch (error) {
      deps.logger.error("database runs pass failed", {
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    } finally {
      client.release();
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  timer = setTimeout(() => void tick(), 30_000);
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
