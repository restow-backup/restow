import type { DbMysqlFacts, DbPostgresFacts, DbProbeResult } from "./facts.js";
import { DB_BACKUP_USER, type DbEngine } from "./model.js";

/**
 * The rights matrix of the dialog (docs/DATABASES.md 3.2): what the signed-in user allows Restow
 * to do, read from the facts of a probe. The server judges; the executor only reports.
 *
 *   capability          PostgreSQL                     MySQL/MariaDB                         SQL Server
 *   backup              CONNECT, read all objects      SELECT, SHOW VIEW, TRIGGER, EVENT,     db_backupoperator
 *                       (pg_read_all_data from 14)     LOCK TABLES, PROCESS, RELOAD; MySQL
 *                                                      from 8.0.20 SHOW_ROUTINE
 *   verifyOnInstance    additionally CREATEDB          additionally CREATE, DROP, INSERT,     dbcreator
 *                                                      ALTER, INDEX, REFERENCES, CREATE
 *                                                      ROUTINE, ALTER ROUTINE, CREATE VIEW,
 *                                                      SHOW VIEW, TRIGGER, EVENT
 *   pitr                REPLICATION and a pg_hba.conf  REPLICATION SLAVE, REPLICATION         sysadmin or the log
 *                       entry `replication`            CLIENT, binlog on                      backup (7.2)
 *
 * A capability is `granted`, `missing`, `partial` (some databases only), `unknown` (Restow cannot
 * tell with this user: PostgreSQL before 14 without superuser, the pg_hba.conf entry, SQL Server
 * before it moves into the module) or `not_applicable` (SQLite: the check runs in a copy, there
 * is no point-in-time). A missing capability does not stop the connection from being saved: it
 * can then do what the user allows, and the dialog shows the SQL that grants the rest to a backup
 * user `restow_backup`.
 */

export const DB_CAPABILITIES = ["backup", "verifyOnInstance", "pitr"] as const;
export type DbCapability = (typeof DB_CAPABILITIES)[number];

export type DbCapabilityState = "granted" | "missing" | "partial" | "unknown" | "not_applicable";

export interface DbCapabilityVerdict {
  state: DbCapabilityState;
  /** The rights (or settings) that are missing, in the words of the engine. */
  missing: string[];
  /** Why the state is `unknown` or `partial`, as a code the interface explains. */
  note:
    | "pg_before_14"
    | "pg_hba_unchecked"
    | "binlog_off"
    | "some_databases"
    | "sqlserver_later"
    | "not_signed_in"
    | "grants_truncated"
    | null;
}

export interface DbRights {
  engine: DbEngine;
  /** The user is an administrator (superuser, ALL PRIVILEGES ON *.*): everything works. */
  admin: boolean;
  capabilities: Record<DbCapability, DbCapabilityVerdict>;
  /**
   * The SQL that creates `restow_backup` with the rights of the backup and of every capability
   * this user lacks (for an administrator: backup and the check on the instance, as the
   * recommendation). null where no block applies (SQLite, SQL Server in this release).
   */
  grantSql: string | null;
  /** Rights an administrator gives that Restow does not need (10), for the recommendation. */
  adminExtras: string[];
}

const verdict = (
  state: DbCapabilityState,
  missing: string[] = [],
  note: DbCapabilityVerdict["note"] = null,
): DbCapabilityVerdict => ({ state, missing, note });

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function postgresRights(facts: DbPostgresFacts): DbRights {
  const admin = facts.superuser;
  const unreachable = facts.databases.filter(
    (database) => database.allowConnections && !database.canConnect,
  );
  let backup: DbCapabilityVerdict;
  if (admin) {
    backup = verdict("granted");
  } else if (facts.readAllData === null) {
    backup = verdict("unknown", ["pg_read_all_data"], "pg_before_14");
  } else if (!facts.readAllData) {
    backup = verdict("missing", ["pg_read_all_data"]);
  } else if (unreachable.length > 0) {
    backup = verdict(
      "partial",
      unreachable.map((database) => `CONNECT ${database.name}`),
      "some_databases",
    );
  } else {
    backup = verdict("granted");
  }
  const verifyOnInstance =
    admin || facts.createDb ? verdict("granted") : verdict("missing", ["CREATEDB"]);
  const pitr =
    admin || facts.replication
      ? verdict("unknown", ["pg_hba.conf replication"], "pg_hba_unchecked")
      : verdict("missing", ["REPLICATION", "pg_hba.conf replication"]);
  const capabilities = { backup, verifyOnInstance, pitr };
  return {
    engine: "postgresql",
    admin,
    capabilities,
    grantSql: postgresGrantSql(facts.versionNum, wantedCapabilities(admin, capabilities)),
    adminExtras: admin ? ["SUPERUSER"] : [],
  };
}

/** The capabilities the grant block covers: backup always, and what this user lacks. */
function wantedCapabilities(
  admin: boolean,
  capabilities: Record<DbCapability, DbCapabilityVerdict>,
): DbCapability[] {
  if (admin) {
    return ["backup", "verifyOnInstance"];
  }
  return DB_CAPABILITIES.filter(
    (capability) => capability === "backup" || capabilities[capability].state === "missing",
  );
}

/** `CREATE ROLE restow_backup` with exactly the rights of `capabilities` (3.2). */
export function postgresGrantSql(
  versionNum: number,
  capabilities: readonly DbCapability[],
): string {
  const lines = [`CREATE ROLE ${DB_BACKUP_USER} LOGIN PASSWORD '<password>';`];
  if (capabilities.includes("backup")) {
    if (versionNum >= 140000 || versionNum === 0) {
      lines.push(`GRANT pg_read_all_data TO ${DB_BACKUP_USER};`);
    } else {
      lines.push(
        "-- PostgreSQL 13 and older: in every database and for every schema",
        `GRANT USAGE ON SCHEMA public TO ${DB_BACKUP_USER};`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DB_BACKUP_USER};`,
        `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${DB_BACKUP_USER};`,
      );
    }
  }
  if (capabilities.includes("verifyOnInstance")) {
    lines.push(`ALTER ROLE ${DB_BACKUP_USER} CREATEDB;`);
  }
  if (capabilities.includes("pitr")) {
    lines.push(
      `ALTER ROLE ${DB_BACKUP_USER} REPLICATION;`,
      `-- pg_hba.conf: host replication ${DB_BACKUP_USER} <address of the executor>/32 scram-sha-256`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MySQL and MariaDB
// ---------------------------------------------------------------------------

export const MYSQL_BACKUP_PRIVILEGES = [
  "SELECT",
  "SHOW VIEW",
  "TRIGGER",
  "EVENT",
  "LOCK TABLES",
  "PROCESS",
  "RELOAD",
] as const;
export const MYSQL_VERIFY_PRIVILEGES = [
  "CREATE",
  "DROP",
  "INSERT",
  "ALTER",
  "INDEX",
  "REFERENCES",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "CREATE VIEW",
  "SHOW VIEW",
  "TRIGGER",
  "EVENT",
] as const;
/**
 * MySQL from 8.0.20 shows a routine's body only with SHOW_ROUTINE, a global SELECT, or CREATE
 * ROUTINE, ALTER ROUTINE or EXECUTE where the routine lies (16 "D4" M3).
 */
export const MYSQL_SHOW_ROUTINE = "SHOW_ROUTINE";
const SHOW_ROUTINE_ALSO = ["CREATE ROUTINE", "ALTER ROUTINE", "EXECUTE"] as const;

/** Whether a MySQL server of `version` knows SHOW_ROUTINE (8.0.20 and later). */
export function mysqlHasShowRoutine(engine: "mysql" | "mariadb", version: string): boolean {
  if (engine !== "mysql") {
    return false;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return false;
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major > 8 || (major === 8 && (minor > 0 || patch >= 20));
}
export const MYSQL_PITR_PRIVILEGES = ["REPLICATION SLAVE", "REPLICATION CLIENT"] as const;

/** Names that stand for the same privilege on MySQL 8.4 or MariaDB 10.5 and later. */
const MYSQL_ALIASES: Readonly<Record<string, string>> = {
  "REPLICATION REPLICA": "REPLICATION SLAVE",
  "BINLOG MONITOR": "REPLICATION CLIENT",
};

/** One line of `SHOW GRANTS`: the privileges and where they apply. */
export interface MysqlGrant {
  privileges: string[];
  /** `*.*` (global), `db.*` (one database) or `db.table`; null for a role grant. */
  scope: string | null;
}

/** Read one `SHOW GRANTS` line (`GRANT … ON … TO …`); null for anything else. */
export function parseMysqlGrant(line: string): MysqlGrant | null {
  const match = /^\s*GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/is.exec(line);
  if (!match) {
    return /^\s*GRANT\s+/i.test(line) ? { privileges: [], scope: null } : null;
  }
  const privileges = (match[1] ?? "")
    // Column lists ("SELECT (id, name)") first: their commas are not privileges.
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((privilege) => privilege.replace(/\s+/g, " ").trim().toUpperCase())
    .filter((privilege) => privilege.length > 0)
    .map((privilege) => MYSQL_ALIASES[privilege] ?? privilege);
  const scope = (match[2] ?? "").replace(/[`'"]/g, "").replace(/\s+/g, "").trim();
  return { privileges, scope };
}

function mysqlRights(engine: "mysql" | "mariadb", facts: DbMysqlFacts): DbRights {
  const grants = facts.grants.map(parseMysqlGrant).filter((grant) => grant !== null);
  const global = new Set<string>();
  const perDatabase = new Map<string, Set<string>>();
  for (const grant of grants) {
    if (grant.scope === "*.*") {
      for (const privilege of grant.privileges) {
        global.add(privilege);
      }
    } else if (grant.scope?.endsWith(".*")) {
      const set = perDatabase.get(grant.scope) ?? new Set<string>();
      for (const privilege of grant.privileges) {
        set.add(privilege);
      }
      perDatabase.set(grant.scope, set);
    }
  }
  const all = global.has("ALL PRIVILEGES") || global.has("ALL");
  const admin = all || global.has("SUPER");
  const holds = (set: ReadonlySet<string>, privilege: string) =>
    set.has(privilege) ||
    (privilege === MYSQL_SHOW_ROUTINE && SHOW_ROUTINE_ALSO.some((other) => set.has(other)));
  const has = (privilege: string) =>
    all || holds(global, privilege) || (privilege === MYSQL_SHOW_ROUTINE && global.has("SELECT"));
  const judge = (wanted: readonly string[], perDatabaseCounts = false): DbCapabilityVerdict => {
    const missing = wanted.filter((privilege) => !has(privilege));
    if (missing.length === 0) {
      return verdict("granted");
    }
    // A backup of some databases may still be covered by grants of their own (a check needs
    // CREATE DATABASE, which only a global grant gives).
    const someDatabase =
      perDatabaseCounts &&
      [...perDatabase.values()].some((set) =>
        missing.every(
          (privilege) =>
            holds(set, privilege) ||
            set.has("ALL PRIVILEGES") ||
            set.has("ALL") ||
            // PROCESS and RELOAD are global privileges only; a database grant cannot carry them.
            privilege === "PROCESS" ||
            privilege === "RELOAD",
        ),
      );
    return someDatabase
      ? verdict("partial", missing, "some_databases")
      : verdict("missing", missing);
  };
  const showRoutine = mysqlHasShowRoutine(engine, facts.version);
  const backup = judge(
    showRoutine ? [...MYSQL_BACKUP_PRIVILEGES, MYSQL_SHOW_ROUTINE] : MYSQL_BACKUP_PRIVILEGES,
    true,
  );
  const verifyOnInstance = judge(MYSQL_VERIFY_PRIVILEGES);
  let pitr = judge(MYSQL_PITR_PRIVILEGES);
  if (facts.logBin === false) {
    pitr = verdict(
      pitr.state === "granted" ? "missing" : pitr.state,
      [...pitr.missing, "log_bin"],
      "binlog_off",
    );
  }
  // `SHOW GRANTS` was cut: a right that was not read is not known to be missing.
  const honest = (judged: DbCapabilityVerdict): DbCapabilityVerdict =>
    facts.grantsTruncated && judged.state !== "granted" && judged.note !== "binlog_off"
      ? verdict("unknown", judged.missing, "grants_truncated")
      : judged;
  const capabilities = {
    backup: honest(backup),
    verifyOnInstance: honest(verifyOnInstance),
    pitr: honest(pitr),
  };
  const wanted = wantedCapabilities(admin, capabilities);
  return {
    engine,
    admin,
    capabilities,
    grantSql: mysqlGrantSql(wanted, { showRoutine }),
    adminExtras: admin ? (all ? ["ALL PRIVILEGES"] : ["SUPER"]) : [],
  };
}

/**
 * `CREATE USER 'restow_backup'` with exactly the privileges of `capabilities` (3.2);
 * `showRoutine` for MySQL from 8.0.20.
 */
export function mysqlGrantSql(
  capabilities: readonly DbCapability[],
  options: { showRoutine?: boolean } = {},
): string {
  const wanted: string[] = [];
  if (capabilities.includes("backup")) {
    wanted.push(...MYSQL_BACKUP_PRIVILEGES);
    if (options.showRoutine) {
      wanted.push(MYSQL_SHOW_ROUTINE);
    }
  }
  if (capabilities.includes("verifyOnInstance")) {
    wanted.push(...MYSQL_VERIFY_PRIVILEGES);
  }
  if (capabilities.includes("pitr")) {
    wanted.push(...MYSQL_PITR_PRIVILEGES);
  }
  const privileges = [...new Set(wanted)];
  const user = `'${DB_BACKUP_USER}'@'%'`;
  return [
    `CREATE USER ${user} IDENTIFIED BY '<password>';`,
    `GRANT ${privileges.join(", ")} ON *.* TO ${user};`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The matrix of one probe
// ---------------------------------------------------------------------------

/** The rights matrix of a probe; null when nothing was signed in to (no engine, sign-in failed). */
export function evaluateDbRights(result: DbProbeResult): DbRights | null {
  const engine = result.engine;
  if (engine === null) {
    return null;
  }
  if (engine === "sqlite") {
    return result.sqlite
      ? {
          engine,
          admin: false,
          capabilities: {
            backup: verdict("granted"),
            verifyOnInstance: verdict("not_applicable"),
            pitr: verdict("not_applicable"),
          },
          grantSql: null,
          adminExtras: [],
        }
      : null;
  }
  if (engine === "sqlserver") {
    // SQL Server keeps its native backup on the machine page until it moves into the module (D5).
    const later = verdict("unknown", [], "sqlserver_later");
    return {
      engine,
      admin: false,
      capabilities: { backup: later, verifyOnInstance: later, pitr: later },
      grantSql: null,
      adminExtras: [],
    };
  }
  if (result.login !== "ok") {
    return null;
  }
  if (engine === "postgresql") {
    return result.postgresql ? postgresRights(result.postgresql) : null;
  }
  return result.mysql ? mysqlRights(engine, result.mysql) : null;
}
