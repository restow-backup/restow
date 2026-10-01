import { endpointReports, endpointRuns, endpoints } from "@restow/db";
import { type SQL, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import type { ResolvedPeriod } from "./period.js";

/**
 * What the statistics read about servers and clients backed up by the agent
 * (docs/AGENT.md), from the tables `endpoints`, `endpoint_runs` and
 * `endpoint_reports`. Same contract as collect.ts: read inside the tenant's
 * pinned transaction, the tenant named in every query, the database groups and
 * thins the rows, the rating itself is pure (endpoint-timeline.ts).
 *
 * Only what the recovery readiness and the backup outcomes need is read.
 * Endpoint repositories live outside the chunk store (restic, under
 * `endpoints/<id>/` of the primary target), so the storage, volume,
 * deduplication, largest-object, restore, throttling and failure-cause figures
 * deliberately stay as they are and leave endpoints out.
 */

/** An endpoint of the tenant, whatever its status. */
export interface EndpointRow {
  readonly id: string;
  readonly createdAt: Date;
  /** When it was revoked; null while it is active. */
  readonly revokedAt: Date | null;
}

/** A good backup run of an endpoint (succeeded or partial, with a snapshot). */
export interface EndpointBackup {
  readonly endpointId: string;
  readonly snapshotId: string;
  /** Some files could not be read: a green test rates it yellow. */
  readonly partial: boolean;
  readonly finishedAt: Date;
}

/** A server-side or agent-side finding about an endpoint's repository. */
export interface EndpointReportRow {
  readonly endpointId: string;
  readonly kind: "restore_test" | "repository_check";
  readonly origin: "server" | "agent";
  /** The snapshot a restore test read back; null for a repository check. */
  readonly snapshotId: string | null;
  readonly readiness: "green" | "yellow" | "red" | null;
  readonly checkedAt: Date;
}

export interface EndpointFacts {
  /** Every endpoint of the tenant, revoked ones included: they were protected before. */
  readonly list: readonly EndpointRow[];
  /**
   * The good backups readiness is rated on at the midnights (UTC) the period
   * is rated at: each endpoint's newest one when the period starts, and its
   * newest one of every day in the period.
   */
  readonly backups: readonly EndpointBackup[];
  /**
   * The restore tests of the backups above and the repository checks that
   * decide at those moments: every report of the period, and before it the
   * tests of each endpoint's newest backup at the start and its newest check.
   */
  readonly reports: readonly EndpointReportRow[];
  /**
   * Finished backup runs per UTC day of `finished_at` over the previous and
   * the current period. A partial run counts as succeeded; a failed run that
   * only says `interrupted` (the agent restarted, docs/AGENT.md) is left out.
   */
  readonly backupRuns: readonly {
    readonly day: string;
    readonly status: "succeeded" | "failed";
    readonly count: number;
  }[];
}

/** A tenant without endpoints. */
export const NO_ENDPOINT_FACTS: EndpointFacts = {
  list: [],
  backups: [],
  reports: [],
  backupRuns: [],
};

type Row = Record<string, unknown>;

async function rows(tx: Transaction, query: SQL): Promise<Row[]> {
  const result = await tx.execute(query);
  return result.rows as Row[];
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `YYYY-MM-DD` of a timestamptz expression, in UTC. */
function dayOf(expression: SQL): SQL<string> {
  return sql<string>`to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD')`;
}

/** A finished backup that produced a snapshot (`alias` names `endpoint_runs` in the query). */
function goodBackup(alias: string, tenantId: string): SQL {
  const r = sql.raw(alias);
  return sql`${r}.tenant_id = ${tenantId} and ${r}.kind = 'backup'
    and ${r}.status in ('succeeded', 'partial') and ${r}.snapshot_id is not null
    and ${r}.finished_at is not null`;
}

/**
 * A run whose errors all say `interrupted`: the same rule as
 * `isInterruptedOnly` (@restow/core), which keeps a restart of the agent out
 * of every failure count. No errors, or one without a code, is not interrupted.
 */
function interruptedOnly(errors: SQL): SQL {
  return sql`case when jsonb_typeof(${errors}) = 'array' and jsonb_array_length(${errors}) > 0
    then not exists (
      select 1 from jsonb_array_elements(${errors}) as e where e->>'code' is distinct from 'interrupted')
    else false end`;
}

/**
 * Everything the statistics need about the tenant's endpoints for `period`.
 * Must run in a transaction pinned to `tenantId`. Four queries.
 */
export async function collectEndpointFacts(
  tx: Transaction,
  tenantId: string,
  period: ResolvedPeriod,
): Promise<EndpointFacts> {
  const { start, end } = period.current;
  const since = period.previous.start;

  const list = await rows(
    tx,
    sql`
      select e.id, e.created_at,
        coalesce(e.revoked_at, case when e.status = 'revoked' then e.updated_at end) as revoked_at
      from ${endpoints} as e
      where e.tenant_id = ${tenantId}`,
  );

  // Moments are midnights (UTC), so the newest backup of each day stands in for
  // the others of that day, and before the period only the newest one matters.
  const backupColumns = sql`r.endpoint_id, r.snapshot_id, (r.status = 'partial') as partial, r.finished_at`;
  const backupDay = dayOf(sql`r.finished_at`);
  const backups = await rows(
    tx,
    sql`
      (select distinct on (r.endpoint_id) ${backupColumns}
        from ${endpointRuns} as r
        where ${goodBackup("r", tenantId)} and r.finished_at < ${start}
        order by r.endpoint_id, r.finished_at desc)
      union all
      (select distinct on (r.endpoint_id, ${backupDay}) ${backupColumns}
        from ${endpointRuns} as r
        where ${goodBackup("r", tenantId)} and r.finished_at >= ${start} and r.finished_at < ${end}
        order by r.endpoint_id, ${backupDay}, r.finished_at desc)`,
  );

  const reportColumns = sql`r.endpoint_id, r.kind::text as kind, r.origin, r.snapshot_id,
    r.readiness::text as readiness, r.checked_at`;
  const reports = await rows(
    tx,
    sql`
      (select ${reportColumns} from ${endpointReports} as r
        where r.tenant_id = ${tenantId} and r.kind in ('restore_test', 'repository_check')
          and r.checked_at >= ${start} and r.checked_at < ${end})
      union
      (select ${reportColumns} from ${endpointReports} as r
        where r.tenant_id = ${tenantId} and r.kind = 'restore_test' and r.checked_at < ${start}
          and (r.endpoint_id, r.snapshot_id) in (
            select distinct on (x.endpoint_id) x.endpoint_id, x.snapshot_id
            from ${endpointRuns} as x
            where ${goodBackup("x", tenantId)} and x.finished_at < ${start}
            order by x.endpoint_id, x.finished_at desc))
      union
      (select distinct on (r.endpoint_id) ${reportColumns} from ${endpointReports} as r
        where r.tenant_id = ${tenantId} and r.kind = 'repository_check' and r.checked_at < ${start}
        order by r.endpoint_id, r.checked_at desc)`,
  );

  const runs = await rows(
    tx,
    sql`
      select ${dayOf(sql`r.finished_at`)} as day,
        case when r.status = 'failed' then 'failed' else 'succeeded' end as status,
        count(*)::int as count
      from ${endpointRuns} as r
      where r.tenant_id = ${tenantId} and r.kind = 'backup'
        and r.status in ('succeeded', 'partial', 'failed')
        and r.finished_at >= ${since} and r.finished_at < ${end}
        and not (r.status = 'failed' and ${interruptedOnly(sql`r.errors`)})
      group by 1, 2`,
  );

  return {
    list: list.map((row) => ({
      id: String(row.id),
      createdAt: toDate(row.created_at),
      revokedAt:
        row.revoked_at === null || row.revoked_at === undefined ? null : toDate(row.revoked_at),
    })),
    backups: backups.map((row) => ({
      endpointId: String(row.endpoint_id),
      snapshotId: String(row.snapshot_id),
      partial: row.partial === true,
      finishedAt: toDate(row.finished_at),
    })),
    reports: reports.map((row) => ({
      endpointId: String(row.endpoint_id),
      kind: row.kind as EndpointReportRow["kind"],
      origin: row.origin === "agent" ? "agent" : "server",
      snapshotId:
        row.snapshot_id === null || row.snapshot_id === undefined ? null : String(row.snapshot_id),
      readiness: (row.readiness ?? null) as EndpointReportRow["readiness"],
      checkedAt: toDate(row.checked_at),
    })),
    backupRuns: runs.map((row) => ({
      day: String(row.day),
      status: row.status === "failed" ? "failed" : "succeeded",
      count: toNumber(row.count),
    })),
  };
}
