import {
  DEFAULT_RUN_SIZE_GUARD,
  parseRunSizeOverride,
  type RunSizeGuardOverride,
  type RunSizeGuardSettings,
  type RunSizeObjectKind,
  resolveRunSizeGuard,
  runSizeLimit,
} from "@restow/core";
import {
  type Database,
  describeRunSizeObject,
  type RunSizeHold,
  type RunSizeHoldResolution,
  type RunSizeTx,
  resolveRunSizeHolds,
  runSizeHistory,
  runSizeHolds,
  runSizeObjectExists,
  runSizeSettings,
} from "@restow/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * The backups the size and space guard held, and its settings (#99, docs/STORAGE.md "Unusually
 * large runs"). The guard itself runs where the bytes are counted (@restow/db run-size.ts: the
 * api's restic routes, the worker's chunk store); here an administrator decides:
 *
 *   continue once   the next run of the object goes through without the check (audited
 *                   `backup.size_hold_continued`); the run that uses it closes the hold
 *   raise the limit the object's own limit becomes the given size, the hold ends (audited
 *                   `backup.size_limit_raised`)
 *   settings        the tenant's or an object's override of the defaults; switching the guard
 *                   off for an object ends its hold (audited `backup.size_guard_changed`)
 */

export const RUN_SIZE_AUDIT_ACTIONS = {
  continued: "backup.size_hold_continued",
  limitRaised: "backup.size_limit_raised",
  settingsChanged: "backup.size_guard_changed",
} as const;

export const RUN_SIZE_PROBLEMS = {
  holdNotOpen: "urn:restow:problem:run-size-hold-not-open",
  limitTooSmall: "urn:restow:problem:run-size-limit-too-small",
  notForSpace: "urn:restow:problem:run-size-raise-not-for-space",
  objectNotFound: "urn:restow:problem:run-size-object-not-found",
} as const;

export interface RunSizeActor {
  userId: string;
  label: string;
  ip: string | null;
}

export interface RunSizeHoldDto {
  id: string;
  objectKind: RunSizeObjectKind;
  objectId: string;
  objectName: string;
  runId: string | null;
  reason: "size" | "space";
  status: "pending" | "approved" | "resolved";
  bytes: number;
  limitBytes: number | null;
  medianBytes: number | null;
  historyRuns: number;
  freeBytes: number | null;
  totalBytes: number | null;
  refusedRuns: number;
  heldAt: string;
  lastRefusedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  note: string | null;
  resolution: RunSizeHoldResolution | null;
  resolvedAt: string | null;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toDto(row: RunSizeHold): RunSizeHoldDto {
  return {
    id: row.id,
    objectKind: row.objectKind,
    objectId: row.objectId,
    objectName: row.objectName,
    runId: row.runId,
    reason: row.reason,
    status: row.status,
    bytes: row.bytes,
    limitBytes: row.limitBytes,
    medianBytes: row.medianBytes,
    historyRuns: row.historyRuns,
    freeBytes: row.freeBytes,
    totalBytes: row.totalBytes,
    refusedRuns: row.refusedRuns,
    heldAt: row.createdAt.toISOString(),
    lastRefusedAt: iso(row.lastRefusedAt),
    approvedAt: iso(row.approvedAt),
    approvedBy: row.approvedBy,
    note: row.note,
    resolution: row.resolution,
    resolvedAt: iso(row.resolvedAt),
  };
}

/** How many decided holds the page shows below the open ones. */
const RECENT_RESOLVED = 20;

/**
 * The tenant's open holds, oldest first, and the most recent decided ones. An open hold of an
 * object that is gone (a removed machine, a deleted share, guest or account) holds nothing: it
 * ends here (`object_removed`).
 */
export async function listRunSizeHolds(
  db: Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ open: RunSizeHoldDto[]; recent: RunSizeHoldDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const candidates = await tx
      .select({
        id: runSizeHolds.id,
        kind: runSizeHolds.objectKind,
        objectId: runSizeHolds.objectId,
      })
      .from(runSizeHolds)
      .where(
        and(
          eq(runSizeHolds.tenantId, tenantId),
          inArray(runSizeHolds.status, ["pending", "approved"]),
        ),
      );
    for (const candidate of candidates) {
      if (!(await runSizeObjectExists(tx, candidate.kind, candidate.objectId))) {
        await tx
          .update(runSizeHolds)
          .set({ status: "resolved", resolution: "object_removed", resolvedAt: now })
          .where(eq(runSizeHolds.id, candidate.id));
      }
    }
    const open = await tx
      .select()
      .from(runSizeHolds)
      .where(
        and(
          eq(runSizeHolds.tenantId, tenantId),
          inArray(runSizeHolds.status, ["pending", "approved"]),
        ),
      )
      .orderBy(runSizeHolds.createdAt);
    const recent = await tx
      .select()
      .from(runSizeHolds)
      .where(and(eq(runSizeHolds.tenantId, tenantId), eq(runSizeHolds.status, "resolved")))
      .orderBy(desc(runSizeHolds.resolvedAt))
      .limit(RECENT_RESOLVED);
    return { open: open.map(toDto), recent: recent.map(toDto) };
  });
}

/** The number of open holds (the menu badge). */
export async function countOpenRunSizeHolds(db: Database, tenantId: string): Promise<number> {
  const { open } = await listRunSizeHolds(db, tenantId);
  return open.filter((hold) => hold.status === "pending").length;
}

async function lockedHold(tx: Transaction, tenantId: string, id: string): Promise<RunSizeHold> {
  const [row] = await tx
    .select()
    .from(runSizeHolds)
    .where(and(eq(runSizeHolds.tenantId, tenantId), eq(runSizeHolds.id, id)))
    .for("update");
  if (!row) {
    throw new ProblemError(404, "Not found", { detail: "No such held backup." });
  }
  return row;
}

function notOpen(): ProblemError {
  return new ProblemError(409, "Already decided", {
    type: RUN_SIZE_PROBLEMS.holdNotOpen,
    detail: "This held backup was decided already.",
  });
}

function targetTypeOf(kind: RunSizeObjectKind): string {
  // The audit log's own name for a mailbox, OneDrive, site or IMAP account.
  return kind === "m365" ? "protected_object" : kind;
}

/** Continue once: the next run of the object goes through without the check. */
export async function continueRunSizeHold(
  db: Database,
  tenantId: string,
  id: string,
  note: string | null,
  actor: RunSizeActor,
  now: Date = new Date(),
): Promise<RunSizeHoldDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const hold = await lockedHold(tx, tenantId, id);
    if (hold.status !== "pending") {
      throw notOpen();
    }
    const [updated] = await tx
      .update(runSizeHolds)
      .set({
        status: "approved",
        approvedAt: now,
        approvedByUserId: actor.userId,
        approvedBy: actor.label,
        note,
      })
      .where(eq(runSizeHolds.id, id))
      .returning();
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: RUN_SIZE_AUDIT_ACTIONS.continued,
      target: hold.objectId,
      targetType: targetTypeOf(hold.objectKind),
      ip: actor.ip,
      details: {
        holdId: hold.id,
        objectKind: hold.objectKind,
        objectName: hold.objectName,
        reason: hold.reason,
        bytes: hold.bytes,
        limitBytes: hold.limitBytes,
        medianBytes: hold.medianBytes,
        note,
      },
    });
    return toDto(updated as RunSizeHold);
  });
}

async function writeOverride(
  tx: RunSizeTx,
  tenantId: string,
  scope: { kind: RunSizeObjectKind; objectId: string } | null,
  override: RunSizeGuardOverride,
  actor: RunSizeActor,
  now: Date,
): Promise<void> {
  const where = scope
    ? and(
        eq(runSizeSettings.tenantId, tenantId),
        eq(runSizeSettings.objectKind, scope.kind),
        eq(runSizeSettings.objectId, scope.objectId),
      )
    : and(eq(runSizeSettings.tenantId, tenantId), isNull(runSizeSettings.objectKind));
  const [existing] = await tx.select({ id: runSizeSettings.id }).from(runSizeSettings).where(where);
  const values = {
    settings: override as Record<string, unknown>,
    updatedByUserId: actor.userId,
    updatedBy: actor.label,
    updatedAt: now,
  };
  if (existing) {
    await tx.update(runSizeSettings).set(values).where(eq(runSizeSettings.id, existing.id));
    return;
  }
  await tx.insert(runSizeSettings).values({
    tenantId,
    objectKind: scope?.kind ?? null,
    objectId: scope?.objectId ?? null,
    ...values,
  });
}

async function storedOverride(
  tx: RunSizeTx,
  tenantId: string,
  scope: { kind: RunSizeObjectKind; objectId: string } | null,
): Promise<RunSizeGuardOverride | null> {
  const rows = await tx
    .select({
      objectKind: runSizeSettings.objectKind,
      objectId: runSizeSettings.objectId,
      settings: runSizeSettings.settings,
    })
    .from(runSizeSettings)
    .where(eq(runSizeSettings.tenantId, tenantId));
  const row = rows.find((candidate) =>
    scope
      ? candidate.objectKind === scope.kind && candidate.objectId === scope.objectId
      : candidate.objectKind === null,
  );
  return row ? parseRunSizeOverride(row.settings) : null;
}

/** Raise the object's own limit to `limitBytes`; the hold ends. */
export async function raiseRunSizeLimit(
  db: Database,
  tenantId: string,
  id: string,
  limitBytes: number,
  actor: RunSizeActor,
  now: Date = new Date(),
): Promise<RunSizeHoldDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const hold = await lockedHold(tx, tenantId, id);
    if (hold.status !== "pending" && hold.status !== "approved") {
      throw notOpen();
    }
    if (hold.reason === "space") {
      // A size limit does not make room on the target: the hold ends by itself once there is
      // room (the next run checks), or continue once.
      throw new ProblemError(422, "Not a size hold", {
        type: RUN_SIZE_PROBLEMS.notForSpace,
        detail: "This backup was held for the free space of its storage target, not for its size.",
      });
    }
    if (limitBytes <= hold.bytes) {
      throw new ProblemError(422, "Limit too small", {
        type: RUN_SIZE_PROBLEMS.limitTooSmall,
        detail: "The new limit must be larger than what the held run added.",
      });
    }
    const scope = { kind: hold.objectKind, objectId: hold.objectId };
    const before = (await storedOverride(tx, tenantId, scope)) ?? {};
    await writeOverride(tx, tenantId, scope, { ...before, limitBytes }, actor, now);
    await resolveRunSizeHolds(tx, hold.objectKind, hold.objectId, "limit_raised", now);
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: RUN_SIZE_AUDIT_ACTIONS.limitRaised,
      target: hold.objectId,
      targetType: targetTypeOf(hold.objectKind),
      ip: actor.ip,
      details: {
        holdId: hold.id,
        objectKind: hold.objectKind,
        objectName: hold.objectName,
        bytes: hold.bytes,
        previousLimitBytes: before.limitBytes ?? null,
        limitBytes,
      },
    });
    const [row] = await tx.select().from(runSizeHolds).where(eq(runSizeHolds.id, id));
    return toDto(row as RunSizeHold);
  });
}

export interface RunSizeSettingsView {
  defaults: RunSizeGuardSettings;
  /** The tenant's override; null when it has none. */
  tenant: RunSizeGuardOverride | null;
  /** What applies to the tenant's objects without an override of their own. */
  effective: RunSizeGuardSettings;
  /** Objects with their own override, with the name they read with. */
  objects: {
    kind: RunSizeObjectKind;
    objectId: string;
    objectName: string;
    override: RunSizeGuardOverride;
    effective: RunSizeGuardSettings;
  }[];
}

export async function runSizeSettingsView(
  db: Database,
  tenantId: string,
): Promise<RunSizeSettingsView> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(runSizeSettings)
      .where(eq(runSizeSettings.tenantId, tenantId))
      .orderBy(runSizeSettings.createdAt);
    const tenantRow = rows.find((row) => row.objectKind === null);
    const tenant = tenantRow ? parseRunSizeOverride(tenantRow.settings) : null;
    const objects: RunSizeSettingsView["objects"] = [];
    for (const row of rows) {
      if (row.objectKind === null || row.objectId === null) {
        continue;
      }
      const override = parseRunSizeOverride(row.settings);
      objects.push({
        kind: row.objectKind,
        objectId: row.objectId,
        objectName: (await describeRunSizeObject(tx, row.objectKind, row.objectId)).name,
        override,
        effective: resolveRunSizeGuard(tenant, override),
      });
    }
    return {
      defaults: DEFAULT_RUN_SIZE_GUARD,
      tenant,
      effective: resolveRunSizeGuard(tenant),
      objects,
    };
  });
}

/**
 * The open holds of `scope` (one object, or every object of the tenant) that its settings no
 * longer hold, ended: the guard switched off (`guard_off`), a size hold whose run now fits its
 * limit, or a space hold whose free share was switched off (`settings_changed`). A space hold
 * otherwise ends by itself once the target has room (the next run checks). Returns how many.
 */
async function reconsiderHolds(
  tx: Transaction,
  tenantId: string,
  scope: { kind: RunSizeObjectKind; objectId: string } | null,
  now: Date,
): Promise<number> {
  const open = await tx
    .select()
    .from(runSizeHolds)
    .where(
      and(
        eq(runSizeHolds.tenantId, tenantId),
        eq(runSizeHolds.status, "pending"),
        scope ? eq(runSizeHolds.objectKind, scope.kind) : undefined,
        scope ? eq(runSizeHolds.objectId, scope.objectId) : undefined,
      ),
    );
  const tenant = await storedOverride(tx, tenantId, null);
  let ended = 0;
  for (const hold of open) {
    const own = await storedOverride(tx, tenantId, {
      kind: hold.objectKind,
      objectId: hold.objectId,
    });
    const settings = resolveRunSizeGuard(tenant, own);
    let resolution: "guard_off" | "settings_changed" | null = null;
    if (!settings.enabled) {
      resolution = "guard_off";
    } else if (hold.reason === "size") {
      const history = await runSizeHistory(
        tx,
        hold.objectKind,
        hold.objectId,
        settings.historyRuns,
      );
      const limit = runSizeLimit(settings, history).limitBytes;
      resolution = limit === null || hold.bytes <= limit ? "settings_changed" : null;
    } else if (settings.minFreePercent === 0) {
      resolution = "settings_changed";
    }
    if (resolution) {
      await tx
        .update(runSizeHolds)
        .set({ status: "resolved", resolution, resolvedAt: now })
        .where(and(eq(runSizeHolds.id, hold.id), eq(runSizeHolds.status, "pending")));
      ended++;
    }
  }
  return ended;
}

/**
 * Change the tenant's override (`scope` null) or an object's: what is given is merged into the
 * stored one (a size given as null clears it); `override` null clears the whole override. The
 * object must be the tenant's. Every open hold the new settings no longer hold ends.
 */
export async function updateRunSizeSettings(
  db: Database,
  tenantId: string,
  scope: { kind: RunSizeObjectKind; objectId: string } | null,
  override: RunSizeGuardOverride | null,
  actor: RunSizeActor,
  now: Date = new Date(),
): Promise<RunSizeSettingsView> {
  await withTenantTx(db, tenantId, async (tx) => {
    // Row Level Security pins the transaction to the tenant: another tenant's object is not found.
    if (scope && !(await runSizeObjectExists(tx, scope.kind, scope.objectId))) {
      throw new ProblemError(404, "Not found", {
        type: RUN_SIZE_PROBLEMS.objectNotFound,
        detail: "No such machine, file share, guest or account in this tenant.",
      });
    }
    const before = await storedOverride(tx, tenantId, scope);
    const objectName = scope
      ? (await describeRunSizeObject(tx, scope.kind, scope.objectId)).name
      : null;
    const after =
      override === null ? null : { ...(before ?? {}), ...parseRunSizeOverride(override) };
    if (after === null) {
      await tx
        .delete(runSizeSettings)
        .where(
          scope
            ? and(
                eq(runSizeSettings.tenantId, tenantId),
                eq(runSizeSettings.objectKind, scope.kind),
                eq(runSizeSettings.objectId, scope.objectId),
              )
            : and(eq(runSizeSettings.tenantId, tenantId), isNull(runSizeSettings.objectKind)),
        );
    } else {
      await writeOverride(tx, tenantId, scope, after, actor, now);
    }
    const resolved = await reconsiderHolds(tx, tenantId, scope, now);
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: RUN_SIZE_AUDIT_ACTIONS.settingsChanged,
      target: scope?.objectId ?? tenantId,
      targetType: scope ? targetTypeOf(scope.kind) : "tenant",
      ip: actor.ip,
      details: {
        scope: scope ? "object" : "tenant",
        objectKind: scope?.kind ?? null,
        objectName,
        before,
        after,
        holdsEnded: resolved,
      },
    });
  });
  return runSizeSettingsView(db, tenantId);
}
