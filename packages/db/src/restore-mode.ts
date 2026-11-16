import { type SQL, sql } from "drizzle-orm";
import type { Queryable } from "./roles.js";
import type {
  KeyMirrorFindingKind,
  RestoreModeActor,
  RestoreModeDetection,
  RestoreModeSource,
  StorageProgressOutcome,
} from "./schema/restore-mode.js";

/**
 * Restore mode after restoring a database dump (schema/restore-mode.ts), as the worker, the
 * scheduler, the api and the command line read and write it. Every function runs on the
 * installation pool (or a transaction of it). A database without the tables yet (a process
 * that started before the migration ran) is not in restore mode.
 */

/** Postgres' "undefined_table". */
const UNDEFINED_TABLE = "42P01";

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

export interface RestoreModeState {
  readonly active: boolean;
  readonly id: string | null;
  readonly source: RestoreModeSource | null;
  readonly reason: string | null;
  readonly activatedAt: Date | null;
  readonly activatedBy: RestoreModeActor | null;
  /** Jobs created before this are held. */
  readonly holdJobsBefore: Date | null;
  readonly detection: RestoreModeDetection | null;
  /**
   * The newest `keep_unknown_before` of an ended restore mode: data the database does not know
   * and that is older than this is kept for good. Null when none was ended with "keep".
   */
  readonly keepUnknownBefore: Date | null;
}

export const RESTORE_MODE_OFF: RestoreModeState = {
  active: false,
  id: null,
  source: null,
  reason: null,
  activatedAt: null,
  activatedBy: null,
  holdJobsBefore: null,
  detection: null,
  keepUnknownBefore: null,
};

interface ActiveRow extends Record<string, unknown> {
  id: string;
  source: RestoreModeSource;
  reason: string | null;
  activated_at: Date;
  activated_by: RestoreModeActor;
  hold_jobs_before: Date;
  detection: RestoreModeDetection | null;
}

const asDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string);

/** The active restore mode, if any, and the keep floor of the ended ones. */
export async function readRestoreMode(db: Queryable): Promise<RestoreModeState> {
  let active: ActiveRow | undefined;
  let floor: Date | null = null;
  try {
    const { rows } = await db.query<ActiveRow>(
      `SELECT id::text AS id, source, reason, activated_at, activated_by, hold_jobs_before, detection
         FROM installation_restore_mode WHERE ended_at IS NULL LIMIT 1`,
    );
    active = rows[0];
    const kept = await db.query<{ floor: Date | null }>(
      `SELECT max(keep_unknown_before) AS floor FROM installation_restore_mode
        WHERE ended_at IS NOT NULL AND storage_only_data = 'keep'`,
    );
    floor = asDate(kept.rows[0]?.floor ?? null);
  } catch (error) {
    if (isUndefinedTable(error)) {
      return RESTORE_MODE_OFF;
    }
    throw error;
  }
  if (!active) {
    return { ...RESTORE_MODE_OFF, keepUnknownBefore: floor };
  }
  return {
    active: true,
    id: active.id,
    source: active.source,
    reason: active.reason,
    activatedAt: asDate(active.activated_at),
    activatedBy: active.activated_by,
    holdJobsBefore: asDate(active.hold_jobs_before),
    detection: active.detection,
    keepUnknownBefore: floor,
  };
}

export interface ActivateRestoreModeInput {
  readonly source: RestoreModeSource;
  readonly reason: string | null;
  readonly actor: RestoreModeActor;
  readonly detection?: RestoreModeDetection | null;
  readonly now?: Date;
  /**
   * Jobs created before this are held. Defaults to the activation (`now`): right for the command
   * line, which runs before the worker and the scheduler start. A detection passes
   * {@link detectedHoldBoundary}: by then the scheduler and the api may have queued new backups.
   */
  readonly holdJobsBefore?: Date;
}

/** A heartbeat older than this belongs to a process that no longer runs (heartbeat.ts). */
const ALIVE_SECONDS = 120;

/**
 * Where a detected restore mode's job hold ends: the start of the processes of the restored
 * database's timeline, not the moment of the detection (the scheduler queues overdue backups on
 * its first tick, and a detection may come minutes or days later). The earliest start among the
 * processes that beat now (`service_heartbeats`, the scheduler's and the workers'), the
 * activating process's own start and the database clock, whichever is earliest; never before the
 * newest beat of a process that no longer beats (the rows that came with the dump), so a
 * process that kept running across the restore cannot pull it into the dump's time.
 *
 * Jobs from the dump were created before the dump, and the dump's heartbeats are its newest
 * beats; jobs of the new processes were created after they started. Process starts are the
 * processes' clocks, `created_on` the database's: on one host they agree.
 */
export async function detectedHoldBoundary(
  db: Queryable,
  processStartedAt: Date | null,
): Promise<Date> {
  const { rows } = await db.query<{ boundary: Date | string | null }>(
    `SELECT GREATEST(
              (SELECT max(beat_at) FROM service_heartbeats
                WHERE beat_at <= now() - make_interval(secs => $2::double precision)),
              LEAST(now(), $1::timestamptz,
                    (SELECT min(started_at) FROM service_heartbeats
                      WHERE beat_at > now() - make_interval(secs => $2::double precision)))
            ) AS boundary`,
    [processStartedAt ? processStartedAt.toISOString() : null, ALIVE_SECONDS],
  );
  return asDate(rows[0]?.boundary ?? null) ?? new Date();
}

/**
 * Switch restore mode on. Returns the active row's id and whether this call created it: a
 * restore mode that is on already stays as it is (its start and its job hold are kept).
 */
export async function activateRestoreMode(
  db: Queryable,
  input: ActivateRestoreModeInput,
): Promise<{ id: string; created: boolean }> {
  const now = input.now ?? new Date();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO installation_restore_mode (source, reason, activated_at, activated_by, hold_jobs_before, detection)
     VALUES ($1, $2, $3, $4::jsonb, $6, $5::jsonb)
     ON CONFLICT (singleton) WHERE ended_at IS NULL DO NOTHING
     RETURNING id::text AS id`,
    [
      input.source,
      input.reason,
      now.toISOString(),
      JSON.stringify(input.actor),
      input.detection ? JSON.stringify(input.detection) : null,
      (input.holdJobsBefore ?? now).toISOString(),
    ],
  );
  const created = inserted.rows[0];
  if (created) {
    return { id: created.id, created: true };
  }
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM installation_restore_mode WHERE ended_at IS NULL LIMIT 1`,
  );
  const existing = rows[0];
  if (!existing) {
    throw new Error("restore mode could neither be switched on nor read");
  }
  return { id: existing.id, created: false };
}

export interface EndRestoreModeInput {
  readonly id: string;
  readonly actor: RestoreModeActor;
  readonly checked: string;
  readonly storageOnlyData: "keep" | "release";
  readonly rebase: Record<string, unknown>;
  readonly now?: Date;
}

/** End the active restore mode `id`. False when it is no longer the active one. */
export async function endRestoreMode(db: Queryable, input: EndRestoreModeInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const { rows } = await db.query<{ id: string }>(
    `UPDATE installation_restore_mode
        SET ended_at = $2, ended_by = $3::jsonb, checked = $4, storage_only_data = $5,
            keep_unknown_before = CASE WHEN $5 = 'keep' THEN $2::timestamptz ELSE NULL END,
            rebase = $6::jsonb
      WHERE id = $1::uuid AND ended_at IS NULL
      RETURNING id::text AS id`,
    [
      input.id,
      now.toISOString(),
      JSON.stringify(input.actor),
      input.checked,
      input.storageOnlyData,
      JSON.stringify(input.rebase),
    ],
  );
  return rows.length > 0;
}

/** Count one refused deletion pass (per restore mode, pass, tenant and day). */
export async function recordRestoreModeRefusal(
  db: Queryable,
  input: {
    readonly restoreModeId: string;
    readonly tenantId: string | null;
    readonly pass: string;
    readonly sample?: Record<string, unknown> | null;
    readonly now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.query(
    `INSERT INTO restore_mode_refusals (restore_mode_id, tenant_id, pass, day, count, first_at, last_at, sample)
     VALUES ($1::uuid, $2::uuid, $3, ($4::timestamptz AT TIME ZONE 'UTC')::date, 1, $4, $4, $5::jsonb)
     ON CONFLICT ON CONSTRAINT restore_mode_refusals_uq
     DO UPDATE SET count = restore_mode_refusals.count + 1, last_at = EXCLUDED.last_at,
                   sample = COALESCE(EXCLUDED.sample, restore_mode_refusals.sample)`,
    [
      input.restoreModeId,
      input.tenantId,
      input.pass,
      now.toISOString(),
      input.sample ? JSON.stringify(input.sample) : null,
    ],
  );
}

// ---------------------------------------------------------------------------
// The database's progress per tenant
// ---------------------------------------------------------------------------

/**
 * The next progress value of `tenantId`, committed by this statement alone (never inside a
 * caller's transaction that could roll back): a marker in storage is written only after it.
 */
export async function allocateStorageProgress(db: Queryable, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ seq: string | number }>(
    `INSERT INTO storage_progress (tenant_id, seq, updated_at) VALUES ($1::uuid, 1, now())
     ON CONFLICT (tenant_id) DO UPDATE SET seq = storage_progress.seq + 1, updated_at = now()
     RETURNING seq`,
    [tenantId],
  );
  return Number(rows[0]?.seq ?? 0);
}

/** The database's current progress value of `tenantId` (0 without a row). */
export async function readStorageProgress(db: Queryable, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ seq: string | number }>(
    `SELECT seq FROM storage_progress WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return Number(rows[0]?.seq ?? 0);
}

/** Raise `tenantId`'s progress value to at least `to` (ending restore mode). Returns the old value. */
export async function rebaseStorageProgress(
  db: Queryable,
  tenantId: string,
  to: number,
): Promise<{ from: number; to: number }> {
  const before = await readStorageProgress(db, tenantId);
  const { rows } = await db.query<{ seq: string | number }>(
    `INSERT INTO storage_progress (tenant_id, seq, rebased_at, updated_at) VALUES ($1::uuid, $2, now(), now())
     ON CONFLICT (tenant_id) DO UPDATE SET seq = GREATEST(storage_progress.seq, EXCLUDED.seq),
            rebased_at = now(), updated_at = now()
     RETURNING seq`,
    [tenantId, to],
  );
  return { from: before, to: Number(rows[0]?.seq ?? to) };
}

export interface StorageProgressCheckRow {
  readonly tenantId: string;
  readonly targetId: string;
  readonly outcome: StorageProgressOutcome;
  readonly storageMaxSeq: number | null;
  readonly dbSeq: number;
  readonly unknownKeyVersions: readonly number[];
  readonly detail: string | null;
  readonly checkedAt?: Date;
}

/** Keep the last comparison of a tenant's progress with one target. */
export async function recordStorageProgressCheck(
  db: Queryable,
  row: StorageProgressCheckRow,
): Promise<void> {
  await db.query(
    `INSERT INTO storage_progress_checks
       (tenant_id, target_id, checked_at, outcome, storage_max_seq, db_seq, unknown_key_versions, detail)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::int[], $8)
     ON CONFLICT (tenant_id, target_id) DO UPDATE SET checked_at = EXCLUDED.checked_at,
       outcome = EXCLUDED.outcome, storage_max_seq = EXCLUDED.storage_max_seq,
       db_seq = EXCLUDED.db_seq, unknown_key_versions = EXCLUDED.unknown_key_versions,
       detail = EXCLUDED.detail`,
    [
      row.tenantId,
      row.targetId,
      (row.checkedAt ?? new Date()).toISOString(),
      row.outcome,
      row.storageMaxSeq,
      row.dbSeq,
      [...row.unknownKeyVersions],
      row.detail,
    ],
  );
}

/**
 * The installation's identity as progress markers carry it: the id of the settings row,
 * created by the setup. It survives a dump restore and is new on a fresh installation; null
 * before the setup.
 */
export async function readInstallationIdentity(db: Queryable): Promise<string | null> {
  try {
    const { rows } = await db.query<{ id: string }>(`SELECT id::text AS id FROM settings LIMIT 1`);
    return rows[0]?.id ?? null;
  } catch (error) {
    if (isUndefinedTable(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Record a wrapped key in storage that differs from the database's. True when it is new or was
 * resolved before (the caller raises the alert), false while it stays open.
 */
export async function recordKeyMirrorFinding(
  db: Queryable,
  input: {
    readonly tenantId: string;
    readonly targetId: string;
    readonly keyVersion: number;
    /** A sealed repository password document (key version 0): its storage key. */
    readonly objectKey?: string | null;
    readonly storedSha256: string;
    readonly kind: KeyMirrorFindingKind;
    readonly now?: Date;
  },
): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const before = await db.query<{ open: boolean }>(
    `SELECT resolved_at IS NULL AS open FROM key_mirror_findings
      WHERE tenant_id = $1::uuid AND target_id = $2 AND key_version = $3 AND stored_sha256 = $4`,
    [input.tenantId, input.targetId, input.keyVersion, input.storedSha256],
  );
  await db.query(
    `INSERT INTO key_mirror_findings
       (tenant_id, target_id, key_version, object_key, stored_sha256, kind, first_seen_at, last_seen_at)
     VALUES ($1::uuid, $2, $3, $7, $4, $5, $6, $6)
     ON CONFLICT (tenant_id, target_id, key_version, stored_sha256)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, kind = EXCLUDED.kind, resolved_at = NULL`,
    [
      input.tenantId,
      input.targetId,
      input.keyVersion,
      input.storedSha256,
      input.kind,
      now,
      input.objectKey ?? null,
    ],
  );
  return before.rows[0]?.open !== true;
}

/**
 * Resolve the open findings of `keyVersion` on `targetId`: all of them when the target holds the
 * database's key again (`keepSha256` null), otherwise those for other stored bytes than
 * `keepSha256` (the target now holds something else, reported on its own). Returns how many.
 */
export async function resolveKeyMirrorFindings(
  db: Queryable,
  input: {
    readonly tenantId: string;
    readonly targetId: string;
    readonly keyVersion: number;
    /** A sealed repository password document: its storage key (key version 0). */
    readonly objectKey?: string | null;
    readonly keepSha256: string | null;
    readonly now?: Date;
  },
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE key_mirror_findings SET resolved_at = $5
      WHERE tenant_id = $1::uuid AND target_id = $2 AND key_version = $3
        AND object_key IS NOT DISTINCT FROM $6::text
        AND resolved_at IS NULL AND ($4::text IS NULL OR stored_sha256 <> $4::text)
      RETURNING id::text AS id`,
    [
      input.tenantId,
      input.targetId,
      input.keyVersion,
      input.keepSha256,
      (input.now ?? new Date()).toISOString(),
      input.objectKey ?? null,
    ],
  );
  return rows.length;
}

/**
 * A {@link Queryable} over a Drizzle transaction (`$1` placeholders become bound parameters), so
 * the functions above join a caller's transaction: switching restore mode on commits together
 * with its audit entry and its alert.
 */
export function drizzleQueryable(tx: {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}): Queryable {
  return {
    async query<R extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      const parts = text.split(/\$(\d+)/);
      let query = sql.raw(parts[0] ?? "");
      for (let index = 1; index < parts.length; index += 2) {
        const value = values[Number(parts[index]) - 1];
        query = sql`${query}${sql.param(value)}${sql.raw(parts[index + 1] ?? "")}`;
      }
      const result = await tx.execute(query);
      return { rows: result.rows as R[] };
    },
  };
}
