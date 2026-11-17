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
): Promise<void> {
  const { judgement } = input;
  let sizes: Record<string, number> | null = null;
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
      await tx
        .update(databases)
        .set({ sizeBytes: found.sizeBytes, lastSeenAt: input.at, updatedAt: sql`now()` })
        .where(eq(databases.id, row.id));
    }
  }
  await tx.insert(databaseHealthSamples).values({
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
  });
}

/**
 * Fold the raw samples older than `before` into one `hour` sample per connection and hour (8):
 * the sums of the checks, the mean and extremes of the response time and the connections, and the
 * last version, start time, certificate, instance, error and sizes of the hour. Then the raw rows
 * go. Runs on the installation pool (all tenants); returns the raw rows folded.
 */
export async function compactDatabaseHealthSamples(
  // biome-ignore lint/suspicious/noExplicitAny: any drizzle database of this package.
  db: Pick<NodePgDatabase<any>, "execute">,
  before: Date,
  hourlyBefore: Date,
): Promise<{ folded: number; dropped: number }> {
  // Whole hours only: an hour is folded at once, never half of it.
  const cutoff = new Date(Math.floor(before.getTime() / 3_600_000) * 3_600_000).toISOString();
  const folded = await db.execute(sql`
    WITH raw AS (
      DELETE FROM database_health_samples
       WHERE resolution = 'raw' AND at < ${cutoff}::timestamptz
      RETURNING *
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
      INSERT INTO database_health_samples
        (tenant_id, connection_id, at, resolution, executor_kind, checks, ok_checks, error_code,
         error_message, latency_ms, latency_min_ms, latency_max_ms, server_version, started_at,
         connections_used, connections_used_max, connections_max, tls_fingerprint, instance_key, sizes)
      SELECT tenant_id, connection_id, hour, 'hour', executor_kind, checks, ok_checks, error_code,
             error_message, latency_ms, latency_min_ms, latency_max_ms, server_version, started_at,
             connections_used, connections_used_max, connections_max, tls_fingerprint, instance_key, sizes
        FROM hours
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM raw)::int AS folded, (SELECT count(*) FROM inserted)::int AS hours
  `);
  const dropped = await db.execute(sql`
    WITH gone AS (
      DELETE FROM database_health_samples
       WHERE resolution = 'hour' AND at < ${hourlyBefore.toISOString()}::timestamptz
      RETURNING 1
    )
    SELECT count(*)::int AS dropped FROM gone
  `);
  const rowsOf = (result: unknown) => (result as { rows?: Record<string, unknown>[] }).rows ?? [];
  return {
    folded: Number(rowsOf(folded)[0]?.folded ?? 0),
    dropped: Number(rowsOf(dropped)[0]?.dropped ?? 0),
  };
}
