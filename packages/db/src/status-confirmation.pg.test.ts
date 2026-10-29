/**
 * Migration 0069 against Postgres: the upgrade backfill (objects orphaned before 0.4.7 count as
 * confirmed, so no long amber list appears after an update) and the trigger that keeps the
 * confirmation lifecycle (fresh on every transition into `orphaned` except from `excluded`, which
 * counts as confirmed, gone on the way out).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; uses its own scratch database,
 * since an edit to 0069 never re-runs on a database that already applied it.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const DATABASE = `restow_db_status_confirmation_${randomBytes(4).toString("hex")}`;
const BEFORE_0069 = "0068_app_secret_alerts";

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A migrations folder holding only what shipped up to and including `tag`. */
function migrationsFolderUpTo(tag: string): string {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((item) => item.tag === tag);
  if (last < 0) {
    throw new Error(`${tag} is not in the migration journal`);
  }
  const entries = journal.entries.slice(0, last + 1);
  const folder = mkdtempSync(join(tmpdir(), "restow-0068-migrations-"));
  mkdirSync(join(folder, "meta"));
  for (const item of entries) {
    copyFileSync(join(migrationsFolder, `${item.tag}.sql`), join(folder, `${item.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

describe.skipIf(!adminUrl)("migration 0069: inactive objects and their confirmation", () => {
  let folder: string;
  let pool: pg.Pool;
  let sourceId: string;
  let tenantId: string;

  const row = async (externalId: string) =>
    (
      await pool.query<{
        status: string;
        status_reason: string | null;
        inactive_since: Date | null;
        inactive_notified_at: Date | null;
        status_confirmed_at: Date | null;
        status_confirmed_by: string | null;
      }>(
        `SELECT status, status_reason, inactive_since, inactive_notified_at, status_confirmed_at,
                status_confirmed_by
           FROM protected_objects WHERE external_id = $1`,
        [externalId],
      )
    ).rows[0];

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    folder = migrationsFolderUpTo(BEFORE_0069);
    pool = new pg.Pool({ connectionString: urlFor(adminUrl as string, DATABASE) });
    await migrate(drizzle(pool), { migrationsFolder: folder });
    // 0.4.6 data: one object removed from the source long ago, one active.
    const provider = await pool.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('P') RETURNING id",
    );
    const tenant = await pool.query<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'T', 't-0069') RETURNING id",
      [provider.rows[0]?.id],
    );
    tenantId = tenant.rows[0]?.id as string;
    const source = await pool.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', 'M365', 'active') RETURNING id",
      [tenantId],
    );
    sourceId = source.rows[0]?.id as string;
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, external_id, updated_at)
       VALUES ($1, $2, 'mailbox', 'orphaned', 'gone', '2026-05-01T00:00:00Z'),
              ($1, $2, 'onedrive', 'active', 'drive', now())`,
      [tenantId, sourceId],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, DATABASE);
    }
  });

  it("counts objects orphaned before the upgrade as confirmed and notified", async () => {
    const gone = await row("gone");
    expect(gone).toMatchObject({ status: "orphaned", status_confirmed_by: "migration" });
    expect(gone?.status_confirmed_at).toBeInstanceOf(Date);
    expect(gone?.inactive_notified_at).toBeInstanceOf(Date);
    expect(gone?.inactive_since?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(await row("drive")).toMatchObject({
      status: "active",
      inactive_since: null,
      status_confirmed_at: null,
    });
  });

  it("starts a fresh, unconfirmed state on a transition and clears all of it on the way out", async () => {
    await pool.query(
      "UPDATE protected_objects SET status = 'orphaned', status_reason = 'locked' WHERE external_id = 'drive'",
    );
    const locked = await row("drive");
    expect(locked).toMatchObject({ status_reason: "locked", status_confirmed_at: null });
    expect(locked?.inactive_since).toBeInstanceOf(Date);

    await pool.query(
      "UPDATE protected_objects SET status_confirmed_at = now(), status_confirmed_by = 'a@b.example', inactive_notified_at = now() WHERE external_id = 'drive'",
    );
    expect((await row("drive"))?.status_confirmed_by).toBe("a@b.example");

    await pool.query("UPDATE protected_objects SET status = 'active' WHERE external_id = 'drive'");
    expect(await row("drive")).toMatchObject({
      status_reason: null,
      inactive_since: null,
      inactive_notified_at: null,
      status_confirmed_at: null,
      status_confirmed_by: null,
    });

    // A confirmation written together with the transition is dropped: a new transition asks.
    await pool.query(
      "UPDATE protected_objects SET status = 'orphaned', status_confirmed_at = now(), status_confirmed_by = 'x' WHERE external_id = 'drive'",
    );
    expect((await row("drive"))?.status_confirmed_at).toBeNull();
  });

  it("counts an excluded object that turns orphaned as confirmed and notified", async () => {
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, external_id)
       VALUES ($1, $2, 'site', 'excluded', 'never-protected')`,
      [tenantId, sourceId],
    );
    await pool.query(
      "UPDATE protected_objects SET status = 'orphaned' WHERE external_id = 'never-protected'",
    );
    const gone = await row("never-protected");
    expect(gone).toMatchObject({ status: "orphaned", status_confirmed_by: "excluded" });
    expect(gone?.status_confirmed_at).toBeInstanceOf(Date);
    expect(gone?.inactive_notified_at).toBeInstanceOf(Date);
    expect(gone?.inactive_since).toBeInstanceOf(Date);
  });

  it("checks the reason and that a confirmation names its author", async () => {
    await expect(
      pool.query(
        "UPDATE protected_objects SET status_reason = 'stolen' WHERE external_id = 'gone'",
      ),
    ).rejects.toThrow(/protected_objects_status_reason_ck/);
    await expect(
      pool.query(
        "UPDATE protected_objects SET status_confirmed_by = NULL WHERE external_id = 'gone'",
      ),
    ).rejects.toThrow(/protected_objects_status_confirmed_ck/);
  });
});
