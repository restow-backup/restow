/**
 * The deletion guard the worker and the api install (deletion-guard.ts), backed by the
 * database's restore mode and the comparison of each tenant's storage with the database
 * (progress-marker.ts). The database side comes in through {@link RestoreModeStore}, the
 * tenant's targets through `targetsOf`, so this module has no database dependency of its own.
 *
 * A pass asks {@link RestoreModeGuard.decide}:
 *
 *   - an `own_scope` pass (a row deleting its own output under its own id) is always allowed,
 *     without a comparison: a copy target that cannot be read never holds it;
 *   - restore mode on: refused (a `post_activation_only` pass for a row created after restore
 *     mode began is allowed), counted and logged;
 *   - otherwise the tenant's targets are compared with the database (cached for a while): a
 *     target ahead of the database switches restore mode on (the store raises the alert and
 *     writes the audit entry) and refuses; a target that cannot be read refuses this time only;
 *   - otherwise allowed, with the keep floor of an ended restore mode.
 */
import type { Logger } from "../engine/types.js";
import type { StorageBackend } from "./backend.js";
import {
  DELETION_PASS_BEHAVIOUR,
  type DeletionDecision,
  type DeletionGuard,
  type DeletionPass,
  type DeletionRequest,
} from "./deletion-guard.js";
import {
  compareStorageProgress,
  PROGRESS_REBASE_MARGIN,
  type ProgressOutcome,
  type TargetProgress,
} from "./progress-marker.js";

export interface RestoreModeSnapshot {
  readonly active: boolean;
  readonly id: string | null;
  readonly activatedAt: Date | null;
  /** Jobs created before this are held, never resumed. */
  readonly holdJobsBefore: Date | null;
  readonly keepUnknownBefore: Date | null;
}

export interface RestoreModeDetectionInput {
  readonly tenantId: string;
  readonly targetId: string;
  readonly markerSeq: number | null;
  readonly dbSeq: number;
  readonly keyVersions: readonly number[];
  readonly installationId: string | null;
}

/** What the guard needs from the database (apps/worker and apps/api implement it). */
export interface RestoreModeStore {
  read(): Promise<RestoreModeSnapshot>;
  readDbSeq(tenantId: string): Promise<number>;
  readDbKeyMax(tenantId: string): Promise<number>;
  installationId(): Promise<string | null>;
  recordCheck(tenantId: string, result: TargetProgress): Promise<void>;
  /** Switch restore mode on for a detection: the row, the audit entry, the alert. */
  activateDetected(detection: RestoreModeDetectionInput): Promise<{ id: string; created: boolean }>;
  recordRefusal(input: {
    restoreModeId: string;
    tenantId: string | null;
    pass: DeletionPass;
    sample?: Record<string, unknown>;
  }): Promise<void>;
  /** A foreign marker (another installation wrote to this tenant's storage): warn only. */
  reportForeign?(tenantId: string, result: TargetProgress): Promise<void>;
  /**
   * Raise the tenant's progress value to at least `to` (never lowers it). Called while restore
   * mode is on for a tenant whose storage holds markers above the database: new markers then
   * land above everything already stored, so none is written twice (a write-once target would
   * refuse it), and the detection details stay in the restore mode row.
   */
  rebaseAbove?(tenantId: string, to: number): Promise<void>;
}

export interface GuardTarget {
  readonly id: string;
  readonly backend: StorageBackend;
}

export interface TenantProgressCheck {
  readonly tenantId: string;
  /** The worst outcome over the targets: ahead, unreachable, foreign, ok, none. */
  readonly outcome: ProgressOutcome;
  readonly targets: readonly TargetProgress[];
  readonly checkedAt: Date;
  /** Restore mode switched on by this check. */
  readonly activated: { id: string; created: boolean } | null;
}

export interface RestoreModeGuardOptions {
  readonly store: RestoreModeStore;
  /** The tenant's targets to compare (primary and copies; previous ones may be left out). */
  readonly targetsOf: (tenantId: string) => Promise<readonly GuardTarget[]>;
  readonly logger: Logger;
  /** How long a tenant's comparison is reused (default 10 minutes). */
  readonly checkTtlMs?: number;
  /** How long the restore mode read is reused (default 5 seconds). */
  readonly stateTtlMs?: number;
  /** Per target (default 20 seconds). */
  readonly targetTimeoutMs?: number;
  readonly now?: () => Date;
}

const RANK: Record<ProgressOutcome, number> = {
  ahead: 4,
  unreachable: 3,
  foreign: 2,
  ok: 1,
  none: 0,
};

function worst(outcomes: readonly ProgressOutcome[]): ProgressOutcome {
  return outcomes.reduce<ProgressOutcome>((a, b) => (RANK[b] > RANK[a] ? b : a), "none");
}

class TargetTimeout extends Error {
  constructor(ms: number) {
    super(`no answer within ${Math.round(ms / 1000)} s`);
    this.name = "TargetTimeout";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TargetTimeout(ms)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class RestoreModeGuard implements DeletionGuard {
  private state: RestoreModeSnapshot = {
    active: false,
    id: null,
    activatedAt: null,
    holdJobsBefore: null,
    keepUnknownBefore: null,
  };
  private stateReadAt = Number.NEGATIVE_INFINITY;
  private stateReading: Promise<RestoreModeSnapshot> | null = null;
  private readonly checks = new Map<string, TenantProgressCheck>();
  private readonly checking = new Map<string, Promise<TenantProgressCheck>>();
  /** Tenants compared at least once in this process (any comparison that finished). */
  private readonly compared = new Set<string>();
  private readonly firstComparisons = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RestoreModeGuardOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  holding(): boolean {
    return this.state.active;
  }

  /** The restore mode, read at most every few seconds (`force` reads now). */
  async restoreMode(force = false): Promise<RestoreModeSnapshot> {
    const ttl = this.options.stateTtlMs ?? 5_000;
    if (!force && this.now().getTime() - this.stateReadAt < ttl) {
      return this.state;
    }
    if (!this.stateReading) {
      this.stateReading = this.options.store
        .read()
        .then((state) => {
          this.state = state;
          this.stateReadAt = this.now().getTime();
          return state;
        })
        .finally(() => {
          this.stateReading = null;
        });
    }
    return this.stateReading;
  }

  /** Read the restore mode every few seconds in the background (holding() stays current). */
  start(intervalMs = 5_000): () => void {
    const tick = () => {
      void this.restoreMode(true)
        .catch((error: unknown) =>
          this.options.logger.warn("could not read the restore mode", {
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          if (this.timer) {
            this.timer = setTimeout(tick, intervalMs);
            this.timer.unref();
          }
        });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
    return () => {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = null;
    };
  }

  /** Forget the cached comparisons (after restore mode ended, tests). */
  forgetChecks(tenantId?: string): void {
    if (tenantId) {
      this.checks.delete(tenantId);
    } else {
      this.checks.clear();
    }
    this.stateReadAt = Number.NEGATIVE_INFINITY;
  }

  /** Compare the tenant's targets with the database (cached unless `force`). */
  async checkTenant(
    tenantId: string,
    options: { force?: boolean } = {},
  ): Promise<TenantProgressCheck> {
    const ttl = this.options.checkTtlMs ?? 10 * 60_000;
    const cached = this.checks.get(tenantId);
    if (
      !options.force &&
      cached &&
      cached.outcome !== "unreachable" &&
      this.now().getTime() - cached.checkedAt.getTime() < ttl
    ) {
      return cached;
    }
    const running = this.checking.get(tenantId);
    if (running) {
      return running;
    }
    const check = this.runCheck(tenantId).finally(() => this.checking.delete(tenantId));
    this.checking.set(tenantId, check);
    return check;
  }

  /**
   * A marker writer found the value it was handed taken already on `target`. A marker of this
   * installation there is proof by itself that the storage is ahead (the value was handed out
   * before, in a timeline the database no longer has): restore mode comes on with `seq` as the
   * storage's value and `seq - 1` as the database's, before the comparison of the target, which
   * reads the database's value after the allocation already raised it and so may no longer see
   * storage that is only one value ahead. The comparison then lifts the value above the
   * storage's. A marker of another installation only gets the comparison (its warning).
   */
  async markerCollision(
    tenantId: string,
    target: GuardTarget,
    seq: number,
    ours: boolean,
  ): Promise<TenantProgressCheck> {
    const { store, logger } = this.options;
    let activated: { id: string; created: boolean } | null = null;
    if (ours) {
      const installationId = await store.installationId();
      activated = await store.activateDetected({
        tenantId,
        targetId: target.id,
        markerSeq: seq,
        dbSeq: seq - 1,
        keyVersions: [],
        installationId,
      });
      logger.error(
        "the database is older than its storage: restore mode is on, nothing is deleted",
        {
          tenantId,
          targetId: target.id,
          markerSeq: seq,
          dbSeq: seq - 1,
          collision: true,
          created: activated.created,
        },
      );
      await this.restoreMode(true).catch(() => undefined);
      this.checks.delete(tenantId);
    }
    const check = await this.checkTargets(tenantId, [target]);
    if (ours && store.rebaseAbove) {
      // The comparison may see nothing above the raised value: lift it above the taken one.
      const seen = Math.max(seq, ...check.targets.map((result) => result.storageMaxSeq ?? 0));
      await store.rebaseAbove(tenantId, seen + PROGRESS_REBASE_MARGIN).catch((error: unknown) =>
        logger.warn("could not lift the progress value above the storage's", {
          tenantId,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return activated && !check.activated ? { ...check, activated } : check;
  }

  /**
   * Compare the tenant's `targets` once in this process before a marker writer allocates its
   * first value for the tenant (progress-marker.ts `beforeFirstAllocation`): every allocation
   * raises the database's value, and a comparison after a few of them could no longer see
   * storage that is only a few values ahead. Never waits for a running comparison that resolves
   * the tenant's storage (the worker's writer runs inside that resolution).
   */
  async compareBeforeFirstAllocation(
    tenantId: string,
    targets?: readonly GuardTarget[],
  ): Promise<void> {
    if (this.compared.has(tenantId)) {
      return;
    }
    let first = this.firstComparisons.get(tenantId);
    if (!first) {
      first = (targets ? this.runCheck(tenantId, targets) : this.checkTenant(tenantId))
        .then(() => undefined)
        .finally(() => this.firstComparisons.delete(tenantId));
      this.firstComparisons.set(tenantId, first);
    }
    await first;
  }

  /**
   * Compare the given targets of the tenant now (a marker writer that found its value taken
   * compares the target it writes to without resolving the tenant's storage again).
   */
  async checkTargets(
    tenantId: string,
    targets: readonly GuardTarget[],
  ): Promise<TenantProgressCheck> {
    return this.runCheck(tenantId, targets);
  }

  private async runCheck(
    tenantId: string,
    given?: readonly GuardTarget[],
  ): Promise<TenantProgressCheck> {
    const { store, logger } = this.options;
    const installationId = await store.installationId();
    const targets = given ?? (await this.options.targetsOf(tenantId));
    const timeout = this.options.targetTimeoutMs ?? 20_000;
    const results: TargetProgress[] = [];
    for (const target of targets) {
      let result: TargetProgress;
      try {
        result = await withTimeout(
          compareStorageProgress({
            tenantId,
            targetId: target.id,
            backend: target.backend,
            readDbSeq: () => store.readDbSeq(tenantId),
            readDbKeyMax: () => store.readDbKeyMax(tenantId),
            installationId,
          }),
          timeout,
        );
      } catch (error) {
        result = {
          targetId: target.id,
          outcome: "unreachable",
          storageMaxSeq: null,
          aheadSeq: null,
          dbSeq: await store.readDbSeq(tenantId),
          unknownKeyVersions: [],
          detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
        };
      }
      results.push(result);
      await store.recordCheck(tenantId, result).catch((error: unknown) =>
        logger.warn("could not record a storage progress check", {
          tenantId,
          targetId: target.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const outcome = worst(results.map((result) => result.outcome));
    let activated: { id: string; created: boolean } | null = null;
    const ahead = results.find((result) => result.outcome === "ahead");
    if (ahead) {
      activated = await store.activateDetected({
        tenantId,
        targetId: ahead.targetId,
        markerSeq: ahead.aheadSeq,
        dbSeq: ahead.dbSeq,
        keyVersions: ahead.unknownKeyVersions,
        installationId,
      });
      logger.error(
        "the database is older than its storage: restore mode is on, nothing is deleted",
        {
          tenantId,
          targetId: ahead.targetId,
          markerSeq: ahead.aheadSeq,
          dbSeq: ahead.dbSeq,
          keyVersions: [...ahead.unknownKeyVersions],
          created: activated.created,
        },
      );
      await this.restoreMode(true).catch(() => undefined);
    }
    // Restore mode is on (now, or already): lift the database's value above every marker seen.
    const seenMax = Math.max(...results.map((result) => result.storageMaxSeq ?? 0), 0);
    const dbSeq = Math.max(...results.map((result) => result.dbSeq), 0);
    if (store.rebaseAbove && seenMax >= dbSeq && (activated || this.state.active)) {
      const above = results.some(
        (result) => (result.storageMaxSeq ?? 0) > result.dbSeq || result.outcome === "ahead",
      );
      if (above) {
        await store
          .rebaseAbove(tenantId, seenMax + PROGRESS_REBASE_MARGIN)
          .catch((error: unknown) =>
            logger.warn("could not lift the progress value above the storage's", {
              tenantId,
              errorMessage: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    }
    for (const result of results.filter((entry) => entry.outcome === "foreign")) {
      logger.warn("a storage target holds progress markers of another installation", {
        tenantId,
        targetId: result.targetId,
        detail: result.detail,
      });
      await store.reportForeign?.(tenantId, result).catch(() => undefined);
    }
    const check: TenantProgressCheck = {
      tenantId,
      outcome,
      targets: results,
      checkedAt: this.now(),
      activated,
    };
    this.compared.add(tenantId);
    if (!given) {
      this.checks.set(tenantId, check);
    }
    return check;
  }

  /**
   * Compare many tenants (worker start): `concurrency` at a time; whatever is not done after
   * `capMs` continues in the background. Resolves with the checks that finished in time.
   */
  async checkTenants(
    tenantIds: readonly string[],
    options: { concurrency?: number; capMs?: number } = {},
  ): Promise<TenantProgressCheck[]> {
    const done: TenantProgressCheck[] = [];
    let next = 0;
    const concurrency = Math.max(1, options.concurrency ?? 8);
    const workers = Array.from({ length: Math.min(concurrency, tenantIds.length) }, async () => {
      while (next < tenantIds.length) {
        const tenantId = tenantIds[next++] as string;
        try {
          done.push(await this.checkTenant(tenantId, { force: true }));
        } catch (error) {
          this.options.logger.warn("could not compare a tenant's storage with the database", {
            tenantId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    const all = Promise.all(workers);
    const cap = options.capMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, cap);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return done;
  }

  async decide(request: DeletionRequest): Promise<DeletionDecision> {
    const { store, logger } = this.options;
    let state = await this.restoreMode();
    if (DELETION_PASS_BEHAVIOUR[request.pass] === "own_scope") {
      // Only the row's own output goes: nothing the database could have lost is in its scope.
      return {
        allowed: true,
        keepUnknownBefore: state.keepUnknownBefore,
        inRestoreMode: state.active,
      };
    }
    if (!state.active && request.tenantId) {
      const check = await this.checkTenant(request.tenantId);
      if (check.activated) {
        state = await this.restoreMode(true);
      }
      if (!state.active && check.outcome === "unreachable") {
        const unreachable = check.targets.filter((target) => target.outcome === "unreachable");
        logger.warn("deletion held: a storage target could not be compared with the database", {
          pass: request.pass,
          tenantId: request.tenantId,
          targets: unreachable.map((target) => target.targetId),
        });
        return {
          allowed: false,
          reason: "progress_unknown",
          restoreModeId: null,
          detail: unreachable
            .map((target) => `${target.targetId}: ${target.detail ?? ""}`)
            .join("; "),
        };
      }
    }
    if (state.active) {
      if (
        DELETION_PASS_BEHAVIOUR[request.pass] === "post_activation_only" &&
        request.createdAt &&
        state.activatedAt &&
        request.createdAt.getTime() > state.activatedAt.getTime()
      ) {
        return { allowed: true, keepUnknownBefore: state.keepUnknownBefore, inRestoreMode: true };
      }
      logger.warn("deletion held: restore mode", {
        pass: request.pass,
        tenantId: request.tenantId,
      });
      if (state.id) {
        await store
          .recordRefusal({
            restoreModeId: state.id,
            tenantId: request.tenantId,
            pass: request.pass,
          })
          .catch((error: unknown) =>
            logger.warn("could not count a refused deletion", {
              errorMessage: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      return { allowed: false, reason: "restore_mode", restoreModeId: state.id };
    }
    return { allowed: true, keepUnknownBefore: state.keepUnknownBefore, inRestoreMode: false };
  }

  onUnguarded(key: string, refused: boolean): void {
    if (refused) {
      this.options.logger.warn("deletion held: restore mode (a delete outside a deletion pass)", {
        key,
      });
    } else {
      this.options.logger.debug("a storage delete outside a deletion pass", { key });
    }
  }
}
