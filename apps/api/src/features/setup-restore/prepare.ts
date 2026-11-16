import {
  DEFAULT_STORAGE_SECRET_KIND,
  type Dek,
  deriveInstallationSecretsKey,
  EnvKeyProvider,
  InstallationDefaultResolver,
  openSecret,
  type TenantProgressCheck,
} from "@restow/core";
import {
  activateRestoreMode,
  createDb,
  type Database,
  findInstallationSecret,
  type RoleLogin,
} from "@restow/db";
import { appliedMigrationCount, runMigrations, shippedMigrationCount } from "@restow/db/migrate";
import { audit } from "../../lib/audit.js";
import { setInstallationDefaultResolver } from "../../lib/installation-default.js";
import { createApiRestoreModeGuard, RESTORE_MODE_AUDIT_ACTIONS } from "../restore-mode/guard.js";
import { checkRestoreMode } from "../restore-mode/service.js";
import { emptyReport, type RestoreReport, type RestoreTargetFinding } from "./report.js";

/**
 * Preparing a restored database dump before it goes live (docs/DATABASE.md, "Restore an
 * installation from a dump"). The dump was restored into the scratch database
 * (`restow_restore`, report.ts) by the updater or by install.sh; this runs on it, as the
 * database owner, while the worker and the scheduler are stopped:
 *
 *   1. inspect     the dump holds a Restow database (a migration journal) that is not newer
 *                  than this release
 *   2. migrate     to this release, the roles of this server provisioned again (a dump carries
 *                  no roles and, restored with --no-owner --no-acl, no grants)
 *   3. restore mode  switched on: the first thing Restow writes into the restored data, so
 *                  nothing that starts on it later deletes anything (source `setup`)
 *   4. master key  RESTOW_MASTER_KEY must unwrap every tenant key and open every installation
 *                  secret and one secret per tenant; otherwise `master_key_mismatch`, and the
 *                  caller drops the scratch database (nothing of the live installation changed)
 *   5. storage     every tenant's targets of the restored configuration are opened and their
 *                  progress markers compared with the database (restore-mode/guard.ts)
 *   6. report      what the wizard and install.sh show before the operator activates it
 *
 * The scratch database is activated by activate.ts only after the operator confirmed.
 */

export interface PrepareOptions {
  /** The owner's connection string of the scratch database. */
  readonly ownerUrl: string;
  /** The application, installation and auth logins of this server (migrate.ts). */
  readonly roles?: { tenant: RoleLogin; installation: RoleLogin; auth?: RoleLogin };
  /** The master key (RESTOW_MASTER_KEY, 32 bytes). */
  readonly kek: Buffer;
  /** The dump file the database came from, for the audit entry and the report. */
  readonly dumpName: string | null;
  /** Who restores: "setup wizard" or "install.sh". */
  readonly via: string;
  /** Compare the storage; tests replace it. Default: restore-mode/service.ts `checkRestoreMode`. */
  readonly checkStorage?: ((db: Database) => Promise<TenantProgressCheck[]>) | null;
  readonly now?: () => Date;
}

async function count(db: Database, sql: string): Promise<number> {
  const { rows } = await db.$client.query<{ count: string }>(sql);
  return Number(rows[0]?.count ?? 0);
}

/** The storage comparison on the scratch database, with the restored saved default storage. */
async function defaultCheckStorage(db: Database, kek: Buffer): Promise<TenantProgressCheck[]> {
  setInstallationDefaultResolver(
    new InstallationDefaultResolver({
      loadStored: () => findInstallationSecret(db, DEFAULT_STORAGE_SECRET_KIND),
      installationKey: () => deriveInstallationSecretsKey(kek),
    }),
  );
  try {
    const guard = createApiRestoreModeGuard(db, () => undefined);
    return await checkRestoreMode(db, guard);
  } finally {
    setInstallationDefaultResolver(null);
  }
}

interface KeyRow extends Record<string, unknown> {
  tenant_id: string;
  key_version: number;
  encrypted_dek: string;
}

interface SecretRow extends Record<string, unknown> {
  id: string;
  tenant_id: string | null;
  key_version: number;
  ciphertext: string;
}

/** Step 4: does the master key open what the dump sealed? */
async function checkMasterKey(db: Database, kek: Buffer): Promise<RestoreReport["keys"]> {
  const provider = new EnvKeyProvider(kek);
  const keys = new Map<string, Dek>();
  const result: RestoreReport["keys"] = {
    tenantKeys: { checked: 0, failed: 0 },
    installationSecrets: { checked: 0, failed: 0 },
    tenantSecrets: { checked: 0, failed: 0 },
  };
  const { rows: keyRows } = await db.$client.query<KeyRow>(
    "SELECT tenant_id::text AS tenant_id, key_version, encrypted_dek FROM tenant_keys ORDER BY tenant_id, key_version",
  );
  for (const row of keyRows) {
    result.tenantKeys.checked += 1;
    try {
      const dek = await provider.unwrapDek(Buffer.from(row.encrypted_dek, "base64"));
      keys.set(`${row.tenant_id}/${row.key_version}`, dek);
    } catch {
      result.tenantKeys.failed += 1;
    }
  }
  const installationKey = deriveInstallationSecretsKey(kek);
  const { rows: installationRows } = await db.$client.query<SecretRow>(
    "SELECT id::text AS id, tenant_id, key_version, ciphertext FROM secrets WHERE tenant_id IS NULL",
  );
  for (const row of installationRows) {
    result.installationSecrets.checked += 1;
    try {
      openSecret(installationKey, row.id, row.ciphertext);
    } catch {
      result.installationSecrets.failed += 1;
    }
  }
  // One secret per tenant (its newest) shows that the tenant's keys open what they sealed.
  const { rows: tenantRows } = await db.$client.query<SecretRow>(
    `SELECT DISTINCT ON (tenant_id) id::text AS id, tenant_id::text AS tenant_id, key_version, ciphertext
       FROM secrets WHERE tenant_id IS NOT NULL ORDER BY tenant_id, updated_at DESC`,
  );
  for (const row of tenantRows) {
    result.tenantSecrets.checked += 1;
    const dek = keys.get(`${row.tenant_id}/${row.key_version}`);
    try {
      if (!dek) {
        throw new Error("no key");
      }
      openSecret(dek, row.id, row.ciphertext);
    } catch {
      result.tenantSecrets.failed += 1;
    }
  }
  return result;
}

function findings(checks: readonly TenantProgressCheck[], names: Map<string, string>) {
  const targets: RestoreTargetFinding[] = checks.flatMap((check) =>
    check.targets.map((target) => ({
      tenantId: check.tenantId,
      tenantName: names.get(check.tenantId) ?? null,
      targetId: target.targetId,
      outcome: target.outcome,
      storageMaxSeq: target.storageMaxSeq,
      dbSeq: target.dbSeq,
      unknownKeyVersions: [...target.unknownKeyVersions],
      detail: target.detail,
    })),
  );
  return {
    targets,
    unreachable: targets.filter((target) => target.outcome === "unreachable").length,
    ahead: targets.filter((target) => target.outcome === "ahead").length,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

/** Run steps 1 to 6 on the scratch database; never touches the live one. */
export async function prepareRestoredDatabase(options: PrepareOptions): Promise<RestoreReport> {
  const now = options.now ?? (() => new Date());
  const shipped = shippedMigrationCount();
  const db = createDb(options.ownerUrl, { max: 2 });
  try {
    const restored = await appliedMigrationCount(db.$client);
    const report = emptyReport({ dumpName: options.dumpName, shipped, restored, at: now() });
    if (restored === null) {
      report.refusal = {
        code: "not_restow",
        message: "The dump holds no Restow database (it has no migration journal).",
      };
      return report;
    }
    if (restored > shipped) {
      report.refusal = {
        code: "dump_too_new",
        message: `The dump comes from a newer release (${restored} migrations; this release has ${shipped}). Install that release or a newer one and restore again.`,
        requiredMigrations: restored,
      };
      return report;
    }

    await runMigrations(options.ownerUrl, options.roles ? { roles: options.roles } : {});
    report.migrations.after = await appliedMigrationCount(db.$client);

    const { rows: settingsRows } = await db.$client.query<{
      setup_completed_at: Date | null;
      public_url: string | null;
      operating_mode: string | null;
    }>("SELECT setup_completed_at, public_url, operating_mode FROM settings LIMIT 1");
    const settingsRow = settingsRows[0];
    report.installation = {
      publicUrl: settingsRow?.public_url ?? null,
      operatingMode: settingsRow?.operating_mode ?? null,
      setupCompletedAt: settingsRow?.setup_completed_at
        ? new Date(settingsRow.setup_completed_at).toISOString()
        : null,
    };
    if (!settingsRow?.setup_completed_at) {
      report.refusal = {
        code: "setup_incomplete",
        message:
          "The dump holds no completed setup: there is nothing to restore. Run the setup as a new installation instead.",
      };
      return report;
    }

    // Restore mode first: whatever runs on this data later deletes nothing until an owner ends it.
    const activatedAt = now();
    report.restoreMode = await activateRestoreMode(db.$client, {
      source: "setup",
      reason: `Restored from ${options.dumpName ?? "a database dump"} (${options.via}).`,
      actor: { label: `setup (restore from ${options.dumpName ?? "a dump"})` },
      now: activatedAt,
      holdJobsBefore: activatedAt,
    });

    report.counts = {
      users: await count(db, 'SELECT count(*)::text AS count FROM "user"'),
      providerOwners: await count(
        db,
        `SELECT count(*)::text AS count FROM "user" u
          WHERE u.role = 'admin' AND coalesce(u.banned, false) = false
            AND coalesce((SELECT m.role::text FROM provider_members m WHERE m.user_id = u.id), 'owner') = 'owner'`,
      ),
      tenants: await count(db, "SELECT count(*)::text AS count FROM tenants"),
      storageTargets: await count(db, "SELECT count(*)::text AS count FROM storage_targets"),
      clusterNodes: await count(
        db,
        "SELECT count(*)::text AS count FROM cluster_nodes WHERE status = 'active'",
      ),
    };

    report.keys = await checkMasterKey(db, options.kek);
    const failed =
      report.keys.tenantKeys.failed +
      report.keys.installationSecrets.failed +
      report.keys.tenantSecrets.failed;
    if (failed > 0) {
      report.refusal = {
        code: "master_key_mismatch",
        message: `RESTOW_MASTER_KEY does not open ${failed} of the restored keys and secrets: this dump belongs to another master key. Nothing was changed; start again with the master key of the old installation.`,
      };
      return report;
    }

    if (options.checkStorage !== null) {
      const { rows: tenantRows } = await db.$client.query<{ id: string; name: string }>(
        "SELECT id::text AS id, name FROM tenants",
      );
      const names = new Map(tenantRows.map((row) => [row.id, row.name]));
      try {
        const checks = options.checkStorage
          ? await options.checkStorage(db)
          : await defaultCheckStorage(db, options.kek);
        report.storage = { checked: true, error: null, ...findings(checks, names) };
      } catch (error) {
        report.storage = {
          checked: false,
          targets: [],
          unreachable: 0,
          ahead: 0,
          error: errorText(error),
        };
      }
    }

    await audit(db, {
      tenantId: null,
      actor: `setup (restore from ${options.dumpName ?? "a dump"})`,
      action: RESTORE_MODE_AUDIT_ACTIONS.started,
      target: report.restoreMode.id,
      targetType: "installation",
      details: {
        source: "setup",
        via: options.via,
        dump: options.dumpName,
        migrations: report.migrations,
        tenants: report.counts.tenants,
        storageTargets: report.storage.targets.length,
        ahead: report.storage.ahead,
        unreachable: report.storage.unreachable,
      },
    });
    report.ok = true;
    report.preparedAt = now().toISOString();
    return report;
  } finally {
    await db.$client.end();
  }
}
