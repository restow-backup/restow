import { randomUUID } from "node:crypto";
import {
  compareDbInstance,
  DB_DEFAULT_INTERVAL_MINUTES,
  DB_RUNNER_OFFLINE_AFTER_MS,
  type DbEngine,
  type DbProbeResult,
  type DbProbeSpec,
  type DbRights,
  type DbServerProbeOptions,
  dbApprovedAddress,
  dbCanonicalAddress,
  dbExecutorRefusal,
  dbFoundDatabases,
  dbInstanceIdentityOf,
  dbInstanceKey,
  dbListRank,
  evaluateDbRights,
  formatDbAddress,
  type HostResolver,
  hasDbRunnerCapability,
  isDbErrorCode,
  judgeDbHost,
  parseDbAddress,
  parseDbProbeResult,
  probeDatabaseFromServer,
  rateDatabase,
  sanitizeDbMessage,
  systemResolver,
} from "@restow/core";
import {
  type DatabaseConnection,
  type DatabaseConnectionCheck,
  type DatabaseProbe,
  type DatabaseSelection,
  databaseBackups,
  databaseConnections,
  databaseProbes,
  databaseRuns,
  databases,
  type Endpoint,
  endpoints,
  endpointTasks,
  type ProtectedDatabase,
} from "@restow/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, max, or, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { deleteSecret, readSecret, replaceSecret, storeSecret } from "../../lib/secrets.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { restoreModeTaskHoldBefore } from "../restore-mode/hold.js";
import {
  DATABASE_AUDIT_ACTIONS as A,
  AGENT_PROBE_TTL_MS,
  DATABASE_PROBLEMS as P,
  PROBE_CREDENTIALS_KEEP_MS,
  PROBE_KEEP_MS,
  PROBE_LIMIT,
  PROBE_WINDOW_MS,
  SERVER_PROBE_TIMEOUT_SECONDS,
  SERVER_PROBES_PER_TENANT,
  SERVER_PROBES_TOTAL,
} from "./constants.js";
import {
  type DatabaseHealthDto,
  type HealthBandHour,
  healthBands,
  healthDto,
} from "./health-dto.js";
import {
  databaseUrlTargets,
  type OwnDatabaseTarget,
  OwnDatabaseUnknownError,
} from "./own-database.js";
import type {
  CreateConnectionInput,
  TestConnectionInput,
  UpdateConnectionInput,
} from "./schemas.js";

/**
 * The module "Databases", stage D1 (docs/DATABASES.md 2, 3, 4, 9, 10): connections and the
 * databases they found, "Test connection" through an agent or the Restow server, credentials in
 * the secret store, the TLS fingerprint, the network protection of the server executor and the
 * suggestions from the agents' inventories; the health of each connection as the worker keeps it
 * (D2, ./health.ts for the history and the agents' checks). Backups and checks come with D3 to D6.
 *
 * The server judges, the executor reports facts: a test result (@restow/core `DbProbeResult`) is
 * checked, its messages are cleaned of the credentials once more, and saving a connection takes
 * its engine, address, identity, certificate and databases from a stored test, never from the
 * browser. Credentials are written, never read back: an answer says `credential: "set"`.
 */

/** Who acts, and what the tests may use instead of the network (tests). */
export interface DatabaseContext {
  actor: { label: string; userId: string | null; ip: string | null };
  isProviderAdmin: boolean;
  now?: Date;
  /** Tests: the name resolution of the network protection. */
  resolve?: HostResolver;
  /** Tests: the server's probe. */
  probe?: (spec: DbProbeSpec, options: DbServerProbeOptions) => Promise<DbProbeResult>;
  /** Tests: the system identifier of Restow's own database. */
  ownSystemIdentifier?: () => Promise<string | null>;
  /** Tests: the addresses and ports Restow's own database listens on. */
  ownDatabaseTargets?: () => Promise<OwnDatabaseTarget[]>;
  /** Tests: `RESTOW_DB_ALLOW_PRIVATE_NETWORKS`. */
  privateNetworksAllowed?: boolean;
  /** Tests: `RESTOW_DB_SERVER_CONNECTIONS_PER_TENANT`. */
  serverConnectionsPerTenant?: number;
}

const nowOf = (ctx: Pick<DatabaseContext, "now">) => ctx.now ?? new Date();
const privateAllowedOf = (ctx: DatabaseContext) =>
  ctx.privateNetworksAllowed ?? config.dbAllowPrivateNetworks;

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

function notFound(what = "Database connection"): ProblemError {
  return new ProblemError(404, `${what} not found`);
}

function invalid(field: string, detail: string, type: string = P.invalid): ProblemError {
  return new ProblemError(422, "Invalid database connection", {
    type,
    detail,
    extensions: { field, issues: [{ path: [field], message: detail }] },
  });
}

function hostNotAllowed(reason: "db_private_network" | "db_forbidden_address"): ProblemError {
  return new ProblemError(422, "Address not allowed", {
    type: P.hostNotAllowed,
    detail:
      reason === "db_private_network"
        ? "The address is in a loopback or private network, or a container name. Only a provider admin can approve it for the Restow server; an agent in that network can open it."
        : "The address is link-local, multicast or reserved (such as a cloud metadata service). The Restow server never connects there.",
    extensions: { field: "address", reason },
  });
}

async function assertNoRestoreMode(): Promise<void> {
  // Restore mode (docs/DATABASES.md 10): no runs and no tests with credentials until it is lifted.
  if ((await restoreModeTaskHoldBefore()) !== null) {
    throw new ProblemError(409, "Restore mode is on", {
      type: "urn:restow:problem:restore-mode",
      detail:
        "Database connections are not tested while the installation is in restore mode; a provider owner ends it after checking the restored database.",
    });
  }
}

// ---------------------------------------------------------------------------
// Rate limit of tests (a tenant admin must not scan ports through Restow)
// ---------------------------------------------------------------------------

/**
 * Take one of the tenant's tests in the window, counted from the stored tests (every test is a
 * row, a refused address included), so a restart or another api replica starts from the same
 * count. The advisory lock makes two requests of one tenant count one after the other.
 */
async function takeProbeSlot(tx: Transaction, tenantId: string, now: Date): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`restow:database_probes:${tenantId}`}))`,
  );
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(databaseProbes)
    .where(
      and(
        eq(databaseProbes.tenantId, tenantId),
        gt(databaseProbes.createdAt, new Date(now.getTime() - PROBE_WINDOW_MS)),
      ),
    );
  if (Number(row?.count ?? 0) >= PROBE_LIMIT) {
    throw new ProblemError(429, "Too many connection tests", {
      type: P.probeLimit,
      detail: `At most ${PROBE_LIMIT} connection tests in ten minutes. Try again later.`,
    });
  }
}

/**
 * Room for one more connection of the tenant on the Restow server (4.2): at most
 * `RESTOW_DB_SERVER_CONNECTIONS_PER_TENANT`, counted in the transaction that saves it (an
 * advisory lock per tenant, so two saves count one after the other). Its health checks share the
 * worker's pass with every other tenant; more connections run on an agent.
 */
async function assertServerConnectionRoom(
  tx: Transaction,
  tenantId: string,
  ctx: DatabaseContext,
): Promise<void> {
  const limit = ctx.serverConnectionsPerTenant ?? config.dbServerConnectionsPerTenant;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`restow:database_server_connections:${tenantId}`}))`,
  );
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(databaseConnections)
    .where(
      and(
        eq(databaseConnections.tenantId, tenantId),
        eq(databaseConnections.executorKind, "server"),
      ),
    );
  if (Number(row?.count ?? 0) >= limit) {
    throw new ProblemError(422, "Too many connections on the Restow server", {
      type: P.serverConnectionLimit,
      detail: `At most ${limit} database connections of a tenant run on the Restow server. Run this one on an agent.`,
      extensions: { field: "executor", limit },
    });
  }
}

/** Tests of the Restow server running in this process, per tenant and in all. */
const runningServerProbes = new Map<string, number>();
let runningServerProbesTotal = 0;

/** Hold one of the server's test runs; the answer releases it. */
function takeServerProbeRun(tenantId: string): () => void {
  const mine = runningServerProbes.get(tenantId) ?? 0;
  if (mine >= SERVER_PROBES_PER_TENANT || runningServerProbesTotal >= SERVER_PROBES_TOTAL) {
    throw new ProblemError(429, "Connection tests busy", {
      type: P.probeBusy,
      detail: "Other connection tests are running. Try again in a moment.",
    });
  }
  runningServerProbes.set(tenantId, mine + 1);
  runningServerProbesTotal += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    runningServerProbesTotal -= 1;
    const left = (runningServerProbes.get(tenantId) ?? 1) - 1;
    if (left > 0) {
      runningServerProbes.set(tenantId, left);
    } else {
      runningServerProbes.delete(tenantId);
    }
  };
}

/** Tests: forget the running tests counted so far (the window is counted from the rows). */
export function resetDatabaseProbeLimit(): void {
  runningServerProbes.clear();
  runningServerProbesTotal = 0;
}

// ---------------------------------------------------------------------------
// Restow's own database (4.2: never the own database)
// ---------------------------------------------------------------------------

/** The system identifier of Restow's own cluster, for the agents' health checks (D2). */
export function restowSystemIdentifier(): Promise<string | null> {
  return ownSystemIdentifier({
    actor: { label: "agent", userId: null, ip: null },
    isProviderAdmin: false,
  });
}

let ownIdentifier: Promise<string | null> | null = null;

/** The system identifier of the cluster that holds Restow's database (read once). */
async function ownSystemIdentifier(ctx: DatabaseContext): Promise<string | null> {
  if (ctx.ownSystemIdentifier) {
    return ctx.ownSystemIdentifier();
  }
  ownIdentifier ??= providerDb
    .execute(sql`SELECT system_identifier::text AS id FROM pg_control_system()`)
    .then((result) => {
      const rows = (result as unknown as { rows?: { id?: string }[] }).rows ?? [];
      return rows[0]?.id ?? null;
    })
    .catch(() => {
      ownIdentifier = null;
      return null;
    });
  return ownIdentifier;
}

let ownTargets: { at: number; targets: OwnDatabaseTarget[] } | null = null;
const OWN_TARGETS_KEEP_MS = 5 * 60 * 1000;

/**
 * The addresses and ports of Restow's own database (4.2), from `DATABASE_URL` and
 * `DATABASE_PROVIDER_URL`: the server executor refuses them by the address it reached, before it
 * signs in (the system identifier after the sign-in is the backstop). A result is kept a few
 * minutes; a failure is not kept, and a test of the Restow server is refused while it lasts.
 */
async function ownDatabaseTargets(ctx: DatabaseContext): Promise<OwnDatabaseTarget[]> {
  const now = Date.now();
  if (!ctx.ownDatabaseTargets && ownTargets && now - ownTargets.at <= OWN_TARGETS_KEEP_MS) {
    return ownTargets.targets;
  }
  try {
    if (ctx.ownDatabaseTargets) {
      return await ctx.ownDatabaseTargets();
    }
    const urls = [config.databaseUrl, config.databaseProviderUrl].filter((url) => url !== "");
    if (urls.length === 0) {
      throw new OwnDatabaseUnknownError("no database URL is configured");
    }
    const lists = await Promise.all(urls.map((url) => databaseUrlTargets(url, systemResolver)));
    ownTargets = { at: now, targets: lists.flat() };
    return ownTargets.targets;
  } catch (error) {
    if (!ctx.ownDatabaseTargets) {
      ownTargets = null;
    }
    throw new ProblemError(503, "Restow's own database cannot be located", {
      type: P.ownDatabaseUnknown,
      detail: `The Restow server does not test connections while it cannot tell where its own database is (${
        error instanceof OwnDatabaseUnknownError ? error.message : "unknown error"
      }). Try again in a moment.`,
    });
  }
}

/**
 * The result as the server keeps it: messages cleaned once more of the credentials, and a
 * PostgreSQL that is Restow's own database refused without any of its facts (4.2).
 */
async function judgeResult(
  raw: unknown,
  secrets: { user?: string | null; password?: string | null },
  ctx: DatabaseContext,
): Promise<DbProbeResult> {
  const parsed = parseDbProbeResult(raw);
  if (!parsed) {
    return {
      engine: null,
      port: null,
      serverVersion: null,
      tls: {
        offered: null,
        used: false,
        fingerprintSha256: null,
        subject: null,
        issuer: null,
        notAfter: null,
      },
      login: "skipped",
      error: { code: "db_probe_failed", message: "The executor's answer was not understood." },
      durationMs: 0,
    };
  }
  const result: DbProbeResult = {
    ...parsed,
    error: parsed.error
      ? { code: parsed.error.code, message: sanitizeDbMessage(parsed.error.message, secrets) }
      : null,
    // The user is part of the credentials (3.2): the facts keep what it may do, not its name.
    ...(parsed.postgresql ? { postgresql: { ...parsed.postgresql, currentUser: "" } } : {}),
    ...(parsed.mysql
      ? {
          mysql: {
            ...parsed.mysql,
            currentUser: "",
            grants: parsed.mysql.grants.map((grant) => hideUser(grant, secrets.user)),
          },
        }
      : {}),
  };
  if (result.engine === "postgresql" && result.postgresql?.systemIdentifier) {
    const own = await ownSystemIdentifier(ctx);
    if (own !== null && own === result.postgresql.systemIdentifier) {
      const { postgresql: _hidden, ...rest } = result;
      return {
        ...rest,
        login: "skipped",
        error: {
          code: "db_target_is_restow",
          message:
            "This is the database of this Restow installation. It is backed up as described in the backup guide of the installation, not by this module.",
        },
      };
    }
  }
  return result;
}

/** A grant line without the user's name (`TO \`***\`@\`%\``); its rights stay readable. */
function hideUser(grant: string, user: string | null | undefined): string {
  const named = grant.replace(/\bTO\s+(`[^`]*`|'[^']*'|"[^"]*"|\S+?)(@|\s|$)/i, "TO `***`$2");
  return user ? sanitizeDbMessage(named, { user }) : named;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

async function loadAgent(tx: Transaction, tenantId: string, endpointId: string): Promise<Endpoint> {
  const [endpoint] = await tx
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.tenantId, tenantId),
        eq(endpoints.id, endpointId),
        isNull(endpoints.removedAt),
      ),
    )
    .limit(1);
  if (!endpoint) {
    throw invalid("executor", "The machine of the executor does not exist.", P.executor);
  }
  if (endpoint.status !== "active") {
    throw invalid("executor", "The machine of the executor is revoked.", P.executor);
  }
  if (!hasDbRunnerCapability(endpoint.settings.agent?.capabilities)) {
    throw invalid(
      "executor",
      "The agent on this machine cannot run database connections yet. Update it to 0.6.0 or later.",
      P.executor,
    );
  }
  return endpoint;
}

function assertExecutorFits(
  kind: "agent" | "server",
  engine: DbEngine | null,
  authMethod: "password" | "socket",
  endpoint: Endpoint | null,
): void {
  const refusal = dbExecutorRefusal(kind, engine, authMethod);
  if (refusal === "engine_needs_agent") {
    throw invalid(
      "executor",
      "SQLite and SQL Server are opened by an agent on their own machine, not by the Restow server.",
      P.executor,
    );
  }
  if (refusal === "socket_needs_agent") {
    throw invalid(
      "authMethod",
      "The sign-in over the local socket needs an agent on the database machine.",
      P.executor,
    );
  }
  if (authMethod === "socket" && endpoint && endpoint.os !== "linux") {
    throw invalid(
      "authMethod",
      "The sign-in over the local socket needs a Linux agent.",
      P.executor,
    );
  }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface DatabaseProbeDto {
  id: string;
  status: DatabaseProbe["status"];
  executor: { kind: "agent" | "server"; endpointId: string | null };
  address: string;
  engine: DbEngine | null;
  serverVersion: string | null;
  port: number | null;
  tls: DbProbeResult["tls"] | null;
  login: DbProbeResult["login"] | null;
  error: DbProbeResult["error"];
  rights: DbRights | null;
  databases: { name: string; sizeBytes: number | null; accessible: boolean }[];
  /** The instance has an identity Restow can follow (3.3). */
  identityKnown: boolean;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
}

function specAddress(spec: Record<string, unknown>): string {
  return formatDbAddress({
    host: typeof spec.host === "string" ? spec.host : null,
    port: typeof spec.port === "number" ? spec.port : null,
    path: typeof spec.path === "string" ? spec.path : null,
  });
}

export function probeDto(probe: DatabaseProbe): DatabaseProbeDto {
  const result = probe.result ? parseDbProbeResult(probe.result) : null;
  return {
    id: probe.id,
    status: probe.status,
    executor: { kind: probe.executorKind, endpointId: probe.executorEndpointId },
    address: specAddress(probe.spec),
    engine: result?.engine ?? null,
    serverVersion: result?.serverVersion ?? null,
    port: result?.port ?? null,
    tls: result?.tls ?? null,
    login: result?.login ?? null,
    error:
      result?.error ??
      (probe.errorCode
        ? {
            code: isDbErrorCode(probe.errorCode) ? probe.errorCode : "db_probe_failed",
            message: "",
          }
        : null),
    rights: result ? evaluateDbRights(result) : null,
    databases: result
      ? dbFoundDatabases(result).map(({ name, sizeBytes, accessible }) => ({
          name,
          sizeBytes,
          accessible,
        }))
      : [],
    identityKnown: result ? dbInstanceIdentityOf(result) !== null : false,
    createdAt: probe.createdAt.toISOString(),
    finishedAt: probe.finishedAt?.toISOString() ?? null,
    expiresAt: probe.expiresAt.toISOString(),
  };
}

export type ConnectionState = "ok" | "attention" | "red" | "unchecked";

export interface DatabaseConnectionDto {
  id: string;
  name: string;
  engine: DbEngine;
  address: string;
  host: string | null;
  port: number | null;
  path: string | null;
  executor: {
    kind: "agent" | "server";
    endpointId: string | null;
    hostname: string | null;
    /** null for the server; false when the agent has not been seen for 15 minutes (4.3). */
    online: boolean | null;
    lastSeenAt: string | null;
  };
  authMethod: "password" | "socket";
  /** Whether a credential is stored; never the credential. */
  credential: "set" | "none";
  allowUnencrypted: boolean;
  tls: {
    fingerprint: string | null;
    subject: string | null;
    issuer: string | null;
    notAfter: string | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
  };
  privateNetworkApproval: { by: string; at: string; addresses?: string[] } | null;
  mode: DatabaseConnection["mode"];
  schedule: DatabaseConnection["schedule"];
  selection: DatabaseSelection;
  identityKnown: boolean;
  serverVersion: string | null;
  lastCheck: DatabaseConnectionCheck | null;
  /** The health checks (8): interval, reachability and the current episode. */
  health: DatabaseHealthDto;
  state: ConnectionState;
  /** Codes the page explains: db_unencrypted, db_runner_offline, db_tls_changed, ... */
  notices: string[];
  enabled: boolean;
  databaseCount: number;
  createdAt: string;
  updatedAt: string;
}

const RED_CODES = new Set([
  "db_tls_changed",
  "db_instance_changed",
  "db_engine_changed",
  "db_target_is_restow",
  "db_tls_missing",
]);

function stateOf(connection: DatabaseConnection, runnerOffline: boolean): ConnectionState {
  const code = connection.lastCheck?.errorCode ?? null;
  // A health check that sees another certificate, instance or engine is as red as a test (D2).
  const healthCode = connection.health?.lastOk === false ? connection.health.errorCode : null;
  if ((code && RED_CODES.has(code)) || (healthCode && RED_CODES.has(healthCode))) {
    return "red";
  }
  if (
    code ||
    healthCode ||
    runnerOffline ||
    (!connection.executorEndpointId && connection.executorKind === "agent")
  ) {
    return "attention";
  }
  return connection.lastCheck ? "ok" : "unchecked";
}

function connectionDto(
  connection: DatabaseConnection,
  executor: Pick<Endpoint, "hostname" | "lastSeenAt"> | null,
  databaseCount: number,
  now: Date,
): DatabaseConnectionDto {
  const runnerOffline =
    connection.executorKind === "agent" &&
    (!executor?.lastSeenAt ||
      now.getTime() - executor.lastSeenAt.getTime() > DB_RUNNER_OFFLINE_AFTER_MS);
  const notices: string[] = [];
  if (connection.allowUnencrypted && !connection.tlsFingerprint) {
    notices.push("db_unencrypted");
  }
  if (runnerOffline) {
    notices.push("db_runner_offline");
  }
  const code = connection.lastCheck?.errorCode;
  if (code) {
    notices.push(code);
  }
  const health = healthDto(connection, now);
  if (health.errorCode && RED_CODES.has(health.errorCode)) {
    notices.push(health.errorCode);
  }
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    address: formatDbAddress(connection),
    host: connection.host,
    port: connection.port,
    path: connection.path,
    executor: {
      kind: connection.executorKind,
      endpointId: connection.executorEndpointId,
      hostname: executor?.hostname ?? null,
      online: connection.executorKind === "server" ? null : !runnerOffline,
      lastSeenAt: executor?.lastSeenAt?.toISOString() ?? null,
    },
    authMethod: connection.authMethod,
    credential: connection.credentialSecretId ? "set" : "none",
    allowUnencrypted: connection.allowUnencrypted,
    tls: {
      fingerprint: connection.tlsFingerprint,
      subject: connection.tlsSubject,
      issuer: connection.tlsIssuer,
      notAfter: connection.tlsNotAfter?.toISOString() ?? null,
      confirmedAt: connection.tlsConfirmedAt?.toISOString() ?? null,
      confirmedBy: connection.tlsConfirmedBy,
    },
    privateNetworkApproval: connection.privateNetworkApproval ?? null,
    mode: connection.mode,
    schedule: connection.schedule,
    selection: connection.selection,
    identityKnown: connection.instanceKey !== null,
    serverVersion: connection.serverVersion,
    lastCheck: connection.lastCheck ?? null,
    health,
    state: stateOf(connection, runnerOffline),
    notices: [...new Set(notices)],
    enabled: connection.enabled,
    databaseCount,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

function isExcluded(selection: DatabaseSelection, name: string): boolean {
  return selection.mode === "selected"
    ? !selection.names.includes(name)
    : selection.exclude.includes(name);
}

export interface DatabaseDto {
  id: string;
  name: string;
  connectionId: string;
  connectionName: string;
  engine: DbEngine;
  mode: DatabaseConnection["mode"];
  sizeBytes: number | null;
  /** PostgreSQL: the OID is known; MySQL and MariaDB schemas are known by their name (3.3). */
  identityByName: boolean;
  accessible: boolean;
  excluded: boolean;
  droppedAt: string | null;
  lastBackupAt: string | null;
  lastCheckAt: string | null;
  /**
   * From the connection's health checks (D2, 8), before the first one from its last test: true,
   * false or unknown. Beside the rating, never part of it (2.4).
   */
  reachable: boolean | null;
  reachability: DatabaseHealthDto["reachability"];
  /** The last 24 hours of the connection's health checks, hour by hour (the list only). */
  band?: HealthBandHour[];
  rating: ReturnType<typeof rateDatabase>;
  firstSeenAt: string;
}

/** The newest active backup of each database (D3), by database id. */
async function lastBackupsOf(tx: Transaction, ids: readonly string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: databaseBackups.databaseId, at: max(databaseBackups.finishedAt) })
    .from(databaseBackups)
    .where(and(inArray(databaseBackups.databaseId, [...ids]), eq(databaseBackups.status, "active")))
    .groupBy(databaseBackups.databaseId);
  return new Map(
    rows
      .filter((row) => row.id && row.at)
      .map((row) => [row.id as string, new Date(row.at as Date)]),
  );
}

function databaseDto(
  row: ProtectedDatabase,
  connection: DatabaseConnection,
  now: Date,
  lastBackup: Date | null = null,
): DatabaseDto {
  const excluded =
    !connection.enabled || row.droppedAt !== null || isExcluded(connection.selection, row.name);
  const code = connection.lastCheck?.errorCode ?? null;
  const health = healthDto(connection, now);
  const reachable = connection.health?.lastAt
    ? health.reachability === "unknown"
      ? null
      : health.reachability !== "unreachable"
    : connection.lastCheck
      ? !(code === "db_unreachable" || code === "db_runner_offline")
      : null;
  return {
    id: row.id,
    name: row.name,
    connectionId: connection.id,
    connectionName: connection.name,
    engine: connection.engine,
    mode: connection.mode,
    sizeBytes: row.sizeBytes,
    identityByName: row.identity === null,
    accessible: row.accessible,
    excluded,
    droppedAt: row.droppedAt?.toISOString() ?? null,
    // Backups (D3) feed the first; checks (D6) the second: a backed-up database is unverified.
    lastBackupAt: lastBackup?.toISOString() ?? null,
    lastCheckAt: null,
    reachable,
    reachability: health.reachability,
    rating: rateDatabase({
      excluded,
      lastBackupAt: lastBackup,
      lastGreenCheckAt: null,
      lastCheckRed: false,
      intervalMinutes: connection.schedule.intervalMinutes,
      now,
    }),
    firstSeenAt: row.firstSeenAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface Credentials {
  user: string | null;
  password: string | null;
}

async function readCredentials(
  tx: DbExecutor,
  tenantId: string,
  secretId: string | null,
): Promise<Credentials> {
  if (!secretId) {
    return { user: null, password: null };
  }
  const plaintext = await readSecret(tx, { id: secretId, tenantId });
  if (!plaintext) {
    return { user: null, password: null };
  }
  const parsed = JSON.parse(plaintext) as Partial<Credentials>;
  return { user: parsed.user ?? null, password: parsed.password ?? null };
}

// ---------------------------------------------------------------------------
// Tests ("Test connection", 3.2)
// ---------------------------------------------------------------------------

interface ProbeTarget {
  engine: DbEngine | null;
  host: string | null;
  port: number | null;
  path: string | null;
  database: string | null;
  authMethod: "password" | "socket";
  allowUnencrypted: boolean;
  executorKind: "agent" | "server";
  executorEndpointId: string | null;
  connectionId: string | null;
  /** A stored connection's approval of its private address. */
  approval: DbPrivateNetworkApproval | null;
  /** The certificate a stored connection confirmed: the executor checks it before signing in. */
  pinnedFingerprint: string | null;
}

type DbPrivateNetworkApproval = { by: string; at: string; addresses?: string[] };

/**
 * A provider admin's approval as it is stored: for the address the test connected to and signed
 * in on, never for what a lookup of its own finds (null without a private address to approve).
 */
function approvalFor(
  judged: DbPrivateNetworkApproval | null,
  result: DbProbeResult,
  ctx: DatabaseContext,
  now: Date,
): DbPrivateNetworkApproval | null {
  const connected = result.connectedAddress ?? null;
  if (!judged || !connected || !dbApprovedAddress({ addresses: [connected] }, connected)) {
    return null;
  }
  return { by: ctx.actor.label, at: now.toISOString(), addresses: [dbCanonicalAddress(connected)] };
}

function sameAddresses(a: DbPrivateNetworkApproval | null, b: DbPrivateNetworkApproval | null) {
  const list = (approval: DbPrivateNetworkApproval | null) =>
    [...(approval?.addresses ?? [])].sort().join(",");
  return list(a) === list(b);
}

/** Judge the address for the server executor; the approval to store when a provider admin saves it. */
async function judgeServerHost(
  host: string,
  ctx: DatabaseContext,
  approval: DbPrivateNetworkApproval | null,
): Promise<DbPrivateNetworkApproval | null> {
  const decision = await judgeDbHost(
    host,
    {
      isProviderAdmin: ctx.isProviderAdmin,
      privateNetworksAllowed: privateAllowedOf(ctx) || approval !== null,
      actorEmail: ctx.actor.label,
      now: nowOf(ctx),
    },
    ctx.resolve,
  );
  if (decision.kind === "refused") {
    throw hostNotAllowed(decision.reason);
  }
  return decision.approval ?? approval;
}

async function startProbe(
  db: DbExecutor,
  tenantId: string,
  target: ProbeTarget,
  credentials: Credentials,
  ctx: DatabaseContext,
): Promise<DatabaseProbeDto> {
  await assertNoRestoreMode();
  const now = nowOf(ctx);
  const probeId = randomUUID();
  const spec: Omit<DbProbeSpec, "user" | "password"> = {
    probeId,
    engine: target.engine,
    host: target.host,
    port: target.port,
    path: target.path,
    database: target.database,
    authMethod: target.authMethod,
    allowUnencrypted: target.allowUnencrypted,
    timeoutSeconds: SERVER_PROBE_TIMEOUT_SECONDS,
    pinnedFingerprintSha256: target.pinnedFingerprint,
  };
  // The credentials of a test are sealed with it: for the agent, which fetches them once, and
  // for settings that are not saved yet, so that saving takes exactly what was tested (3.2).
  const sealCredentials =
    target.authMethod === "password" &&
    (target.executorKind === "agent" || target.connectionId === null);
  const sealed = (tx: Transaction) =>
    sealCredentials
      ? storeSecret(tx, {
          tenantId,
          kind: "database_probe_credentials",
          plaintext: JSON.stringify(credentials),
        })
      : Promise.resolve(null);

  if (target.executorKind === "server") {
    const release = takeServerProbeRun(tenantId);
    try {
      // Where Restow's own database is, before anything is counted or stored.
      const forbiddenTargets = await ownDatabaseTargets(ctx);
      // The slot comes first: a test the network protection refuses counts, too.
      await withTenantTx(db, tenantId, async (tx) => {
        await cleanupProbes(tx, tenantId, now);
        await takeProbeSlot(tx, tenantId, now);
        const secret = await sealed(tx);
        await tx.insert(databaseProbes).values({
          id: probeId,
          tenantId,
          connectionId: target.connectionId,
          executorKind: "server",
          spec,
          credentialSecretId: secret?.id ?? null,
          status: "running",
          createdBy: ctx.actor.userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + (SERVER_PROBE_TIMEOUT_SECONDS + 60) * 1000),
        });
      });
      let approval: DbPrivateNetworkApproval | null = null;
      let raw: unknown;
      try {
        if (target.host) {
          approval = await judgeServerHost(target.host, ctx, target.approval);
        }
        const run = ctx.probe ?? probeDatabaseFromServer;
        raw = await run(
          { ...spec, user: credentials.user, password: credentials.password },
          {
            // A provider admin tests what they could approve by saving it (as for IMAP); a
            // stored approval reaches the addresses it was given for, no others.
            allowPrivateNetworks: privateAllowedOf(ctx) || ctx.isProviderAdmin,
            approvedAddresses: target.approval?.addresses ?? [],
            forbiddenTargets,
          },
        );
      } catch (error) {
        const reason =
          error instanceof ProblemError
            ? (error.extensions?.reason as string | undefined)
            : undefined;
        await withTenantTx(db, tenantId, (tx) =>
          tx
            .update(databaseProbes)
            .set({
              status: "failed",
              errorCode: reason && isDbErrorCode(reason) ? reason : "db_probe_failed",
              finishedAt: new Date(),
              expiresAt: new Date(now.getTime() + PROBE_KEEP_MS),
            })
            .where(and(eq(databaseProbes.tenantId, tenantId), eq(databaseProbes.id, probeId))),
        );
        throw error;
      }
      const result = await judgeResult(raw, credentials, ctx);
      return await withTenantTx(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(databaseProbes)
          .set({
            status: "done",
            result: result as unknown as Record<string, unknown>,
            errorCode: result.error?.code ?? null,
            finishedAt: new Date(),
            expiresAt: new Date(now.getTime() + PROBE_KEEP_MS),
          })
          .where(and(eq(databaseProbes.tenantId, tenantId), eq(databaseProbes.id, probeId)))
          .returning();
        if (!row) {
          throw new Error("probe update returned no row");
        }
        if (target.connectionId) {
          await applyProbeToConnection(tx, tenantId, target.connectionId, row, result, now);
          // A provider admin's good test of a stored connection with a private address renews
          // its approval for the address this test connected to and signed in on (audited).
          const renewed = approvalFor(approval, result, ctx, now);
          if (
            ctx.isProviderAdmin &&
            renewed &&
            result.login === "ok" &&
            !sameAddresses(renewed, target.approval)
          ) {
            await tx
              .update(databaseConnections)
              .set({ privateNetworkApproval: renewed, updatedAt: now })
              .where(
                and(
                  eq(databaseConnections.tenantId, tenantId),
                  eq(databaseConnections.id, target.connectionId),
                ),
              );
            await audit(tx, {
              tenantId,
              actor: ctx.actor.label,
              actorUserId: ctx.actor.userId,
              ip: ctx.actor.ip,
              action: A.privateNetworkApproved,
              target: target.connectionId,
              targetType: "database_connection",
              details: { address: target.host, addresses: renewed.addresses ?? [] },
            });
          }
        }
        return probeDto(row);
      });
    } finally {
      release();
    }
  }

  return withTenantTx(db, tenantId, async (tx) => {
    await cleanupProbes(tx, tenantId, now);
    await takeProbeSlot(tx, tenantId, now);
    const expiresAt = new Date(now.getTime() + AGENT_PROBE_TTL_MS);
    // The agent fetches the credentials once (GET /agent/v1/databases/probes/:id); they are
    // sealed for this probe alone and deleted when its result arrives (a stored connection)
    // or when they are saved or expire (unsaved settings).
    const secret = await sealed(tx);
    const [row] = await tx
      .insert(databaseProbes)
      .values({
        id: probeId,
        tenantId,
        connectionId: target.connectionId,
        executorKind: "agent",
        executorEndpointId: target.executorEndpointId,
        spec,
        credentialSecretId: secret?.id ?? null,
        status: "pending",
        createdBy: ctx.actor.userId,
        createdAt: now,
        expiresAt,
      })
      .returning();
    if (!row) {
      throw new Error("probe insert returned no row");
    }
    await tx.insert(endpointTasks).values({
      tenantId,
      endpointId: target.executorEndpointId as string,
      kind: "db_probe",
      params: { probeId },
      createdBy: ctx.actor.userId,
      createdAt: now,
      expiresAt,
    });
    return probeDto(row);
  });
}

/** Expire tests no agent answered, drop their sealed credentials, forget old tests. */
async function cleanupProbes(tx: Transaction, tenantId: string, now: Date): Promise<void> {
  const expired = await tx
    .update(databaseProbes)
    .set({ status: "expired", errorCode: "db_runner_offline", finishedAt: now })
    .where(
      and(
        eq(databaseProbes.tenantId, tenantId),
        inArray(databaseProbes.status, ["pending", "running"]),
        lt(databaseProbes.expiresAt, now),
      ),
    )
    .returning({ secret: databaseProbes.credentialSecretId });
  for (const { secret } of expired) {
    if (secret) {
      await deleteSecret(tx, { id: secret, tenantId });
    }
  }
  // The tested credentials of unsaved settings are kept a short while for saving them.
  const stale = await tx
    .select({ secret: databaseProbes.credentialSecretId })
    .from(databaseProbes)
    .where(
      and(
        eq(databaseProbes.tenantId, tenantId),
        isNotNull(databaseProbes.credentialSecretId),
        inArray(databaseProbes.status, ["done", "failed", "expired"]),
        lt(databaseProbes.finishedAt, new Date(now.getTime() - PROBE_CREDENTIALS_KEEP_MS)),
      ),
    );
  for (const { secret } of stale) {
    if (secret) {
      await deleteSecret(tx, { id: secret, tenantId });
    }
  }
  await tx
    .delete(databaseProbes)
    .where(
      and(
        eq(databaseProbes.tenantId, tenantId),
        lt(databaseProbes.expiresAt, new Date(now.getTime() - PROBE_KEEP_MS)),
      ),
    );
}

/** Test settings that are not saved yet (3.2). */
export async function testConnection(
  db: DbExecutor,
  tenantId: string,
  input: TestConnectionInput,
  ctx: DatabaseContext,
): Promise<DatabaseProbeDto> {
  const parsed = parseDbAddress(input.address);
  if (!parsed.ok) {
    throw invalid("address", `The address is not valid (${parsed.reason}).`, P.address);
  }
  const address = parsed.address;
  const endpoint =
    input.executor.kind === "agent"
      ? await withTenantTx(db, tenantId, (tx) =>
          loadAgent(tx, tenantId, input.executor.endpointId as string),
        )
      : null;
  assertExecutorFits(input.executor.kind, address.engineHint, input.authMethod, endpoint);
  // A user and password in the URL count as typed into their fields (3.1).
  const credentials: Credentials =
    input.authMethod === "socket"
      ? { user: null, password: null }
      : {
          user: input.user ?? parsed.user,
          password: input.password ?? parsed.password,
        };
  return startProbe(
    db,
    tenantId,
    {
      engine: address.engineHint,
      host: address.kind === "network" ? address.host : null,
      port: address.kind === "network" ? address.port : null,
      path: address.kind === "file" ? address.path : null,
      database: address.kind === "network" ? address.database : null,
      authMethod: input.authMethod,
      allowUnencrypted: input.allowUnencrypted,
      executorKind: input.executor.kind,
      executorEndpointId: endpoint?.id ?? null,
      connectionId: null,
      approval: null,
      pinnedFingerprint: null,
    },
    credentials,
    ctx,
  );
}

/** Test a stored connection with its stored credentials; the result updates it. */
export async function testStoredConnection(
  db: DbExecutor,
  tenantId: string,
  id: string,
  ctx: DatabaseContext,
): Promise<DatabaseProbeDto> {
  const { connection, credentials } = await withTenantTx(db, tenantId, async (tx) => {
    const connection = await loadConnection(tx, tenantId, id);
    if (connection.executorKind === "agent") {
      if (!connection.executorEndpointId) {
        throw invalid(
          "executor",
          "The connection has no executor: choose an agent or the Restow server.",
          P.executor,
        );
      }
      await loadAgent(tx, tenantId, connection.executorEndpointId);
    }
    return {
      connection,
      credentials: await readCredentials(tx, tenantId, connection.credentialSecretId),
    };
  });
  const result = await startProbe(
    db,
    tenantId,
    {
      engine: connection.engine,
      host: connection.host,
      port: connection.port,
      path: connection.path,
      database: connection.loginDatabase,
      authMethod: connection.authMethod,
      allowUnencrypted: connection.allowUnencrypted,
      executorKind: connection.executorKind,
      executorEndpointId: connection.executorEndpointId,
      connectionId: connection.id,
      approval: connection.privateNetworkApproval ?? null,
      pinnedFingerprint: connection.tlsFingerprint,
    },
    credentials,
    ctx,
  );
  await audit(db, {
    tenantId,
    actor: ctx.actor.label,
    actorUserId: ctx.actor.userId,
    ip: ctx.actor.ip,
    action: A.tested,
    target: connection.id,
    targetType: "database_connection",
    details: { probeId: result.id, executor: connection.executorKind },
  });
  return result;
}

export async function getProbe(
  db: DbExecutor,
  tenantId: string,
  probeId: string,
  ctx: Pick<DatabaseContext, "now">,
): Promise<DatabaseProbeDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    await cleanupProbes(tx, tenantId, nowOf(ctx));
    const [row] = await tx
      .select()
      .from(databaseProbes)
      .where(and(eq(databaseProbes.tenantId, tenantId), eq(databaseProbes.id, probeId)))
      .limit(1);
    if (!row) {
      throw notFound("Connection test");
    }
    return probeDto(row);
  });
}

// ---------------------------------------------------------------------------
// What a test means for a stored connection
// ---------------------------------------------------------------------------

/**
 * Bring the databases of a connection in line with a complete test (3.3): a database is known by
 * its instance, its name and (PostgreSQL) its OID, so one created again under its name, and every
 * database of another instance, is a row of its own. Rows of another instance are left alone.
 */
async function syncDatabases(
  tx: Transaction,
  tenantId: string,
  connectionId: string,
  instanceKey: string | null,
  result: DbProbeResult,
  now: Date,
): Promise<void> {
  const found = dbFoundDatabases(result);
  const existing = await tx
    .select()
    .from(databases)
    .where(
      and(
        eq(databases.tenantId, tenantId),
        eq(databases.connectionId, connectionId),
        instanceKey === null
          ? isNull(databases.instanceKey)
          : eq(databases.instanceKey, instanceKey),
      ),
    );
  const key = (name: string, identity: string | null) => `${name}\u0000${identity ?? ""}`;
  const known = new Map(existing.map((row) => [key(row.name, row.identity), row]));
  const seen = new Set<string>();
  for (const database of found) {
    const k = key(database.name, database.identity);
    seen.add(k);
    const row = known.get(k);
    if (row) {
      await tx
        .update(databases)
        .set({
          sizeBytes: database.sizeBytes,
          accessible: database.accessible,
          droppedAt: null,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(databases.id, row.id));
    } else {
      await tx.insert(databases).values({
        tenantId,
        connectionId,
        name: database.name,
        identity: database.identity,
        instanceKey,
        sizeBytes: database.sizeBytes,
        accessible: database.accessible,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }
  const gone = existing.filter((row) => !seen.has(key(row.name, row.identity)) && !row.droppedAt);
  if (gone.length > 0) {
    await tx
      .update(databases)
      .set({ droppedAt: now, updatedAt: now })
      .where(
        inArray(
          databases.id,
          gone.map((row) => row.id),
        ),
      );
  }
}

/**
 * What a test of a stored connection says: its sign-in, an engine that changed, another instance
 * under the address, another certificate (red until an admin confirms, 3.2, 3.3), and the
 * databases it found.
 */
async function applyProbeToConnection(
  tx: Transaction,
  tenantId: string,
  connectionId: string,
  probe: DatabaseProbe,
  result: DbProbeResult,
  now: Date,
): Promise<void> {
  const [connection] = await tx
    .select()
    .from(databaseConnections)
    .where(
      and(eq(databaseConnections.tenantId, tenantId), eq(databaseConnections.id, connectionId)),
    )
    .limit(1);
  if (!connection) {
    return;
  }
  let errorCode = result.error?.code ?? null;
  let errorMessage = result.error?.message ?? null;
  const identity = dbInstanceIdentityOf(result);
  let instanceKeySeen: string | null = null;
  let tlsFingerprintSeen: string | null = null;
  if (result.engine !== null && result.engine !== connection.engine) {
    errorCode = "db_engine_changed";
    errorMessage = `Under the address answers ${result.engine}, not ${connection.engine}.`;
  } else if (compareDbInstance(connection.instanceKey, identity) === "changed" && identity) {
    errorCode = "db_instance_changed";
    errorMessage = "Another instance answers under the address.";
    instanceKeySeen = dbInstanceKey(identity);
  } else if (connection.tlsFingerprint && result.tls.used) {
    if (result.tls.fingerprintSha256 !== connection.tlsFingerprint) {
      errorCode = "db_tls_changed";
      errorMessage = "The server shows another TLS certificate than the one confirmed.";
      tlsFingerprintSeen = result.tls.fingerprintSha256;
    }
  } else if (
    connection.tlsFingerprint &&
    !result.tls.used &&
    result.engine !== null &&
    !errorCode
  ) {
    errorCode = "db_tls_missing";
    errorMessage = "The server no longer offers TLS.";
  }
  const healthy = errorCode === null && result.login === "ok";
  if (healthy || (errorCode === null && result.engine === "sqlite")) {
    // A connection saved before its instance could be named gets it with the first good test.
    const instanceKey = connection.instanceKey ?? (identity ? dbInstanceKey(identity) : null);
    await syncDatabases(tx, tenantId, connectionId, instanceKey, result, now);
  }
  const rights = evaluateDbRights(result);
  await tx
    .update(databaseConnections)
    .set({
      lastCheck: {
        at: now.toISOString(),
        probeId: probe.id,
        login: result.login,
        errorCode,
        errorMessage,
        rights: rights as unknown as Record<string, unknown> | null,
        tlsFingerprintSeen,
        instanceKeySeen,
      },
      ...(healthy && result.serverVersion ? { serverVersion: result.serverVersion } : {}),
      // A connection saved before its instance could be named gets it with the first good test.
      ...(healthy && !connection.instanceKey && identity
        ? {
            instanceKey: dbInstanceKey(identity),
            instanceIdentity: identity as unknown as Record<string, unknown>,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(databaseConnections.id, connectionId));
}

// ---------------------------------------------------------------------------
// The agent's side of a test (GET/POST /agent/v1/databases/probes/:id)
// ---------------------------------------------------------------------------

/** The spec with the credentials, once, for the agent the test belongs to. */
export async function agentFetchProbe(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  probeId: string,
  now: Date = new Date(),
): Promise<DbProbeSpec> {
  await assertNoRestoreMode();
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(databaseProbes)
      .where(
        and(
          eq(databaseProbes.tenantId, agent.tenantId),
          eq(databaseProbes.id, probeId),
          eq(databaseProbes.executorEndpointId, agent.endpointId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row || row.expiresAt < now) {
      throw notFound("Connection test");
    }
    if (row.status !== "pending" || row.fetchedAt) {
      // The credentials of a test go out once (4.3).
      throw new ProblemError(409, "Connection test already fetched", { type: P.probeUsed });
    }
    const credentials = await readCredentials(tx, agent.tenantId, row.credentialSecretId);
    await tx
      .update(databaseProbes)
      .set({ status: "running", fetchedAt: now })
      .where(eq(databaseProbes.id, row.id));
    const spec = row.spec as Omit<DbProbeSpec, "user" | "password">;
    return { ...spec, probeId: row.id, user: credentials.user, password: credentials.password };
  });
}

/** The facts the agent found; the credentials of the test are deleted with them. */
export async function agentFinishProbe(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  probeId: string,
  raw: unknown,
  ctx: Pick<DatabaseContext, "now" | "ownSystemIdentifier"> = {},
): Promise<void> {
  const now = nowOf(ctx);
  const loaded = await withTenantTx(db, agent.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(databaseProbes)
      .where(
        and(
          eq(databaseProbes.tenantId, agent.tenantId),
          eq(databaseProbes.id, probeId),
          eq(databaseProbes.executorEndpointId, agent.endpointId),
        ),
      )
      .limit(1);
    if (row?.status !== "running") {
      throw notFound("Connection test");
    }
    return {
      row,
      credentials: await readCredentials(tx, agent.tenantId, row.credentialSecretId),
    };
  });
  const result = await judgeResult(raw, loaded.credentials, {
    actor: { label: "agent", userId: null, ip: null },
    isProviderAdmin: false,
    ...ctx,
  });
  await withTenantTx(db, agent.tenantId, async (tx) => {
    const [row] = await tx
      .update(databaseProbes)
      .set({
        status: "done",
        result: result as unknown as Record<string, unknown>,
        errorCode: result.error?.code ?? null,
        finishedAt: now,
        expiresAt: new Date(now.getTime() + PROBE_KEEP_MS),
      })
      .where(and(eq(databaseProbes.id, probeId), eq(databaseProbes.status, "running")))
      .returning();
    // A stored connection keeps its own credentials: the test's copy goes now. Unsaved settings
    // keep it a short while, for saving exactly what was tested.
    if (loaded.row.credentialSecretId && loaded.row.connectionId) {
      await deleteSecret(tx, { id: loaded.row.credentialSecretId, tenantId: agent.tenantId });
    }
    if (row?.connectionId) {
      await applyProbeToConnection(tx, agent.tenantId, row.connectionId, row, result, now);
    }
  });
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function loadConnection(
  tx: Transaction,
  tenantId: string,
  id: string,
): Promise<DatabaseConnection> {
  const [row] = await tx
    .select()
    .from(databaseConnections)
    .where(and(eq(databaseConnections.tenantId, tenantId), eq(databaseConnections.id, id)))
    .limit(1);
  if (!row) {
    throw notFound();
  }
  return row;
}

function isUnique(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function nameTaken(name: string): ProblemError {
  return new ProblemError(409, "Name in use", {
    type: P.nameTaken,
    detail: `Another database connection of this tenant is named "${name}".`,
    extensions: { field: "name" },
  });
}

function defaultName(spec: Record<string, unknown>): string {
  return specAddress(spec).slice(0, 120) || "Database";
}

/** Save a connection from a test (3.2: the dialog tests before it saves). */
export async function createConnection(
  db: DbExecutor,
  tenantId: string,
  input: CreateConnectionInput,
  ctx: DatabaseContext,
): Promise<DatabaseConnectionDto> {
  const now = nowOf(ctx);
  const probe = await withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(databaseProbes)
      .where(and(eq(databaseProbes.tenantId, tenantId), eq(databaseProbes.id, input.probeId)))
      .limit(1);
    return row ?? null;
  });
  const result = probe?.result ? parseDbProbeResult(probe.result) : null;
  const probeRequired = (detail: string) =>
    new ProblemError(422, "Test the connection first", {
      type: P.probeRequired,
      detail,
      extensions: { field: "probeId" },
    });
  if (probe?.status !== "done" || !result || probe.connectionId) {
    throw probeRequired("Save a connection from a finished test of its settings.");
  }
  if (result.error?.code === "db_target_is_restow") {
    throw new ProblemError(422, "Restow's own database", {
      type: P.targetIsRestow,
      detail: result.error.message,
    });
  }
  const engine = result.engine;
  const signedIn = result.login === "ok" || (engine === "sqlite" && result.sqlite !== undefined);
  if (!engine || !signedIn) {
    throw probeRequired(
      "The test did not sign in to a database. Correct the address or the sign-in and test again.",
    );
  }
  const spec = probe.spec as Omit<DbProbeSpec, "user" | "password">;
  const executorKind = probe.executorKind;
  const authMethod = spec.authMethod;
  const endpoint =
    executorKind === "agent"
      ? await withTenantTx(db, tenantId, (tx) =>
          loadAgent(tx, tenantId, probe.executorEndpointId as string),
        )
      : null;
  assertExecutorFits(executorKind, engine, authMethod, endpoint);
  if (!result.tls.used && !input.allowUnencrypted) {
    throw new ProblemError(422, "Unencrypted connection not allowed", {
      type: P.tlsMissing,
      detail:
        'The server offers no TLS. Tick "connect unencrypted" to save it anyway; the connection keeps the notice.',
      extensions: { field: "allowUnencrypted" },
    });
  }
  // A test is good for saving a short while: its sealed credentials and what it saw are recent.
  if (probe.finishedAt && now.getTime() - probe.finishedAt.getTime() > PROBE_CREDENTIALS_KEEP_MS) {
    throw probeRequired("The test is too old to be saved. Test again and save.");
  }
  const judged =
    executorKind === "server" && spec.host ? await judgeServerHost(spec.host, ctx, null) : null;
  // A private address is approved for the address the test signed in on.
  const approval = judged ? approvalFor(judged, result, ctx, now) : null;
  if (judged && !approval) {
    throw probeRequired(
      "The test did not report the private address it signed in on. Test again and save.",
    );
  }
  // The connection keeps the credentials the test used, sealed with it (3.2): other ones would
  // reach the server untested.
  const tested =
    authMethod === "password"
      ? await withTenantTx(db, tenantId, (tx) =>
          readCredentials(tx, tenantId, probe.credentialSecretId),
        )
      : null;
  if (tested) {
    if (!probe.credentialSecretId) {
      throw probeRequired("The credentials of this test are no longer kept. Test again and save.");
    }
    if (!tested.user) {
      throw invalid("user", "A user is needed for the sign-in with a password.");
    }
    const differs =
      (input.user != null && input.user !== tested.user) ||
      (input.password != null && input.password !== (tested.password ?? ""));
    if (differs) {
      throw probeRequired(
        "The user or password differs from the test. Test the connection with them, then save.",
      );
    }
  }
  const timeZone =
    input.schedule?.timeZone ?? (await loadInstallationTimeZone(providerDb)).timeZone;
  const identity = dbInstanceIdentityOf(result);
  const rights = evaluateDbRights(result);
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      if (executorKind === "server") {
        await assertServerConnectionRoom(tx, tenantId, ctx);
      }
      const secret = tested
        ? await storeSecret(tx, {
            tenantId,
            kind: "database_credentials",
            plaintext: JSON.stringify({ user: tested.user, password: tested.password ?? "" }),
          })
        : null;
      const name = input.name ?? defaultName(probe.spec);
      const [connection] = await tx
        .insert(databaseConnections)
        .values({
          tenantId,
          name,
          engine,
          host: spec.host,
          port: engine === "sqlite" ? null : (result.port ?? spec.port),
          path: spec.path,
          loginDatabase: spec.database,
          executorKind,
          executorEndpointId: endpoint?.id ?? null,
          authMethod,
          credentialSecretId: secret?.id ?? null,
          allowUnencrypted: !result.tls.used && input.allowUnencrypted,
          tlsFingerprint: result.tls.fingerprintSha256,
          tlsSubject: result.tls.subject,
          tlsIssuer: result.tls.issuer,
          tlsNotAfter: result.tls.notAfter ? new Date(result.tls.notAfter) : null,
          // The administrator saw the certificate in the dialog and saves it (3.2).
          tlsConfirmedAt: result.tls.fingerprintSha256 ? now : null,
          tlsConfirmedBy: result.tls.fingerprintSha256 ? ctx.actor.label : null,
          privateNetworkApproval: approval,
          mode: input.mode,
          schedule: {
            kind: "interval",
            intervalMinutes: input.schedule?.intervalMinutes ?? DB_DEFAULT_INTERVAL_MINUTES,
            timeZone,
          },
          selection: {
            mode: input.selection?.mode ?? "all",
            names: input.selection?.names ?? [],
            exclude: input.selection?.exclude ?? [],
          },
          instanceKey: identity ? dbInstanceKey(identity) : null,
          instanceIdentity: identity as unknown as Record<string, unknown> | null,
          serverVersion: result.serverVersion,
          lastCheck: {
            at: (probe.finishedAt ?? now).toISOString(),
            probeId: probe.id,
            login: result.login,
            errorCode: null,
            errorMessage: null,
            rights: rights as unknown as Record<string, unknown> | null,
          },
          createdBy: ctx.actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!connection) {
        throw new Error("connection insert returned no row");
      }
      await tx
        .update(databaseProbes)
        .set({ connectionId: connection.id })
        .where(eq(databaseProbes.id, probe.id));
      // The test's copy of the credentials is not needed any more.
      if (probe.credentialSecretId) {
        await deleteSecret(tx, { id: probe.credentialSecretId, tenantId });
      }
      await syncDatabases(tx, tenantId, connection.id, connection.instanceKey, result, now);
      const details = {
        name,
        engine,
        address: formatDbAddress(connection),
        executor: executorKind,
        executorEndpointId: endpoint?.id ?? null,
        authMethod,
        tlsFingerprint: result.tls.fingerprintSha256,
        allowUnencrypted: connection.allowUnencrypted,
        mode: input.mode,
      };
      await audit(tx, {
        tenantId,
        actor: ctx.actor.label,
        actorUserId: ctx.actor.userId,
        ip: ctx.actor.ip,
        action: A.connectionCreated,
        target: connection.id,
        targetType: "database_connection",
        details,
      });
      if (approval) {
        await audit(tx, {
          tenantId,
          actor: ctx.actor.label,
          actorUserId: ctx.actor.userId,
          ip: ctx.actor.ip,
          action: A.privateNetworkApproved,
          target: connection.id,
          targetType: "database_connection",
          details: { address: details.address },
        });
      }
      const count = await countDatabases(tx, tenantId, connection.id);
      return connectionDto(connection, endpoint, count, now);
    });
  } catch (error) {
    if (isUnique(error, "database_connections_tenant_name_uq")) {
      throw nameTaken(input.name ?? defaultName(probe.spec));
    }
    throw error;
  }
}

async function countDatabases(
  tx: Transaction,
  tenantId: string,
  connectionId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(databases)
    .where(
      and(
        eq(databases.tenantId, tenantId),
        eq(databases.connectionId, connectionId),
        isNull(databases.droppedAt),
      ),
    );
  return Number(row?.count ?? 0);
}

async function executorsOf(
  tx: Transaction,
  tenantId: string,
  ids: string[],
): Promise<Map<string, Pick<Endpoint, "hostname" | "lastSeenAt">>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: endpoints.id, hostname: endpoints.hostname, lastSeenAt: endpoints.lastSeenAt })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function listConnections(
  db: DbExecutor,
  tenantId: string,
  ctx: Pick<DatabaseContext, "now"> = {},
): Promise<{ connections: DatabaseConnectionDto[] }> {
  const now = nowOf(ctx);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.tenantId, tenantId))
      .orderBy(asc(sql`lower(${databaseConnections.name})`));
    const counts = await tx
      .select({ connectionId: databases.connectionId, count: sql<number>`count(*)::int` })
      .from(databases)
      .where(and(eq(databases.tenantId, tenantId), isNull(databases.droppedAt)))
      .groupBy(databases.connectionId);
    const countOf = new Map(counts.map((row) => [row.connectionId, Number(row.count)]));
    const executors = await executorsOf(
      tx,
      tenantId,
      rows.map((row) => row.executorEndpointId).filter((id): id is string => Boolean(id)),
    );
    return {
      connections: rows.map((row) =>
        connectionDto(
          row,
          row.executorEndpointId ? (executors.get(row.executorEndpointId) ?? null) : null,
          countOf.get(row.id) ?? 0,
          now,
        ),
      ),
    };
  });
}

export interface DatabaseConnectionDetailDto extends DatabaseConnectionDto {
  databases: DatabaseDto[];
  /** The last 24 hours of health checks, hour by hour. */
  band: HealthBandHour[];
}

export async function getConnection(
  db: DbExecutor,
  tenantId: string,
  id: string,
  ctx: Pick<DatabaseContext, "now"> = {},
): Promise<DatabaseConnectionDetailDto> {
  const now = nowOf(ctx);
  return withTenantTx(db, tenantId, async (tx) => {
    const connection = await loadConnection(tx, tenantId, id);
    const executors = await executorsOf(
      tx,
      tenantId,
      connection.executorEndpointId ? [connection.executorEndpointId] : [],
    );
    const rows = await tx
      .select()
      .from(databases)
      .where(and(eq(databases.tenantId, tenantId), eq(databases.connectionId, id)))
      .orderBy(asc(databases.name), desc(databases.firstSeenAt));
    const executor = connection.executorEndpointId
      ? (executors.get(connection.executorEndpointId) ?? null)
      : null;
    const bands = await healthBands(tx, tenantId, [connection.id], now);
    const backedUp = await lastBackupsOf(
      tx,
      rows.map((row) => row.id),
    );
    return {
      ...connectionDto(connection, executor, rows.filter((row) => !row.droppedAt).length, now),
      databases: rows.map((row) => databaseDto(row, connection, now, backedUp.get(row.id) ?? null)),
      band: bands.get(connection.id) ?? [],
    };
  });
}

/** Change a connection (2.3); new credentials replace the stored ones and are audited. */
export async function updateConnection(
  db: DbExecutor,
  tenantId: string,
  id: string,
  input: UpdateConnectionInput,
  ctx: DatabaseContext,
): Promise<DatabaseConnectionDetailDto> {
  const now = nowOf(ctx);
  const before = await withTenantTx(db, tenantId, (tx) => loadConnection(tx, tenantId, id));
  const executor = input.executor;
  let endpoint: Endpoint | null = null;
  if (executor?.kind === "agent") {
    endpoint = await withTenantTx(db, tenantId, (tx) =>
      loadAgent(tx, tenantId, executor.endpointId as string),
    );
  }
  if (executor) {
    assertExecutorFits(executor.kind, before.engine, before.authMethod, endpoint);
  }
  // Stored credentials only travel to the executor they were stored for: another executor gets
  // them when the administrator enters the password again in the same change (audited).
  const executorChanged =
    executor !== undefined &&
    (executor.kind !== before.executorKind ||
      (endpoint?.id ?? null) !== (before.executorEndpointId ?? null));
  if (
    executorChanged &&
    before.authMethod === "password" &&
    before.credentialSecretId &&
    input.password === undefined
  ) {
    throw new ProblemError(422, "Password required", {
      type: P.credentialsRequired,
      detail:
        "Enter the password again to move the connection to another executor: stored credentials only go to the executor they were stored for.",
      extensions: { field: "password", issues: [{ path: ["password"], message: "required" }] },
    });
  }
  // Moving to the server judges the address as when it is saved (4.2).
  let approval = before.privateNetworkApproval ?? null;
  const approvedNow = executor?.kind === "server" && before.executorKind !== "server";
  if (executor?.kind === "server" && before.host) {
    approval = await judgeServerHost(
      before.host,
      ctx,
      before.executorKind === "server" ? approval : null,
    );
  }
  let confirmProbe: DbProbeResult | null = null;
  if (input.confirm) {
    const confirm = input.confirm;
    const row = await withTenantTx(db, tenantId, async (tx) => {
      const [probe] = await tx
        .select()
        .from(databaseProbes)
        .where(
          and(
            eq(databaseProbes.tenantId, tenantId),
            eq(databaseProbes.id, confirm.probeId),
            eq(databaseProbes.connectionId, id),
          ),
        )
        .limit(1);
      return probe ?? null;
    });
    confirmProbe = row?.result ? parseDbProbeResult(row.result) : null;
    if (!confirmProbe || confirmProbe.engine !== before.engine) {
      throw new ProblemError(422, "Nothing to confirm", {
        type: P.confirm,
        detail: "Confirm what a finished test of this connection found.",
        extensions: { field: "confirm" },
      });
    }
  }
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      if (executor?.kind === "server" && before.executorKind !== "server") {
        await assertServerConnectionRoom(tx, tenantId, ctx);
      }
      const changes: Partial<typeof databaseConnections.$inferInsert> = { updatedAt: now };
      const changed: string[] = [];
      if (input.name !== undefined && input.name !== before.name) {
        changes.name = input.name;
        changed.push("name");
      }
      if (
        input.allowUnencrypted !== undefined &&
        input.allowUnencrypted !== before.allowUnencrypted
      ) {
        changes.allowUnencrypted = input.allowUnencrypted;
        changed.push("allowUnencrypted");
      }
      if (input.mode !== undefined && input.mode !== before.mode) {
        changes.mode = input.mode;
        changed.push("mode");
      }
      if (input.enabled !== undefined && input.enabled !== before.enabled) {
        changes.enabled = input.enabled;
        changed.push("enabled");
      }
      if (input.schedule) {
        changes.schedule = {
          kind: "interval",
          intervalMinutes: input.schedule.intervalMinutes,
          timeZone: input.schedule.timeZone ?? before.schedule.timeZone,
        };
        changed.push("schedule");
      }
      if (
        input.healthIntervalMinutes !== undefined &&
        input.healthIntervalMinutes !== before.healthIntervalMinutes
      ) {
        changes.healthIntervalMinutes = input.healthIntervalMinutes;
        changed.push("healthInterval");
      }
      if (input.selection) {
        changes.selection = {
          mode: input.selection.mode,
          names: input.selection.names,
          exclude: input.selection.exclude,
        };
        changed.push("selection");
      }
      if (executor) {
        changes.executorKind = executor.kind;
        changes.executorEndpointId = endpoint?.id ?? null;
        changes.privateNetworkApproval = executor.kind === "server" ? approval : null;
        changed.push("executor");
      }
      let credentialsChanged = false;
      if (input.user !== undefined || input.password !== undefined) {
        if (before.authMethod !== "password") {
          throw invalid(
            "user",
            "This connection signs in over the socket and keeps no credentials.",
          );
        }
        const current = await readCredentials(tx, tenantId, before.credentialSecretId);
        const next = {
          user: input.user ?? current.user,
          password: input.password ?? current.password ?? "",
        };
        if (before.credentialSecretId) {
          await replaceSecret(
            tx,
            { id: before.credentialSecretId, tenantId },
            JSON.stringify(next),
          );
        } else {
          const secret = await storeSecret(tx, {
            tenantId,
            kind: "database_credentials",
            plaintext: JSON.stringify(next),
          });
          changes.credentialSecretId = secret.id;
        }
        credentialsChanged = true;
      }
      const confirmed: string[] = [];
      if (input.confirm && confirmProbe) {
        if (input.confirm.tls && confirmProbe.tls.used && confirmProbe.tls.fingerprintSha256) {
          changes.tlsFingerprint = confirmProbe.tls.fingerprintSha256;
          changes.tlsSubject = confirmProbe.tls.subject;
          changes.tlsIssuer = confirmProbe.tls.issuer;
          changes.tlsNotAfter = confirmProbe.tls.notAfter
            ? new Date(confirmProbe.tls.notAfter)
            : null;
          changes.tlsConfirmedAt = now;
          changes.tlsConfirmedBy = ctx.actor.label;
          confirmed.push("tls");
        }
        const identity = dbInstanceIdentityOf(confirmProbe);
        if (input.confirm.instance && identity) {
          changes.instanceKey = dbInstanceKey(identity);
          changes.instanceIdentity = identity as unknown as Record<string, unknown>;
          confirmed.push("instance");
        }
        if (confirmed.length > 0 && before.lastCheck) {
          changes.lastCheck = { ...before.lastCheck, errorCode: null, errorMessage: null };
        }
      }
      const [after] = await tx
        .update(databaseConnections)
        .set(changes)
        .where(and(eq(databaseConnections.tenantId, tenantId), eq(databaseConnections.id, id)))
        .returning();
      if (!after) {
        throw notFound();
      }
      // Runs the old executor would take or is running end here (16, "D3"): their credentials and
      // repository token were meant for it. The queued agent task finds nothing to fetch.
      if (executorChanged) {
        await tx
          .update(databaseRuns)
          .set({
            status: "failed",
            finishedAt: now,
            errorCode: "db_run_failed",
            errorMessage: "The connection moved to another executor.",
            tokenHash: null,
          })
          .where(
            and(
              eq(databaseRuns.tenantId, tenantId),
              inArray(databaseRuns.status, ["queued", "running"]),
              or(eq(databaseRuns.connectionId, id), eq(databaseRuns.targetConnectionId, id)),
            ),
          );
      }
      const event = (action: string, details: Record<string, unknown>) =>
        audit(tx, {
          tenantId,
          actor: ctx.actor.label,
          actorUserId: ctx.actor.userId,
          ip: ctx.actor.ip,
          action,
          target: id,
          targetType: "database_connection",
          details,
        });
      if (changed.length > 0) {
        await event(A.connectionUpdated, { changed, executor: after.executorKind });
      }
      if (credentialsChanged) {
        await event(A.credentialsChanged, {
          userChanged: input.user !== undefined,
          ...(executorChanged ? { executor: after.executorKind } : {}),
        });
      }
      if (approvedNow && approval) {
        await event(A.privateNetworkApproved, { address: formatDbAddress(after) });
      }
      if (confirmed.includes("tls")) {
        await event(A.tlsConfirmed, {
          before: before.tlsFingerprint,
          after: after.tlsFingerprint,
          probeId: input.confirm?.probeId,
        });
      }
      if (confirmed.includes("instance")) {
        await event(A.instanceConfirmed, {
          before: before.instanceKey,
          after: after.instanceKey,
          probeId: input.confirm?.probeId,
        });
        // The history of the old instance stays separate: its databases are dropped here, the
        // new instance's are rows of their own (3.3).
        await tx
          .update(databases)
          .set({ droppedAt: now, updatedAt: now })
          .where(and(eq(databases.connectionId, id), isNull(databases.droppedAt)));
        if (confirmProbe) {
          await syncDatabases(tx, tenantId, id, after.instanceKey, confirmProbe, now);
        }
      }
      return null;
    }).then(() => getConnection(db, tenantId, id, ctx));
  } catch (error) {
    if (isUnique(error, "database_connections_tenant_name_uq")) {
      throw nameTaken(input.name ?? before.name);
    }
    throw error;
  }
}

/** Delete a connection with its databases and its stored credentials (no backups exist in D1). */
export async function deleteConnection(
  db: DbExecutor,
  tenantId: string,
  id: string,
  ctx: DatabaseContext,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const connection = await loadConnection(tx, tenantId, id);
    const probeSecrets = await tx
      .select({ id: databaseProbes.credentialSecretId })
      .from(databaseProbes)
      .where(
        and(eq(databaseProbes.connectionId, id), isNotNull(databaseProbes.credentialSecretId)),
      );
    // The connection's tests stay as rows until they are old (the rate limit counts them), but
    // nothing can be saved from them any more.
    await tx
      .update(databaseProbes)
      .set({
        connectionId: null,
        status: "expired",
        finishedAt: sql`coalesce(${databaseProbes.finishedAt}, now())`,
      })
      .where(and(eq(databaseProbes.tenantId, tenantId), eq(databaseProbes.connectionId, id)));
    await tx.delete(databaseConnections).where(eq(databaseConnections.id, id));
    for (const secretId of [connection.credentialSecretId, ...probeSecrets.map((row) => row.id)]) {
      if (secretId) {
        await deleteSecret(tx, { id: secretId, tenantId });
      }
    }
    await audit(tx, {
      tenantId,
      actor: ctx.actor.label,
      actorUserId: ctx.actor.userId,
      ip: ctx.actor.ip,
      action: A.connectionDeleted,
      target: id,
      targetType: "database_connection",
      details: {
        name: connection.name,
        engine: connection.engine,
        address: formatDbAddress(connection),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Databases and suggestions
// ---------------------------------------------------------------------------

export async function listDatabases(
  db: DbExecutor,
  tenantId: string,
  ctx: Pick<DatabaseContext, "now"> = {},
): Promise<{ databases: DatabaseDto[] }> {
  const now = nowOf(ctx);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ database: databases, connection: databaseConnections })
      .from(databases)
      .innerJoin(databaseConnections, eq(databaseConnections.id, databases.connectionId))
      .where(and(eq(databases.tenantId, tenantId), isNull(databases.droppedAt)));
    const bands = await healthBands(
      tx,
      tenantId,
      [...new Set(rows.map((row) => row.connection.id))],
      now,
    );
    const backedUp = await lastBackupsOf(
      tx,
      rows.map((row) => row.database.id),
    );
    const list = rows.map((row) => ({
      ...databaseDto(row.database, row.connection, now, backedUp.get(row.database.id) ?? null),
      band: bands.get(row.connection.id) ?? [],
    }));
    list.sort(
      (a, b) =>
        dbListRank(a.rating, a.reachable) - dbListRank(b.rating, b.reachable) ||
        a.connectionName.localeCompare(b.connectionName) ||
        a.name.localeCompare(b.name),
    );
    return { databases: list };
  });
}

export async function getDatabase(
  db: DbExecutor,
  tenantId: string,
  id: string,
  ctx: Pick<DatabaseContext, "now"> = {},
): Promise<DatabaseDto & { connection: DatabaseConnectionDto }> {
  const now = nowOf(ctx);
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ database: databases, connection: databaseConnections })
      .from(databases)
      .innerJoin(databaseConnections, eq(databaseConnections.id, databases.connectionId))
      .where(and(eq(databases.tenantId, tenantId), eq(databases.id, id)))
      .limit(1);
    if (!row) {
      throw notFound("Database");
    }
    const executors = await executorsOf(
      tx,
      tenantId,
      row.connection.executorEndpointId ? [row.connection.executorEndpointId] : [],
    );
    const executor = row.connection.executorEndpointId
      ? (executors.get(row.connection.executorEndpointId) ?? null)
      : null;
    const backedUp = await lastBackupsOf(tx, [row.database.id]);
    return {
      ...databaseDto(row.database, row.connection, now, backedUp.get(row.database.id) ?? null),
      connection: connectionDto(
        row.connection,
        executor,
        await countDatabases(tx, tenantId, row.connection.id),
        now,
      ),
    };
  });
}

export interface DatabaseSuggestionDto {
  endpointId: string;
  hostname: string;
  engine: "postgresql" | "mysql" | "mariadb";
  name: string;
  version: string | null;
  source: string;
  port: number | null;
  container: string | null;
  running: boolean | null;
  /** What the dialog is opened with; null where the agent cannot reach the instance (a container without a published port). */
  prefill: { address: string; authMethod: "password" | "socket"; endpointId: string } | null;
  collectedAt: string;
}

/**
 * Instances the agents' inventories found and no connection covers yet (3.4): "Found on <machine>,
 * not protected", with what the dialog is opened with. The inventory never creates a connection.
 */
export async function listSuggestions(
  db: DbExecutor,
  tenantId: string,
): Promise<{ suggestions: DatabaseSuggestionDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const machines = await tx
      .select({
        id: endpoints.id,
        hostname: endpoints.hostname,
        settings: endpoints.settings,
        os: endpoints.os,
      })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.tenantId, tenantId),
          isNull(endpoints.removedAt),
          eq(endpoints.status, "active"),
          sql`${endpoints.settings} ? 'databaseInventory'`,
        ),
      );
    const covered = await tx
      .select({
        endpointId: databaseConnections.executorEndpointId,
        port: databaseConnections.port,
        host: databaseConnections.host,
      })
      .from(databaseConnections)
      .where(eq(databaseConnections.tenantId, tenantId));
    const local = new Set(["localhost", "127.0.0.1", "::1"]);
    const suggestions: DatabaseSuggestionDto[] = [];
    for (const machine of machines) {
      const inventory = machine.settings.databaseInventory;
      if (!inventory) {
        continue;
      }
      const hostname = machine.hostname.toLowerCase();
      for (const instance of inventory.instances) {
        const isCovered = covered.some(
          (connection) =>
            instance.port !== null &&
            connection.port === instance.port &&
            ((connection.endpointId === machine.id && local.has(connection.host ?? "")) ||
              (connection.host ?? "").toLowerCase() === hostname),
        );
        if (isCovered) {
          continue;
        }
        const containerWithoutPort = instance.source === "docker" && instance.port === null;
        const socket = machine.os === "linux" && instance.source !== "docker";
        suggestions.push({
          endpointId: machine.id,
          hostname: machine.hostname,
          engine: instance.engine,
          name: instance.name,
          version: instance.version,
          source: instance.source,
          port: instance.port,
          container: instance.container,
          running: instance.running,
          prefill: containerWithoutPort
            ? null
            : {
                address: `localhost:${instance.port ?? (instance.engine === "postgresql" ? 5432 : 3306)}`,
                authMethod: socket ? "socket" : "password",
                endpointId: machine.id,
              },
          collectedAt: inventory.collectedAt,
        });
      }
    }
    return { suggestions };
  });
}

/** The agents of the tenant that can run connections (the executor picker of the dialog). */
export async function listRunners(
  db: DbExecutor,
  tenantId: string,
  ctx: Pick<DatabaseContext, "now"> = {},
): Promise<{
  runners: {
    endpointId: string;
    hostname: string;
    os: string;
    online: boolean;
    lastSeenAt: string | null;
  }[];
}> {
  const now = nowOf(ctx);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(endpoints)
      .where(
        and(
          eq(endpoints.tenantId, tenantId),
          isNull(endpoints.removedAt),
          eq(endpoints.status, "active"),
        ),
      )
      .orderBy(asc(endpoints.hostname));
    return {
      runners: rows
        .filter((row) => hasDbRunnerCapability(row.settings.agent?.capabilities))
        .map((row) => ({
          endpointId: row.id,
          hostname: row.hostname,
          os: row.os,
          online:
            row.lastSeenAt !== null &&
            now.getTime() - row.lastSeenAt.getTime() <= DB_RUNNER_OFFLINE_AFTER_MS,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        })),
    };
  });
}
