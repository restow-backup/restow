import { type Settings, type StoredUpdateCheck, settings } from "@restow/db";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";
import type { UpdateChannel } from "./schemas.js";
import {
  defaultSource,
  parseEnvironmentSource,
  parseRepositoryUrl,
  sourceFromSettings,
} from "./source.js";
import type { MaintenanceSummary, UpdateSnapshot } from "./state.js";

/**
 * The update columns of the `settings` row (packages/db schema/system.ts) and
 * how the effective configuration follows from them and the environment:
 * `RESTOW_UPDATE_CHECK_URL`, when set to a valid https address, wins over the
 * stored switch and source.
 */

export type UpdateRow = Pick<
  Settings,
  | "id"
  | "updateCheckEnabled"
  | "updateSourceUrl"
  | "updateChannel"
  | "updateCheck"
  | "updateNotifiedVersion"
  | "updateAuditCursor"
>;

export async function loadUpdateRow(db: DbExecutor): Promise<UpdateRow | null> {
  const [row] = await db
    .select({
      id: settings.id,
      updateCheckEnabled: settings.updateCheckEnabled,
      updateSourceUrl: settings.updateSourceUrl,
      updateChannel: settings.updateChannel,
      updateCheck: settings.updateCheck,
      updateNotifiedVersion: settings.updateNotifiedVersion,
      updateAuditCursor: settings.updateAuditCursor,
    })
    .from(settings)
    .limit(1);
  return row ?? null;
}

/**
 * Write the cached check without touching `settings.updated_at`: the page
 * shows that column as "settings last changed", which a background check is not.
 */
export async function saveCheck(db: DbExecutor, id: string, check: StoredUpdateCheck) {
  await db
    .update(settings)
    .set({ updateCheck: check, updatedAt: sql`${settings.updatedAt}` })
    .where(sql`${settings.id} = ${id}`);
}

export interface SnapshotInput {
  row: UpdateRow | null;
  env: Record<string, string | undefined>;
  demo: boolean;
  maintenance: MaintenanceSummary | null;
}

/** The effective configuration: environment first, then the stored settings, then the defaults. */
export function snapshotOf({ row, env, demo, maintenance }: SnapshotInput): UpdateSnapshot {
  const channel: UpdateChannel = row?.updateChannel ?? "stable";
  const fromEnvironment = parseEnvironmentSource(env.RESTOW_UPDATE_CHECK_URL);
  if (fromEnvironment) {
    return {
      enabled: !demo,
      channel,
      source: fromEnvironment,
      origin: "environment",
      check: row?.updateCheck ?? null,
      maintenance,
    };
  }
  const stored = row?.updateSourceUrl ?? null;
  const parsed = stored ? parseRepositoryUrl(stored) : null;
  return {
    enabled: !demo && (row?.updateCheckEnabled ?? false),
    channel,
    source: parsed?.ok ? parsed.source : stored ? defaultSource() : sourceFromSettings(null),
    origin: stored && parsed?.ok ? "settings" : "default",
    check: row?.updateCheck ?? null,
    maintenance,
  };
}
