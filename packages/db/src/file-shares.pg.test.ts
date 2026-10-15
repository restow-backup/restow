/**
 * The file share tables against a real Postgres, connected as the application role
 * (docs/FILESHARES.md 7): tenant A never sees or writes B's shares, runs, items, restore points,
 * samples, reports, locks, downloads or catalog; the dispatcher's singleton (one starting or
 * running run per share mount) and the one queued backup per share hold under concurrency; a
 * share name is unique per tenant among the shares not retired; deleting a share cascades to its
 * runs, restore points and catalog.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser; skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import type { RoleLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_file_shares_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_fs_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_fs_provider_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};

function urlFor(base: string, database: string, login?: RoleLogin): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login.name;
    url.password = login.password;
  }
  return url.toString();
}

async function inTenant<T>(
  pool: pg.Pool,
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const TABLES = [
  "file_shares",
  "file_share_runs",
  "file_share_run_items",
  "file_share_snapshots",
  "file_share_samples",
  "file_share_reports",
  "file_share_repository_locks",
  "file_share_downloads",
  "file_share_catalog",
];

describe.skipIf(!adminUrl)("file share tables against Postgres", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();
  const userId = randomUUID();

  /** A share with one of every dependent row. */
  async function seed(tenantId: string, name: string): Promise<{ share: string; run: string }> {
    return inTenant(app, tenantId, async (client) => {
      const share = (
        await client.query<{ id: string }>(
          `INSERT INTO file_shares (tenant_id, name, protocol, server, share_name)
           VALUES ($1, $2, 'smb', 'files.example.test', 'data') RETURNING id`,
          [tenantId, name],
        )
      ).rows[0]?.id as string;
      const run = (
        await client.query<{ id: string }>(
          `INSERT INTO file_share_runs (tenant_id, file_share_id, lock_share_id, kind, status)
           VALUES ($1, $2, $2, 'backup', 'succeeded') RETURNING id`,
          [tenantId, share],
        )
      ).rows[0]?.id as string;
      await client.query(
        "INSERT INTO file_share_run_items (tenant_id, run_id, path, code, phase) VALUES ($1, $2, 'a', 'read_error', 'backup')",
        [tenantId, run],
      );
      const snapshot = (
        await client.query<{ id: string }>(
          `INSERT INTO file_share_snapshots (tenant_id, file_share_id, run_id, sequence, restic_snapshot_id, snapshot_time)
           VALUES ($1, $2, $3, 1, $4, now()) RETURNING id`,
          [tenantId, share, run, randomBytes(32).toString("hex")],
        )
      ).rows[0]?.id as string;
      await client.query(
        "INSERT INTO file_share_samples (tenant_id, file_share_id, run_id, snapshot_id, path, sha256, size) VALUES ($1, $2, $3, 'abc', '/share/a', $4, 1)",
        [tenantId, share, run, "0".repeat(64)],
      );
      await client.query(
        "INSERT INTO file_share_reports (tenant_id, file_share_id, kind) VALUES ($1, $2, 'retention')",
        [tenantId, share],
      );
      await client.query(
        "INSERT INTO file_share_repository_locks (tenant_id, file_share_id, name) VALUES ($1, $2, 'lock')",
        [tenantId, share],
      );
      await client.query(
        `INSERT INTO file_share_downloads (tenant_id, file_share_id, snapshot_id, selection, created_by, expires_at)
         VALUES ($1, $2, $3, '[]'::jsonb, $4, now() + interval '10 minutes')`,
        [tenantId, share, snapshot, userId],
      );
      await client.query(
        "INSERT INTO file_share_catalog (tenant_id, file_share_id, path, name, first_seq) VALUES ($1, $2, 'a', 'a', 1)",
        [tenantId, share],
      );
      return { share, run };
    });
  }

  beforeAll(async () => {
    const base = adminUrl as string;
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const ownerUrl = urlFor(base, DATABASE);
    owner = new pg.Pool({ connectionString: ownerUrl });
    await runMigrations(ownerUrl, {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    const provider = (
      await owner.query<{ id: string }>("INSERT INTO providers (name) VALUES ('P') RETURNING id")
    ).rows[0]?.id;
    for (const [id, slug] of [
      [contoso, `contoso-${suffix}`],
      [fabrikam, `fabrikam-${suffix}`],
    ]) {
      await owner.query(
        "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
        [id, provider, slug],
      );
    }
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Admin', 'admin@example.test', true)`,
      [userId],
    );
    app = new pg.Pool({ connectionString: urlFor(base, DATABASE, tenantLogin) });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    await dropTestDatabase(adminUrl as string, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      for (const role of [tenantLogin.name, installationLogin.name]) {
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await admin.end();
    }
  });

  it("keeps every file share table inside its tenant", async () => {
    await seed(contoso, "Contoso data");
    await seed(fabrikam, "Fabrikam data");
    for (const table of TABLES) {
      const own = await inTenant(app, contoso, (client) =>
        client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(own.rows.length, table).toBeGreaterThan(0);
      expect(
        own.rows.every((row) => row.tenant_id === contoso),
        table,
      ).toBe(true);
      const unpinned = await inTenant(app, null, (client) =>
        client.query(`SELECT 1 FROM ${table}`),
      );
      expect(unpinned.rows, table).toEqual([]);
    }
    await expect(
      inTenant(app, contoso, (client) =>
        client.query(
          "INSERT INTO file_shares (tenant_id, name, protocol, server) VALUES ($1, 'x', 'nfs', 'h')",
          [fabrikam],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("allows one starting or running run per share mount and one queued backup per share", async () => {
    const { share } = await seed(contoso, "Singleton");
    const insert = (status: string, kind = "backup") =>
      inTenant(app, contoso, (client) =>
        client.query(
          "INSERT INTO file_share_runs (tenant_id, file_share_id, lock_share_id, kind, status) VALUES ($1, $2, $2, $3, $4)",
          [contoso, share, kind, status],
        ),
      );
    await insert("running");
    await expect(insert("starting", "restore")).rejects.toThrow(/file_share_runs_lock_active_uq/);
    await insert("queued");
    await expect(insert("queued")).rejects.toThrow(/file_share_runs_backup_queued_uq/);
    // A queued restore of the same share is fine: it waits for the mount.
    await insert("queued", "restore");
  });

  it("keeps a name unique per tenant among the shares not retired", async () => {
    await seed(contoso, "Unique");
    await expect(seed(contoso, "unique")).rejects.toThrow(/file_shares_tenant_name_uq/);
    await inTenant(app, contoso, (client) =>
      client.query("UPDATE file_shares SET retired_at = now() WHERE name = 'Unique'"),
    );
    await seed(contoso, "unique");
    // Another tenant has its own names.
    await seed(fabrikam, "Unique");
  });

  it("removes a share's runs, restore points and catalog with it", async () => {
    const { share } = await seed(contoso, "Cascade");
    await inTenant(app, contoso, (client) =>
      client.query("DELETE FROM file_shares WHERE id = $1", [share]),
    );
    for (const table of TABLES.filter((name) => name !== "file_shares")) {
      const column = table === "file_share_run_items" ? null : "file_share_id";
      if (!column) {
        continue;
      }
      const left = await owner.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [share]);
      expect(left.rows, table).toEqual([]);
    }
  });
});
