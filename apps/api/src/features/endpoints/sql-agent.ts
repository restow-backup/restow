import {
  inventoryIsComplete,
  judgeSqlVerifyDatabase,
  parseRunNotices,
  parseSqlBackupReport,
  parseSqlInventory,
  parseSqlRestoreReport,
  parseSqlVerifyReport,
  type SqlInventory,
  type SqlVerifyDatabaseReport,
} from "@restow/core";
import {
  type EndpointRun,
  type EndpointRunSqlDatabase,
  type EndpointRunSqlStats,
  type EndpointRunStats,
  type EndpointSqlInventoryState,
  type EndpointSqlRestoreParams,
  type EndpointSqlVerifyParams,
  endpointReports,
  endpointSqlBackups,
  endpointSqlDatabases,
  endpoints,
  endpointTasks,
} from "@restow/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import type { AgentContext } from "./agent-auth.js";
import { agentActor, auditEndpoint, ENDPOINT_AUDIT_ACTIONS } from "./audit.js";
import type { FinishRunInput } from "./schemas.js";

/**
 * The server side of the native SQL Server backup in the agent contract (W2a,
 * docs/BAREMETAL-WINDOWS.md 5.1; the fixtures in agent/internal/api/testdata/contract): the SQL
 * inventory of a heartbeat, and the end of the runs `sql`, `sql_restore` and `sql_verify`. Every
 * report is read through @restow/core (checked, bounded, redacted); what does not fit is dropped,
 * so a heartbeat or the end of a run always counts.
 */

/** One run's database results kept in its statistics; the run sheet lists them. */
const MAX_RUN_DATABASES = 200;

function bounded(databases: EndpointRunSqlDatabase[]): EndpointRunSqlDatabase[] {
  return databases.slice(0, MAX_RUN_DATABASES);
}

/**
 * Write the SQL inventory of a heartbeat: one row per database (by `family_guid`, so a database
 * dropped and created again under the same name is another row), `dropped_at` for a database a
 * complete inventory of an `ok` instance no longer names (cleared when it comes back), and the
 * instances themselves in `settings.sqlInstances` with a `jsonb_set` of their own, so a
 * heartbeat without an inventory never removes them.
 */
export async function recordSqlInventory(
  tx: Transaction,
  agent: AgentContext,
  raw: unknown,
  now: Date,
): Promise<SqlInventory | null> {
  const inventory = parseSqlInventory(raw);
  if (!inventory) {
    return null;
  }
  for (const instance of inventory.instances) {
    if (instance.state !== "ok") {
      continue;
    }
    const seen = new Set<string>();
    for (const database of instance.databases) {
      seen.add(`${database.name}\u0000${database.familyGuid}`);
      const { name, familyGuid, databaseGuid, recoveryModel, ...facts } = database;
      await tx
        .insert(endpointSqlDatabases)
        .values({
          tenantId: agent.tenantId,
          endpointId: agent.endpointId,
          instance: instance.name,
          database: name,
          familyGuid,
          databaseGuid,
          recoveryModel,
          facts,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [
            endpointSqlDatabases.endpointId,
            endpointSqlDatabases.instance,
            endpointSqlDatabases.database,
            endpointSqlDatabases.familyGuid,
          ],
          set: {
            databaseGuid,
            recoveryModel,
            facts,
            lastSeenAt: now,
            droppedAt: null,
            updatedAt: now,
          },
        });
    }
    if (!inventoryIsComplete(inventory, instance)) {
      continue;
    }
    const present = await tx
      .select({
        id: endpointSqlDatabases.id,
        database: endpointSqlDatabases.database,
        familyGuid: endpointSqlDatabases.familyGuid,
      })
      .from(endpointSqlDatabases)
      .where(
        and(
          eq(endpointSqlDatabases.endpointId, agent.endpointId),
          eq(endpointSqlDatabases.instance, instance.name),
          isNull(endpointSqlDatabases.droppedAt),
        ),
      );
    for (const row of present) {
      if (!seen.has(`${row.database}\u0000${row.familyGuid}`)) {
        await tx
          .update(endpointSqlDatabases)
          .set({ droppedAt: now, updatedAt: now })
          .where(eq(endpointSqlDatabases.id, row.id));
      }
    }
  }
  const state: EndpointSqlInventoryState = {
    collectedAt: inventory.collectedAt,
    truncated: inventory.truncated,
    instances: inventory.instances.map(({ databases: _databases, ...instance }) => instance),
  };
  await tx
    .update(endpoints)
    .set({
      settings: sql`jsonb_set(${endpoints.settings}, '{sqlInstances}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(endpoints.id, agent.endpointId));
  return inventory;
}

/** The notices of a run, for its statistics; undefined for none. */
export function runNoticesOf(input: Pick<FinishRunInput, "notices">) {
  return parseRunNotices(input.notices);
}

/** `stats` with the SQL part and the notices beside them; null when there is nothing to keep. */
export function withSqlStats(
  stats: EndpointRunStats | null,
  extra: { sql?: EndpointRunSqlStats; notices?: EndpointRunStats["notices"] },
): EndpointRunStats | null {
  if (!extra.sql && !extra.notices) {
    return stats;
  }
  return {
    ...(stats ?? {}),
    ...(extra.sql ? { sql: extra.sql } : {}),
    ...(extra.notices ? { notices: extra.notices } : {}),
  };
}

/**
 * The end of a `sql` run (one instance): every database it backed up gets its row (by
 * `family_guid`) and one row in `endpoint_sql_backups` for the run's snapshot, with the chain
 * facts of `RESTORE HEADERONLY` and `FILELISTONLY` as the agent read them from its own file.
 * A backup is kept only with the run's whole snapshot id: retention and the check fetch it from
 * there.
 */
export async function recordSqlBackupRun(
  tx: Transaction,
  agent: AgentContext,
  run: EndpointRun,
  input: FinishRunInput,
  now: Date,
): Promise<EndpointRunSqlStats | undefined> {
  const report = parseSqlBackupReport(input.sql);
  if (!report) {
    return undefined;
  }
  const snapshotId =
    input.snapshotId && /^[0-9a-f]{64}$/.test(input.snapshotId) && input.status !== "failed"
      ? input.snapshotId
      : null;
  const databases: EndpointRunSqlDatabase[] = [];
  for (const database of report.databases) {
    const kept =
      database.outcome === "backed_up" &&
      database.backup !== undefined &&
      database.familyGuid !== undefined &&
      database.databaseGuid !== undefined &&
      snapshotId !== null;
    if (kept && database.backup && database.familyGuid && database.databaseGuid && snapshotId) {
      const backup = database.backup;
      const [row] = await tx
        .insert(endpointSqlDatabases)
        .values({
          tenantId: agent.tenantId,
          endpointId: agent.endpointId,
          instance: report.instance,
          database: database.name,
          familyGuid: database.familyGuid,
          databaseGuid: database.databaseGuid,
          recoveryModel: database.recoveryModel ?? "UNKNOWN",
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [
            endpointSqlDatabases.endpointId,
            endpointSqlDatabases.instance,
            endpointSqlDatabases.database,
            endpointSqlDatabases.familyGuid,
          ],
          set: {
            databaseGuid: database.databaseGuid,
            ...(database.recoveryModel ? { recoveryModel: database.recoveryModel } : {}),
            lastSeenAt: now,
            droppedAt: null,
            updatedAt: now,
          },
        })
        .returning({ id: endpointSqlDatabases.id });
      if (row) {
        await tx.insert(endpointSqlBackups).values({
          tenantId: agent.tenantId,
          endpointId: agent.endpointId,
          databaseId: row.id,
          runId: run.id,
          kind: "full",
          copyOnly: backup.copyOnly,
          resticSnapshotId: snapshotId,
          pathInSnapshot: backup.pathInSnapshot,
          sha256: backup.sha256,
          firstLsn: backup.firstLsn,
          lastLsn: backup.lastLsn,
          databaseBackupLsn: backup.databaseBackupLsn ?? null,
          checkpointLsn: backup.checkpointLsn ?? null,
          databaseGuid: database.databaseGuid,
          familyGuid: database.familyGuid,
          firstRecoveryForkGuid: backup.firstRecoveryForkGuid ?? null,
          lastRecoveryForkGuid: backup.lastRecoveryForkGuid ?? null,
          beginsLogChain: backup.beginsLogChain,
          hasBulkLoggedData: backup.hasBulkLoggedData,
          backupStart: new Date(backup.backupStart),
          backupFinish: new Date(backup.backupFinish),
          bytes: backup.bytes,
          fileList: backup.fileList,
          compressed: backup.compressed,
          checksum: backup.checksum,
        });
      }
    }
    databases.push({
      name: database.name,
      // A backup without the run's snapshot is not in the repository: it did not work.
      outcome: database.outcome === "backed_up" && !kept ? "failed" : database.outcome,
      ...(database.code ? { code: database.code } : {}),
      ...(database.message ? { message: database.message } : {}),
      ...(database.backup ? { bytes: database.backup.bytes } : {}),
    });
  }
  return { instance: report.instance, databases: bounded(databases) };
}

type VerifyTarget = EndpointSqlVerifyParams["databases"][number];

async function taskParams<T>(tx: Transaction, run: EndpointRun): Promise<T | null> {
  if (!run.taskId) {
    return null;
  }
  const [task] = await tx
    .select({ params: endpointTasks.params })
    .from(endpointTasks)
    .where(eq(endpointTasks.id, run.taskId))
    .limit(1);
  return (task?.params as T | undefined) ?? null;
}

/**
 * The end of a `sql_verify` run: the server judges each database (@restow/core
 * `judgeSqlVerifyDatabase`; the agent reports facts only) and writes one report of kind
 * `sql_verify` per database of the task, green or red with evidence, or without a readiness when
 * the check came to no result. Only databases of the task count: a report about another one is
 * ignored. A database of the task the agent did not report on is incomplete. The restore test of
 * the file backup (`last_restore_test_at`) is not touched.
 */
export async function recordSqlVerifyRun(
  tx: Transaction,
  agent: AgentContext,
  run: EndpointRun,
  input: FinishRunInput,
  now: Date,
): Promise<EndpointRunSqlStats | undefined> {
  const params = await taskParams<EndpointSqlVerifyParams>(tx, run);
  if (!params || !Array.isArray(params.databases)) {
    return undefined;
  }
  const report = parseSqlVerifyReport(input.sqlVerify);
  const byId = new Map<string, SqlVerifyDatabaseReport>();
  for (const database of report?.databases ?? []) {
    if (database.databaseId && !byId.has(database.databaseId)) {
      byId.set(database.databaseId, database);
    }
  }
  const databases: EndpointRunSqlDatabase[] = [];
  for (const target of params.databases as VerifyTarget[]) {
    const reported = byId.get(target.databaseId);
    // The agent must name the backup the task asked for; another one proves nothing about it.
    const facts: SqlVerifyDatabaseReport =
      reported && (reported.backupId === undefined || reported.backupId === target.backupId)
        ? reported
        : {
            name: target.name,
            method: "none",
            fetched: false,
            sha256Match: null,
            restore: null,
            checkdb: null,
            code: input.status === "failed" ? "sql_script_failed" : "sql_verify_incomplete",
          };
    const judgement = judgeSqlVerifyDatabase(facts);
    await tx.insert(endpointReports).values({
      tenantId: agent.tenantId,
      endpointId: agent.endpointId,
      kind: "sql_verify",
      origin: "agent",
      snapshotId: target.snapshotId,
      readiness: judgement.outcome === "incomplete" ? null : judgement.outcome,
      summary: {
        databaseId: target.databaseId,
        backupId: target.backupId,
        outcome: judgement.outcome,
        instance: params.instance,
        database: target.name,
        method: facts.method,
        ...(judgement.code ? { code: judgement.code } : {}),
        physicalOnly: facts.checkdb?.physicalOnly ?? false,
        ...(facts.backupLsn ? { backupLsn: facts.backupLsn } : {}),
        ...(facts.durationMs !== undefined ? { durationMs: facts.durationMs } : {}),
        ...(judgement.evidence.length > 0 ? { evidence: judgement.evidence } : {}),
        ...(facts.message ? { errorMessage: facts.message } : {}),
      },
      runId: run.id,
      checkedAt: now,
    });
    databases.push({
      name: target.name,
      outcome: judgement.outcome,
      ...(judgement.code ? { code: judgement.code } : {}),
      ...(facts.message ? { message: facts.message } : {}),
      ...(facts.durationMs !== undefined ? { durationMs: facts.durationMs } : {}),
    });
  }
  return { instance: params.instance, databases: bounded(databases) };
}

/** The end of a `sql_restore` run: its result in the run's statistics, and the audit trail. */
export async function recordSqlRestoreRun(
  tx: Transaction,
  agent: AgentContext,
  run: EndpointRun,
  input: FinishRunInput,
  errors: { message: string; code?: string }[],
): Promise<EndpointRunSqlStats | undefined> {
  const params = await taskParams<EndpointSqlRestoreParams>(tx, run);
  const report = parseSqlRestoreReport(input.sqlRestore);
  const restored = report?.restored === true && input.status !== "failed";
  const checkdb: EndpointRunSqlStats["checkdb"] =
    report?.checkdb?.ran === true
      ? report.checkdb.errors.length > 0
        ? "errors"
        : "clean"
      : "skipped";
  await auditEndpoint(tx, {
    tenantId: agent.tenantId,
    actor: agentActor(agent.hostname, agent.ip),
    action: ENDPOINT_AUDIT_ACTIONS.sqlRestoreFinished,
    endpointId: agent.endpointId,
    details: {
      runId: run.id,
      taskId: run.taskId,
      status: input.status,
      backupId: params?.backupId ?? null,
      database: params?.database ?? null,
      instance: params?.targetInstance ?? report?.instance ?? null,
      newName: params?.newName ?? report?.newName ?? null,
      restored,
      checkdb,
      errors: errors.length,
    },
  });
  const instance = params?.targetInstance ?? report?.instance;
  if (!instance) {
    return undefined;
  }
  const code = report?.code ?? errors[0]?.code;
  return {
    instance,
    newName: params?.newName ?? report?.newName,
    checkdb,
    databases: [
      {
        name: params?.database ?? report?.newName ?? "",
        outcome: restored ? "restored" : "failed",
        ...(code ? { code } : {}),
        ...(report?.message ? { message: report.message } : {}),
        ...(report?.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
      },
    ],
  };
}
