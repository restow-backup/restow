import { type Database, type StorageTarget, packs, snapshots, storageTargets } from "@restow/db";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { snapshotNotImported } from "../../lib/imported-objects.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps } from "./api.js";
import { component } from "./components.js";
import { timestampSchema, uuidSchema } from "./schemas.js";

/**
 * GET /storage — where the tenant's chunk store lives, how much it holds and
 * how it grew. Addresses and credentials are never part of the answer: a
 * target is named, typed and rated, nothing more.
 *
 *   logical bytes   the protected data as the sources hold it: the newest
 *                   restorable snapshot of every object
 *   physical bytes  the packs actually stored (deduplicated, encrypted);
 *                   every target of the tenant holds this amount
 *   growth          bytes of the packs written in the last 30 / 90 days (a
 *                   pack is immutable, so its creation date is when its bytes
 *                   were added; packs replaced by garbage collection are gone)
 */

export const storageTotalsSchema = component(
  "StorageTotals",
  z.object({
    logicalBytes: z.number().int(),
    physicalBytes: z.number().int(),
  }),
);
export type StorageTotals = z.infer<typeof storageTotalsSchema>;

export const storageTargetSchema = component(
  "StorageTarget",
  z.object({
    id: uuidSchema,
    name: z.string().nullable(),
    kind: z
      .enum(["local", "s3", "installation_default"])
      .describe(
        "`local` is any mounted filesystem (volume, NFS, SMB); `s3` any S3-compatible service; " +
          "`installation_default` is a placeholder with no addressing of its own, standing for the " +
          "environment default a storage migration retired (docs/STORAGE.md).",
      ),
    role: z
      .enum(["primary", "copy", "previous"])
      .describe(
        "`previous` is a retired primary a storage migration replaced: read-only, kept until an " +
          "admin removes it (docs/STORAGE.md).",
      ),
    status: z.enum(["unverified", "ok", "error"]).describe("Result of the latest probe."),
    errorMessage: z.string().nullable(),
    checkedAt: timestampSchema.nullable(),
    usedBytes: z.number().int(),
    objectLock: z
      .boolean()
      .describe("The bucket enforces S3 Object Lock (WORM); always false for filesystems."),
  }),
);
export type StorageTargetDto = z.infer<typeof storageTargetSchema>;

export const storageSchema = component(
  "Storage",
  z.object({
    usesInstallationDefault: z
      .boolean()
      .describe(
        "The tenant has no primary target of its own and writes to the installation default.",
      ),
    targets: z.array(storageTargetSchema),
    usage: storageTotalsSchema.extend({
      packCount: z.number().int(),
    }),
    growthBytes: z.object({
      last30d: z.number().int(),
      last90d: z.number().int(),
    }),
  }),
);
export type StorageDto = z.infer<typeof storageSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

function objectLockOf(target: Pick<StorageTarget, "kind" | "config">): boolean {
  return target.kind === "s3" && (target.config as { objectLock?: unknown }).objectLock === true;
}

export function toStorageTarget(target: StorageTarget): StorageTargetDto {
  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    role: target.role,
    status: target.status,
    errorMessage: target.errorMessage,
    checkedAt: target.checkedAt?.toISOString() ?? null,
    usedBytes: target.bytesUsed,
    objectLock: objectLockOf(target),
  };
}

/** Logical and physical bytes of a tenant, inside the caller's tenant transaction. */
export async function loadStorageTotals(tx: Transaction, tenantId: string): Promise<StorageTotals> {
  const latest = tx
    .selectDistinctOn([snapshots.protectedObjectId], { byteSize: snapshots.byteSize })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.status, "active"),
        isNotNull(snapshots.manifestPath),
        // "Protected data": imported mailboxes are stored, but not protected from a source.
        snapshotNotImported(),
      ),
    )
    .orderBy(snapshots.protectedObjectId, desc(snapshots.sequence))
    .as("latest");
  const [logical] = await tx
    .select({ bytes: sql<number>`coalesce(sum(${latest.byteSize}), 0)`.mapWith(Number) })
    .from(latest);
  const [physical] = await tx
    .select({ bytes: sql<number>`coalesce(sum(${packs.size}), 0)`.mapWith(Number) })
    .from(packs)
    .where(eq(packs.tenantId, tenantId));
  return { logicalBytes: logical?.bytes ?? 0, physicalBytes: physical?.bytes ?? 0 };
}

export async function loadStorage(db: Database, tenantId: string, now: Date): Promise<StorageDto> {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since90 = new Date(now.getTime() - 90 * DAY_MS);
  return withTenantTx(db, tenantId, async (tx) => {
    const targets = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId))
      .orderBy(asc(storageTargets.role), asc(storageTargets.createdAt));
    const totals = await loadStorageTotals(tx, tenantId);
    const [packStats] = await tx
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        last30d:
          sql<number>`coalesce(sum(${packs.size}) filter (where ${packs.createdAt} >= ${since30}), 0)`.mapWith(
            Number,
          ),
        last90d:
          sql<number>`coalesce(sum(${packs.size}) filter (where ${packs.createdAt} >= ${since90}), 0)`.mapWith(
            Number,
          ),
      })
      .from(packs)
      .where(eq(packs.tenantId, tenantId));
    return {
      usesInstallationDefault: !targets.some((target) => target.role === "primary"),
      targets: targets.map(toStorageTarget),
      usage: { ...totals, packCount: packStats?.count ?? 0 },
      growthBytes: { last30d: packStats?.last30d ?? 0, last90d: packStats?.last90d ?? 0 },
    };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerStorageRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;

  api.tenant(
    {
      method: "get",
      path: "/storage",
      operationId: "getStorage",
      summary: "Storage targets, usage and growth over 30 and 90 days",
      tag: "Status",
      scope: "status:read",
      errors: READ_ERRORS,
      response: { status: 200, description: "Storage of the tenant.", schema: storageSchema },
    },
    ({ tenant }) => loadStorage(db, tenant.id, deps.now()),
  );
}
