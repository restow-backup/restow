/**
 * The mail file import and export tables on the application role
 * (docs/IMPORT.md): Row Level Security between tenants, the upload segment
 * uniqueness that makes a retried chunk idempotent, cascades, and the enum
 * values and column the feature added.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (roles are cluster-wide; the suite creates uniquely named ones and
 * drops them again). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import type { RoleLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_imports_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_imp_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_imp_provider_${suffix}`,
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

async function inTransaction<T>(
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

describe.skipIf(!adminUrl)("mail file import and export tables", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();
  const uploads = { [contoso]: randomUUID(), [fabrikam]: randomUUID() };
  const objects: Record<string, string> = {};
  const sourcesOf: Record<string, string> = {};

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
    const [providerRow] = (
      await owner.query<{ id: string }>(
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
      )
    ).rows;
    for (const [id, slug] of [
      [contoso, `contoso-${suffix}`],
      [fabrikam, `fabrikam-${suffix}`],
    ] as const) {
      await owner.query(
        "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
        [id, providerRow?.id, slug],
      );
      const source = (
        await owner.query<{ id: string }>(
          "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'import', 'Imported mail files', 'active') RETURNING id",
          [id],
        )
      ).rows[0];
      sourcesOf[id] = source?.id as string;
      const object = (
        await owner.query<{ id: string }>(
          "INSERT INTO protected_objects (tenant_id, source_id, kind, origin, external_id, display_name) VALUES ($1, $2, 'imap', 'manual', $3, 'Legacy') RETURNING id",
          [id, sourcesOf[id], `import-${id}`],
        )
      ).rows[0];
      objects[id] = object?.id as string;
      await owner.query(
        `INSERT INTO import_uploads (id, tenant_id, file_name, size, segment_size, segment_count, expires_at)
         VALUES ($1, $2, 'legacy.mbox', 10, 5, 2, now() + interval '1 day')`,
        [uploads[id], id],
      );
      await owner.query(
        `INSERT INTO mail_imports (tenant_id, source_id, protected_object_id, name, files, options)
         VALUES ($1, $2, $3, 'Legacy', '[]'::jsonb, '{"archive":false}'::jsonb)`,
        [id, sourcesOf[id], objects[id]],
      );
      await owner.query(
        `INSERT INTO mail_exports (tenant_id, origin, format, protected_object_id, selection)
         VALUES ($1, 'snapshot', 'eml_zip', $2, '{"all":true}'::jsonb)`,
        [id, objects[id]],
      );
    }
    app = new pg.Pool({ connectionString: urlFor(base, DATABASE, tenantLogin) });
  });

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    if (!adminUrl) {
      return;
    }
    await dropTestDatabase(adminUrl, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      for (const login of [tenantLogin, installationLogin]) {
        await admin.query(`DROP ROLE IF EXISTS ${login.name}`);
      }
    } finally {
      await admin.end();
    }
  });

  const tables = ["import_uploads", "import_upload_segments", "mail_imports", "mail_exports"];

  it("shows nothing without a pinned tenant and only the own rows with one", async () => {
    for (const table of tables) {
      expect(
        await inTransaction(
          app,
          null,
          async (c) => (await c.query(`SELECT 1 FROM ${table}`)).rowCount,
        ),
        `${table} unpinned`,
      ).toBe(0);
    }
    const pinned = await inTransaction(app, contoso, async (c) => ({
      uploads: (await c.query("SELECT tenant_id FROM import_uploads")).rows,
      imports: (await c.query("SELECT tenant_id FROM mail_imports")).rows,
      exports: (await c.query("SELECT tenant_id FROM mail_exports")).rows,
    }));
    for (const rows of Object.values(pinned)) {
      expect(rows).toHaveLength(1);
      expect(rows.every((row) => row.tenant_id === contoso)).toBe(true);
    }
  });

  it("refuses to write a row for another tenant", async () => {
    await expect(
      inTransaction(app, contoso, (c) =>
        c.query(
          `INSERT INTO import_uploads (tenant_id, file_name, size, segment_size, segment_count, expires_at)
           VALUES ($1, 'x', 1, 1, 1, now())`,
          [fabrikam],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inTransaction(app, contoso, (c) =>
        c.query(
          `INSERT INTO mail_exports (tenant_id, origin, format, selection)
           VALUES ($1, 'archive', 'mbox', '{}'::jsonb)`,
          [fabrikam],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // The other tenant's upload cannot be updated or deleted either.
    const changed = await inTransaction(app, contoso, async (c) => {
      const update = await c.query("UPDATE import_uploads SET status = 'cancelled' WHERE id = $1", [
        uploads[fabrikam],
      ]);
      const remove = await c.query("DELETE FROM import_uploads WHERE id = $1", [uploads[fabrikam]]);
      return [update.rowCount, remove.rowCount];
    });
    expect(changed).toEqual([0, 0]);
  });

  it("keeps a segment unique per upload and index, so a retried chunk is an upsert", async () => {
    const upsert = (size: number, sha: string) =>
      inTransaction(app, contoso, (c) =>
        c.query(
          `INSERT INTO import_upload_segments (upload_id, tenant_id, segment_index, size, sha256)
           VALUES ($1, $2, 0, $3, $4)
           ON CONFLICT (upload_id, segment_index) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256`,
          [uploads[contoso], contoso, size, sha],
        ),
      );
    await upsert(5, "a".repeat(64));
    await upsert(5, "b".repeat(64));
    const rows = await inTransaction(
      app,
      contoso,
      async (c) =>
        (
          await c.query("SELECT sha256 FROM import_upload_segments WHERE upload_id = $1", [
            uploads[contoso],
          ])
        ).rows,
    );
    expect(rows).toEqual([{ sha256: "b".repeat(64) }]);
  });

  it("deletes segments with their upload and import records with the imported mailbox, keeping export history", async () => {
    await owner.query("DELETE FROM import_uploads WHERE id = $1", [uploads[contoso]]);
    expect(
      (
        await owner.query("SELECT 1 FROM import_upload_segments WHERE upload_id = $1", [
          uploads[contoso],
        ])
      ).rowCount,
    ).toBe(0);
    await owner.query("DELETE FROM protected_objects WHERE id = $1", [objects[contoso]]);
    expect(
      (await owner.query("SELECT 1 FROM mail_imports WHERE tenant_id = $1", [contoso])).rowCount,
    ).toBe(0);
    const exports = await owner.query(
      "SELECT protected_object_id FROM mail_exports WHERE tenant_id = $1",
      [contoso],
    );
    expect(exports.rows).toEqual([{ protected_object_id: null }]);
  });

  it("knows the values and the column the feature added", async () => {
    const values = async (type: string) =>
      (
        await owner.query<{ enumlabel: string }>(
          "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1",
          [type],
        )
      ).rows.map((row) => row.enumlabel);
    expect(await values("source_kind")).toContain("import");
    expect(await values("job_queue")).toEqual(expect.arrayContaining(["import", "export"]));
    expect(await values("archive_capture")).toContain("file_import");
    expect(await values("export_format")).toEqual(["eml_zip", "mbox", "msg_zip"]);
    const column = await owner.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'archive_items' AND column_name = 'sent_at'",
    );
    expect(column.rows).toEqual([{ data_type: "timestamp with time zone" }]);
  });
});
