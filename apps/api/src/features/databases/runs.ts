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
import { restowSystemIdentifier } from "./service.js";

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
} as const;

export const DB_RUN_AUDIT = {
  backupRequested: "database_connection.backup_requested",
  restoreRequested: "database_connection.restore_requested",
  downloaded: "database_connection.backup_downloaded",
} as const;

/** A new database's name: at most 63 bytes (O3). */
export const DB_NAME_MAX_BYTES = 63;

export function validRestoreName(name: string): boolean {
  return (
    name.trim() === name &&
    name.length > 0 &&
    Buffer.byteLength(name, "utf8") <= DB_NAME_MAX_BYTES &&
    !name.includes("\0")
  );
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
    const name = input.name ?? defaultRestoreName(database.name, now);
    if (!validRestoreName(name)) {
      throw new ProblemError(422, "Invalid database name", {
        type: RUN_PROBLEMS.restoreName,
        detail: `The new database's name has at most ${DB_NAME_MAX_BYTES} bytes.`,
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

async function backupOf(tx: DbExecutor, tenantId: string, databaseId: string, backupId: string) {
  const { database, connection } = await databaseAndConnection(tx, tenantId, databaseId);
  const [backup] = await tx
    .select()
    .from(databaseBackups)
    .where(
      and(
        eq(databaseBackups.id, backupId),
        eq(databaseBackups.connectionId, connection.id),
        inArray(databaseBackups.kind, ["database", "globals"]),
      ),
    )
    .limit(1);
  if (backup?.status !== "active") {
    throw notFound("Backup");
  }
  if (backup.kind === "database" && backup.databaseId !== database.id) {
    throw notFound("Backup");
  }
  return { database, connection, backup };
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

/** "Herunterladen": the dump file, streamed from the repository (audited). */
export async function downloadBackup(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
  backupId: string,
  ctx: DatabaseContext,
): Promise<{ stream: Readable; fileName: string; bytes: number; done: Promise<void> }> {
  const { connection, backup } = await withTenantTx(db, tenantId, (tx) =>
    backupOf(tx, tenantId, databaseId, backupId),
  );
  const access = await repositoryAccess(db, connection, false);
  const open = await openRepository(access);
  const dump = resticDump(open.session, backup.snapshotId, `/${backup.fileName}`);
  const done = dump.done.finally(() => open.close());
  done.catch(() => undefined);
  await audit(db, {
    tenantId,
    actor: ctx.actor.label,
    actorUserId: ctx.actor.userId,
    ip: ctx.actor.ip,
    action: DB_RUN_AUDIT.downloaded,
    target: connection.id,
    targetType: "database_connection",
    details: { databaseId, backupId: backup.id, kind: backup.kind },
  });
  return {
    stream: dump.stream,
    fileName: backup.fileName.split("/").pop() ?? "backup",
    bytes: backup.bytes,
    done,
  };
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
  const file = backup.fileName.split("/").pop() ?? "backup.pgdump";
  const target = defaultRestoreName(database.name, backup.finishedAt);
  return [
    `Restore guide for the database "${database.name}" of the connection "${connection.name}"`,
    `Backup of ${backup.finishedAt.toISOString()} (PostgreSQL ${backup.serverVersion ?? "?"}, pg_dump ${backup.toolVersion ?? "?"})`,
    `File: ${file} (custom format), ${backup.bytes} bytes, SHA-256 ${backup.sha256}`,
    "",
    "1. Check the file:",
    `     sha256sum ${file}`,
    "",
    "2. Create a new, empty database (never restore over an existing one):",
    `     createdb --template=template0 '${target.replace(/'/g, "'\\''")}'`,
    "",
    "3. Restore into it, stopping at the first error:",
    `     pg_restore --exit-on-error --no-owner --no-privileges --dbname='${target.replace(/'/g, "'\\''")}' ${file}`,
    "",
    "   Use pg_restore of the server's major version or newer. Connect as a user with CREATEDB;",
    "   the password goes into ~/.pgpass or PGPASSWORD, never onto the command line.",
    "",
    "4. Owners and privileges: Restow restores without them (--no-owner --no-privileges). The",
    "   roles of the instance are in the globals backup of the same run (globals.sql):",
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
  /** restic access: the connection's repository through the run's own REST credential. */
  repository: { url: string; username: string; password: string; repositoryPassword: string };
  restore: { snapshotId: string; fileName: string; sha256: string; targetName: string } | null;
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

/**
 * The run of an agent, with its credentials, once (4.3): a second fetch is refused. Only the
 * agent the run was given to, only while it waits; the token for the repository is made now and
 * only its hash is kept.
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
    const [run] = await tx
      .update(databaseRuns)
      .set({
        fetchedAt: new Date(),
        status: "running",
        startedAt: new Date(),
        tokenHash: hashSecret(token),
      })
      .where(
        and(
          eq(databaseRuns.tenantId, agent.tenantId),
          eq(databaseRuns.id, runId),
          eq(databaseRuns.executorKind, "agent"),
          eq(databaseRuns.executorEndpointId, agent.endpointId),
          eq(databaseRuns.status, "queued"),
        ),
      )
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
  if (!claimed) {
    throw runNotFound();
  }
  const { run, source, target, backup } = claimed;
  if (run.kind === "restore" && backup?.status !== "active") {
    await finishAgentRun(db, run, "failed", "db_restore_failed", "The backup is not available.");
    throw runNotFound();
  }
  const access = await repositoryAccess(db, source, run.kind === "backup");
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
    repository: {
      url: `rest:${instanceUrl.replace(/\/+$/, "")}/agent/db/restic/${source.id}/`,
      username: run.id,
      password: token,
      repositoryPassword: access.repositoryPassword,
    },
    restore:
      run.kind === "restore" && backup
        ? {
            snapshotId: backup.snapshotId,
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
      .where(eq(databaseRuns.id, run.id)),
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
  snapshotId: z.string().regex(/^[0-9a-f]{8,64}$/),
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
  backups: z.array(backupReportSchema).max(1001),
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
      await withTenantTx(db, agent.tenantId, async (tx) => {
        const ids = await recordInstanceDatabasesTx(
          tx,
          connection,
          instanceKey,
          report.instance?.databases ?? [],
          new Date(),
        );
        for (const backup of report.backups) {
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
              serverVersion: report.instance?.serverVersion.slice(0, 256) ?? null,
              startedAt: new Date(backup.startedAt),
              finishedAt: new Date(backup.finishedAt),
            })
            .onConflictDoNothing();
        }
      });
    }
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
      principal: run.status !== "running" ? "closing" : run.kind === "backup" ? "agent" : "reader",
      prefix: databaseRepositoryPrefix(connectionId),
      storage,
    },
  };
}
