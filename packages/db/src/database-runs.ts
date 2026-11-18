import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type DatabaseConnection,
  type DatabaseRun,
  databaseRuns,
  databases,
} from "./schema/databases.js";
import { endpointTasks } from "./schema/endpoints.js";

// biome-ignore lint/suspicious/noExplicitAny: a transaction of any schema of this package.
type RunTx = Pick<NodePgDatabase<any>, "select" | "insert" | "update">;

/** An agent has this long to fetch a run's credentials (docs/DATABASES.md 4.3). */
export const DATABASE_RUN_AGENT_FETCH_MS = 60 * 60 * 1000;

/**
 * Plan a run of a connection (docs/DATABASES.md 4.3, 16 "D3"), inside a transaction pinned to the
 * tenant: at most one queued or running run per connection. When one is active, nothing is
 * planned (null); a scheduled run that finds one notes `db_run_overlap` on it, so a schedule
 * that is too short shows. A run of an agent gets its task (`db_backup` / `db_restore`).
 *
 * `executor` is who runs it: the connection's own executor for a backup, the target
 * connection's for a restore (it holds the target's credentials and network).
 */
export async function insertDatabaseRunTx(
  tx: RunTx,
  connection: Pick<DatabaseConnection, "id" | "tenantId">,
  executor: Pick<DatabaseConnection, "executorKind" | "executorEndpointId">,
  input: Partial<
    Pick<
      DatabaseRun,
      "kind" | "trigger" | "requestedBy" | "sourceBackupId" | "targetConnectionId" | "targetName"
    >
  >,
  now: Date,
): Promise<DatabaseRun | null> {
  const [active] = await tx
    .select()
    .from(databaseRuns)
    .where(
      and(
        eq(databaseRuns.connectionId, connection.id),
        inArray(databaseRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1)
    .for("update");
  if (active) {
    if ((input.trigger ?? "schedule") === "schedule") {
      await tx
        .update(databaseRuns)
        .set({
          notes: sql`${databaseRuns.notes} || ${JSON.stringify([{ code: "db_run_overlap", at: now.toISOString() }])}::jsonb`,
        })
        .where(eq(databaseRuns.id, active.id));
    }
    return null;
  }
  const [run] = await tx
    .insert(databaseRuns)
    .values({
      tenantId: connection.tenantId,
      connectionId: connection.id,
      kind: input.kind ?? "backup",
      trigger: input.trigger ?? "schedule",
      executorKind: executor.executorKind,
      executorEndpointId: executor.executorKind === "agent" ? executor.executorEndpointId : null,
      requestedBy: input.requestedBy ?? null,
      sourceBackupId: input.sourceBackupId ?? null,
      targetConnectionId: input.targetConnectionId ?? null,
      targetName: input.targetName ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) {
    return null;
  }
  if (executor.executorKind === "agent" && executor.executorEndpointId) {
    await tx.insert(endpointTasks).values({
      tenantId: connection.tenantId,
      endpointId: executor.executorEndpointId,
      kind: run.kind === "restore" ? "db_restore" : "db_backup",
      params: { runId: run.id },
      createdAt: now,
      expiresAt: new Date(now.getTime() + DATABASE_RUN_AGENT_FETCH_MS),
    });
  }
  return run;
}

/**
 * Record the databases an instance has now (docs/DATABASES.md 3.3, from a backup run): a name
 * with a new OID is a new database, a row of this instance that is gone is dropped. Returns the
 * row id per database name.
 */
export async function recordInstanceDatabasesTx(
  tx: RunTx,
  connection: Pick<DatabaseConnection, "id" | "tenantId">,
  instanceKey: string,
  // MySQL and MariaDB schemas have no stable identity (3.3): `oid` null, known by the name.
  found: readonly { name: string; oid: string | null }[],
  now: Date,
): Promise<Map<string, string>> {
  const rows = await tx
    .select()
    .from(databases)
    .where(and(eq(databases.connectionId, connection.id), isNull(databases.droppedAt)));
  const ids = new Map<string, string>();
  for (const database of found) {
    const match =
      rows.find((row) => row.name === database.name && row.identity === database.oid) ??
      rows.find((row) => row.name === database.name && row.identity === null);
    if (match) {
      ids.set(database.name, match.id);
      await tx
        .update(databases)
        .set({ identity: database.oid, instanceKey, lastSeenAt: now, updatedAt: now })
        .where(eq(databases.id, match.id));
      continue;
    }
    const [created] = await tx
      .insert(databases)
      .values({
        tenantId: connection.tenantId,
        connectionId: connection.id,
        name: database.name,
        identity: database.oid,
        instanceKey,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: databases.id });
    if (created) {
      ids.set(database.name, created.id);
    }
  }
  const kept = new Set(ids.values());
  for (const row of rows) {
    if (!kept.has(row.id) && (row.instanceKey === null || row.instanceKey === instanceKey)) {
      await tx
        .update(databases)
        .set({ droppedAt: now, updatedAt: now })
        .where(eq(databases.id, row.id));
    }
  }
  return ids;
}
