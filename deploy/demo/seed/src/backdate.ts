import { createDb } from "@restow/db";

/**
 * Moving the demo's backup history into the past (deploy/demo/README.md,
 * "History"). Every run of the history step (history.ts) happens for real
 * during the seed — real backups, real snapshots, real verification — and
 * afterwards everything a run wrote is moved back to the simulated day it
 * stands for, so the statistics and readiness charts show weeks of history
 * instead of one point, while every snapshot stays restorable (its manifest
 * and packs exist; only the dates move).
 *
 * Only the tables the statistics read from (apps/api features/stats
 * collect.ts) and their close relatives are touched, and only rows whose
 * timestamp falls inside a run's own window. The append-only audit log is
 * never touched: it keeps the true time of every seed action.
 */

/** One run of the history: when it really happened, and when it should appear to have. */
export interface RunWindow {
  start: Date;
  end: Date;
  target: Date;
}

/** Tables a backup, verify or restore run writes to. */
export const RUN_TABLES = [
  "jobs",
  "job_progress",
  "item_failures",
  "restore_jobs",
  "verify_reports",
  "snapshots",
  "packs",
  "chunks",
] as const;

/** Also moved for the first run: the sources and objects it created. */
export const FIRST_RUN_TABLES = ["sources", "protected_objects"] as const;

/**
 * Which tables a history moves: the ones every run writes, and the ones only
 * its first run writes. The mailbox history moves the backup tables; the
 * history of the simulated machines (endpoint-history.ts) moves the endpoint
 * tables, a machine's own rows (its enrollment included) with the run that
 * made them.
 */
export interface BackdatePlan {
  runTables: readonly string[];
  firstRunTables: readonly string[];
}

export const MAIL_PLAN: BackdatePlan = { runTables: RUN_TABLES, firstRunTables: FIRST_RUN_TABLES };

/** Tables of the endpoint backup (docs/AGENT.md, the data model section) that a backup, its restore tests and its server work write. */
export const ENDPOINT_RUN_TABLES = [
  "endpoints",
  "endpoint_enrollment_tokens",
  "endpoint_runs",
  "endpoint_tasks",
  "endpoint_samples",
  "endpoint_reports",
] as const;

export const ENDPOINT_PLAN: BackdatePlan = { runTables: ENDPOINT_RUN_TABLES, firstRunTables: [] };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: the simulated moment of each run. Run `index` of `count` lands
 * `count - 1 - index` days before `anchor`, give or take up to twenty minutes
 * (a fixed, seeded jitter, so resets look alike), so the newest run sits at
 * the anchor and the first one `count - 1` days before it.
 */
export function simulatedTargets(anchor: Date, count: number, jitterSeed = 7): Date[] {
  let state = jitterSeed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => {
    const daysBack = count - 1 - index;
    const jitter = daysBack === 0 ? 0 : Math.round((next() - 0.5) * 40) * 60_000;
    return new Date(anchor.getTime() - daysBack * DAY_MS + jitter);
  });
}

/**
 * Pure: the order runs are moved in. Oldest first, and each run only ever
 * moves into the past relative to its own window, so a moved row can never
 * land inside a window that is still to be moved.
 */
export function assertMovable(windows: readonly RunWindow[]): void {
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i] as RunWindow;
    if (w.end < w.start) {
      throw new Error(`run ${i}: its window ends before it starts`);
    }
    const later = windows.slice(i + 1);
    const moved = {
      start: w.target.getTime(),
      end: w.target.getTime() + (w.end.getTime() - w.start.getTime()),
    };
    for (const other of later) {
      if (moved.end >= other.start.getTime() && moved.start <= other.end.getTime()) {
        throw new Error(`run ${i} would move into the window of a later run`);
      }
    }
  }
}

type Pool = ReturnType<typeof createDb>["$client"];

async function timestampColumns(
  pool: Pool,
  tables: readonly string[],
): Promise<Map<string, string[]>> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type = 'timestamp with time zone'
       and table_name = any($1::text[])`,
    [tables as unknown as string[]],
  );
  const columns = new Map<string, string[]>();
  for (const row of rows) {
    columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
  }
  return columns;
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** The database's own clock, so run windows and the rows they cover use one time source. */
export async function databaseNow(databaseUrl: string): Promise<Date> {
  const db = createDb(databaseUrl);
  try {
    const { rows } = await db.$client.query<{ now: Date }>("select clock_timestamp() as now");
    return new Date((rows[0] as { now: Date }).now);
  } finally {
    await db.$client.end();
  }
}

/**
 * Move every run to its simulated moment, in one transaction. Connects as
 * the installation role (`DATABASE_PROVIDER_URL`, BYPASSRLS), which may
 * update these tables for every tenant; the tenant role could not.
 */
export async function backdateRuns(
  databaseUrl: string,
  windows: readonly RunWindow[],
  log: (message: string) => void,
  plan: BackdatePlan = MAIL_PLAN,
): Promise<number> {
  assertMovable(windows);
  const db = createDb(databaseUrl);
  const pool = db.$client;
  const client = await pool.connect();
  let moved = 0;
  try {
    const columns = await timestampColumns(pool, [...plan.runTables, ...plan.firstRunTables]);
    await client.query("begin");
    for (const [index, w] of windows.entries()) {
      const deltaMs = w.target.getTime() - w.start.getTime();
      const tables = index === 0 ? [...plan.runTables, ...plan.firstRunTables] : plan.runTables;
      for (const table of tables) {
        for (const column of columns.get(table) ?? []) {
          const result = await client.query(
            `update ${quote(table)} set ${quote(column)} = ${quote(column)} + ($1::bigint * interval '1 millisecond')
             where ${quote(column)} >= $2 and ${quote(column)} <= $3`,
            [deltaMs, w.start, w.end],
          );
          moved += result.rowCount ?? 0;
        }
      }
    }
    await client.query("commit");
    log(`moved ${windows.length} runs into the past (${moved} timestamps)`);
    return moved;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
