import {
  itemFailures,
  jobs,
  packs,
  protectedObjects,
  restoreJobs,
  snapshots,
  sources,
  verifyReports,
} from "@restow/db";
import { type SQL, sql } from "drizzle-orm";
import { notImported, notImportedRaw, snapshotNotImportedRaw } from "../../lib/imported-objects.js";
import type { Transaction } from "../../lib/tenant-context.js";
import { MAX_LARGEST_OBJECTS } from "./aggregate.js";
import type { TenantRefDto } from "./dto.js";
import { collectEndpointFacts } from "./endpoint-facts.js";
import type {
  ProtectedObjectKind,
  ProtectedObjectStatus,
  ReadinessRating,
  ReadinessReport,
  ReadinessSnapshot,
  StoredLevels,
  TenantFacts,
} from "./facts.js";
import { collectGuestFacts } from "./guest-facts.js";
import type { ResolvedPeriod } from "./period.js";

/**
 * Reading one tenant's statistics sources inside a tenant-pinned transaction
 * (withTenantTx, so Row Level Security applies; every query also names the
 * tenant). The database does the heavy lifting — grouping by UTC day and
 * status — and hands over small result sets; bucketing happens in
 * aggregate.ts.
 *
 * Sources, as the contract names them:
 *   jobs            backup outcomes, run times, and Graph throttling totals
 *                   (`payload.result.throttleWaitMs` / `throttleWaits` of a
 *                   finished run, else the running totals the worker keeps
 *                   under `payload.runtime.throttle`)
 *   restore_jobs    restores, with the outcome of their job
 *   snapshots       logical bytes (`byte_size`)
 *   packs           physical bytes (`size`)
 *   verify_reports  recovery readiness
 *   item_failures   failed items and their causes
 *
 * A job finished at `completed_at`; a finished job without one (an older
 * worker) counts at its last update.
 *
 * A backup is a completed snapshot: it has a manifest and a completion time.
 * Retention prunes a snapshot by flipping its status, which is its last
 * update, so a snapshot pruned after a moment still existed at it. Object
 * figures (protected data, the largest objects, readiness) leave excluded
 * objects out, like the recovery-readiness page; storage figures (retained
 * and stored bytes, what backups added) keep them, because their data is
 * still stored.
 */

const FINISHED_AT = sql`coalesce(${jobs.completedAt}, ${jobs.updatedAt})`;

/** `YYYY-MM-DD` of a timestamptz expression, in UTC. */
function utcDay(expression: SQL): SQL<string> {
  return sql<string>`to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD')`;
}

/** A numeric member of a jsonb document, or null when it is missing or not a number. */
function jsonNumber(document: SQL, path: readonly string[]): SQL {
  const pathLiteral = `{${path.join(",")}}`;
  return sql`case when jsonb_typeof(${document} #> ${pathLiteral}::text[]) = 'number'
    then (${document} #>> ${pathLiteral}::text[])::float8 end`;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

type Row = Record<string, unknown>;

async function rows(tx: Transaction, query: SQL): Promise<Row[]> {
  const result = await tx.execute(query);
  return result.rows as Row[];
}

/** A completed snapshot (`alias` names the snapshots table in the query). */
function completedBefore(alias: SQL, moment: Date): SQL {
  return sql`${alias}.manifest_path is not null and ${alias}.completed_at < ${moment}`;
}

/** A snapshot that was not pruned yet at `moment`. */
function keptAt(alias: SQL, moment: Date): SQL {
  return sql`(${alias}.status = 'active' or ${alias}.updated_at >= ${moment})`;
}

/**
 * The newest backup of every protected (not excluded) object at `moment`,
 * one row per object: the highest sequence completed before the moment and
 * not pruned at it.
 */
function newestBackupsAt(tenantId: string, moment: Date): SQL {
  const newest = sql.raw("newest");
  return sql`
    select distinct on (newest.protected_object_id)
      newest.protected_object_id as object_id, newest.byte_size, newest.completed_at
    from ${snapshots} as newest
    join ${protectedObjects} as o on o.id = newest.protected_object_id
    where newest.tenant_id = ${tenantId}
      and o.status <> 'excluded'
      and ${notImportedRaw("o.source_id")}
      and ${completedBefore(newest, moment)}
      and ${keptAt(newest, moment)}
    order by newest.protected_object_id, newest.sequence desc`;
}

/** The figures of one moment read from storage. */
async function levelsAt(tx: Transaction, tenantId: string, moment: Date): Promise<StoredLevels> {
  const retained = sql.raw("retained");
  const [row] = await rows(
    tx,
    sql`
      select
        (select coalesce(sum(latest.byte_size), 0)::float8
          from (${newestBackupsAt(tenantId, moment)}) as latest) as logical_bytes,
        (select coalesce(sum(retained.byte_size), 0)::float8 from ${snapshots} as retained
          where retained.tenant_id = ${tenantId}
            and ${completedBefore(retained, moment)}
            and ${keptAt(retained, moment)}) as retained_bytes,
        (select coalesce(sum(${packs.size}), 0)::float8 from ${packs}
          where ${packs.tenantId} = ${tenantId} and ${packs.createdAt} < ${moment}) as physical_bytes`,
  );
  return {
    logicalBytes: toNumber(row?.logical_bytes),
    retainedBytes: toNumber(row?.retained_bytes),
    physicalBytes: toNumber(row?.physical_bytes),
  };
}

/**
 * `columns` of each object's newest backup kept at `moment` (alias `s`),
 * whether or not the object is protected: readiness decides that itself.
 */
function newestKeptAt(tenantId: string, moment: Date, columns: SQL): SQL {
  const s = sql.raw("s");
  return sql`
    select distinct on (s.protected_object_id) ${columns}
    from ${snapshots} as s
    where s.tenant_id = ${tenantId} and ${completedBefore(s, moment)} and ${keptAt(s, moment)}
    order by s.protected_object_id, s.sequence desc`;
}

/**
 * The snapshots readiness is rated on (see TenantFacts.snapshots). Moments
 * are midnights (UTC), so the newest backup of each day stands in for the
 * others of that day. Before the period only the newest backup kept at its
 * start matters: retention never prunes an object's newest backup, so an
 * older one cannot become the newest again.
 */
async function readinessSnapshots(
  tx: Transaction,
  tenantId: string,
  period: ResolvedPeriod,
): Promise<ReadinessSnapshot[]> {
  const { start, end } = period.current;
  const s = sql.raw("s");
  const day = utcDay(sql`s.completed_at`);
  const columns = sql`s.id, s.protected_object_id as object_id, s.sequence, s.completed_at,
    case when s.status = 'pruned' then s.updated_at end as pruned_at`;
  const found = await rows(
    tx,
    sql`
      (${newestKeptAt(tenantId, start, columns)})
      union all
      (select distinct on (s.protected_object_id, ${day}) ${columns}
        from ${snapshots} as s
        where s.tenant_id = ${tenantId}
          and ${completedBefore(s, end)} and s.completed_at >= ${start}
        order by s.protected_object_id, ${day}, s.sequence desc)`,
  );
  return found.map((row) => ({
    id: String(row.id),
    objectId: String(row.object_id),
    sequence: toNumber(row.sequence),
    completedAt: toDate(row.completed_at),
    prunedAt: toNullableDate(row.pruned_at),
  }));
}

/**
 * The reports readiness is rated on (see TenantFacts.reports): every report
 * of the period, and before it the newest check of each object's backup at
 * the start, the newest storage finding and the newest check of each object.
 * `union` drops a report that answers more than one of these.
 */
async function readinessReports(
  tx: Transaction,
  tenantId: string,
  period: ResolvedPeriod,
): Promise<ReadinessReport[]> {
  const { start, end } = period.current;
  const columns = sql`r.id, r.protected_object_id as object_id, r.snapshot_id,
    r.details->>'origin' as origin, r.recovery_readiness::text as readiness,
    r.checked_at, r.created_at`;
  const newestFirst = sql`r.checked_at desc, r.created_at desc`;
  const isFinding = sql`r.details->>'origin' = 'scrub'`;
  const before = sql`r.tenant_id = ${tenantId} and r.checked_at < ${start}`;
  const found = await rows(
    tx,
    sql`
      (select ${columns} from ${verifyReports} as r
        where r.tenant_id = ${tenantId} and r.checked_at >= ${start} and r.checked_at < ${end})
      union
      (select distinct on (r.snapshot_id) ${columns} from ${verifyReports} as r
        where ${before}
          and r.snapshot_id in (${newestKeptAt(tenantId, start, sql`s.id`)})
        order by r.snapshot_id, ${newestFirst})
      union
      (select distinct on (r.protected_object_id) ${columns} from ${verifyReports} as r
        where ${before} and ${isFinding}
        order by r.protected_object_id, ${newestFirst})
      union
      (select distinct on (r.protected_object_id) ${columns} from ${verifyReports} as r
        where ${before} and not coalesce(${isFinding}, false)
        order by r.protected_object_id, ${newestFirst})`,
  );
  return found.map((row) => ({
    id: String(row.id),
    objectId: String(row.object_id),
    snapshotId: toNullableString(row.snapshot_id),
    origin: toNullableString(row.origin),
    readiness: row.readiness as ReadinessRating,
    checkedAt: toDate(row.checked_at),
    createdAt: toDate(row.created_at),
  }));
}

/**
 * Everything the statistics need from one tenant for `period`. Must run in a
 * transaction pinned to `tenant.id`.
 */
export async function collectTenantFacts(
  tx: Transaction,
  tenant: TenantRefDto,
  period: ResolvedPeriod,
): Promise<TenantFacts> {
  const tenantId = tenant.id;
  const { start, end } = period.current;
  const since = period.previous.start;

  const [flags] = await rows(
    tx,
    sql`
      select
        (select count(*)::int from ${protectedObjects}
          where ${protectedObjects.tenantId} = ${tenantId} and ${notImported()}) as objects,
        exists(select 1 from ${sources}
          where ${sources.tenantId} = ${tenantId} and ${sources.kind} = 'm365') as microsoft365,
        exists(select 1 from ${snapshots} as s
          where s.tenant_id = ${tenantId} and ${completedBefore(sql.raw("s"), end)}
            and ${snapshotNotImportedRaw("s.protected_object_id")}) as backups`,
  );

  const backupRuns = await rows(
    tx,
    sql`
      select ${utcDay(FINISHED_AT)} as day, ${jobs.status}::text as status, count(*)::int as count
      from ${jobs}
      where ${jobs.tenantId} = ${tenantId}
        and ${jobs.queue} = 'backup'
        and ${jobs.status} in ('completed', 'failed', 'cancelled')
        and ${FINISHED_AT} >= ${since} and ${FINISHED_AT} < ${end}
      group by 1, 2`,
  );

  const restoreRuns = await rows(
    tx,
    sql`
      select ${utcDay(FINISHED_AT)} as day, ${jobs.status}::text as status, count(*)::int as count
      from ${restoreJobs}
      join ${jobs} on ${jobs.id} = ${restoreJobs.jobId}
      where ${restoreJobs.tenantId} = ${tenantId}
        and ${jobs.status} in ('completed', 'failed')
        and ${FINISHED_AT} >= ${since} and ${FINISHED_AT} < ${end}
      group by 1, 2`,
  );

  const waitMs = sql`coalesce(
    ${jsonNumber(sql`${jobs.payload}`, ["result", "throttleWaitMs"])},
    ${jsonNumber(sql`${jobs.payload}`, ["runtime", "throttle", "totalWaitMs"])}, 0)`;
  const waits = sql`coalesce(
    ${jsonNumber(sql`${jobs.payload}`, ["result", "throttleWaits"])},
    ${jsonNumber(sql`${jobs.payload}`, ["runtime", "throttle", "waits"])}, 0)`;
  const throttling = await rows(
    tx,
    sql`
      select ${utcDay(FINISHED_AT)} as day,
        sum(greatest(${waitMs}, 0))::float8 as wait_ms,
        sum(greatest(${waits}, 0))::float8 as waits
      from ${jobs}
      where ${jobs.tenantId} = ${tenantId}
        and ${jobs.status} in ('completed', 'failed', 'cancelled')
        and ${FINISHED_AT} >= ${since} and ${FINISHED_AT} < ${end}
      group by 1`,
  );

  const snapshotBytes = await rows(
    tx,
    sql`
      select ${utcDay(sql`s.completed_at`)} as day, sum(s.byte_size)::float8 as bytes
      from ${snapshots} as s
      where s.tenant_id = ${tenantId}
        and ${completedBefore(sql.raw("s"), end)} and s.completed_at >= ${start}
      group by 1`,
  );

  const packBytes = await rows(
    tx,
    sql`
      select ${utcDay(sql`${packs.createdAt}`)} as day, sum(${packs.size})::float8 as bytes
      from ${packs}
      where ${packs.tenantId} = ${tenantId}
        and ${packs.createdAt} >= ${start} and ${packs.createdAt} < ${end}
      group by 1`,
  );

  const durations = await rows(
    tx,
    sql`
      select ${jobs.queue}::text as queue,
        extract(epoch from (${jobs.completedAt} - ${jobs.startedAt}))::float8 as seconds
      from ${jobs}
      where ${jobs.tenantId} = ${tenantId}
        and ${jobs.status} = 'completed'
        and ${jobs.startedAt} is not null
        and ${jobs.completedAt} >= ${jobs.startedAt}
        and ${jobs.completedAt} >= ${start} and ${jobs.completedAt} < ${end}`,
  );

  const levelsStart = await levelsAt(tx, tenantId, start);
  const levelsEnd = await levelsAt(tx, tenantId, end);

  const [failed] = await rows(
    tx,
    sql`
      select
        count(*) filter (where ${itemFailures.createdAt} >= ${start})::int as current,
        count(*) filter (where ${itemFailures.createdAt} < ${start})::int as previous
      from ${itemFailures}
      where ${itemFailures.tenantId} = ${tenantId}
        and ${itemFailures.createdAt} >= ${since} and ${itemFailures.createdAt} < ${end}`,
  );

  const reasons = await rows(
    tx,
    sql`
      select ${itemFailures.reason} as reason, count(*)::int as count,
        max(${itemFailures.createdAt}) as last_at
      from ${itemFailures}
      where ${itemFailures.tenantId} = ${tenantId}
        and ${itemFailures.createdAt} >= ${start} and ${itemFailures.createdAt} < ${end}
      group by ${itemFailures.reason}`,
  );

  const objects = await rows(
    tx,
    sql`
      select ${protectedObjects.id} as id,
        coalesce(${protectedObjects.displayName}, ${protectedObjects.externalId}) as name,
        ${protectedObjects.kind}::text as kind,
        ${protectedObjects.status}::text as status,
        ${protectedObjects.createdAt} as created_at
      from ${protectedObjects}
      where ${protectedObjects.tenantId} = ${tenantId} and ${notImported()}`,
  );

  const largest = await rows(
    tx,
    sql`
      select latest.object_id, latest.byte_size::float8 as bytes, latest.completed_at
      from (${newestBackupsAt(tenantId, end)}) as latest
      order by latest.byte_size desc, latest.object_id
      limit ${MAX_LARGEST_OBJECTS}`,
  );

  const ratedSnapshots = await readinessSnapshots(tx, tenantId, period);
  const ratedReports = await readinessReports(tx, tenantId, period);

  return {
    tenant,
    protectedObjectCount: toNumber(flags?.objects),
    hasMicrosoft365: flags?.microsoft365 === true,
    hasBackups: flags?.backups === true,
    backupRuns: backupRuns.map((row) => ({
      day: String(row.day),
      status: row.status as "completed" | "failed" | "cancelled",
      count: toNumber(row.count),
    })),
    restoreRuns: restoreRuns.map((row) => ({
      day: String(row.day),
      status: row.status as "completed" | "failed",
      count: toNumber(row.count),
    })),
    throttling: throttling.map((row) => ({
      day: String(row.day),
      waitMs: toNumber(row.wait_ms),
      waits: toNumber(row.waits),
    })),
    snapshotBytes: snapshotBytes.map((row) => ({
      day: String(row.day),
      bytes: toNumber(row.bytes),
    })),
    packBytes: packBytes.map((row) => ({ day: String(row.day), bytes: toNumber(row.bytes) })),
    durations: durations.map((row) => ({
      queue: String(row.queue),
      seconds: toNumber(row.seconds),
    })),
    levels: { start: levelsStart, end: levelsEnd },
    failedItems: { current: toNumber(failed?.current), previous: toNumber(failed?.previous) },
    failureReasons: reasons.map((row) => ({
      reason: String(row.reason ?? ""),
      count: toNumber(row.count),
      lastAt: toDate(row.last_at),
    })),
    objects: objects.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: row.kind as ProtectedObjectKind,
      status: row.status as ProtectedObjectStatus,
      createdAt: toDate(row.created_at),
    })),
    snapshots: ratedSnapshots,
    reports: ratedReports,
    // Endpoints count in readiness and the backup outcomes only: their
    // repositories are restic repositories outside the chunk store, so the
    // storage, volume, deduplication, restore and largest-object figures above
    // leave them out (endpoint-facts.ts).
    endpoints: await collectEndpointFacts(tx, tenantId, period),
    // So do the VMs and containers of Proxmox VE (guest-facts.ts).
    guests: await collectGuestFacts(tx, tenantId, period),
    largestSnapshots: largest.map((row) => ({
      objectId: String(row.object_id),
      bytes: toNumber(row.bytes),
      completedAt: toDate(row.completed_at),
    })),
  };
}
