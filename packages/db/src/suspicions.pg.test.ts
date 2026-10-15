/**
 * The ransomware judgements of restore points against a real Postgres, connected as the
 * application role (docs/RANSOMWARE.md): tenant A never sees or writes B's judgements, a backup
 * run is judged once per object kind, and the checks keep kinds, verdicts and notes in range.
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
const DATABASE = `restow_db_suspicions_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_rps_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_rps_provider_${suffix}`,
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

describe.skipIf(!adminUrl)("restore point suspicions against Postgres", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();
  const userId = randomUUID();

  function insert(
    tenantId: string,
    values: { runId?: string; kind?: string; verdict?: string; note?: string | null } = {},
  ) {
    return inTenant(app, tenantId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO restore_point_suspicions
           (tenant_id, object_kind, object_id, run_id, restore_point_id, restore_point_at, verdict,
            findings, metrics, signatures_version, false_alarm_note)
         VALUES ($1, $2, $3, $4, 'abc', now(), $5, $6::jsonb, $7::jsonb, '2026.10-1', $8)
         RETURNING id`,
        [
          tenantId,
          values.kind ?? "endpoint",
          randomUUID(),
          values.runId ?? randomUUID(),
          values.verdict ?? "suspicious",
          JSON.stringify([{ code: "ransom_notes", value: 12, threshold: 2 }]),
          JSON.stringify({ itemsChanged: 10, itemsTotal: 100, bytesAdded: 1 }),
          values.note ?? null,
        ],
      ),
    );
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

  it("keeps every judgement inside its tenant", async () => {
    await insert(contoso);
    await insert(fabrikam);
    const own = await inTenant(app, contoso, (client) =>
      client.query<{ tenant_id: string }>("SELECT tenant_id FROM restore_point_suspicions"),
    );
    expect(own.rows.length).toBeGreaterThan(0);
    expect(own.rows.every((row) => row.tenant_id === contoso)).toBe(true);
    const unpinned = await inTenant(app, null, (client) =>
      client.query("SELECT 1 FROM restore_point_suspicions"),
    );
    expect(unpinned.rows).toEqual([]);
    await expect(insertForeign()).rejects.toThrow(/row-level security/);
  });

  async function insertForeign() {
    await inTenant(app, contoso, (client) =>
      client.query(
        `INSERT INTO restore_point_suspicions
           (tenant_id, object_kind, object_id, run_id, restore_point_id, restore_point_at, verdict,
            metrics, signatures_version)
         VALUES ($1, 'endpoint', $2, $3, 'x', now(), 'none', '{}'::jsonb, 'v')`,
        [fabrikam, randomUUID(), randomUUID()],
      ),
    );
  }

  it("judges a backup run once per object kind", async () => {
    const runId = randomUUID();
    await insert(contoso, { runId });
    await expect(insert(contoso, { runId })).rejects.toThrow(/restore_point_suspicions_run_uq/);
    // The same id in another kind's run table is another run.
    await insert(contoso, { runId, kind: "m365" });
  });

  it("refuses unknown kinds and verdicts and an overlong note", async () => {
    await expect(insert(contoso, { kind: "printer" })).rejects.toThrow(
      /restore_point_suspicions_kind_ck/,
    );
    await expect(insert(contoso, { verdict: "maybe" })).rejects.toThrow(
      /restore_point_suspicions_verdict_ck/,
    );
    await expect(insert(contoso, { note: "x".repeat(1001) })).rejects.toThrow(
      /restore_point_suspicions_note_ck/,
    );
  });

  it("keeps the false alarm's label when the account goes", async () => {
    const id = (await insert(contoso)).rows[0]?.id as string;
    await inTenant(app, contoso, (client) =>
      client.query(
        `UPDATE restore_point_suspicions
         SET false_alarm_at = now(), false_alarm_by_user_id = $2, false_alarm_by = 'admin@example.test'
         WHERE id = $1`,
        [id, userId],
      ),
    );
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    const row = (
      await owner.query<{ by: string | null; who: string | null }>(
        "SELECT false_alarm_by_user_id AS by, false_alarm_by AS who FROM restore_point_suspicions WHERE id = $1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ by: null, who: "admin@example.test" });
  });

  it("gives the installation its thresholds column with every default", async () => {
    const { rows } = await owner.query<{ value: unknown }>(
      "SELECT column_default AS value FROM information_schema.columns WHERE table_name = 'settings' AND column_name = 'ransomware_detection'",
    );
    expect(String(rows[0]?.value)).toContain("'{}'::jsonb");
  });
});
