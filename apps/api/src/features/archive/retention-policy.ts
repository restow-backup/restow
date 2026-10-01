/**
 * The archive's retention policy (docs/ARCHIVE.md): uniform by default, 8
 * years, the period ends on 31 December of the year of receipt plus the
 * period. Reuses the same `retention_policies` table the
 * snapshot/backup retention feature uses (apps/api/src/features/retention),
 * discriminated by `applies_to.target`: a row with `"archive"` governs the
 * archive, `"snapshots"` (or absent) governs backup retention — the two
 * never read each other's rows.
 *
 * Only one uniform policy per tenant is supported (no per-mailbox override
 * yet; see Known Issues in the release notes).
 */
import type { archive } from "@restow/core";
import { retentionPolicies } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { withTenantTx } from "../../lib/tenant-context.js";

/** The default: 8 years, ending with the receipt year, until a tenant sets its own. */
export const DEFAULT_ARCHIVE_RETENTION_POLICY: archive.RetentionPolicy = {
  mode: "end_of_year",
  years: 8,
};

function toArchivePolicy(row: {
  years: number | null;
  mode: "from_capture" | "end_of_year";
}): archive.RetentionPolicy {
  return { mode: row.mode, years: (row.years as archive.RetentionYears) ?? null };
}

/** The tenant's archive retention policy, or the default when none is set. */
export async function archiveRetentionPolicyFor(
  db: DbExecutor,
  tenantId: string,
): Promise<archive.RetentionPolicy> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ years: retentionPolicies.years, mode: retentionPolicies.mode })
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.tenantId, tenantId),
          sql`${retentionPolicies.appliesTo}->>'target' = 'archive'`,
        ),
      )
      .limit(1);
    return row ? toArchivePolicy(row) : DEFAULT_ARCHIVE_RETENTION_POLICY;
  });
}
