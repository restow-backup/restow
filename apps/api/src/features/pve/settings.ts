import { type Database, type PveInstallationSettings, settings } from "@restow/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * The installation's settings of Proxmox VE backups (docs/PVE.md, "Restore check"):
 *
 *   verifyAfterBackup  check every new restore point right after its backup (default on): the
 *                      commit marks the restore point, and the worker's next PVE pass (every five
 *                      minutes, a bounded number per pass) reads it back. The weekly check of every
 *                      guest's newest restore point stays either way.
 *
 * Read on the installation pool; GET /api/v1/settings/pve for every provider admin, PUT for the
 * owner (lib/provider-access.ts), audited in the installation chain.
 */

export const PVE_SETTINGS_AUDIT_ACTIONS = { updated: "settings.pve.updated" } as const;

/** Every guest's newest restore point is checked at least this often (apps/worker pve). */
export const PVE_VERIFY_EVERY_DAYS = 7;

export const DEFAULT_PVE_SETTINGS: Required<PveInstallationSettings> = {
  verifyAfterBackup: true,
};

export const pveSettingsSchema = z.object({ verifyAfterBackup: z.boolean().optional() }).strict();

export function resolvePveSettings(
  stored: PveInstallationSettings | null | undefined,
): Required<PveInstallationSettings> {
  return {
    verifyAfterBackup:
      typeof stored?.verifyAfterBackup === "boolean"
        ? stored.verifyAfterBackup
        : DEFAULT_PVE_SETTINGS.verifyAfterBackup,
  };
}

export interface PveSettingsDto {
  settings: Required<PveInstallationSettings>;
  defaults: Required<PveInstallationSettings>;
}

export async function getPveSettings(db: DbExecutor): Promise<PveSettingsDto> {
  const [row] = await db.select({ value: settings.pveSettings }).from(settings).limit(1);
  return { settings: resolvePveSettings(row?.value), defaults: DEFAULT_PVE_SETTINGS };
}

/** Whether a new restore point is checked right after its backup; on when unreadable. */
export async function verifyAfterBackup(db: DbExecutor): Promise<boolean> {
  try {
    return (await getPveSettings(db)).settings.verifyAfterBackup;
  } catch {
    return DEFAULT_PVE_SETTINGS.verifyAfterBackup;
  }
}

export async function updatePveSettings(
  db: Database,
  input: z.infer<typeof pveSettingsSchema>,
  actor: { id: string; email: string; ip: string | null },
): Promise<PveSettingsDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).limit(1).for("update");
    if (!row) {
      throw new ProblemError(409, "Setup not completed", {
        type: "urn:restow:problem:setup-incomplete",
        detail: "Finish the setup wizard before changing installation settings.",
      });
    }
    const stored: PveInstallationSettings = { ...row.pveSettings, ...input };
    await tx.update(settings).set({ pveSettings: stored }).where(eq(settings.id, row.id));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: PVE_SETTINGS_AUDIT_ACTIONS.updated,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { before: row.pveSettings, after: stored },
    });
    return { settings: resolvePveSettings(stored), defaults: DEFAULT_PVE_SETTINGS };
  });
}
