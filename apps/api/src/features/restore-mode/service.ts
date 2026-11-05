import {
  type DeletionPass,
  deletionDecision,
  type KeyProvider,
  PROGRESS_REBASE_MARGIN,
  type RestoreModeGuard,
  type TenantProgressCheck,
  wrappedKeyKey,
} from "@restow/core";
import {
  activateRestoreMode,
  type Database,
  drizzleQueryable,
  endRestoreMode,
  type RestoreModeActor,
  readRestoreMode,
  readStorageProgress,
  rebaseStorageProgress,
  tenantKeys,
} from "@restow/db";
import { audit } from "../../lib/audit.js";
import { ENV_KEK_ID, keyProvider } from "../../lib/secrets.js";
import { ProblemError } from "../../problem.js";
import { RESTORE_MODE_AUDIT_ACTIONS, tenantStorageTargets } from "./guard.js";

/**
 * Restore mode after restoring a database dump (docs/STORAGE.md, "Restore mode and progress
 * markers"): what the Restore mode page shows and does, and what `restow restore-mode` runs.
 *
 *   view        the active restore mode and its history, the comparison of every tenant's
 *               targets with the database, refused deletions, held jobs, key versions in
 *               storage the database lacks, wrapped keys in storage that differ
 *   start       switch it on (the command line before the worker starts, or a provider owner)
 *   check       compare every tenant's storage with the database now
 *   importKeys  take wrapped keys from storage the database lacks into `tenant_keys`
 *   end         a provider owner ends it after checking, in their own words what they checked;
 *               each tenant's progress value is lifted above everything storage showed
 *
 * Everything runs on the installation pool.
 */

export const RESTORE_MODE_PROBLEM = "urn:restow:problem:restore-mode";
export const MIN_CHECKED_LENGTH = 20;
export const MAX_CHECKED_LENGTH = 2000;
export const END_CONFIRMATION = "END";

/** The 409 every refused deleting action answers while restore mode is on. */
export function restoreModeProblem(detail?: string): ProblemError {
  return new ProblemError(409, "Restore mode is on", {
    type: RESTORE_MODE_PROBLEM,
    detail:
      detail ??
      "Deleting is paused for the whole installation until a provider owner has checked the restored database.",
  });
}

/**
 * Refuse a deleting action (purge, reset, removal, a primary replacement) with 409 while restore
 * mode is on: asked of the process's deletion guard (server.ts installs it; without one, as in
 * route tests, nothing is refused). The refusal is counted like a refused pass.
 */
export async function assertNotInRestoreMode(
  pass: DeletionPass,
  tenantId: string | null = null,
): Promise<void> {
  const decision = await deletionDecision({ pass, tenantId: null });
  if (!decision.allowed) {
    throw restoreModeProblem(
      tenantId
        ? "Deleting is paused for the whole installation until a provider owner has checked the restored database."
        : undefined,
    );
  }
}

export interface RestoreModeTargetView {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly targetId: string;
  readonly outcome: string;
  readonly storageMaxSeq: number | null;
  readonly dbSeq: number;
  readonly unknownKeyVersions: readonly number[];
  readonly detail: string | null;
  readonly checkedAt: string;
}

export interface RestoreModeView {
  readonly active: {
    readonly id: string;
    readonly source: string;
    readonly reason: string | null;
    readonly activatedAt: string;
    readonly activatedBy: RestoreModeActor;
    readonly holdJobsBefore: string;
    readonly detection: unknown;
  } | null;
  readonly history: readonly {
    readonly id: string;
    readonly source: string;
    readonly activatedAt: string;
    readonly endedAt: string | null;
    readonly endedBy: RestoreModeActor | null;
    readonly checked: string | null;
    readonly storageOnlyData: string | null;
  }[];
  readonly targets: readonly RestoreModeTargetView[];
  readonly refusals: readonly {
    pass: string;
    tenantId: string | null;
    count: number;
    lastAt: string;
  }[];
  readonly heldJobs: { readonly held: number; readonly waiting: number };
  readonly unknownKeyVersions: readonly {
    tenantId: string;
    targetId: string;
    versions: number[];
  }[];
  readonly keyFindings: readonly {
    tenantId: string;
    targetId: string;
    keyVersion: number;
    /** A sealed repository password document (key version 0): its storage key. */
    objectKey: string | null;
    kind: string;
    firstSeenAt: string;
  }[];
}

export interface RestoreModeBanner {
  readonly active: boolean;
  readonly since: string | null;
  readonly source: string | null;
}

const iso = (value: unknown): string => new Date(value as string).toISOString();

export async function restoreModeBanner(db: Database): Promise<RestoreModeBanner> {
  const state = await readRestoreMode(db.$client);
  return {
    active: state.active,
    since: state.activatedAt?.toISOString() ?? null,
    source: state.source,
  };
}

export async function restoreModeView(db: Database): Promise<RestoreModeView> {
  const client = db.$client;
  const { rows: activeRows } = await client.query<Record<string, unknown>>(
    `SELECT id::text AS id, source, reason, activated_at, activated_by, hold_jobs_before, detection
       FROM installation_restore_mode WHERE ended_at IS NULL LIMIT 1`,
  );
  const activeRow = activeRows[0];
  const { rows: historyRows } = await client.query<Record<string, unknown>>(
    `SELECT id::text AS id, source, activated_at, ended_at, ended_by, checked, storage_only_data
       FROM installation_restore_mode WHERE ended_at IS NOT NULL
      ORDER BY activated_at DESC LIMIT 10`,
  );
  const { rows: checkRows } = await client.query<Record<string, unknown>>(
    `SELECT c.tenant_id::text AS tenant_id, t.name AS tenant_name, c.target_id, c.outcome,
            c.storage_max_seq, c.db_seq, c.unknown_key_versions, c.detail, c.checked_at
       FROM storage_progress_checks c LEFT JOIN tenants t ON t.id = c.tenant_id
      ORDER BY t.name NULLS LAST, c.target_id`,
  );
  const refusals = activeRow
    ? (
        await client.query<Record<string, unknown>>(
          `SELECT pass, tenant_id::text AS tenant_id, sum(count)::int AS count, max(last_at) AS last_at
             FROM restore_mode_refusals WHERE restore_mode_id = $1::uuid
            GROUP BY pass, tenant_id ORDER BY max(last_at) DESC LIMIT 200`,
          [activeRow.id],
        )
      ).rows
    : [];
  let held = 0;
  let waiting = 0;
  if (activeRow) {
    const heldRows = await client.query<{ held: number }>(
      `SELECT count(*)::int AS held FROM jobs
        WHERE failure->>'code' = 'job.restore_mode_hold' AND updated_at >= $1::timestamptz`,
      [iso(activeRow.activated_at)],
    );
    held = heldRows.rows[0]?.held ?? 0;
    try {
      const waitingRows = await client.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pgboss.job
          WHERE state IN ('created', 'retry', 'active') AND created_on < $1::timestamptz`,
        [iso(activeRow.hold_jobs_before)],
      );
      waiting = waitingRows.rows[0]?.waiting ?? 0;
    } catch {
      // pg-boss's schema exists once the worker or the scheduler has started.
    }
  }
  const { rows: findingRows } = await client.query<Record<string, unknown>>(
    `SELECT tenant_id::text AS tenant_id, target_id, key_version, object_key, kind, first_seen_at
       FROM key_mirror_findings WHERE resolved_at IS NULL ORDER BY first_seen_at DESC LIMIT 100`,
  );
  const targets: RestoreModeTargetView[] = checkRows.map((row) => ({
    tenantId: String(row.tenant_id),
    tenantName: (row.tenant_name as string | null) ?? null,
    targetId: String(row.target_id),
    outcome: String(row.outcome),
    storageMaxSeq: row.storage_max_seq === null ? null : Number(row.storage_max_seq),
    dbSeq: Number(row.db_seq),
    unknownKeyVersions: ((row.unknown_key_versions as number[] | null) ?? []).map(Number),
    detail: (row.detail as string | null) ?? null,
    checkedAt: iso(row.checked_at),
  }));
  return {
    active: activeRow
      ? {
          id: String(activeRow.id),
          source: String(activeRow.source),
          reason: (activeRow.reason as string | null) ?? null,
          activatedAt: iso(activeRow.activated_at),
          activatedBy: activeRow.activated_by as RestoreModeActor,
          holdJobsBefore: iso(activeRow.hold_jobs_before),
          detection: activeRow.detection ?? null,
        }
      : null,
    history: historyRows.map((row) => ({
      id: String(row.id),
      source: String(row.source),
      activatedAt: iso(row.activated_at),
      endedAt: row.ended_at ? iso(row.ended_at) : null,
      endedBy: (row.ended_by as RestoreModeActor | null) ?? null,
      checked: (row.checked as string | null) ?? null,
      storageOnlyData: (row.storage_only_data as string | null) ?? null,
    })),
    targets,
    refusals: refusals.map((row) => ({
      pass: String(row.pass),
      tenantId: (row.tenant_id as string | null) ?? null,
      count: Number(row.count),
      lastAt: iso(row.last_at),
    })),
    heldJobs: { held, waiting },
    unknownKeyVersions: targets
      .filter((target) => target.unknownKeyVersions.length > 0)
      .map((target) => ({
        tenantId: target.tenantId,
        targetId: target.targetId,
        versions: [...target.unknownKeyVersions],
      })),
    keyFindings: findingRows.map((row) => ({
      tenantId: String(row.tenant_id),
      targetId: String(row.target_id),
      keyVersion: Number(row.key_version),
      objectKey: (row.object_key as string | null) ?? null,
      kind: String(row.kind),
      firstSeenAt: iso(row.first_seen_at),
    })),
  };
}

/** Switch restore mode on (the command line, or a provider owner). */
export async function startRestoreMode(
  db: Database,
  input: {
    readonly source: "cli" | "api";
    readonly reason: string;
    readonly actor: RestoreModeActor;
  },
): Promise<{ id: string; created: boolean }> {
  return db.transaction(async (tx) => {
    const activated = await activateRestoreMode(drizzleQueryable(tx), {
      source: input.source,
      reason: input.reason,
      actor: input.actor,
    });
    if (activated.created) {
      await audit(tx, {
        tenantId: null,
        actor: input.actor.label,
        actorUserId: input.actor.userId ?? null,
        action: RESTORE_MODE_AUDIT_ACTIONS.started,
        target: activated.id,
        targetType: "installation",
        ip: input.actor.ip ?? null,
        details: { source: input.source, reason: input.reason, host: input.actor.host ?? null },
      });
    }
    return activated;
  });
}

async function tenantIds(db: Database, only?: string): Promise<string[]> {
  const { rows } = await db.$client.query<{ id: string }>(
    only
      ? "SELECT id::text AS id FROM tenants WHERE id = $1::uuid"
      : "SELECT id::text AS id FROM tenants ORDER BY created_at",
    only ? [only] : [],
  );
  return rows.map((row) => row.id);
}

/** Compare every tenant's storage with the database now. */
export async function checkRestoreMode(
  db: Database,
  guard: RestoreModeGuard,
): Promise<TenantProgressCheck[]> {
  guard.forgetChecks();
  return guard.checkTenants(await tenantIds(db), { concurrency: 8, capMs: 10 * 60_000 });
}

export interface ImportedKey {
  readonly tenantId: string;
  readonly keyVersion: number;
}

export interface KeyImportRefusal {
  readonly tenantId: string;
  readonly keyVersion: number;
  readonly reason: "differs_between_targets" | "does_not_unwrap" | "unreadable";
}

/**
 * Take wrapped keys from storage into the database: every `keys/<v>` above the tenant's newest
 * version that unwraps with the KEK and is identical on every target that has it.
 */
export async function importRestoreModeKeys(
  db: Database,
  input: {
    readonly actor: RestoreModeActor;
    readonly tenantId?: string;
    readonly provider?: KeyProvider;
  },
): Promise<{ imported: ImportedKey[]; refused: KeyImportRefusal[] }> {
  const provider = input.provider ?? keyProvider();
  const imported: ImportedKey[] = [];
  const refused: KeyImportRefusal[] = [];
  for (const tenantId of await tenantIds(db, input.tenantId)) {
    const { targets, previous } = await tenantStorageTargets(db, tenantId);
    const { rows } = await db.$client.query<{ version: number | null }>(
      "SELECT max(key_version) AS version FROM tenant_keys WHERE tenant_id = $1::uuid",
      [tenantId],
    );
    const dbMax = Number(rows[0]?.version ?? 0);
    const found = new Map<number, Buffer[]>();
    for (const target of [...targets, ...previous]) {
      const keys = await target.backend.list(`tenants/${tenantId}/keys/`).catch(() => []);
      for (const key of keys) {
        const version = Number(/\/keys\/(\d+)$/.exec(key)?.[1] ?? Number.NaN);
        if (!Number.isInteger(version) || version <= dbMax) {
          continue;
        }
        const bytes = await target.backend.get(wrappedKeyKey(tenantId, version)).catch(() => null);
        const list = found.get(version) ?? [];
        if (bytes) {
          list.push(bytes);
        }
        found.set(version, list);
      }
    }
    for (const [version, copies] of [...found.entries()].sort((a, b) => a[0] - b[0])) {
      const first = copies[0];
      if (!first) {
        refused.push({ tenantId, keyVersion: version, reason: "unreadable" });
        continue;
      }
      if (copies.some((copy) => !copy.equals(first))) {
        refused.push({ tenantId, keyVersion: version, reason: "differs_between_targets" });
        continue;
      }
      try {
        await provider.unwrapDek(first);
      } catch {
        refused.push({ tenantId, keyVersion: version, reason: "does_not_unwrap" });
        continue;
      }
      await db.transaction(async (tx) => {
        await tx
          .insert(tenantKeys)
          .values({
            tenantId,
            keyVersion: version,
            encryptedDek: first.toString("base64"),
            kekId: ENV_KEK_ID,
          })
          .onConflictDoNothing();
        await audit(tx, {
          tenantId: null,
          actor: input.actor.label,
          actorUserId: input.actor.userId ?? null,
          action: RESTORE_MODE_AUDIT_ACTIONS.keysImported,
          target: tenantId,
          targetType: "tenant",
          ip: input.actor.ip ?? null,
          details: { tenantId, keyVersion: version, targets: copies.length },
        });
      });
      imported.push({ tenantId, keyVersion: version });
    }
  }
  return { imported, refused };
}

export interface EndRestoreModeInput {
  readonly checked: string;
  readonly confirmation: string;
  readonly storageOnlyData: "keep" | "release";
  /** Targets (`<tenant id>/<target id>`) that may stay unreachable at the confirmation. */
  readonly acceptUnreachable?: readonly string[];
  readonly actor: RestoreModeActor;
}

export interface EndRestoreModeResult {
  readonly ended: true;
  readonly rebase: { tenantId: string; from: number; to: number }[];
  readonly acceptedUnreachable: string[];
}

/**
 * A refusal of the end step. `code` names the case for the web's translation
 * (`restoreMode.errors.*`): checked_length, confirmation, off, unreachable,
 * unknown_key_versions, changed.
 */
function problem(
  status: 400 | 409 | 503,
  title: string,
  detail: string,
  extensions: { code: string } & Record<string, unknown>,
): ProblemError {
  return new ProblemError(status, title, { type: RESTORE_MODE_PROBLEM, detail, extensions });
}

/**
 * End restore mode: a fresh comparison first (an unreachable target must be accepted by name,
 * unimported key versions refuse), then in one transaction each tenant's progress value is lifted
 * above everything storage showed, the row is ended and the installation's audit entry written.
 */
export async function endRestoreModeConfirmed(
  db: Database,
  guard: RestoreModeGuard,
  input: EndRestoreModeInput,
): Promise<EndRestoreModeResult> {
  const checked = input.checked.trim();
  if (checked.length < MIN_CHECKED_LENGTH || checked.length > MAX_CHECKED_LENGTH) {
    throw problem(
      400,
      "Describe what was checked",
      `Describe in ${MIN_CHECKED_LENGTH} to ${MAX_CHECKED_LENGTH} characters what you checked.`,
      { code: "checked_length" },
    );
  }
  if (input.confirmation !== END_CONFIRMATION) {
    throw problem(400, "Confirmation missing", `Type ${END_CONFIRMATION} to confirm.`, {
      code: "confirmation",
    });
  }
  const state = await readRestoreMode(db.$client);
  if (!state.active || !state.id) {
    throw problem(409, "Restore mode is off", "Restore mode is not on.", { code: "off" });
  }
  const checks = await checkRestoreMode(db, guard);
  const accepted = new Set(input.acceptUnreachable ?? []);
  const unreachable = checks.flatMap((check) =>
    check.targets
      .filter((target) => target.outcome === "unreachable")
      .map((target) => `${check.tenantId}/${target.targetId}`),
  );
  const notAccepted = unreachable.filter((name) => !accepted.has(name));
  if (notAccepted.length > 0) {
    throw problem(
      409,
      "A storage target could not be read",
      "Every storage target must answer before restore mode ends, or be accepted as unreachable.",
      { code: "unreachable", unreachable: notAccepted },
    );
  }
  const unknownKeys = checks.flatMap((check) =>
    check.targets
      .filter((target) => target.unknownKeyVersions.length > 0)
      .map((target) => ({
        tenantId: check.tenantId,
        targetId: target.targetId,
        versions: [...target.unknownKeyVersions],
      })),
  );
  if (unknownKeys.length > 0) {
    throw problem(
      409,
      "Key versions in storage are not in the database",
      "Import the key versions found in storage first (Import keys), then end restore mode.",
      { code: "unknown_key_versions", unknownKeyVersions: unknownKeys },
    );
  }
  const restoreModeId = state.id;
  const rebase = await db.transaction(async (tx) => {
    const queryable = drizzleQueryable(tx);
    const lifted: { tenantId: string; from: number; to: number }[] = [];
    for (const check of checks) {
      const seen = Math.max(0, ...check.targets.map((target) => target.storageMaxSeq ?? 0));
      const dbSeq = await readStorageProgress(queryable, check.tenantId);
      lifted.push(
        await rebaseStorageProgress(
          queryable,
          check.tenantId,
          Math.max(seen, dbSeq) + PROGRESS_REBASE_MARGIN,
        ).then((result) => ({ tenantId: check.tenantId, ...result })),
      );
    }
    const ended = await endRestoreMode(queryable, {
      id: restoreModeId,
      actor: input.actor,
      checked,
      storageOnlyData: input.storageOnlyData,
      rebase: { tenants: lifted, acceptedUnreachable: unreachable },
    });
    if (!ended) {
      throw problem(409, "Restore mode changed", "Restore mode was ended meanwhile.", {
        code: "changed",
      });
    }
    await audit(tx, {
      tenantId: null,
      actor: input.actor.label,
      actorUserId: input.actor.userId ?? null,
      action: RESTORE_MODE_AUDIT_ACTIONS.ended,
      target: restoreModeId,
      targetType: "installation",
      ip: input.actor.ip ?? null,
      details: {
        checked,
        storageOnlyData: input.storageOnlyData,
        rebase: lifted,
        acceptedUnreachable: unreachable,
        host: input.actor.host ?? null,
      },
    });
    return lifted;
  });
  guard.forgetChecks();
  return { ended: true, rebase, acceptedUnreachable: unreachable };
}

/**
 * The active provider owner `email` names (the command line's `off --email`), the same check as
 * `restow admin recover`: refuses an unknown account, a non-owner and a disabled one.
 */
export async function providerOwnerByEmail(
  db: Database,
  email: string,
): Promise<{ id: string; email: string }> {
  const { recoveryTarget } = await import("../../cli/admin-recovery.js");
  return recoveryTarget(db, email);
}
