import type { DbHealthJudgement } from "@restow/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { databaseHealthSamples, databases } from "./schema/databases.js";

// biome-ignore lint/suspicious/noExplicitAny: a transaction of any schema of this package.
type HealthTx = Pick<NodePgDatabase<any>, "select" | "insert" | "update">;

/**
 * Write one judged health check (docs/DATABASES.md 8) of a connection: the API for an agent's
 * checks, the worker for the server's. Inside a transaction pinned to the tenant. Sizes are kept
 * per database row of the connection's current instance (found by name and, for PostgreSQL, OID)
 * and the row's `size_bytes` follows; a database the check found but no test listed yet stays out
 * (a test or a backup run brings it in, with its identity).
 *
 * A connection has at most one sample per point in time: a second one at the same time (a report
 * sent twice) is dropped, and the sizes are not taken from it. Returns whether it was written.
 */
export async function recordDatabaseHealthSample(
  tx: HealthTx,
  input: {
    tenantId: string;
    connectionId: string;
    instanceKey: string | null;
    executorKind: "agent" | "server";
    at: Date;
    judgement: DbHealthJudgement;
  },
): Promise<boolean> {
  const { judgement } = input;
  let sizes: Record<string, number> | null = null;
  const sizeUpdates: { id: string; sizeBytes: number }[] = [];
  if (judgement.ok && judgement.sizes) {
    const rows = await tx
      .select({ id: databases.id, name: databases.name, identity: databases.identity })
      .from(databases)
      .where(
        and(
          eq(databases.tenantId, input.tenantId),
          eq(databases.connectionId, input.connectionId),
          isNull(databases.droppedAt),
          input.instanceKey === null
            ? isNull(databases.instanceKey)
            : eq(databases.instanceKey, input.instanceKey),
        ),
      );
    sizes = {};
    for (const found of judgement.sizes) {
      const row =
        rows.find(
          (candidate) => candidate.name === found.name && candidate.identity === found.identity,
        ) ?? rows.find((candidate) => candidate.name === found.name && candidate.identity === null);
      if (!row) {
        continue;
      }
      sizes[row.id] = found.sizeBytes;
      sizeUpdates.push({ id: row.id, sizeBytes: found.sizeBytes });
    }
  }
  const written = await tx
    .insert(databaseHealthSamples)
    .values({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      at: input.at,
      resolution: "raw",
      executorKind: input.executorKind,
      checks: 1,
      okChecks: judgement.ok ? 1 : 0,
      errorCode: judgement.ok ? null : judgement.errorCode,
      errorMessage: judgement.ok ? null : (judgement.errorMessage?.slice(0, 500) ?? null),
      latencyMs: judgement.ok ? judgement.latencyMs : null,
      latencyMinMs: judgement.ok ? judgement.latencyMs : null,
      latencyMaxMs: judgement.ok ? judgement.latencyMs : null,
      serverVersion: judgement.serverVersion?.slice(0, 256) ?? null,
      startedAt: judgement.startedAt ? new Date(judgement.startedAt) : null,
      connectionsUsed: judgement.connectionsUsed,
      connectionsUsedMax: judgement.connectionsUsed,
      connectionsMax: judgement.connectionsMax,
      tlsFingerprint: judgement.tlsFingerprint,
      instanceKey: judgement.instanceKey,
      sizes,
    })
    .onConflictDoNothing({
      target: [
        databaseHealthSamples.connectionId,
        databaseHealthSamples.at,
        databaseHealthSamples.resolution,
      ],
    })
    .returning({ id: databaseHealthSamples.id });
  if (written.length === 0) {
    return false;
  }
  for (const update of sizeUpdates) {
    await tx
      .update(databases)
      .set({ sizeBytes: update.sizeBytes, lastSeenAt: input.at, updatedAt: sql`now()` })
      .where(eq(databases.id, update.id));
  }
  return true;
}

/** Hours (per connection) folded in one statement, and hourly rows dropped in one. */
export const DB_HEALTH_COMPACT_HOURS_PER_BATCH = 500;
export const DB_HEALTH_DROP_ROWS_PER_BATCH = 5000;

/**
 * Fold the raw samples older than `before` into one `hour` sample per connection and hour (8):
 * the sums of the checks, the mean and extremes of the response time and the connections, and the
 * last version, start time, certificate, instance, error and sizes of the hour. Then the raw rows
 * go. Runs on the installation pool (all tenants).
 *
 * One call is one bounded batch: at most `hours` connection-hours are folded (the oldest first;
 * a connection has at most a few dozen samples an hour) and at most `rows` hourly rows older than
 * `hourlyBefore` dropped. `more` says that something is left; the worker calls again (in the same
 * pass, within its budget, or in the next one). An hour that already has its `hour` row (a raw
 * sample that came late) is merged into it.
 */
export async function compactDatabaseHealthSamples(
  // biome-ignore lint/suspicious/noExplicitAny: any drizzle database of this package.
  db: Pick<NodePgDatabase<any>, "execute">,
  before: Date,
  hourlyBefore: Date,
  limits: { hours: number; rows: number } = {
    hours: DB_HEALTH_COMPACT_HOURS_PER_BATCH,
    rows: DB_HEALTH_DROP_ROWS_PER_BATCH,
  },
): Promise<{ folded: number; dropped: number; more: boolean }> {
  // Whole hours only: an hour is folded at once, never half of it.
  const cutoff = new Date(Math.floor(before.getTime() / 3_600_000) * 3_600_000).toISOString();
  const folded = await db.execute(sql`
    WITH batch AS (
      SELECT connection_id, date_trunc('hour', at) AS hour
        FROM database_health_samples
       WHERE resolution = 'raw' AND at < ${cutoff}::timestamptz
       GROUP BY connection_id, date_trunc('hour', at)
       ORDER BY date_trunc('hour', at), connection_id
       LIMIT ${limits.hours}
    ), raw AS (
      DELETE FROM database_health_samples s
       USING batch b
       WHERE s.resolution = 'raw' AND s.connection_id = b.connection_id
         AND s.at >= b.hour AND s.at < b.hour + interval '1 hour'
      RETURNING s.*
    ), hours AS (
      SELECT tenant_id, connection_id, date_trunc('hour', at) AS hour,
             (array_agg(executor_kind ORDER BY at DESC))[1] AS executor_kind,
             sum(checks)::int AS checks, sum(ok_checks)::int AS ok_checks,
             (array_agg(error_code ORDER BY at DESC) FILTER (WHERE error_code IS NOT NULL))[1] AS error_code,
             (array_agg(error_message ORDER BY at DESC) FILTER (WHERE error_code IS NOT NULL))[1] AS error_message,
             round(avg(latency_ms))::int AS latency_ms,
             min(latency_min_ms) AS latency_min_ms, max(latency_max_ms) AS latency_max_ms,
             (array_agg(server_version ORDER BY at DESC) FILTER (WHERE server_version IS NOT NULL))[1] AS server_version,
             (array_agg(started_at ORDER BY at DESC) FILTER (WHERE started_at IS NOT NULL))[1] AS started_at,
             round(avg(connections_used))::int AS connections_used,
             max(connections_used_max) AS connections_used_max,
             max(connections_max) AS connections_max,
             (array_agg(tls_fingerprint ORDER BY at DESC) FILTER (WHERE tls_fingerprint IS NOT NULL))[1] AS tls_fingerprint,
             (array_agg(instance_key ORDER BY at DESC) FILTER (WHERE instance_key IS NOT NULL))[1] AS instance_key,
             (array_agg(sizes ORDER BY at DESC) FILTER (WHERE sizes IS NOT NULL))[1] AS sizes
        FROM raw
       GROUP BY tenant_id, connection_id, date_trunc('hour', at)
    ), inserted AS (
      INSERT INTO database_health_samples AS h
        (tenant_id, connection_id, at, resolution, executor_kind, checks, ok_checks, error_code,
         error_message, latency_ms, latency_min_ms, latency_max_ms, server_version, started_at,
         connections_used, connections_used_max, connections_max, tls_fingerprint, instance_key, sizes)
      SELECT tenant_id, connection_id, hour, 'hour', executor_kind, checks, ok_checks, error_code,
             error_message, latency_ms, latency_min_ms, latency_max_ms, server_version, started_at,
             connections_used, connections_used_max, connections_max, tls_fingerprint, instance_key, sizes
        FROM hours
      ON CONFLICT (connection_id, at, resolution) DO UPDATE SET
        checks = h.checks + excluded.checks,
        ok_checks = h.ok_checks + excluded.ok_checks,
        latency_min_ms = least(h.latency_min_ms, excluded.latency_min_ms),
        latency_max_ms = greatest(h.latency_max_ms, excluded.latency_max_ms),
        connections_used_max = greatest(h.connections_used_max, excluded.connections_used_max),
        connections_max = greatest(h.connections_max, excluded.connections_max),
        error_code = coalesce(excluded.error_code, h.error_code),
        error_message = CASE WHEN excluded.error_code IS NULL THEN h.error_message ELSE excluded.error_message END
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM raw)::int AS folded, (SELECT count(*) FROM batch)::int AS batch
  `);
  const dropped = await db.execute(sql`
    WITH gone AS (
      DELETE FROM database_health_samples
       WHERE id IN (
         SELECT id FROM database_health_samples
          WHERE resolution = 'hour' AND at < ${hourlyBefore.toISOString()}::timestamptz
          LIMIT ${limits.rows})
      RETURNING 1
    )
    SELECT count(*)::int AS dropped FROM gone
  `);
  const rowsOf = (result: unknown) => (result as { rows?: Record<string, unknown>[] }).rows ?? [];
  const batch = Number(rowsOf(folded)[0]?.batch ?? 0);
  const droppedCount = Number(rowsOf(dropped)[0]?.dropped ?? 0);
  return {
    folded: Number(rowsOf(folded)[0]?.folded ?? 0),
    dropped: droppedCount,
    more: batch >= limits.hours || droppedCount >= limits.rows,
  };
}
