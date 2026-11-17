import {
  DB_HEALTH_AGENT_TASK_SPACING_MS,
  DB_HEALTH_AGENT_WINDOW_SECONDS,
  DB_HEALTH_SIZES_EVERY_MS,
  DB_HEALTH_TIMEOUT_SECONDS,
  type DbHealthEvent,
  type DbProbeSpec,
  dbHealthEvents,
  judgeDbHealth,
  parseDbProbeResult,
  sanitizeDbMessage,
} from "@restow/core";
import {
  databaseConnections,
  databaseHealthSamples,
  databases,
  endpointTasks,
  recordDatabaseHealthSample,
} from "@restow/db";
import { and, asc, desc, eq, gt, gte, isNotNull, lte, max, sql } from "drizzle-orm";
import { z } from "zod";
import { readSecret } from "../../lib/secrets.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { restoreModeTaskHoldBefore } from "../restore-mode/hold.js";
import { restowSystemIdentifier } from "./service.js";

/**
 * Health checks of the module "Databases", stage D2 (docs/DATABASES.md 8, 9): the agent's side and
 * the history the pages read. The worker checks the server's connections itself, judges every
 * connection's samples and raises the alerts (apps/worker databases/health.ts).
 *
 * An agent gets its checks bundled: with a heartbeat at most every 4 minutes a `db_health` task
 * (finished on delivery) for the enabled connections it runs. It fetches the task's checks once
 * (`GET /agent/v1/databases/health/:taskId`), with the credentials of each connection and the
 * certificate an administrator confirmed, runs each one when due within the task's window
 * ({@link DB_HEALTH_AGENT_WINDOW_SECONDS}) at the connection's interval, and posts what it found
 * (`POST …/:taskId/samples`). The server judges every sample as for its own checks, cleans the
 * messages of the credentials once more and keeps only connections the task named.
 */

const MINUTE_MS = 60 * 1000;
/** A sample may be up to this much older than the fetch or newer than now (clocks differ). */
const CLOCK_SLACK_MS = 2 * MINUTE_MS;
/** Samples are accepted until this long after the window. */
const POST_GRACE_MS = 5 * MINUTE_MS;

export const HEALTH_PROBLEMS = {
  used: "urn:restow:problem:database-health-used",
  closed: "urn:restow:problem:database-health-closed",
} as const;

// ---------------------------------------------------------------------------
// The heartbeat: one `db_health` task per agent and window
// ---------------------------------------------------------------------------

/**
 * Hand an agent a `db_health` task when it runs an enabled connection and its last one is older
 * than {@link DB_HEALTH_AGENT_TASK_SPACING_MS}. Called inside the heartbeat's transaction; never
 * while restore mode is on (no checks with credentials, 10).
 */
export async function planAgentHealthTask(
  tx: Transaction,
  agent: { tenantId: string; endpointId: string },
  capabilities: readonly string[] | null | undefined,
  now: Date,
): Promise<{ id: string; kind: "db_health"; params: Record<string, unknown> } | null> {
  if (!capabilities?.includes("db_runner_v1")) {
    return null;
  }
  const [running] = await tx
    .select({ id: databaseConnections.id })
    .from(databaseConnections)
    .where(
      and(
        eq(databaseConnections.tenantId, agent.tenantId),
        eq(databaseConnections.executorKind, "agent"),
        eq(databaseConnections.executorEndpointId, agent.endpointId),
        eq(databaseConnections.enabled, true),
      ),
    )
    .limit(1);
  if (!running) {
    return null;
  }
  const [recent] = await tx
    .select({ id: endpointTasks.id })
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.endpointId, agent.endpointId),
        eq(endpointTasks.kind, "db_health"),
        gt(endpointTasks.createdAt, new Date(now.getTime() - DB_HEALTH_AGENT_TASK_SPACING_MS)),
      ),
    )
    .limit(1);
  if (recent) {
    return null;
  }
  const params = { windowSeconds: DB_HEALTH_AGENT_WINDOW_SECONDS };
  const [created] = await tx
    .insert(endpointTasks)
    .values({
      tenantId: agent.tenantId,
      endpointId: agent.endpointId,
      kind: "db_health",
      params,
      status: "done",
      createdAt: now,
      deliveredAt: now,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + DB_HEALTH_AGENT_WINDOW_SECONDS * 1000),
    })
    .returning({ id: endpointTasks.id });
  return created ? { id: created.id, kind: "db_health", params } : null;
}

// ---------------------------------------------------------------------------
// The agent fetches its checks once and posts what it found
// ---------------------------------------------------------------------------

export interface AgentHealthCheck {
  connectionId: string;
  /** Run the first check this many seconds after the fetch (0: now). */
  firstAfterSeconds: number;
  /** Then every this many seconds while the window lasts. */
  intervalSeconds: number;
  /** The spec of the check, with the credentials (held in memory only). */
  spec: DbProbeSpec;
}

export interface AgentHealthPlan {
  taskId: string;
  windowSeconds: number;
  checks: AgentHealthCheck[];
}

interface HealthTaskParams {
  windowSeconds?: number;
  fetchedAt?: string;
  connectionIds?: string[];
}

async function credentialsOf(
  tx: DbExecutor,
  tenantId: string,
  secretId: string | null,
): Promise<{ user: string | null; password: string | null }> {
  if (!secretId) {
    return { user: null, password: null };
  }
  const plaintext = await readSecret(tx, { id: secretId, tenantId });
  if (!plaintext) {
    return { user: null, password: null };
  }
  const parsed = JSON.parse(plaintext) as { user?: string | null; password?: string | null };
  return { user: parsed.user ?? null, password: parsed.password ?? null };
}

function notFound(): ProblemError {
  return new ProblemError(404, "Health check task not found");
}

async function loadTask(
  tx: Transaction,
  agent: { endpointId: string; tenantId: string },
  taskId: string,
) {
  const [task] = await tx
    .select()
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.tenantId, agent.tenantId),
        eq(endpointTasks.id, taskId),
        eq(endpointTasks.endpointId, agent.endpointId),
        eq(endpointTasks.kind, "db_health"),
      ),
    )
    .limit(1)
    .for("update");
  return task ?? null;
}

/**
 * The checks of a `db_health` task, with the credentials, once (4.3): a second fetch is refused.
 * Each connection's first check is placed where its interval falls after its newest sample.
 */
export async function agentFetchHealth(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  taskId: string,
  now: Date = new Date(),
): Promise<AgentHealthPlan> {
  if ((await restoreModeTaskHoldBefore()) !== null) {
    throw new ProblemError(409, "Restore mode is on", {
      type: "urn:restow:problem:restore-mode",
      detail: "No database health checks run while the installation is in restore mode.",
    });
  }
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const task = await loadTask(tx, agent, taskId);
    const params = (task?.params ?? {}) as HealthTaskParams;
    const windowSeconds = params.windowSeconds ?? DB_HEALTH_AGENT_WINDOW_SECONDS;
    if (!task || now.getTime() > task.createdAt.getTime() + windowSeconds * 1000) {
      throw notFound();
    }
    if (params.fetchedAt) {
      throw new ProblemError(409, "Health check task already fetched", {
        type: HEALTH_PROBLEMS.used,
      });
    }
    const connections = await tx
      .select({
        connection: databaseConnections,
        lastAt: sql<Date | null>`(SELECT max(s.at) FROM ${databaseHealthSamples} s WHERE s.connection_id = ${databaseConnections.id} AND s.resolution = 'raw')`,
        sizesAt: sql<Date | null>`(SELECT max(s.at) FROM ${databaseHealthSamples} s WHERE s.connection_id = ${databaseConnections.id} AND s.sizes IS NOT NULL)`,
      })
      .from(databaseConnections)
      .where(
        and(
          eq(databaseConnections.tenantId, agent.tenantId),
          eq(databaseConnections.executorKind, "agent"),
          eq(databaseConnections.executorEndpointId, agent.endpointId),
          eq(databaseConnections.enabled, true),
        ),
      )
      .orderBy(asc(databaseConnections.id));
    const checks: AgentHealthCheck[] = [];
    for (const { connection, lastAt, sizesAt } of connections) {
      const intervalSeconds = connection.healthIntervalMinutes * 60;
      const last = lastAt ? new Date(lastAt).getTime() : null;
      const dueIn = last === null ? 0 : last + intervalSeconds * 1000 - now.getTime();
      const firstAfterSeconds = Math.max(0, Math.ceil(dueIn / 1000));
      if (firstAfterSeconds >= windowSeconds) {
        continue;
      }
      const sizes =
        !sizesAt || now.getTime() - new Date(sizesAt).getTime() >= DB_HEALTH_SIZES_EVERY_MS;
      const credentials =
        connection.authMethod === "password"
          ? await credentialsOf(tx, agent.tenantId, connection.credentialSecretId)
          : { user: null, password: null };
      checks.push({
        connectionId: connection.id,
        firstAfterSeconds,
        intervalSeconds,
        spec: {
          probeId: taskId,
          engine: connection.engine,
          host: connection.host,
          port: connection.port,
          path: connection.path,
          database: connection.loginDatabase,
          authMethod: connection.authMethod,
          user: credentials.user,
          password: credentials.password,
          allowUnencrypted: connection.allowUnencrypted,
          timeoutSeconds: DB_HEALTH_TIMEOUT_SECONDS,
          purpose: "health",
          tlsFingerprint: connection.tlsFingerprint,
          sizes,
        },
      });
    }
    await tx
      .update(endpointTasks)
      .set({
        params: {
          ...params,
          windowSeconds,
          fetchedAt: now.toISOString(),
          connectionIds: checks.map((check) => check.connectionId),
        },
      })
      .where(eq(endpointTasks.id, task.id));
    return { taskId, windowSeconds, checks };
  });
}

export const agentHealthSamplesSchema = z
  .object({
    samples: z
      .array(
        z.object({
          connectionId: z.string().uuid(),
          at: z.string().datetime({ offset: true }),
          result: z.unknown(),
        }),
      )
      .max(200),
  })
  .strict();
export type AgentHealthSamples = z.infer<typeof agentHealthSamplesSchema>;

/**
 * What the agent found, judged as the server's own checks are. A sample of a connection the task
 * did not name, outside the task's window, or that is no result is dropped; the answer says how
 * many were kept.
 */
export async function agentReportHealth(
  db: DbExecutor,
  agent: { endpointId: string; tenantId: string },
  taskId: string,
  input: AgentHealthSamples,
  now: Date = new Date(),
): Promise<{ accepted: number }> {
  const own = await restowSystemIdentifier();
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const task = await loadTask(tx, agent, taskId);
    const params = (task?.params ?? {}) as HealthTaskParams;
    if (!task || !params.fetchedAt) {
      throw notFound();
    }
    const fetchedAt = Date.parse(params.fetchedAt);
    const windowMs = (params.windowSeconds ?? DB_HEALTH_AGENT_WINDOW_SECONDS) * 1000;
    if (now.getTime() > fetchedAt + windowMs + POST_GRACE_MS) {
      throw new ProblemError(409, "Health check task closed", { type: HEALTH_PROBLEMS.closed });
    }
    const named = new Set(params.connectionIds ?? []);
    let accepted = 0;
    const connections = new Map<string, typeof databaseConnections.$inferSelect>();
    for (const sample of input.samples) {
      const at = Date.parse(sample.at);
      if (
        !named.has(sample.connectionId) ||
        at < fetchedAt - CLOCK_SLACK_MS ||
        at > now.getTime() + CLOCK_SLACK_MS
      ) {
        continue;
      }
      const result = parseDbProbeResult(sample.result);
      if (!result) {
        continue;
      }
      let connection = connections.get(sample.connectionId);
      if (!connection) {
        const [row] = await tx
          .select()
          .from(databaseConnections)
          .where(
            and(
              eq(databaseConnections.tenantId, agent.tenantId),
              eq(databaseConnections.id, sample.connectionId),
              eq(databaseConnections.executorKind, "agent"),
              eq(databaseConnections.executorEndpointId, agent.endpointId),
              // Switched off while the task ran: its checks stopped with it.
              eq(databaseConnections.enabled, true),
            ),
          )
          .limit(1);
        if (!row) {
          continue;
        }
        connection = row;
        connections.set(row.id, row);
      }
      const credentials =
        connection.authMethod === "password"
          ? await credentialsOf(tx, agent.tenantId, connection.credentialSecretId)
          : { user: null, password: null };
      const cleaned = result.error
        ? {
            ...result,
            error: {
              ...result.error,
              message: sanitizeDbMessage(result.error.message, credentials),
            },
          }
        : result;
      let judgement = judgeDbHealth(cleaned, connection);
      if (
        own !== null &&
        cleaned.engine === "postgresql" &&
        cleaned.health?.systemIdentifier === own
      ) {
        judgement = {
          ok: false,
          errorCode: "db_target_is_restow",
          errorMessage: "This is the database of this Restow installation.",
          latencyMs: null,
          serverVersion: null,
          startedAt: null,
          connectionsUsed: null,
          connectionsMax: null,
          tlsFingerprint: null,
          instanceKey: null,
          sizes: null,
        };
      }
      await recordDatabaseHealthSample(tx, {
        tenantId: agent.tenantId,
        connectionId: connection.id,
        instanceKey: connection.instanceKey,
        executorKind: "agent",
        at: new Date(Math.min(at, now.getTime())),
        judgement,
      });
      accepted++;
    }
    return { accepted };
  });
}

// ---------------------------------------------------------------------------
// The history (GET …/connections/:id/health, GET …/:id/health)
// ---------------------------------------------------------------------------

export const healthRangeSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type HealthRange = z.infer<typeof healthRangeSchema>;

const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_RANGE_MS = 400 * DAY_MS;
const POINTS = 200;

function rangeOf(range: HealthRange, now: Date, defaultDays: number): { from: Date; to: Date } {
  const to = range.to ? new Date(range.to) : now;
  const from = range.from ? new Date(range.from) : new Date(to.getTime() - defaultDays * DAY_MS);
  if (!(from < to) || to.getTime() - from.getTime() > MAX_RANGE_MS) {
    throw new ProblemError(422, "Invalid range", {
      detail: "`from` must be before `to`, at most 400 days apart.",
      extensions: { field: "from" },
    });
  }
  return { from, to };
}

export interface HealthPointDto {
  at: string;
  checks: number;
  okChecks: number;
  latencyMs: number | null;
  latencyMaxMs: number | null;
  connectionsUsed: number | null;
  connectionsMax: number | null;
}

export interface ConnectionHealthDto {
  from: string;
  to: string;
  bucketSeconds: number;
  /** Share of good checks (0 to 1), null without a check: 24 hours, 7 and 30 days before now. */
  availability: { day: number | null; week: number | null; month: number | null };
  points: HealthPointDto[];
  events: DbHealthEvent[];
  /** The executor's last word: what a failed check said. */
  lastError: { at: string; code: string | null; message: string | null } | null;
}

async function availability(
  tx: Transaction,
  connectionId: string,
  since: Date,
): Promise<number | null> {
  const [row] = await tx
    .select({
      checks: sql<number>`coalesce(sum(${databaseHealthSamples.checks}), 0)::int`,
      okChecks: sql<number>`coalesce(sum(${databaseHealthSamples.okChecks}), 0)::int`,
    })
    .from(databaseHealthSamples)
    .where(
      and(
        eq(databaseHealthSamples.connectionId, connectionId),
        gte(databaseHealthSamples.at, since),
      ),
    );
  const checks = Number(row?.checks ?? 0);
  return checks > 0 ? Number(row?.okChecks ?? 0) / checks : null;
}

async function ensureConnection(tx: Transaction, tenantId: string, id: string): Promise<void> {
  const [row] = await tx
    .select({ id: databaseConnections.id })
    .from(databaseConnections)
    .where(and(eq(databaseConnections.tenantId, tenantId), eq(databaseConnections.id, id)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Database connection not found");
  }
}

/** The health history of a connection: availability, response time, connections, events (8). */
export async function connectionHealth(
  db: DbExecutor,
  tenantId: string,
  connectionId: string,
  range: HealthRange,
  now: Date = new Date(),
): Promise<ConnectionHealthDto> {
  const { from, to } = rangeOf(range, now, 1);
  return withTenantTx(db, tenantId, async (tx) => {
    await ensureConnection(tx, tenantId, connectionId);
    const span = to.getTime() - from.getTime();
    // At least an hour per point beyond 14 days: older samples are hourly anyway.
    const bucketSeconds = Math.max(
      span > 14 * DAY_MS ? 3600 : 60,
      Math.ceil(span / POINTS / 1000 / 60) * 60,
    );
    const inRange = and(
      eq(databaseHealthSamples.tenantId, tenantId),
      eq(databaseHealthSamples.connectionId, connectionId),
      gte(databaseHealthSamples.at, from),
      lte(databaseHealthSamples.at, to),
    );
    const bucket = sql<string>`to_char(to_timestamp(floor(extract(epoch FROM ${databaseHealthSamples.at}) / ${bucketSeconds}) * ${bucketSeconds}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"')`;
    const points = await tx
      .select({
        at: bucket,
        checks: sql<number>`sum(${databaseHealthSamples.checks})::int`,
        okChecks: sql<number>`sum(${databaseHealthSamples.okChecks})::int`,
        latencyMs: sql<number | null>`round(avg(${databaseHealthSamples.latencyMs}))::int`,
        latencyMaxMs: sql<number | null>`max(${databaseHealthSamples.latencyMaxMs})`,
        connectionsUsed: sql<number | null>`max(${databaseHealthSamples.connectionsUsedMax})`,
        connectionsMax: sql<number | null>`max(${databaseHealthSamples.connectionsMax})`,
      })
      .from(databaseHealthSamples)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const history = await tx
      .select({
        at: databaseHealthSamples.at,
        checks: databaseHealthSamples.checks,
        okChecks: databaseHealthSamples.okChecks,
        errorCode: databaseHealthSamples.errorCode,
        serverVersion: databaseHealthSamples.serverVersion,
        startedAt: databaseHealthSamples.startedAt,
        tlsFingerprint: databaseHealthSamples.tlsFingerprint,
      })
      .from(databaseHealthSamples)
      .where(inRange)
      .orderBy(asc(databaseHealthSamples.at))
      .limit(20_000);
    const [lastError] = await tx
      .select({
        at: databaseHealthSamples.at,
        code: databaseHealthSamples.errorCode,
        message: databaseHealthSamples.errorMessage,
      })
      .from(databaseHealthSamples)
      .where(
        and(
          eq(databaseHealthSamples.connectionId, connectionId),
          isNotNull(databaseHealthSamples.errorCode),
        ),
      )
      .orderBy(desc(databaseHealthSamples.at))
      .limit(1);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucketSeconds,
      availability: {
        day: await availability(tx, connectionId, new Date(now.getTime() - DAY_MS)),
        week: await availability(tx, connectionId, new Date(now.getTime() - 7 * DAY_MS)),
        month: await availability(tx, connectionId, new Date(now.getTime() - 30 * DAY_MS)),
      },
      points: points.map((point) => ({
        at: point.at,
        checks: Number(point.checks),
        okChecks: Number(point.okChecks),
        latencyMs: point.latencyMs === null ? null : Number(point.latencyMs),
        latencyMaxMs: point.latencyMaxMs === null ? null : Number(point.latencyMaxMs),
        connectionsUsed: point.connectionsUsed === null ? null : Number(point.connectionsUsed),
        connectionsMax: point.connectionsMax === null ? null : Number(point.connectionsMax),
      })),
      events: dbHealthEvents(history).reverse(),
      lastError: lastError
        ? { at: lastError.at.toISOString(), code: lastError.code, message: lastError.message }
        : null,
    };
  });
}

export interface DatabaseSizeDto {
  from: string;
  to: string;
  /** The last size read on each day (UTC), oldest first, with the change against the day before. */
  days: { day: string; sizeBytes: number; growthBytes: number | null }[];
}

/** The size of a database day by day (8: "Größe und Wachstum je Tag"). */
export async function databaseSizeHistory(
  db: DbExecutor,
  tenantId: string,
  databaseId: string,
  range: HealthRange,
  now: Date = new Date(),
): Promise<DatabaseSizeDto> {
  const { from, to } = rangeOf(range, now, 30);
  return withTenantTx(db, tenantId, async (tx) => {
    const [database] = await tx
      .select({ id: databases.id, connectionId: databases.connectionId })
      .from(databases)
      .where(and(eq(databases.tenantId, tenantId), eq(databases.id, databaseId)))
      .limit(1);
    if (!database) {
      throw new ProblemError(404, "Database not found");
    }
    const rows = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${databaseHealthSamples.at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        last: max(databaseHealthSamples.at),
        size: sql<
          string | null
        >`(array_agg((${databaseHealthSamples.sizes} ->> ${databaseId})::bigint ORDER BY ${databaseHealthSamples.at} DESC))[1]::text`,
      })
      .from(databaseHealthSamples)
      .where(
        and(
          eq(databaseHealthSamples.tenantId, tenantId),
          eq(databaseHealthSamples.connectionId, database.connectionId),
          gte(databaseHealthSamples.at, from),
          lte(databaseHealthSamples.at, to),
          sql`${databaseHealthSamples.sizes} ? ${databaseId}`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    let previous: number | null = null;
    const days: DatabaseSizeDto["days"] = [];
    for (const row of rows) {
      if (row.size === null) {
        continue;
      }
      const sizeBytes = Number(row.size);
      days.push({
        day: row.day,
        sizeBytes,
        growthBytes: previous === null ? null : sizeBytes - previous,
      });
      previous = sizeBytes;
    }
    return { from: from.toISOString(), to: to.toISOString(), days };
  });
}
