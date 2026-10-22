/**
 * The time shift of a restored demo template (deploy/demo/seed/sql/shift-time.sql,
 * deploy/demo/README.md "Fast reset") against a real Postgres with the full Restow
 * schema: what moves, what stays, what goes, and that a refused run changes nothing.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
 * (the script runs as the database owner, the demo's bootstrap superuser); skipped
 * otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENDPOINT_RUN_TABLES, FIRST_RUN_TABLES, RUN_TABLES } from "./backdate.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const DATABASE = `restow_demo_shift_test_${randomBytes(4).toString("hex")}`;
const SCRIPT = readFileSync(new URL("../sql/shift-time.sql", import.meta.url), "utf8");

type Pool = ReturnType<typeof createDb>["$client"];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const AGE_DAYS = 3;

/** Tables with times the script deliberately leaves alone (shift-time.sql, header). */
const UNTOUCHED_TABLES = ["audit_anchor", "audit_log", "license", "session", "verification"];
/** Columns of moved tables that belong to the backed-up data or to restic. */
const UNTOUCHED_COLUMNS = [
  "endpoint_snapshot_flags.snapshot_time",
  "file_share_catalog.mtime",
  "file_share_snapshots.snapshot_time",
  "item_failures.item_date",
  "manifest_objects.mtime",
  "manifest_versions.mtime",
  "pve_snapshots.backup_at",
];

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

interface ShiftRun {
  notices: string[];
  plan: Map<string, string[]>;
}

/** Run the script on its own connection, the template taken at `epoch` (or with no setting). */
async function runShift(pool: Pool, epoch: string | null): Promise<ShiftRun> {
  const client = await pool.connect();
  const notices: string[] = [];
  client.on("notice", (notice) => notices.push(notice.message ?? ""));
  try {
    if (epoch !== null) {
      await client.query("select set_config('restow_demo.template_epoch', $1, false)", [epoch]);
    }
    try {
      await client.query(SCRIPT);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    const { rows } = await client.query<{ table_name: string; columns: string[] }>(
      "select * from pg_temp.restow_demo_shift_plan()",
    );
    return { notices, plan: new Map(rows.map((row) => [row.table_name, row.columns])) };
  } finally {
    client.release();
  }
}

async function timeColumns(pool: Pool): Promise<Map<string, string[]>> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and data_type in ('timestamp with time zone', 'timestamp without time zone')
        and table_name in (select table_name from information_schema.tables
                            where table_schema = 'public' and table_type = 'BASE TABLE')
      order by table_name, ordinal_position`,
  );
  const columns = new Map<string, string[]>();
  for (const row of rows) {
    columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
  }
  return columns;
}

describe.skipIf(!adminUrl)("demo template time shift against Postgres", () => {
  let pool: Pool;
  const tenant = randomUUID();
  const job = randomUUID();
  const endpoint = randomUUID();
  const userId = randomUUID();
  // The seed's moments, relative to when the template was taken.
  let taken: Date;
  const at = (offsetMs: number) => new Date(taken.getTime() + offsetMs);

  async function epochNow(): Promise<number> {
    const { rows } = await pool.query<{ epoch: string }>(
      "select extract(epoch from clock_timestamp())::text as epoch",
    );
    return Number(rows[0]?.epoch);
  }

  async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await pool.query(sql, params);
    return rows[0] as T;
  }

  beforeAll(async () => {
    const base = adminUrl as string;
    const admin = createDb(base).$client;
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const url = urlFor(base, DATABASE);
    await runMigrations(url);
    pool = createDb(url).$client;
    taken = new Date((await epochNow()) * 1000 - AGE_DAYS * DAY);

    const provider = await one<{ id: string }>(
      "insert into providers (name, created_at) values ('Demo', $1) returning id",
      [at(-2 * HOUR)],
    );
    await pool.query(
      "insert into tenants (id, provider_id, name, slug, created_at) values ($1, $2, 'Example Trading Ltd', 'example', $3)",
      [tenant, provider.id, at(-2 * HOUR)],
    );
    // The newest backup of the history, 12 minutes before the template was taken.
    await pool.query(
      `insert into jobs (id, tenant_id, queue, status, created_at, started_at, completed_at)
       values ($1, $2, 'backup', 'completed', $3, $3, $4)`,
      [job, tenant, at(-13 * 60_000), at(-12 * 60_000)],
    );
    // A mail of the backup dated years ago: a fact of the data, not of the system.
    await pool.query(
      `insert into item_failures (tenant_id, job_id, item_ref, reason, item_date, created_at)
       values ($1, $2, 'INBOX/1', 'too large', '2019-05-01T09:00:00Z', $3)`,
      [tenant, job, at(-12 * 60_000)],
    );
    await pool.query(
      `insert into endpoints (id, tenant_id, hostname, os, arch, profile, secret_hash, config,
                              last_seen_at, next_run_at, created_at)
       values ($1, $2, 'fileserver-01', 'linux', 'amd64', 'server', 'x', '{}'::jsonb, $3, $4, $5)`,
      [endpoint, tenant, at(-60_000), at(20 * HOUR), at(-30 * DAY)],
    );
    // restic's own time of a snapshot, which lives in the repository.
    await pool.query(
      `insert into endpoint_snapshot_flags (tenant_id, endpoint_id, snapshot_id, reasons, snapshot_time, created_at)
       values ($1, $2, 'abcdef01', '["unrecorded"]'::jsonb, $3, $4)`,
      [tenant, endpoint, at(-DAY), at(-5 * 60_000)],
    );
    await pool.query(
      "insert into audit_log (actor, action, chain_hash, created_at) values ('seed', 'tenant.create', 'h', $1)",
      [at(-HOUR)],
    );
    // better-auth's tables use timestamp without time zone.
    await pool.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Demo Administrator', 'demo@example.org', true, $2::timestamptz at time zone 'UTC', $2::timestamptz at time zone 'UTC')`,
      [userId, at(-2 * HOUR)],
    );
    await pool.query(
      `insert into session (id, expires_at, token, created_at, updated_at, user_id)
       values ('s1', $1::timestamptz at time zone 'UTC', 't1', now(), now(), $2)`,
      [at(7 * DAY), userId],
    );
    await pool.query(
      `insert into verification (id, identifier, value, expires_at)
       values ('v1', 'demo@example.org', 'code', $1::timestamptz at time zone 'UTC')`,
      [at(HOUR)],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = createDb(adminUrl as string).$client;
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("refuses to run without the template's moment, and changes nothing", async () => {
    await expect(runShift(pool, null)).rejects.toThrow(/template_epoch is not set/);
    await expect(runShift(pool, "yesterday")).rejects.toThrow(/template_epoch is not set/);
    const row = await one<{ completed_at: Date }>("select completed_at from jobs where id = $1", [
      job,
    ]);
    expect(row.completed_at).toEqual(at(-12 * 60_000));
  });

  it("refuses a template from the future, and changes nothing", async () => {
    const future = ((await epochNow()) + 2 * 3600).toFixed(3);
    await expect(runShift(pool, future)).rejects.toThrow(/refusing to move the demo back/);
    const count = await one<{ n: number }>("select count(*)::int as n from session");
    expect(count.n).toBe(1);
  });

  describe("after a shift of a template taken three days ago", () => {
    let run: ShiftRun;
    let shiftedAt: number;

    beforeAll(async () => {
      run = await runShift(pool, (taken.getTime() / 1000).toFixed(6));
      shiftedAt = (await epochNow()) * 1000;
    });

    /** `value` moved by the template's age: it now sits where it sat relative to the template. */
    function expectMoved(value: Date, before: Date) {
      const moved = value.getTime() - before.getTime();
      expect(Math.abs(moved - AGE_DAYS * DAY)).toBeLessThan(60_000);
    }

    it("shows the newest backup as recent as it was when the template was taken", async () => {
      const row = await one<{ started_at: Date; completed_at: Date; created_at: Date }>(
        "select started_at, completed_at, created_at from jobs where id = $1",
        [job],
      );
      expectMoved(row.completed_at, at(-12 * 60_000));
      expectMoved(row.started_at, at(-13 * 60_000));
      const age = shiftedAt - row.completed_at.getTime();
      expect(age).toBeGreaterThan(11 * 60_000);
      expect(age).toBeLessThan(14 * 60_000);
    });

    it("moves the tenants, the machines and their times ahead with everything else", async () => {
      const tenantRow = await one<{ created_at: Date }>(
        "select created_at from tenants where id = $1",
        [tenant],
      );
      expectMoved(tenantRow.created_at, at(-2 * HOUR));
      const machine = await one<{ last_seen_at: Date; next_run_at: Date; created_at: Date }>(
        "select last_seen_at, next_run_at, created_at from endpoints where id = $1",
        [endpoint],
      );
      expectMoved(machine.last_seen_at, at(-60_000));
      expectMoved(machine.created_at, at(-30 * DAY));
      // A time ahead keeps its distance: the next run is still about 20 hours away.
      expectMoved(machine.next_run_at, at(20 * HOUR));
      expect(machine.next_run_at.getTime() - shiftedAt).toBeGreaterThan(19 * HOUR);
    });

    it("moves timestamp columns without a time zone too", async () => {
      const row = await one<{ created_at: Date }>(
        `select created_at at time zone 'UTC' as created_at from "user" where id = $1`,
        [userId],
      );
      expectMoved(row.created_at, at(-2 * HOUR));
    });

    it("keeps the audit log, the dates of the data and restic's snapshot times", async () => {
      const audit = await one<{ created_at: Date }>(
        "select created_at from audit_log where actor = 'seed'",
      );
      expect(audit.created_at).toEqual(at(-HOUR));
      const failure = await one<{ item_date: Date; created_at: Date }>(
        "select item_date, created_at from item_failures where job_id = $1",
        [job],
      );
      expect(failure.item_date).toEqual(new Date("2019-05-01T09:00:00Z"));
      expectMoved(failure.created_at, at(-12 * 60_000));
      const flag = await one<{ snapshot_time: Date; created_at: Date }>(
        "select snapshot_time, created_at from endpoint_snapshot_flags where endpoint_id = $1",
        [endpoint],
      );
      expect(flag.snapshot_time).toEqual(at(-DAY));
      expectMoved(flag.created_at, at(-5 * 60_000));
    });

    it("removes the seed's sign-ins and codes instead of moving them", async () => {
      const counts = await one<{ sessions: number; codes: number; users: number }>(
        `select (select count(*)::int from session) as sessions,
                (select count(*)::int from verification) as codes,
                (select count(*)::int from "user") as users`,
      );
      expect(counts).toEqual({ sessions: 0, codes: 0, users: 1 });
    });

    it("says what it moved", () => {
      expect(run.notices.some((n) => n.startsWith("restow-demo shift: jobs (1 rows)"))).toBe(true);
      expect(run.notices.at(-1)).toMatch(
        /^restow-demo shift: moved \d+ rows of \d+ tables forward by 3 days .*removed 2 sign-ins and codes$/,
      );
    });

    it("moves every table and time the seed's backdate step moves", async () => {
      const columns = await timeColumns(pool);
      for (const table of [...RUN_TABLES, ...FIRST_RUN_TABLES, ...ENDPOINT_RUN_TABLES]) {
        const all = columns.get(table);
        expect(all, table).toBeDefined();
        const expected = (all as string[]).filter(
          (column) => !UNTOUCHED_COLUMNS.includes(`${table}.${column}`),
        );
        expect(run.plan.get(table), table).toEqual(expected);
      }
    });

    it("leaves only the documented tables and columns alone", async () => {
      const columns = await timeColumns(pool);
      const leftTables: string[] = [];
      const leftColumns: string[] = [];
      for (const [table, all] of columns) {
        const moved = run.plan.get(table);
        if (!moved) {
          leftTables.push(table);
          continue;
        }
        for (const column of all) {
          if (!moved.includes(column)) {
            leftColumns.push(`${table}.${column}`);
          }
        }
      }
      expect(leftTables.filter((table) => !table.startsWith("archive_")).sort()).toEqual(
        UNTOUCHED_TABLES,
      );
      // The archive (append-only, hash chain) is left whole.
      expect(leftTables.filter((table) => table.startsWith("archive_")).length).toBeGreaterThan(0);
      expect([...run.plan.keys()].filter((table) => table.startsWith("archive_"))).toEqual([]);
      expect(leftColumns.sort()).toEqual(UNTOUCHED_COLUMNS);
    });
  });
});
