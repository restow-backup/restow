import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chooseMysqlTools,
  dbDumpFileName,
  type MysqlFamily,
  mariadbUsersArgs,
  mysqlClientFailureCode,
  mysqlDefinerFilter,
  mysqlDumpArgs,
  mysqlQuoteIdent,
  mysqlRestoreArgs,
  mysqlServerVersion,
  mysqlToolEnv,
  openMysqlAdminSession,
  openMysqlRelay,
  type PgAdminSession,
  privateTempDir,
  type RepositoryAccess,
  resticDump,
  sanitizeDbMessage,
  validMysqlSchemaName,
  withRepository,
  writeMysqlOptionFile,
} from "@restow/core";
import {
  type DatabaseConnection,
  type DatabaseRun,
  databaseBackups,
  databaseConnections,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import {
  type DatabaseRunDeps,
  DatabaseRunFailure,
  dumpThrough,
  ensureDatabaseRepository,
  finishRun,
  PROGRAM_MAX_MS,
  type Prepared,
  prepare,
  recordBackup,
  recordDatabases,
  selected,
} from "./runs.js";

/**
 * Backups and restores of MySQL and MariaDB by the Restow server (docs/DATABASES.md 5.3, 7.1,
 * 16 "D4"): the same run as PostgreSQL (./runs.ts) with the engine's programs through the MySQL
 * relay, one snapshot per schema plus the instance's users and grants, and a restore into a new
 * schema with a marker table, the DEFINER filter and the events switched off.
 */

/** Schemas of the server itself, never backed up as a database (5.3). */
const SYSTEM_SCHEMAS = new Set(["mysql", "sys", "performance_schema", "information_schema"]);
/** Accounts of the server itself, left out of the users backup. */
const SYSTEM_ACCOUNTS = new Set(["mysql.sys", "mysql.session", "mysql.infoschema", "mariadb.sys"]);
/** Engines with transactions: anything else is inconsistent under --single-transaction. */
const TRANSACTIONAL = new Set(["innodb", "xtradb", "ndbcluster", "ndb", "rocksdb", "tokudb"]);
/** At most this many names in the notice `db_nontransactional_tables`. */
const NONTRANSACTIONAL_NAMES = 20;

function family(connection: DatabaseConnection): MysqlFamily {
  return connection.engine === "mariadb" ? "mariadb" : "mysql";
}

async function adminSession(prepared: Prepared): Promise<PgAdminSession> {
  const opened = await openMysqlAdminSession(
    prepared.target,
    family(prepared.connection),
    prepared.network,
    prepared.credentials,
    null,
  );
  if (!opened.ok) {
    throw new DatabaseRunFailure(opened.code, opened.message);
  }
  // The first connection did the instance check: the relays go to the same address.
  if (!prepared.target.address && opened.session.connectedAddress) {
    prepared.target = { ...prepared.target, address: opened.session.connectedAddress };
  }
  return opened.session;
}

export interface MysqlInstanceFacts {
  version: string;
  serverVersion: { major: number; minor: number };
  instanceKey: string;
  lowerCaseNames: boolean;
  schemas: { name: string; characterSet: string | null; collation: string | null }[];
}

/** The instance as the run sees it (3.3: MySQL `server_uuid`, MariaDB `server_id` and datadir). */
export async function mysqlInstanceFacts(
  session: PgAdminSession,
  engine: MysqlFamily,
): Promise<MysqlInstanceFacts> {
  const [head] = await session.query(
    "SELECT VERSION(), @@server_id, @@datadir, @@lower_case_table_names",
  );
  let instanceKey: string;
  if (engine === "mysql") {
    const [uuid] = await session.query("SELECT @@server_uuid");
    instanceKey = `mysql:${String(uuid?.[0] ?? "").toLowerCase()}`;
  } else {
    instanceKey = `mariadb:${head?.[1] ?? ""}:${head?.[2] ?? ""}`;
  }
  const rows = await session.query(
    "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
  );
  const version = head?.[0] ?? "";
  return {
    version,
    serverVersion: mysqlServerVersion(version),
    instanceKey,
    lowerCaseNames: (head?.[3] ?? "0") !== "0",
    schemas: rows
      .map((row) => ({
        name: row[0] ?? "",
        characterSet: row[1] ?? null,
        collation: row[2] ?? null,
      }))
      .filter((schema) => schema.name !== "" && !SYSTEM_SCHEMAS.has(schema.name.toLowerCase())),
  };
}

/** Tables without transactions per schema (M4), from constant literals only. */
async function nontransactionalTables(session: PgAdminSession): Promise<Map<string, string[]>> {
  const rows = await session.query(
    "SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE'",
  );
  const found = new Map<string, string[]>();
  for (const [schema, table, engine] of rows) {
    if (!schema || !table || !engine || TRANSACTIONAL.has(engine.toLowerCase())) {
      continue;
    }
    found.set(schema, [...(found.get(schema) ?? []), table]);
  }
  return found;
}

/** MySQL's users and grants as SQL, from Restow's own client; null when they cannot be read. */
async function mysqlUsersSql(session: PgAdminSession): Promise<string | null> {
  let accounts: (string | null)[][];
  try {
    accounts = await session.query("SELECT User, Host FROM mysql.user ORDER BY User, Host");
  } catch {
    return null;
  }
  // MySQL writes the hashes of caching_sha2_password as raw bytes; as hex they survive the text
  // (8.0.17 and later; an older server keeps its printable hashes).
  await session.query("SET SESSION print_identified_with_as_hex = ON").catch(() => undefined);
  const lines = [
    '-- Users and grants of the instance, written by Restow (docs/DATABASES.md 16 "D4").',
    "-- Review before running: it creates accounts with their password hashes.",
    "",
  ];
  for (const [user, host] of accounts) {
    if (user === null || host === null || SYSTEM_ACCOUNTS.has(user)) {
      continue;
    }
    const account = `${mysqlQuoteIdent(user)}@${mysqlQuoteIdent(host)}`;
    const [create] = await session.query(`SHOW CREATE USER ${account}`);
    if (create?.[0]) {
      lines.push(`${create[0].replace(/^CREATE USER /, "CREATE USER IF NOT EXISTS ")};`);
    }
    for (const [grant] of await session.query(`SHOW GRANTS FOR ${account}`)) {
      if (grant) {
        lines.push(`${grant};`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** A backup run of MySQL or MariaDB on the server (5.3, 16 "D4"). */
export async function serverMysqlBackup(
  deps: DatabaseRunDeps,
  run: DatabaseRun,
  prepared: Prepared,
): Promise<void> {
  const { connection } = prepared;
  const engine = family(connection);
  const admin = await adminSession(prepared);
  let facts: MysqlInstanceFacts;
  let nontransactional: Map<string, string[]>;
  let usersSql: string | null = null;
  try {
    facts = await mysqlInstanceFacts(admin, engine);
    if (connection.instanceKey && connection.instanceKey !== facts.instanceKey) {
      throw new DatabaseRunFailure(
        "db_instance_changed",
        "Another instance answers under the address; an administrator confirms it after a test.",
      );
    }
    nontransactional = await nontransactionalTables(admin);
    if (engine === "mysql") {
      usersSql = await mysqlUsersSql(admin);
    }
  } finally {
    admin.close();
  }
  const tools = await (deps.mysqlTools ?? chooseMysqlTools)(engine, facts.serverVersion);
  if (!tools.ok) {
    throw new DatabaseRunFailure(tools.code, tools.message);
  }
  const ids = await recordDatabases(
    deps,
    connection,
    facts.instanceKey,
    facts.schemas.map((schema) => ({ name: schema.name, oid: null })),
  );
  const notes: Record<string, unknown>[] = [];
  const wanted = facts.schemas.filter((schema) => selected(connection, schema.name));
  const access = await ensureDatabaseRepository(deps, connection);
  const dir = await privateTempDir("restow-db-run-");
  const toolVersion = `${tools.tools.version.major}.${tools.tools.version.minor}`;
  let failed = 0;
  let done = 0;
  const failure = (error: unknown) => ({
    code: error instanceof DatabaseRunFailure ? error.code : "db_dump_failed",
    message: sanitizeDbMessage(
      error instanceof Error ? error.message : String(error),
      prepared.credentials,
    ).slice(0, 500),
  });
  try {
    await withRepository(access, async (session) => {
      const baseTags = [
        "restow-db",
        `restow-db-engine=${engine}`,
        `restow-db-connection=${connection.id}`,
        `restow-db-run=${run.id}`,
      ];
      const through = (args: (optionFile: string) => string[]) => ({
        open: () =>
          openMysqlRelay({
            target: prepared.target,
            engine,
            network: prepared.network,
            maxDurationMs: PROGRAM_MAX_MS,
          }),
        argsOf: args,
      });
      for (const schema of wanted) {
        const tables = nontransactional.get(schema.name);
        if (tables?.length) {
          notes.push({
            database: schema.name,
            code: "db_nontransactional_tables",
            tables: tables.slice(0, NONTRANSACTIONAL_NAMES),
            more: Math.max(0, tables.length - NONTRANSACTIONAL_NAMES),
          });
        }
        const databaseId = ids.get(schema.name) ?? null;
        const fileName = dbDumpFileName(engine, "database", schema.name);
        try {
          const relayed = through((file) => mysqlDumpArgs(file, engine, schema.name));
          const dumped = await dumpWithOptions(
            deps,
            session,
            dir,
            prepared,
            relayed,
            tools.tools.dump,
            {
              fileName,
              tags: [...baseTags, ...(databaseId ? [`restow-db-database=${databaseId}`] : [])],
            },
          );
          await recordBackup(deps, run, connection, {
            databaseId,
            kind: "database",
            name: schema.name,
            identity: null,
            instanceKey: facts.instanceKey,
            fileName,
            dumped,
            toolVersion,
            serverVersion: facts.version,
            engineOptions: {
              ...(schema.characterSet ? { characterSet: schema.characterSet } : {}),
              ...(schema.collation ? { collation: schema.collation } : {}),
            },
          });
          notes.push({ database: schema.name, result: "backed_up", snapshotId: dumped.snapshotId });
          done++;
        } catch (error) {
          failed++;
          notes.push({ database: schema.name, result: "failed", ...failure(error) });
        }
      }
      // The users and grants once per instance (the "globals" of D3).
      const fileName = dbDumpFileName(engine, "globals", "");
      try {
        let dumped: Awaited<ReturnType<typeof dumpThrough>> | null = null;
        if (engine === "mariadb") {
          const relayed = through((file) => mariadbUsersArgs(file));
          dumped = await dumpWithOptions(deps, session, dir, prepared, relayed, tools.tools.dump, {
            fileName,
            tags: [...baseTags, "restow-db-globals"],
            count: false,
          });
        } else if (usersSql !== null) {
          const input = join(dir, "users.sql");
          await writeFile(input, usersSql, { mode: 0o600 });
          try {
            dumped = await dumpThrough(deps, session, dir, {
              open: null,
              spec: () => ({ tool: "", args: [], env: {}, listTool: null, inputFile: input }),
              fileName,
              tags: [...baseTags, "restow-db-globals"],
            });
          } finally {
            await rm(input, { force: true });
          }
        }
        if (dumped) {
          await recordBackup(deps, run, connection, {
            databaseId: null,
            kind: "globals",
            name: "",
            identity: null,
            instanceKey: facts.instanceKey,
            fileName,
            dumped,
            toolVersion,
            serverVersion: facts.version,
          });
          notes.push({ globals: true, result: "backed_up" });
          done++;
        } else {
          // The user may not read the accounts: a hint, not a failure.
          notes.push({ globals: true, result: "skipped", code: "db_permission_missing" });
        }
      } catch (error) {
        failed++;
        notes.push({ globals: true, result: "failed", ...failure(error) });
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

/** One dump through a relay of its own, with an option file for that relay's socket. */
async function dumpWithOptions(
  deps: DatabaseRunDeps,
  session: Parameters<typeof dumpThrough>[1],
  dir: string,
  prepared: Prepared,
  relayed: { open: Parameters<typeof dumpThrough>[3]["open"]; argsOf: (file: string) => string[] },
  tool: string,
  input: { fileName: string; tags: string[]; count?: boolean },
) {
  let optionFile = "";
  try {
    return await dumpThrough(deps, session, dir, {
      open: relayed.open,
      spec: async (relay) => {
        // Written for this relay's socket (0600, the private directory); removed afterwards.
        optionFile = await writeMysqlOptionFile(dir, {
          user: prepared.credentials.user,
          password: prepared.credentials.password,
          socket: relay?.socketPath ?? "",
        });
        return {
          tool,
          args: relayed.argsOf(optionFile),
          env: mysqlToolEnv(dir),
          listTool: null,
          countMysql: input.count !== false,
        };
      },
      fileName: input.fileName,
      tags: input.tags,
    });
  } finally {
    if (optionFile) {
      await rm(optionFile, { force: true });
    }
  }
}

/** A restore of MySQL or MariaDB into a new schema (7.1, 16 "D4" M3). */
export async function serverMysqlRestore(
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
  if (!target || target.engine !== source.engine || target.tenantId !== run.tenantId) {
    throw new DatabaseRunFailure("db_restore_failed", "The target connection is not available.");
  }
  const name = run.targetName ?? "";
  if (!validMysqlSchemaName(name)) {
    throw new DatabaseRunFailure("db_restore_failed", "The new schema's name is not valid.");
  }
  const engine = family(target);
  const prepared = await prepare(deps, target);
  seen(prepared.credentials);
  const marker = `__restow_run_${run.id.replace(/-/g, "").slice(0, 12)}`;
  const admin = await adminSession(prepared);
  let created = false;
  let facts: MysqlInstanceFacts;
  try {
    facts = await mysqlInstanceFacts(admin, engine);
    if (target.instanceKey && target.instanceKey !== facts.instanceKey) {
      throw new DatabaseRunFailure(
        "db_instance_changed",
        "Another instance answers under the target's address.",
      );
    }
    const all = await admin.query("SHOW DATABASES");
    const same = (a: string) =>
      facts.lowerCaseNames ? a.toLowerCase() === name.toLowerCase() : a === name;
    if (all.some(([existing]) => existing !== null && same(existing))) {
      throw new DatabaseRunFailure("db_restore_name_taken", "A schema of that name exists.");
    }
    const options = backup.engineOptions ?? {};
    const word = (value: string | undefined) =>
      value && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null;
    const characterSet = word(options.characterSet);
    const collation = word(options.collation);
    try {
      await admin.query(
        `CREATE DATABASE ${mysqlQuoteIdent(name)}${characterSet ? ` CHARACTER SET ${characterSet}` : ""}${collation ? ` COLLATE ${collation}` : ""}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errno = (error as { errno?: number }).errno;
      throw new DatabaseRunFailure(
        errno === 1007
          ? "db_restore_name_taken"
          : errno === 1044 || errno === 1227
            ? "db_permission_missing"
            : "db_restore_failed",
        message,
      );
    }
    created = true;
    await admin.query(
      `CREATE TABLE ${mysqlQuoteIdent(name)}.${mysqlQuoteIdent(marker)} (run_id CHAR(36) NOT NULL)`,
    );
  } catch (error) {
    if (created) {
      await dropOwnSchema(admin, name, marker).catch(() => undefined);
    }
    admin.close();
    throw error;
  }
  admin.close();
  try {
    const tools = await (deps.mysqlTools ?? chooseMysqlTools)(engine, facts.serverVersion);
    if (!tools.ok) {
      throw new DatabaseRunFailure(tools.code, tools.message);
    }
    const access = await ensureDatabaseRepository(deps, source);
    const restored = await restoreInto(access, backup, prepared, tools.tools.client, name);
    const after = await adminSession(prepared);
    let eventsDisabled = 0;
    try {
      for (const row of await after.query(`SHOW EVENTS FROM ${mysqlQuoteIdent(name)}`)) {
        const event = row[1];
        if (event) {
          await after.query(
            `ALTER EVENT ${mysqlQuoteIdent(name)}.${mysqlQuoteIdent(event)} DISABLE`,
          );
          eventsDisabled++;
        }
      }
      await after.query(`DROP TABLE ${mysqlQuoteIdent(name)}.${mysqlQuoteIdent(marker)}`);
    } finally {
      after.close();
    }
    await finishRun(deps, run, {
      status: "succeeded",
      notes: [
        {
          result: "restored",
          definersRemoved: restored.definersRemoved,
          eventsDisabled,
        },
      ],
    });
  } catch (error) {
    // Only the schema this run created: its name and its marker table, never by a pattern.
    const cleanup = await adminSession(prepared).catch(() => null);
    if (cleanup) {
      await dropOwnSchema(cleanup, name, marker).catch(() => undefined);
      cleanup.close();
    }
    throw error;
  }
}

/** Drop `name` only while it still holds this run's marker table. */
async function dropOwnSchema(session: PgAdminSession, name: string, marker: string): Promise<void> {
  try {
    await session.query(
      `SELECT 1 FROM ${mysqlQuoteIdent(name)}.${mysqlQuoteIdent(marker)} LIMIT 1`,
    );
  } catch {
    return;
  }
  await session.query(`DROP DATABASE ${mysqlQuoteIdent(name)}`);
}

async function restoreInto(
  access: RepositoryAccess,
  backup: { snapshotId: string; fileName: string; sha256: string },
  prepared: Prepared,
  client: string,
  name: string,
): Promise<{ definersRemoved: number }> {
  const dir = await privateTempDir("restow-db-restore-");
  try {
    return await withRepository(access, async (session) => {
      const relay = await openMysqlRelay({
        target: prepared.target,
        engine: family(prepared.connection),
        network: prepared.network,
        maxDurationMs: PROGRAM_MAX_MS,
      });
      if (!relay.ok) {
        throw new DatabaseRunFailure(relay.code, relay.message);
      }
      const optionFile = await writeMysqlOptionFile(dir, {
        user: prepared.credentials.user,
        password: prepared.credentials.password,
        socket: relay.relay.socketPath,
      });
      try {
        const dump = resticDump(session, backup.snapshotId, `/${backup.fileName}`);
        const hash = createHash("sha256");
        const filter = mysqlDefinerFilter();
        let stderr = "";
        const child = spawn(client, mysqlRestoreArgs(optionFile, name), {
          env: mysqlToolEnv(dir),
          cwd: dir,
          stdio: ["pipe", "ignore", "pipe"],
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4096);
        });
        child.stdin.on("error", () => undefined);
        filter.stream.on("error", () => undefined);
        dump.stream.on("data", (chunk: Buffer) => hash.update(chunk));
        dump.stream.pipe(filter.stream).pipe(child.stdin);
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
          const ended = await Promise.race([
            relay.relay.ended,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref()),
          ]);
          if (ended?.failure) {
            throw new DatabaseRunFailure(ended.failure.code, ended.failure.message);
          }
          throw new DatabaseRunFailure(
            mysqlClientFailureCode(stderr),
            sanitizeDbMessage(stderr.trim() || "the client failed", prepared.credentials),
          );
        }
        return { definersRemoved: filter.scanner.definersRemoved };
      } finally {
        relay.relay.close();
        await rm(optionFile, { force: true });
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
