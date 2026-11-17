import type { DbProbeResult } from "./facts.js";
import { type DbEngine, isDbSystemDatabase } from "./model.js";

/**
 * Identity (docs/DATABASES.md 3.3). A database dropped and created again under the same name is
 * another database with a history of its own, and an instance that answers under the address
 * after a move or a failover is another instance:
 *
 *   PostgreSQL     instance = system_identifier of the cluster, database = name and OID
 *   MySQL          instance = @@server_uuid, schema = name (a schema has no stable id)
 *   MariaDB        instance = @@server_id and @@datadir, schema = name
 *   SQLite         path, device and inode, birth time where the system has one
 *   SQL Server     family_guid, as in 0.5.0 (it moves into the module in D5)
 *
 * The instance identity is stored with the connection as one string key; a probe that finds
 * another key turns the connection red (`db_instance_changed`) until an administrator confirms.
 */

export type DbInstanceIdentity =
  | { engine: "postgresql"; systemIdentifier: string }
  | { engine: "mysql"; serverUuid: string }
  | { engine: "mariadb"; serverId: number; datadir: string }
  | {
      engine: "sqlite";
      path: string;
      device: string | null;
      inode: string | null;
      createdAt: string | null;
    };

/** The instance identity a probe found, or null where it cannot tell. */
export function dbInstanceIdentityOf(result: DbProbeResult): DbInstanceIdentity | null {
  switch (result.engine) {
    case "postgresql":
      return result.postgresql?.systemIdentifier
        ? { engine: "postgresql", systemIdentifier: result.postgresql.systemIdentifier }
        : null;
    case "mysql":
      return result.mysql?.serverUuid
        ? { engine: "mysql", serverUuid: result.mysql.serverUuid }
        : null;
    case "mariadb":
      return result.mysql && result.mysql.serverId !== null && result.mysql.datadir
        ? { engine: "mariadb", serverId: result.mysql.serverId, datadir: result.mysql.datadir }
        : null;
    case "sqlite":
      return result.sqlite
        ? {
            engine: "sqlite",
            path: result.sqlite.path,
            device: result.sqlite.device,
            inode: result.sqlite.inode,
            createdAt: result.sqlite.createdAt,
          }
        : null;
    default:
      return null;
  }
}

/** The identity as one comparable string. */
export function dbInstanceKey(identity: DbInstanceIdentity): string {
  switch (identity.engine) {
    case "postgresql":
      return `postgresql:${identity.systemIdentifier}`;
    case "mysql":
      return `mysql:${identity.serverUuid.toLowerCase()}`;
    case "mariadb":
      return `mariadb:${identity.serverId}:${identity.datadir}`;
    case "sqlite":
      return `sqlite:${identity.path}:${identity.device ?? ""}:${identity.inode ?? ""}:${identity.createdAt ?? ""}`;
  }
}

export type DbInstanceComparison = "same" | "changed" | "unknown";

/**
 * Whether a probe found the instance a connection knows: `unknown` when either side has no
 * identity (the user may not read it), never `changed` on a guess.
 */
export function compareDbInstance(
  storedKey: string | null,
  probed: DbInstanceIdentity | null,
): DbInstanceComparison {
  if (!storedKey || !probed) {
    return "unknown";
  }
  return storedKey === dbInstanceKey(probed) ? "same" : "changed";
}

/** One database of an instance as a probe found it. */
export interface DbFoundDatabase {
  name: string;
  /** PostgreSQL: the OID; null where the engine has no stable id (MySQL, MariaDB). */
  identity: string | null;
  sizeBytes: number | null;
  /** The executor's user may sign in to it (PostgreSQL CONNECT). */
  accessible: boolean;
}

/** The databases of a probe that can be protected: no system databases (5.2, 5.3). */
export function dbFoundDatabases(result: DbProbeResult): DbFoundDatabase[] {
  const engine: DbEngine | null = result.engine;
  if (engine === "postgresql" && result.postgresql) {
    return result.postgresql.databases
      .filter((database) => !isDbSystemDatabase(engine, database.name))
      .map((database) => ({
        name: database.name,
        identity: database.oid,
        sizeBytes: database.sizeBytes,
        accessible: database.allowConnections && database.canConnect,
      }));
  }
  if ((engine === "mysql" || engine === "mariadb") && result.mysql) {
    return result.mysql.databases
      .filter((database) => !isDbSystemDatabase(engine, database.name))
      .map((database) => ({
        name: database.name,
        identity: null,
        sizeBytes: database.sizeBytes,
        accessible: true,
      }));
  }
  if (engine === "sqlite" && result.sqlite) {
    const base = result.sqlite.path.split(/[\\/]/).pop() || result.sqlite.path;
    return [
      {
        name: base,
        identity: result.sqlite.inode,
        sizeBytes: result.sqlite.sizeBytes,
        accessible: true,
      },
    ];
  }
  return [];
}
