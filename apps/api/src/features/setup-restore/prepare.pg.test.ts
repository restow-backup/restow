/**
 * Preparing a restored dump (prepare.ts) against Postgres: the dump of an installation is
 * restored into a scratch database (with pg_dump and pg_restore --no-owner --no-acl when they are
 * installed, else as a copy of the database), then
 *
 *   - with the right master key: migrated, restore mode on with source `setup`, every key and
 *     secret opens, the storage compared, the audit entry written, a report that is ok;
 *   - with another master key: refused as `master_key_mismatch`, with restore mode already on in
 *     the scratch database (it is switched on before the key check), and once the scratch database
 *     is dropped the installation it came from is unchanged;
 *   - a database without Restow's migrations, one newer than this release and one without a
 *     completed setup are refused before anything is checked.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveInstallationSecretsKey,
  EnvKeyProvider,
  generateDek,
  kekFromBase64,
  sealSecret,
} from "@restow/core";
import { createDb, type Database } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const suffix = randomBytes(3).toString("hex");
const SOURCE = `restow_api_setup_restore_src_${suffix}`;
const SCRATCH = `restow_api_setup_restore_tmp_${suffix}`;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const hasPgTools =
  spawnSync("pg_dump", ["--version"]).status === 0 &&
  spawnSync("pg_restore", ["--version"]).status === 0;

// Every case restores the dump into a scratch database and runs the preparation (migrations,
// checks) on it, some more than once: seconds each, more than vitest's default 5 s on a busy CI
// runner.
describe.skipIf(!testDatabaseAdminUrl)("preparing a restored dump against Postgres", () => {
  const admin = testDatabaseAdminUrl as string;
  let sourceUrl: string;
  let source: Database;
  let roles: TestDatabaseRoles | undefined;
  let root: string;
  let dumpFile: string;
  const masterKey = randomBytes(32).toString("base64");
  const otherKey = randomBytes(32).toString("base64");
  let prepare: typeof import("./prepare.js");
  let activate: typeof import("./activate.js");

  /** A fresh "restore" of the source into the scratch database. */
  async function restoreScratch(): Promise<string> {
    const adminDb = createDb(admin, { max: 1 });
    try {
      await adminDb.$client.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
      if (hasPgTools) {
        await adminDb.$client.query(`CREATE DATABASE ${SCRATCH}`);
      } else {
        await adminDb.$client.query(`CREATE DATABASE ${SCRATCH} TEMPLATE ${SOURCE}`);
      }
    } finally {
      await adminDb.$client.end();
    }
    const scratchUrl = urlFor(admin, SCRATCH);
    if (hasPgTools) {
      execFileSync("pg_restore", [
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "-d",
        scratchUrl,
        dumpFile,
      ]);
    }
    return scratchUrl;
  }

  beforeAll(async () => {
    sourceUrl = await recreateDatabase(admin, SOURCE);
    roles = await provisionTestRoles(sourceUrl);
    root = await mkdtemp(join(tmpdir(), "restow-setup-restore-"));
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = masterKey;
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    source = createDb(sourceUrl);
    const kek = kekFromBase64(masterKey);
    await source.$client.query(
      "INSERT INTO settings (operating_mode, public_url, setup_completed_at) VALUES ('public', 'https://backup.example.com', now())",
    );
    const provider = await source.$client.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('Provider') RETURNING id::text AS id",
    );
    const tenant = await source.$client.query<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id::text AS id",
      [provider.rows[0]?.id],
    );
    const tenantId = tenant.rows[0]?.id ?? "";
    const dek = generateDek(1);
    await source.$client.query(
      "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
      [tenantId, (await new EnvKeyProvider(kek).wrapDek(dek)).toString("base64")],
    );
    const tenantSecret = randomUUID();
    await source.$client.query(
      "INSERT INTO secrets (id, tenant_id, kind, ciphertext, key_version) VALUES ($1, $2, 'imap_password', $3, 1)",
      [tenantSecret, tenantId, sealSecret(dek, tenantSecret, "imap secret")],
    );
    const installationSecret = randomUUID();
    await source.$client.query(
      "INSERT INTO secrets (id, tenant_id, kind, ciphertext, key_version) VALUES ($1, NULL, 'smtp_password', $2, 1)",
      [
        installationSecret,
        sealSecret(deriveInstallationSecretsKey(kek), installationSecret, "smtp secret"),
      ],
    );
    await source.$client.query(
      `INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
       VALUES ('u-owner', 'Owner', 'owner@example.com', true, 'admin', now(), now())`,
    );
    dumpFile = join(root, "restow-20261105-120000-uploaded-to-0.5.0.dump");
    if (hasPgTools) {
      execFileSync("pg_dump", ["-Fc", "-f", dumpFile, sourceUrl]);
    }
    prepare = await import("./prepare.js");
    activate = await import("./activate.js");
  }, 180_000);

  afterAll(async () => {
    const shared = await import("../../db.js").catch(() => null);
    await Promise.allSettled([
      source?.$client.end(),
      shared?.db.$client.end(),
      shared?.providerDb.$client.end(),
      shared?.authDb.$client.end(),
    ]);
    await dropDatabase(admin, SCRATCH);
    await dropDatabase(admin, SOURCE);
    await roles?.drop(admin);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const rolesOf = () => {
    const tenant = new URL(roles?.appUrl ?? "");
    const installation = new URL(roles?.providerUrl ?? "");
    return {
      tenant: { name: tenant.username, password: decodeURIComponent(tenant.password) },
      installation: {
        name: installation.username,
        password: decodeURIComponent(installation.password),
      },
    };
  };

  it("prepares the restore with the master key that sealed it", async () => {
    const scratchUrl = await restoreScratch();
    const report = await prepare.prepareRestoredDatabase({
      ownerUrl: scratchUrl,
      roles: rolesOf(),
      kek: kekFromBase64(masterKey),
      dumpName: "restow-20261105-120000-uploaded-to-0.5.0.dump",
      via: "test",
    });
    expect(report.refusal).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.keys).toEqual({
      tenantKeys: { checked: 1, failed: 0 },
      installationSecrets: { checked: 1, failed: 0 },
      tenantSecrets: { checked: 1, failed: 0 },
    });
    expect(report.counts).toMatchObject({ users: 1, providerOwners: 1, tenants: 1 });
    expect(report.installation.publicUrl).toBe("https://backup.example.com");
    expect(report.storage.checked).toBe(true);
    expect(report.migrations.after).toBe(report.migrations.shipped);
    const scratch = createDb(scratchUrl, { max: 1 });
    try {
      const mode = await scratch.$client.query<{ source: string }>(
        "SELECT source FROM installation_restore_mode WHERE ended_at IS NULL",
      );
      expect(mode.rows).toEqual([{ source: "setup" }]);
      const entries = await scratch.$client.query<{ details: { source: string; dump: string } }>(
        "SELECT details FROM audit_log WHERE action = 'installation.restore_mode.started'",
      );
      expect(entries.rows[0]?.details).toMatchObject({
        source: "setup",
        dump: "restow-20261105-120000-uploaded-to-0.5.0.dump",
      });
    } finally {
      await scratch.$client.end();
    }
  }, 60_000);

  it("refuses another master key after switching restore mode on, and the source stays as it was", async () => {
    const scratchUrl = await restoreScratch();
    const report = await prepare.prepareRestoredDatabase({
      ownerUrl: scratchUrl,
      roles: rolesOf(),
      kek: kekFromBase64(otherKey),
      dumpName: "restow-20261105-120000-uploaded-to-0.5.0.dump",
      via: "test",
    });
    expect(report.ok).toBe(false);
    expect(report.refusal?.code).toBe("master_key_mismatch");
    expect(report.keys.tenantKeys.failed).toBe(1);
    expect(report.keys.installationSecrets.failed).toBe(1);
    expect(report.storage.checked).toBe(false);
    // Restore mode was on before the key check ran.
    expect(report.restoreMode?.created).toBe(true);
    const scratch = createDb(scratchUrl, { max: 1 });
    try {
      const mode = await scratch.$client.query(
        "SELECT 1 FROM installation_restore_mode WHERE ended_at IS NULL AND source = 'setup'",
      );
      expect(mode.rows).toHaveLength(1);
    } finally {
      await scratch.$client.end();
    }
    await activate.dropScratchDatabase(scratchUrl, SCRATCH);
    const gone = await source.$client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      SCRATCH,
    ]);
    expect(gone.rows).toHaveLength(0);
    const untouched = await source.$client.query("SELECT 1 FROM installation_restore_mode");
    expect(untouched.rows).toHaveLength(0);
  }, 60_000);

  it("refuses a dump newer than this release, one without Restow and one without a setup", async () => {
    const scratchUrl = await restoreScratch();
    const scratch = createDb(scratchUrl, { max: 1 });
    try {
      await scratch.$client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
      );
    } finally {
      await scratch.$client.end();
    }
    const tooNew = await prepare.prepareRestoredDatabase({
      ownerUrl: scratchUrl,
      kek: kekFromBase64(masterKey),
      dumpName: null,
      via: "test",
      checkStorage: null,
    });
    expect(tooNew.refusal?.code).toBe("dump_too_new");
    expect(tooNew.restoreMode).toBeNull();

    const adminDb = createDb(admin, { max: 1 });
    try {
      await adminDb.$client.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
      await adminDb.$client.query(`CREATE DATABASE ${SCRATCH}`);
    } finally {
      await adminDb.$client.end();
    }
    const empty = await prepare.prepareRestoredDatabase({
      ownerUrl: scratchUrl,
      kek: kekFromBase64(masterKey),
      dumpName: null,
      via: "test",
      checkStorage: null,
    });
    expect(empty.refusal?.code).toBe("not_restow");

    await recreateDatabase(admin, SCRATCH);
    const noSetup = await prepare.prepareRestoredDatabase({
      ownerUrl: scratchUrl,
      kek: kekFromBase64(masterKey),
      dumpName: null,
      via: "test",
      checkStorage: null,
    });
    expect(noSetup.refusal?.code).toBe("setup_incomplete");
    expect(noSetup.restoreMode).toBeNull();
  }, 60_000);
});
