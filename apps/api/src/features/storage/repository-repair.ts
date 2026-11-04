import {
  type Database,
  type StorageRepositoryRepair,
  type StorageRepositoryRepairResult,
  storageRepositoryRepairs,
} from "@restow/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * The repository repair of a tenant from the API side (docs/STORAGE.md, "Repository repair"):
 * an administrator queues a scan (lists and classifies every restic repository of the tenant
 * on every storage target, changes nothing) and, after reading it, the repair of that scan
 * (a recent sign-in and the typed word {@link REPAIR_CONFIRMATION}). The worker does the work
 * (apps/worker handlers/repository-repair.ts); the page polls the state here.
 */

const PROBLEM_PREFIX = "urn:restow:problem:storage-";

/** What the administrator types to apply a repair. */
export const REPAIR_CONFIRMATION = "REPAIR";

export const requestRepairSchema = z.object({
  scanId: z.string().uuid(),
  confirm: z.string(),
});

export interface RepositoryRepairDto {
  id: string;
  kind: "scan" | "apply";
  status: StorageRepositoryRepair["status"];
  scanId: string | null;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  result: StorageRepositoryRepairResult | null;
}

export interface RepositoryRepairsDto {
  /** The newest scan, and the newest repair (each null when none ran yet). */
  scan: RepositoryRepairDto | null;
  repair: RepositoryRepairDto | null;
}

interface Actor {
  id: string;
  email: string;
  ip: string | null;
}

function toDto(row: StorageRepositoryRepair): RepositoryRepairDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    scanId: row.scanId,
    requestedBy: row.requestedBy,
    requestedAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
    result: row.result ?? null,
  };
}

function inProgress(): ProblemError {
  return new ProblemError(409, "A scan or repair is running", {
    type: `${PROBLEM_PREFIX}repair-in-progress`,
    detail: "A repository scan or repair of this tenant is queued or running. Wait for it to end.",
    extensions: { code: "repair_in_progress" },
  });
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

export async function repositoryRepairs(
  db: Database,
  tenantId: string,
): Promise<RepositoryRepairsDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const newest = async (kind: "scan" | "apply") => {
      const [row] = await tx
        .select()
        .from(storageRepositoryRepairs)
        .where(
          and(
            eq(storageRepositoryRepairs.tenantId, tenantId),
            eq(storageRepositoryRepairs.kind, kind),
          ),
        )
        .orderBy(desc(storageRepositoryRepairs.createdAt))
        .limit(1);
      return row ? toDto(row) : null;
    };
    return { scan: await newest("scan"), repair: await newest("apply") };
  });
}

/** Queue a scan (changes nothing on any target). */
export async function requestRepositoryScan(
  db: Database,
  tenantId: string,
  actor: Actor,
): Promise<RepositoryRepairDto> {
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(storageRepositoryRepairs)
        .values({ tenantId, kind: "scan", requestedBy: actor.email, requestedByUserId: actor.id })
        .returning();
      if (!row) {
        throw new Error("repository scan insert returned no row");
      }
      await audit(tx, {
        tenantId,
        actor: actor.email,
        actorUserId: actor.id,
        action: "storage.repositories.scan_requested",
        target: row.id,
        targetType: "storage_repository_repair",
        ip: actor.ip,
        details: {},
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw inProgress();
    }
    throw error;
  }
}

/**
 * Queue the repair of a completed scan: the typed confirmation must match, and the scan must
 * be the tenant's newest (a repair decided on an older picture would surprise).
 */
export async function requestRepositoryRepair(
  db: Database,
  tenantId: string,
  input: z.infer<typeof requestRepairSchema>,
  actor: Actor,
): Promise<RepositoryRepairDto> {
  if (input.confirm.trim() !== REPAIR_CONFIRMATION) {
    throw new ProblemError(422, "Confirmation does not match", {
      type: `${PROBLEM_PREFIX}repair-confirm`,
      detail: `Type ${REPAIR_CONFIRMATION} to repair the repositories.`,
      extensions: { field: "confirm", code: "repair_confirm" },
    });
  }
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      const [scan] = await tx
        .select()
        .from(storageRepositoryRepairs)
        .where(
          and(
            eq(storageRepositoryRepairs.tenantId, tenantId),
            eq(storageRepositoryRepairs.kind, "scan"),
          ),
        )
        .orderBy(desc(storageRepositoryRepairs.createdAt))
        .limit(1);
      if (!scan || scan.id !== input.scanId || scan.status !== "completed") {
        throw new ProblemError(409, "Scan again first", {
          type: `${PROBLEM_PREFIX}repair-needs-scan`,
          detail:
            "A repair applies the newest completed scan of this tenant. Run a scan, read it, then repair.",
          extensions: { code: "repair_needs_scan" },
        });
      }
      const [row] = await tx
        .insert(storageRepositoryRepairs)
        .values({
          tenantId,
          kind: "apply",
          scanId: scan.id,
          requestedBy: actor.email,
          requestedByUserId: actor.id,
        })
        .returning();
      if (!row) {
        throw new Error("repository repair insert returned no row");
      }
      await audit(tx, {
        tenantId,
        actor: actor.email,
        actorUserId: actor.id,
        action: "storage.repositories.repair_requested",
        target: row.id,
        targetType: "storage_repository_repair",
        ip: actor.ip,
        details: { scanId: scan.id },
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw inProgress();
    }
    throw error;
  }
}
