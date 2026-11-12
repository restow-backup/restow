/**
 * The deletion guard (0.5.0, docs/STORAGE.md "Restore mode and progress markers").
 *
 * After a database dump is restored, the database knows less than the storage: backups written
 * after the dump have packs, manifests and restic snapshots but no rows, and every pass that
 * decides by the database what may go (the orphan sweep, retention, clean-ups, purge, restic
 * forget and prune) would delete them. Restore mode refuses all of them until a provider
 * owner has checked the restored database.
 *
 * Every pass that deletes storage data names itself ({@link DELETION_PASSES}) and runs inside
 * {@link withDeletionPermit}: the installed {@link DeletionGuard} (the worker's and the api's,
 * backed by the database) decides whether it may delete now, compares the database's progress
 * with the storage first (progress-marker.ts) and switches restore mode on by itself when the
 * storage is ahead. A pass that would rather skip cleanly asks {@link deletionDecision} first.
 *
 * The storage backends themselves call {@link assertDeletionPermitted} before every delete, so
 * a construction site that forgot its permit cannot delete while restore mode is on either.
 * What may always go: restic lock files, probe objects, objects the same operation wrote
 * itself ({@link withStorageOperation}) and the scope a row owns under its own fresh id (an
 * `own_scope` pass: an export starting its file over, a failed enrollment removing the
 * repository it began). Without an installed guard (the standalone restore, plain unit tests)
 * nothing is checked.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Every pass that deletes storage data. A new one is added here and to deletion-sites.ts. */
export const DELETION_PASSES = [
  "orphan_sweep",
  "gc_repack",
  "superseded_release",
  "abandoned_checkpoint",
  "job_checkpoint_discard",
  "snapshot_retention",
  "mail_files_cleanup",
  "import_staging",
  "export_reset",
  "archive_retention",
  "file_share_purge",
  "file_share_retention",
  "endpoint_retention",
  "endpoint_removal",
  "pve_retention",
  "pve_reconcile_forget",
  "pve_repository_reset",
  "pve_chain_clear",
  "repository_repair_apply",
  "enrollment_cleanup",
  "progress_marker_prune",
  // Retention on the restic repositories a copy target holds (docs/STORAGE.md, "restic
  // repositories on copies"): restic forget and prune there.
  "repository_copy_retention",
  // Not deletes of their own, but they leave data behind that a later removal loses: removing a
  // storage target, and replacing the primary (the copy is filled from the database's rows).
  "storage_target_removal",
  "primary_replacement",
] as const;
export type DeletionPass = (typeof DELETION_PASSES)[number];

/**
 * What a pass may do in restore mode:
 *
 *   refuse                nothing
 *   post_activation_only  delete what belongs to a row created after restore mode began
 *                         (`createdAt` of the permit request)
 *   own_writes            delete only objects the same operation wrote (always allowed)
 *   own_scope             delete inside the scope named by the fresh id of the row whose job
 *                         deletes it (an export's own segments, the repository a failed
 *                         enrollment began under its fresh endpoint id): whatever is there is that
 *                         row's own output, which nothing else references and the row writes
 *                         again, so neither restore mode nor a storage target that cannot be
 *                         compared with the database holds it (always allowed, no comparison)
 */
export type RestoreModeBehaviour = "refuse" | "post_activation_only" | "own_writes" | "own_scope";

export const DELETION_PASS_BEHAVIOUR: Readonly<Record<DeletionPass, RestoreModeBehaviour>> = {
  orphan_sweep: "refuse",
  gc_repack: "refuse",
  superseded_release: "refuse",
  abandoned_checkpoint: "refuse",
  job_checkpoint_discard: "post_activation_only",
  snapshot_retention: "refuse",
  mail_files_cleanup: "refuse",
  import_staging: "refuse",
  export_reset: "own_scope",
  archive_retention: "refuse",
  file_share_purge: "refuse",
  file_share_retention: "refuse",
  endpoint_retention: "refuse",
  endpoint_removal: "refuse",
  pve_retention: "refuse",
  pve_reconcile_forget: "refuse",
  pve_repository_reset: "refuse",
  pve_chain_clear: "refuse",
  repository_repair_apply: "refuse",
  enrollment_cleanup: "own_scope",
  progress_marker_prune: "refuse",
  repository_copy_retention: "refuse",
  storage_target_removal: "refuse",
  primary_replacement: "refuse",
};

export function isDeletionPass(value: unknown): value is DeletionPass {
  return typeof value === "string" && (DELETION_PASSES as readonly string[]).includes(value);
}

export interface DeletionRequest {
  readonly pass: DeletionPass;
  /** The tenant whose data the pass deletes; null for installation-level data. */
  readonly tenantId: string | null;
  /** For `post_activation_only`: when the row the deleted objects belong to was created. */
  readonly createdAt?: Date | null;
}

export type DeletionRefusalReason =
  /** Restore mode is on (switched on, or just detected). */
  | "restore_mode"
  /** A storage target of the tenant could not be compared with the database this time. */
  | "progress_unknown";

export type DeletionDecision =
  | {
      readonly allowed: true;
      /**
       * Data the database does not know and that is older than this stays (restore mode ended
       * with "keep"): the orphan sweep and the other passes over storage-only data skip it.
       */
      readonly keepUnknownBefore: Date | null;
      /** Granted while restore mode is on (a `post_activation_only` or `own_scope` pass). */
      readonly inRestoreMode: boolean;
    }
  | {
      readonly allowed: false;
      readonly reason: DeletionRefusalReason;
      readonly restoreModeId: string | null;
      readonly detail?: string;
    };

/** The database-backed decision the worker and the api install. */
export interface DeletionGuard {
  /** Decide (and, when refused, record and log the refusal). */
  decide(request: DeletionRequest): Promise<DeletionDecision>;
  /** Whether restore mode is known to be on right now (a cached read, no I/O). */
  holding(): boolean;
  /** A delete outside any permit; `refused` when restore mode held it. */
  onUnguarded?(key: string, refused: boolean): void;
}

/** A pass refused because deleting is paused (restore mode) or the storage could not be compared. */
export class DeletionsHeldError extends Error {
  readonly code = "restore_mode";
  constructor(
    readonly pass: DeletionPass | null,
    readonly reason: DeletionRefusalReason,
    readonly restoreModeId: string | null,
    detail?: string,
  ) {
    super(
      reason === "restore_mode"
        ? `Deleting is paused (restore mode)${pass ? `: ${pass} refused` : ""}.`
        : `Deleting is paused: the storage could not be compared with the database${detail ? ` (${detail})` : ""}.`,
    );
    this.name = "DeletionsHeldError";
  }
}

/** A storage delete outside every permit, own write and always-allowed class (strict mode). */
export class UnguardedDeletionError extends Error {
  constructor(readonly key: string) {
    super(
      `storage delete of ${key} outside a deletion permit: register it with the deletion guard (DELETION_PASSES)`,
    );
    this.name = "UnguardedDeletionError";
  }
}

/** A write that would replace a stored wrapped key with different bytes. */
export class KeyOverwriteRefusedError extends Error {
  constructor(readonly key: string) {
    super(
      `${key} exists with different content; a wrapped key or sealed repository password is never overwritten`,
    );
    this.name = "KeyOverwriteRefusedError";
  }
}

/** Whether `error` (or its cause) is a {@link DeletionsHeldError}. */
export function deletionsHeldErrorOf(error: unknown): DeletionsHeldError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof DeletionsHeldError) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

interface OperationContext {
  /** Keys this operation wrote (bounded); they may be deleted again. */
  readonly writes: Set<string>;
}

interface PermitContext {
  readonly pass: DeletionPass;
  readonly tenantId: string | null;
  /** Granted while restore mode was on (only a `post_activation_only` or `own_scope` pass can be). */
  readonly inRestoreMode: boolean;
}

interface GuardStore {
  readonly operation: OperationContext | null;
  readonly permit: PermitContext | null;
}

const storage = new AsyncLocalStorage<GuardStore>();
const MAX_OWN_WRITES = 20_000;

interface Enforcement {
  readonly guard: DeletionGuard;
  /** Tests: a delete outside every permit throws even when restore mode is off. */
  readonly strict: boolean;
}

let enforcement: Enforcement | null = null;

/** Install the guard (worker and api start, pg tests). Returns the uninstall function. */
export function installDeletionEnforcement(
  guard: DeletionGuard,
  options: { readonly strict?: boolean } = {},
): () => void {
  const installed: Enforcement = { guard, strict: options.strict === true };
  enforcement = installed;
  return () => {
    if (enforcement === installed) {
      enforcement = null;
    }
  };
}

/** Whether a guard is installed in this process. */
export function deletionEnforcementInstalled(): boolean {
  return enforcement !== null;
}

/**
 * Run `fn` as one storage operation (a job, an api request): objects it writes may be deleted
 * again by it in restore mode (a failed export's own segments, a failed enrollment's own
 * repository).
 */
export function withStorageOperation<T>(fn: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  return storage.run({ operation: { writes: new Set() }, permit: current?.permit ?? null }, fn);
}

/** The decision for `request` (always allowed without an installed guard). */
export async function deletionDecision(request: DeletionRequest): Promise<DeletionDecision> {
  if (!enforcement) {
    return { allowed: true, keepUnknownBefore: null, inRestoreMode: false };
  }
  return enforcement.guard.decide(request);
}

/**
 * Run the deletion pass `fn` with a permit, or throw {@link DeletionsHeldError} when the guard
 * refuses it. `fn` receives the decision (its keep floor).
 */
export async function withDeletionPermit<T>(
  request: DeletionRequest,
  fn: (decision: Extract<DeletionDecision, { allowed: true }>) => Promise<T>,
): Promise<T> {
  const decision = await deletionDecision(request);
  if (!decision.allowed) {
    throw new DeletionsHeldError(
      request.pass,
      decision.reason,
      decision.restoreModeId,
      decision.detail,
    );
  }
  const current = storage.getStore();
  return storage.run(
    {
      operation: current?.operation ?? null,
      permit: {
        pass: request.pass,
        tenantId: request.tenantId,
        inRestoreMode: decision.inRestoreMode,
      },
    },
    () => fn(decision),
  );
}

/**
 * Run `fn` in the guard context that is current now, from wherever it is called later (the
 * restic loopback serves restic's requests in the context of the pass that started restic).
 */
export function bindDeletionContext(): <T>(fn: () => T) => T {
  const current = storage.getStore();
  return <T>(fn: () => T): T => (current ? storage.run(current, fn) : storage.exit(fn));
}

/**
 * Objects that may always be deleted: restic lock files (restic removes its own locks after
 * every command, also during a check or a backup), probe objects of a storage test, progress
 * markers' own folders are not among them (they are pruned by a pass).
 */
export function isAlwaysDeletable(key: string): boolean {
  if (/(^|\/)locks\/[^/]+$/.test(key)) {
    return true;
  }
  if (/^(installation|tenants\/[^/]+)\/probes\//.test(key) || /(^|\/)\.restow-probe-/.test(key)) {
    return true;
  }
  return false;
}

/** Note a write of `key` for the current operation (the backends call it after a put). */
export function noteStorageWrite(key: string): void {
  const operation = storage.getStore()?.operation;
  if (operation && operation.writes.size < MAX_OWN_WRITES) {
    operation.writes.add(key);
  }
}

/**
 * Called by every storage backend before it deletes `key` (or removes all its versions):
 * throws {@link DeletionsHeldError} when restore mode holds the delete, and in strict mode
 * {@link UnguardedDeletionError} for a delete outside every permit.
 */
export function assertDeletionPermitted(key: string): void {
  const installed = enforcement;
  if (!installed) {
    return;
  }
  if (isAlwaysDeletable(key)) {
    return;
  }
  const current = storage.getStore();
  if (current?.operation?.writes.has(key)) {
    return;
  }
  const permit = current?.permit ?? null;
  if (permit) {
    // Restore mode may have come on (another process detected it) after the permit was given;
    // an own_scope pass deletes only its row's own output and is never held by it.
    if (
      !permit.inRestoreMode &&
      DELETION_PASS_BEHAVIOUR[permit.pass] !== "own_scope" &&
      installed.guard.holding()
    ) {
      throw new DeletionsHeldError(permit.pass, "restore_mode", null);
    }
    return;
  }
  if (installed.guard.holding()) {
    installed.guard.onUnguarded?.(key, true);
    throw new DeletionsHeldError(null, "restore_mode", null);
  }
  installed.guard.onUnguarded?.(key, false);
  if (installed.strict) {
    throw new UnguardedDeletionError(key);
  }
}

/** `tenants/<tid>/keys/<version>`: a wrapped tenant key. */
const WRAPPED_KEY = /^tenants\/[^/]+\/keys\/\d+$/;

export function isWrappedKeyKey(key: string): boolean {
  return WRAPPED_KEY.test(key);
}

/**
 * `.../restow-repository-password.json`: the sealed password next to a restic repository (of a
 * machine, a file share or a Proxmox VE guest, at its default prefix or a fresh one).
 */
const REPOSITORY_PASSWORD_DOCUMENT = /(^|\/)restow-repository-password\.json$/;

export function isRepositoryPasswordKey(key: string): boolean {
  return REPOSITORY_PASSWORD_DOCUMENT.test(key);
}

/**
 * Objects that may be the only key to data written under them: wrapped tenant keys and sealed
 * repository passwords. One that exists is never replaced by other bytes.
 */
export function isNeverReplacedKey(key: string): boolean {
  return isWrappedKeyKey(key) || isRepositoryPasswordKey(key);
}

/**
 * Called by the backends before a put of a wrapped key or a sealed repository password: an
 * existing object with different bytes is never replaced ({@link KeyOverwriteRefusedError}). Only
 * while a guard is installed (the worker, the api); `existing` reads the stored bytes, null when
 * there are none.
 */
export async function assertKeyWritePermitted(
  key: string,
  data: Buffer | unknown,
  existing: () => Promise<Buffer | null>,
): Promise<void> {
  if (!enforcement || !isNeverReplacedKey(key) || !Buffer.isBuffer(data)) {
    return;
  }
  const stored = await existing();
  if (stored && !stored.equals(data)) {
    throw new KeyOverwriteRefusedError(key);
  }
}
