import { z } from "zod";

/**
 * What a restore from a database dump found (features/setup-restore/prepare.ts), as
 * `restow restore prepare --json` prints it, the updater keeps it in its state and the setup
 * wizard shows it before the operator activates the restored database. Shared by the command
 * line, the updater protocol and the web; it lives here because the updater may import nothing
 * of the application (boundary.test.ts).
 */

/**
 * The restored copy lives in this database until it is activated (activate.ts): pg_restore never
 * writes into the live database, so the live one is always either the empty fresh database or a
 * restored one that already has restore mode on.
 */
export const SCRATCH_DATABASE = "restow_restore";

/** The prefix of the fresh database a restore set aside (`<live>_before_restore_<stamp>`). */
export const BEFORE_RESTORE_INFIX = "_before_restore_";

/**
 * Why a dump was refused. Nothing of the live installation was changed in any case; the caller
 * drops the scratch database.
 *
 *   master_key_mismatch  RESTOW_MASTER_KEY does not open the restored tenant keys or the
 *                        installation's secrets: the dump belongs to another master key
 *   dump_too_new         the dump has more migrations than this release ships
 *   not_restow           the dump holds no Restow database (no migration journal)
 *   setup_incomplete     the dump's installation never finished its setup
 */
export const RESTORE_REFUSAL_CODES = [
  "master_key_mismatch",
  "dump_too_new",
  "not_restow",
  "setup_incomplete",
] as const;
export type RestoreRefusalCode = (typeof RESTORE_REFUSAL_CODES)[number];

/** `restow restore prepare` exit codes (install.sh maps 3 to its exit code 11). */
export const PREPARE_EXIT = { ok: 0, error: 1, masterKey: 3, refused: 4 } as const;

const countCheckSchema = z.object({
  checked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const restoreTargetFindingSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string().nullable(),
  targetId: z.string(),
  /** ok, ahead (storage shows progress the database lacks), unreachable, foreign, none. */
  outcome: z.string(),
  storageMaxSeq: z.number().nullable(),
  dbSeq: z.number(),
  unknownKeyVersions: z.array(z.number()),
  detail: z.string().nullable(),
});
export type RestoreTargetFinding = z.infer<typeof restoreTargetFindingSchema>;

export const restoreReportSchema = z.object({
  ok: z.boolean(),
  refusal: z
    .object({
      code: z.enum(RESTORE_REFUSAL_CODES),
      message: z.string(),
      /** dump_too_new: the release that has at least this many migrations is needed. */
      requiredMigrations: z.number().int().optional(),
    })
    .nullable(),
  dumpName: z.string().nullable(),
  migrations: z.object({
    restored: z.number().int().nullable(),
    shipped: z.number().int(),
    after: z.number().int().nullable(),
  }),
  installation: z.object({
    publicUrl: z.string().nullable(),
    operatingMode: z.string().nullable(),
    setupCompletedAt: z.string().nullable(),
  }),
  counts: z.object({
    users: z.number().int(),
    providerOwners: z.number().int(),
    tenants: z.number().int(),
    storageTargets: z.number().int(),
    clusterNodes: z.number().int(),
  }),
  restoreMode: z.object({ id: z.string(), created: z.boolean() }).nullable(),
  keys: z.object({
    tenantKeys: countCheckSchema,
    installationSecrets: countCheckSchema,
    tenantSecrets: countCheckSchema,
  }),
  storage: z.object({
    /** False when the comparison did not run (the keys did not open, or it was skipped). */
    checked: z.boolean(),
    targets: z.array(restoreTargetFindingSchema),
    unreachable: z.number().int(),
    ahead: z.number().int(),
    /** Why the comparison failed as a whole (a configuration problem), else null. */
    error: z.string().nullable(),
  }),
  preparedAt: z.string(),
});
export type RestoreReport = z.infer<typeof restoreReportSchema>;

/** The report of a database whose dump was refused before anything was checked. */
export function emptyReport(input: {
  dumpName: string | null;
  shipped: number;
  restored: number | null;
  at: Date;
}): RestoreReport {
  return {
    ok: false,
    refusal: null,
    dumpName: input.dumpName,
    migrations: { restored: input.restored, shipped: input.shipped, after: null },
    installation: { publicUrl: null, operatingMode: null, setupCompletedAt: null },
    counts: { users: 0, providerOwners: 0, tenants: 0, storageTargets: 0, clusterNodes: 0 },
    restoreMode: null,
    keys: {
      tenantKeys: { checked: 0, failed: 0 },
      installationSecrets: { checked: 0, failed: 0 },
      tenantSecrets: { checked: 0, failed: 0 },
    },
    storage: { checked: false, targets: [], unreachable: 0, ahead: 0, error: null },
    preparedAt: input.at.toISOString(),
  };
}

/** One line per finding, for the terminal (install.sh prints it before it asks to activate). */
export function formatReport(report: RestoreReport): string {
  const lines: string[] = [];
  if (report.refusal) {
    lines.push(`Refused (${report.refusal.code}): ${report.refusal.message}`);
  }
  lines.push(
    `Dump:           ${report.dumpName ?? "(unnamed)"}`,
    `Migrations:     ${report.migrations.restored ?? "none"} in the dump, ${report.migrations.shipped} in this release${report.migrations.after === null ? "" : `, ${report.migrations.after} after migrating`}`,
    `Address:        ${report.installation.publicUrl ?? "(none saved)"} (${report.installation.operatingMode ?? "unknown"} mode)`,
    `Accounts:       ${report.counts.users} (${report.counts.providerOwners} provider owner(s))`,
    `Tenants:        ${report.counts.tenants}, storage targets: ${report.counts.storageTargets}`,
    `Master key:     ${report.keys.tenantKeys.checked} tenant key(s), ${report.keys.installationSecrets.checked} installation secret(s), ${report.keys.tenantSecrets.checked} tenant secret(s) checked, ${report.keys.tenantKeys.failed + report.keys.installationSecrets.failed + report.keys.tenantSecrets.failed} did not open`,
  );
  if (report.restoreMode) {
    lines.push(`Restore mode:   on (${report.restoreMode.id})`);
  }
  if (report.storage.checked) {
    lines.push(
      `Storage:        ${report.storage.targets.length} target(s) compared, ${report.storage.ahead} ahead of the database, ${report.storage.unreachable} unreachable`,
    );
    for (const target of report.storage.targets) {
      lines.push(
        `  ${target.tenantName ?? target.tenantId} / ${target.targetId}: ${target.outcome} (storage ${target.storageMaxSeq ?? "-"}, database ${target.dbSeq})${target.detail ? ` ${target.detail}` : ""}`,
      );
    }
  } else if (report.storage.error) {
    lines.push(`Storage:        not compared: ${report.storage.error}`);
  }
  if (report.counts.clusterNodes > 0) {
    lines.push(
      `Worker nodes:   ${report.counts.clusterNodes} in the dump; their database logins are not part of a dump: join them again under Installation > Cluster.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
