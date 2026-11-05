/**
 * The archive capture service (docs/ARCHIVE.md "Erfassungswege", docs/ARCHITECTURE.md):
 * continuous capture of archived mailboxes by their mailbox ways (Graph, IMAP), next to
 * the queue workers of every worker process. Not a pg-boss queue: `archive_capture_streams`
 * is the queue (./streams.ts), and a pass of one mailbox writes no `jobs` row. Only the
 * one-time backfill of a newly activated stream is an `archive` job (../handlers/archive.ts).
 *
 * A loop, every `pollMs`:
 *
 *   - every `gateCheckMs` the gate `archive.mailboxCapture` (WorkerExtension.features) is
 *     read; closed = the service idles and aborts what runs (the Community build);
 *   - every `reconcileMs` the streams are reconciled with the mail jobs (./reconcile.ts);
 *   - tenants whose storage switches targets are not claimed, and their running passes are
 *     aborted; when the switch is over their storage is resolved afresh;
 *   - due streams are claimed up to the free slots (`ARCHIVE_CAPTURE_CONCURRENCY`, default
 *     16, at most `ARCHIVE_CAPTURE_TENANT_CONCURRENCY`, default 4, per tenant) and passed
 *     (ensure, drain, catch-up of its way, ./ways.ts); the leases of running passes are
 *     renewed every third of the lease, and a pass whose lease was lost is aborted.
 *
 * It stops on shutdown and while an update drains the worker (#46): running passes are
 * aborted at the next mail boundary, their leases given back, nothing appended is lost.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  type ArchiveJobPayload,
  type archive,
  JOB_PRIORITY,
  LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS,
  type Logger,
  recordFailure,
  type StorageTargets,
  singletonKeyFor,
  type TenantKeyring,
} from "@restow/core";
import { type Database, jobs, safeErrorMessage } from "@restow/db";
import type { WorkerFeatureGate } from "../extensions.js";
import { bossFor } from "../handlers/backup.js";
import {
  PgChunkIndex,
  TenantCache,
  TenantConcurrencyLimiter,
  tenantRunner,
  type UpdateDrain,
  withTenantTx,
} from "../handlers/framework.js";
import { archiveRetentionPolicyFor } from "../handlers/import-archive.js";
import { recordLoginFailure, recordLoginSuccess } from "../imap-login-state.js";
import { alreadyCapturedFor, appendCapturedMail } from "./append.js";
import { PgCaptureGaps } from "./gaps.js";

/** Failed fetches after which an announced ref is dropped from pending as a capture gap. */
export const PENDING_MAX_ATTEMPTS = 5;

import { reconcileCaptureStreams } from "./reconcile.js";
import { CAPTURE_WAYS } from "./registry.js";
import { PgStreamStore, type StreamOutcome } from "./streams.js";
import type {
  ArchiveStreamState,
  CaptureContext,
  CaptureStream,
  CaptureWay,
  MailboxWay,
  PassReason,
} from "./ways.js";

type Env = Record<string, string | undefined>;

export interface ArchiveCaptureSettings {
  /** Passes at once in this process. */
  readonly concurrency: number;
  /** Passes at once per tenant in this process. */
  readonly tenantConcurrency: number;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly reconcileMs: number;
  readonly gateCheckMs: number;
  /** Refs drained per pass. */
  readonly drainBatch: number;
  /** Failures in a row after which a stream shows `error`. */
  readonly errorAfterFailures: number;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function captureSettingsFromEnv(env: Env = process.env): ArchiveCaptureSettings {
  return {
    concurrency: positiveInt(env, "ARCHIVE_CAPTURE_CONCURRENCY", 16),
    tenantConcurrency: positiveInt(env, "ARCHIVE_CAPTURE_TENANT_CONCURRENCY", 4),
    leaseMs: 120_000,
    pollMs: 2_000,
    reconcileMs: 120_000,
    gateCheckMs: 60_000,
    drainBatch: 500,
    errorAfterFailures: 5,
  };
}

/** Queues the one-time backfill of a stream; returns the `jobs` id, or null when one is queued. */
export type BackfillEnqueuer = (stream: CaptureStream) => Promise<string | null>;

export interface ArchiveCaptureServiceDeps {
  /** The application pool (tenant transactions, appends). */
  readonly db: Database;
  /** The installation pool (claims across tenants, reconcile). */
  readonly providerDb: Database;
  readonly keyrings: TenantCache<TenantKeyring>;
  readonly storage: TenantCache<StorageTargets>;
  readonly logger: Logger;
  readonly gate: WorkerFeatureGate;
  readonly now?: () => Date;
  readonly shutdownSignal?: AbortSignal;
  readonly updateDrain?: UpdateDrain & { draining?(): boolean };
  /** The ways (default ./registry.ts). */
  readonly ways?: Partial<Record<MailboxWay, CaptureWay>>;
  readonly settings?: Partial<ArchiveCaptureSettings>;
  /** This process's lease owner name (default host and a random id). */
  readonly owner?: string;
  readonly enqueueBackfill?: BackfillEnqueuer;
}

/** Wait `ms` or until `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Backoff after `failures` failures in a row: 1, 2, 4 ... minutes, at most an hour. */
export function backoffMs(failuresInARow: number): number {
  return Math.min(60, 2 ** Math.max(0, failuresInARow - 1)) * 60_000;
}

/** A backfill whose last job failed is queued again after this long (./service.ts). */
export const BACKFILL_REQUEUE_AFTER_FAILURE_MS = 60 * 60_000;

/** The status a stream that works has, from where it stands. */
export function workingStatus(stream: {
  activatedAt: Date | null;
  backfillCompletedAt: Date | null;
}): "pending" | "backfilling" | "live" {
  if (stream.activatedAt === null) {
    return "pending";
  }
  return stream.backfillCompletedAt === null ? "backfilling" : "live";
}

/** The default backfill enqueuer: an `archive` job with `mode: "backfill"` and its `jobs` row. */
export function pgBackfillEnqueuer(db: Database): BackfillEnqueuer {
  return async (stream) => {
    const payload: ArchiveJobPayload = {
      jobId: randomUUID(),
      tenantId: stream.tenantId,
      protectedObjectId: stream.protectedObjectId,
      capture: stream.way,
      mode: "backfill",
    };
    const singletonKey = singletonKeyFor("archive", payload);
    const pgBossJobId = await bossFor(db).send("archive", payload, {
      priority: JOB_PRIORITY.archive,
      ...(singletonKey ? { singletonKey } : {}),
    });
    if (pgBossJobId === null) {
      return null;
    }
    await withTenantTx(db, stream.tenantId, (tx) =>
      tx
        .insert(jobs)
        .values({
          id: payload.jobId,
          tenantId: stream.tenantId,
          queue: "archive",
          status: "queued",
          protectedObjectId: stream.protectedObjectId,
          payload: payload as unknown as Record<string, unknown>,
          pgBossJobId,
        })
        .onConflictDoNothing({ target: jobs.id }),
    );
    return payload.jobId;
  };
}

interface RunningPass {
  readonly stream: CaptureStream;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export class ArchiveCaptureService {
  readonly owner: string;
  private readonly settings: ArchiveCaptureSettings;
  private readonly store: PgStreamStore;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly running = new Map<string, RunningPass>();
  private readonly stopController = new AbortController();
  private readonly retention: TenantCache<archive.RetentionPolicy>;
  private readonly now: () => Date;
  private readonly ways: Partial<Record<MailboxWay, CaptureWay>>;
  private readonly enqueueBackfill: BackfillEnqueuer;
  private loop: Promise<void> | null = null;
  private enabled = false;
  private lastGateCheck = Number.NEGATIVE_INFINITY;
  private lastReconcile = Number.NEGATIVE_INFINITY;
  private lastRenew = 0;
  private switching = new Set<string>();
  private unsubscribeDrain: (() => void) | null = null;
  private drainRequested = false;

  constructor(private readonly deps: ArchiveCaptureServiceDeps) {
    this.settings = { ...captureSettingsFromEnv({}), ...deps.settings };
    this.store = new PgStreamStore(deps.providerDb);
    this.limiter = new TenantConcurrencyLimiter(this.settings.tenantConcurrency);
    this.retention = new TenantCache((tenantId) => archiveRetentionPolicyFor(deps.db, tenantId));
    this.now = deps.now ?? (() => new Date());
    this.ways = deps.ways ?? CAPTURE_WAYS;
    this.owner = deps.owner ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.enqueueBackfill = deps.enqueueBackfill ?? pgBackfillEnqueuer(deps.db);
  }

  /** Whether the gate was open at the last check (status, tests). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Streams this process is passing right now. */
  runningStreams(): string[] {
    return [...this.running.keys()];
  }

  start(): void {
    if (this.loop) {
      return;
    }
    this.deps.shutdownSignal?.addEventListener("abort", () => void this.stop(), { once: true });
    this.unsubscribeDrain =
      this.deps.updateDrain?.subscribe(() => {
        this.drainRequested = true;
        this.abortAll("update drain");
      }) ?? null;
    for (const way of Object.values(this.ways)) {
      way?.start?.({
        db: this.deps.db,
        providerDb: this.deps.providerDb,
        logger: this.deps.logger.child({ way: way.way }),
        signal: this.stopController.signal,
        markDue: (ids) => this.store.markDue(ids),
        keyring: (tenantId) => this.deps.keyrings.get(tenantId),
        active: () =>
          this.enabled &&
          !this.stopController.signal.aborted &&
          !(this.deps.updateDrain?.draining?.() ?? this.drainRequested),
      });
    }
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopController.abort("shutdown");
    this.abortAll("shutdown");
    this.unsubscribeDrain?.();
    await this.loop;
    this.loop = null;
  }

  /** One round of the loop (tests drive it directly); returns how many streams it claimed. */
  async tick(): Promise<number> {
    const now = this.now().getTime();
    if (now - this.lastGateCheck >= this.settings.gateCheckMs) {
      this.lastGateCheck = now;
      const enabled = await this.deps.gate.isEnabled("archive.mailboxCapture");
      if (enabled !== this.enabled) {
        this.deps.logger.info(
          enabled ? "archive capture enabled" : "archive capture off: the gate is closed",
        );
      }
      this.enabled = enabled;
      if (!enabled) {
        this.abortAll("gate closed");
      }
    }
    if (!this.enabled || this.isDraining() || this.stopController.signal.aborted) {
      return 0;
    }
    if (now - this.lastReconcile >= this.settings.reconcileMs) {
      this.lastReconcile = now;
      const outcome = await reconcileCaptureStreams(this.deps.providerDb);
      if (outcome.wanted > 0 || outcome.disabled > 0) {
        this.deps.logger.info("archive capture streams reconciled", { ...outcome });
      }
    }
    await this.followStorageSwitches();
    if (now - this.lastRenew >= this.settings.leaseMs / 3) {
      this.lastRenew = now;
      await this.renewLeases();
    }
    const ways = (Object.keys(this.ways) as MailboxWay[]).filter((way) => this.ways[way]);
    const free = this.settings.concurrency - this.running.size;
    const busyTenants = [
      ...new Set([...this.running.values()].map((p) => p.stream.tenantId)),
    ].filter((tenantId) => this.limiter.activeCount(tenantId) >= this.settings.tenantConcurrency);
    const claimed = await this.store.claimDue({
      owner: this.owner,
      limit: free,
      leaseMs: this.settings.leaseMs,
      ways,
      skipTenants: [...busyTenants, ...this.switching],
    });
    for (const stream of claimed) {
      this.begin(stream);
    }
    return claimed.length;
  }

  /** Wait for every running pass to end (tests). */
  async settle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((pass) => pass.done));
    }
  }

  private isDraining(): boolean {
    const draining = this.deps.updateDrain?.draining?.() ?? this.drainRequested;
    if (!draining) {
      this.drainRequested = false;
    }
    return draining;
  }

  private async run(): Promise<void> {
    const signal = this.stopController.signal;
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.deps.logger.error("archive capture round failed", {
          errorMessage: safeErrorMessage(error),
        });
      }
      await sleep(this.settings.pollMs, signal);
    }
    await this.settle();
  }

  private abortAll(reason: string): void {
    for (const pass of this.running.values()) {
      pass.controller.abort(reason);
    }
  }

  /** Abort the passes of tenants that began a storage switch; forget the storage of those that ended one. */
  private async followStorageSwitches(): Promise<void> {
    const switching = await this.store.switchingTenants();
    for (const tenantId of this.switching) {
      if (!switching.has(tenantId)) {
        this.deps.storage.invalidate(tenantId);
      }
    }
    this.switching = switching;
    for (const pass of this.running.values()) {
      if (switching.has(pass.stream.tenantId)) {
        pass.controller.abort("storage switch");
      }
    }
  }

  private async renewLeases(): Promise<void> {
    const ids = [...this.running.keys()];
    const lost = await this.store.renew(this.owner, ids, this.settings.leaseMs);
    for (const id of lost) {
      this.running.get(id)?.controller.abort("lease lost");
    }
  }

  private begin(stream: CaptureStream): void {
    const controller = new AbortController();
    const done = this.pass(stream, controller.signal)
      .catch((error) => {
        this.deps.logger.error("archive capture pass failed to finish", {
          streamId: stream.id,
          errorMessage: safeErrorMessage(error),
        });
      })
      .finally(() => {
        this.running.delete(stream.id);
      });
    this.running.set(stream.id, { stream, controller, done });
  }

  /**
   * Why this pass runs. A resync request decides first: it is only set by an administrator
   * and only cleared by a pass that ran as a resync, so it must not depend on `dirty_since`,
   * which a pass started by a notification clears although a resync arrived meanwhile.
   */
  private reasonOf(stream: CaptureStream): PassReason {
    if (stream.state.resyncRequestedAt !== undefined) {
      return "resync";
    }
    return stream.dirtySince === null ? "scheduled" : "notified";
  }

  private async pass(stream: CaptureStream, signal: AbortSignal): Promise<void> {
    const way = this.ways[stream.way];
    const logger = this.deps.logger.child({
      tenantId: stream.tenantId,
      streamId: stream.id,
      way: stream.way,
    });
    if (!way) {
      await this.store.release(this.owner, stream.id);
      return;
    }
    const release = await this.limiter.acquire(stream.tenantId, signal).catch(() => null);
    if (!release) {
      await this.store.release(this.owner, stream.id);
      return;
    }
    const passStartedAt = this.now();
    let state: ArchiveStreamState = stream.state;
    let captured = 0;
    let activatedAt: Date | undefined;
    let backfillJobId: string | undefined;
    let step = "prepare";
    try {
      const [keys, storage, retentionPolicy] = await Promise.all([
        this.deps.keyrings.get(stream.tenantId),
        this.deps.storage.get(stream.tenantId),
        this.retention.get(stream.tenantId),
      ]);
      const index = new PgChunkIndex(tenantRunner(this.deps.db, stream.tenantId), stream.tenantId);
      const gaps = new PgCaptureGaps(this.deps.db, stream.tenantId, stream.id);
      const ctx = (): CaptureContext => ({
        db: this.deps.db,
        tenantId: stream.tenantId,
        stream: { ...stream, state, activatedAt: activatedAt ?? stream.activatedAt },
        reason: this.reasonOf(stream),
        keys,
        storage,
        logger,
        signal,
        now: this.now,
        append: async (mail) => {
          const result = await appendCapturedMail(
            {
              db: this.deps.db,
              tenantId: stream.tenantId,
              storage,
              keys,
              index,
              retentionPolicy,
              logger,
              now: this.now,
              signal,
            },
            { ...stream, activatedAt: activatedAt ?? stream.activatedAt },
            mail,
          );
          captured++;
          await gaps.resolved("message", mail.externalRef);
          return result;
        },
        gaps,
        alreadyCaptured: (query) =>
          alreadyCapturedFor(this.deps.db, stream.tenantId, stream.protectedObjectId, query),
        checkpoint: async (next) => {
          state = next;
          await this.store.checkpoint(this.owner, stream.id, next);
        },
      });

      if (stream.status === "disabled") {
        step = "release";
        await way.release?.(ctx());
        await this.complete(stream, {
          state,
          status: "disabled",
          nextDueAt: null,
          passStartedAt,
          captured: 0,
          failure: null,
        });
        return;
      }

      step = "ensure";
      const ensured = await way.ensure(ctx());
      // How mail is noticed, for the status page (reserved keys, see ./ways.ts).
      state = {
        ...(ensured.state ?? state),
        _mode: ensured.mode,
        _pollReason: ensured.pollReason ?? null,
      };
      if (stream.activatedAt === null && ensured.activated) {
        activatedAt = this.now();
        // Persisted before the backfill is queued: the job may start before this pass ends,
        // and it reads the way's state (where live capture starts) and `activated_at`.
        if (!(await this.store.activate(this.owner, stream.id, state, activatedAt))) {
          throw new Error("the stream's lease was lost during its activation");
        }
        // Live capture works: from here on the one-time takeover of the existing mail runs.
        backfillJobId =
          (await this.enqueueBackfill({ ...stream, state, activatedAt })) ?? undefined;
        logger.info("archive capture stream activated", { backfillJobId });
      } else if (
        stream.activatedAt !== null &&
        stream.backfillCompletedAt === null &&
        ensured.activated
      ) {
        backfillJobId = (await this.requeueBackfill(stream, logger)) ?? undefined;
      }
      const status = workingStatus({
        activatedAt: activatedAt ?? stream.activatedAt,
        backfillCompletedAt: stream.backfillCompletedAt,
      });
      if (status === "pending") {
        await this.complete(stream, {
          state,
          status,
          nextDueAt: ensured.nextDueAt ?? new Date(passStartedAt.getTime() + 5 * 60_000),
          passStartedAt,
          captured,
          failure: null,
        });
        return;
      }

      step = "drain";
      if (way.retryGaps) {
        const retried = await way.retryGaps(ctx());
        if (retried > 0) {
          logger.info("open capture gaps are asked for again", { gaps: retried });
        }
      }
      const refs = await this.store.pendingRefs(stream, this.settings.drainBatch);
      let morePending = false;
      if (refs.length > 0) {
        const drained = await way.drain(ctx(), refs);
        state = drained.state ?? state;
        await this.store.deletePending(stream, drained.handled);
        await this.store.deferPending(stream, drained.deferred ?? [], "MIME export failed (5xx)");
        if (drained.failed && drained.failed.refs.length > 0) {
          // Counted per ref; after PENDING_MAX_ATTEMPTS passes a ref is dropped as an open
          // capture gap (shown, alerted) and left to the catch-up, which finds it in its
          // folder if Graph lists it there.
          const exhausted = await this.store.failPending(
            stream,
            drained.failed.refs,
            drained.failed.error,
            PENDING_MAX_ATTEMPTS,
          );
          for (const ref of exhausted) {
            await gaps.gaveUp({ kind: "message", ref, reason: "fetch_failed" });
          }
          if (exhausted.length > 0) {
            logger.warn("announced mail that could not be fetched repeatedly is a capture gap", {
              refs: exhausted.length,
              error: drained.failed.error,
            });
          }
        }
        // A full batch: more may wait, the next pass follows at once. Refs that failed or were
        // deferred now wait out their delay, so that pass never asks for them again.
        morePending = refs.length >= this.settings.drainBatch;
      }
      // Refs waiting out their delay: the stream is due again when the first may be fetched.
      const pendingRetryAt = await this.store.nextPendingRetryAt(stream);

      step = "catch_up";
      const caught = await way.catchUp(ctx());
      state = {
        ...(caught.state ?? state),
        _mode: ensured.mode,
        _pollReason: ensured.pollReason ?? null,
      };
      // The request this pass ran as a resync for is done; only that one (the value it was
      // claimed with). One asked for meanwhile is merged back by complete().
      if (
        this.reasonOf(stream) === "resync" &&
        state.resyncRequestedAt === stream.state.resyncRequestedAt
      ) {
        const { resyncRequestedAt: _done, ...rest } = state;
        state = rest;
      }
      const due = [caught.nextDueAt, ensured.nextDueAt, pendingRetryAt ?? undefined].filter(
        (d): d is Date => d !== undefined,
      );
      const nextDueAt = morePending
        ? passStartedAt
        : new Date(Math.min(...due.map((d) => d.getTime())));
      await this.complete(stream, {
        state,
        status,
        nextDueAt,
        ...(activatedAt ? { activatedAt } : {}),
        ...(backfillJobId ? { backfillJobId } : {}),
        passStartedAt,
        captured,
        failure: null,
      });
    } catch (error) {
      if (signal.aborted) {
        // Shutdown, drain, gate, storage switch or a lost lease: the next owner resumes.
        if (state !== stream.state) {
          await this.store.checkpoint(this.owner, stream.id, state).catch(() => undefined);
        }
        await this.store.release(this.owner, stream.id).catch(() => undefined);
        return;
      }
      const failuresInARow = stream.consecutiveFailures + 1;
      const failure = recordFailure(error, { now: this.now(), step });
      logger.warn("archive capture pass failed", {
        step,
        code: failure.code,
        failuresInARow,
        errorMessage: safeErrorMessage(error),
      });
      await this.complete(stream, {
        state,
        status:
          failuresInARow >= this.settings.errorAfterFailures
            ? "error"
            : workingStatus({
                activatedAt: activatedAt ?? stream.activatedAt,
                backfillCompletedAt: stream.backfillCompletedAt,
              }),
        nextDueAt: new Date(this.now().getTime() + backoffMs(failuresInARow)),
        ...(activatedAt ? { activatedAt } : {}),
        ...(backfillJobId ? { backfillJobId } : {}),
        passStartedAt,
        captured,
        failure: failure as unknown as StreamOutcome["failure"],
      });
    } finally {
      release();
    }
  }

  /**
   * The backfill is reconciled, not queued once: a stream whose takeover is not done and
   * has no backfill job queued or running gets one again (the enqueue at activation failed,
   * the pass was aborted before it, the job used up its retries, or it ran while the stream
   * was off or the gate closed). It resumes from the stream's backfill cursor; the
   * singleton key keeps two from being queued. After a failed job it waits
   * {@link BACKFILL_REQUEUE_AFTER_FAILURE_MS}, so a backfill that keeps failing is retried
   * hourly, not every pass (the capture alert names it, ./alerts.ts). A failing enqueue
   * does not fail the pass: live capture goes on, the next pass tries again.
   */
  private async requeueBackfill(stream: CaptureStream, logger: Logger): Promise<string | null> {
    try {
      const jobs = await this.store.backfillJobs(stream);
      if (jobs.live) {
        return null;
      }
      if (
        jobs.lastFailedAt !== null &&
        this.now().getTime() - jobs.lastFailedAt.getTime() < BACKFILL_REQUEUE_AFTER_FAILURE_MS
      ) {
        return null;
      }
      const jobId = await this.enqueueBackfill(stream);
      if (jobId !== null) {
        logger.info("archive backfill queued again", {
          backfillJobId: jobId,
          afterFailure: jobs.lastFailedAt !== null,
        });
      }
      return jobId;
    } catch (error) {
      logger.warn("archive backfill could not be queued again; the next pass tries", {
        errorMessage: safeErrorMessage(error),
      });
      return null;
    }
  }

  private async complete(stream: CaptureStream, outcome: StreamOutcome): Promise<void> {
    const written = await this.store.complete(this.owner, stream.id, outcome);
    if (!written) {
      this.deps.logger.warn("archive capture lease was lost before the pass ended", {
        streamId: stream.id,
      });
    }
    await this.recordLogin(stream, outcome);
  }

  /**
   * Every pass of every way ends in {@link complete}: the one place that learns whether an IMAP
   * account's login was refused (`imap.auth_failed`) or worked, for the question "was this
   * account shut down?" (../imap-login-state.ts). Every non-disabled IMAP pass logs in (the
   * activation and the catch-up both open a session); a disabled stream logs in nowhere.
   * A pass counts with the longer archive spacing, so passes every few hours do not run the
   * counter faster than the nightly backup. IDLE needs no hook: a failed IDLE login marks the stream due and the next pass reports it.
   * Best effort: it never fails the pass.
   */
  private async recordLogin(stream: CaptureStream, outcome: StreamOutcome): Promise<void> {
    if (stream.way !== "imap_sync") {
      return;
    }
    const refused = outcome.failure?.code === "imap.auth_failed";
    const worked = outcome.failure === null && outcome.status !== "disabled";
    if (!refused && !worked) {
      return;
    }
    try {
      await withTenantTx(this.deps.db, stream.tenantId, async (tx) => {
        if (refused) {
          await recordLoginFailure(
            tx,
            stream.tenantId,
            stream.protectedObjectId,
            this.now(),
            LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS,
          );
        } else {
          await recordLoginSuccess(tx, stream.tenantId, stream.protectedObjectId);
        }
      });
    } catch (error) {
      this.deps.logger.warn("could not record the login state of the IMAP account", {
        streamId: stream.id,
        errorMessage: safeErrorMessage(error),
      });
    }
  }
}
