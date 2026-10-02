import {
  type RetentionPreset,
  type RetentionTier,
  cutoffDays,
  jobRetentionAssignments,
  parseSnapshotPolicy,
  planRetentionRun,
  policyAppliesTo,
  totalBytes,
  withJobRetention,
} from "@restow/core";
import {
  type Database,
  type ProtectedObject,
  type RetentionPolicy,
  backupJobMembers,
  backupJobs,
  legalHolds,
  protectedObjects,
  retentionPolicies,
  snapshots,
  sources,
  verifyReports,
} from "@restow/db";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import {
  type CreateRetentionPolicyInput,
  type PreviewRetentionPolicyInput,
  type UpdateRetentionPolicyInput,
  resolveTiers,
  retentionPolicyProblem,
} from "./schemas.js";

/**
 * Snapshot retention policies: the tenant default (`protectedObjects: null`)
 * plus any number of per-object overrides. The tiered keep rule itself lives
 * in @restow/core (packages/core/src/retention) and is enforced by
 * apps/worker/src/handlers/retention.ts; this feature only manages the rows
 * and previews what the next run would do with `planRetentionRun`, the exact
 * function the worker runs, so the preview is never a guess.
 */

export const RETENTION_AUDIT_ACTIONS = {
  created: "retention_policy.created",
  updated: "retention_policy.updated",
  deleted: "retention_policy.deleted",
} as const;

export interface RetentionActor {
  userId: string | null;
  label: string;
  ip: string | null;
}

type ObjectRow = Pick<ProtectedObject, "id" | "displayName" | "externalId" | "kind">;

export interface RetentionScopeObjectDto {
  id: string;
  /** Display name, else the address or external id. */
  name: string;
  kind: ProtectedObject["kind"];
}

export interface RetentionPolicyDto {
  id: string;
  name: string;
  preset: RetentionPreset;
  tiers: readonly RetentionTier[];
  /** Age past which nothing survives; null = kept without an age limit. */
  cutoffDays: number | null;
  /** The tenant-wide policy (there is at most one); false for an object override. */
  isDefault: boolean;
  /** The objects an override is limited to; empty for the tenant-wide policy. */
  protectedObjects: RetentionScopeObjectDto[];
  createdAt: string;
  updatedAt: string;
}

export interface RetentionPolicyListDto {
  items: RetentionPolicyDto[];
  /** The recommended default rule, offered as the default preset when nothing exists yet. */
  recommendedPreset: RetentionPreset;
}

export interface RetentionPreviewDto {
  /** Objects at least one restore point would be removed from. */
  objects: number;
  /** Restore points the next run would remove. */
  restorePoints: number;
  /** Rough size of what would be removed, in bytes. */
  bytesLogical: number;
  /** Restore points that would otherwise be due, but a legal hold currently suspends. */
  heldRestorePoints: number;
}

const RECOMMENDED_PRESET: RetentionPreset = "default";

function iso(value: Date): string {
  return value.toISOString();
}

async function loadObjects(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<ObjectRow[]> {
  if (ids.length === 0) {
    return [];
  }
  return tx
    .select({
      id: protectedObjects.id,
      displayName: protectedObjects.displayName,
      externalId: protectedObjects.externalId,
      kind: protectedObjects.kind,
    })
    .from(protectedObjects)
    .where(and(eq(protectedObjects.tenantId, tenantId), inArray(protectedObjects.id, [...ids])));
}

function toObjectDto(object: ObjectRow): RetentionScopeObjectDto {
  const displayName = object.displayName?.trim();
  return {
    id: object.id,
    name: displayName && displayName.length > 0 ? displayName : object.externalId,
    kind: object.kind,
  };
}

/** Every protected object id exists in the tenant, or a 422 problem names the first missing one. */
async function assertObjectsExist(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<ObjectRow[]> {
  const found = await loadObjects(tx, tenantId, ids);
  const foundIds = new Set(found.map((object) => object.id));
  const missing = ids.find((id) => !foundIds.has(id));
  if (missing) {
    throw retentionPolicyProblem(
      "protectedObjectIds",
      "object_not_found",
      `Protected object ${missing} does not exist in this tenant.`,
    );
  }
  return found;
}

/** No two override policies may claim the same object; ambiguous otherwise. */
async function assertObjectsFree(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
  excludingPolicyId: string | null,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const rows = await tx
    .select({ id: retentionPolicies.id, appliesTo: retentionPolicies.appliesTo })
    .from(retentionPolicies)
    .where(
      excludingPolicyId
        ? and(eq(retentionPolicies.tenantId, tenantId), ne(retentionPolicies.id, excludingPolicyId))
        : eq(retentionPolicies.tenantId, tenantId),
    );
  const claimed = new Set<string>();
  for (const row of rows) {
    const scope = (row.appliesTo ?? {}) as Record<string, unknown>;
    if (scope.target !== "snapshots" || !Array.isArray(scope.protectedObjectIds)) {
      continue;
    }
    for (const id of scope.protectedObjectIds) {
      if (typeof id === "string") {
        claimed.add(id);
      }
    }
  }
  const conflict = ids.find((id) => claimed.has(id));
  if (conflict) {
    throw retentionPolicyProblem(
      "protectedObjectIds",
      "object_already_scoped",
      `Protected object ${conflict} already has its own retention policy.`,
    );
  }
}

/**
 * Serializes writes that check the one-default / one-override-per-object
 * rules against sibling rows before inserting or updating: without this, two
 * concurrent creates can both pass `assertNoOtherDefault` (or
 * `assertObjectsFree`) and each insert its own row, leaving two tenant
 * defaults (or two policies claiming the same object). Transaction-scoped
 * (`pg_advisory_xact_lock`), so it releases automatically at commit or
 * rollback and never leaks across requests.
 */
async function lockRetentionWrites(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`retention-policy:${tenantId}`}))`);
}

/**
 * At most one tenant-wide (default) *snapshot* policy; a second one must
 * edit the first instead. `retention_policies` also holds the archive
 * module's own default (same table, `applies_to.target` "archive"), which
 * must never block or be blocked by this one.
 */
async function assertNoOtherDefault(
  tx: Transaction,
  tenantId: string,
  excludingPolicyId: string | null,
): Promise<void> {
  const rows = await tx
    .select({
      id: retentionPolicies.id,
      isDefault: retentionPolicies.isDefault,
      appliesTo: retentionPolicies.appliesTo,
    })
    .from(retentionPolicies)
    .where(
      excludingPolicyId
        ? and(
            eq(retentionPolicies.tenantId, tenantId),
            eq(retentionPolicies.isDefault, true),
            ne(retentionPolicies.id, excludingPolicyId),
          )
        : and(eq(retentionPolicies.tenantId, tenantId), eq(retentionPolicies.isDefault, true)),
    );
  const snapshotDefault = rows.some(
    (row) => ((row.appliesTo ?? {}) as { target?: string }).target === "snapshots",
  );
  if (snapshotDefault) {
    throw retentionPolicyProblem(
      "protectedObjectIds",
      "default_exists",
      "This tenant already has a default retention policy; edit it instead of creating another.",
    );
  }
}

async function toPolicyDto(tx: Transaction, row: RetentionPolicy): Promise<RetentionPolicyDto> {
  const policy = parseSnapshotPolicy(row);
  if (!policy) {
    throw new Error(`retention_policies row ${row.id} does not carry a readable snapshots scope`);
  }
  const objects = await loadObjects(tx, row.tenantId, policy.protectedObjectIds ?? []);
  return {
    id: row.id,
    name: row.name,
    preset: (row.appliesTo as { preset?: RetentionPreset } | null)?.preset ?? "custom",
    tiers: policy.tiers,
    cutoffDays: cutoffDays(policy.tiers),
    isDefault: row.isDefault,
    protectedObjects: objects.map(toObjectDto),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * {@link toPolicyDto}, but for a row the list endpoint only reads (never one
 * this service just wrote itself): a row with a corrupt `applies_to` (not
 * even a flat cutoff the legacy fallback can make sense of) is left out of
 * the list instead of failing the whole page with a 500.
 */
async function toPolicyDtoOrSkip(
  tx: Transaction,
  row: RetentionPolicy,
): Promise<RetentionPolicyDto | null> {
  try {
    return await toPolicyDto(tx, row);
  } catch {
    return null;
  }
}

function auditEvent(
  tenantId: string,
  actor: RetentionActor,
  action: string,
  policyId: string,
  details: Record<string, unknown>,
) {
  return {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target: policyId,
    targetType: "retention_policy",
    ip: actor.ip,
    details,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listRetentionPolicies(
  db: Database,
  tenantId: string,
): Promise<RetentionPolicyListDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.tenantId, tenantId))
      .orderBy(asc(retentionPolicies.createdAt));
    const items: RetentionPolicyDto[] = [];
    for (const row of rows) {
      // A row for another target (the archive) never reaches this feature's list.
      if ((row.appliesTo as { target?: string } | null)?.target !== "snapshots") {
        continue;
      }
      const dto = await toPolicyDtoOrSkip(tx, row);
      if (dto) {
        items.push(dto);
      }
    }
    return { items, recommendedPreset: RECOMMENDED_PRESET };
  });
}

export async function createRetentionPolicy(
  db: Database,
  tenantId: string,
  input: CreateRetentionPolicyInput,
  actor: RetentionActor,
): Promise<RetentionPolicyDto> {
  const tiers = resolveTiers(input.preset, input.tiers);
  const isDefault = input.protectedObjectIds === null;
  return withTenantTx(db, tenantId, async (tx) => {
    await lockRetentionWrites(tx, tenantId);
    if (isDefault) {
      await assertNoOtherDefault(tx, tenantId, null);
    } else {
      await assertObjectsExist(tx, tenantId, input.protectedObjectIds ?? []);
      await assertObjectsFree(tx, tenantId, input.protectedObjectIds ?? [], null);
    }
    const [row] = await tx
      .insert(retentionPolicies)
      .values({
        tenantId,
        name: input.name,
        isDefault,
        appliesTo: policyAppliesTo(input.preset, tiers, input.protectedObjectIds),
      })
      .returning();
    if (!row) {
      throw new Error("retention policy insert returned no row");
    }
    await audit(
      tx,
      auditEvent(tenantId, actor, RETENTION_AUDIT_ACTIONS.created, row.id, {
        name: row.name,
        preset: input.preset,
        isDefault,
        protectedObjectIds: input.protectedObjectIds,
      }),
    );
    return toPolicyDto(tx, row);
  });
}

async function findPolicy(tx: Transaction, tenantId: string, id: string): Promise<RetentionPolicy> {
  const [row] = await tx
    .select()
    .from(retentionPolicies)
    .where(and(eq(retentionPolicies.tenantId, tenantId), eq(retentionPolicies.id, id)))
    .limit(1);
  if (!row || (row.appliesTo as { target?: string } | null)?.target !== "snapshots") {
    throw new ProblemError(404, "Retention policy not found");
  }
  return row;
}

export async function updateRetentionPolicy(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateRetentionPolicyInput,
  actor: RetentionActor,
): Promise<RetentionPolicyDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    await lockRetentionWrites(tx, tenantId);
    const before = await findPolicy(tx, tenantId, id);
    const beforeScope = (before.appliesTo ?? {}) as {
      preset?: RetentionPreset;
      tiers?: RetentionTier[];
      protectedObjectIds?: string[];
    };
    const preset = patch.preset ?? beforeScope.preset ?? "custom";
    // A row with no preset (saved before presets existed) has no
    // beforeScope.tiers either; parseSnapshotPolicy still reads it (its own
    // keepDays, or the plain years column) as the flat tiers it always
    // enforced, so a patch that does not touch the rule (a rename, say)
    // falls back to that instead of failing as an incomplete custom policy.
    const fallbackTiers = beforeScope.tiers ?? parseSnapshotPolicy(before)?.tiers;
    const tiers = resolveTiers(preset, patch.tiers ?? fallbackTiers);
    const protectedObjectIds =
      patch.protectedObjectIds !== undefined
        ? patch.protectedObjectIds
        : (beforeScope.protectedObjectIds ?? null);
    const isDefault = protectedObjectIds === null;
    if (isDefault) {
      await assertNoOtherDefault(tx, tenantId, id);
    } else {
      await assertObjectsExist(tx, tenantId, protectedObjectIds);
      await assertObjectsFree(tx, tenantId, protectedObjectIds, id);
    }
    const name = patch.name ?? before.name;
    const [row] = await tx
      .update(retentionPolicies)
      .set({
        name,
        isDefault,
        appliesTo: policyAppliesTo(preset, tiers, protectedObjectIds),
      })
      .where(and(eq(retentionPolicies.tenantId, tenantId), eq(retentionPolicies.id, id)))
      .returning();
    if (!row) {
      throw new ProblemError(404, "Retention policy not found");
    }
    await audit(
      tx,
      auditEvent(tenantId, actor, RETENTION_AUDIT_ACTIONS.updated, id, {
        name,
        preset,
        isDefault,
        protectedObjectIds,
      }),
    );
    return toPolicyDto(tx, row);
  });
}

export async function deleteRetentionPolicy(
  db: Database,
  tenantId: string,
  id: string,
  actor: RetentionActor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const before = await findPolicy(tx, tenantId, id);
    // A job that names the policy would silently fall back to the tenant default: refuse instead.
    const [named] = await tx
      .select({ name: backupJobs.name })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.retentionPolicyId, id)))
      .limit(1);
    if (named) {
      throw new ProblemError(409, "Retention policy in use", {
        type: "urn:restow:problem:retention-policy-in-use",
        detail: `The backup job "${named.name}" uses this retention policy. Choose another policy for the job first.`,
        extensions: { jobName: named.name },
      });
    }
    await tx
      .delete(retentionPolicies)
      .where(and(eq(retentionPolicies.tenantId, tenantId), eq(retentionPolicies.id, id)));
    await audit(
      tx,
      auditEvent(tenantId, actor, RETENTION_AUDIT_ACTIONS.deleted, id, {
        name: before.name,
        appliesTo: before.appliesTo,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * The restore point history the retention rule needs, exactly as
 * apps/worker/src/handlers/retention.ts loads it: completed, active
 * snapshots with a manifest (never an in-flight backup, which has neither
 * yet) and whether a check ever rated that exact one green (docs/TESTING.md).
 * Kept local to this feature (not shared with the worker, which lives in a
 * different app) so each side stays a plain database read — the filters must
 * still match exactly, or the preview and the run it previews can disagree
 * (see the parity test in retention.pg.test.ts).
 */
async function loadSnapshotHistory(tx: Transaction, tenantId: string) {
  const rows = await tx
    .select({
      id: snapshots.id,
      protectedObjectId: snapshots.protectedObjectId,
      sequence: snapshots.sequence,
      byteSize: snapshots.byteSize,
      completedAt: snapshots.completedAt,
    })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.status, "active"),
        isNotNull(snapshots.manifestPath),
      ),
    );
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const verifiedRows = await tx
    .selectDistinct({ snapshotId: verifyReports.snapshotId })
    .from(verifyReports)
    .where(
      and(
        eq(verifyReports.tenantId, tenantId),
        inArray(verifyReports.snapshotId, ids),
        eq(verifyReports.recoveryReadiness, "green"),
      ),
    );
  const verified = new Set(verifiedRows.flatMap((row) => (row.snapshotId ? [row.snapshotId] : [])));
  return rows.map((row) => ({ ...row, verified: verified.has(row.id) }));
}

async function loadLegalHoldScope(tx: Transaction, tenantId: string) {
  const rows = await tx
    .select({ protectedObjectId: legalHolds.protectedObjectId })
    .from(legalHolds)
    .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true)));
  const ids = new Set<string>();
  let tenantWide = false;
  for (const row of rows) {
    if (row.protectedObjectId === null) {
      tenantWide = true;
    } else {
      ids.add(row.protectedObjectId);
    }
  }
  return { tenantWide, protectedObjectIds: ids };
}

/** The policies mail jobs name, with the objects of each job (the worker's `loadJobRetention`). */
async function loadJobRetentionAssignments(tx: Transaction, tenantId: string) {
  const named = await tx
    .select({
      id: backupJobs.id,
      scopeMode: backupJobs.scopeMode,
      retentionPolicyId: backupJobs.retentionPolicyId,
    })
    .from(backupJobs)
    .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "mail")));
  if (!named.some((job) => job.retentionPolicyId !== null)) {
    return [];
  }
  const members = await tx
    .select({
      jobId: backupJobMembers.jobId,
      protectedObjectId: backupJobMembers.protectedObjectId,
    })
    .from(backupJobMembers)
    .where(eq(backupJobMembers.tenantId, tenantId));
  const objects = await tx
    .select({ id: protectedObjects.id, sourceKind: sources.kind })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .where(eq(protectedObjects.tenantId, tenantId));
  return jobRetentionAssignments(
    named,
    members.flatMap((member) =>
      member.protectedObjectId
        ? [{ jobId: member.jobId, protectedObjectId: member.protectedObjectId }]
        : [],
    ),
    objects.map((object) => ({ id: object.id, imported: object.sourceKind === "import" })),
  );
}

/**
 * What the next retention run would remove if `input` were saved as given,
 * computed with {@link planRetentionRun} — the exact function the worker
 * runs — against the tenant's real restore point history. The draft
 * substitutes for the policy it would become (its own row when `input.id`
 * names one, otherwise an addition); every other saved policy still applies
 * to the objects it already covers.
 */
export async function previewRetentionPolicy(
  db: Database,
  tenantId: string,
  input: PreviewRetentionPolicyInput,
  now: Date,
): Promise<RetentionPreviewDto> {
  const tiers = resolveTiers(input.preset, input.tiers);
  return withTenantTx(db, tenantId, async (tx) => {
    if (input.protectedObjectIds) {
      await assertObjectsExist(tx, tenantId, input.protectedObjectIds);
      // Same guard the actual save would enforce: without it, a draft that
      // targets an object another policy already scopes would silently
      // preview under that OTHER policy's numbers (resolvePolicyFor picks
      // the first scoped match, and the existing policy is listed before the
      // draft below) instead of surfacing the conflict the save will fail
      // with.
      await assertObjectsFree(tx, tenantId, input.protectedObjectIds, input.id ?? null);
    }
    // Ordered the same way the worker loads policies, so resolvePolicyFor's
    // "first tenant-wide policy" fallback picks the same one on both sides.
    const rows = await tx
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.tenantId, tenantId))
      .orderBy(asc(retentionPolicies.createdAt));
    const existing = rows
      .filter((row) => row.id !== input.id)
      .map((row) => parseSnapshotPolicy(row))
      .filter((policy) => policy !== null);
    const draft = {
      policyId: input.id ?? "draft",
      tiers,
      protectedObjectIds: input.protectedObjectIds,
      isDefault: input.protectedObjectIds === null,
    };
    const history = await loadSnapshotHistory(tx, tenantId);
    const holds = await loadLegalHoldScope(tx, tenantId);
    // The objects of a job that names a policy follow it, exactly as in the worker's run.
    const policies = withJobRetention(
      [...existing, draft],
      await loadJobRetentionAssignments(tx, tenantId),
    );
    const plan = planRetentionRun(history, policies, holds, now);
    return {
      objects: new Set(plan.expired.map((snapshot) => snapshot.protectedObjectId)).size,
      restorePoints: plan.expired.length,
      bytesLogical: totalBytes(plan.expired),
      heldRestorePoints: plan.held.length,
    };
  });
}
