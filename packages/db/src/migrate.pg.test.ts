/**
 * The upgrade path of the schema, against a real Postgres:
 *
 *   - a fresh database takes every migration, and a second run applies nothing;
 *   - a 0.300.x database (the migrations, policies and roles of that release,
 *     with data) takes the migrations since, which link each earlier
 *     verification report to the snapshot its details name: only a well-formed
 *     id of a snapshot of the same tenant and protected object counts;
 *   - the Row Level Security flags lifted for that backfill are back afterwards,
 *     and the application roles can use the new tables on the upgraded database;
 *   - the backfill also works when the migrating owner is neither superuser nor
 *     BYPASSRLS, so FORCE ROW LEVEL SECURITY applies to it;
 *   - a second run of the migration step changes nothing;
 *   - a 0.301.4 database (release d042065, the migrations and data of that
 *     release) takes the tenant-customer-data and storage-migration migration
 *     (0006) purely additively: its existing tenants, storage targets and jobs
 *     keep their columns and enum values unchanged, the three new tables exist
 *     and are isolated by Row Level Security, the three new enum values are
 *     usable once the migration has committed, both application roles can use
 *     the new tables, and a second run changes nothing;
 *   - a 0.302.0 database (release d45b3eb, the migrations and data of that
 *     release) takes the per-mailbox IMAP credential migration (0007) purely
 *     additively: an existing protected object keeps its columns unchanged and
 *     the three new columns come back null, the new secret_ref survives a
 *     secret deletion (set null, the object itself untouched), the
 *     credential_status enum is usable once the migration has committed, and a
 *     second run changes nothing.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
 * (it creates databases and roles and drops them again); skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { type RoleLogin, provisionRoles } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

/** The last migration shipped with 0.300.x. */
const LAST_RELEASED_MIGRATION = "0002_consent_proof_setup_lock";

/** The last migration shipped with 0.301.4 (release d042065), just before this iteration's schema changes. */
const LAST_RELEASED_MIGRATION_0301 = "0005_protected_objects_active_since";

/** The last migration shipped with 0.302.0 (release d45b3eb), just before this iteration's schema change. */
const LAST_RELEASED_MIGRATION_0302 = "0006_stale_the_executioner";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const rlsSql = readFileSync(fileURLToPath(new URL("../sql/rls.sql", import.meta.url)), "utf8");

interface JournalEntry {
  idx: number;
  tag: string;
}
interface Journal {
  entries: JournalEntry[];
  [key: string]: unknown;
}

const journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as Journal;

const suffix = randomBytes(4).toString("hex");
const databases = {
  fresh: `restow_db_migrate_fresh_${suffix}`,
  upgrade: `restow_db_migrate_upgrade_${suffix}`,
  upgrade0301: `restow_db_migrate_upgrade0301_${suffix}`,
  upgrade0302: `restow_db_migrate_upgrade0302_${suffix}`,
  restricted: `restow_db_migrate_owner_${suffix}`,
};
const roles: { tenant: RoleLogin; installation: RoleLogin } = {
  tenant: { name: `restow_mig_app_${suffix}`, password: randomBytes(18).toString("base64url") },
  installation: {
    name: `restow_mig_provider_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  },
};
/** An owner that is neither superuser nor BYPASSRLS, as some managed Postgres services hand out. */
const restrictedOwner: RoleLogin = {
  name: `restow_mig_owner_${suffix}`,
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

/** A migrations folder holding only what shipped up to and including `tag`. */
function migrationsFolderUpTo(tag: string): string {
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  if (last < 0) {
    throw new Error(`${tag} is not in the migration journal`);
  }
  const entries = journal.entries.slice(0, last + 1);
  const folder = mkdtempSync(join(tmpdir(), "restow-released-migrations-"));
  mkdirSync(join(folder, "meta"));
  for (const entry of entries) {
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** A migrations folder holding only what 0.300.x shipped. */
function releasedMigrationsFolder(): string {
  return migrationsFolderUpTo(LAST_RELEASED_MIGRATION);
}

/** A migrations folder holding only what 0.301.4 shipped. */
function released0301MigrationsFolder(): string {
  return migrationsFolderUpTo(LAST_RELEASED_MIGRATION_0301);
}

/** A migrations folder holding only what 0.302.0 shipped. */
function released0302MigrationsFolder(): string {
  return migrationsFolderUpTo(LAST_RELEASED_MIGRATION_0302);
}

/** The `public` schema tables that actually exist on `pool`'s database. */
async function existingTableNames(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return new Set(rows.map((row) => row.table_name));
}

/**
 * sql/rls.sql's `tenant_tables` array, restricted to the given table names.
 * The committed file always names every *current* tenant-scoped table, but a
 * database migrated only up to an older release does not have the ones added
 * since — exactly like a real 0.300.x install, whose own rls.sql never
 * mentioned a table `runMigrations` had not created yet. Applying the
 * unfiltered, current file against that older schema would fail on the first
 * missing relation, so the released-schema fixture below runs this filtered
 * version instead; the real upgrade path (`runMigrations`) always applies the
 * unfiltered file, and only after every migration has run.
 */
function rlsSqlForTables(tables: ReadonlySet<string>): string {
  return rlsSql.replace(
    /tenant_tables text\[\] := ARRAY\[([\s\S]*?)\];/,
    (_match, body: string) => {
      const kept = [...(body as string).matchAll(/'([a-z_]+)'/g)]
        .map((m) => m[1])
        .filter((name) => tables.has(name));
      return `tenant_tables text[] := ARRAY[\n    ${kept.map((name) => `'${name}'`).join(",\n    ")}\n  ];`;
    },
  );
}

/** Bring a database to the 0.300.x state: its migrations, then the policies (and roles). */
async function applyReleasedSchema(
  url: string,
  folder: string,
  withRoles: typeof roles | null,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
    await pool.query(rlsSqlForTables(await existingTableNames(pool)));
    if (withRoles) {
      const client = await pool.connect();
      try {
        await provisionRoles(client, withRoles);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

async function appliedMigrations(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ applied: string }>(
    "SELECT count(*) AS applied FROM drizzle.__drizzle_migrations",
  );
  return Number(rows[0]?.applied);
}

/** Run `fn` in a transaction pinned to `tenantId` (required once FORCE RLS applies to the caller). */
async function asTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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

type Queryable = Pick<pg.PoolClient, "query">;

async function insertReturningId(
  client: Queryable,
  text: string,
  values: unknown[],
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(text, values);
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`no id returned by: ${text}`);
  }
  return id;
}

/** A tenant with one source, `objects` protected objects and one snapshot for each. */
async function seedTenant(
  client: Queryable,
  tenantId: string,
  providerId: string,
  slug: string,
  objects: string[],
): Promise<{ objects: string[]; snapshots: string[] }> {
  await client.query("INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)", [
    tenantId,
    providerId,
    slug,
  ]);
  const sourceId = await insertReturningId(
    client,
    "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', $2, 'active') RETURNING id",
    [tenantId, `${slug} M365`],
  );
  const objectIds: string[] = [];
  const snapshotIds: string[] = [];
  for (const externalId of objects) {
    const objectId = await insertReturningId(
      client,
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id)
       VALUES ($1, $2, 'mailbox', $3) RETURNING id`,
      [tenantId, sourceId, externalId],
    );
    objectIds.push(objectId);
    snapshotIds.push(
      await insertReturningId(
        client,
        `INSERT INTO snapshots (tenant_id, protected_object_id, sequence, status)
         VALUES ($1, $2, 1, 'active') RETURNING id`,
        [tenantId, objectId],
      ),
    );
  }
  return { objects: objectIds, snapshots: snapshotIds };
}

async function insertReport(
  client: Queryable,
  tenantId: string,
  objectId: string,
  details: unknown,
): Promise<string> {
  return insertReturningId(
    client,
    `INSERT INTO verify_reports (tenant_id, protected_object_id, recovery_readiness, details)
     VALUES ($1, $2, 'green', $3::jsonb) RETURNING id`,
    [tenantId, objectId, details === null ? null : JSON.stringify(details)],
  );
}

async function linkedSnapshots(pool: pg.Pool): Promise<Map<string, string | null>> {
  const { rows } = await pool.query<{ id: string; snapshot_id: string | null }>(
    "SELECT id, snapshot_id FROM verify_reports",
  );
  return new Map(rows.map((row) => [row.id, row.snapshot_id]));
}

describe.skipIf(!adminUrl)("migrations on a fresh and on a 0.300.x database", () => {
  const base = adminUrl as string;
  let releasedFolder: string;
  let released0301Folder: string;
  let released0302Folder: string;

  beforeAll(async () => {
    releasedFolder = releasedMigrationsFolder();
    released0301Folder = released0301MigrationsFolder();
    released0302Folder = released0302MigrationsFolder();
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE DATABASE ${databases.fresh}`);
      await admin.query(`CREATE DATABASE ${databases.upgrade}`);
      await admin.query(`CREATE DATABASE ${databases.upgrade0301}`);
      await admin.query(`CREATE DATABASE ${databases.upgrade0302}`);
      await admin.query(
        `CREATE ROLE ${restrictedOwner.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${restrictedOwner.password}'`,
      );
      await admin.query(`CREATE DATABASE ${databases.restricted} OWNER ${restrictedOwner.name}`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    if (releasedFolder) {
      rmSync(releasedFolder, { recursive: true, force: true });
    }
    if (released0301Folder) {
      rmSync(released0301Folder, { recursive: true, force: true });
    }
    if (released0302Folder) {
      rmSync(released0302Folder, { recursive: true, force: true });
    }
    for (const database of Object.values(databases)) {
      await dropTestDatabase(base, database);
    }
    const admin = new pg.Pool({ connectionString: base });
    try {
      for (const role of [roles.tenant.name, roles.installation.name, restrictedOwner.name]) {
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await admin.end();
    }
  });

  // Migrating a whole database in the test body takes about a second alone, but
  // on the one Postgres server every workspace's suites share (two workspaces at
  // a time in `pnpm test`, slower CI runners) it can take longer than vitest's
  // 5 s default; hooks get 60 s for the same reason (vitest.config.ts). The
  // other tests that migrate in their body get the same timeout.
  it("applies every migration to an empty database, and nothing on the second run", async () => {
    const url = urlFor(base, databases.fresh);
    await runMigrations(url, { roles });
    const pool = new pg.Pool({ connectionString: url });
    try {
      expect(await appliedMigrations(pool)).toBe(journal.entries.length);
      await runMigrations(url, { roles });
      expect(await appliedMigrations(pool)).toBe(journal.entries.length);
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('service_heartbeats', 'rate_limit')
          ORDER BY table_name`,
      );
      expect(rows.map((row) => row.table_name)).toEqual(["rate_limit", "service_heartbeats"]);
    } finally {
      await pool.end();
    }
  }, 60_000);

  describe("upgrading 0.300.x", () => {
    const contoso = randomUUID();
    const fabrikam = randomUUID();
    const expected = new Map<string, string | null>();
    let owner: pg.Pool;
    let lateReport: string;

    beforeAll(async () => {
      const url = urlFor(base, databases.upgrade);
      await applyReleasedSchema(url, releasedFolder, roles);
      owner = new pg.Pool({ connectionString: url });
      const released = journal.entries.findIndex((e) => e.tag === LAST_RELEASED_MIGRATION) + 1;
      expect(await appliedMigrations(owner)).toBe(released);

      // Data as 0.300.x wrote it (the owner of the test server is a superuser).
      const providerId = await insertReturningId(
        owner,
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
        [],
      );
      const c = await seedTenant(owner, contoso, providerId, `contoso-${suffix}`, [
        "adele@contoso.test",
        "alex@contoso.test",
      ]);
      const f = await seedTenant(owner, fabrikam, providerId, `fabrikam-${suffix}`, [
        "megan@fabrikam.test",
      ]);
      const [adele = "", alex = ""] = c.objects;
      const [adeleSnapshot = "", alexSnapshot = ""] = c.snapshots;
      const [meganMailbox = ""] = f.objects;
      const [meganSnapshot = ""] = f.snapshots;
      const report = async (
        tenant: string,
        object: string,
        details: unknown,
        linked: string | null,
      ) => {
        expected.set(await insertReport(owner, tenant, object, details), linked);
      };

      // Named as `snapshotId`, and as `snapshot.id` (the readiness report format).
      await report(contoso, adele, { snapshotId: adeleSnapshot }, adeleSnapshot);
      await report(
        contoso,
        adele,
        { format: 1, origin: "verify", snapshot: { id: adeleSnapshot, sequence: 1 } },
        adeleSnapshot,
      );
      await report(contoso, adele, { snapshotId: adeleSnapshot.toUpperCase() }, adeleSnapshot);
      // `snapshotId` wins; an unusable one falls back to `snapshot.id`.
      await report(
        contoso,
        adele,
        { snapshotId: "not-a-snapshot", snapshot: { id: adeleSnapshot } },
        adeleSnapshot,
      );
      await report(fabrikam, meganMailbox, { snapshotId: meganSnapshot }, meganSnapshot);
      // Not linked: another object's snapshot, another tenant's, one that does not
      // exist, values that are no uuid, and details without an id.
      await report(contoso, adele, { snapshotId: alexSnapshot }, null);
      await report(contoso, alex, { snapshot: { id: meganSnapshot } }, null);
      await report(contoso, adele, { snapshotId: randomUUID() }, null);
      await report(contoso, adele, { snapshotId: `{${adeleSnapshot}}` }, null);
      await report(contoso, adele, { snapshotId: `${adeleSnapshot}'; DROP TABLE x; --` }, null);
      await report(contoso, adele, { snapshotId: 42 }, null);
      await report(contoso, adele, { snapshot: adeleSnapshot }, null);
      await report(contoso, adele, [adeleSnapshot], null);
      await report(contoso, adele, "scalar details", null);
      await report(contoso, adele, null, null);

      await runMigrations(url, { roles });
    });

    afterAll(async () => {
      await owner?.end();
    });

    it("applies the new migrations", async () => {
      expect(await appliedMigrations(owner)).toBe(journal.entries.length);
    });

    it("links each report to the snapshot its details name, and only a valid one", async () => {
      expect(await linkedSnapshots(owner)).toEqual(expected);
    });

    it("forces Row Level Security on the backfilled tables again", async () => {
      const { rows } = await owner.query<{ relname: string; forced: boolean; enabled: boolean }>(
        `SELECT relname, relforcerowsecurity AS forced, relrowsecurity AS enabled
           FROM pg_class
          WHERE relname IN ('snapshots', 'verify_reports') AND relnamespace = 'public'::regnamespace
          ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: "snapshots", forced: true, enabled: true },
        { relname: "verify_reports", forced: true, enabled: true },
      ]);
    });

    it("lets both application roles use the new tables on the upgraded database", async () => {
      for (const login of [roles.tenant, roles.installation]) {
        const pool = new pg.Pool({ connectionString: urlFor(base, databases.upgrade, login) });
        try {
          const instanceId = `${login.name}-api`;
          await pool.query(
            `INSERT INTO service_heartbeats (role, instance_id, version, hostname, started_at)
             VALUES ('api', $1, '0.301.0', 'restow-api', now())`,
            [instanceId],
          );
          await pool.query("UPDATE service_heartbeats SET beat_at = now() WHERE instance_id = $1", [
            instanceId,
          ]);
          await pool.query(
            "INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, $3)",
            [randomUUID(), `${login.name}|/sign-in/email`, Date.now()],
          );
          const beats = await pool.query(
            "SELECT 1 FROM service_heartbeats WHERE instance_id = $1",
            [instanceId],
          );
          expect(beats.rowCount, login.name).toBe(1);
        } finally {
          await pool.end();
        }
      }
    });

    it("changes nothing on a second run", async () => {
      // A report written after the upgrade is the verify handler's to link, not the migration's.
      const [object] = (
        await owner.query<{ id: string; snapshot: string }>(
          `SELECT o.id, s.id AS snapshot FROM protected_objects o
             JOIN snapshots s ON s.protected_object_id = o.id
            WHERE o.tenant_id = $1 LIMIT 1`,
          [fabrikam],
        )
      ).rows;
      lateReport = await insertReport(owner, fabrikam, object?.id ?? "", {
        snapshotId: object?.snapshot,
      });

      await runMigrations(urlFor(base, databases.upgrade), { roles });

      expect(await appliedMigrations(owner)).toBe(journal.entries.length);
      const after = await linkedSnapshots(owner);
      expect(after.get(lateReport)).toBeNull();
      after.delete(lateReport);
      expect(after).toEqual(expected);
    });
  });

  describe("upgrading 0.301.4", () => {
    const tenantId = randomUUID();
    let owner: pg.Pool;
    let primaryTargetId: string;
    let copyTargetId: string;
    let backupJobId: string;

    beforeAll(async () => {
      const url = urlFor(base, databases.upgrade0301);
      await applyReleasedSchema(url, released0301Folder, roles);
      owner = new pg.Pool({ connectionString: url });
      const released = journal.entries.findIndex((e) => e.tag === LAST_RELEASED_MIGRATION_0301) + 1;
      expect(await appliedMigrations(owner)).toBe(released);

      // Data exactly as 0.301.4 wrote it: a tenant with a primary and a copy
      // storage target, and a completed backup job.
      const providerId = await insertReturningId(
        owner,
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
        [],
      );
      await owner.query(
        "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
        [tenantId, providerId, `northwind-${suffix}`],
      );
      primaryTargetId = await insertReturningId(
        owner,
        `INSERT INTO storage_targets (tenant_id, kind, role, config)
         VALUES ($1, 'local', 'primary', $2::jsonb) RETURNING id`,
        [tenantId, JSON.stringify({ basePath: "/data/primary" })],
      );
      copyTargetId = await insertReturningId(
        owner,
        `INSERT INTO storage_targets (tenant_id, kind, role, config)
         VALUES ($1, 's3', 'copy', $2::jsonb) RETURNING id`,
        [tenantId, JSON.stringify({ bucket: "restow-copy" })],
      );
      backupJobId = await insertReturningId(
        owner,
        "INSERT INTO jobs (tenant_id, queue, status) VALUES ($1, 'backup', 'completed') RETURNING id",
        [tenantId],
      );

      await runMigrations(url, { roles });
    });

    afterAll(async () => {
      await owner?.end();
    });

    it("applies the new migration", async () => {
      expect(await appliedMigrations(owner)).toBe(journal.entries.length);
    });

    it("keeps the existing tenant, storage targets and job unchanged", async () => {
      const target = await owner.query<{ kind: string; role: string }>(
        "SELECT kind, role FROM storage_targets WHERE id = $1",
        [primaryTargetId],
      );
      expect(target.rows).toEqual([{ kind: "local", role: "primary" }]);
      const copy = await owner.query<{ kind: string; role: string }>(
        "SELECT kind, role FROM storage_targets WHERE id = $1",
        [copyTargetId],
      );
      expect(copy.rows).toEqual([{ kind: "s3", role: "copy" }]);
      const job = await owner.query<{ queue: string }>("SELECT queue FROM jobs WHERE id = $1", [
        backupJobId,
      ]);
      expect(job.rows).toEqual([{ queue: "backup" }]);
      const tenant = await owner.query<{
        customer_number: string | null;
        language: string | null;
      }>("SELECT customer_number, language FROM tenants WHERE id = $1", [tenantId]);
      expect(tenant.rows).toEqual([{ customer_number: null, language: null }]);
    });

    it("adds the new tables and lets the new enum values be used", async () => {
      const tables = await existingTableNames(owner);
      expect(tables.has("tenant_contacts")).toBe(true);
      expect(tables.has("tenant_notification_recipients")).toBe(true);
      expect(tables.has("storage_migrations")).toBe(true);

      // The enum values added by ALTER TYPE ... ADD VALUE are usable once the
      // migration that added them has committed (this query runs outside it).
      const installationDefaultTarget = await insertReturningId(
        owner,
        `INSERT INTO storage_targets (tenant_id, kind, role, config)
         VALUES ($1, 'installation_default', 'previous', '{}'::jsonb) RETURNING id`,
        [tenantId],
      );
      const migrationJobId = await insertReturningId(
        owner,
        "INSERT INTO jobs (tenant_id, queue, status) VALUES ($1, 'storage_migration', 'queued') RETURNING id",
        [tenantId],
      );
      const migrationId = await insertReturningId(
        owner,
        `INSERT INTO storage_migrations (tenant_id, source_target_id, destination_target_id, mode, job_id)
         VALUES ($1, $2, $3, 'move', $4) RETURNING id`,
        [tenantId, installationDefaultTarget, primaryTargetId, migrationJobId],
      );
      expect(migrationId).toBeTruthy();
    });

    it("forces Row Level Security on the new tenant tables", async () => {
      const { rows } = await owner.query<{ relname: string; forced: boolean; enabled: boolean }>(
        `SELECT relname, relforcerowsecurity AS forced, relrowsecurity AS enabled
           FROM pg_class
          WHERE relname IN ('tenant_contacts', 'tenant_notification_recipients', 'storage_migrations')
            AND relnamespace = 'public'::regnamespace
          ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: "storage_migrations", forced: true, enabled: true },
        { relname: "tenant_contacts", forced: true, enabled: true },
        { relname: "tenant_notification_recipients", forced: true, enabled: true },
      ]);
    });

    it("lets both application roles use the new tables on the upgraded database", async () => {
      for (const login of [roles.tenant, roles.installation]) {
        const pool = new pg.Pool({ connectionString: urlFor(base, databases.upgrade0301, login) });
        try {
          const contactId = await asTenant(pool, tenantId, (client) =>
            insertReturningId(
              client,
              "INSERT INTO tenant_contacts (tenant_id, name) VALUES ($1, $2) RETURNING id",
              [tenantId, `Contact (${login.name})`],
            ),
          );
          expect(contactId, login.name).toBeTruthy();
        } finally {
          await pool.end();
        }
      }
    });

    it("changes nothing on a second run", async () => {
      const before = await owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM storage_targets WHERE tenant_id = $1",
        [tenantId],
      );

      await runMigrations(urlFor(base, databases.upgrade0301), { roles });

      expect(await appliedMigrations(owner)).toBe(journal.entries.length);
      const after = await owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM storage_targets WHERE tenant_id = $1",
        [tenantId],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });
  });

  describe("upgrading 0.302.0", () => {
    const tenantId = randomUUID();
    let owner: pg.Pool;
    let sourceId: string;
    let objectWithCredentialId: string;
    let objectWithoutCredentialId: string;
    let secretId: string;

    beforeAll(async () => {
      const url = urlFor(base, databases.upgrade0302);
      await applyReleasedSchema(url, released0302Folder, roles);
      owner = new pg.Pool({ connectionString: url });
      const released = journal.entries.findIndex((e) => e.tag === LAST_RELEASED_MIGRATION_0302) + 1;
      expect(await appliedMigrations(owner)).toBe(released);

      // Data exactly as 0.302.0 wrote it: a tenant, one IMAP source and two
      // protected objects, one of which already carries a sealed secret on
      // sources.secret_ref (the pre-0.303 shared-credential shape).
      const providerId = await insertReturningId(
        owner,
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
        [],
      );
      await owner.query(
        "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
        [tenantId, providerId, `wingtip-${suffix}`],
      );
      secretId = await insertReturningId(
        owner,
        `INSERT INTO secrets (tenant_id, kind, ciphertext) VALUES ($1, 'imap_password', 'sealed-fixture')
         RETURNING id`,
        [tenantId],
      );
      sourceId = await insertReturningId(
        owner,
        `INSERT INTO sources (tenant_id, kind, name, status, secret_ref)
         VALUES ($1, 'imap', $2, 'active', $3) RETURNING id`,
        [tenantId, `wingtip-${suffix} IMAP`, secretId],
      );
      objectWithCredentialId = await insertReturningId(
        owner,
        `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, display_name)
         VALUES ($1, $2, 'imap', 'adele@wingtip.test', 'Adele Vance') RETURNING id`,
        [tenantId, sourceId],
      );
      objectWithoutCredentialId = await insertReturningId(
        owner,
        `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id)
         VALUES ($1, $2, 'imap', 'alex@wingtip.test') RETURNING id`,
        [tenantId, sourceId],
      );

      await runMigrations(url, { roles });
    });

    afterAll(async () => {
      await owner?.end();
    });

    it("applies the new migration", async () => {
      expect(await appliedMigrations(owner)).toBe(journal.entries.length);
    });

    it("keeps the existing protected objects unchanged and adds the new columns as null", async () => {
      const { rows } = await owner.query<{
        id: string;
        display_name: string | null;
        secret_ref: string | null;
        credential_status: string | null;
        credential_checked_at: string | null;
        credential_error: string | null;
      }>(
        `SELECT id, display_name, secret_ref, credential_status, credential_checked_at, credential_error
           FROM protected_objects WHERE tenant_id = $1 ORDER BY external_id`,
        [tenantId],
      );
      expect(rows).toEqual([
        {
          id: objectWithCredentialId,
          display_name: "Adele Vance",
          secret_ref: null,
          credential_status: null,
          credential_checked_at: null,
          credential_error: null,
        },
        {
          id: objectWithoutCredentialId,
          display_name: null,
          secret_ref: null,
          credential_status: null,
          credential_checked_at: null,
          credential_error: null,
        },
      ]);
      // The source's own shared secret (the pre-0.303 auth path) is untouched.
      const source = await owner.query<{ secret_ref: string }>(
        "SELECT secret_ref FROM sources WHERE id = $1",
        [sourceId],
      );
      expect(source.rows).toEqual([{ secret_ref: secretId }]);
    });

    it("lets the new credential_status enum be used, and deleting the secret sets secret_ref null", async () => {
      // The enum value added by this migration is usable once it has committed
      // (this query runs outside the migration transaction).
      const perMailboxSecretId = await insertReturningId(
        owner,
        `INSERT INTO secrets (tenant_id, kind, ciphertext) VALUES ($1, 'imap_password', 'sealed-per-mailbox')
         RETURNING id`,
        [tenantId],
      );
      await owner.query(
        `UPDATE protected_objects
            SET secret_ref = $1, credential_status = 'untested'
          WHERE id = $2`,
        [perMailboxSecretId, objectWithCredentialId],
      );
      const before = await owner.query<{ secret_ref: string | null; credential_status: string }>(
        "SELECT secret_ref, credential_status FROM protected_objects WHERE id = $1",
        [objectWithCredentialId],
      );
      expect(before.rows).toEqual([
        { secret_ref: perMailboxSecretId, credential_status: "untested" },
      ]);

      await owner.query("DELETE FROM secrets WHERE id = $1", [perMailboxSecretId]);

      const after = await owner.query<{
        id: string;
        secret_ref: string | null;
        credential_status: string;
      }>("SELECT id, secret_ref, credential_status FROM protected_objects WHERE id = $1", [
        objectWithCredentialId,
      ]);
      // The reference is cleared; the object and its (now stale) status survive.
      expect(after.rows).toEqual([
        { id: objectWithCredentialId, secret_ref: null, credential_status: "untested" },
      ]);
    });

    it("lets both application roles read and set the new columns on the upgraded database", async () => {
      for (const login of [roles.tenant, roles.installation]) {
        const pool = new pg.Pool({ connectionString: urlFor(base, databases.upgrade0302, login) });
        try {
          const read = await asTenant(pool, tenantId, (client) =>
            client.query<{
              id: string;
              secret_ref: string | null;
              credential_status: string | null;
            }>(
              "SELECT id, secret_ref, credential_status FROM protected_objects WHERE tenant_id = $1",
              [tenantId],
            ),
          );
          expect(read.rowCount, login.name).toBe(2);

          const updated = await asTenant(pool, tenantId, (client) =>
            client.query<{ credential_status: string }>(
              `UPDATE protected_objects SET credential_status = 'failed'
                WHERE id = $1 RETURNING credential_status`,
              [objectWithoutCredentialId],
            ),
          );
          expect(updated.rows, login.name).toEqual([{ credential_status: "failed" }]);
        } finally {
          await pool.end();
        }
      }
    });

    it("changes nothing on a second run", async () => {
      const before = await owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM protected_objects WHERE tenant_id = $1",
        [tenantId],
      );

      await runMigrations(urlFor(base, databases.upgrade0302), { roles });

      expect(await appliedMigrations(owner)).toBe(journal.entries.length);
      const after = await owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM protected_objects WHERE tenant_id = $1",
        [tenantId],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });
  });

  it("backfills for an owner that Row Level Security binds", async () => {
    const url = urlFor(base, databases.restricted, restrictedOwner);
    await applyReleasedSchema(url, releasedFolder, null);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const tenantId = randomUUID();
      // FORCE ROW LEVEL SECURITY applies to this owner: it writes pinned to the tenant.
      const { report, snapshot } = await asTenant(pool, tenantId, async (client) => {
        const providerId = await insertReturningId(
          client,
          "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
          [],
        );
        const seeded = await seedTenant(client, tenantId, providerId, `northwind-${suffix}`, [
          "nestor@northwind.test",
        ]);
        const [objectId = ""] = seeded.objects;
        const [snapshotId = ""] = seeded.snapshots;
        return {
          snapshot: snapshotId,
          report: await insertReport(client, tenantId, objectId, { snapshotId }),
        };
      });
      // Unpinned, the owner sees nothing: the backfill cannot rely on seeing rows.
      expect((await pool.query("SELECT 1 FROM verify_reports")).rowCount).toBe(0);

      await runMigrations(url);

      const linked = await asTenant(pool, tenantId, (client) =>
        client.query<{ snapshot_id: string | null }>(
          "SELECT snapshot_id FROM verify_reports WHERE id = $1",
          [report],
        ),
      );
      expect(linked.rows).toEqual([{ snapshot_id: snapshot }]);
      // And the flag is back: unpinned, the owner still sees nothing.
      expect((await pool.query("SELECT 1 FROM verify_reports")).rowCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe.skipIf(!adminUrl)("recipient flags become report rules (0010)", () => {
  const base = adminUrl as string;
  const database = `restow_db_migrate_flags_${suffix}`;
  const flagOwner: RoleLogin = {
    name: `restow_mig_flags_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  let folder = "";

  beforeAll(async () => {
    folder = migrationsFolderUpTo("0009_keen_siren");
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(
        `CREATE ROLE ${flagOwner.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${flagOwner.password}'`,
      );
      await admin.query(`CREATE DATABASE ${database} OWNER ${flagOwner.name}`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    await dropTestDatabase(base, database);
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${flagOwner.name}`);
    } finally {
      await admin.end();
    }
  });

  it("turns each flag into one rule per tenant, even for an owner bound by RLS", async () => {
    const url = urlFor(base, database, flagOwner);
    await applyReleasedSchema(url, folder, null);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const providerId = await insertReturningId(
        pool,
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
        [],
      );
      const german = randomUUID();
      const english = randomUUID();
      const silent = randomUUID();
      for (const [id, slug, language, zone] of [
        [german, "kanzlei", "de", "Europe/Berlin"],
        [english, "acme", "en", null],
        [silent, "quiet", null, null],
      ] as const) {
        await asTenant(pool, id, (client) =>
          client.query(
            "INSERT INTO tenants (id, provider_id, name, slug, language, time_zone) VALUES ($1, $2, $3, $3, $4, $5)",
            [id, providerId, slug, language, zone],
          ),
        );
      }
      const recipient = (tenant: string, email: string, flags: [boolean, boolean, boolean]) =>
        asTenant(pool, tenant, (client) =>
          client.query(
            `INSERT INTO tenant_notification_recipients
               (tenant_id, email, notify_job_failures, notify_weekly_report, notify_readiness_red)
             VALUES ($1, $2, $3, $4, $5)`,
            [tenant, email, ...flags],
          ),
        );
      await recipient(german, "it@kanzlei.test", [true, true, true]);
      await recipient(german, "chef@kanzlei.test", [true, false, false]);
      await recipient(english, "ops@acme.test", [false, true, false]);
      await recipient(silent, "nobody@quiet.test", [false, false, false]);

      await runMigrations(url);

      const rulesOf = (tenant: string) =>
        asTenant(pool, tenant, (client) =>
          client
            .query<{
              name: string;
              trigger: string;
              events: string[];
              cron: string | null;
              timezone: string;
              email_recipients: string[];
            }>(
              "SELECT name, trigger, events, cron, timezone, email_recipients FROM report_rules ORDER BY name",
            )
            .then((result) => result.rows),
        );
      expect(await rulesOf(german)).toEqual([
        {
          name: "Fehlgeschlagene Aufträge",
          trigger: "event",
          events: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
          cron: null,
          timezone: "UTC",
          email_recipients: ["it@kanzlei.test", "chef@kanzlei.test"],
        },
        {
          name: "Wiederherstellbarkeit gefährdet",
          trigger: "event",
          events: ["verify.red", "scrub.corrupt"],
          cron: null,
          timezone: "UTC",
          email_recipients: ["it@kanzlei.test"],
        },
        {
          name: "Wochenbericht",
          trigger: "schedule",
          events: [],
          cron: "0 7 * * 1",
          timezone: "Europe/Berlin",
          email_recipients: ["it@kanzlei.test"],
        },
      ]);
      expect(await rulesOf(english)).toEqual([
        {
          name: "Weekly report",
          trigger: "schedule",
          events: [],
          cron: "0 7 * * 1",
          timezone: "UTC",
          email_recipients: ["ops@acme.test"],
        },
      ]);
      expect(await rulesOf(silent)).toEqual([]);

      // The force is back on both source tables: unpinned, the owner sees nothing.
      expect((await pool.query("SELECT 1 FROM tenant_notification_recipients")).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM tenants")).rowCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe.skipIf(!adminUrl)("upgrading 0.1.0: endpoint repository guards (0019)", () => {
  const base = adminUrl as string;
  const database = `restow_db_migrate_endpoints_${suffix}`;
  const owner: RoleLogin = {
    name: `restow_mig_endpoints_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  let folder = "";

  beforeAll(async () => {
    folder = migrationsFolderUpTo("0018_giant_silver_sable");
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(
        `CREATE ROLE ${owner.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${owner.password}'`,
      );
      await admin.query(`CREATE DATABASE ${database} OWNER ${owner.name}`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    await dropTestDatabase(base, database);
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${owner.name}`);
    } finally {
      await admin.end();
    }
  });

  it("adds the tables and columns, and brings stored snapshot ids to lower case, for an owner bound by RLS", async () => {
    const url = urlFor(base, database, owner);
    await applyReleasedSchema(url, folder, null);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const providerId = await insertReturningId(
        pool,
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
        [],
      );
      const tenantId = randomUUID();
      const endpointId = randomUUID();
      const upper = "ABCDEF01".repeat(8);
      const lower = upper.toLowerCase();
      const tasks = await asTenant(pool, tenantId, async (client) => {
        await client.query(
          "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, 'Contoso', $3)",
          [tenantId, providerId, `contoso-${suffix}`],
        );
        await client.query(
          `INSERT INTO endpoints (id, tenant_id, hostname, os, arch, profile, secret_hash, config, last_snapshot_id)
           VALUES ($1, $2, 'srv-01', 'linux', 'amd64', 'server', 'x', '{}'::jsonb, $3)`,
          [endpointId, tenantId, upper],
        );
        await client.query(
          `INSERT INTO endpoint_runs (tenant_id, endpoint_id, kind, status, started_at, snapshot_id)
           VALUES ($1, $2, 'backup', 'succeeded', now(), $3)`,
          [tenantId, endpointId, upper],
        );
        const task = (status: string) =>
          insertReturningId(
            client,
            `INSERT INTO endpoint_tasks (tenant_id, endpoint_id, kind, params, status)
             VALUES ($1, $2, 'restore', $3::jsonb, $4) RETURNING id`,
            [tenantId, endpointId, JSON.stringify({ snapshotId: upper, paths: ["/etc"] }), status],
          );
        return { pending: await task("pending"), done: await task("done") };
      });
      // Unpinned, the owner sees nothing: the update cannot rely on seeing rows.
      expect((await pool.query("SELECT 1 FROM endpoints")).rowCount).toBe(0);

      await runMigrations(url);

      const after = await asTenant(pool, tenantId, async (client) => ({
        endpoint: (
          await client.query(
            "SELECT last_snapshot_id, repository_bytes, maintenance_locked_count FROM endpoints WHERE id = $1",
            [endpointId],
          )
        ).rows[0],
        run: (await client.query("SELECT snapshot_id FROM endpoint_runs")).rows[0],
        pending: (
          await client.query(
            "SELECT params->>'snapshotId' AS id FROM endpoint_tasks WHERE id = $1",
            [tasks.pending],
          )
        ).rows[0],
        done: (
          await client.query(
            "SELECT params->>'snapshotId' AS id FROM endpoint_tasks WHERE id = $1",
            [tasks.done],
          )
        ).rows[0],
        lock: await insertReturningId(
          client,
          "INSERT INTO endpoint_repository_locks (tenant_id, endpoint_id, name) VALUES ($1, $2, $3) RETURNING id",
          [tenantId, endpointId, "a".repeat(64)],
        ),
        flag: await insertReturningId(
          client,
          `INSERT INTO endpoint_snapshot_flags (tenant_id, endpoint_id, snapshot_id, reasons)
           VALUES ($1, $2, $3, '["unrecorded"]'::jsonb) RETURNING id`,
          [tenantId, endpointId, lower],
        ),
      }));
      expect(after.endpoint).toEqual({
        last_snapshot_id: lower,
        repository_bytes: null,
        maintenance_locked_count: 0,
      });
      expect(after.run).toEqual({ snapshot_id: lower });
      expect(after.pending).toEqual({ id: lower });
      // A finished task is history and stays as it was.
      expect(after.done).toEqual({ id: upper });
      expect(after.lock).toBeTruthy();
      expect(after.flag).toBeTruthy();
      // The flags are back, and the new tables are isolated as well: unpinned, nothing is seen.
      for (const table of [
        "endpoints",
        "endpoint_runs",
        "endpoint_tasks",
        "endpoint_repository_locks",
        "endpoint_snapshot_flags",
      ]) {
        expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount, table).toBe(0);
      }
    } finally {
      await pool.end();
    }
  }, 120_000);
});

describe.skipIf(!adminUrl)("upgrading 0.1.0: tenant kind and the own organisation (0020)", () => {
  const base = adminUrl as string;
  const database = `restow_db_migrate_tenant_kind_${suffix}`;
  const owner: RoleLogin = {
    name: `restow_mig_kind_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  const tenantIds = [randomUUID(), randomUUID()];
  let folder = "";
  let providerId = "";

  beforeAll(async () => {
    folder = migrationsFolderUpTo("0019_endpoint_repository_guards");
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(
        `CREATE ROLE ${owner.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${owner.password}'`,
      );
      await admin.query(`CREATE DATABASE ${database} OWNER ${owner.name}`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    await dropTestDatabase(base, database);
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${owner.name}`);
    } finally {
      await admin.end();
    }
  });

  const kindOf = (pool: pg.Pool, tenantId: string) =>
    asTenant(pool, tenantId, async (client) => {
      const { rows } = await client.query<{ kind: string }>(
        "SELECT kind FROM tenants WHERE id = $1",
        [tenantId],
      );
      return rows[0]?.kind;
    });

  const setKind = (pool: pg.Pool, tenantId: string, kind: "customer" | "internal") =>
    asTenant(pool, tenantId, (client) =>
      client.query("UPDATE tenants SET kind = $2 WHERE id = $1", [tenantId, kind]),
    );

  it("makes every existing tenant a customer, never guessing which one is the operator's own", async () => {
    const url = urlFor(base, database, owner);
    await applyReleasedSchema(url, folder, null);
    const pool = new pg.Pool({ connectionString: url });
    try {
      providerId = await insertReturningId(
        pool,
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
        [],
      );
      for (const [index, tenantId] of tenantIds.entries()) {
        await asTenant(pool, tenantId, (client) =>
          client.query(
            "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
            [tenantId, providerId, `tenant-${index}-${suffix}`],
          ),
        );
      }

      await runMigrations(url);

      for (const tenantId of tenantIds) {
        expect(await kindOf(pool, tenantId)).toBe("customer");
      }
      // The column is NOT NULL with the customer default, and the enum knows exactly two kinds.
      const { rows: column } = await pool.query<{
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'tenants' AND column_name = 'kind'`,
      );
      expect(column[0]?.is_nullable).toBe("NO");
      expect(column[0]?.column_default).toContain("customer");
      const { rows: values } = await pool.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'tenant_kind' ORDER BY e.enumsortorder`,
      );
      expect(values.map((row) => row.enumlabel)).toEqual(["customer", "internal"]);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("allows one internal tenant per provider, refuses a second one even across Row Level Security, and takes the mark back", async () => {
    const pool = new pg.Pool({ connectionString: urlFor(base, database, owner) });
    try {
      const [first, second] = tenantIds as [string, string];
      await setKind(pool, first, "internal");
      expect(await kindOf(pool, first)).toBe("internal");

      // The second tenant is invisible to the first one's session, yet the unique index still sees it.
      await expect(setKind(pool, second, "internal")).rejects.toMatchObject({
        code: "23505",
        constraint: "tenants_internal_uq",
      });
      expect(await kindOf(pool, second)).toBe("customer");

      // A new tenant starts as a customer without naming a kind, and customers do not compete.
      const created = randomUUID();
      await asTenant(pool, created, (client) =>
        client.query("INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)", [
          created,
          providerId,
          `created-${suffix}`,
        ]),
      );
      expect(await kindOf(pool, created)).toBe("customer");

      // Taking the mark back frees the place for the other tenant.
      await setKind(pool, first, "customer");
      await setKind(pool, second, "internal");
      expect(await kindOf(pool, second)).toBe("internal");
      await expect(setKind(pool, first, "internal")).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("changes nothing on a second run of the migration step", async () => {
    const url = urlFor(base, database, owner);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const before = await appliedMigrations(pool);
      await runMigrations(url);
      expect(await appliedMigrations(pool)).toBe(before);
      expect(await kindOf(pool, tenantIds[1] as string)).toBe("internal");
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe.skipIf(!adminUrl)(
  "upgrading to the tenant page: agent update pause and recipient rules (0021)",
  () => {
    const base = adminUrl as string;
    const database = `restow_db_migrate_tenant_page_${suffix}`;
    const owner: RoleLogin = {
      name: `restow_mig_page_${suffix}`,
      password: randomBytes(18).toString("base64url"),
    };
    const ids = {
      empty: randomUUID(),
      allPaused: randomUUID(),
      somePaused: randomUUID(),
      unset: randomUUID(),
      onePaused: randomUUID(),
    };
    let folder = "";

    beforeAll(async () => {
      folder = migrationsFolderUpTo("0020_tenant_kind");
      const admin = new pg.Pool({ connectionString: base });
      try {
        await admin.query(
          `CREATE ROLE ${owner.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${owner.password}'`,
        );
        await admin.query(`CREATE DATABASE ${database} OWNER ${owner.name}`);
      } finally {
        await admin.end();
      }
    });

    afterAll(async () => {
      if (folder) rmSync(folder, { recursive: true, force: true });
      await dropTestDatabase(base, database);
      const admin = new pg.Pool({ connectionString: base });
      try {
        await admin.query(`DROP ROLE IF EXISTS ${owner.name}`);
      } finally {
        await admin.end();
      }
    });

    const addMachine = (pool: pg.Pool, tenantId: string, settings: Record<string, unknown>) =>
      asTenant(pool, tenantId, (client) =>
        client.query(
          `INSERT INTO endpoints (tenant_id, hostname, os, arch, profile, secret_hash, config, settings)
         VALUES ($1, $2, 'linux', 'amd64', 'server', 'hash', '{}'::jsonb, $3::jsonb)`,
          [tenantId, `host-${randomBytes(3).toString("hex")}`, JSON.stringify(settings)],
        ),
      );

    const pausedOf = (pool: pg.Pool, tenantId: string) =>
      asTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query<{ paused: boolean }>(
          "SELECT agent_updates_paused AS paused FROM tenants WHERE id = $1",
          [tenantId],
        );
        return rows[0]?.paused;
      });

    it("turns a pause that every machine of a tenant carried into the tenant's own setting, and nothing else", async () => {
      const url = urlFor(base, database, owner);
      await applyReleasedSchema(url, folder, null);
      const pool = new pg.Pool({ connectionString: url });
      try {
        const providerId = await insertReturningId(
          pool,
          "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
          [],
        );
        for (const [name, tenantId] of Object.entries(ids)) {
          await asTenant(pool, tenantId, (client) =>
            client.query(
              "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
              [tenantId, providerId, `${name}-${suffix}`],
            ),
          );
        }
        await addMachine(pool, ids.allPaused, { autoUpdatePaused: true });
        await addMachine(pool, ids.allPaused, { autoUpdatePaused: true });
        await addMachine(pool, ids.somePaused, { autoUpdatePaused: true });
        await addMachine(pool, ids.somePaused, { autoUpdatePaused: false });
        await addMachine(pool, ids.unset, {});
        await addMachine(pool, ids.onePaused, { autoUpdatePaused: true });

        await runMigrations(url);

        // Updates were on for the new column everywhere it was not the tenant-wide switch.
        expect(await pausedOf(pool, ids.empty)).toBe(false);
        expect(await pausedOf(pool, ids.allPaused)).toBe(true);
        expect(await pausedOf(pool, ids.somePaused)).toBe(false);
        expect(await pausedOf(pool, ids.unset)).toBe(false);
        expect(await pausedOf(pool, ids.onePaused)).toBe(true);

        // The flags on the machines stay; they are the machines' own pauses from now on.
        const flags = await asTenant(pool, ids.allPaused, async (client) => {
          const { rows } = await client.query<{ paused: string | null }>(
            "SELECT settings ->> 'autoUpdatePaused' AS paused FROM endpoints WHERE tenant_id = $1",
            [ids.allPaused],
          );
          return rows.map((row) => row.paused);
        });
        expect(flags).toEqual(["true", "true"]);

        // Row Level Security is forced on both tables again, even for their owner.
        const { rows } = await pool.query<{ relname: string; force: boolean }>(
          `SELECT relname, relforcerowsecurity AS force FROM pg_class
         WHERE relname IN ('tenants', 'endpoints') AND relkind = 'r' ORDER BY relname`,
        );
        expect(rows).toEqual([
          { relname: "endpoints", force: true },
          { relname: "tenants", force: true },
        ]);
      } finally {
        await pool.end();
      }
    }, 120_000);

    it("adds the recipient category as null and keeps it unique per tenant when set", async () => {
      const pool = new pg.Pool({ connectionString: urlFor(base, database, owner) });
      try {
        const tenantId = ids.empty;
        const addRule = (name: string, category: string | null) =>
          asTenant(pool, tenantId, (client) =>
            client.query(
              `INSERT INTO report_rules (tenant_id, name, trigger, events, recipient_category)
             VALUES ($1, $2, 'event', ARRAY['backup.failed'], $3)`,
              [tenantId, name, category],
            ),
          );
        // Rules without a category (made by hand, or by an earlier release) do not compete.
        await addRule("by hand one", null);
        await addRule("by hand two", null);
        await addRule("failed jobs", "jobFailures");
        await expect(addRule("failed jobs again", "jobFailures")).rejects.toMatchObject({
          code: "23505",
          constraint: "report_rules_recipient_category_uq",
        });
        await addRule("readiness", "readinessRed");
        const { rows } = await asTenant(pool, tenantId, (client) =>
          client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM report_rules WHERE tenant_id = $1",
            [tenantId],
          ),
        );
        expect(rows[0]?.n).toBe("4");
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("changes nothing on a second run of the migration step", async () => {
      const url = urlFor(base, database, owner);
      const pool = new pg.Pool({ connectionString: url });
      try {
        const before = await appliedMigrations(pool);
        await runMigrations(url);
        expect(await appliedMigrations(pool)).toBe(before);
        expect(await pausedOf(pool, ids.allPaused)).toBe(true);
        expect(await pausedOf(pool, ids.somePaused)).toBe(false);
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);

describe.skipIf(!adminUrl)(
  "upgrading to the Start checklist: the notification mail marked as not needed (0022)",
  () => {
    const base = adminUrl as string;
    const database = `restow_db_migrate_mail_not_needed_${suffix}`;
    const owner: RoleLogin = {
      name: `restow_mig_mailmark_${suffix}`,
      password: randomBytes(18).toString("base64url"),
    };
    let folder = "";

    beforeAll(async () => {
      folder = migrationsFolderUpTo("0021_tenant_page_settings");
      const admin = new pg.Pool({ connectionString: base });
      try {
        await admin.query(
          `CREATE ROLE ${owner.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${owner.password}'`,
        );
        await admin.query(`CREATE DATABASE ${database} OWNER ${owner.name}`);
      } finally {
        await admin.end();
      }
    });

    afterAll(async () => {
      if (folder) rmSync(folder, { recursive: true, force: true });
      await dropTestDatabase(base, database);
      const admin = new pg.Pool({ connectionString: base });
      try {
        await admin.query(`DROP ROLE IF EXISTS ${owner.name}`);
      } finally {
        await admin.end();
      }
    });

    const settingsRow = async (pool: pg.Pool) => {
      const { rows } = await pool.query<{
        mail_not_needed: boolean;
        mail_transport: string | null;
        public_url: string | null;
      }>("SELECT mail_not_needed, mail_transport, public_url FROM settings");
      return rows;
    };

    it("adds the mark as off for an installation that skipped the mail step, and keeps everything else", async () => {
      const url = urlFor(base, database, owner);
      await applyReleasedSchema(url, folder, null);
      const pool = new pg.Pool({ connectionString: url });
      try {
        // An installation of the previous release, set up with the mail step skipped.
        await pool.query(
          `INSERT INTO settings (singleton, operating_mode, public_url, setup_completed_at)
           VALUES (true, 'public', 'https://restow.example.test', now())`,
        );
        await runMigrations(url);

        expect(await settingsRow(pool)).toEqual([
          {
            mail_not_needed: false,
            mail_transport: null,
            public_url: "https://restow.example.test",
          },
        ]);
        // The column is not nullable and defaults to off: a new installation starts without the mark.
        const { rows } = await pool.query<{ nullable: string; fallback: string }>(
          `SELECT is_nullable AS nullable, column_default AS fallback
           FROM information_schema.columns
           WHERE table_name = 'settings' AND column_name = 'mail_not_needed'`,
        );
        expect(rows).toEqual([{ nullable: "NO", fallback: "false" }]);
      } finally {
        await pool.end();
      }
    }, 120_000);

    it("changes nothing on a second run of the migration step", async () => {
      const url = urlFor(base, database, owner);
      const pool = new pg.Pool({ connectionString: url });
      try {
        await pool.query("UPDATE settings SET mail_not_needed = true");
        const before = await appliedMigrations(pool);
        await runMigrations(url);
        expect(await appliedMigrations(pool)).toBe(before);
        // A mark set after the upgrade survives a restart.
        expect((await settingsRow(pool))[0]?.mail_not_needed).toBe(true);
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);
