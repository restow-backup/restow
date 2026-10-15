/**
 * Retention hold on suspicion (docs/RANSOMWARE.md, "Retention hold"), as every retention path of
 * the worker asks it: may restore points of this object be deleted now?
 *
 *   held      the object has a suspicious restore point that is neither a false alarm nor
 *             released (@restow/db `suspicionHolds`): retention deletes nothing of it, and
 *             therefore nothing those restore points reference, until an administrator resolves
 *             it. A later clean restore point does not end the hold.
 *   pending   while the detection is on, a backup of the object from the last six hours has no
 *             judgement yet: its restore point may be the first encrypted one, so retention waits
 *             for the pass (every two minutes) instead of deciding without it. Six hours, not
 *             the pass's 72: a backup the pass cannot judge must not stop retention for days.
 *
 * The owner can switch the hold off (`retentionHold.enabled` of the installation's thresholds);
 * then nothing holds. Backups go on either way; only deleting stops. The paths are machines
 * (endpoints/retention.ts), file shares (file-shares/maintenance.ts), Proxmox VE guests
 * (pve/maintenance.ts) and the chunk store's snapshots (handlers/retention.ts). Other objects of
 * the same repository or chunk store are not held: their retention goes on, and the chunk store's
 * garbage collection only collects chunks no active snapshot references.
 */
import type { SuspicionObjectKind } from "@restow/core";
import { type Database, type SuspicionHold, suspicionHolds } from "@restow/db";
import { loadRansomwareSettings, unjudgedObjects } from "./scan.js";

type Executor = Pick<Database, "execute">;

export interface RetentionHolds {
  /** Objects with an open hold, with when and since which restore point. */
  readonly held: ReadonlyMap<string, SuspicionHold>;
  /** Objects whose newest restore points are not judged yet. */
  readonly pending: ReadonlySet<string>;
}

/** How far back an unjudged backup holds retention. */
export const PENDING_JUDGEMENT_WINDOW_MS = 6 * 60 * 60 * 1000;

export const NO_RETENTION_HOLDS: RetentionHolds = { held: new Map(), pending: new Set() };

/** Whether retention must leave every restore point of the object alone. */
export function retentionHeld(holds: RetentionHolds, objectId: string): boolean {
  return holds.held.has(objectId) || holds.pending.has(objectId);
}

/** What a retention report says about a held object (nothing for one that is not held). */
export function retentionHoldSummary(
  holds: RetentionHolds,
  objectId: string,
): Record<string, unknown> {
  const hold = holds.held.get(objectId);
  if (hold) {
    return {
      retentionHeld: "suspicious",
      heldSince: hold.since.toISOString(),
      heldRestorePoints: hold.restorePoints,
    };
  }
  return holds.pending.has(objectId) ? { retentionHeld: "pending_judgement" } : {};
}

/** What holds under the installation's settings. */
export interface RetentionHoldMode {
  /** Open holds apply (`retentionHold.enabled`). */
  readonly holds: boolean;
  /** Unjudged backups hold as well: only while the detection is on, or nothing would judge them. */
  readonly pending: boolean;
}

/** Without the installation's settings at hand: open holds apply, unjudged backups do not. */
export const DEFAULT_RETENTION_HOLD_MODE: RetentionHoldMode = { holds: true, pending: false };

/** The holds of `objectIds` (of one tenant and kind) under `mode`. */
export async function loadRetentionHolds(
  tx: Executor,
  input: {
    tenantId: string;
    kind: SuspicionObjectKind;
    objectIds: readonly string[];
    now: Date;
    mode: RetentionHoldMode;
  },
): Promise<RetentionHolds> {
  if (!input.mode.holds) {
    return NO_RETENTION_HOLDS;
  }
  const held = await suspicionHolds(tx, {
    tenantId: input.tenantId,
    kind: input.kind,
    objectIds: input.objectIds,
  });
  const pending = input.mode.pending
    ? await unjudgedObjects(
        tx,
        input.tenantId,
        input.kind,
        input.objectIds,
        new Date(input.now.getTime() - PENDING_JUDGEMENT_WINDOW_MS),
      )
    : new Set<string>();
  return { held, pending };
}

/** What holds under the installation's settings (read on the installation pool). */
export async function retentionHoldMode(providerDb: Database): Promise<RetentionHoldMode> {
  const settings = await loadRansomwareSettings(providerDb);
  const holds = settings.retentionHold.enabled;
  return { holds, pending: holds && settings.enabled };
}

let modeSource: (() => Promise<RetentionHoldMode>) | null = null;

/**
 * Where code that runs on the tenant pool alone (the chunk store's retention task) reads the
 * installation's settings; set once at start-up (index.ts). Unset (tests), or when the settings
 * cannot be read: {@link DEFAULT_RETENTION_HOLD_MODE}.
 */
export function configureSuspicionHolds(deps: { providerDb: Database } | null): void {
  modeSource = deps ? () => retentionHoldMode(deps.providerDb) : null;
}

export async function configuredRetentionHoldMode(): Promise<RetentionHoldMode> {
  return modeSource
    ? modeSource().catch(() => DEFAULT_RETENTION_HOLD_MODE)
    : DEFAULT_RETENTION_HOLD_MODE;
}
