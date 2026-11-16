import { type WriteOnceFinding, writeOnceOfConfig } from "@restow/core";
import { type Database, storageTargets } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../../lib/tenant-context.js";
import { defaultWriteOnceFinding } from "../../lib/write-once.js";

/**
 * Whether the tenant's backups go to write-once storage (docs/STORAGE.md, "Write-once storage"):
 * the finding of the last test of its primary target, or of the installation default when it has
 * none of its own. The pages of jobs, guests, file shares and machines and the retention settings
 * ask it, so that they can say that retention is not applied there instead of leaving it unsaid.
 * Every member of the tenant may ask: it names the primary, never a path.
 */
export interface PrimaryWriteOnceDto {
  /** The primary refuses to overwrite or delete what it holds. */
  writeOnce: boolean;
  /** The primary's name, null for the installation default. */
  targetName: string | null;
  installationDefault: boolean;
  /** When it was found out, null when the primary was never tested since 0.5.0. */
  checkedAt: string | null;
  /** What the storage refused. */
  refused: WriteOnceFinding["refused"];
}

export async function primaryWriteOnce(
  db: Database,
  tenantId: string,
): Promise<PrimaryWriteOnceDto> {
  const [primary] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ name: storageTargets.name, config: storageTargets.config })
      .from(storageTargets)
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
      .limit(1),
  );
  const finding = primary ? writeOnceOfConfig(primary.config) : await defaultWriteOnceFinding();
  return {
    writeOnce: finding?.writeOnce === true,
    targetName: primary ? (primary.name ?? null) : null,
    installationDefault: !primary,
    checkedAt: finding?.checkedAt ?? null,
    refused: finding?.refused ?? [],
  };
}
