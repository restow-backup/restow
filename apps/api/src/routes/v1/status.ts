import { type Database, jobProgress, jobs, protectedObjects, snapshots } from "@restow/db";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { loadGuestCounts } from "../../features/pve/protection.js";
import { readinessOverview } from "../../features/verify/service.js";
import { loadMailWarnings, warningCounts } from "../../features/warnings/state.js";
import { notImported } from "../../lib/imported-objects.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps } from "./api.js";
import { ARCHIVE_CHAIN_STATE, chainStateSchema, lastArchiveCapture } from "./archive.js";
import { component } from "./components.js";
import { endpointCountsSchema, loadEndpointCounts } from "./endpoints.js";
import { readinessSchema, timestampSchema, toIso, uuidSchema } from "./schemas.js";
import { loadStorageTotals, storageTotalsSchema } from "./storage.js";
import { readinessSummarySchema } from "./verify.js";
import { versionInfoSchema } from "./version.js";

/**
 * GET /status — the one call an RMM tile needs: last success per backup type,
 * protected and failed objects, storage, recovery readiness (the same rating
 * the Restow UI shows), the archive, and the running version. The summary is
 * shared with GET /provider/tenants, so a provider overview and a tenant's own
 * status never disagree. Readiness follows the verify feature's rule: an
 * object whose newest backup was not checked yet is `unverified`, whatever an
 * older backup scored (features/verify/verification-state.ts).
 */

export const lastSuccessSchema = component(
  "LastSuccess",
  z
    .object({
      mail: timestampSchema
        .nullable()
        .describe("Newest restorable Exchange mailbox backup without failed items."),
      onedrive: timestampSchema.nullable(),
      imap: timestampSchema.nullable(),
      archive: timestampSchema.nullable().describe("Newest message captured into the archive."),
    })
    .describe(
      "Completion time of the newest successful run per type. A run that completed but left items it could not back up does not count as successful.",
    ),
);

export const objectCountsSchema = component(
  "ObjectCounts",
  z.object({
    total: z.number().int(),
    active: z.number().int().describe("Objects under protection."),
    excluded: z.number().int(),
    orphaned: z.number().int(),
    failed: z.number().int().describe("Protected objects whose latest finished backup run failed."),
    withItemFailures: z
      .number()
      .int()
      .describe(
        "Protected objects whose latest finished backup run completed but could not back up some items, and whose warning nobody acknowledged for these causes. The job's item failures name them and the reason.",
      ),
    acknowledgedWarnings: z
      .number()
      .int()
      .describe(
        "Protected objects whose latest run left items behind for causes an administrator acknowledged. They do not count in `withItemFailures` until a new cause appears or a backup fails outright.",
      ),
    runningBackups: z.number().int().describe("Backup jobs queued or running."),
  }),
);

export const tenantSummarySchema = component(
  "TenantSummary",
  z.object({
    lastSuccess: lastSuccessSchema,
    objects: objectCountsSchema,
    storage: storageTotalsSchema,
    recoveryReadiness: readinessSchema
      .nullable()
      .describe(
        "Overall readiness: red when any object cannot be restored or its newest backup was not proven by a test restore yet, yellow when a rating needs attention or is overdue; null without protected objects.",
      ),
    readiness: readinessSummarySchema,
    lastVerifyAt: timestampSchema
      .nullable()
      .describe("When a restore check or storage finding last rated any object."),
    archive: z.object({ chain: chainStateSchema, lastCaptureAt: timestampSchema.nullable() }),
  }),
);
export type TenantSummaryDto = z.infer<typeof tenantSummarySchema>;

export const guestCountsSchema = component(
  "GuestCounts",
  z.object({
    total: z
      .number()
      .int()
      .describe("VMs and containers Proxmox VE can back up (present, no VM template)."),
    protected: z.number().int().describe("Guests in an enabled backup job."),
    withoutJob: z
      .number()
      .int()
      .describe("Guests in no enabled backup job: nothing backs them up."),
    failedLastBackup: z
      .number()
      .int()
      .describe("Protected guests whose newest finished backup run failed."),
    lastSuccessAt: timestampSchema.nullable().describe("Newest successful guest backup."),
    restorePoints: z.number().int().describe("Restore points kept for the tenant's guests."),
  }),
);

export const statusSchema = component(
  "Status",
  tenantSummarySchema.extend({
    tenant: z.object({
      id: uuidSchema,
      name: z.string(),
      slug: z.string(),
      status: z.enum(["active", "suspended", "deleting"]),
    }),
    generatedAt: timestampSchema,
    version: versionInfoSchema,
    endpoints: endpointCountsSchema.describe(
      "Servers and clients backed up by the agent (docs/AGENT.md); they also count in `readiness` and `recoveryReadiness`.",
    ),
    guests: guestCountsSchema.describe(
      "VMs and containers of Proxmox VE (docs/PVE.md); the ones in a backup job also count in `readiness` and `recoveryReadiness`.",
    ),
  }),
);
export type StatusDto = z.infer<typeof statusSchema>;

type ObjectKind = "mailbox" | "onedrive" | "imap";
type ObjectStatus = "active" | "excluded" | "orphaned";

/** Counts per status, including the statuses nothing has. */
export function countByStatus(rows: readonly { status: ObjectStatus; n: number }[]) {
  const of = (status: ObjectStatus) => rows.find((row) => row.status === status)?.n ?? 0;
  const counts = { active: of("active"), excluded: of("excluded"), orphaned: of("orphaned") };
  return { total: counts.active + counts.excluded + counts.orphaned, ...counts };
}

/** Newest completion per object kind, as ISO strings. */
export function lastSuccessOf(
  rows: readonly { kind: ObjectKind; at: Date | string | null }[],
  archive: string | null,
) {
  const of = (kind: ObjectKind) => toIso(rows.find((row) => row.kind === kind)?.at);
  return { mail: of("mailbox"), onedrive: of("onedrive"), imap: of("imap"), archive };
}

/**
 * How the latest finished backup run of each object ended: failed outright, or
 * completed while leaving items behind (`failedItems` from the job's progress).
 * A completed run with failed items is not a success and is counted as such.
 * The summary reads the same rule through features/warnings (state.ts), which
 * also sets acknowledged warnings apart; this is its plain form.
 */
export function backupOutcomes(rows: readonly { status: string; failedItems: number | null }[]): {
  failed: number;
  withItemFailures: number;
} {
  let failed = 0;
  let withItemFailures = 0;
  for (const row of rows) {
    if (row.status === "failed") {
      failed += 1;
    } else if (row.status === "completed" && (row.failedItems ?? 0) > 0) {
      withItemFailures += 1;
    }
  }
  return { failed, withItemFailures };
}

/** The tenant's summary (all reads tenant-pinned). */
export async function loadTenantSummary(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<TenantSummaryDto> {
  const facts = await withTenantTx(db, tenantId, async (tx) => {
    const byStatus = await tx
      .select({ status: protectedObjects.status, n: count() })
      .from(protectedObjects)
      .where(and(eq(protectedObjects.tenantId, tenantId), notImported()))
      .groupBy(protectedObjects.status);
    // Committed snapshots whose run left no failed items; a snapshot without a
    // job (or without progress) has nothing that could have failed.
    const lastByKind = await tx
      .select({
        kind: protectedObjects.kind,
        at: sql<Date | null>`max(${snapshots.completedAt})`.mapWith(snapshots.completedAt),
      })
      .from(snapshots)
      .innerJoin(protectedObjects, eq(protectedObjects.id, snapshots.protectedObjectId))
      .leftJoin(jobProgress, eq(jobProgress.jobId, snapshots.jobId))
      .where(
        and(
          eq(snapshots.tenantId, tenantId),
          isNotNull(snapshots.manifestPath),
          sql`coalesce(${jobProgress.failed}, 0) = 0`,
          // An import is not a backup: it never counts as the last successful one.
          notImported(),
        ),
      )
      .groupBy(protectedObjects.kind);
    // How the newest finished backup of each active object ended, with acknowledged warnings
    // apart (features/warnings): an acknowledged warning no longer counts as items left behind.
    const warnings = warningCounts((await loadMailWarnings(tx, tenantId)).values());
    const [running] = await tx
      .select({ n: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, "backup"),
          inArray(jobs.status, ["queued", "active"]),
        ),
      );
    return {
      byStatus,
      lastByKind,
      outcomes: {
        failed: warnings.failed,
        withItemFailures: warnings.open,
        acknowledged: warnings.acknowledged,
      },
      running: running?.n ?? 0,
      storage: await loadStorageTotals(tx, tenantId),
      archiveCapture: await lastArchiveCapture(tx, tenantId),
    };
  });
  const overview = await readinessOverview(db, tenantId, now);

  return {
    lastSuccess: lastSuccessOf(facts.lastByKind, facts.archiveCapture),
    objects: {
      ...countByStatus(facts.byStatus),
      failed: facts.outcomes.failed,
      withItemFailures: facts.outcomes.withItemFailures,
      acknowledgedWarnings: facts.outcomes.acknowledged,
      runningBackups: facts.running,
    },
    storage: facts.storage,
    recoveryReadiness: overview.summary.overall,
    readiness: overview.summary,
    lastVerifyAt: overview.summary.lastCheckedAt,
    archive: { chain: ARCHIVE_CHAIN_STATE, lastCaptureAt: facts.archiveCapture },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerStatusRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;

  api.tenant(
    {
      method: "get",
      path: "/status",
      operationId: "getStatus",
      summary: "Backup, readiness, storage and archive summary of the tenant",
      description:
        "Last success per type, protected objects with failed runs and with runs that left failed items, storage, recovery readiness, the latest verification, the archive chain and the running version with the opt-in update hint.",
      tag: "Status",
      scope: "status:read",
      errors: READ_ERRORS,
      response: { status: 200, description: "The status summary.", schema: statusSchema },
    },
    async ({ tenant }) => {
      const now = deps.now();
      const summary = await loadTenantSummary(db, tenant.id, now);
      return {
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
        generatedAt: now.toISOString(),
        ...summary,
        version: deps.version.current(),
        endpoints: await loadEndpointCounts(db, tenant.id, now),
        guests: (await loadGuestCounts(db, tenant.id, now)).counts,
      };
    },
  );
}
