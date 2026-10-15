/**
 * The ransomware judgements of restore points (docs/RANSOMWARE.md) as the web app shows them,
 * the false alarm an administrator records, and the installation's thresholds.
 *
 * The worker judges (apps/worker/src/suspicion); this feature only reads the judgements and lets
 * an administrator call a finding a false alarm: the restore point then counts as clean, its
 * numbers join the object's baseline, and the next finding opens a new episode (and alert).
 * Taking a false alarm back makes the finding count again. Both are audited in the tenant's
 * chain; changing the thresholds is audited in the installation's.
 *
 * Retention hold (docs/RANSOMWARE.md, "Retention hold"): while an object has a suspicious restore
 * point that is neither a false alarm nor released, the worker's retention deletes none of its
 * restore points. An administrator ends it by calling the held findings a false alarm, or by
 * releasing the hold (a recent sign-in, audited `suspicion.hold_released`): the findings stay,
 * retention resumes, and the next finding opens a new episode and hold.
 */
import {
  DEFAULT_RANSOMWARE_SETTINGS,
  RANSOMWARE_SETTING_RANGES,
  RANSOMWARE_SIGNATURES_VERSION,
  type RansomwareSettings,
  resolveRansomwareSettings,
  type SuspicionObjectKind,
} from "@restow/core";
import {
  type Database,
  endpoints,
  fileShares,
  type RestorePointSuspicion,
  restorePointSuspicions,
  SUSPICION_HOLDS_SQL,
  settings,
  suspicionHolds,
} from "@restow/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { RansomwareSettingsInput } from "./schemas.js";

export const SUSPICION_AUDIT_ACTIONS = {
  falseAlarm: "suspicion.false_alarm",
  falseAlarmRevoked: "suspicion.false_alarm_revoked",
  holdReleased: "suspicion.hold_released",
} as const;

export const RANSOMWARE_SETTINGS_AUDIT_ACTIONS = {
  updated: "settings.ransomware.updated",
} as const;

/** The most judgements one object's list returns (newest first). */
export const MAX_LISTED_JUDGEMENTS = 500;

export interface SuspicionActor {
  userId: string;
  label: string;
  ip: string | null;
}

export interface SuspicionDto {
  id: string;
  objectKind: SuspicionObjectKind;
  objectId: string;
  runId: string;
  restorePointId: string;
  restorePointAt: string;
  verdict: "none" | "suspicious";
  /** Suspicious and nobody called it a false alarm. */
  active: boolean;
  findings: RestorePointSuspicion["findings"];
  signals: Record<string, string>;
  signaturesVersion: string;
  alerted: boolean;
  falseAlarm: { at: string; by: string | null; note: string | null } | null;
  /** Suspicious, no false alarm, its hold not released: it holds the object's retention. */
  holds: boolean;
  /** An administrator released the retention hold this restore point was part of. */
  holdReleased: { at: string; by: string | null; note: string | null } | null;
  judgedAt: string;
}

/** An object's open retention hold. */
export interface RetentionHoldDto {
  /** The oldest suspicious restore point that holds. */
  since: string;
  /** When the hold began (the first of them was judged). */
  heldAt: string;
  restorePoints: number;
  /** When the hold was last announced again (`backup.suspicious_hold`). */
  remindedAt: string | null;
  /** After how many days an unresolved hold is announced again. */
  reminderDays: number;
  /** What the object's repository takes now (machines and file shares); null when unknown. */
  storageBytes: number | null;
}

/** What the installation's settings say about the hold (`retentionHold`). */
export interface RetentionHoldSettings {
  enabled: boolean;
  reminderDays: number;
}

export interface ObjectSuspicionsDto {
  objectKind: SuspicionObjectKind;
  objectId: string;
  /** The newest judged restore point is suspicious (an episode is open). */
  open: boolean;
  /** The oldest restore point of the open episode. */
  openSince: string | null;
  /** The newest judged restore point that counts as clean. */
  lastClean: { restorePointId: string; restorePointAt: string } | null;
  /** Retention of the object is paused; null when it is not (or the hold is switched off). */
  hold: RetentionHoldDto | null;
  restorePoints: SuspicionDto[];
}

export interface OpenSuspicionDto {
  objectKind: SuspicionObjectKind;
  objectId: string;
  suspicionId: string;
  restorePointId: string;
  restorePointAt: string;
  findings: RestorePointSuspicion["findings"];
}

const NOT_FOUND = () => new ProblemError(404, "Restore point judgement not found");

function isActive(row: Pick<RestorePointSuspicion, "verdict" | "falseAlarmAt">): boolean {
  return row.verdict === "suspicious" && row.falseAlarmAt === null;
}

export function suspicionDto(row: RestorePointSuspicion): SuspicionDto {
  return {
    id: row.id,
    objectKind: row.objectKind,
    objectId: row.objectId,
    runId: row.runId,
    restorePointId: row.restorePointId,
    restorePointAt: row.restorePointAt.toISOString(),
    verdict: row.verdict,
    active: isActive(row),
    findings: row.findings,
    signals: row.signals,
    signaturesVersion: row.signaturesVersion,
    alerted: row.alertedAt !== null,
    falseAlarm: row.falseAlarmAt
      ? { at: row.falseAlarmAt.toISOString(), by: row.falseAlarmBy, note: row.falseAlarmNote }
      : null,
    holds: isActive(row) && row.holdReleasedAt === null,
    holdReleased: row.holdReleasedAt
      ? {
          at: row.holdReleasedAt.toISOString(),
          by: row.holdReleasedBy,
          note: row.holdReleaseNote,
        }
      : null,
    judgedAt: row.createdAt.toISOString(),
  };
}

/**
 * The episode state of an object from its judgements, newest first: open while the newest one is
 * active, since the oldest active one in a row; the last clean one is the newest that is not.
 */
export function episodeOf(
  rows: readonly RestorePointSuspicion[],
): Pick<ObjectSuspicionsDto, "open" | "openSince" | "lastClean"> {
  let openSince: string | null = null;
  for (const row of rows) {
    if (!isActive(row)) break;
    openSince = row.restorePointAt.toISOString();
  }
  const clean = rows.find((row) => !isActive(row));
  return {
    open: openSince !== null,
    openSince,
    lastClean: clean
      ? { restorePointId: clean.restorePointId, restorePointAt: clean.restorePointAt.toISOString() }
      : null,
  };
}

/** What the object's repository takes, where Restow measures it per object. */
async function storageOf(
  tx: DbExecutor,
  kind: SuspicionObjectKind,
  objectId: string,
): Promise<number | null> {
  if (kind === "endpoint") {
    const [row] = await tx
      .select({ bytes: endpoints.repositoryBytes })
      .from(endpoints)
      .where(eq(endpoints.id, objectId));
    return row?.bytes ?? null;
  }
  if (kind === "file_share") {
    const [row] = await tx
      .select({ bytes: fileShares.repositoryBytes })
      .from(fileShares)
      .where(eq(fileShares.id, objectId));
    return row?.bytes ?? null;
  }
  return null;
}

/** The object's open retention hold, or null. */
async function holdOf(
  tx: DbExecutor,
  tenantId: string,
  kind: SuspicionObjectKind,
  objectId: string,
  settings: RetentionHoldSettings,
): Promise<RetentionHoldDto | null> {
  if (!settings.enabled) {
    return null;
  }
  const hold = (await suspicionHolds(tx, { tenantId, kind, objectIds: [objectId] })).get(objectId);
  if (!hold) {
    return null;
  }
  return {
    since: hold.since.toISOString(),
    heldAt: hold.heldAt.toISOString(),
    restorePoints: hold.restorePoints,
    remindedAt: hold.remindedAt?.toISOString() ?? null,
    reminderDays: settings.reminderDays,
    storageBytes: await storageOf(tx, kind, objectId),
  };
}

/** The hold settings of the installation (read on the installation pool). */
export async function retentionHoldSettings(db: DbExecutor): Promise<RetentionHoldSettings> {
  return (await getRansomwareSettings(db)).settings.retentionHold;
}

/** The judgements of one object's restore points, newest first, its episode and its hold. */
export async function listObjectSuspicions(
  db: Database,
  tenantId: string,
  kind: SuspicionObjectKind,
  objectId: string,
  holdSettings: RetentionHoldSettings = DEFAULT_RANSOMWARE_SETTINGS.retentionHold,
): Promise<ObjectSuspicionsDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(restorePointSuspicions)
      .where(
        and(
          eq(restorePointSuspicions.tenantId, tenantId),
          eq(restorePointSuspicions.objectKind, kind),
          eq(restorePointSuspicions.objectId, objectId),
        ),
      )
      .orderBy(desc(restorePointSuspicions.restorePointAt))
      .limit(MAX_LISTED_JUDGEMENTS);
    return {
      objectKind: kind,
      objectId,
      ...episodeOf(rows),
      hold: await holdOf(tx, tenantId, kind, objectId, holdSettings),
      restorePoints: rows.map(suspicionDto),
    };
  });
}

/** The rows of an object's open hold, locked for the change. */
async function heldRows(
  tx: DbExecutor,
  tenantId: string,
  kind: SuspicionObjectKind,
  objectId: string,
): Promise<RestorePointSuspicion[]> {
  return tx
    .select()
    .from(restorePointSuspicions)
    .where(
      and(
        eq(restorePointSuspicions.tenantId, tenantId),
        eq(restorePointSuspicions.objectKind, kind),
        eq(restorePointSuspicions.objectId, objectId),
        SUSPICION_HOLDS_SQL,
      ),
    )
    .orderBy(asc(restorePointSuspicions.restorePointAt))
    .for("update");
}

const NO_HOLD = () =>
  new ProblemError(409, "No retention hold", {
    detail: "Retention of this object is not paused.",
  });

/**
 * Release an object's retention hold: retention resumes with its next run. The findings stay (the
 * restore points remain marked suspicious and out of the baseline); the next finding opens a new
 * episode and a new hold. Audited with every restore point it released. 409 without a hold.
 */
export async function releaseRetentionHold(
  db: Database,
  tenantId: string,
  kind: SuspicionObjectKind,
  objectId: string,
  note: string | null,
  actor: SuspicionActor,
  now: Date = new Date(),
  holdSettings: RetentionHoldSettings = DEFAULT_RANSOMWARE_SETTINGS.retentionHold,
): Promise<ObjectSuspicionsDto> {
  await withTenantTx(db, tenantId, async (tx) => {
    const rows = await heldRows(tx, tenantId, kind, objectId);
    if (rows.length === 0) {
      throw NO_HOLD();
    }
    const text = note && note.length > 0 ? note : null;
    await tx
      .update(restorePointSuspicions)
      .set({
        holdReleasedAt: now,
        holdReleasedByUserId: actor.userId,
        holdReleasedBy: actor.label,
        holdReleaseNote: text,
      })
      .where(
        inArray(
          restorePointSuspicions.id,
          rows.map((row) => row.id),
        ),
      );
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: SUSPICION_AUDIT_ACTIONS.holdReleased,
      target: objectId,
      // The audit log's own name for a mailbox, OneDrive, site or IMAP account.
      targetType: kind === "m365" ? "protected_object" : kind,
      ip: actor.ip,
      details: {
        objectKind: kind,
        objectId,
        heldSince: rows[0]?.restorePointAt.toISOString() ?? null,
        heldAt: rows
          .reduce((first, row) => (row.createdAt < first ? row.createdAt : first), now)
          .toISOString(),
        restorePoints: rows.map((row) => row.restorePointId),
        note: text,
      },
    });
  });
  return listObjectSuspicions(db, tenantId, kind, objectId, holdSettings);
}

/**
 * Call every finding that holds the object's retention a false alarm at once (the hold banner's
 * "Mark as false alarm"): each is audited like a single false alarm, and the hold ends.
 */
export async function markHoldFalseAlarm(
  db: Database,
  tenantId: string,
  kind: SuspicionObjectKind,
  objectId: string,
  note: string | null,
  actor: SuspicionActor,
  now: Date = new Date(),
  holdSettings: RetentionHoldSettings = DEFAULT_RANSOMWARE_SETTINGS.retentionHold,
): Promise<ObjectSuspicionsDto> {
  const ids = await withTenantTx(db, tenantId, async (tx) =>
    (await heldRows(tx, tenantId, kind, objectId)).map((row) => row.id),
  );
  if (ids.length === 0) {
    throw NO_HOLD();
  }
  for (const id of ids) {
    await markFalseAlarm(db, tenantId, id, note, actor, now);
  }
  return listObjectSuspicions(db, tenantId, kind, objectId, holdSettings);
}

/** The tenant's objects whose newest judged restore point is suspicious (an open episode). */
export async function listOpenSuspicions(
  db: Database,
  tenantId: string,
): Promise<{ objects: OpenSuspicionDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<{
      id: string;
      object_kind: SuspicionObjectKind;
      object_id: string;
      restore_point_id: string;
      restore_point_at: Date | string;
      verdict: string;
      false_alarm_at: Date | string | null;
      findings: RestorePointSuspicion["findings"];
    }>(sql`
      SELECT DISTINCT ON (object_kind, object_id)
        id, object_kind, object_id, restore_point_id, restore_point_at, verdict, false_alarm_at, findings
      FROM restore_point_suspicions
      WHERE tenant_id = ${tenantId}
      ORDER BY object_kind, object_id, restore_point_at DESC
    `);
    return {
      objects: result.rows
        .filter((row) => row.verdict === "suspicious" && row.false_alarm_at === null)
        .map((row) => ({
          objectKind: row.object_kind,
          objectId: row.object_id,
          suspicionId: row.id,
          restorePointId: row.restore_point_id,
          restorePointAt: new Date(row.restore_point_at).toISOString(),
          findings: row.findings,
        })),
    };
  });
}

/**
 * Record that a finding was a false alarm. Refused (409) for a restore point without findings;
 * marking one twice keeps the first mark.
 */
export async function markFalseAlarm(
  db: Database,
  tenantId: string,
  id: string,
  note: string | null,
  actor: SuspicionActor,
  now: Date = new Date(),
): Promise<SuspicionDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(restorePointSuspicions)
      .where(and(eq(restorePointSuspicions.tenantId, tenantId), eq(restorePointSuspicions.id, id)))
      .for("update");
    if (!row) {
      throw NOT_FOUND();
    }
    if (row.verdict !== "suspicious") {
      throw new ProblemError(409, "Nothing to call a false alarm", {
        detail: "This restore point has no findings.",
      });
    }
    if (row.falseAlarmAt !== null) {
      return suspicionDto(row);
    }
    const [updated] = await tx
      .update(restorePointSuspicions)
      .set({
        falseAlarmAt: now,
        falseAlarmByUserId: actor.userId,
        falseAlarmBy: actor.label,
        falseAlarmNote: note && note.length > 0 ? note : null,
      })
      .where(eq(restorePointSuspicions.id, id))
      .returning();
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: SUSPICION_AUDIT_ACTIONS.falseAlarm,
      target: id,
      targetType: "restore_point",
      ip: actor.ip,
      details: {
        objectKind: row.objectKind,
        objectId: row.objectId,
        restorePointId: row.restorePointId,
        restorePointAt: row.restorePointAt.toISOString(),
        findings: row.findings.map((finding) => finding.code),
        note: note && note.length > 0 ? note : null,
      },
    });
    return suspicionDto(updated as RestorePointSuspicion);
  });
}

/** Take a false alarm back: the finding counts again. 404 when there is none. */
export async function revokeFalseAlarm(
  db: Database,
  tenantId: string,
  id: string,
  actor: SuspicionActor,
): Promise<SuspicionDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(restorePointSuspicions)
      .where(and(eq(restorePointSuspicions.tenantId, tenantId), eq(restorePointSuspicions.id, id)))
      .for("update");
    if (!row || row.falseAlarmAt === null) {
      throw new ProblemError(404, "No false alarm to take back");
    }
    const [updated] = await tx
      .update(restorePointSuspicions)
      .set({
        falseAlarmAt: null,
        falseAlarmByUserId: null,
        falseAlarmBy: null,
        falseAlarmNote: null,
      })
      .where(eq(restorePointSuspicions.id, id))
      .returning();
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: SUSPICION_AUDIT_ACTIONS.falseAlarmRevoked,
      target: id,
      targetType: "restore_point",
      ip: actor.ip,
      details: {
        objectKind: row.objectKind,
        objectId: row.objectId,
        restorePointId: row.restorePointId,
        markedAt: row.falseAlarmAt.toISOString(),
        markedBy: row.falseAlarmBy,
        note: row.falseAlarmNote,
      },
    });
    return suspicionDto(updated as RestorePointSuspicion);
  });
}

// --- The installation's thresholds -----------------------------------------------------------

export interface RansomwareSettingsDto {
  /** What applies: the stored overrides over the defaults. */
  settings: RansomwareSettings;
  defaults: RansomwareSettings;
  ranges: typeof RANSOMWARE_SETTING_RANGES;
  signaturesVersion: string;
}

function settingsDto(stored: unknown): RansomwareSettingsDto {
  return {
    settings: resolveRansomwareSettings(stored),
    defaults: DEFAULT_RANSOMWARE_SETTINGS,
    ranges: RANSOMWARE_SETTING_RANGES,
    signaturesVersion: RANSOMWARE_SIGNATURES_VERSION,
  };
}

export async function getRansomwareSettings(db: DbExecutor): Promise<RansomwareSettingsDto> {
  const [row] = await db.select({ value: settings.ransomwareDetection }).from(settings).limit(1);
  return settingsDto(row?.value ?? {});
}

/**
 * Replace the stored thresholds with `input` (what is left out takes its default; `{}` is every
 * default). Audited in the installation's chain with the values before and after.
 */
export async function updateRansomwareSettings(
  db: Database,
  input: RansomwareSettingsInput,
  actor: { id: string; email: string; ip: string | null },
): Promise<RansomwareSettingsDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).limit(1).for("update");
    if (!row) {
      throw new ProblemError(409, "Setup not completed", {
        type: "urn:restow:problem:setup-incomplete",
        detail: "Finish the setup wizard before changing installation settings.",
      });
    }
    const stored = input as Record<string, unknown>;
    await tx.update(settings).set({ ransomwareDetection: stored }).where(eq(settings.id, row.id));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: RANSOMWARE_SETTINGS_AUDIT_ACTIONS.updated,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { before: row.ransomwareDetection, after: stored },
    });
    return settingsDto(stored);
  });
}
