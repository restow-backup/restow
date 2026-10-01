/**
 * Legal holds (docs/ARCHIVE.md): placing and releasing a hold that suspends
 * the archive's deletion run and snapshot retention for a tenant or one of
 * its mailboxes. Business/Service Provider (`archive.legalHold`). The core
 * only reads `legal_holds` (retention honours every active hold); creating
 * and releasing them lives here. Every change is audited.
 */
import { legalHolds } from "@restow/db";
import { and, desc, eq } from "drizzle-orm";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import { type DbExecutor, withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import type { CreateLegalHoldInput } from "./schemas.js";

export interface LegalHoldDto {
  id: string;
  reason: string;
  protectedObjectId: string | null;
  active: boolean;
  createdAt: string;
  releasedAt: string | null;
}

function toHoldDto(row: typeof legalHolds.$inferSelect): LegalHoldDto {
  return {
    id: row.id,
    reason: row.reason,
    protectedObjectId: row.protectedObjectId,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    releasedAt: row.releasedAt?.toISOString() ?? null,
  };
}

export async function listLegalHolds(db: DbExecutor, tenantId: string): Promise<LegalHoldDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(legalHolds)
      .where(eq(legalHolds.tenantId, tenantId))
      .orderBy(desc(legalHolds.createdAt));
    return rows.map(toHoldDto);
  });
}

export async function createLegalHold(
  db: DbExecutor,
  tenantId: string,
  input: CreateLegalHoldInput,
  actor: ArchiveActor,
): Promise<LegalHoldDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .insert(legalHolds)
      .values({
        tenantId,
        reason: input.reason,
        createdBy: actor.userId,
        protectedObjectId: input.protectedObjectId ?? null,
        scope: input.scope ?? null,
        active: true,
      })
      .returning();
    if (!row) {
      throw new Error("legal hold insert returned no row");
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.legal_hold.created",
      target: row.id,
      targetType: "legal_hold",
      ip: actor.ip,
      details: { reason: input.reason, protectedObjectId: input.protectedObjectId ?? null },
    });
    return toHoldDto(row);
  });
}

export async function releaseLegalHold(
  db: DbExecutor,
  tenantId: string,
  holdId: string,
  actor: ArchiveActor,
): Promise<LegalHoldDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .update(legalHolds)
      .set({ active: false, releasedAt: new Date() })
      .where(and(eq(legalHolds.id, holdId), eq(legalHolds.tenantId, tenantId)))
      .returning();
    if (!row) {
      throw new ProblemError(404, "Legal hold not found");
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.legal_hold.released",
      target: row.id,
      targetType: "legal_hold",
      ip: actor.ip,
      details: null,
    });
    return toHoldDto(row);
  });
}
