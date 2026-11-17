import type { DbHealthState } from "@restow/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { retentionPolicies } from "./archive.js";
import { endpoints } from "./endpoints.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";

/**
 * The module "Databases" (docs/DATABASES.md 9), stage D1: connections, the databases they found,
 * and the tests ("Test connection") that ran for them. All three are tenant-scoped (RLS,
 * sql/rls.sql). Backups, health samples, point-in-time ranges and warm copies get tables of
 * their own in later stages; SQL Server keeps its tables (`endpoint_sql_*`) until it moves into
 * the module (D5).
 *
 * Credentials never stand in these tables: a connection points at a sealed `secrets` row
 * (`database_credentials`), and a probe that an agent runs holds a sealed copy for exactly that
 * probe (`database_probe_credentials`), deleted when the agent fetched it or the probe ended.
 */

/** Values of the text columns, kept by CHECK constraints (no enum: a value can be added without ALTER TYPE). */
export type DatabaseEngine = "postgresql" | "mysql" | "mariadb" | "sqlserver" | "sqlite";
export type DatabaseExecutorKind = "agent" | "server";
export type DatabaseAuthMethod = "password" | "socket";
export type DatabaseMode = "backup" | "pitr" | "warm_copy";
export type DatabaseProbeStatus = "pending" | "running" | "done" | "failed" | "expired";

/** When a connection runs (5.1): every N minutes, at least 15, in the zone of the schedule. */
export type DatabaseSchedule = {
  kind: "interval";
  intervalMinutes: number;
  timeZone: string;
};

/** Which databases of the instance a connection protects: all (minus `exclude`) or a list. */
export type DatabaseSelection = {
  mode: "all" | "selected";
  names: string[];
  exclude: string[];
};

/** A provider admin's approval of a private address for the server executor (4.2). */
export type DatabasePrivateNetworkApproval = { by: string; at: string; addresses?: string[] };

/**
 * What the last test of a connection found, without credentials: the rights matrix (@restow/core
 * `DbRights`), the sign-in, the error code and when. Written by the API.
 */
export type DatabaseConnectionCheck = {
  at: string;
  probeId: string;
  login: "ok" | "failed" | "skipped";
  errorCode: string | null;
  errorMessage: string | null;
  rights: Record<string, unknown> | null;
  /** The certificate the test saw, when it differs from the confirmed one. */
  tlsFingerprintSeen?: string | null;
  /** The instance the test found, when it differs from the stored one. */
  instanceKeySeen?: string | null;
};

export const databaseConnections = pgTable(
  "database_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    engine: text("engine").$type<DatabaseEngine>().notNull(),
    // The address, never with a user or password (3.1): host and port, or the SQLite file.
    host: text("host"),
    port: integer("port"),
    path: text("path"),
    // PostgreSQL: the database to sign in to (from the URL); null = postgres.
    loginDatabase: text("login_database"),
    executorKind: text("executor_kind").$type<DatabaseExecutorKind>().notNull(),
    // The agent that runs the connection (4.1); null for the server, or once the machine is gone.
    executorEndpointId: uuid("executor_endpoint_id").references(() => endpoints.id, {
      onDelete: "set null",
    }),
    authMethod: text("auth_method").$type<DatabaseAuthMethod>().notNull().default("password"),
    // The sealed user and password (`secrets.kind = database_credentials`); null with the socket.
    credentialSecretId: uuid("credential_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    // "Connect unencrypted" ticked by an administrator (3.2); stays visible as a notice.
    allowUnencrypted: boolean("allow_unencrypted").notNull().default(false),
    tlsFingerprint: text("tls_fingerprint"),
    tlsSubject: text("tls_subject"),
    tlsIssuer: text("tls_issuer"),
    tlsNotAfter: timestamp("tls_not_after", { withTimezone: true }),
    tlsConfirmedAt: timestamp("tls_confirmed_at", { withTimezone: true }),
    tlsConfirmedBy: text("tls_confirmed_by"),
    privateNetworkApproval: jsonb(
      "private_network_approval",
    ).$type<DatabasePrivateNetworkApproval>(),
    mode: text("mode").$type<DatabaseMode>().notNull().default("backup"),
    schedule: jsonb("schedule").$type<DatabaseSchedule>().notNull(),
    // null: the tenant's default retention (4.4, D3).
    retentionPolicyId: uuid("retention_policy_id").references(() => retentionPolicies.id, {
      onDelete: "set null",
    }),
    selection: jsonb("selection")
      .$type<DatabaseSelection>()
      .notNull()
      .default({ mode: "all", names: [], exclude: [] }),
    // The identity of the instance (3.3) as @restow/core `dbInstanceKey`, and its parts.
    instanceKey: text("instance_key"),
    instanceIdentity: jsonb("instance_identity").$type<Record<string, unknown>>(),
    serverVersion: text("server_version"),
    lastCheck: jsonb("last_check").$type<DatabaseConnectionCheck>(),
    // Health checks (D2, 8): every N minutes, 1 to 60, default 5; the state the worker keeps
    // (the newest check, failures in a row, the episode of `database.unreachable`).
    healthIntervalMinutes: integer("health_interval_minutes").notNull().default(5),
    health: jsonb("health").$type<DbHealthState>(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("database_connections_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`),
    index("database_connections_executor_idx").on(t.executorEndpointId),
    check(
      "database_connections_engine_ck",
      sql`${t.engine} IN ('postgresql', 'mysql', 'mariadb', 'sqlserver', 'sqlite')`,
    ),
    check("database_connections_executor_ck", sql`${t.executorKind} IN ('agent', 'server')`),
    check("database_connections_auth_ck", sql`${t.authMethod} IN ('password', 'socket')`),
    check("database_connections_mode_ck", sql`${t.mode} IN ('backup', 'pitr', 'warm_copy')`),
    // An SQLite file has a path and no host; every other engine a host and no path.
    check(
      "database_connections_address_ck",
      sql`CASE WHEN ${t.engine} = 'sqlite' THEN ${t.path} IS NOT NULL AND ${t.host} IS NULL ELSE ${t.host} IS NOT NULL AND ${t.path} IS NULL END`,
    ),
    check("database_connections_port_ck", sql`${t.port} IS NULL OR ${t.port} BETWEEN 1 AND 65535`),
    check(
      "database_connections_health_interval_ck",
      sql`${t.healthIntervalMinutes} BETWEEN 1 AND 60`,
    ),
    // The server opens PostgreSQL, MySQL and MariaDB with a password only (4.2) and has no agent.
    check(
      "database_connections_server_ck",
      sql`${t.executorKind} = 'agent' OR (${t.executorEndpointId} IS NULL AND ${t.authMethod} = 'password' AND ${t.engine} IN ('postgresql', 'mysql', 'mariadb'))`,
    ),
  ],
);

/**
 * One database of a connection (3.3). A database dropped and created again under the same name is
 * another row (PostgreSQL: another OID), and so is every database of another instance under the
 * address; MySQL and MariaDB schemas are known by their name only (`identity` null). `dropped_at`
 * is set when a complete probe no longer lists it.
 */
export const databases = pgTable(
  "databases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => databaseConnections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    identity: text("identity"),
    // The instance it belongs to (the connection's `instance_key` when it was found): another
    // instance under the address keeps a history of its own (3.3).
    instanceKey: text("instance_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // The executor's user may sign in to it (PostgreSQL CONNECT).
    accessible: boolean("accessible").notNull().default(true),
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("databases_connection_name_identity_uq").on(
      t.connectionId,
      sql`coalesce(${t.instanceKey}, '')`,
      t.name,
      sql`coalesce(${t.identity}, '')`,
    ),
    index("databases_tenant_idx").on(t.tenantId),
  ],
);

/**
 * One "Test connection" (3.2), for a connection that is not saved yet or a stored one. The server
 * runs its own synchronously and stores the result; an agent's waits as `pending` for the agent's
 * next heartbeat (task `db_probe`), which fetches the spec and the sealed credentials once and
 * posts the facts back. Saving a connection takes engine, identity, certificate and databases
 * from its probe, never from the browser. Old rows are deleted after a day.
 */
export const databaseProbes = pgTable(
  "database_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => databaseConnections.id, {
      onDelete: "cascade",
    }),
    executorKind: text("executor_kind").$type<DatabaseExecutorKind>().notNull(),
    executorEndpointId: uuid("executor_endpoint_id").references(() => endpoints.id, {
      onDelete: "cascade",
    }),
    // @restow/core `DbProbeSpec` without user and password.
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    // The sealed credentials for the agent (`database_probe_credentials`); null once fetched.
    credentialSecretId: uuid("credential_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<DatabaseProbeStatus>().notNull().default("pending"),
    // @restow/core `DbProbeResult`, checked and with sanitized messages.
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("database_probes_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("database_probes_endpoint_idx").on(t.executorEndpointId),
    check(
      "database_probes_status_ck",
      sql`${t.status} IN ('pending', 'running', 'done', 'failed', 'expired')`,
    ),
    check("database_probes_executor_ck", sql`${t.executorKind} IN ('agent', 'server')`),
  ],
);

/**
 * The health history of a connection (docs/DATABASES.md 8, stage D2). A raw sample is one check
 * (`checks` 1, `ok_checks` 0 or 1) as the executor reported it and the server judged it; raw
 * samples are kept 14 days, then the worker folds each hour into one `hour` sample (sums of
 * `checks` and `ok_checks`, mean and extremes of the response time and the connections, the last
 * version, start time, certificate and sizes) kept 400 days. Never a credential: error messages
 * are cleaned of them before they are stored.
 */
export type DatabaseHealthResolution = "raw" | "hour";

export const databaseHealthSamples = pgTable(
  "database_health_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => databaseConnections.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    resolution: text("resolution").$type<DatabaseHealthResolution>().notNull().default("raw"),
    executorKind: text("executor_kind").$type<DatabaseExecutorKind>().notNull(),
    checks: integer("checks").notNull().default(1),
    okChecks: integer("ok_checks").notNull(),
    // The code of the (last) failed check; null when it was good.
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    // Connection, TLS, sign-in and SELECT 1 (8); the mean of an hour, with its extremes.
    latencyMs: integer("latency_ms"),
    latencyMinMs: integer("latency_min_ms"),
    latencyMaxMs: integer("latency_max_ms"),
    serverVersion: text("server_version"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    connectionsUsed: integer("connections_used"),
    connectionsUsedMax: integer("connections_used_max"),
    connectionsMax: integer("connections_max"),
    tlsFingerprint: text("tls_fingerprint"),
    instanceKey: text("instance_key"),
    // Size per database row id (`databases.id`), at most once an hour.
    sizes: jsonb("sizes").$type<Record<string, number>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("database_health_samples_connection_at_idx").on(t.connectionId, t.at),
    index("database_health_samples_tenant_at_idx").on(t.tenantId, t.at),
    check("database_health_samples_resolution_ck", sql`${t.resolution} IN ('raw', 'hour')`),
    check("database_health_samples_executor_ck", sql`${t.executorKind} IN ('agent', 'server')`),
    check(
      "database_health_samples_checks_ck",
      sql`${t.checks} >= 1 AND ${t.okChecks} BETWEEN 0 AND ${t.checks}`,
    ),
  ],
);

export type DatabaseConnection = typeof databaseConnections.$inferSelect;
export type NewDatabaseConnection = typeof databaseConnections.$inferInsert;
export type ProtectedDatabase = typeof databases.$inferSelect;
export type NewProtectedDatabase = typeof databases.$inferInsert;
export type DatabaseProbe = typeof databaseProbes.$inferSelect;
export type DatabaseHealthSample = typeof databaseHealthSamples.$inferSelect;
export type NewDatabaseHealthSample = typeof databaseHealthSamples.$inferInsert;
