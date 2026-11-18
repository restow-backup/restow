/**
 * The module "Databases" (docs/DATABASES.md): its engines, executors, modes and codes, shared by
 * the API, the worker and (as the agent contract) the Go agent.
 *
 * A connection is one address (an instance, or an SQLite file) with its sign-in, the executor
 * that opens it, a mode and a schedule. The executor is an agent of the tenant that names
 * {@link DB_RUNNER_CAPABILITY} (4.1) or the Restow server itself (4.2). The server opens network
 * engines only (PostgreSQL, MySQL, MariaDB); SQLite (a file) and SQL Server (the .bak file is
 * written on its own machine) need an agent, and so does the sign-in over the local socket.
 */

export const DB_ENGINES = ["postgresql", "mysql", "mariadb", "sqlserver", "sqlite"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

/** Engines reached over the network; SQLite is a file. */
export const DB_NETWORK_ENGINES = ["postgresql", "mysql", "mariadb", "sqlserver"] as const;

/** The engines the Restow server opens itself (4.2): those with a network protocol it speaks. */
export const DB_SERVER_ENGINES = ["postgresql", "mysql", "mariadb"] as const;

export const DB_EXECUTOR_KINDS = ["agent", "server"] as const;
export type DbExecutorKind = (typeof DB_EXECUTOR_KINDS)[number];

/** `password`: user and password from the secret store; `socket`: the local socket (agent on the database machine). */
export const DB_AUTH_METHODS = ["password", "socket"] as const;
export type DbAuthMethod = (typeof DB_AUTH_METHODS)[number];

/** The three modes (E8): backup in 0.6.0, point-in-time in 0.6.x, warm copy in 0.7.0. */
export const DB_MODES = ["backup", "pitr", "warm_copy"] as const;
export type DbMode = (typeof DB_MODES)[number];

/** The modes this release can run; the others are shown as coming later. */
export const DB_AVAILABLE_MODES: readonly DbMode[] = ["backup"];

/** The capability an agent announces when it can run connections (enroll and heartbeat). */
export const DB_RUNNER_CAPABILITY = "db_runner_v1";

/** An agent without a heartbeat for this long is shown as an executor that is offline (4.3). */
export const DB_RUNNER_OFFLINE_AFTER_MS = 15 * 60 * 1000;

/** The default ports, and the order in which an address without a port is tried (3.1). */
export const DB_DEFAULT_PORTS: Readonly<Record<Exclude<DbEngine, "sqlite">, number>> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
};
export const DB_DETECTION_PORTS = [5432, 3306, 1433] as const;

/** Schedule of a connection (5.1): default every hour, at least every 15 minutes. */
export const DB_DEFAULT_INTERVAL_MINUTES = 60;
export const DB_MIN_INTERVAL_MINUTES = 15;
export const DB_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** The user the grant blocks of the rights matrix create (3.2). */
export const DB_BACKUP_USER = "restow_backup";

/** At most this many databases are read from one instance by a probe. */
export const DB_MAX_DATABASES = 1000;

/** The inventory of an agent (3.4): at most 64 KiB in the heartbeat, at most every 6 hours. */
export const DB_INVENTORY_MAX_BYTES = 64 * 1024;
export const DB_INVENTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Error codes (prefix `db_`, 9). D1 uses the ones of the connection test; the others belong to
 * runs, checks and modes of later stages and are listed here so the UI and the agent share them.
 */
export const DB_ERROR_CODES = [
  "db_unreachable",
  "db_login_failed",
  "db_permission_missing",
  "db_engine_changed",
  "db_instance_changed",
  "db_target_is_restow",
  "db_private_network",
  "db_forbidden_address",
  "db_tls_changed",
  "db_tls_missing",
  "db_not_a_database",
  "db_engine_unsupported",
  "db_auth_unsupported",
  "db_dump_failed",
  "db_snapshot_failed",
  "db_tool_missing",
  "db_tool_too_old",
  "db_no_space",
  "db_restore_name_taken",
  "db_restore_failed",
  "db_backup_mismatch",
  /** A statement header of a MySQL dump the restore's filter could not check (16 "D4" M3). */
  "db_restore_unchecked",
  "db_verify_no_space",
  "db_verify_timeout",
  "db_runner_offline",
  /** The executor's platform cannot run this (PostgreSQL and MySQL on a Windows agent: E7). */
  "db_platform_unsupported",
  "db_pitr_slot_unbounded",
  "db_pitr_gap",
  "db_warm_copy_name_taken",
  "db_probe_failed",
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

/** Notices (not errors) of section 9. */
export const DB_NOTICE_CODES = [
  "db_nontransactional_tables",
  "db_version_untested",
  "db_too_large_to_verify",
  "db_run_overlap",
  "db_run_slow",
  "db_unencrypted",
] as const;
export type DbNoticeCode = (typeof DB_NOTICE_CODES)[number];

export function isDbEngine(value: unknown): value is DbEngine {
  return typeof value === "string" && (DB_ENGINES as readonly string[]).includes(value);
}

export function isDbErrorCode(value: unknown): value is DbErrorCode {
  return typeof value === "string" && (DB_ERROR_CODES as readonly string[]).includes(value);
}

/** Why an executor cannot open a connection, or null when it can (4.1, 4.2). */
export type DbExecutorRefusal = "engine_needs_agent" | "socket_needs_agent";

/**
 * Whether an executor can open a connection of this engine with this sign-in: the server only
 * network engines it speaks and only with a password; SQLite, SQL Server and the socket need an
 * agent. `engine` null (not detected yet) is judged by the sign-in alone.
 */
export function dbExecutorRefusal(
  kind: DbExecutorKind,
  engine: DbEngine | null,
  authMethod: DbAuthMethod,
): DbExecutorRefusal | null {
  if (kind === "agent") {
    return null;
  }
  if (authMethod === "socket") {
    return "socket_needs_agent";
  }
  if (engine !== null && !(DB_SERVER_ENGINES as readonly string[]).includes(engine)) {
    return "engine_needs_agent";
  }
  return null;
}

/** Whether an agent names the capability to run connections. */
export function hasDbRunnerCapability(capabilities: readonly string[] | null | undefined): boolean {
  return capabilities?.includes(DB_RUNNER_CAPABILITY) === true;
}

/** System databases that are never protected as databases of their own (5.2, 5.3). */
export function isDbSystemDatabase(engine: DbEngine, name: string): boolean {
  switch (engine) {
    case "postgresql":
      return name === "template0" || name === "template1";
    case "mysql":
    case "mariadb":
      return ["mysql", "sys", "performance_schema", "information_schema"].includes(
        name.toLowerCase(),
      );
    case "sqlserver":
      return ["master", "model", "msdb", "tempdb"].includes(name.toLowerCase());
    case "sqlite":
      return false;
  }
}
