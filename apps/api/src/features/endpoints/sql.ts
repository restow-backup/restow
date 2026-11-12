import {
  endpointPrefix,
  hasSqlCapability,
  rateSqlDatabase,
  renderSqlRestoreScript,
  SQL_AGENT_LOGIN,
  SQL_VERIFY_TASK_TTL_MS,
  type SqlDatabaseRating,
  type SqlSettings,
  type SqlVerifyCandidate,
  type SqlVerifyTaskParams,
  safeFilePart,
  sqlDatabaseSelected,
  sqlLoginScript,
  sqlVerifyOf,
  sqlVerifyTaskParams,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  type EndpointSqlBackupFile,
  type EndpointSqlInstanceState,
  type EndpointSqlRestoreParams,
  type EndpointWindowsSqlInstance,
  endpointReports,
  endpointSqlBackups,
  endpointSqlDatabases,
  endpoints,
  endpointTasks,
} from "@restow/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * The native SQL Server backup of a Windows machine on its page (W2a, docs/BAREMETAL-WINDOWS.md
 * 5.1): the instances and their sign-in, the databases with their rating, their backups, a
 * restore under a new name, a check now, a fresh inventory ("Check sign-in"), the restore script
 * for another machine and the confirmation that a TDE certificate is backed up elsewhere.
 *
 * Every action refuses with 409 when the machine is revoked or its agent does not name the
 * capability `sql_native_v1` (an older agent would ignore the task or fail it). No SQL credential
 * is stored anywhere: the agent signs in with its service SID (integrated authentication).
 */

/** A `sql_restore` task nobody picked up is stale after a week (like a file restore). */
const SQL_RESTORE_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SqlInstanceDto {
  name: string;
  /** From the registry (heartbeat, W1); null when only the inventory names it. */
  facts: EndpointWindowsSqlInstance | null;
  /** From the last SQL inventory; null before the first one. */
  inventory: EndpointSqlInstanceState | null;
  /**
   * `ok`: signed in with the rights the backup needs; `missing`: no login for the agent
   * (18456); `permission`: signed in without the rights; `error`: another problem (the code
   * says which); `unknown`: no inventory yet.
   */
  signIn: "ok" | "missing" | "permission" | "error" | "unknown";
  /** The T-SQL a DBA runs once (5.1.2): the simple variant and the small one. */
  loginScripts: { sysadmin: string; minimal: string };
}

export interface SqlBackupDto {
  id: string;
  kind: "full" | "log" | "tail";
  copyOnly: boolean;
  snapshotId: string;
  backupStart: string;
  backupFinish: string;
  bytes: number;
  firstLsn: string;
  lastLsn: string;
  compressed: boolean;
  checksum: boolean;
  status: "active" | "pruned";
}

export interface SqlVerificationDto {
  outcome: "green" | "red" | "incomplete";
  checkedAt: string;
  code: string | null;
  physicalOnly: boolean;
  backupId: string | null;
  evidence: { source: string; number?: number; message: string }[];
}

export interface SqlDatabaseDto {
  id: string;
  instance: string;
  name: string;
  recoveryModel: string;
  mode: string;
  system: boolean;
  state: string | null;
  encrypted: boolean;
  tdeConfirmedAt: string | null;
  sizeBytes: number | null;
  usedBytes: number | null;
  /** Gone from the last complete inventory of its instance. */
  droppedAt: string | null;
  /** The job's SQL settings take it. */
  selected: boolean;
  rating: SqlDatabaseRating;
  lastBackup: SqlBackupDto | null;
  /** The newest check, whatever its outcome. */
  lastVerification: SqlVerificationDto | null;
  /** The newest backup by another tool, as the instance's history names it (display only). */
  lastForeignFullAt: string | null;
}

export interface SqlOverviewDto {
  /** The agent names `sql_native_v1`. */
  capable: boolean;
  /** A backup job switched the native backup on for this machine. */
  enabled: boolean;
  settings: SqlSettings | null;
  verify: ReturnType<typeof sqlVerifyOf>;
  inventoryAt: string | null;
  inventoryTruncated: boolean;
  instances: SqlInstanceDto[];
  databases: SqlDatabaseDto[];
  /** Waiting or running SQL requests. */
  pending: { verify: number; restore: number; inventory: number };
  /** The account the agent signs in with. */
  account: string;
}

function notFound(): ProblemError {
  return new ProblemError(404, "Endpoint not found");
}

async function loadEndpoint(tx: Transaction, tenantId: string, id: string): Promise<Endpoint> {
  const [endpoint] = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, id), isNull(endpoints.removedAt)))
    .limit(1);
  if (!endpoint) {
    throw notFound();
  }
  return endpoint;
}

/** The machine takes SQL tasks: active, Windows, and an agent that names `sql_native_v1`. */
function assertSqlCapable(endpoint: Endpoint): void {
  if (endpoint.status !== "active") {
    throw new ProblemError(409, "Endpoint revoked", {
      type: ENDPOINT_PROBLEMS.revoked,
      detail: "A revoked endpoint takes no tasks.",
    });
  }
  if (endpoint.os !== "windows" || !hasSqlCapability(endpoint.settings.agent?.capabilities)) {
    throw new ProblemError(409, "Agent without SQL Server backup", {
      type: ENDPOINT_PROBLEMS.sqlUnsupported,
      detail:
        "The agent on this machine cannot back up SQL Server natively. Update it to 0.5.0 or later.",
    });
  }
}

function signInOf(inventory: EndpointSqlInstanceState | null): SqlInstanceDto["signIn"] {
  if (!inventory) {
    return "unknown";
  }
  if (inventory.state === "ok") {
    return inventory.login?.sysadmin || inventory.login?.canCreateDatabase ? "ok" : "permission";
  }
  switch (inventory.error?.code) {
    case "sql_login_missing":
      return "missing";
    case "sql_permission_missing":
      return "permission";
    default:
      return "error";
  }
}

function toBackup(row: typeof endpointSqlBackups.$inferSelect): SqlBackupDto {
  return {
    id: row.id,
    kind: row.kind,
    copyOnly: row.copyOnly,
    snapshotId: row.resticSnapshotId,
    backupStart: row.backupStart.toISOString(),
    backupFinish: row.backupFinish.toISOString(),
    bytes: row.bytes,
    firstLsn: row.firstLsn,
    lastLsn: row.lastLsn,
    compressed: row.compressed,
    checksum: row.checksum,
    status: row.status,
  };
}

async function sqlDatabasesOf(tx: Transaction, tenantId: string, endpointId: string) {
  return tx
    .select()
    .from(endpointSqlDatabases)
    .where(
      and(
        eq(endpointSqlDatabases.tenantId, tenantId),
        eq(endpointSqlDatabases.endpointId, endpointId),
      ),
    )
    .orderBy(endpointSqlDatabases.instance, endpointSqlDatabases.database);
}

/** The newest active full of each database. */
async function newestFulls(
  tx: Transaction,
  databaseIds: readonly string[],
): Promise<Map<string, typeof endpointSqlBackups.$inferSelect>> {
  if (databaseIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .selectDistinctOn([endpointSqlBackups.databaseId])
    .from(endpointSqlBackups)
    .where(
      and(
        inArray(endpointSqlBackups.databaseId, [...databaseIds]),
        eq(endpointSqlBackups.status, "active"),
        eq(endpointSqlBackups.kind, "full"),
      ),
    )
    .orderBy(endpointSqlBackups.databaseId, desc(endpointSqlBackups.backupFinish));
  return new Map(rows.map((row) => [row.databaseId, row]));
}

export async function getSqlOverview(
  database: Database,
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<SqlOverviewDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    const settings = endpoint.config.sql ?? null;
    const rows = await sqlDatabasesOf(tx, tenantId, id);
    const fulls = await newestFulls(
      tx,
      rows.map((row) => row.id),
    );
    const checks = await tx
      .select({
        readiness: endpointReports.readiness,
        summary: endpointReports.summary,
        checkedAt: endpointReports.checkedAt,
      })
      .from(endpointReports)
      .where(
        and(
          eq(endpointReports.tenantId, tenantId),
          eq(endpointReports.endpointId, id),
          eq(endpointReports.kind, "sql_verify"),
        ),
      )
      .orderBy(desc(endpointReports.checkedAt))
      .limit(2000);
    const lastCheck = new Map<string, (typeof checks)[number]>();
    const lastResult = new Map<string, (typeof checks)[number]>();
    for (const check of checks) {
      const databaseId = check.summary.databaseId;
      if (typeof databaseId !== "string") {
        continue;
      }
      if (!lastCheck.has(databaseId)) {
        lastCheck.set(databaseId, check);
      }
      if (check.readiness !== null && !lastResult.has(databaseId)) {
        lastResult.set(databaseId, check);
      }
    }
    const windows = endpoint.settings.agent?.machine?.windows;
    const state = endpoint.settings.sqlInstances;
    const names = new Map<string, string>();
    for (const instance of windows?.sqlInstances ?? []) {
      names.set(instance.name.toUpperCase(), instance.name);
    }
    for (const instance of state?.instances ?? []) {
      names.set(
        instance.name.toUpperCase(),
        names.get(instance.name.toUpperCase()) ?? instance.name,
      );
    }
    const instances: SqlInstanceDto[] = [...names.values()].sort().map((name) => {
      const facts =
        windows?.sqlInstances.find((item) => item.name.toUpperCase() === name.toUpperCase()) ??
        null;
      const inventory =
        state?.instances.find((item) => item.name.toUpperCase() === name.toUpperCase()) ?? null;
      const userDatabases = rows
        .filter(
          (row) =>
            row.instance.toUpperCase() === name.toUpperCase() &&
            row.droppedAt === null &&
            row.facts.system !== true,
        )
        .map((row) => row.database);
      return {
        name,
        facts,
        inventory,
        signIn: signInOf(inventory),
        loginScripts: {
          sysadmin: sqlLoginScript({ variant: "sysadmin" }),
          minimal: sqlLoginScript({ variant: "minimal", databases: userDatabases }),
        },
      };
    });
    const databases: SqlDatabaseDto[] = rows.map((row) => {
      const full = fulls.get(row.id) ?? null;
      const result = lastResult.get(row.id);
      const check = lastCheck.get(row.id);
      const evidence = Array.isArray(check?.summary.evidence) ? check.summary.evidence : [];
      return {
        id: row.id,
        instance: row.instance,
        name: row.database,
        recoveryModel: row.recoveryModel,
        mode: row.mode,
        system: row.facts.system === true,
        state: row.facts.state ?? null,
        encrypted: row.facts.encrypted === true,
        tdeConfirmedAt: row.tdeConfirmedAt?.toISOString() ?? null,
        sizeBytes: row.facts.sizeBytes ?? null,
        usedBytes: row.facts.usedBytes ?? null,
        droppedAt: row.droppedAt?.toISOString() ?? null,
        selected: settings ? sqlDatabaseSelected(settings, row.instance, row.database) : false,
        rating: rateSqlDatabase({
          lastBackupAt: full?.backupFinish ?? null,
          lastResult:
            result && (result.readiness === "green" || result.readiness === "red")
              ? { outcome: result.readiness, checkedAt: result.checkedAt }
              : null,
          now,
        }),
        lastBackup: full ? toBackup(full) : null,
        lastVerification: check
          ? {
              outcome: check.summary.outcome ?? "incomplete",
              checkedAt: check.checkedAt.toISOString(),
              code: check.summary.code ?? null,
              physicalOnly: check.summary.physicalOnly === true,
              backupId: check.summary.backupId ?? null,
              evidence: evidence.slice(0, 20),
            }
          : null,
        lastForeignFullAt: row.facts.lastFullBackupAt ?? null,
      };
    });
    const waiting = await tx
      .select({ kind: endpointTasks.kind, count: sql<number>`count(*)::int` })
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, id),
          inArray(endpointTasks.kind, ["sql_verify", "sql_restore", "sql_inventory"]),
          inArray(endpointTasks.status, ["pending", "delivered"]),
        ),
      )
      .groupBy(endpointTasks.kind);
    const count = (kind: string) => waiting.find((row) => row.kind === kind)?.count ?? 0;
    return {
      capable: endpoint.os === "windows" && hasSqlCapability(endpoint.settings.agent?.capabilities),
      enabled: settings?.enabled === true,
      settings,
      verify: sqlVerifyOf(settings),
      inventoryAt: state?.collectedAt ?? null,
      inventoryTruncated: state?.truncated === true,
      instances,
      databases,
      pending: {
        verify: count("sql_verify"),
        restore: count("sql_restore"),
        inventory: count("sql_inventory"),
      },
      account: SQL_AGENT_LOGIN,
    };
  });
}

async function loadSqlDatabase(
  tx: Transaction,
  tenantId: string,
  endpointId: string,
  databaseId: string,
) {
  const [row] = await tx
    .select()
    .from(endpointSqlDatabases)
    .where(
      and(
        eq(endpointSqlDatabases.tenantId, tenantId),
        eq(endpointSqlDatabases.endpointId, endpointId),
        eq(endpointSqlDatabases.id, databaseId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Database not found");
  }
  return row;
}

export async function listSqlBackups(
  database: Database,
  tenantId: string,
  id: string,
  databaseId: string,
): Promise<{ backups: SqlBackupDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    await loadEndpoint(tx, tenantId, id);
    await loadSqlDatabase(tx, tenantId, id, databaseId);
    const rows = await tx
      .select()
      .from(endpointSqlBackups)
      .where(
        and(
          eq(endpointSqlBackups.tenantId, tenantId),
          eq(endpointSqlBackups.endpointId, id),
          eq(endpointSqlBackups.databaseId, databaseId),
        ),
      )
      .orderBy(desc(endpointSqlBackups.backupFinish))
      .limit(500);
    return { backups: rows.map(toBackup) };
  });
}

async function loadBackup(tx: Transaction, tenantId: string, endpointId: string, backupId: string) {
  const [row] = await tx
    .select({ backup: endpointSqlBackups, database: endpointSqlDatabases })
    .from(endpointSqlBackups)
    .innerJoin(endpointSqlDatabases, eq(endpointSqlDatabases.id, endpointSqlBackups.databaseId))
    .where(
      and(
        eq(endpointSqlBackups.tenantId, tenantId),
        eq(endpointSqlBackups.endpointId, endpointId),
        eq(endpointSqlBackups.id, backupId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Backup not found");
  }
  return row;
}

function backupGone(): ProblemError {
  return new ProblemError(409, "Backup no longer kept", {
    type: ENDPOINT_PROBLEMS.sqlBackupPruned,
    detail: "Retention removed the snapshot of this backup. Choose a newer one.",
  });
}

/** The instances the machine reports, by the name the registry gives them. */
function knownInstance(endpoint: Endpoint, name: string): string | null {
  const all = [
    ...(endpoint.settings.agent?.machine?.windows?.sqlInstances ?? []).map((item) => item.name),
    ...(endpoint.settings.sqlInstances?.instances ?? []).map((item) => item.name),
  ];
  return all.find((item) => item.toUpperCase() === name.toUpperCase()) ?? null;
}

export interface SqlRestoreInput {
  backupId: string;
  newName: string;
  targetInstance?: string;
  checkdb?: boolean;
}

/**
 * Restore one backup under a new name (5.1.4, W2a): a `sql_restore` task with the backup's
 * snapshot, path, SHA-256 and files. The new name is checked here and again by the agent; a name
 * the last inventory knows on the target instance is refused at once (the agent would refuse it
 * with `sql_restore_name_taken`). It never replaces an existing database.
 */
export async function requestSqlRestore(
  database: Database,
  tenantId: string,
  id: string,
  input: SqlRestoreInput,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ taskId: string }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    assertSqlCapable(endpoint);
    const { backup, database: source } = await loadBackup(tx, tenantId, id, input.backupId);
    if (backup.status !== "active") {
      throw backupGone();
    }
    const target = knownInstance(endpoint, input.targetInstance ?? source.instance);
    if (target === null) {
      throw new ProblemError(422, "Validation failed", {
        detail: "The machine reports no SQL Server instance of that name.",
        extensions: { errors: [{ path: "targetInstance", code: "unknown_instance" }] },
      });
    }
    const [taken] = await tx
      .select({ id: endpointSqlDatabases.id })
      .from(endpointSqlDatabases)
      .where(
        and(
          eq(endpointSqlDatabases.endpointId, id),
          sql`upper(${endpointSqlDatabases.instance}) = upper(${target})`,
          sql`lower(${endpointSqlDatabases.database}) = lower(${input.newName})`,
          isNull(endpointSqlDatabases.droppedAt),
        ),
      )
      .limit(1);
    if (taken) {
      throw new ProblemError(409, "Name taken", {
        type: ENDPOINT_PROBLEMS.sqlNameTaken,
        detail: `A database named ${input.newName} exists on ${target}. Choose another name.`,
      });
    }
    const maxGiB = sqlVerifyOf(endpoint.config.sql).maxGiB;
    const params: EndpointSqlRestoreParams = {
      backupId: backup.id,
      instance: source.instance,
      targetInstance: target,
      database: source.database,
      newName: input.newName,
      snapshotId: backup.resticSnapshotId,
      pathInSnapshot: backup.pathInSnapshot,
      sha256: backup.sha256,
      bytes: backup.bytes,
      fileList: backup.fileList,
      checkdb: input.checkdb ?? true,
      maxGiB,
    };
    const [task] = await tx
      .insert(endpointTasks)
      .values({
        tenantId,
        endpointId: id,
        kind: "sql_restore",
        params,
        createdBy: actor.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + SQL_RESTORE_TASK_TTL_MS),
      })
      .returning({ id: endpointTasks.id });
    if (!task) {
      throw new Error("task insert returned no row");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.sqlRestoreRequested,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        taskId: task.id,
        backupId: backup.id,
        instance: source.instance,
        targetInstance: target,
        database: source.database,
        newName: input.newName,
        checkdb: params.checkdb,
        backupFinish: backup.backupFinish.toISOString(),
      },
    });
    return { taskId: task.id };
  });
}

/** What a check of the databases of a machine needs: candidates per instance. */
export async function sqlVerifyCandidates(
  tx: Transaction,
  endpoint: Endpoint,
  only?: { databaseId: string },
): Promise<Map<string, SqlVerifyCandidate[]>> {
  const settings = endpoint.config.sql;
  const rows = (await sqlDatabasesOf(tx, endpoint.tenantId, endpoint.id)).filter(
    (row) =>
      row.droppedAt === null &&
      (only
        ? row.id === only.databaseId
        : settings
          ? sqlDatabaseSelected(settings, row.instance, row.database)
          : false),
  );
  const fulls = await newestFulls(
    tx,
    rows.map((row) => row.id),
  );
  const byInstance = new Map<string, SqlVerifyCandidate[]>();
  for (const row of rows) {
    const full = fulls.get(row.id);
    if (!full) {
      continue;
    }
    const list = byInstance.get(row.instance) ?? [];
    list.push({
      databaseId: row.id,
      name: row.database,
      usedBytes: row.facts.usedBytes ?? 0,
      backup: {
        id: full.id,
        snapshotId: full.resticSnapshotId,
        pathInSnapshot: full.pathInSnapshot,
        sha256: full.sha256,
        bytes: full.bytes,
        fileList: full.fileList as EndpointSqlBackupFile[],
      },
    });
    byInstance.set(row.instance, list);
  }
  return byInstance;
}

/**
 * Check now: one `sql_verify` task per instance with the newest full of each database the job
 * takes, or of the one database asked for. An instance with a check waiting or running gets no
 * second one (`alreadyQueued`).
 */
export async function requestSqlVerify(
  database: Database,
  tenantId: string,
  id: string,
  input: { databaseId?: string },
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ queued: string[]; alreadyQueued: string[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    assertSqlCapable(endpoint);
    if (input.databaseId) {
      await loadSqlDatabase(tx, tenantId, id, input.databaseId);
    }
    const candidates = await sqlVerifyCandidates(
      tx,
      endpoint,
      input.databaseId ? { databaseId: input.databaseId } : undefined,
    );
    if (candidates.size === 0) {
      throw new ProblemError(409, "Nothing to check", {
        type: ENDPOINT_PROBLEMS.sqlNothingToVerify,
        detail: "No database of this machine has a backup in the repository yet.",
      });
    }
    const waiting = await tx
      .select({ params: endpointTasks.params })
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, id),
          eq(endpointTasks.kind, "sql_verify"),
          inArray(endpointTasks.status, ["pending", "delivered"]),
        ),
      );
    const busy = new Set(
      waiting.map((task) =>
        String((task.params as Partial<SqlVerifyTaskParams>).instance ?? "").toUpperCase(),
      ),
    );
    const verify = sqlVerifyOf(endpoint.config.sql);
    const queued: string[] = [];
    const alreadyQueued: string[] = [];
    for (const [instance, list] of candidates) {
      if (busy.has(instance.toUpperCase())) {
        alreadyQueued.push(instance);
        continue;
      }
      const params = sqlVerifyTaskParams(instance, verify, list);
      if (!params) {
        continue;
      }
      await tx.insert(endpointTasks).values({
        tenantId,
        endpointId: id,
        kind: "sql_verify",
        params: params as unknown as Record<string, unknown>,
        createdBy: actor.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + SQL_VERIFY_TASK_TTL_MS),
      });
      queued.push(instance);
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.sqlVerifyRequested,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        databaseId: input.databaseId ?? null,
        instances: queued,
        alreadyQueued,
      },
    });
    return { queued, alreadyQueued };
  });
}

/**
 * "Check sign-in": an `sql_inventory` task, finished on delivery; the agent connects once and
 * sends a fresh inventory with its next heartbeat. Without the native backup on, this is the
 * only time the agent connects (decision C18: every failed sign-in lands in the instance's log).
 */
export async function requestSqlInventory(
  database: Database,
  tenantId: string,
  id: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ alreadyQueued: boolean }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    assertSqlCapable(endpoint);
    const [existing] = await tx
      .select({ id: endpointTasks.id })
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, id),
          eq(endpointTasks.kind, "sql_inventory"),
          eq(endpointTasks.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) {
      return { alreadyQueued: true };
    }
    await tx.insert(endpointTasks).values({
      tenantId,
      endpointId: id,
      kind: "sql_inventory",
      params: {},
      createdBy: actor.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SQL_RESTORE_TASK_TTL_MS),
    });
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.sqlInventoryRequested,
      endpointId: id,
      details: { hostname: endpoint.hostname },
    });
    return { alreadyQueued: false };
  });
}

/**
 * The restore script for another machine (5.1.4): one backup, fetched with restic from the
 * repository and restored under a new name, without this server. It carries no secret: the
 * repository password comes from "Show repository password" (audited, recent sign-in) or from
 * `restow-restore endpoint-password`. The download is audited.
 */
export async function sqlRestoreScript(
  database: Database,
  tenantId: string,
  id: string,
  backupId: string,
  actor: EndpointActor,
): Promise<{ fileName: string; body: string }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    const { backup, database: source } = await loadBackup(tx, tenantId, id, backupId);
    if (backup.status !== "active") {
      throw backupGone();
    }
    const body = renderSqlRestoreScript({
      endpointId: endpoint.id,
      hostname: endpoint.hostname,
      instance: source.instance,
      database: source.database,
      backup: {
        snapshotId: backup.resticSnapshotId,
        pathInSnapshot: backup.pathInSnapshot,
        sha256: backup.sha256,
        bytes: backup.bytes,
        firstLsn: backup.firstLsn,
        lastLsn: backup.lastLsn,
        backupFinish: backup.backupFinish.toISOString(),
        fileList: backup.fileList as EndpointSqlBackupFile[],
      },
      repositoryHint: `folder ${endpointPrefix(endpoint.id)} of the tenant's storage target`,
    });
    const stamp = backup.backupFinish.toISOString().replace(/[-:]/g, "").slice(0, 15);
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.sqlRestoreScriptDownloaded,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        backupId: backup.id,
        instance: source.instance,
        database: source.database,
      },
    });
    return { fileName: `restore-${safeFilePart(source.database)}-${stamp}Z.ps1`, body };
  });
}

/** An admin confirms that the TDE certificate and its key of a database are backed up elsewhere. */
export async function confirmSqlTde(
  database: Database,
  tenantId: string,
  id: string,
  databaseId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ confirmedAt: string }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    const row = await loadSqlDatabase(tx, tenantId, id, databaseId);
    await tx
      .update(endpointSqlDatabases)
      .set({ tdeConfirmedAt: now, tdeConfirmedBy: actor.label, updatedAt: now })
      .where(eq(endpointSqlDatabases.id, row.id));
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.sqlTdeConfirmed,
      endpointId: id,
      details: { hostname: endpoint.hostname, instance: row.instance, database: row.database },
    });
    return { confirmedAt: now.toISOString() };
  });
}
