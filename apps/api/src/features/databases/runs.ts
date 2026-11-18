import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import {
  DB_ERROR_CODES,
  hashSecret,
  openRepository,
  type RepositoryAccess,
  resticBinary,
  resticCacheBase,
  resticDump,
  resticInit,
  resticSnapshots,
  sanitizeDbMessage,
  secretMatchesHash,
  withRepository,
} from "@restow/core";
import {
  type DatabaseBackup,
  type DatabaseConnection,
  type DatabaseRun,
  databaseBackups,
  databaseConnections,
  databaseRuns,
  databases,
  endpoints,
  insertDatabaseRunTx,
  recordInstanceDatabasesTx,
  tenants,
} from "@restow/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db as appDb, providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import type { RunResticResolution } from "../../lib/restic-run-route.js";
import { readSecret, storeSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { tenantStorage } from "../endpoints/repository.js";
import { restoreModeTaskHoldBefore } from "../restore-mode/hold.js";
import type { DatabaseContext } from "./service.js";
import { dbRunPlatformUnsupported, restowSystemIdentifier } from "./service.js";

/**
 * Backup and restore runs, stage D3 (docs/DATABASES.md 4.3, 4.4, 7.1, 9, 16 "D3"): the session
 * side ("Jetzt sichern", the backups of a database, "Wiederherstellen", the download and the
 * restore guide) and the agent side (fetch a run's credentials once, report its outcome, write
 * to the connection's repository with the run's own token). The worker runs the server's runs
 * (apps/worker databases/runs.ts).
 */

export const RUN_PROBLEMS = {
  active: "urn:restow:problem:database-run-active",
  restoreName: "urn:restow:problem:database-restore-name",
  backupGone: "urn:restow:problem:database-backup-gone",
  target: "urn:restow:problem:database-restore-target",
  /** PostgreSQL and MySQL by an agent on Windows come later (E7). */
  platform: "urn:restow:problem:database-platform-unsupported",
} as const;

export const DB_RUN_AUDIT = {
  backupRequested: "database_connection.backup_requested",
  restoreRequested: "database_connection.restore_requested",
  downloaded: "database_connection.backup_downloaded",
  /** The instance's roles and their password hashes: administrators only, audited apart. */
  globalsDownloaded: "database_connection.globals_downloaded",
} as const;

/** A new database's name: at most 63 bytes (O3). */
export const DB_NAME_MAX_BYTES = 63;

/** At most 63 bytes, no control character (NUL included), no outer blanks. */
export function validRestoreName(name: string): boolean {
  return (
    name.trim() === name &&
    name.length > 0 &&
    Buffer.byteLength(name, "utf8") <= DB_NAME_MAX_BYTES &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/** The dump's file in the repository (`postgresql/<name>.pgdump`, the globals' own). */
export function dumpFileNameOf(kind: "database" | "globals", name: string): string {
  return kind === "globals"
    ? "postgresql/globals.sql"
    : `postgresql/${name.replace(/[/\\]/g, "_")}.pgdump`;
}

/** The file's name for a download and the restore guide: only `[A-Za-z0-9._-]`. */
export function downloadFileNameOf(fileName: string): string {
  const base = (fileName.split("/").pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return /^[._-]*$/.test(base) ? "backup.pgdump" : base;
}

/** `<name>_restored_<UTC time>`, cut to 63 bytes. */
export function defaultRestoreName(name: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "_");
  const suffix = `_restored_${stamp}`;
  let base = name;
  while (Buffer.byteLength(base + suffix, "utf8") > DB_NAME_MAX_BYTES) {
    base = base.slice(0, -1);
  }
  return base + suffix;
}

export const DB_REPOSITORY_SECRET_KIND = "database_repository";

export function databaseRepositoryPrefix(connectionId: string): string {
  return `db/${connectionId}/`;
}

async function assertNoRestoreMode(): Promise<void> {
  if ((await restoreModeTaskHoldBefore()) !== null) {
    throw new ProblemError(409, "Restore mode is on", {
      type: "urn:restow:problem:restore-mode",
      detail: "No database runs start while the installation is in restore mode.",
    });
  }
}

function notFound(what: string): ProblemError {
  return new ProblemError(404, `${what} not found`);
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface DatabaseBackupDto {
  id: string;
  kind: "database" | "globals";
  databaseName: string;
  snapshotId: string;
  fileName: string;
  sha256: string;
  bytes: number;
  objects: Record<string, number>;
  toolVersion: string | null;
  serverVersion: string | null;
  startedAt: string;
  finishedAt: string;
}

function backupDto(row: DatabaseBackup): DatabaseBackupDto {
  return {
    id: row.id,
    kind: row.kind,
    databaseName: row.databaseName,
    snapshotId: row.snapshotId,
    fileName: row.fileName,
    sha256: row.sha256,
    bytes: row.bytes,
    objects: row.objects,
    toolVersion: row.toolVersion,
    serverVersion: row.serverVersion,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  };
}

export interface DatabaseRunDto {
  id: string;
  kind: "backup" | "restore";
  trigger: "schedule" | "manual";
  status: DatabaseRun["status"];
  executor: "agent" | "server";
  targetConnectionId: string | null;
  targetName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  notes: Record<string, unknown>[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function runDto(row: DatabaseRun): DatabaseRunDto {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    executor: row.executorKind,
    targetConnectionId: row.targetConnectionId,
    targetName: row.targetName,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------

async function databaseAndConnection(tx: DbExecutor, tenantId: string, databaseId: string) {
  const [row] = await tx
    .select({ database: databases, connection: databaseConnections })
    .from(databases)
    .innerJoin(databaseConnections, eq(databaseConnections.id, databases.connectionId))
    .where(and(eq(databases.tenantId, tenantId), eq(databases.id, databaseId)))
    .limit(1);
  if (!row) {
    throw notFound("Database");
  }
  return row;
}

/** Refuse a run its executor cannot do: an agent on Windows for PostgreSQL or MySQL (E7). */
async function assertPlatformRuns(tx: DbExecutor, connection: DatabaseConnection): Promise<void> {
  if (connection.executorKind !== "agent" || !connection.executorEndpointId) {
    return;
  }
  const [endpoint] = await tx
    .select({ os: endpoints.os })
    .from(endpoints)
    .where(eq(endpoints.id, connection.executorEndpointId))
    .limit(1);
  if (dbRunPlatformUnsupported(connection, endpoint ?? null)) {
    throw new ProblemError(422, "Not on this executor's platform yet", {
      type: RUN_PROBLEMS.platform,
      detail:
        "Backups and restores of this engine by an agent on Windows come with a later version; the agent tests and checks the connection meanwhile.",
      extensions: { code: "db_platform_unsupported" },
    });
  }
}

function runActive(): ProblemError {
  return new ProblemError(409, "A run of this connection is active", {
    type: RUN_PROBLEMS.active,
    detail: "The connection runs a backup or a restore; try again when it ended.",
  });
}

/** "Jetzt sichern": a manual backup run of the database's connection. */
export async function requestBackup(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
  ctx: DatabaseContext,
): Promise<DatabaseRunDto> {
  await assertNoRestoreMode();
  const now = ctx.now ?? new Date();
  return withTenantTx(db, tenantId, async (tx) => {
    const { connection } = await databaseAndConnection(tx, tenantId, databaseId);
    if (connection.engine !== "postgresql") {
      throw new ProblemError(422, "Not backed up yet", {
        detail: "Backups of this engine come with a later stage.",
      });
    }
    await assertPlatformRuns(tx, connection);
    const run = await insertDatabaseRunTx(
      tx,
      connection,
      connection,
      { kind: "backup", trigger: "manual", requestedBy: ctx.actor.label },
      now,
    );
    if (!run) {
      throw runActive();
    }
    await audit(tx, {
      tenantId,
      actor: ctx.actor.label,
      actorUserId: ctx.actor.userId,
      ip: ctx.actor.ip,
      action: DB_RUN_AUDIT.backupRequested,
      target: connection.id,
      targetType: "database_connection",
      details: { runId: run.id, databaseId },
    });
    return runDto(run);
  });
}

/** The active backups of a database, newest first. */
export async function listBackups(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
): Promise<{ backups: DatabaseBackupDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    await databaseAndConnection(tx, tenantId, databaseId);
    const rows = await tx
      .select()
      .from(databaseBackups)
      .where(and(eq(databaseBackups.databaseId, databaseId), eq(databaseBackups.status, "active")))
      .orderBy(desc(databaseBackups.finishedAt))
      .limit(500);
    return { backups: rows.map(backupDto) };
  });
}

/** The runs of a connection, newest first. */
export async function listRuns(
  db: DbExecutor,
  tenantId: string,
  connectionId: string,
): Promise<{ runs: DatabaseRunDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(databaseRuns)
      .where(and(eq(databaseRuns.tenantId, tenantId), eq(databaseRuns.connectionId, connectionId)))
      .orderBy(desc(databaseRuns.createdAt))
      .limit(100);
    return { runs: rows.map(runDto) };
  });
}

export const restoreRequestSchema = z
  .object({
    backupId: z.string().uuid(),
    /** Another connection of the tenant (same engine); default: the database's own. */
    targetConnectionId: z.string().uuid().optional(),
    /** The new database's name; default `<name>_restored_<UTC time>`. */
    name: z.string().min(1).max(200).optional(),
  })
  .strict();
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

/** "Wiederherstellen": always into a new database (O3), on this or another connection. */
export async function requestRestore(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
  input: RestoreRequest,
  ctx: DatabaseContext,
): Promise<DatabaseRunDto> {
  await assertNoRestoreMode();
  const now = ctx.now ?? new Date();
  return withTenantTx(db, tenantId, async (tx) => {
    const { database, connection } = await databaseAndConnection(tx, tenantId, databaseId);
    const [backup] = await tx
      .select()
      .from(databaseBackups)
      .where(
        and(eq(databaseBackups.id, input.backupId), eq(databaseBackups.databaseId, database.id)),
      )
      .limit(1);
    if (backup?.status !== "active" || backup.kind !== "database") {
      throw new ProblemError(422, "Backup not available", {
        type: RUN_PROBLEMS.backupGone,
        extensions: { field: "backupId" },
      });
    }
    let target: DatabaseConnection = connection;
    if (input.targetConnectionId && input.targetConnectionId !== connection.id) {
      const [other] = await tx
        .select()
        .from(databaseConnections)
        .where(
          and(
            eq(databaseConnections.tenantId, tenantId),
            eq(databaseConnections.id, input.targetConnectionId),
          ),
        )
        .limit(1);
      if (!other || other.engine !== connection.engine) {
        throw new ProblemError(422, "Target connection not usable", {
          type: RUN_PROBLEMS.target,
          detail: "Restore onto a connection of the same engine of this tenant.",
          extensions: { field: "targetConnectionId" },
        });
      }
      target = other;
    }
    await assertPlatformRuns(tx, target);
    const name = input.name ?? defaultRestoreName(database.name, now);
    if (!validRestoreName(name)) {
      throw new ProblemError(422, "Invalid database name", {
        type: RUN_PROBLEMS.restoreName,
        detail: `The new database's name has at most ${DB_NAME_MAX_BYTES} bytes and no control characters.`,
        extensions: { field: "name" },
      });
    }
    // The run belongs to the source (its repository, one run at a time); the target's executor
    // runs it with the target's credentials and network.
    const run = await insertDatabaseRunTx(
      tx,
      connection,
      target,
      {
        kind: "restore",
        trigger: "manual",
        requestedBy: ctx.actor.label,
        sourceBackupId: backup.id,
        targetConnectionId: target.id,
        targetName: name,
      },
      now,
    );
    if (!run) {
      throw runActive();
    }
    await audit(tx, {
      tenantId,
      actor: ctx.actor.label,
      actorUserId: ctx.actor.userId,
      ip: ctx.actor.ip,
      action: DB_RUN_AUDIT.restoreRequested,
      target: connection.id,
      targetType: "database_connection",
      details: {
        runId: run.id,
        databaseId,
        backupId: backup.id,
        targetConnectionId: target.id,
        name,
      },
    });
    return runDto(run);
  });
}

/**
 * A dump of the database (never the globals: they carry the roles' password hashes and are read
 * through {@link downloadGlobals} by administrators only).
 */
async function backupOf(tx: DbExecutor, tenantId: string, databaseId: string, backupId: string) {
  const { database, connection } = await databaseAndConnection(tx, tenantId, databaseId);
  const [backup] = await tx
    .select()
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.connectionId, connection.id),
        eq(databaseBackups.kind, "database"),
        eq(databaseBackups.databaseId, database.id),
      ),
    )
    .limit(1);
  if (backup?.status !== "active") {
    throw notFound("Backup");
  }
  return { database, connection, backup };
}

/** A globals backup of a connection (roles, tablespaces). */
async function globalsOf(tx: DbExecutor, tenantId: string, connectionId: string, backupId: string) {
  const [row] = await tx
    .select({ connection: databaseConnections, backup: databaseBackups })
    .from(databaseBackups)
    .innerJoin(databaseConnections, eq(databaseConnections.id, databaseBackups.connectionId))
    .where(
      and(
        eq(databaseBackups.tenantId, tenantId),
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.connectionId, connectionId),
        eq(databaseBackups.kind, "globals"),
      ),
    )
    .limit(1);
  if (row?.backup.status !== "active") {
    throw notFound("Backup");
  }
  return row;
}

/** The active globals backups of a connection, newest first (administrators). */
export async function listGlobals(
  db: DbExecutor,
  tenantId: string,
  connectionId: string,
): Promise<{ backups: DatabaseBackupDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(databaseBackups)
      .where(
        and(
          eq(databaseBackups.tenantId, tenantId),
          eq(databaseBackups.connectionId, connectionId),
          eq(databaseBackups.kind, "globals"),
          eq(databaseBackups.status, "active"),
        ),
      )
      .orderBy(desc(databaseBackups.finishedAt))
      .limit(100);
    return { backups: rows.map(backupDto) };
  });
}

/** The repository of a connection, read by the API (downloads) or initialized for an agent. */
async function repositoryAccess(
  db: DbExecutor,
  connection: DatabaseConnection,
  init: boolean,
): Promise<RepositoryAccess> {
  const { storage } = await tenantStorage(db, connection.tenantId);
  const prefix = databaseRepositoryPrefix(connection.id);
  let secretId = connection.repositorySecretId;
  if (!secretId) {
    if (!init) {
      throw notFound("Repository");
    }
    if (await storage.head(`${prefix}config`).catch(() => null)) {
      throw new ProblemError(409, "Repository without password", {
        detail:
          "The storage holds a repository of this connection that Restow has no password for.",
      });
    }
    const created = await storeSecret(db, {
      tenantId: connection.tenantId,
      kind: DB_REPOSITORY_SECRET_KIND,
      plaintext: randomBytes(32).toString("base64url"),
    });
    secretId = await withTenantTx(db, connection.tenantId, async (tx) => {
      const [locked] = await tx
        .select({ secretId: databaseConnections.repositorySecretId })
        .from(databaseConnections)
        .where(eq(databaseConnections.id, connection.id))
        .for("update");
      if (locked?.secretId) {
        return locked.secretId;
      }
      await tx
        .update(databaseConnections)
        .set({ repositorySecretId: created.id })
        .where(eq(databaseConnections.id, connection.id));
      return created.id;
    });
  }
  const password = await readSecret(db, { id: secretId, tenantId: connection.tenantId });
  if (!password) {
    throw notFound("Repository");
  }
  const access: RepositoryAccess = {
    storage,
    prefix,
    repositoryPassword: password,
    repositoryKey: `db-${connection.id}`,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
  if (init && !connection.repositoryInitializedAt) {
    if (!(await storage.head(`${prefix}config`).catch(() => null))) {
      await withRepository(access, (session) => resticInit(session));
    }
    await withTenantTx(db, connection.tenantId, (tx) =>
      tx
        .update(databaseConnections)
        .set({ repositoryInitializedAt: new Date() })
        .where(eq(databaseConnections.id, connection.id)),
    );
  }
  return access;
}

/** Downloads at once: in all and per tenant (each holds a restic process and a stream). */
export const DB_DOWNLOAD_LIMITS = { global: 4, perTenant: 2 } as const;
const downloadsRunning = { global: 0, tenants: new Map<string, number>() };

/** Take a download slot or refuse with 429; the returned function gives it back (once). */
export function takeDownloadSlot(tenantId: string): () => void {
  const tenant = downloadsRunning.tenants.get(tenantId) ?? 0;
  if (
    downloadsRunning.global >= DB_DOWNLOAD_LIMITS.global ||
    tenant >= DB_DOWNLOAD_LIMITS.perTenant
  ) {
    throw new ProblemError(429, "Too many downloads", {
      type: "urn:restow:problem:rate-limited",
      detail: "Other downloads of backups are running; try again when one of them ended.",
      extensions: { retryAfterSeconds: 30 },
    });
  }
  downloadsRunning.global++;
  downloadsRunning.tenants.set(tenantId, tenant + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    downloadsRunning.global--;
    const left = (downloadsRunning.tenants.get(tenantId) ?? 1) - 1;
    if (left > 0) {
      downloadsRunning.tenants.set(tenantId, left);
    } else {
      downloadsRunning.tenants.delete(tenantId);
    }
  };
}

export interface BackupDownload {
  stream: Readable;
  fileName: string;
  done: Promise<void>;
}

async function streamDump(
  db: DbExecutor,
  tenantId: string,
  connection: DatabaseConnection,
  backup: DatabaseBackup,
  audited: { action: string; actor: DatabaseContext["actor"]; details: Record<string, unknown> },
): Promise<BackupDownload> {
  const release = takeDownloadSlot(tenantId);
  try {
    const access = await repositoryAccess(db, connection, false);
    const open = await openRepository(access);
    const dump = resticDump(open.session, backup.snapshotId, `/${backup.fileName}`);
    const done = dump.done.finally(() => {
      open.close();
      release();
    });
    done.catch(() => undefined);
    await audit(db, {
      tenantId,
      actor: audited.actor.label,
      actorUserId: audited.actor.userId,
      ip: audited.actor.ip,
      action: audited.action,
      target: connection.id,
      targetType: "database_connection",
      details: audited.details,
    });
    // No length: the size an executor reported is not one the server checked.
    return { stream: dump.stream, fileName: downloadFileNameOf(backup.fileName), done };
  } catch (error) {
    release();
    throw error;
  }
}

/** "Herunterladen": the dump file of a database, streamed from the repository (audited). */
export async function downloadBackup(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
  backupId: string,
  ctx: DatabaseContext,
): Promise<BackupDownload> {
  const { connection, backup } = await withTenantTx(db, tenantId, (tx) =>
    backupOf(tx, tenantId, databaseId, backupId),
  );
  return streamDump(db, tenantId, connection, backup, {
    action: DB_RUN_AUDIT.downloaded,
    actor: ctx.actor,
    details: { databaseId, backupId: backup.id, kind: backup.kind },
  });
}

/**
 * The globals of a connection (roles with their password hashes where the user could read them,
 * tablespaces): administrators only, audited with an action of their own (16, "D3").
 */
export async function downloadGlobals(
  db: DbExecutor,
  tenantId: string,
  connectionId: string,
  backupId: string,
  ctx: DatabaseContext,
): Promise<BackupDownload> {
  const { connection, backup } = await withTenantTx(db, tenantId, (tx) =>
    globalsOf(tx, tenantId, connectionId, backupId),
  );
  return streamDump(db, tenantId, connection, backup, {
    action: DB_RUN_AUDIT.globalsDownloaded,
    actor: ctx.actor,
    details: { backupId: backup.id, kind: backup.kind },
  });
}

/** A word for a shell, in single quotes: safe whatever it holds. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The restore guide (7.1): `pg_restore` commands as text, without a secret. */
export async function restoreGuide(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
  backupId: string,
): Promise<string> {
  const { database, connection, backup } = await withTenantTx(db, tenantId, (tx) =>
    backupOf(tx, tenantId, databaseId, backupId),
  );
  // The same name as the download, quoted for the shell all the same.
  const file = shellQuote(downloadFileNameOf(backup.fileName));
  const target = shellQuote(defaultRestoreName(database.name, backup.finishedAt));
  const oneLine = (value: string) => JSON.stringify(value);
  return [
    `Restore guide for the database ${oneLine(database.name)} of the connection ${oneLine(connection.name)}`,
    `Backup of ${backup.finishedAt.toISOString()} (PostgreSQL ${oneLine(backup.serverVersion ?? "?")}, pg_dump ${oneLine(backup.toolVersion ?? "?")})`,
    `File: ${file} (custom format), SHA-256 ${backup.sha256}`,
    "",
    "1. Check the file:",
    `     sha256sum ${file}`,
    "",
    "2. Create a new, empty database (never restore over an existing one):",
    `     createdb --template=template0 ${target}`,
    "",
    "3. Restore into it, stopping at the first error:",
    `     pg_restore --exit-on-error --no-owner --no-privileges --dbname=${target} ${file}`,
    "",
    "   Use pg_restore of the server's major version or newer. Connect as a user with CREATEDB;",
    "   the password goes into ~/.pgpass or PGPASSWORD, never onto the command line.",
    "",
    "4. Owners and privileges: Restow restores without them (--no-owner --no-privileges). The",
    "   roles of the instance are in the globals backup of the same run (globals.sql), which an",
    "   administrator downloads on the database page:",
    "     psql --dbname=postgres --file=globals.sql   # review it first: it creates roles",
    "   then restore again without --no-owner --no-privileges, or grant by hand.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Agent API
// ---------------------------------------------------------------------------

export interface AgentRunSpec {
  runId: string;
  kind: "backup" | "restore";
  /** The connection the agent signs in to (the target's for a restore). */
  connection: {
    connectionId: string;
    engine: string;
    host: string | null;
    port: number | null;
    loginDatabase: string | null;
    authMethod: string;
    user: string | null;
    password: string | null;
    allowUnencrypted: boolean;
    pinnedFingerprintSha256: string | null;
    instanceKey: string | null;
    selection: { mode: "all" | "selected"; names: string[]; exclude: string[] };
  };
  /**
   * restic access of a backup: the connection's repository through the run's own REST credential
   * (append only). A restore gets none: it reads the one dump from the server
   * (`GET /agent/v1/databases/runs/:runId/dump`), never the repository.
   */
  repository: {
    url: string;
    username: string;
    password: string;
    repositoryPassword: string;
  } | null;
  restore: { fileName: string; sha256: string; targetName: string } | null;
  maxDurationSeconds: number;
}

function runNotFound(): ProblemError {
  return new ProblemError(404, "Database run not found");
}

async function credentialsOf(db: DbExecutor, connection: DatabaseConnection) {
  if (connection.authMethod !== "password" || !connection.credentialSecretId) {
    return { user: null, password: null };
  }
  const plaintext = await readSecret(db, {
    id: connection.credentialSecretId,
    tenantId: connection.tenantId,
  });
  if (!plaintext) {
    return { user: null, password: null };
  }
  const parsed = JSON.parse(plaintext) as { user?: string | null; password?: string | null };
  return { user: parsed.user ?? null, password: parsed.password ?? null };
}

/** Whether `agent` still executes `connection`, and the connection is on. */
function executedBy(connection: DatabaseConnection, agent: { endpointId: string }): boolean {
  return (
    connection.enabled &&
    connection.executorKind === "agent" &&
    connection.executorEndpointId === agent.endpointId
  );
}

/**
 * The run of an agent, with its credentials, once (4.3): a second fetch is refused. Only the
 * agent the run was given to, only while it waits, and only while that agent still executes the
 * connection it signs in to (a move to another executor fails the queued run instead); the token
 * for the repository is made now (backups only) and only its hash is kept.
 */
export async function agentFetchRun(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  runId: string,
  instanceUrl: string,
): Promise<AgentRunSpec> {
  await assertNoRestoreMode();
  const token = randomBytes(32).toString("base64url");
  const claimed = await withTenantTx(db, agent.tenantId, async (tx) => {
    const [queued] = await tx
      .select()
      .from(databaseRuns)
      .where(
        and(
          eq(databaseRuns.tenantId, agent.tenantId),
          eq(databaseRuns.id, runId),
          eq(databaseRuns.executorKind, "agent"),
          eq(databaseRuns.executorEndpointId, agent.endpointId),
          eq(databaseRuns.status, "queued"),
        ),
      )
      .for("update")
      .limit(1);
    if (!queued) {
      return null;
    }
    const [executed] = await tx
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, queued.targetConnectionId ?? queued.connectionId))
      .limit(1);
    if (!executed || !executedBy(executed, agent)) {
      await tx
        .update(databaseRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorCode: "db_run_failed",
          errorMessage: "The connection is no longer run by this agent, or it is switched off.",
        })
        .where(eq(databaseRuns.id, queued.id));
      return "moved" as const;
    }
    const [run] = await tx
      .update(databaseRuns)
      .set({
        fetchedAt: new Date(),
        status: "running",
        startedAt: new Date(),
        tokenHash: queued.kind === "backup" ? hashSecret(token) : null,
      })
      .where(and(eq(databaseRuns.id, queued.id), eq(databaseRuns.status, "queued")))
      .returning();
    if (!run) {
      return null;
    }
    const [source] = await tx
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, run.connectionId))
      .limit(1);
    const [target] = run.targetConnectionId
      ? await tx
          .select()
          .from(databaseConnections)
          .where(eq(databaseConnections.id, run.targetConnectionId))
          .limit(1)
      : [source];
    const [backup] = run.sourceBackupId
      ? await tx
          .select()
          .from(databaseBackups)
          .where(eq(databaseBackups.id, run.sourceBackupId))
          .limit(1)
      : [];
    return source && target ? { run, source, target, backup: backup ?? null } : null;
  });
  if (!claimed || claimed === "moved") {
    throw runNotFound();
  }
  const { run, source, target, backup } = claimed;
  if (
    run.kind === "restore" &&
    (backup?.status !== "active" || backup.kind !== "database" || backup.connectionId !== source.id)
  ) {
    await finishAgentRun(db, run, "failed", "db_restore_failed", "The backup is not available.");
    throw runNotFound();
  }
  const access = run.kind === "backup" ? await repositoryAccess(db, source, true) : null;
  const credentials = await credentialsOf(db, target);
  return {
    runId: run.id,
    kind: run.kind,
    connection: {
      connectionId: target.id,
      engine: target.engine,
      host: target.host,
      port: target.port,
      loginDatabase: target.loginDatabase,
      authMethod: target.authMethod,
      user: credentials.user,
      password: credentials.password,
      allowUnencrypted: target.allowUnencrypted,
      pinnedFingerprintSha256: target.tlsFingerprint,
      instanceKey: target.instanceKey,
      selection: target.selection,
    },
    repository: access
      ? {
          url: `rest:${instanceUrl.replace(/\/+$/, "")}/agent/db/restic/${source.id}/`,
          username: run.id,
          password: token,
          repositoryPassword: access.repositoryPassword,
        }
      : null,
    restore:
      run.kind === "restore" && backup
        ? {
            fileName: backup.fileName,
            sha256: backup.sha256,
            targetName: run.targetName ?? "",
          }
        : null,
    maxDurationSeconds: 12 * 60 * 60,
  };
}

async function finishAgentRun(
  db: DbExecutor,
  run: DatabaseRun,
  status: "succeeded" | "partial" | "failed",
  errorCode: string | null,
  errorMessage: string | null,
  extra: { notes?: Record<string, unknown>[]; targetOid?: string | null } = {},
): Promise<void> {
  await withTenantTx(db, run.tenantId, (tx) =>
    tx
      .update(databaseRuns)
      .set({
        status,
        finishedAt: new Date(),
        errorCode,
        errorMessage: errorMessage?.slice(0, 1000) ?? null,
        ...(extra.notes ? { notes: extra.notes } : {}),
        ...(extra.targetOid !== undefined ? { targetOid: extra.targetOid } : {}),
      })
      .where(and(eq(databaseRuns.id, run.id), eq(databaseRuns.status, "running"))),
  );
}

const codeSchema = z.enum(DB_ERROR_CODES).catch("db_probe_failed");
const backupReportSchema = z.object({
  kind: z.enum(["database", "globals"]),
  name: z.string().max(128),
  oid: z
    .string()
    .regex(/^\d{1,10}$/)
    .nullable(),
  /** The full id: restic would read a prefix as any snapshot that starts with it. */
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().min(1).max(300),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  objects: z.record(z.string().max(64), z.number().int().min(0)).catch({}),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  toolVersion: z.string().max(64).nullable(),
});

export const agentRunFinishSchema = z.object({
  status: z.enum(["succeeded", "partial", "failed"]),
  error: z.object({ code: codeSchema, message: z.string().max(2000).catch("") }).nullable(),
  instance: z
    .object({
      systemIdentifier: z.string().regex(/^\d{1,20}$/),
      serverVersion: z.string().max(256),
      databases: z
        .array(z.object({ name: z.string().max(128), oid: z.string().regex(/^\d{1,10}$/) }))
        .max(1000),
    })
    .nullable(),
  backups: z
    .array(backupReportSchema)
    .max(1001)
    .refine(
      (backups) =>
        new Set(backups.map((b) => `${b.kind}:${b.kind === "globals" ? "" : b.name}`)).size ===
          backups.length && new Set(backups.map((b) => b.snapshotId)).size === backups.length,
      "one backup per database and one of the globals per run, each its own snapshot",
    ),
  notes: z
    .array(z.record(z.string().max(64), z.unknown()))
    .max(1100)
    .catch([]),
  targetOid: z
    .string()
    .regex(/^\d{1,10}$/)
    .nullable()
    .catch(null),
});
export type AgentRunFinish = z.infer<typeof agentRunFinishSchema>;

/**
 * What the agent's run found and wrote. The server judges: another instance than the confirmed
 * one, or Restow's own, records nothing of it; backups are recorded with the databases they
 * belong to. Messages are cleaned of the credentials once more.
 */
export async function agentFinishRun(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  runId: string,
  raw: unknown,
): Promise<void> {
  const [run] = await withTenantTx(db, agent.tenantId, (tx) =>
    tx
      .select()
      .from(databaseRuns)
      .where(
        and(
          eq(databaseRuns.tenantId, agent.tenantId),
          eq(databaseRuns.id, runId),
          eq(databaseRuns.executorEndpointId, agent.endpointId),
          eq(databaseRuns.status, "running"),
        ),
      )
      .limit(1),
  );
  if (!run) {
    throw runNotFound();
  }
  const parsed = agentRunFinishSchema.safeParse(raw);
  const [connection] = await withTenantTx(db, agent.tenantId, (tx) =>
    tx
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, run.targetConnectionId ?? run.connectionId))
      .limit(1),
  );
  if (!parsed.success || !connection) {
    await finishAgentRun(
      db,
      run,
      "failed",
      "db_probe_failed",
      "The agent's report was not understood.",
    );
    return;
  }
  const report = parsed.data;
  const credentials = await credentialsOf(db, connection);
  const clean = (message: string | null | undefined) =>
    message ? sanitizeDbMessage(message, credentials) : null;
  const notes = report.notes.map((note) =>
    typeof note.message === "string" ? { ...note, message: clean(note.message) } : note,
  );
  if (report.instance) {
    const instanceKey = `postgresql:${report.instance.systemIdentifier}`;
    const own = await restowSystemIdentifier();
    if (own !== null && report.instance.systemIdentifier === own) {
      await finishAgentRun(
        db,
        run,
        "failed",
        "db_target_is_restow",
        "This is the database of this Restow installation.",
      );
      return;
    }
    if (connection.instanceKey && connection.instanceKey !== instanceKey) {
      await finishAgentRun(
        db,
        run,
        "failed",
        "db_instance_changed",
        "Another instance answers under the address.",
      );
      return;
    }
    if (run.kind === "backup") {
      const instance = report.instance;
      const verified = await verifyAgentBackups(
        db,
        run,
        connection,
        { ...report, instance },
        notes,
      );
      await withTenantTx(db, agent.tenantId, async (tx) => {
        const ids = await recordInstanceDatabasesTx(
          tx,
          connection,
          instanceKey,
          instance.databases,
          new Date(),
        );
        for (const { backup, startedAt, finishedAt } of verified.backups) {
          await tx
            .insert(databaseBackups)
            .values({
              tenantId: run.tenantId,
              connectionId: run.connectionId,
              runId: run.id,
              databaseId: backup.kind === "database" ? (ids.get(backup.name) ?? null) : null,
              kind: backup.kind,
              databaseName: backup.kind === "database" ? backup.name : "",
              identity: backup.oid,
              instanceKey,
              snapshotId: backup.snapshotId,
              fileName: backup.fileName,
              sha256: backup.sha256,
              bytes: backup.bytes,
              objects: backup.objects,
              toolVersion: backup.toolVersion,
              serverVersion: instance.serverVersion.slice(0, 256),
              startedAt,
              finishedAt,
            })
            .onConflictDoNothing();
        }
      });
      if (verified.refused > 0) {
        const status = verified.backups.length > 0 ? "partial" : "failed";
        await finishAgentRun(
          db,
          run,
          status,
          "db_snapshot_failed",
          `${verified.refused} of ${report.backups.length} reported backups were not found in the repository as this run's.`,
          { notes },
        );
        return;
      }
    }
  } else if (run.kind === "backup" && report.backups.length > 0) {
    // Backups without the instance they came from are not recorded.
    await finishAgentRun(
      db,
      run,
      "failed",
      "db_probe_failed",
      "The agent's report names backups but no instance.",
      { notes },
    );
    return;
  }
  await finishAgentRun(
    db,
    run,
    report.status,
    report.error?.code ?? null,
    clean(report.error?.message),
    { notes, ...(run.kind === "restore" ? { targetOid: report.targetOid } : {}) },
  );
}

/** How far a snapshot's time may lie before the run's start (the agent's clock). */
const SNAPSHOT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function clampDate(value: Date, min: Date, max: Date): Date {
  const time = Number.isNaN(value.getTime()) ? max.getTime() : value.getTime();
  return new Date(Math.min(Math.max(time, min.getTime()), max.getTime()));
}

/**
 * The backups an agent reported, checked against the repository before anything is recorded
 * (16, "D3"): the snapshot must exist under its full id, written by a run of Restow
 * (`restow-db`) for this connection and this run (tags), for the file the report names, at a time
 * within the run. A backup of a database the instance did not list is refused. The times recorded
 * are the server's: the snapshot's own clamped to the run's start and now.
 */
async function verifyAgentBackups(
  db: DbExecutor,
  run: DatabaseRun,
  connection: DatabaseConnection,
  report: AgentRunFinish & { instance: NonNullable<AgentRunFinish["instance"]> },
  notes: Record<string, unknown>[],
): Promise<{
  backups: { backup: AgentRunFinish["backups"][number]; startedAt: Date; finishedAt: Date }[];
  refused: number;
}> {
  if (report.backups.length === 0) {
    return { backups: [], refused: 0 };
  }
  const now = new Date();
  const runStart = run.startedAt ?? run.createdAt;
  let snapshots: Awaited<ReturnType<typeof resticSnapshots>>;
  try {
    const access = await repositoryAccess(db, connection, false);
    snapshots = await withRepository(access, (session) =>
      resticSnapshots(session, { noLock: true }),
    );
  } catch {
    notes.push({ result: "unverified", code: "db_snapshot_failed" });
    return { backups: [], refused: report.backups.length };
  }
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const listed = new Set(report.instance.databases.map((database) => database.name));
  const backups: {
    backup: AgentRunFinish["backups"][number];
    startedAt: Date;
    finishedAt: Date;
  }[] = [];
  let refused = 0;
  for (const backup of report.backups) {
    const snapshot = byId.get(backup.snapshotId);
    const time = snapshot ? new Date(snapshot.time) : null;
    const globals = backup.kind === "globals";
    const ok =
      snapshot !== undefined &&
      time !== null &&
      !Number.isNaN(time.getTime()) &&
      snapshot.hostname === "restow-db" &&
      snapshot.tags.includes(`restow-db-connection=${connection.id}`) &&
      snapshot.tags.includes(`restow-db-run=${run.id}`) &&
      snapshot.tags.includes("restow-db-globals") === globals &&
      backup.fileName === dumpFileNameOf(backup.kind, backup.name) &&
      snapshot.paths.length === 1 &&
      snapshot.paths[0] === `/${backup.fileName}` &&
      (globals || listed.has(backup.name)) &&
      time.getTime() >= runStart.getTime() - SNAPSHOT_CLOCK_SKEW_MS &&
      time.getTime() <= now.getTime() + SNAPSHOT_CLOCK_SKEW_MS;
    if (!ok || time === null) {
      refused++;
      notes.push({
        ...(globals ? { globals: true } : { database: backup.name.slice(0, 128) }),
        result: "unverified",
        code: "db_snapshot_failed",
      });
      continue;
    }
    const finishedAt = clampDate(time, runStart, now);
    const startedAt = clampDate(new Date(backup.startedAt), runStart, finishedAt);
    backups.push({ backup, startedAt, finishedAt });
  }
  return { backups, refused };
}

/**
 * The dump a restore run plays back (`GET /agent/v1/databases/runs/:runId/dump`): the server reads
 * the one file from the source's repository and streams it, so the agent of the target never gets
 * the source repository's password. Only the run's agent, only while the run is running.
 */
export async function agentRunDump(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  runId: string,
): Promise<BackupDownload> {
  const found = await withTenantTx(db, agent.tenantId, async (tx) => {
    const [run] = await tx
      .select()
      .from(databaseRuns)
      .where(
        and(
          eq(databaseRuns.tenantId, agent.tenantId),
          eq(databaseRuns.id, runId),
          eq(databaseRuns.kind, "restore"),
          eq(databaseRuns.executorKind, "agent"),
          eq(databaseRuns.executorEndpointId, agent.endpointId),
          eq(databaseRuns.status, "running"),
        ),
      )
      .limit(1);
    if (!run?.sourceBackupId) {
      return null;
    }
    const [row] = await tx
      .select({ connection: databaseConnections, backup: databaseBackups })
      .from(databaseBackups)
      .innerJoin(databaseConnections, eq(databaseConnections.id, databaseBackups.connectionId))
      .where(
        and(
          eq(databaseBackups.id, run.sourceBackupId),
          eq(databaseBackups.connectionId, run.connectionId),
          eq(databaseBackups.kind, "database"),
          eq(databaseBackups.status, "active"),
        ),
      )
      .limit(1);
    return row ? { run, ...row } : null;
  });
  if (!found) {
    throw runNotFound();
  }
  // Counts against the downloads at once like a user's (429: the agent tries again).
  const release = takeDownloadSlot(agent.tenantId);
  try {
    const access = await repositoryAccess(db, found.connection, false);
    const open = await openRepository(access);
    const dump = resticDump(open.session, found.backup.snapshotId, `/${found.backup.fileName}`);
    const done = dump.done.finally(() => {
      open.close();
      release();
    });
    done.catch(() => undefined);
    return { stream: dump.stream, fileName: downloadFileNameOf(found.backup.fileName), done };
  } catch (error) {
    release();
    throw error;
  }
}

/** The run credential of `/agent/db/restic/:connectionId` (append-only backup, read-only restore). */
export async function resolveDatabaseRunCredential(
  credentials: { runId: string; token: string },
  connectionId: string,
): Promise<RunResticResolution> {
  const [run] = await providerDb
    .select({
      id: databaseRuns.id,
      tenantId: databaseRuns.tenantId,
      connectionId: databaseRuns.connectionId,
      kind: databaseRuns.kind,
      status: databaseRuns.status,
      tokenHash: databaseRuns.tokenHash,
      tenantStatus: tenants.status,
    })
    .from(databaseRuns)
    .innerJoin(tenants, eq(tenants.id, databaseRuns.tenantId))
    .where(eq(databaseRuns.id, credentials.runId))
    .limit(1);
  if (
    !run?.tokenHash ||
    run.kind !== "backup" ||
    !secretMatchesHash(credentials.token, run.tokenHash) ||
    run.connectionId !== connectionId
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (run.tenantStatus !== "active") {
    return { ok: false, reason: "expired" };
  }
  const { storage } = await tenantStorage(appDb, run.tenantId);
  return {
    ok: true,
    access: {
      tenantId: run.tenantId,
      runId: run.id,
      runKind: run.kind,
      principal: run.status !== "running" ? "closing" : "agent",
      prefix: databaseRepositoryPrefix(connectionId),
      storage,
    },
  };
}
