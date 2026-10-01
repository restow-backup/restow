import { settings } from "@restow/db";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";

/**
 * Installation-level license rows (no tenant, no RLS). The active row is
 * read by ee/licensing (`loadInstalledLicense`), the same code every gate of
 * ee/api and ee/worker uses, so the edition shown on the license page and the
 * edition gating elsewhere never disagree.
 */
export {
  effectiveLicenseOf,
  loadEffectiveLicense,
  loadInstalledLicense,
} from "../../../licensing/src/index.js";

/**
 * The installation id license keys are bound to: the id of the single
 * settings row, created by the first wizard step (the operator notice) and
 * completed by the setup. Null before the wizard was started.
 */
export async function loadInstallationId(db: DbExecutor): Promise<string | null> {
  const [row] = await db.select({ id: settings.id }).from(settings).limit(1);
  return row?.id ?? null;
}

/** Serialize license changes so two concurrent installs cannot both stay active. */
export async function lockLicenseRows(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('restow.license'))`);
}
