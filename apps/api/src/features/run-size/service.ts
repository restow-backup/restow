import {
  DEFAULT_RUN_SIZE_GUARD,
  DEFAULT_RUN_SPACE_RULE,
  parseRunSizeOverride,
  parseRunSpaceOverride,
  type RunSizeGuardOverride,
  type RunSizeGuardSettings,
  type RunSizeObjectKind,
  type RunSpaceOverride,
  type RunSpaceRule,
  resolveRunSizeGuard,
  resolveRunSpaceRule,
  runSizeLimit,
} from "@restow/core";
import {
  type Database,
  describeRunSizeObject,
  settings as installationSettings,
  type RunSizeHold,
  type RunSizeHoldResolution,
  type RunSizeTx,
  resolveRunSizeHolds,
  runSizeHistory,
  runSizeHolds,
  runSizeObjectExists,
  runSizeRuns,
  runSizeSettings,
  runSpaceOverrides,
  storageTargets,
} from "@restow/db";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
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
 *   settings        the tenant's or an object's override of the size defaults; switching the
 *                   guard off for an object ends its hold (audited `backup.size_guard_changed`)
 *   space rule      what a storage target keeps free: the installation's default, the tenant's
 *                   (on its own targets), a target's own (audited `backup.space_rule_changed`)
 *
 * The size rule warns by default (`mode: "warn"`): a run past its limit goes on with the notice
 * `backup.unusually_large_notice`, listed here as `notices`; `hold` holds it as below.
 *
 * "Continue once" lifts only the size rule: a hold for space ends when the target has room
 * again, or when its space rule is switched off.
 */

export const RUN_SIZE_AUDIT_ACTIONS = {
  continued: "backup.size_hold_continued",
  limitRaised: "backup.size_limit_raised",
  settingsChanged: "backup.size_guard_changed",
  spaceRuleChanged: "backup.space_rule_changed",
} as const;

export const RUN_SIZE_PROBLEMS = {
  holdNotOpen: "urn:restow:problem:run-size-hold-not-open",
  limitTooSmall: "urn:restow:problem:run-size-limit-too-small",
  notForSpace: "urn:restow:problem:run-size-raise-not-for-space",
  objectNotFound: "urn:restow:problem:run-size-object-not-found",
  continueNotForSpace: "urn:restow:problem:run-size-continue-not-for-space",
  spaceRuleInvalid: "urn:restow:problem:run-size-space-rule-invalid",
  targetNotFound: "urn:restow:problem:run-size-target-not-found",
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
 * A run that passed its size limit and went on (#99, `warn`, the default): no hold, a notice.
 * `mode` is what its object's size check does now (`hold` once an administrator switched it).
 */
export interface RunSizeNoticeDto {
  objectKind: RunSizeObjectKind;
  objectId: string;
  objectName: string;
  runId: string;
  bytes: number;
  limitBytes: number;
  medianBytes: number | null;
  noticedAt: string;
  mode: RunSizeGuardSettings["mode"];
  enabled: boolean;
}

/** How far back, and how many, notices Warnings lists. */
const NOTICE_DAYS = 30;
const NOTICE_LIMIT = 50;

/**
 * The tenant's open holds, oldest first, and the most recent decided ones. An open hold of an
 * object that is gone (a removed machine, a deleted share, guest or account) holds nothing: it
 * ends here (`object_removed`).
 */
export async function listRunSizeHolds(
  db: Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ open: RunSizeHoldDto[]; recent: RunSizeHoldDto[]; notices: RunSizeNoticeDto[] }> {
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
    return {
      open: open.map(toDto),
      recent: recent.map(toDto),
      notices: await recentNotices(tx, tenantId, now),
    };
  });
}

/**
 * The runs of the last {@link NOTICE_DAYS} days that passed their size limit and went on, newest
 * first, with what their object's size check does now. Objects that are gone are left out.
 */
async function recentNotices(
  tx: RunSizeTx,
  tenantId: string,
  now: Date,
): Promise<RunSizeNoticeDto[]> {
  const rows = await tx
    .select({
      objectKind: runSizeRuns.objectKind,
      objectId: runSizeRuns.objectId,
      runId: runSizeRuns.runId,
      noticedAt: runSizeRuns.noticedAt,
      notice: runSizeRuns.notice,
    })
    .from(runSizeRuns)
    .where(
      and(
        eq(runSizeRuns.tenantId, tenantId),
        isNotNull(runSizeRuns.noticedAt),
        gte(runSizeRuns.noticedAt, new Date(now.getTime() - NOTICE_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(runSizeRuns.noticedAt))
    .limit(NOTICE_LIMIT);
  const tenant = await storedOverride(tx, tenantId, null);
  const notices: RunSizeNoticeDto[] = [];
  for (const row of rows) {
    if (!row.notice || !row.noticedAt) continue;
    if (!(await runSizeObjectExists(tx, row.objectKind, row.objectId))) continue;
    const own = await storedOverride(tx, tenantId, {
      kind: row.objectKind,
      objectId: row.objectId,
    });
    const settings = resolveRunSizeGuard(tenant, own);
    notices.push({
      objectKind: row.objectKind,
      objectId: row.objectId,
      objectName: row.notice.objectName,
      runId: row.runId,
      bytes: row.notice.bytes,
      limitBytes: row.notice.limitBytes,
      medianBytes: row.notice.medianBytes,
      noticedAt: row.noticedAt.toISOString(),
      mode: settings.mode,
      enabled: settings.enabled,
    });
  }
  return notices;
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
    if (hold.reason === "space") {
      throw new ProblemError(422, "Not for a hold for space", {
        type: RUN_SIZE_PROBLEMS.continueNotForSpace,
        detail:
          "Continue once lifts the size check only. A backup held for space goes ahead once its storage target has room again, or once the target's space rule is switched off.",
      });
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
  const [existing] = await tx
    .select({ id: runSizeSettings.id, settings: runSizeSettings.settings })
    .from(runSizeSettings)
    .where(where);
  // The tenant's row also holds its space rule (`space`), which a size change keeps.
  const space = (existing?.settings as { space?: unknown } | undefined)?.space;
  const values = {
    settings: {
      ...(override as Record<string, unknown>),
      ...(!scope && space !== undefined ? { space } : {}),
    },
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

/** A space rule as an admin sees it: the override set at this level and what applies. */
export interface SpaceRuleView {
  override: RunSpaceOverride | null;
  effective: RunSpaceRule;
}

export interface RunSizeSettingsView {
  defaults: RunSizeGuardSettings;
  /** The tenant's override; null when it has none. */
  tenant: RunSizeGuardOverride | null;
  /** What applies to the tenant's objects without an override of their own. */
  effective: RunSizeGuardSettings;
  /**
   * The tenant's space rule: its override (on its own targets) over the installation's; whether
   * its current primary is the installation's shared default (where only the installation decides).
   */
  space: SpaceRuleView & {
    defaults: RunSpaceRule;
    installation: RunSpaceOverride;
    sharedTarget: boolean;
  };
  /** Objects with their own override, with the name they read with. */
  objects: {
    kind: RunSizeObjectKind;
    objectId: string;
    objectName: string;
    override: RunSizeGuardOverride;
    effective: RunSizeGuardSettings;
  }[];
}

/** The installation's space rule as a loader the tenant's transactions cannot read themselves. */
export type InstallationSpaceRule = () => Promise<RunSpaceOverride | null>;

function tenantSpaceOf(row: { settings: unknown } | undefined): RunSpaceOverride | null {
  const space = (row?.settings as { space?: unknown } | undefined)?.space;
  return space === undefined ? null : parseRunSpaceOverride(space);
}

export async function runSizeSettingsView(
  db: Database,
  tenantId: string,
  installationSpace?: InstallationSpaceRule,
): Promise<RunSizeSettingsView> {
  const installation = parseRunSpaceOverride(installationSpace ? await installationSpace() : null);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(runSizeSettings)
      .where(eq(runSizeSettings.tenantId, tenantId))
      .orderBy(runSizeSettings.createdAt);
    const tenantRow = rows.find((row) => row.objectKind === null);
    const tenant = tenantRow ? parseRunSizeOverride(tenantRow.settings) : null;
    const tenantSpace = tenantSpaceOf(tenantRow);
    const target = await runSpaceOverrides(tx, tenantId);
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
      space: {
        defaults: DEFAULT_RUN_SPACE_RULE,
        installation,
        override: tenantSpace,
        effective: resolveRunSpaceRule({
          installation,
          tenant: tenantSpace,
          sharedTarget: target.sharedTarget,
        }),
        sharedTarget: target.sharedTarget,
      },
      objects,
    };
  });
}

/** A merged space rule whose maximum is below its minimum is refused. */
function checkSpaceRule(rule: RunSpaceRule): void {
  if (rule.maxBytes < rule.minBytes) {
    throw new ProblemError(422, "Invalid space rule", {
      type: RUN_SIZE_PROBLEMS.spaceRuleInvalid,
      detail: "The most a target keeps free must not be less than the least it keeps free.",
    });
  }
}

/**
 * The open holds of `scope` (one object, or every object of the tenant) that the settings no
 * longer hold, ended: the size guard switched off (`guard_off`), a size hold whose run now fits
 * its limit, or a hold for space whose target's space rule is off (`settings_changed`). A hold for
 * space otherwise ends by itself once the target has room (the next run checks). Returns how many.
 */
async function reconsiderHolds(
  tx: RunSizeTx,
  tenantId: string,
  scope: { kind: RunSizeObjectKind; objectId: string } | null,
  installation: RunSpaceOverride | null,
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
  if (open.length === 0) {
    return 0;
  }
  const tenant = await storedOverride(tx, tenantId, null);
  const space = await runSpaceOverrides(tx, tenantId);
  const spaceRule = resolveRunSpaceRule({
    installation,
    tenant: space.tenant,
    target: space.target,
    sharedTarget: space.sharedTarget,
  });
  let ended = 0;
  for (const hold of open) {
    let resolution: "guard_off" | "settings_changed" | null = null;
    if (hold.reason === "space") {
      resolution = spaceRule.enabled ? null : "settings_changed";
    } else {
      const own = await storedOverride(tx, tenantId, {
        kind: hold.objectKind,
        objectId: hold.objectId,
      });
      const settings = resolveRunSizeGuard(tenant, own);
      if (!settings.enabled) {
        resolution = "guard_off";
      } else if (settings.mode === "warn") {
        // The object warns now instead of holding: a run past its limit goes on.
        resolution = "settings_changed";
      } else {
        const history = await runSizeHistory(
          tx,
          hold.objectKind,
          hold.objectId,
          settings.historyRuns,
        );
        const limit = runSizeLimit(settings, history).limitBytes;
        resolution = limit === null || hold.bytes <= limit ? "settings_changed" : null;
      }
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
 * Change the tenant's settings (`scope` null) or an object's. `override` (the size settings) is
 * merged into the stored one (a size given as null clears it; null clears them all); `space`
 * (the tenant's space rule, never an object's) likewise. The object must be the tenant's. Every
 * open hold the new settings no longer make ends.
 */
export async function updateRunSizeSettings(
  db: Database,
  tenantId: string,
  scope: { kind: RunSizeObjectKind; objectId: string } | null,
  input: { override?: RunSizeGuardOverride | null; space?: RunSpaceOverride | null },
  actor: RunSizeActor,
  now: Date = new Date(),
  installationSpace?: InstallationSpaceRule,
): Promise<RunSizeSettingsView> {
  const installation = parseRunSpaceOverride(installationSpace ? await installationSpace() : null);
  await withTenantTx(db, tenantId, async (tx) => {
    // Row Level Security pins the transaction to the tenant: another tenant's object is not found.
    if (scope && !(await runSizeObjectExists(tx, scope.kind, scope.objectId))) {
      throw new ProblemError(404, "Not found", {
        type: RUN_SIZE_PROBLEMS.objectNotFound,
        detail: "No such machine, file share, guest or account in this tenant.",
      });
    }
    const where = scope
      ? and(
          eq(runSizeSettings.tenantId, tenantId),
          eq(runSizeSettings.objectKind, scope.kind),
          eq(runSizeSettings.objectId, scope.objectId),
        )
      : and(eq(runSizeSettings.tenantId, tenantId), isNull(runSizeSettings.objectKind));
    const [row] = await tx.select().from(runSizeSettings).where(where);
    const before = row ? parseRunSizeOverride(row.settings) : null;
    const spaceBefore = scope ? null : tenantSpaceOf(row);
    const objectName = scope
      ? (await describeRunSizeObject(tx, scope.kind, scope.objectId)).name
      : null;
    const after =
      input.override === undefined
        ? before
        : input.override === null
          ? null
          : { ...(before ?? {}), ...parseRunSizeOverride(input.override) };
    const spaceAfter =
      scope || input.space === undefined
        ? spaceBefore
        : input.space === null
          ? null
          : { ...(spaceBefore ?? {}), ...parseRunSpaceOverride(input.space) };
    if (spaceAfter) {
      checkSpaceRule(
        resolveRunSpaceRule({ installation, tenant: spaceAfter, sharedTarget: false }),
      );
    }
    const stored = {
      ...(after ?? {}),
      ...(spaceAfter ? { space: spaceAfter } : {}),
    };
    if (after === null && spaceAfter === null) {
      await tx.delete(runSizeSettings).where(where);
    } else if (row) {
      await tx
        .update(runSizeSettings)
        .set({
          settings: stored,
          updatedByUserId: actor.userId,
          updatedBy: actor.label,
          updatedAt: now,
        })
        .where(eq(runSizeSettings.id, row.id));
    } else {
      await tx.insert(runSizeSettings).values({
        tenantId,
        objectKind: scope?.kind ?? null,
        objectId: scope?.objectId ?? null,
        settings: stored,
        updatedByUserId: actor.userId,
        updatedBy: actor.label,
      });
    }
    const resolved = await reconsiderHolds(tx, tenantId, scope, installation, now);
    if (input.override !== undefined) {
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
    }
    if (!scope && input.space !== undefined) {
      await audit(tx, {
        tenantId,
        actorUserId: actor.userId,
        actor: actor.label,
        action: RUN_SIZE_AUDIT_ACTIONS.spaceRuleChanged,
        target: tenantId,
        targetType: "tenant",
        ip: actor.ip,
        details: { scope: "tenant", before: spaceBefore, after: spaceAfter, holdsEnded: resolved },
      });
    }
  });
  return runSizeSettingsView(db, tenantId, installationSpace);
}

export interface TargetSpaceRuleDto extends SpaceRuleView {
  targetId: string;
  name: string | null;
  role: string;
}

/** The space rule of each of the tenant's own storage targets (where a target is set up). */
export async function targetSpaceRules(
  db: Database,
  tenantId: string,
  installationSpace?: InstallationSpaceRule,
): Promise<TargetSpaceRuleDto[]> {
  const installation = parseRunSpaceOverride(installationSpace ? await installationSpace() : null);
  return withTenantTx(db, tenantId, async (tx) => {
    const space = await runSpaceOverrides(tx, tenantId);
    const rows = await tx
      .select({
        id: storageTargets.id,
        name: storageTargets.name,
        role: storageTargets.role,
        spaceRule: storageTargets.spaceRule,
      })
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId))
      .orderBy(storageTargets.createdAt);
    return rows.map((row) => {
      const override = row.spaceRule ? parseRunSpaceOverride(row.spaceRule) : null;
      return {
        targetId: row.id,
        name: row.name,
        role: row.role,
        override,
        effective: resolveRunSpaceRule({
          installation,
          tenant: space.tenant,
          target: override,
          sharedTarget: false,
        }),
      };
    });
  });
}

/** Set (merged) or clear a storage target's own space rule; audited. */
export async function updateTargetSpaceRule(
  db: Database,
  tenantId: string,
  targetId: string,
  space: RunSpaceOverride | null,
  actor: RunSizeActor,
  now: Date = new Date(),
  installationSpace?: InstallationSpaceRule,
): Promise<TargetSpaceRuleDto[]> {
  const installation = parseRunSpaceOverride(installationSpace ? await installationSpace() : null);
  await withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: storageTargets.id,
        name: storageTargets.name,
        spaceRule: storageTargets.spaceRule,
      })
      .from(storageTargets)
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, targetId)))
      .for("update");
    if (!row) {
      throw new ProblemError(404, "Not found", {
        type: RUN_SIZE_PROBLEMS.targetNotFound,
        detail: "No such storage target in this tenant.",
      });
    }
    const before = row.spaceRule ? parseRunSpaceOverride(row.spaceRule) : null;
    const after = space === null ? null : { ...(before ?? {}), ...parseRunSpaceOverride(space) };
    if (after) {
      const tenantSpace = (await runSpaceOverrides(tx, tenantId)).tenant;
      checkSpaceRule(
        resolveRunSpaceRule({
          installation,
          tenant: tenantSpace,
          target: after,
          sharedTarget: false,
        }),
      );
    }
    await tx.update(storageTargets).set({ spaceRule: after }).where(eq(storageTargets.id, row.id));
    const resolved = await reconsiderHolds(tx, tenantId, null, installation, now);
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: RUN_SIZE_AUDIT_ACTIONS.spaceRuleChanged,
      target: row.id,
      targetType: "storage_target",
      ip: actor.ip,
      details: { scope: "target", targetName: row.name, before, after, holdsEnded: resolved },
    });
  });
  return targetSpaceRules(db, tenantId, installationSpace);
}

export interface InstallationSpaceRuleView extends SpaceRuleView {
  defaults: RunSpaceRule;
}

/** The installation's space rule (Installation › Database), on the installation pool. */
export async function installationSpaceRuleView(
  providerDb: Database,
): Promise<InstallationSpaceRuleView> {
  const [row] = await providerDb
    .select({ rule: installationSettings.runSpaceRule })
    .from(installationSettings)
    .limit(1);
  const override =
    row && Object.keys(row.rule ?? {}).length > 0 ? parseRunSpaceOverride(row.rule) : null;
  return {
    defaults: DEFAULT_RUN_SPACE_RULE,
    override,
    effective: resolveRunSpaceRule({ installation: override, sharedTarget: true }),
  };
}

/**
 * Set (merged) or clear the installation's space rule; audited in the installation's chain. A hold
 * for space whose rule is now off ends at once, in every tenant.
 */
export async function updateInstallationSpaceRule(
  providerDb: Database,
  space: RunSpaceOverride | null,
  actor: RunSizeActor,
  now: Date = new Date(),
): Promise<InstallationSpaceRuleView> {
  await providerDb.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: installationSettings.id, rule: installationSettings.runSpaceRule })
      .from(installationSettings)
      .limit(1)
      .for("update");
    if (!row) {
      throw new ProblemError(409, "Not set up", { detail: "The installation is not set up yet." });
    }
    const before = parseRunSpaceOverride(row.rule);
    const after = space === null ? {} : { ...before, ...parseRunSpaceOverride(space) };
    checkSpaceRule(resolveRunSpaceRule({ installation: after, sharedTarget: true }));
    await tx
      .update(installationSettings)
      .set({ runSpaceRule: after })
      .where(eq(installationSettings.id, row.id));
    // The installation pool sees every tenant: holds whose rule is off now end.
    const open = await tx
      .select({ tenantId: runSizeHolds.tenantId })
      .from(runSizeHolds)
      .where(and(eq(runSizeHolds.status, "pending"), eq(runSizeHolds.reason, "space")));
    let resolved = 0;
    for (const tenantId of new Set(open.map((hold) => hold.tenantId))) {
      resolved += await reconsiderHolds(tx, tenantId, null, after, now);
    }
    await audit(tx, {
      tenantId: null,
      actorUserId: actor.userId,
      actor: actor.label,
      action: RUN_SIZE_AUDIT_ACTIONS.spaceRuleChanged,
      target: "installation",
      targetType: "installation",
      ip: actor.ip,
      details: { scope: "installation", before, after, holdsEnded: resolved },
    });
  });
  return installationSpaceRuleView(providerDb);
}
